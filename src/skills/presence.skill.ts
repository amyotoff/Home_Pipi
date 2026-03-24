import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import { runCommand } from '../utils/shell';

const skill: SkillManifest = {
    name: 'presence',
    description: 'Определение присутствия жильцов дома по сети (ping + ARP + BLE)',
    version: '2.0.0',
    tools: [
        {
            name: 'who_is_home',
            description: 'Check which residents are currently home based on network presence (ping + ARP + BLE hybrid).',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'presence_register_phone',
            description: 'Register a resident\'s phone via Bluetooth (they must pair it or bring it very close, < 1m). Use this when the user says "я спарил телефон" or asks to check-in via bluetooth.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    resident_name: { type: Type.STRING, description: 'Name of the resident registering their phone (e.g. Илья).' }
                },
                required: ['resident_name'],
            }
        },
    ],
    handlers: {
        async who_is_home() {
            // Reads DB state maintained by runPresenceCheck() every 5 min — no extra shell calls
            const db = getDb();
            const residents = db.prepare(
                'SELECT * FROM residents WHERE ip_address IS NOT NULL OR mac_address IS NOT NULL'
            ).all() as any[];

            if (residents.length === 0) return '[TOOL_RESULT] Нет жильцов с настроенным IP/MAC для детекта присутствия.';

            const results: string[] = [];
            for (const r of residents) {
                const name = r.display_name || r.username || r.tg_id;
                if (r.is_home) {
                    results.push(`${name}: дома`);
                } else {
                    const lastSeen = r.last_seen ? new Date(r.last_seen).toLocaleTimeString('ru-RU') : 'неизвестно';
                    results.push(`${name}: отсутствует (последний раз: ${lastSeen})`);
                }
            }
            return '[TOOL_RESULT] Присутствие:\n' + results.join('\n');
        },
        async presence_register_phone(args: { resident_name: string }) {
            try {
                const db = getDb();
                const resident = db.prepare('SELECT * FROM residents WHERE display_name LIKE ? OR username LIKE ?'
                ).get(`%${args.resident_name}%`, `%${args.resident_name}%`) as any;

                if (!resident) {
                    return `[TOOL_RESULT] Жилец "${args.resident_name}" не найден в базе данных. Возможные имена: ` +
                        (db.prepare('SELECT display_name FROM residents').all() as any[]).map(r => r.display_name).join(', ');
                }

                // 1. Убеждаемся, что Bluetooth включен
                await runCommand('rfkill unblock bluetooth 2>/dev/null; hciconfig hci0 up 2>/dev/null', 5000);

                // 2. Сканируем 10 секунд (чтобы найти устройства рядом)
                await runCommand('timeout 10 bluetoothctl --timeout 10 scan on 2>/dev/null || true', 15000);

                // 3. Получаем список всех устройств
                const devicesRaw = await runCommand('bluetoothctl devices 2>/dev/null', 5000);

                let bestMac = '';
                let bestName = '';
                let bestRssi = -999;
                let isPaired = false;

                // Парсим устройства и ищем самое близкое (RSSI)
                for (const line of devicesRaw.split('\n')) {
                    const m = line.match(/Device\s+([0-9A-F:]{17})\s+(.*)/i);
                    if (!m) continue;
                    const mac = m[1].toUpperCase();
                    const name = m[2].trim();

                    try {
                        const info = await runCommand(`bluetoothctl info ${mac} 2>/dev/null`, 3000);
                        const rm = info.match(/RSSI:\s*(-?\d+)/);
                        const pairedMatch = info.match(/Paired:\s*yes/i);

                        // Приоритет спаренным устройствам, иначе смотрим RSSI
                        if (rm) {
                            const rssi = parseInt(rm[1]);
                            if (rssi > bestRssi) {
                                bestRssi = rssi;
                                bestMac = mac;
                                bestName = name;
                                isPaired = !!pairedMatch;
                            }
                        } else if (pairedMatch && bestRssi === -999) {
                            // Если нет RSSI, но устройство спарено (и пока нет лучших вариантов)
                            bestMac = mac;
                            bestName = name;
                            isPaired = true;
                        }
                    } catch { }
                }

                if (!bestMac || (bestRssi < -65 && !isPaired)) {
                    return `[TOOL_RESULT] Не нашел телефон достаточно близко. Пусть ${args.resident_name} поднесет телефон ВПЛОТНУЮ (ближе 1 метра) или спарит его с PiPi по Bluetooth. Лучший сигнал: ${bestRssi}dBm.`;
                }

                // 4. Сохраняем MAC как телефон хозяина
                db.prepare('UPDATE residents SET ble_mac = ?, is_home = 1, last_seen = ? WHERE tg_id = ?').run(bestMac, new Date().toISOString(), resident.tg_id);

                // 5. Также фиксируем его в ble_devices как устройство хозяина
                const exist = db.prepare('SELECT mac FROM ble_devices WHERE mac = ?').get(bestMac);
                if (exist) {
                    db.prepare('UPDATE ble_devices SET is_resident = 1, name = ?, rssi = ?, last_seen = ? WHERE mac = ?').run(bestName, bestRssi, new Date().toISOString(), bestMac);
                } else {
                    db.prepare('INSERT INTO ble_devices (mac, name, rssi, is_resident, first_seen, last_seen) VALUES (?, ?, ?, 1, ?, ?)').run(bestMac, bestName, bestRssi, new Date().toISOString(), new Date().toISOString());
                }

                const pairedStr = isPaired ? '(спарено)' : `(сигнал: ${bestRssi}dBm)`;
                return `[TOOL_RESULT] Успех! Я нашел телефон "${bestName}" ${pairedStr} с MAC-адресом ${bestMac} и привязал его к жильцу ${resident.display_name}. Режим присутствия через Bluetooth активирован.`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },
    }
};

export default skill;
