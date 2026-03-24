import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
export const DB_PATH = path.join(DATA_DIR, 'pipi.db');

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b';
export const HOUSEHOLD_CHAT_ID = process.env.HOUSEHOLD_CHAT_ID || '';

// IKEA Tradfri
export const IKEA_GATEWAY_IP = process.env.IKEA_GATEWAY_IP || '192.168.1.xxx';
export const IKEA_SECURITY_CODE = process.env.IKEA_SECURITY_CODE || '';

// Weather (Open-Meteo)
export const LOCATION_LAT = process.env.LOCATION_LAT || '0.0000';
export const LOCATION_LON = process.env.LOCATION_LON || '0.0000';

// Access Control — who can use the bot
export const OWNER_TG_IDS: Set<string> = new Set(
    (process.env.OWNER_TG_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

export function isOwner(tgId: string): boolean {
    return OWNER_TG_IDS.size === 0 || OWNER_TG_IDS.has(tgId);
}

// Presence Detection
export const OWNER_IPHONE_IP = process.env.OWNER_IP_ADDRESS || '';

// Mock sensors for local testing (no hardware needed)
export const MOCK_SENSORS = process.env.MOCK_SENSORS === 'true';

// MQTT (Zigbee2MQTT)
export const MQTT_URL = process.env.MQTT_URL || '';
export const Z2M_SENSOR_ID = process.env.Z2M_SENSOR_ID || 'living_room_climate';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function isHouseholdChat(chatId: string): boolean {
    return !!HOUSEHOLD_CHAT_ID && chatId.toString() === HOUSEHOLD_CHAT_ID;
}
