/**
 * ha.ts — Home Assistant REST API client
 *
 * Single source of truth for:
 *   1. What devices the bot is allowed to touch (HA_ALLOWED)
 *   2. HTTP wrapper functions (haGet / haPost / haCallService)
 *   3. Rate limiting (3 s per entity_id)
 *
 * Rule: new entity_ids are added by hand only — the bot never modifies this file.
 */

import { HA_URL, HA_TOKEN } from './config';

// ─── Allowlist ────────────────────────────────────────────────────────────────

export interface HaAllowEntry {
    entity_ids: string[];
    services: string[];
}

export const HA_ALLOWED: Record<string, HaAllowEntry> = {
    light: {
        entity_ids: ['light.desk_lamp', 'light.ceiling', 'light.strip'],
        services: ['turn_on', 'turn_off', 'toggle'],
    },
    switch: {
        entity_ids: ['switch.kettle', 'switch.fan'],
        services: ['turn_on', 'turn_off', 'toggle'],
    },
    climate: {
        entity_ids: ['climate.ac_main'],
        services: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode', 'set_fan_mode'],
    },
    media_player: {
        entity_ids: ['media_player.tv'],
        services: ['media_play', 'media_pause', 'volume_set', 'volume_up', 'volume_down'],
    },
    // lock, alarm_control_panel — NEVER add here
};

/** All entity_ids the bot may touch, across all domains. */
export function getAllowedEntityIds(): string[] {
    return Object.values(HA_ALLOWED).flatMap(e => e.entity_ids);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HaEntity {
    entity_id: string;
    state: string;
    attributes: Record<string, any>;
    last_changed: string;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT_MS = 3000;
const lastCall = new Map<string, number>();

function checkRateLimit(entity_id: string): void {
    const last = lastCall.get(entity_id) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
        throw new Error(`[HA ERROR] rate limit для '${entity_id}': подожди ${wait}с`);
    }
    lastCall.set(entity_id, Date.now());
}

/** Bypass rate limit for internal party-mode loops (conscious, rapid toggling). */
export function setLastCall(entity_id: string, ts: number): void {
    lastCall.set(entity_id, ts);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function headers(): HeadersInit {
    return {
        Authorization: `Bearer ${HA_TOKEN}`,
        'Content-Type': 'application/json',
    };
}

export async function haGet(path: string): Promise<any> {
    const res = await fetch(`${HA_URL}${path}`, { headers: headers() });
    if (!res.ok) throw new Error(`[HA ERROR] GET ${path} → ${res.status}`);
    return res.json();
}

export async function haPost(path: string, body: object = {}): Promise<any> {
    const res = await fetch(`${HA_URL}${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`[HA ERROR] POST ${path} → ${res.status}`);
    return res.json();
}

// ─── Service call with safety checks ─────────────────────────────────────────

export async function haCallService(
    domain: string,
    service: string,
    data: { entity_id: string; [key: string]: any }
): Promise<void> {
    const entry = HA_ALLOWED[domain];
    if (!entry) throw new Error(`[HA ERROR] домен '${domain}' не разрешён`);
    if (!entry.entity_ids.includes(data.entity_id))
        throw new Error(`[HA ERROR] entity '${data.entity_id}' не разрешён`);
    if (!entry.services.includes(service))
        throw new Error(`[HA ERROR] сервис '${service}' запрещён для домена '${domain}'`);

    checkRateLimit(data.entity_id);

    console.log(`[HA AUDIT] ${domain}.${service}`, data);
    await haPost(`/api/services/${domain}/${service}`, data);
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

/** Get state of one entity (must be in allowlist). */
export async function haGetState(entity_id: string): Promise<HaEntity> {
    if (!getAllowedEntityIds().includes(entity_id))
        throw new Error(`[HA ERROR] entity '${entity_id}' не разрешён`);
    return haGet(`/api/states/${entity_id}`);
}

/** Get all states for a domain, filtered to allowlist. */
export async function haGetStates(domain: string): Promise<HaEntity[]> {
    const entry = HA_ALLOWED[domain];
    if (!entry) return [];
    const all: HaEntity[] = await haGet('/api/states');
    return all.filter(e => entry.entity_ids.includes(e.entity_id));
}

/** Check HA reachability. Returns false (+ warns) if unreachable. */
export async function checkHa(): Promise<boolean> {
    if (!HA_URL || !HA_TOKEN) {
        console.warn('[HA] HA_URL or HA_TOKEN not set — HA features disabled');
        return false;
    }
    try {
        await haGet('/api/');
        return true;
    } catch {
        console.warn('[HA] Home Assistant unreachable at', HA_URL);
        return false;
    }
}
