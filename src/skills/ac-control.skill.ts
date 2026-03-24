import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { MOCK_SENSORS } from '../config';
import { getMockACState, setMockACState, formatACState } from '../mocks/sensors';

const skill: SkillManifest = {
    name: 'ac-control',
    description: 'Управление кондиционером через Broadlink RM4 Mini (ИК-бластер)',
    version: '1.0.0',
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
                        enum: ['on', 'off', 'temp_up', 'temp_down', 'mode', 'fan']
                    },
                    value: {
                        type: Type.STRING,
                        description: 'Value for mode (cool/heat/fan/auto) or fan (low/medium/high/auto).',
                    },
                },
                required: ['action'],
            }
        },
        {
            name: 'ac_status',
            description: 'Get current AC state: power, mode, target temperature, fan speed.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
    ],
    handlers: {
        async ac_control(args: { action: string; value?: string }) {
            if (MOCK_SENSORS) {
                const state = getMockACState();
                switch (args.action) {
                    case 'on':
                        setMockACState({ power: true });
                        break;
                    case 'off':
                        setMockACState({ power: false });
                        break;
                    case 'temp_up':
                        setMockACState({ target_temp: state.target_temp + 1 });
                        break;
                    case 'temp_down':
                        setMockACState({ target_temp: state.target_temp - 1 });
                        break;
                    case 'mode': {
                        const valid = ['cool', 'heat', 'fan', 'auto'];
                        if (args.value && valid.includes(args.value)) {
                            setMockACState({ mode: args.value as any });
                        } else {
                            return `[TOOL_RESULT] Неизвестный режим. Доступные: ${valid.join(', ')}`;
                        }
                        break;
                    }
                    case 'fan': {
                        const valid = ['low', 'medium', 'high', 'auto'];
                        if (args.value && valid.includes(args.value)) {
                            setMockACState({ fan_speed: args.value as any });
                        } else {
                            return `[TOOL_RESULT] Неизвестная скорость. Доступные: ${valid.join(', ')}`;
                        }
                        break;
                    }
                    default:
                        return `[TOOL_RESULT] Неизвестное действие "${args.action}". Доступные: on, off, temp_up, temp_down, mode, fan.`;
                }
                const updated = getMockACState();
                return `[TOOL_RESULT] AC: ${formatACState(updated)}`;
            }
            return '[TOOL_RESULT] Broadlink RM4 Mini не подключён. Необходима настройка ИК-бластера.';
        },

        async ac_status() {
            if (MOCK_SENSORS) {
                const state = getMockACState();
                return `[TOOL_RESULT] Кондиционер: ${formatACState(state)}`;
            }
            return '[TOOL_RESULT] Broadlink RM4 Mini не подключён.';
        },
    }
};

export default skill;
