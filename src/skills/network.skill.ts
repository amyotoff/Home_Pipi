import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import { runCommand } from '../utils/shell';

// ==========================================
// Device Classification Heuristics
// ==========================================

interface Classification {
    type: string;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
}

function isLAA(mac: string): boolean {
    const secondChar = mac.replace(/:/g, '').charAt(1).toLowerCase();
    return ['2', '6', 'a', 'e'].includes(secondChar);
}

function classifyDevice(ip: string, mac: string, vendor: string, hostname: string, ports: number[]): Classification {
    const v = vendor.toLowerCase();
    const h = hostname.toLowerCase();
    const portSet = new Set(ports);

    // Router: gateway IPs with web admin
    if (/\.(1|254)$/.test(ip) && (portSet.has(80) || portSet.has(443) || portSet.has(8080)))
        return { type: 'router', confidence: 'high', reason: `gateway IP ${ip}, web admin` };

    // Smartphone: hostname or vendor + mobile port
    if (/iphone|ipad/.test(h) || portSet.has(62078))
        return { type: 'smartphone', confidence: 'high', reason: 'Apple mobile device' };
    if (/android/.test(h) || /samsung|huawei|oneplus|pixel|galaxy/.test(v))
        return { type: 'smartphone', confidence: 'medium', reason: `mobile vendor: ${vendor}` };

    // Raspberry Pi / server
    if (/raspberr/.test(h) || /raspberr/.test(v))
        return { type: 'server', confidence: 'high', reason: 'Raspberry Pi' };
    if (portSet.has(22) && portSet.has(80))
        return { type: 'server', confidence: 'medium', reason: 'SSH + HTTP' };

    // IoT gateways
    if (/ikea|tradfri|murata/.test(v))
        return { type: 'iot-gateway', confidence: 'high', reason: `IKEA/Tradfri gateway (${vendor})` };

    // IoT devices
    if (/espressif|shelly|sonoff|tuya|tasmota/.test(v))
        return { type: 'iot', confidence: 'high', reason: `IoT vendor: ${vendor}` };
    if (/xiaomi|roborock|viomi|dreame/.test(v))
        return { type: 'iot', confidence: 'medium', reason: `Xiaomi ecosystem: ${vendor}` };

    // Printer
    if (portSet.has(9100) || portSet.has(631))
        return { type: 'printer', confidence: 'high', reason: 'print service port' };

    // TV / media
    if (portSet.has(8008) || portSet.has(8009) || /cast|smart-tv|roku|fire/.test(h))
        return { type: 'tv/media', confidence: 'high', reason: 'Chromecast/Smart TV ports' };
    if (/lg|samsung.*tv|sony|philips|hisense/.test(v))
        return { type: 'tv/media', confidence: 'medium', reason: `TV vendor: ${vendor}` };

    // Computer (many ports open)
    if (ports.length >= 3 && (portSet.has(445) || portSet.has(139) || portSet.has(548)))
        return { type: 'computer', confidence: 'medium', reason: 'file sharing ports' };

    // LAA = randomized MAC, can't identify by vendor
    if (isLAA(mac))
        return { type: 'unknown', confidence: 'low', reason: 'randomized MAC (LAA)' };

    return { type: 'unknown', confidence: 'low', reason: 'no matching pattern' };
}

// ==========================================
// Skill Definition
// ==========================================

const skill: SkillManifest = {
    name: 'network',
    description: 'Сканирование WiFi/BLE сети, классификация устройств, BLE-присутствие',
    version: '2.0.0',

    migrations: [
        `ALTER TABLE known_devices ADD COLUMN device_type TEXT DEFAULT 'unknown'`,
        `ALTER TABLE known_devices ADD COLUMN confidence TEXT DEFAULT 'low'`,
        `CREATE TABLE IF NOT EXISTS ble_devices (
            mac TEXT PRIMARY KEY,
            name TEXT,
            rssi INTEGER,
            first_seen TEXT,
            last_seen TEXT,
            device_type TEXT DEFAULT 'unknown',
            is_resident INTEGER DEFAULT 0
        )`,
    ],

    tools: [
        {
            name: 'network_scan',
            description: 'Quick network scan (nmap -sn) — discover devices, light classification by vendor.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'network_devices',
            description: 'Show all known network devices with types.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'network_detective',
            description: 'Deep network investigation: ARP + ping + DNS + port scan + classify each device. Slow (~60s), use when detailed report needed.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'ble_scan',
            description: 'Scan nearby Bluetooth Low Energy devices. Returns name, MAC, signal strength.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'ble_presence',
            description: 'Check which BLE devices marked as resident are nearby.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'network_map',
            description: 'Network map: all devices grouped by type (router, smartphone, IoT, server, etc.) with status.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
    ],

    handlers: {
        async network_scan() {
            try {
                const output = await runCommand('nmap -sn 192.168.1.0/24 2>/dev/null', 30000);
                const db = getDb();
                const now = new Date().toISOString();

                const blocks = output.split('Nmap scan report for ').slice(1);
                const newDevices: string[] = [];
                const knownDevices: string[] = [];

                for (const block of blocks) {
                    const ipMatch = block.match(/(\d+\.\d+\.\d+\.\d+)/);
                    const macMatch = block.match(/MAC Address: ([0-9A-F:]+)\s*\(([^)]*)\)/i);
                    if (!ipMatch) continue;

                    const ip = ipMatch[1];
                    const mac = macMatch ? macMatch[1] : 'local';
                    const vendor = macMatch ? macMatch[2] : 'this device';

                    if (mac !== 'local') {
                        // Cross-reference BLE name for better heuristics
                        const bleDevice = db.prepare('SELECT name FROM ble_devices WHERE mac = ?').get(mac.toUpperCase()) as any;
                        const bleHint = bleDevice?.name || '';
                        const cls = classifyDevice(ip, mac, vendor, bleHint, []);

                        const existing = db.prepare('SELECT * FROM known_devices WHERE mac_address = ?').get(mac) as any;
                        if (!existing) {
                            db.prepare('INSERT INTO known_devices (mac_address, ip_address, hostname, device_type, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
                                .run(mac, ip, vendor, cls.type, cls.confidence, now, now);
                            const bleStr = bleHint ? ` 🔵${bleHint}` : '';
                            newDevices.push(`NEW: ${ip} — ${vendor}${bleStr} [${cls.type}] (${mac})`);
                        } else {
                            db.prepare('UPDATE known_devices SET ip_address = ?, device_type = CASE WHEN device_type = \'unknown\' THEN ? ELSE device_type END, last_seen = ? WHERE mac_address = ?')
                                .run(ip, cls.type, now, mac);
                            const name = existing.device_name || bleHint || vendor;
                            const type = existing.device_type !== 'unknown' ? existing.device_type : cls.type;
                            knownDevices.push(`${ip} — ${name} [${type}] (${mac})`);
                        }
                    } else {
                        knownDevices.push(`${ip} — this device [server]`);
                    }
                }

                const total = newDevices.length + knownDevices.length;
                const parts: string[] = [];
                if (newDevices.length > 0) parts.push(`🆕 Новые (${newDevices.length}):\n${newDevices.join('\n')}`);
                if (knownDevices.length > 0) parts.push(`✓ Известные (${knownDevices.length}):\n${knownDevices.join('\n')}`);
                return `[TOOL_RESULT] Найдено ${total} устройств:\n${parts.join('\n\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка сканирования: ${err.message}`;
            }
        },


        async network_devices() {
            const db = getDb();
            const devices = db.prepare('SELECT * FROM known_devices ORDER BY last_seen DESC').all() as any[];
            if (devices.length === 0) return '[TOOL_RESULT] Нет известных устройств. Запустите network_scan.';
            return '[TOOL_RESULT] Известные устройства:\n' + devices.map((d: any) =>
                `${d.ip_address} — ${d.device_name || d.hostname || 'Unknown'} [${d.device_type || 'unknown'}] (${d.mac_address})${d.is_trusted ? ' ✓' : ''}`
            ).join('\n');
        },

        async network_detective() {
            try {
                // Step 1: ARP table
                const arpRaw = await runCommand('arp -a 2>/dev/null || ip neigh show 2>/dev/null', 5000);
                const arpEntries = arpRaw.split('\n')
                    .map(line => {
                        // macOS: host (ip) at mac on iface
                        const m1 = line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-f:]+)/i);
                        if (m1) return { ip: m1[1], mac: m1[2].toUpperCase() };
                        // Linux: ip dev ... lladdr mac
                        const m2 = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+.*lladdr\s+([0-9a-f:]+)/i);
                        if (m2) return { ip: m2[1], mac: m2[2].toUpperCase() };
                        return null;
                    })
                    .filter((e): e is { ip: string; mac: string } => e !== null);

                if (arpEntries.length === 0) {
                    return '[TOOL_RESULT] ARP-таблица пуста. Сначала запусти network_scan для обнаружения.';
                }

                const db = getDb();
                const now = new Date().toISOString();
                const results: string[] = [];

                // Step 2: investigate each device
                for (const { ip, mac } of arpEntries) {
                    // Ping check
                    let alive = false;
                    try {
                        await runCommand(`ping -c 1 -W 1 ${ip}`, 3000);
                        alive = true;
                    } catch { }

                    // Reverse DNS
                    let hostname = '';
                    try {
                        const dns = await runCommand(`nslookup ${ip} 2>/dev/null | grep 'name ='`, 3000);
                        const m = dns.match(/name\s*=\s*(.+?)\.?\s*$/);
                        if (m) hostname = m[1];
                    } catch { }

                    // Port scan (top 20)
                    let ports: number[] = [];
                    try {
                        const nmapOut = await runCommand(`nmap -Pn -n --top-ports 20 ${ip} 2>/dev/null`, 15000);
                        const portMatches = nmapOut.matchAll(/(\d+)\/tcp\s+open/g);
                        for (const pm of portMatches) ports.push(parseInt(pm[1]));
                    } catch { }

                    // Get existing vendor from DB
                    const existing = db.prepare('SELECT * FROM known_devices WHERE mac_address = ?').get(mac) as any;
                    const vendor = existing?.hostname || '';

                    // Classify
                    const cls = classifyDevice(ip, mac, vendor, hostname, ports);

                    // Update DB
                    if (existing) {
                        db.prepare('UPDATE known_devices SET ip_address = ?, device_type = ?, confidence = ?, last_seen = ? WHERE mac_address = ?')
                            .run(ip, cls.type, cls.confidence, now, mac);
                    } else {
                        db.prepare('INSERT INTO known_devices (mac_address, ip_address, hostname, device_type, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
                            .run(mac, ip, hostname || 'unknown', cls.type, cls.confidence, now, now);
                    }

                    const name = existing?.device_name || hostname || vendor || mac;
                    const status = alive ? '✓' : '✗';
                    const portsStr = ports.length > 0 ? ` ports:[${ports.join(',')}]` : '';
                    results.push(`${status} ${ip} — ${name} [${cls.type}] (${cls.confidence}) ${cls.reason}${portsStr}`);
                }

                return `[TOOL_RESULT] Детальный анализ сети (${results.length} устройств):\n${results.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async ble_scan() {
            try {
                await runCommand('rfkill unblock bluetooth 2>/dev/null; hciconfig hci0 up 2>/dev/null', 5000);

                // Scan for 10 seconds, then list devices
                await runCommand('timeout 10 bluetoothctl --timeout 10 scan on 2>/dev/null || true', 15000);
                const devicesRaw = await runCommand('bluetoothctl devices 2>/dev/null', 5000);

                if (!devicesRaw.trim()) {
                    return '[TOOL_RESULT] BLE: устройств не обнаружено.';
                }

                const db = getDb();
                const now = new Date().toISOString();
                const results: string[] = [];

                // Parse "Device XX:XX:XX:XX:XX:XX DeviceName"
                for (const line of devicesRaw.split('\n')) {
                    const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.*)/i);
                    if (!m) continue;
                    const mac = m[1].toUpperCase();
                    const name = m[2].trim() || 'unnamed';

                    // Try to get RSSI
                    let rssi: number | null = null;
                    try {
                        const info = await runCommand(`bluetoothctl info ${mac} 2>/dev/null | grep RSSI`, 3000);
                        const rm = info.match(/RSSI:\s*(-?\d+)/);
                        if (rm) rssi = parseInt(rm[1]);
                    } catch { }

                    // Estimate distance from RSSI (rough: -30=close, -60=room, -90=far)
                    let distance = 'unknown';
                    if (rssi !== null) {
                        if (rssi > -40) distance = 'очень близко (<1m)';
                        else if (rssi > -60) distance = 'рядом (1-3m)';
                        else if (rssi > -80) distance = 'в комнате (3-8m)';
                        else distance = 'далеко (>8m)';
                    }

                    // Upsert DB
                    const existing = db.prepare('SELECT * FROM ble_devices WHERE mac = ?').get(mac) as any;
                    if (existing) {
                        db.prepare('UPDATE ble_devices SET name = ?, rssi = ?, last_seen = ? WHERE mac = ?')
                            .run(name, rssi, now, mac);
                    } else {
                        db.prepare('INSERT INTO ble_devices (mac, name, rssi, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)')
                            .run(mac, name, rssi, now, now);
                    }

                    const rssiStr = rssi !== null ? `${rssi}dBm` : '?';
                    const residentFlag = existing?.is_resident ? ' 👤' : '';
                    results.push(`${mac} — ${name} [${rssiStr}, ${distance}]${residentFlag}`);
                }

                return `[TOOL_RESULT] BLE устройства (${results.length}):\n${results.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] BLE ошибка: ${err.message}`;
            }
        },

        async network_map() {
            const db = getDb();
            const devices = db.prepare('SELECT * FROM known_devices ORDER BY device_type, last_seen DESC').all() as any[];
            if (devices.length === 0) return '[TOOL_RESULT] Нет устройств. Запусти network_scan.';

            // Group by type
            const groups = new Map<string, any[]>();
            for (const d of devices) {
                const type = d.device_type || 'unknown';
                if (!groups.has(type)) groups.set(type, []);
                groups.get(type)!.push(d);
            }

            const typeLabels: Record<string, string> = {
                'router': '🌐 Роутеры',
                'server': '🖥 Серверы',
                'smartphone': '📱 Смартфоны',
                'computer': '💻 Компьютеры',
                'iot': '📡 IoT устройства',
                'iot-gateway': '🏠 IoT шлюзы',
                'tv/media': '📺 ТВ/Медиа',
                'printer': '🖨 Принтеры',
                'unknown': '❓ Неопознанные',
            };

            const now = Date.now();
            const lines: string[] = [];
            let total = 0;

            for (const [type, devs] of groups) {
                const label = typeLabels[type] || `📦 ${type}`;
                lines.push(`\n${label} (${devs.length}):`);
                for (const d of devs) {
                    const name = d.device_name || d.hostname || d.mac_address;
                    const lastMs = d.last_seen ? now - new Date(d.last_seen).getTime() : Infinity;
                    const online = lastMs < 4 * 60 * 60 * 1000; // seen in last 4h
                    const status = online ? '✓' : '✗';
                    lines.push(`  ${status} ${d.ip_address} — ${name}`);
                    total++;
                }
            }

            const onlineCount = devices.filter(d => d.last_seen && (now - new Date(d.last_seen).getTime()) < 4 * 60 * 60 * 1000).length;
            return `[TOOL_RESULT] Карта сети: ${total} устройств (${onlineCount} онлайн)\n${lines.join('\n')}`;
        },

        async ble_presence() {
            try {
                const db = getDb();
                const residents = db.prepare('SELECT * FROM ble_devices WHERE is_resident = 1').all() as any[];

                if (residents.length === 0) {
                    return '[TOOL_RESULT] Нет BLE-устройств, помеченных как жильцы. Сначала запусти ble_scan, потом отметь устройства.';
                }

                // Ensure BT is up
                await runCommand('rfkill unblock bluetooth 2>/dev/null; hciconfig hci0 up 2>/dev/null', 5000);

                const now = new Date().toISOString();
                const results: string[] = [];

                for (const dev of residents) {
                    let nearby = false;
                    try {
                        // Try to resolve name — if responds, device is nearby
                        const name = await runCommand(`hcitool name ${dev.mac} 2>/dev/null`, 5000);
                        if (name.trim()) nearby = true;
                    } catch { }

                    if (!nearby) {
                        // Fallback: l2ping
                        try {
                            await runCommand(`l2ping -c 1 -t 2 ${dev.mac} 2>/dev/null`, 5000);
                            nearby = true;
                        } catch { }
                    }

                    if (nearby) {
                        db.prepare('UPDATE ble_devices SET last_seen = ? WHERE mac = ?').run(now, dev.mac);
                    }

                    const lastSeen = dev.last_seen ? new Date(dev.last_seen).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Rome' }) : '?';
                    const status = nearby ? '✓ рядом' : `✗ нет (был: ${lastSeen})`;
                    results.push(`${dev.name || dev.mac}: ${status}`);
                }

                return `[TOOL_RESULT] BLE присутствие:\n${results.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] BLE ошибка: ${err.message}`;
            }
        },
    }
};

export default skill;
