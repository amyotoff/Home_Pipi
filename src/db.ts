import Database from 'better-sqlite3';
import { DB_PATH } from './config';

let db: Database.Database;

function createSchema(database: Database.Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS residents (
            tg_id TEXT PRIMARY KEY,
            username TEXT,
            display_name TEXT,
            nickname TEXT,
            role TEXT DEFAULT 'resident',
            ip_address TEXT,
            mac_address TEXT,
            is_home INTEGER DEFAULT 0,
            last_seen TEXT,
            joined_at TEXT,
            habits TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS chats (
            jid TEXT PRIMARY KEY,
            type TEXT,
            status TEXT DEFAULT 'ACTIVE',
            language TEXT DEFAULT 'ru'
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            chat_jid TEXT,
            sender_tg_id TEXT,
            content TEXT,
            timestamp TEXT,
            is_bot INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp ON messages(chat_jid, timestamp);

        CREATE TABLE IF NOT EXISTS shopping_list (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item TEXT NOT NULL,
            quantity TEXT DEFAULT '1',
            added_by TEXT,
            added_at TEXT,
            purchased INTEGER DEFAULT 0,
            purchased_at TEXT
        );

        CREATE TABLE IF NOT EXISTS cleaning_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_name TEXT NOT NULL,
            description TEXT,
            assigned_to TEXT,
            frequency TEXT DEFAULT 'weekly',
            last_completed TEXT,
            next_due TEXT,
            status TEXT DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS cleaning_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            completed_by TEXT,
            completed_at TEXT,
            notes TEXT,
            photo_verified INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS known_devices (
            mac_address TEXT PRIMARY KEY,
            ip_address TEXT,
            hostname TEXT,
            device_name TEXT,
            device_type TEXT DEFAULT 'unknown',
            confidence TEXT DEFAULT 'low',
            first_seen TEXT,
            last_seen TEXT,
            is_trusted INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            details TEXT,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS sensor_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sensor_id TEXT,
            type TEXT,
            value REAL,
            timestamp TEXT
        );

        CREATE TABLE IF NOT EXISTS weather_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location TEXT,
            data TEXT,
            fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS skill_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_name TEXT,
            description TEXT,
            requested_by TEXT,
            user_request TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT,
            resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            timestamp TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);

        CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_jid TEXT NOT NULL,
            sender_tg_id TEXT,
            content TEXT NOT NULL,
            remind_at TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reminders_status_time ON reminders(status, remind_at);
    `);
}

function runMigrations(database: Database.Database): void {
    // Add nickname and habits columns for existing DBs
    try { database.exec('ALTER TABLE residents ADD COLUMN nickname TEXT'); } catch { }
    try { database.exec('ALTER TABLE residents ADD COLUMN habits TEXT DEFAULT ""'); } catch { }
    try { database.exec('ALTER TABLE residents ADD COLUMN ble_mac TEXT'); } catch { }
    // Add device classification columns to known_devices
    try { database.exec("ALTER TABLE known_devices ADD COLUMN device_type TEXT DEFAULT 'unknown'"); } catch { }
    try { database.exec("ALTER TABLE known_devices ADD COLUMN confidence TEXT DEFAULT 'low'"); } catch { }
    // Migrate role='resident' → 'owner' (old default → new role system)
    try { database.exec("UPDATE residents SET role = 'owner' WHERE role = 'resident'"); } catch { }
    // BLE devices table
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS ble_devices (
            mac TEXT PRIMARY KEY,
            name TEXT,
            rssi INTEGER,
            first_seen TEXT,
            last_seen TEXT,
            device_type TEXT DEFAULT 'unknown',
            is_resident INTEGER DEFAULT 0
        )`);
    } catch { }

    // Atelier: skill_requests enhancements
    try { database.exec("ALTER TABLE skill_requests ADD COLUMN votes INTEGER DEFAULT 1"); } catch { }
    try { database.exec("ALTER TABLE skill_requests ADD COLUMN voters TEXT DEFAULT ''"); } catch { }
    try { database.exec("ALTER TABLE skill_requests ADD COLUMN hardware_needed TEXT DEFAULT ''"); } catch { }
    try { database.exec("ALTER TABLE skill_requests ADD COLUMN priority TEXT DEFAULT 'normal'"); } catch { }

    // Atelier: status change history
    try {
        database.exec(`CREATE TABLE IF NOT EXISTS skill_request_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER,
            old_status TEXT,
            new_status TEXT,
            changed_by TEXT,
            note TEXT,
            changed_at TEXT
        )`);
    } catch { }
}

export function initDatabase(): void {
    if (!db) {
        db = new Database(DB_PATH);
        createSchema(db);
        runMigrations(db);
    }
}

export function getDb(): Database.Database {
    if (!db) initDatabase();
    return db;
}

// ==========================================
// Residents
// ==========================================

export interface Resident {
    tg_id: string;
    username: string | null;
    display_name: string | null;
    nickname: string | null;
    role: string;
    ip_address: string | null;
    mac_address: string | null;
    ble_mac: string | null;
    is_home: number;
    last_seen: string | null;
    joined_at: string;
    habits: string;
}

export function getResident(tg_id: string): Resident | undefined {
    return getDb().prepare('SELECT * FROM residents WHERE tg_id = ?').get(tg_id) as Resident | undefined;
}

export function upsertResident(r: Partial<Resident> & { tg_id: string }): void {
    const existing = getResident(r.tg_id);
    if (existing) {
        const toUpdate = { ...existing, ...r };
        getDb().prepare(`
            UPDATE residents SET username = @username, display_name = @display_name, nickname = @nickname, role = @role,
            ip_address = @ip_address, mac_address = @mac_address, ble_mac = @ble_mac, is_home = @is_home, last_seen = @last_seen, habits = @habits
            WHERE tg_id = @tg_id
        `).run(toUpdate);
    } else {
        getDb().prepare(`
            INSERT INTO residents (tg_id, username, display_name, nickname, role, ip_address, mac_address, ble_mac, is_home, last_seen, joined_at, habits)
            VALUES (@tg_id, @username, @display_name, @nickname, @role, @ip_address, @mac_address, @ble_mac, @is_home, @last_seen, @joined_at, @habits)
        `).run({
            tg_id: r.tg_id,
            username: r.username || null,
            display_name: r.display_name || null,
            nickname: r.nickname || null,
            role: r.role || 'owner',
            ip_address: r.ip_address || null,
            mac_address: r.mac_address || null,
            ble_mac: r.ble_mac || null,
            is_home: r.is_home || 0,
            last_seen: r.last_seen || null,
            joined_at: r.joined_at || new Date().toISOString(),
            habits: r.habits || ''
        });
    }
}

export function updateResidentHabits(tg_id: string, habits: string): void {
    getDb().prepare('UPDATE residents SET habits = ? WHERE tg_id = ?').run(habits, tg_id);
}

export function updateResidentNickname(tg_id: string, nickname: string): void {
    getDb().prepare('UPDATE residents SET nickname = ? WHERE tg_id = ?').run(nickname, tg_id);
}

export function getAllResidents(): Resident[] {
    return getDb().prepare('SELECT * FROM residents').all() as Resident[];
}

// ==========================================
// Chats
// ==========================================

export interface Chat {
    jid: string;
    type: string;
    status: string;
    language: string;
}

export function getChat(jid: string): Chat | undefined {
    return getDb().prepare('SELECT * FROM chats WHERE jid = ?').get(jid) as Chat | undefined;
}

export function upsertChat(chat: Partial<Chat> & { jid: string }): void {
    getDb().prepare(`
        INSERT INTO chats (jid, type, status, language)
        VALUES (@jid, @type, @status, @language)
        ON CONFLICT(jid) DO UPDATE SET type = @type, status = @status, language = @language
    `).run({
        jid: chat.jid,
        type: chat.type || 'private',
        status: chat.status || 'ACTIVE',
        language: chat.language || 'ru'
    });
}

// ==========================================
// Messages
// ==========================================

export interface Message {
    id: string;
    chat_jid: string;
    sender_tg_id: string | null;
    content: string;
    timestamp: string;
    is_bot: number;
}

export function storeMessage(msg: Message): void {
    getDb().prepare(`
        INSERT INTO messages (id, chat_jid, sender_tg_id, content, timestamp, is_bot)
        VALUES (@id, @chat_jid, @sender_tg_id, @content, @timestamp, @is_bot)
        ON CONFLICT(id) DO NOTHING
    `).run(msg);
}

export function getRecentMessages(chat_jid: string, limit: number = 30): Message[] {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return getDb().prepare(`
        SELECT * FROM messages WHERE chat_jid = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT ?
    `).all(chat_jid, sevenDaysAgo, limit).reverse() as Message[];
}

export function getOldMessages(chat_jid: string, olderThanDays: number = 7): Message[] {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    return getDb().prepare(`
        SELECT * FROM messages WHERE chat_jid = ? AND timestamp <= ? ORDER BY timestamp ASC
    `).all(chat_jid, cutoff) as Message[];
}

export function deleteOldMessages(chat_jid: string, olderThanDays: number = 7): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const result = getDb().prepare(`
        DELETE FROM messages WHERE chat_jid = ? AND timestamp <= ?
    `).run(chat_jid, cutoff);
    return result.changes;
}

export function clearMessages(chat_jid: string): void {
    getDb().prepare('DELETE FROM messages WHERE chat_jid = ?').run(chat_jid);
}

// ==========================================
// Event Log
// ==========================================

export function logEvent(event_type: string, details: Record<string, any>): void {
    getDb().prepare(`
        INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)
    `).run(event_type, JSON.stringify(details), new Date().toISOString());
}

// ==========================================
// Token Usage
// ==========================================

// Gemini 2.5 Flash pricing (per 1M tokens)
const PRICING: Record<string, { input: number; output: number }> = {
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
};

export function logTokenUsage(model: string, inputTokens: number, outputTokens: number): void {
    const today = new Date().toISOString().split('T')[0];
    const isLocal = model.startsWith('ollama:');
    const pricing = isLocal ? { input: 0, output: 0 } : (PRICING[model] || PRICING['gemini-2.5-flash']);
    const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    getDb().prepare(`
        INSERT INTO token_usage (date, model, input_tokens, output_tokens, cost_usd, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(today, model, inputTokens, outputTokens, cost, new Date().toISOString());
}

export function getDailyTokenCost(date?: string): { input_tokens: number; output_tokens: number; cost_usd: number; calls: number } {
    const day = date || new Date().toISOString().split('T')[0];
    const row = getDb().prepare(`
        SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
               COALESCE(SUM(output_tokens), 0) as output_tokens,
               COALESCE(SUM(cost_usd), 0) as cost_usd,
               COUNT(*) as calls
        FROM token_usage WHERE date = ?
    `).get(day) as any;
    return row;
}
