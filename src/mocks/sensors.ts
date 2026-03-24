/**
 * Mock sensor data generators for local testing without hardware.
 * Produces realistic time-varying values for: temperature, humidity, CO₂,
 * presence zones (Everything Presence Lite), and AC state (Broadlink RM4 Mini).
 */

// ==========================================
// Temperature — daily sinusoidal cycle
// ==========================================

export function mockTemperature(): number {
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    // Min ~19°C at 05:00, max ~26°C at 15:00
    const base = 22.5 + 3.5 * Math.sin(((hour - 5) / 24) * 2 * Math.PI - Math.PI / 2);
    const noise = (Math.random() - 0.5) * 1.0;
    return Math.round((base + noise) * 10) / 10;
}

// ==========================================
// Humidity — inverse correlation with temp
// ==========================================

export function mockHumidity(): number {
    const hour = new Date().getHours() + new Date().getMinutes() / 60;
    // Higher at night (60%), lower during day (38%)
    const base = 49 - 11 * Math.sin(((hour - 5) / 24) * 2 * Math.PI - Math.PI / 2);
    const noise = (Math.random() - 0.5) * 6;
    return Math.round(Math.max(30, Math.min(70, base + noise)));
}

// ==========================================
// CO₂ — rises with occupancy, drifts
// ==========================================

let co2Drift = 0;

export function mockCO2(peopleHome: number = 1): number {
    const hour = new Date().getHours();
    const base = 420;

    // Occupancy effect: +80ppm per person
    const occupancy = peopleHome * 80;

    // Time-of-day pattern: higher in evening (windows closed), lower midday
    const timeEffect = hour >= 22 || hour < 6
        ? 120  // night — closed windows
        : hour >= 10 && hour < 16
            ? -40  // midday — ventilation
            : 40;  // morning/evening

    // Random drift (slow walk)
    co2Drift += (Math.random() - 0.5) * 20;
    co2Drift = Math.max(-80, Math.min(80, co2Drift));

    const value = base + occupancy + timeEffect + co2Drift + (Math.random() - 0.5) * 30;
    return Math.round(Math.max(400, Math.min(2000, value)));
}

export function co2Level(ppm: number): string {
    if (ppm < 600) return 'отлично';
    if (ppm < 800) return 'норма';
    if (ppm < 1000) return 'душновато';
    if (ppm < 1500) return 'нужно проветрить';
    return 'опасно высокий';
}

// ==========================================
// Everything Presence Lite — studio zones
// ==========================================

export interface ZonePresence {
    zone: string;
    targets: number;
}

export function mockPresenceZones(): ZonePresence[] {
    const hour = new Date().getHours();

    // Desk: likely 9-18 on weekdays
    const deskProb = (hour >= 9 && hour <= 18) ? 0.7 : 0.1;

    // Kitchen: meal times (8-9, 12-14, 19-21)
    const kitchenProb = (hour >= 8 && hour <= 9) ? 0.6
        : (hour >= 12 && hour <= 14) ? 0.5
        : (hour >= 19 && hour <= 21) ? 0.7
        : 0.05;

    // Bed: night (23-08)
    const bedProb = (hour >= 23 || hour < 8) ? 0.85 : 0.05;

    return [
        { zone: 'desk', targets: Math.random() < deskProb ? 1 : 0 },
        { zone: 'kitchen', targets: Math.random() < kitchenProb ? 1 : 0 },
        { zone: 'bed', targets: Math.random() < bedProb ? 1 : 0 },
    ];
}

// ==========================================
// Broadlink RM4 Mini — AC state machine
// ==========================================

export interface MockACState {
    power: boolean;
    mode: 'cool' | 'heat' | 'fan' | 'auto';
    target_temp: number;
    fan_speed: 'low' | 'medium' | 'high' | 'auto';
}

let acState: MockACState = {
    power: false,
    mode: 'cool',
    target_temp: 24,
    fan_speed: 'auto',
};

export function getMockACState(): MockACState {
    return { ...acState };
}

export function setMockACState(updates: Partial<MockACState>): MockACState {
    if (updates.target_temp !== undefined) {
        updates.target_temp = Math.max(16, Math.min(30, updates.target_temp));
    }
    acState = { ...acState, ...updates };
    return { ...acState };
}

export function formatACState(state: MockACState): string {
    if (!state.power) return 'Выключен';
    const modeNames: Record<string, string> = {
        cool: 'охлаждение', heat: 'обогрев', fan: 'вентилятор', auto: 'авто',
    };
    const fanNames: Record<string, string> = {
        low: 'тихий', medium: 'средний', high: 'макс', auto: 'авто',
    };
    return `${modeNames[state.mode] || state.mode}, ${state.target_temp}°C, вентилятор: ${fanNames[state.fan_speed] || state.fan_speed}`;
}
