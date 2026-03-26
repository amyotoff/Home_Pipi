import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { HA_CLIMATE_ENTITY } from '../config';
import { getMockACState, setMockACState, formatACState } from '../mocks/sensors';
import { checkHa, haCallService, haGetState } from '../ha';

// Use HA if HA_CLIMATE_ENTITY is configured, otherwise fall back to mock
const USE_HA = !!HA_CLIMATE_ENTITY;

const skill: SkillManifest = {
    name: 'ac-control',
    description: USE_HA
        ? `Управление кондиционером через Home Assistant (${HA_CLIMATE_ENTITY})`
        : 'Управление кондиционером (mock-режим)',
    version: '2.0.0',
    tools: [
        {
            name: 'ac_control',
            description: 'Control air conditioner: on, off, temp_up, temp_down, set mode or fan speed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    action: {
                        type: Type.STRING,
                        description: 'Action to perform.',
                        enum: ['on', 'off', 'temp_up', 'temp_down', 'mode', 'fan'],
                    },
                    value: {
                        type: Type.STRING,
                        description: 'Value for mode (cool/heat/fan/auto) or fan (low/medium/high/auto).',
                    },
                },
                required: ['action'],
            },
        },
        {
            name: 'ac_status',
            description: 'Get current AC state: power, mode, target temperature, fan speed.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'ac_set_temperature',
            description: 'Set air conditioner to an exact target temperature.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    temp: { type: Type.NUMBER, description: 'Target temperature in °C (e.g. 22).' },
                },
                required: ['temp'],
            },
        },
    ],
    handlers: {
        async ac_control(args: { action: string; value?: string }) {
            if (USE_HA) {
                if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
                try {
                    const entity_id = HA_CLIMATE_ENTITY;
                    switch (args.action) {
                        case 'on':
                            await haCallService('climate', 'turn_on', { entity_id });
                            break;
                        case 'off':
                            await haCallService('climate', 'turn_off', { entity_id });
                            break;
                        case 'temp_up':
                        case 'temp_down': {
                            const state = await haGetState(entity_id);
                            const current = Number(state.attributes.temperature ?? 22);
                            const delta = args.action === 'temp_up' ? 1 : -1;
                            await haCallService('climate', 'set_temperature', { entity_id, temperature: current + delta });
                            return `[TOOL_RESULT] Температура → ${current + delta}°C`;
                        }
                        case 'mode': {
                            const valid = ['cool', 'heat', 'fan_only', 'auto', 'off'];
                            if (!args.value || !valid.includes(args.value))
                                return `[TOOL_RESULT] Неизвестный режим. Доступные: ${valid.join(', ')}`;
                            await haCallService('climate', 'set_hvac_mode', { entity_id, hvac_mode: args.value });
                            break;
                        }
                        case 'fan': {
                            const valid = ['low', 'medium', 'high', 'auto'];
                            if (!args.value || !valid.includes(args.value))
                                return `[TOOL_RESULT] Неизвестная скорость. Доступные: ${valid.join(', ')}`;
                            await haCallService('climate', 'set_fan_mode', { entity_id, fan_mode: args.value });
                            break;
                        }
                        default:
                            return `[TOOL_RESULT] Неизвестное действие "${args.action}".`;
                    }
                    const updated = await haGetState(entity_id);
                    return `[TOOL_RESULT] AC: ${updated.state}, ${updated.attributes.temperature}°C`;
                } catch (err: any) {
                    return `[TOOL_RESULT] Ошибка: ${err.message}`;
                }
            }

            // ── Mock fallback ──
            const state = getMockACState();
            switch (args.action) {
                case 'on':  setMockACState({ power: true }); break;
                case 'off': setMockACState({ power: false }); break;
                case 'temp_up':   setMockACState({ target_temp: state.target_temp + 1 }); break;
                case 'temp_down': setMockACState({ target_temp: state.target_temp - 1 }); break;
                case 'mode': {
                    const valid = ['cool', 'heat', 'fan', 'auto'];
                    if (args.value && valid.includes(args.value)) setMockACState({ mode: args.value as any });
                    else return `[TOOL_RESULT] Неизвестный режим. Доступные: ${valid.join(', ')}`;
                    break;
                }
                case 'fan': {
                    const valid = ['low', 'medium', 'high', 'auto'];
                    if (args.value && valid.includes(args.value)) setMockACState({ fan_speed: args.value as any });
                    else return `[TOOL_RESULT] Неизвестная скорость. Доступные: ${valid.join(', ')}`;
                    break;
                }
                default:
                    return `[TOOL_RESULT] Неизвестное действие "${args.action}".`;
            }
            return `[TOOL_RESULT] AC: ${formatACState(getMockACState())}`;
        },

        async ac_status() {
            if (USE_HA) {
                if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
                try {
                    const s = await haGetState(HA_CLIMATE_ENTITY);
                    const temp = s.attributes.temperature !== undefined ? `${s.attributes.temperature}°C` : '?';
                    const cur  = s.attributes.current_temperature !== undefined ? `, текущая: ${s.attributes.current_temperature}°C` : '';
                    return `[TOOL_RESULT] Кондиционер: ${s.state}, целевая: ${temp}${cur}`;
                } catch (err: any) {
                    return `[TOOL_RESULT] Ошибка: ${err.message}`;
                }
            }
            return `[TOOL_RESULT] Кондиционер: ${formatACState(getMockACState())}`;
        },

        async ac_set_temperature(args: { temp: number }) {
            if (USE_HA) {
                if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
                const t = Math.max(16, Math.min(30, Math.round(args.temp)));
                try {
                    await haCallService('climate', 'set_temperature', { entity_id: HA_CLIMATE_ENTITY, temperature: t });
                    return `[TOOL_RESULT] Температура установлена: ${t}°C`;
                } catch (err: any) {
                    return `[TOOL_RESULT] Ошибка: ${err.message}`;
                }
            }
            // mock
            const t = Math.max(16, Math.min(30, Math.round(args.temp)));
            setMockACState({ target_temp: t });
            return `[TOOL_RESULT] (mock) Температура установлена: ${t}°C`;
        },
    },
};

export default skill;
