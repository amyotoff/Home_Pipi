import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { checkHa, haCallService, haGetStates, HA_ALLOWED, setLastCall } from '../ha';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatState(entity_id: string, attrs: Record<string, any>, state: string): string {
    const name = attrs.friendly_name || entity_id;
    const brightness = attrs.brightness !== undefined
        ? ` (${Math.round(attrs.brightness / 2.55)}%)`
        : '';
    return `${name}: ${state === 'on' ? 'вкл' : 'выкл'}${brightness}`;
}

const LIGHT_IDS = HA_ALLOWED.light?.entity_ids ?? [];

// ─── Skill ────────────────────────────────────────────────────────────────────

const skill: SkillManifest = {
    name: 'lights',
    description: 'Управление освещением через Home Assistant (light.*)',
    version: '2.0.0',
    tools: [
        {
            name: 'lights_on',
            description: 'Turn on a specific light or all lights. Optionally set brightness.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    light_name: { type: Type.STRING, description: 'Friendly name fragment, entity_id, or "all".' },
                    brightness: { type: Type.INTEGER, description: 'Brightness 1-100 (optional, default 100).' },
                },
                required: ['light_name'],
            },
        },
        {
            name: 'lights_off',
            description: 'Turn off a specific light or all lights.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    light_name: { type: Type.STRING, description: 'Friendly name fragment, entity_id, or "all".' },
                },
                required: ['light_name'],
            },
        },
        {
            name: 'lights_status',
            description: 'Get on/off status and brightness of all allowed lights.',
            parameters: { type: Type.OBJECT, properties: {} },
        },
        {
            name: 'lights_party_mode',
            description: 'Activate party mode — rapidly toggle lights for fun.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    duration_seconds: { type: Type.INTEGER, description: 'Duration in seconds (default 10, max 30).' },
                },
            },
        },
    ],
    handlers: {
        async lights_on(args: { light_name: string; brightness?: number }) {
            if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';

            const pct = Math.max(1, Math.min(100, args.brightness ?? 100));
            const isAll = ['all', 'все', 'всё'].includes(args.light_name.toLowerCase());

            const targets = isAll ? LIGHT_IDS : resolveLight(args.light_name);
            if (!targets.length) return `[TOOL_RESULT] Лампа "${args.light_name}" не найдена. Доступные: ${LIGHT_IDS.join(', ')}`;

            const results: string[] = [];
            for (const entity_id of targets) {
                try {
                    await haCallService('light', 'turn_on', { entity_id, brightness_pct: pct });
                    results.push(`✓ ${entity_id}`);
                } catch (err: any) {
                    results.push(`✗ ${entity_id}: ${err.message}`);
                }
            }
            return `[TOOL_RESULT] ${results.join(', ')}`;
        },

        async lights_off(args: { light_name: string }) {
            if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';

            const isAll = ['all', 'все', 'всё'].includes(args.light_name.toLowerCase());
            const targets = isAll ? LIGHT_IDS : resolveLight(args.light_name);
            if (!targets.length) return `[TOOL_RESULT] Лампа "${args.light_name}" не найдена. Доступные: ${LIGHT_IDS.join(', ')}`;

            const results: string[] = [];
            for (const entity_id of targets) {
                try {
                    await haCallService('light', 'turn_off', { entity_id });
                    results.push(`✓ ${entity_id}`);
                } catch (err: any) {
                    results.push(`✗ ${entity_id}: ${err.message}`);
                }
            }
            return `[TOOL_RESULT] ${results.join(', ')}`;
        },

        async lights_status() {
            if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
            try {
                const entities = await haGetStates('light');
                if (!entities.length) return '[TOOL_RESULT] Нет разрешённых ламп.';
                const lines = entities.map(e => formatState(e.entity_id, e.attributes, e.state));
                return `[TOOL_RESULT] Лампы (${entities.length}):\n${lines.join('\n')}`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },

        async lights_party_mode(args: { duration_seconds?: number }) {
            if (!await checkHa()) return '[TOOL_RESULT] Home Assistant недоступен.';
            if (!LIGHT_IDS.length) return '[TOOL_RESULT] Нет ламп для Party Mode.';

            const duration = Math.max(3, Math.min(30, args.duration_seconds ?? 10));
            const end = Date.now() + duration * 1000;
            let cycles = 0;

            while (Date.now() < end) {
                for (const entity_id of LIGHT_IDS) {
                    const pct = Math.floor(Math.random() * 100) + 1;
                    try {
                        // Bypass rate limiter: rapid toggling is intentional here
                        setLastCall(entity_id, 0);
                        await haCallService('light', 'turn_on', { entity_id, brightness_pct: pct });
                    } catch { /* ignore individual failures during party */ }
                }
                cycles++;
                await new Promise(r => setTimeout(r, 500));
            }

            // Restore to full brightness
            for (const entity_id of LIGHT_IDS) {
                try {
                    setLastCall(entity_id, 0);
                    await haCallService('light', 'turn_on', { entity_id, brightness_pct: 100 });
                } catch { }
            }

            return `[TOOL_RESULT] Party Mode завершён. ${cycles} циклов за ${duration}с. Лампы на 100%.`;
        },
    },
};

/** Resolve a fuzzy name to a list of entity_ids (subset of LIGHT_IDS). */
function resolveLight(name: string): string[] {
    const lower = name.toLowerCase();
    // Exact entity_id match
    if (LIGHT_IDS.includes(name)) return [name];
    // Partial entity_id match
    const partial = LIGHT_IDS.filter(id => id.toLowerCase().includes(lower));
    return partial;
}

export default skill;
