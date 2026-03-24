import mqtt, { MqttClient } from 'mqtt';
import { logEvent } from './db';
import { notifyHousehold } from './channels/telegram';

export interface SensorData {
    temperature?: number;
    humidity?: number;
    battery?: number;
    linkquality?: number;
    timestamp: number;
}

const sensors: Record<string, SensorData> = {};
const knownDevices = new Set<string>();
let client: MqttClient | null = null;

export function getMqttClient(): MqttClient | null {
    return client;
}

export function getSensor(name: string): SensorData | null {
    return sensors[name] || null;
}

export function getAllSensors(): Record<string, SensorData> {
    return { ...sensors };
}

export function startMqtt(url: string): MqttClient {
    client = mqtt.connect(url);

    client.on('connect', () => {
        console.log(`[MQTT] Connected to ${url}`);
        client!.subscribe('zigbee2mqtt/+', (err) => {
            if (err) console.error('[MQTT] Subscribe error:', err);
            else console.log('[MQTT] Subscribed to zigbee2mqtt/+');
        });
        client!.subscribe('zigbee2mqtt/bridge/event', (err) => {
            if (err) console.error('[MQTT] Subscribe bridge/event error:', err);
        });
    });

    client.on('message', (topic, payload) => {
        // Bridge events — new devices, interviews
        if (topic === 'zigbee2mqtt/bridge/event') {
            handleBridgeEvent(payload.toString());
            return;
        }

        // Skip other bridge topics
        if (topic.startsWith('zigbee2mqtt/bridge')) return;

        try {
            const data = JSON.parse(payload.toString());
            const device = topic.replace('zigbee2mqtt/', '');
            sensors[device] = { ...data, timestamp: Date.now() };
        } catch {
            // ignore non-JSON messages
        }
    });

    client.on('error', (err) => {
        console.error('[MQTT] Error:', err.message);
    });

    return client;
}

function handleBridgeEvent(raw: string) {
    try {
        const event = JSON.parse(raw);

        if (event.type === 'device_interview' && event.data?.status === 'successful') {
            const addr = event.data.ieee_address;
            const def = event.data.definition;
            if (!addr || knownDevices.has(addr)) return;
            knownDevices.add(addr);

            const model = def?.model || 'unknown';
            const vendor = def?.vendor || 'unknown';
            const description = def?.description || '';
            const msg = `Новое Zigbee-устройство: ${vendor} ${model} (${description}), адрес: ${addr}`;

            console.log(`[MQTT] ${msg}`);
            logEvent('zigbee_device_joined', { addr, vendor, model, description });
            notifyHousehold(`📡 ${msg}`);
        }
    } catch {
        // ignore parse errors
    }
}
