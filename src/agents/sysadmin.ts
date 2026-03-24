import { getDb, logEvent } from '../db';
import { DB_PATH } from '../config';
import { notifyHousehold } from '../channels/telegram';
import { runCommand } from '../utils/shell';
import { processWithOllama } from '../core/ollama';

const JEEVES_ALERT_SYSTEM = 'Ты Дживс, дворецкий. Перефразируй уведомление кратко и элегантно (1-2 предложения). Сохрани все числа и факты точно. Без markdown.';

async function formatAlert(template: string): Promise<string> {
    try {
        const result = await processWithOllama(
            `Перефразируй это уведомление в стиле Дживса: "${template}"`,
            JEEVES_ALERT_SYSTEM
        );
        return result.text?.trim() || template;
    } catch {
        return template;
    }
}

// Cooldown: don't repeat same alert within 2 hours
const alertCooldowns = new Map<string, number>();
const COOLDOWN_DEFAULT = 2 * 60 * 60 * 1000;   // 2h for system alerts
const COOLDOWN_WEATHER = 6 * 60 * 60 * 1000;   // 6h for weather — avoid spam
function canAlert(key: string, cooldownMs = COOLDOWN_DEFAULT): boolean {
    const last = alertCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldownMs) return false;
    alertCooldowns.set(key, Date.now());
    return true;
}

// Autopilot state
let autopilotState: 'home' | 'away' | 'unknown' = 'unknown';

/** Parse ARP table into MAC→IP map */
async function getArpTable(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const raw = await runCommand('arp -a 2>/dev/null || cat /proc/net/arp 2>/dev/null', 5000);
        // Format: ? (192.168.1.185) at aa:bb:cc:dd:ee:ff ...
        for (const line of raw.split('\n')) {
            const match = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]{17})/i);
            if (match) map.set(match[2].toLowerCase(), match[1]);
        }
    } catch { }
    return map;
}

/** Check BLE presence for a MAC (best-effort, may fail) */
async function checkBlePresence(mac: string): Promise<boolean> {
    try {
        await runCommand(`hcitool name ${mac} 2>/dev/null`, 5000);
        return true;
    } catch {
        return false;
    }
}

export async function runPresenceCheck() {
    const db = getDb();
    const residents = db.prepare(
        'SELECT * FROM residents WHERE ip_address IS NOT NULL OR mac_address IS NOT NULL'
    ).all() as any[];

    // Get ARP table once for all residents
    const arpTable = await getArpTable();

    // Auto-fill MAC addresses from ARP for residents who have IP but no MAC
    const arpByIp = new Map<string, string>();
    for (const [mac, ip] of arpTable) arpByIp.set(ip, mac);

    for (const r of residents) {
        if (r.ip_address && !r.mac_address && arpByIp.has(r.ip_address)) {
            const mac = arpByIp.get(r.ip_address)!;
            db.prepare('UPDATE residents SET mac_address = ? WHERE tg_id = ?').run(mac, r.tg_id);
            r.mac_address = mac;
            console.log(`[PRESENCE] Auto-filled MAC ${mac} for ${r.display_name || r.tg_id} (IP: ${r.ip_address})`);
        }
    }

    for (const r of residents) {
        let isHome = false;
        const methods: string[] = [];

        // Method 1: Ping by IP
        if (r.ip_address) {
            try {
                await runCommand(`ping -c 1 -W 2 ${r.ip_address}`, 5000);
                isHome = true;
                methods.push('ping');
            } catch { }
        }

        // Method 2: ARP table lookup by MAC (device is on WiFi even if ping fails)
        if (!isHome && r.mac_address) {
            const mac = r.mac_address.toLowerCase();
            if (arpTable.has(mac)) {
                isHome = true;
                methods.push('arp');
            }
        }

        // Method 3: BLE check (only if other methods failed, slower)
        if (!isHome && r.ble_mac) {
            if (await checkBlePresence(r.ble_mac)) {
                isHome = true;
                methods.push('ble');
            }
        }

        const wasHome = !!r.is_home;
        const now = new Date().toISOString();

        if (isHome && !wasHome) {
            db.prepare('UPDATE residents SET is_home = 1, last_seen = ? WHERE tg_id = ?').run(now, r.tg_id);
            logEvent('presence_change', { resident: r.display_name, action: 'arrived', method: methods.join('+') });
        } else if (!isHome && wasHome) {
            db.prepare('UPDATE residents SET is_home = 0 WHERE tg_id = ?').run(r.tg_id);
            logEvent('presence_change', { resident: r.display_name, action: 'left' });
        } else if (isHome) {
            db.prepare('UPDATE residents SET last_seen = ? WHERE tg_id = ?').run(now, r.tg_id);
        }
    }

    // Autopilot: check if anyone is home
    const homeCount = (db.prepare('SELECT COUNT(*) as c FROM residents WHERE is_home = 1 AND ip_address IS NOT NULL').get() as any)?.c || 0;
    const prevState = autopilotState;

    if (homeCount > 0 && prevState !== 'home') {
        autopilotState = 'home';
        if (prevState === 'away') {
            // Someone came home — welcome mode
            logEvent('autopilot', { action: 'welcome', residents_home: homeCount });
            try {
                const { getRegisteredHandlers } = require('../skills/_registry');
                const h = getRegisteredHandlers();
                if (h.lights_on) await h.lights_on({ light_name: 'kitchen', brightness: 50 });
            } catch (e: any) { console.error('[AUTOPILOT] lights_on error:', e.message); }

            const names = (db.prepare('SELECT display_name, username FROM residents WHERE is_home = 1').all() as any[])
                .map(r => r.display_name || r.username).filter(Boolean);
            await notifyHousehold(await formatAlert(`Добро пожаловать домой${names.length ? ', ' + names.join(' и ') : ''}. Свет включён.`));
        }
    } else if (homeCount === 0 && prevState !== 'away') {
        autopilotState = 'away';
        if (prevState === 'home') {
            // Everyone left — sleep mode
            logEvent('autopilot', { action: 'sleep' });
            try {
                const { getRegisteredHandlers } = require('../skills/_registry');
                const h = getRegisteredHandlers();
                if (h.lights_off) await h.lights_off({ light_name: 'all' });
                if (h.ac_control) await h.ac_control({ action: 'off' });
            } catch (e: any) { console.error('[AUTOPILOT] sleep error:', e.message); }

            await notifyHousehold(await formatAlert('Все ушли. Свет и кондиционер выключены. Квартира в режиме спячки.'));
        }
    }
}

export async function runZombieCheck() {
    try {
        const db = getDb();
        const now = Date.now();

        // IoT devices not seen for >24h (they should be always-on)
        const zombies = db.prepare(
            `SELECT * FROM known_devices WHERE device_type IN ('iot', 'iot-gateway', 'server') AND last_seen IS NOT NULL`
        ).all() as any[];

        for (const d of zombies) {
            const lastSeen = new Date(d.last_seen).getTime();
            const hoursAgo = Math.round((now - lastSeen) / (1000 * 60 * 60));

            if (hoursAgo >= 24 && canAlert(`zombie_${d.mac_address}`)) {
                const name = d.device_name || d.hostname || d.mac_address;
                logEvent('zombie_device', { device: name, hours_offline: hoursAgo });
                await notifyHousehold(await formatAlert(`${name} (${d.device_type}) не появлялся в сети ${hoursAgo} часов. Проверить?`));
            }
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Zombie check error:', err.message);
    }
}

export async function runWeatherAlert() {
    try {
        const { LOCATION_LAT, LOCATION_LON } = require('../config');
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION_LAT}&longitude=${LOCATION_LON}` +
            `&current=wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
            `&hourly=weather_code,precipitation,wind_gusts_10m&forecast_hours=3&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        const c = data.current;
        const h = data.hourly;

        const warnings: string[] = [];

        // === CURRENT (only severe conditions) ===
        if ([95, 96, 99].includes(c.weather_code) && canAlert('storm_now', COOLDOWN_WEATHER)) {
            warnings.push('⛈ Гроза прямо сейчас! Закрой окна и балконную дверь.');
        }
        if (c.wind_gusts_10m > 60 && canAlert('wind_now', COOLDOWN_WEATHER)) {
            warnings.push(`💨 Порывы ветра ${c.wind_gusts_10m} км/ч! Убери вещи с террасы.`);
        }
        if (c.precipitation > 10 && canAlert('rain_now', COOLDOWN_WEATHER)) {
            warnings.push(`🌧 Сильный дождь (${c.precipitation} мм/ч). Закрой окна.`);
        }

        // === FORECAST (next 3 hours, only high confidence — multiple hours or heavy) ===
        if (h?.weather_code && h?.time) {
            const stormHours: string[] = [];
            const heavyRainHours: string[] = [];
            let maxGust = 0;
            let maxGustHour = '';

            for (let i = 0; i < h.time.length; i++) {
                const hour = h.time[i]?.match(/T(\d{2})/)?.[1] + ':00';
                const code = h.weather_code[i];
                const precip = h.precipitation?.[i] || 0;
                const gust = h.wind_gusts_10m?.[i] || 0;

                if ([95, 96, 99].includes(code)) stormHours.push(hour);
                if (precip > 10 || code === 82) heavyRainHours.push(hour); // only violent showers (82) or >10mm
                if (gust > maxGust) { maxGust = gust; maxGustHour = hour; }
            }

            if (stormHours.length > 0 && canAlert('storm_forecast', COOLDOWN_WEATHER)) {
                warnings.push(`⛈ Гроза ожидается в ${stormHours.join(', ')}. Закрой окна заранее.`);
            }
            if (heavyRainHours.length >= 2 && !stormHours.length && canAlert('rain_forecast', COOLDOWN_WEATHER)) {
                // Only alert if heavy rain in 2+ hours (sustained) — skip single-hour light showers
                warnings.push(`🌧 Сильный дождь ожидается в ${heavyRainHours.join(', ')}. Закрой окна и убери бельё.`);
            }
            if (maxGust > 60 && canAlert('wind_forecast', COOLDOWN_WEATHER)) {
                warnings.push(`💨 Порывы ветра до ${maxGust} км/ч к ${maxGustHour}. Убери вещи с террасы.`);
            }
        }

        if (warnings.length > 0) {
            logEvent('weather_alert', { weather_code: c.weather_code, wind_gusts: c.wind_gusts_10m, precipitation: c.precipitation });
            await notifyHousehold(await formatAlert(warnings.join('\n')));
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Weather alert error:', err.message);
    }
}

export async function runSystemHealthCheck() {
    try {
        const { getSystemMetrics } = require('../core/healthcheck');
        const m = getSystemMetrics();

        if (m.tempC > 50 && canAlert('temp')) {
            logEvent('system_health', { alert: 'high_temp', temp: m.tempC });
            await notifyHousehold(await formatAlert(`Температура CPU: ${m.tempC.toFixed(1)}°C. Рекомендую обеспечить вентиляцию.`));
        }

        if (m.ramPercent > 85 && canAlert('ram')) {
            logEvent('system_health', { alert: 'high_ram', used: m.ramUsedMB, total: m.ramTotalMB });
            await notifyHousehold(await formatAlert(`RAM заполнена на ${m.ramPercent}% (${m.ramUsedMB}/${m.ramTotalMB} MB). Стоит проверить.`));
        }

        if (m.diskPercent > 90 && canAlert('disk')) {
            logEvent('system_health', { alert: 'disk_full', usage: m.diskPercent });
            await notifyHousehold(await formatAlert(`Диск заполнен на ${m.diskPercent}%. Позвольте предложить навести порядок в хранилище.`));
        }

        // Swap warning: if >50% swap is used, system is under memory pressure
        if (m.swapTotalMB > 0 && m.swapUsedMB > m.swapTotalMB * 0.5 && canAlert('swap')) {
            logEvent('system_health', { alert: 'high_swap', used: m.swapUsedMB, total: m.swapTotalMB });
            await notifyHousehold(await formatAlert(`Swap используется на ${Math.round(m.swapUsedMB / m.swapTotalMB * 100)}% (${m.swapUsedMB}/${m.swapTotalMB} MB). Система под давлением памяти.`));
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Health check error:', err.message);
    }
}

export async function runNetworkScan() {
    try {
        // Delegate to network skill handler (no duplicated nmap parsing)
        const { getRegisteredHandlers } = require('../skills/_registry');
        const handlers = getRegisteredHandlers();
        if (handlers.network_scan) {
            const result: string = await handlers.network_scan({});
            if (result.includes('NEW:')) {
                const newLines = result.split('\n').filter((l: string) => l.includes('NEW:'));
                logEvent('network_alert', { new_devices: newLines });
                await notifyHousehold(`Сэр, обнаружены новые устройства в сети:\n${newLines.join('\n')}\nЕсли это не ваши гости, позвольте выразить определённое беспокойство.`);
            }
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Network scan error:', err.message);
    }
}

// Docker containers that should always be running
const WATCHED_CONTAINERS = ['ollama', 'mosquitto', 'zigbee2mqtt'];

export async function runServiceWatchdog() {
    try {
        // 1. Check uptime for recent reboots (power failure detection)
        const { getSystemMetrics } = require('../core/healthcheck');
        const m = getSystemMetrics();
        if (m.uptime.match(/up 0 minutes|up [1-9] minutes/)) {
            if (canAlert('recent_reboot', COOLDOWN_DEFAULT)) {
                logEvent('system_alert', { alert: 'recent_reboot', uptime: m.uptime });
                await notifyHousehold(await formatAlert(`Сэр, система была недавно перезагружена (${m.uptime}). Возможно, был сбой питания.`));
            }
        }

        // 2. Check all watched Docker containers
        const dockerPs = await runCommand('docker ps --format "{{.Names}}" 2>/dev/null || echo ""', 5000);
        const running = new Set(dockerPs.split('\n').map(s => s.trim()).filter(Boolean));

        for (const container of WATCHED_CONTAINERS) {
            if (!running.has(container)) {
                if (canAlert(`watchdog_${container}`, 15 * 60 * 1000)) {
                    console.log(`[WATCHDOG] ${container} is DOWN, restarting...`);
                    logEvent('ops_restart', { service: container, reason: 'контейнер не запущен (watchdog)' });
                    try {
                        await runCommand(`docker restart ${container}`, 30000);
                        await notifyHousehold(await formatAlert(`Контейнер ${container} был остановлен. Я перезапустил его автоматически.`));
                    } catch (restartErr: any) {
                        await notifyHousehold(await formatAlert(`Контейнер ${container} не запущен и не удалось перезапустить: ${restartErr.message}`));
                    }
                }
            }
        }

        // 3. Z2M-specific: check for adapter disconnect (even if container is running)
        if (running.has('zigbee2mqtt')) {
            try {
                const logs = await runCommand('docker logs --tail 50 zigbee2mqtt 2>&1 || echo ""', 10000);
                if (logs.includes('Adapter disconnected') || logs.includes('Ember Adapter Stopped')) {
                    if (canAlert('z2m_adapter_restart', 15 * 60 * 1000)) {
                        // Check USB adapter is still present before restarting
                        const usb = await runCommand('lsusb 2>/dev/null || echo ""', 5000);
                        const hasZigbeeUsb = /silicon labs|cp210|cc2531|sonoff|slzb|conbee/i.test(usb);

                        if (hasZigbeeUsb) {
                            logEvent('ops_restart', { service: 'zigbee2mqtt', reason: 'Adapter disconnected' });
                            await runCommand('docker restart zigbee2mqtt', 30000);
                            await notifyHousehold(await formatAlert(`Zigbee-адаптер потерял связь. Перезапустил zigbee2mqtt, адаптер USB на месте.`));
                        } else {
                            logEvent('system_alert', { alert: 'zigbee_usb_missing' });
                            await notifyHousehold(await formatAlert(`Zigbee USB-адаптер не найден в lsusb! Возможно, он отвалился физически. Проверьте подключение.`));
                        }
                    }
                }
            } catch { }
        }
    } catch (err: any) {
        console.error('[SYSADMIN] Service watchdog error:', err.message);
    }
}

export async function runDatabaseBackup() {
    try {
        const backupPath = DB_PATH.replace('.db', '.backup.db');
        const db = getDb();
        db.backup(backupPath);
        console.log(`[BACKUP] Database backed up to ${backupPath}`);
        logEvent('db_backup', { path: backupPath });
    } catch (err: any) {
        console.error('[BACKUP] Database backup failed:', err.message);
        logEvent('db_backup_failed', { error: err.message });
        await notifyHousehold(`Ошибка резервного копирования базы данных: ${err.message}`);
    }
}

/** @deprecated Use runServiceWatchdog() instead */
export const runZ2mWatchdog = runServiceWatchdog;
