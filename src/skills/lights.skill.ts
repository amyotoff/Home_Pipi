import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { TradfriClient, Accessory, AccessoryTypes } from 'node-tradfri-client';
import { IKEA_GATEWAY_IP, IKEA_SECURITY_CODE, DATA_DIR } from '../config';
import fs from 'fs';
import path from 'path';

// ==========================================
// Tradfri Connection State
// ==========================================

let tradfri: TradfriClient | null = null;
let connected = false;
const lights: Map<number, Accessory> = new Map();
const IDENTITY_FILE = path.join(DATA_DIR, 'tradfri-identity.json');

interface TradfriIdentity {
    identity: string;
    psk: string;
}

function loadIdentity(): TradfriIdentity | null {
    try {
        if (fs.existsSync(IDENTITY_FILE)) {
            return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
        }
    } catch {}
    return null;
}

function saveIdentity(id: TradfriIdentity): void {
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(id, null, 2));
}

async function ensureConnection(): Promise<boolean> {
    if (connected && tradfri) return true;

    if (!IKEA_GATEWAY_IP) {
        console.warn('[LIGHTS] No IKEA_GATEWAY_IP configured');
        return false;
    }

    try {
        tradfri = new TradfriClient(IKEA_GATEWAY_IP);

        // Try saved identity first
        let identity = loadIdentity();

        if (!identity) {
            if (!IKEA_SECURITY_CODE) {
                console.warn('[LIGHTS] No saved identity and no IKEA_SECURITY_CODE for initial auth');
                return false;
            }
            console.log('[LIGHTS] First-time authentication with security code...');
            const result = await tradfri.authenticate(IKEA_SECURITY_CODE);
            identity = { identity: result.identity, psk: result.psk };
            saveIdentity(identity);
            console.log('[LIGHTS] Identity saved to', IDENTITY_FILE);
        }

        await tradfri.connect(identity.identity, identity.psk);
        connected = true;

        // Observe devices
        tradfri
            .on('device updated', (device: Accessory) => {
                if (device.type === AccessoryTypes.lightbulb) {
                    lights.set(device.instanceId, device);
                }
            })
            .on('device removed', (instanceId: number) => {
                lights.delete(instanceId);
            })
            .observeDevices();

        // Wait a bit for device list to populate
        await new Promise(r => setTimeout(r, 2000));
        console.log(`[LIGHTS] Connected. Found ${lights.size} light(s).`);
        return true;
    } catch (err: any) {
        console.error('[LIGHTS] Connection failed:', err.message);
        connected = false;

        // If auth failed with saved identity, delete it and retry with security code
        if (err.message?.includes('denied') || err.message?.includes('auth')) {
            console.log('[LIGHTS] Deleting saved identity, will re-auth on next attempt');
            try { fs.unlinkSync(IDENTITY_FILE); } catch {}
        }

        return false;
    }
}

function findLight(name: string): Accessory | null {
    const lower = name.toLowerCase();

    // "all" returns null — handled separately
    if (lower === 'all' || lower === 'все' || lower === 'всё') return null;

    for (const [, device] of lights) {
        if (device.name.toLowerCase().includes(lower)) return device;
    }

    // Try by instance ID
    const id = parseInt(name);
    if (!isNaN(id) && lights.has(id)) return lights.get(id)!;

    return null;
}

function getLightStatus(device: Accessory): string {
    const light = device.lightList?.[0];
    if (!light) return `${device.name}: нет данных`;

    const state = light.onOff ? 'вкл' : 'выкл';
    const brightness = light.dimmer !== undefined ? ` (${light.dimmer}%)` : '';
    return `${device.name}: ${state}${brightness}`;
}

// ==========================================
// Skill Definition
// ==========================================

const skill: SkillManifest = {
    name: 'lights',
    description: 'Управление IKEA Tradfri освещением: включить/выключить, яркость, статус, Party Mode',
    version: '1.0.0',
    tools: [
        {
            name: 'lights_on',
            description: 'Turn on a specific light or all lights. Optionally set brightness.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    light_name: { type: Type.STRING, description: 'Light name or "all" for all lights.' },
                    brightness: { type: Type.INTEGER, description: 'Brightness 1-100 (optional, default 100).' }
                },
                required: ['light_name'],
            }
        },
        {
            name: 'lights_off',
            description: 'Turn off a specific light or all lights.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    light_name: { type: Type.STRING, description: 'Light name or "all" for all lights.' }
                },
                required: ['light_name'],
            }
        },
        {
            name: 'lights_status',
            description: 'Get on/off status and brightness of all lights.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'lights_party_mode',
            description: 'Activate party mode — rapidly toggle lights for fun.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    duration_seconds: { type: Type.INTEGER, description: 'Duration in seconds (default 10, max 30).' }
                }
            }
        },
    ],
    handlers: {
        async lights_on(args: { light_name: string; brightness?: number }) {
            if (!await ensureConnection() || !tradfri) {
                return '[TOOL_RESULT] Шлюз IKEA Tradfri недоступен. Проверь подключение.';
            }

            const brightness = Math.max(1, Math.min(100, args.brightness || 100));
            const isAll = ['all', 'все', 'всё'].includes(args.light_name.toLowerCase());

            if (isAll) {
                if (lights.size === 0) return '[TOOL_RESULT] Лампочки не найдены.';
                let count = 0;
                for (const [, device] of lights) {
                    try {
                        await tradfri.operateLight(device, { onOff: true, dimmer: brightness });
                        count++;
                    } catch (err: any) {
                        console.error(`[LIGHTS] Failed to turn on ${device.name}:`, err.message);
                    }
                }
                return `[TOOL_RESULT] Включено ${count}/${lights.size} ламп на ${brightness}%.`;
            }

            const device = findLight(args.light_name);
            if (!device) {
                const available = [...lights.values()].map(d => d.name).join(', ');
                return `[TOOL_RESULT] Лампа "${args.light_name}" не найдена. Доступные: ${available || 'нет'}`;
            }

            try {
                await tradfri.operateLight(device, { onOff: true, dimmer: brightness });
                return `[TOOL_RESULT] ${device.name} включена на ${brightness}%.`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async lights_off(args: { light_name: string }) {
            if (!await ensureConnection() || !tradfri) {
                return '[TOOL_RESULT] Шлюз IKEA Tradfri недоступен. Проверь подключение.';
            }

            const isAll = ['all', 'все', 'всё'].includes(args.light_name.toLowerCase());

            if (isAll) {
                if (lights.size === 0) return '[TOOL_RESULT] Лампочки не найдены.';
                let count = 0;
                for (const [, device] of lights) {
                    try {
                        await tradfri.operateLight(device, { onOff: false });
                        count++;
                    } catch (err: any) {
                        console.error(`[LIGHTS] Failed to turn off ${device.name}:`, err.message);
                    }
                }
                return `[TOOL_RESULT] Выключено ${count}/${lights.size} ламп.`;
            }

            const device = findLight(args.light_name);
            if (!device) {
                const available = [...lights.values()].map(d => d.name).join(', ');
                return `[TOOL_RESULT] Лампа "${args.light_name}" не найдена. Доступные: ${available || 'нет'}`;
            }

            try {
                await tradfri.operateLight(device, { onOff: false });
                return `[TOOL_RESULT] ${device.name} выключена.`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async lights_status() {
            if (!await ensureConnection()) {
                return '[TOOL_RESULT] Шлюз IKEA Tradfri недоступен.';
            }

            if (lights.size === 0) return '[TOOL_RESULT] Лампочки не найдены.';

            const statuses = [...lights.values()].map(getLightStatus);
            return `[TOOL_RESULT] Лампы (${lights.size}):\n${statuses.join('\n')}`;
        },

        async lights_party_mode(args: { duration_seconds?: number }) {
            if (!await ensureConnection() || !tradfri) {
                return '[TOOL_RESULT] Шлюз IKEA Tradfri недоступен.';
            }

            if (lights.size === 0) return '[TOOL_RESULT] Лампочки не найдены для Party Mode.';

            const duration = Math.max(3, Math.min(30, args.duration_seconds || 10));
            const endTime = Date.now() + duration * 1000;
            const devices = [...lights.values()];

            let cycles = 0;
            while (Date.now() < endTime) {
                for (const device of devices) {
                    try {
                        const randomBrightness = Math.floor(Math.random() * 100) + 1;
                        await tradfri.operateLight(device, {
                            onOff: true,
                            dimmer: randomBrightness,
                            transitionTime: 0.2,
                        });
                    } catch {}
                }
                cycles++;
                await new Promise(r => setTimeout(r, 500));
            }

            // Restore all to 100%
            for (const device of devices) {
                try {
                    await tradfri.operateLight(device, { onOff: true, dimmer: 100, transitionTime: 0.5 });
                } catch {}
            }

            return `[TOOL_RESULT] Party Mode завершён. ${cycles} циклов за ${duration}с. Лампы на 100%.`;
        },
    }
};

export default skill;
