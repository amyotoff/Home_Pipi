import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { runCommand } from '../utils/shell';
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

// Whitelist of restartable services (Docker container names or systemd units)
const RESTARTABLE_SERVICES: Record<string, string> = {
    'ollama': 'docker restart ollama',
    'pipi-bot': 'docker restart pipi-bot',
    'mqtt': 'docker restart mosquitto',
    'zigbee2mqtt': 'docker restart zigbee2mqtt',
    'tailscale': 'sudo systemctl restart tailscale',
    'wireguard': 'sudo systemctl restart wg-quick@wg0',
};

// ==========================================
// Skill Definition
// ==========================================

const skill: SkillManifest = {
    name: 'ops',
    description: 'Pi Operator: диагностика, рестарт сервисов, логи, сеть, killswitch',
    version: '1.0.0',
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

                // Only docker ps needs a live shell call
                const dockerPs = await runCommand('docker ps --format "{{.Names}}: {{.Status}}" 2>/dev/null || echo "Docker недоступен"', 5000);

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
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async ops_restart(args: { service: string }) {
            const svc = args.service.toLowerCase();

            if (operatorMode === 'READ') {
                return `[TOOL_RESULT] Режим READ -- рестарт запрещён. Переключи в SAFE-ACT: ops_mode(mode="SAFE-ACT")`;
            }

            const cmd = RESTARTABLE_SERVICES[svc];
            if (!cmd) {
                return `[TOOL_RESULT] Сервис "${svc}" не в whitelist. Доступные: ${Object.keys(RESTARTABLE_SERVICES).join(', ')}`;
            }

            logEvent('ops_restart', { service: svc, mode: operatorMode, cmd });

            try {
                const output = await runCommand(cmd, 30000);
                return `[TOOL_RESULT] ${svc} перезапущен.\n${output}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка рестарта ${svc}: ${err.message}`;
            }
        },

        async ops_logs(args: { source?: string; lines?: number }) {
            const lines = Math.min(Math.max(args.lines || 30, 5), 50);
            const source = args.source || 'system';

            try {
                let output: string;
                if (source === 'system') {
                    output = await runCommand(`journalctl -p err..alert -n ${lines} --no-pager 2>/dev/null || echo "journalctl недоступен"`, 10000);
                } else {
                    // Docker container logs
                    const safeName = source.replace(/[^a-zA-Z0-9_-]/g, '');
                    output = await runCommand(`docker logs --tail ${lines} ${safeName} 2>&1 | tail -${lines}`, 10000);
                }
                return `[TOOL_RESULT] Логи (${source}, последние ${lines}):\n${output}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка чтения логов: ${err.message}`;
            }
        },

        async ops_net_diag() {
            try {
                const results = await Promise.all([
                    runCommand('ping -c 1 -W 2 8.8.8.8 2>&1 | tail -1 || echo "FAIL"', 5000),
                    runCommand('ping -c 1 -W 2 192.168.1.1 2>&1 | tail -1 || echo "FAIL"', 5000),
                    runCommand('nslookup google.com 2>&1 | tail -2 || echo "DNS FAIL"', 5000),
                    runCommand('curl -s -o /dev/null -w "%{http_code} %{time_total}s" --max-time 5 https://google.com 2>/dev/null || echo "HTTP FAIL"', 8000),
                    runCommand('iwconfig 2>/dev/null | grep -i "signal level" || echo "WiFi: N/A"', 3000),
                ]);

                return `[TOOL_RESULT] Сетевая диагностика:\n` +
                    `Ping 8.8.8.8: ${results[0]}\n` +
                    `Ping gateway: ${results[1]}\n` +
                    `DNS: ${results[2]}\n` +
                    `HTTP: ${results[3]}\n` +
                    `WiFi: ${results[4]}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка диагностики: ${err.message}`;
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
