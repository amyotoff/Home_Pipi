import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { runSafeCommand } from '../utils/safe-shell';
import { getHealthSummary, getSystemMetrics, setKillSwitch, isKillSwitchActive } from '../core/healthcheck';
import { getDailyTokenCost, logEvent } from '../db';

// ==========================================
// Operator Mode: READ / SAFE-ACT / CONFIRM
// ==========================================

export type OperatorMode = 'READ' | 'SAFE-ACT' | 'CONFIRM';
let operatorMode: OperatorMode = 'READ';

export function getOperatorMode(): OperatorMode {
    return operatorMode;
}

export function setOperatorMode(mode: OperatorMode): void {
    operatorMode = mode;
    logEvent('operator_mode', { mode });
}

// Whitelist of restartable services — bin + args, no shell strings
const RESTARTABLE_SERVICES: Record<string, { bin: string; args: string[] }> = {
    'ollama':       { bin: 'docker', args: ['restart', 'ollama'] },
    'pipi-bot':     { bin: 'docker', args: ['restart', 'pipi-bot'] },
    'mqtt':         { bin: 'docker', args: ['restart', 'mosquitto'] },
    'zigbee2mqtt':  { bin: 'docker', args: ['restart', 'zigbee2mqtt'] },
    'tailscale':    { bin: 'systemctl', args: ['restart', 'tailscale'] },
    'wireguard':    { bin: 'systemctl', args: ['restart', 'wg-quick@wg0'] },
};

// ==========================================
// Skill Definition
// ==========================================

const skill: SkillManifest = {
    name: 'ops',
    description: 'Pi Operator: диагностика, рестарт сервисов, логи, сеть, killswitch',
    version: '1.1.0',
    tools: [
        {
            name: 'ops_report',
            description: 'System report: CPU temp, RAM, swap, disk, undervoltage, SD card, services, health flags, token cost. Use for any hardware/health question.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'ops_restart',
            description: 'Restart a service (whitelisted only). Requires SAFE-ACT mode.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    service: {
                        type: Type.STRING,
                        description: `Service to restart. Allowed: ${Object.keys(RESTARTABLE_SERVICES).join(', ')}`
                    }
                },
                required: ['service'],
            }
        },
        {
            name: 'ops_logs',
            description: 'Show recent error logs from journal or docker.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    source: {
                        type: Type.STRING,
                        description: 'Log source: "system" for journalctl errors, or a docker container name.',
                    },
                    lines: { type: Type.INTEGER, description: 'Number of lines (default 30, max 50).' }
                }
            }
        },
        {
            name: 'ops_net_diag',
            description: 'Quick network diagnostics: DNS resolution, HTTP check, ping gateway, wifi signal.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'ops_mode',
            description: 'Get or set operator mode. READ = diagnostics only, SAFE-ACT = can restart services, CONFIRM = dangerous ops need confirmation.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    mode: {
                        type: Type.STRING,
                        description: 'New mode to set. Omit to show current mode.',
                        enum: ['READ', 'SAFE-ACT', 'CONFIRM']
                    }
                }
            }
        },
        {
            name: 'ops_killswitch',
            description: 'Toggle the kill switch. When active, all LLM calls are blocked. Use to stop runaway spending or loops.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: '"on" to activate, "off" to deactivate, "status" to check.',
                        enum: ['on', 'off', 'status']
                    }
                },
                required: ['action'],
            }
        },
    ],
    handlers: {
        async ops_report() {
            try {
                const m = getSystemMetrics();
                const daily = getDailyTokenCost();
                const health = getHealthSummary();

                let dockerPs: string;
                try {
                    dockerPs = await runSafeCommand('docker', ['ps', '--format', '{{.Names}}: {{.Status}}'], 5000);
                } catch {
                    dockerPs = 'Docker недоступен';
                }

                const swap = m.swapTotalMB > 0 ? `\nSwap: ${m.swapUsedMB}MB / ${m.swapTotalMB}MB` : '';
                const throttle = m.throttleHex !== '0x0' ? `\n⚡ Throttle: ${m.throttleHex}` : '';

                return `[TOOL_RESULT] Отчёт PiPi:\n` +
                    `CPU: ${m.tempC.toFixed(1)}°C\n` +
                    `Uptime: ${m.uptime}\n` +
                    `RAM: ${m.ramUsedMB}MB / ${m.ramTotalMB}MB (${m.ramPercent}%)${swap}\n` +
                    `Диск: ${m.diskUsed} / ${m.diskTotal} (${m.diskPercent}%)${throttle}\n` +
                    `\nСервисы:\n${dockerPs}\n` +
                    `\nЗдоровье:\n${health}\n` +
                    `\nОператор: ${operatorMode}\n` +
                    `Токены сегодня: $${daily.cost_usd.toFixed(2)} (${daily.calls} вызовов)`;
            } catch (err: any) {
                return `[TOOL_ERROR] Отчёт: ${err.message}`;
            }
        },

        async ops_restart(args: { service: string }) {
            const svc = args.service.toLowerCase();

            if (operatorMode === 'READ') {
                return `[TOOL_RESULT] Режим READ — рестарт запрещён. Переключи в SAFE-ACT: ops_mode(mode="SAFE-ACT")`;
            }

            const entry = RESTARTABLE_SERVICES[svc];
            if (!entry) {
                return `[TOOL_RESULT] Сервис "${svc}" не в whitelist. Доступные: ${Object.keys(RESTARTABLE_SERVICES).join(', ')}`;
            }

            logEvent('ops_restart', { service: svc, mode: operatorMode, bin: entry.bin, args: entry.args });

            try {
                const output = await runSafeCommand(entry.bin, entry.args, 30000);
                return `[TOOL_RESULT] ${svc} перезапущен.\n${output}`;
            } catch (err: any) {
                return `[TOOL_ERROR] Рестарт ${svc}: ${err.message}`;
            }
        },

        async ops_logs(args: { source?: string; lines?: number }) {
            const lines = Math.min(Math.max(args.lines || 30, 5), 50);
            const source = args.source || 'system';

            try {
                let output: string;
                if (source === 'system') {
                    try {
                        output = await runSafeCommand('journalctl', ['-p', 'err..alert', '-n', String(lines), '--no-pager'], 10000);
                    } catch {
                        output = 'journalctl недоступен';
                    }
                } else {
                    // Docker container logs — sanitize container name
                    const safeName = source.replace(/[^a-zA-Z0-9_-]/g, '');
                    output = await runSafeCommand('docker', ['logs', '--tail', String(lines), safeName], 10000);
                }
                return `[TOOL_RESULT] Логи (${source}, последние ${lines}):\n${output}`;
            } catch (err: any) {
                return `[TOOL_ERROR] Чтение логов: ${err.message}`;
            }
        },

        async ops_net_diag() {
            try {
                const [ping8, pingGw, dns, wifi] = await Promise.all([
                    runSafeCommand('ping', ['-c', '1', '-W', '2', '8.8.8.8'], 5000).catch(() => 'FAIL'),
                    runSafeCommand('ping', ['-c', '1', '-W', '2', '192.168.1.1'], 5000).catch(() => 'FAIL'),
                    runSafeCommand('nslookup', ['google.com'], 5000).catch(() => 'DNS FAIL'),
                    runSafeCommand('iwconfig', [], 3000).catch(() => 'WiFi: N/A'),
                ]);

                // Extract just the summary lines from ping
                const extractPingSummary = (out: string) => {
                    const lines = out.split('\n');
                    return lines.filter(l => l.includes('packets transmitted') || l.includes('rtt') || l.includes('round-trip')).join(' ') || out.split('\n').pop() || out;
                };

                return `[TOOL_RESULT] Сетевая диагностика:\n` +
                    `Ping 8.8.8.8: ${extractPingSummary(ping8)}\n` +
                    `Ping gateway: ${extractPingSummary(pingGw)}\n` +
                    `DNS: ${dns.split('\n').slice(-2).join(' ')}\n` +
                    `WiFi: ${wifi}`;
            } catch (err: any) {
                return `[TOOL_ERROR] Диагностика: ${err.message}`;
            }
        },

        async ops_mode(args: { mode?: string }) {
            if (!args.mode) {
                return `[TOOL_RESULT] Режим оператора: ${operatorMode}. Варианты: READ (только чтение), SAFE-ACT (рестарт сервисов), CONFIRM (опасные операции с подтверждением).`;
            }

            const mode = args.mode.toUpperCase() as OperatorMode;
            if (!['READ', 'SAFE-ACT', 'CONFIRM'].includes(mode)) {
                return `[TOOL_RESULT] Неизвестный режим "${args.mode}". Варианты: READ, SAFE-ACT, CONFIRM.`;
            }

            setOperatorMode(mode);
            return `[TOOL_RESULT] Режим оператора: ${mode}`;
        },

        async ops_killswitch(args: { action: string }) {
            const action = args.action.toLowerCase();

            if (action === 'status') {
                return `[TOOL_RESULT] Kill switch: ${isKillSwitchActive() ? 'АКТИВЕН' : 'выключен'}`;
            }

            if (action === 'on') {
                setKillSwitch(true, 'ручное включение через ops_killswitch');
                return `[TOOL_RESULT] Kill switch АКТИВИРОВАН. Все LLM-вызовы заблокированы.`;
            }

            if (action === 'off') {
                setKillSwitch(false);
                return `[TOOL_RESULT] Kill switch снят. LLM работает в штатном режиме.`;
            }

            return `[TOOL_RESULT] Неизвестное действие. Используй: on, off, status.`;
        },
    }
};

export default skill;
