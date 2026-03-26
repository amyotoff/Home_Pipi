import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { Z2M_SENSOR_ID, HA_CO2_ENTITY } from '../config';
import { getDb, logEvent } from '../db';
import { getSensor } from '../mqtt';
import { checkHa, haGet, haGetState } from '../ha';

const USE_HA_CO2 = !!HA_CO2_ENTITY;

const STALE_THRESHOLD = 1_800_000; // 30 min
const LOW_BATTERY_THRESHOLD = 15;

interface SensorReading {
    temperature?: number;
    humidity?: number;
    battery?: number;
    online: boolean;
    staleMinutes?: number;
}

function readSensor(): SensorReading {
    const sensor = getSensor(Z2M_SENSOR_ID);
    if (!sensor) {
        return { online: false };
    }
    const age = Date.now() - sensor.timestamp;
    if (age > STALE_THRESHOLD) {
        return { online: false, staleMinutes: Math.round(age / 60_000) };
    }
    return {
        temperature: sensor.temperature,
        humidity: sensor.humidity,
        battery: sensor.battery,
        online: true,
    };
}

const skill: SkillManifest = {
    name: 'room-sensor',
    description: 'Датчики студии: температура, влажность (SNZB-02D через Zigbee2MQTT)',
    version: '1.0.0',
    tools: [
        {
            name: 'room_temperature',
            description: 'Get current room temperature.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'room_humidity',
            description: 'Get current room humidity.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'room_co2',
            description: 'Get current CO₂ level in the room.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'room_comfort',
            description: 'Get a combined comfort assessment: temperature, humidity, CO₂, and advice.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'zone_presence',
            description: 'Check presence in studio zones (desk, kitchen, bed) via Everything Presence Lite mmWave sensor.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'room_history',
            description: 'Get sensor reading history for the last N hours.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    hours: { type: Type.INTEGER, description: 'Hours of history to show (default 3, max 24).' },
                    sensor: { type: Type.STRING, description: 'Sensor type: temperature, humidity. Default: all.' },
                },
            }
        },
    ],
    handlers: {
        async room_temperature() {
            const s = readSensor();
            if (!s.online) {
                const ago = s.staleMinutes ? ` (последние данные ${s.staleMinutes} мин назад)` : '';
                return `[TOOL_RESULT] Датчик SNZB-02D не отвечает${ago}. Проверь батарею или связь Zigbee.`;
            }
            return `[TOOL_RESULT] Температура: ${s.temperature!.toFixed(1)}°C (SNZB-02D)`;
        },

        async room_humidity() {
            const s = readSensor();
            if (!s.online) {
                const ago = s.staleMinutes ? ` (последние данные ${s.staleMinutes} мин назад)` : '';
                return `[TOOL_RESULT] Датчик SNZB-02D не отвечает${ago}. Проверь батарею или связь Zigbee.`;
            }
            return `[TOOL_RESULT] Влажность: ${s.humidity!}% (SNZB-02D)`;
        },

        async room_co2() {
            if (USE_HA_CO2) {
                if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
                try {
                    const s = await haGetState(HA_CO2_ENTITY);
                    const ppm = Number(s.state);
                    const level = ppm > 2000 ? '🔴 опасно' : ppm > 1000 ? '🟡 высокий' : '🟢 норма';
                    return `[TOOL_RESULT] CO₂: ${ppm} ppm (${level})`;
                } catch (err: any) {
                    return `[TOOL_RESULT] Ошибка CO₂: ${err.message}`;
                }
            }
            return '[TOOL_RESULT] Датчик CO₂ не подключён. Требуется установка датчика (например, SCD40/SCD41).';
        },

        async room_comfort() {
            const s = readSensor();

            if (!s.online) {
                const ago = s.staleMinutes ? ` (последние данные ${s.staleMinutes} мин назад)` : '';
                return `[TOOL_RESULT] Комфорт в студии:\nДатчик SNZB-02D не отвечает${ago}!`;
            }

            const advice: string[] = [];
            if (s.temperature! > 26) advice.push('жарко — включи кондей');
            else if (s.temperature! < 19) advice.push('холодно — включи обогрев');
            if (s.humidity! < 35) advice.push('сухо — нужен увлажнитель');
            else if (s.humidity! > 60) advice.push('влажно — проветри');

            let co2Line = '';
            if (USE_HA_CO2) {
                try {
                    const co2State = await haGetState(HA_CO2_ENTITY);
                    const ppm = Number(co2State.state);
                    co2Line = `CO₂: ${ppm} ppm\n`;
                    if (ppm > 1000) advice.push('CO₂ высокий — проветри');
                } catch { /* ignore, CO2 is optional */ }
            }

            return `[TOOL_RESULT] Комфорт в студии:\n` +
                `Температура: ${s.temperature!.toFixed(1)}°C\n` +
                `Влажность: ${s.humidity!}%\n` +
                co2Line +
                (s.battery !== undefined ? `Батарея датчика: ${s.battery}%\n` : '') +
                (advice.length > 0 ? `Совет: ${advice.join('; ')}` : 'Всё в норме.');
        },

        async zone_presence() {
            return '[TOOL_RESULT] Everything Presence Lite не подключён. Требуется установка mmWave-датчика.';
        },

        async room_history(args: { hours?: number; sensor?: string }) {
            const hours = Math.min(Math.max(args.hours || 3, 1), 24);

            // HA history path: use if CO₂ entity is configured
            if (USE_HA_CO2) {
                if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
                try {
                    const start = new Date(Date.now() - hours * 3600_000).toISOString();
                    const data: any[][] = await haGet(
                        `/api/history/period/${start}?filter_entity_id=${HA_CO2_ENTITY}&end_time=${new Date().toISOString()}`
                    );
                    const readings = data?.[0] ?? [];
                    if (!readings.length) return `[TOOL_RESULT] Нет данных CO₂ за последние ${hours}ч.`;
                    const lines = readings
                        .filter((_: any, i: number) => i % Math.max(1, Math.floor(readings.length / 20)) === 0)
                        .map((r: any) => {
                            const time = new Date(r.last_changed).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                            return `${time} CO₂: ${r.state} ppm`;
                        });
                    return `[TOOL_RESULT] История CO₂ за ${hours}ч:\n${lines.join('\n')}`;
                } catch (err: any) {
                    return `[TOOL_RESULT] Ошибка истории: ${err.message}`;
                }
            }

            // SQLite fallback (temperature + humidity from MQTT)
            const db = getDb();
            const since = new Date(Date.now() - hours * 3600000).toISOString();

            let typeFilter = '';
            const validTypes = ['temperature', 'humidity'];
            if (args.sensor && validTypes.includes(args.sensor)) {
                typeFilter = ` AND type = '${args.sensor}'`;
            }

            const rows = db.prepare(
                `SELECT type, value, timestamp FROM sensor_readings
                 WHERE sensor_id = 'studio' AND timestamp > ?${typeFilter}
                 ORDER BY timestamp DESC LIMIT 50`
            ).all(since) as any[];

            if (rows.length === 0) {
                return `[TOOL_RESULT] Нет данных за последние ${hours}ч. Данные появятся после первого цикла записи (каждые 5 мин).`;
            }

            const lines = rows.map((r: any) => {
                const time = new Date(r.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
                const unit = r.type === 'temperature' ? '°C' : '%';
                return `${time} ${r.type}: ${r.value}${unit}`;
            });
            return `[TOOL_RESULT] История за ${hours}ч:\n${lines.join('\n')}`;
        },
    },

    crons: [
        {
            expression: '*/5 * * * *',
            description: 'Record sensor readings to DB',
            handler: async () => {
                const s = readSensor();
                const db = getDb();
                const now = new Date().toISOString();

                // Sensor offline — log event, Jivs decides when to notify
                if (!s.online) {
                    const ago = s.staleMinutes ? `${s.staleMinutes} мин` : 'неизвестно';
                    console.warn(`[SENSOR] SNZB-02D offline! Last data: ${ago} ago`);
                    logEvent('sensor_offline', { sensor: 'SNZB-02D', last_data_ago: ago });
                    return;
                }

                // Low battery — log event, Jivs decides when to notify
                if (s.battery !== undefined && s.battery <= LOW_BATTERY_THRESHOLD) {
                    logEvent('sensor_low_battery', { sensor: 'SNZB-02D', battery: s.battery });
                }

                const insert = db.prepare(
                    'INSERT INTO sensor_readings (sensor_id, type, value, timestamp) VALUES (?, ?, ?, ?)'
                );
                insert.run('studio', 'temperature', s.temperature!, now);
                insert.run('studio', 'humidity', s.humidity!, now);

                console.log(`[SENSOR] Recorded: ${s.temperature!.toFixed(1)}°C, ${s.humidity!}%, bat: ${s.battery ?? '?'}%`);
            },
        },
    ],
};

export default skill;
