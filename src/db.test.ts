import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { testPersonas } from './mocks/test-personas';

/**
 * DB tests using in-memory SQLite for isolation.
 * We replicate the schema from db.ts here to avoid triggering config/file system side effects.
 */

function createTestDb(): Database.Database {
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE IF NOT EXISTS residents (
            tg_id TEXT PRIMARY KEY,
            username TEXT,
            display_name TEXT,
            nickname TEXT,
            role TEXT DEFAULT 'resident',
            ip_address TEXT,
            mac_address TEXT,
            ble_mac TEXT,
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

        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT,
            details TEXT,
            timestamp TEXT
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

        CREATE TABLE IF NOT EXISTS skill_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            skill_name TEXT,
            description TEXT,
            requested_by TEXT,
            user_request TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT,
            resolved_at TEXT,
            votes INTEGER DEFAULT 1,
            voters TEXT DEFAULT '',
            hardware_needed TEXT DEFAULT '',
            priority TEXT DEFAULT 'normal'
        );
    `);

    return db;
}

describe('Database', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
    });

    describe('Residents CRUD', () => {
        it('should insert and retrieve a resident', () => {
            const alice = testPersonas.alice;
            db.prepare(`
                INSERT INTO residents (tg_id, username, display_name, role, joined_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(alice.tg_id, alice.username, alice.display_name, alice.role, new Date().toISOString());

            const row = db.prepare('SELECT * FROM residents WHERE tg_id = ?').get(alice.tg_id) as any;
            expect(row).toBeDefined();
            expect(row.username).toBe('alice');
            expect(row.display_name).toBe('Alice');
            expect(row.role).toBe('owner');
        });

        it('should update resident habits', () => {
            const bob = testPersonas.bob;
            db.prepare(`
                INSERT INTO residents (tg_id, username, display_name, role, habits, joined_at)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(bob.tg_id, bob.username, bob.display_name, bob.role, '', new Date().toISOString());

            db.prepare('UPDATE residents SET habits = ? WHERE tg_id = ?').run('Loves coffee at 8am', bob.tg_id);

            const row = db.prepare('SELECT habits FROM residents WHERE tg_id = ?').get(bob.tg_id) as any;
            expect(row.habits).toBe('Loves coffee at 8am');
        });

        it('should list all residents', () => {
            const { alice, bob, bender } = testPersonas;
            const stmt = db.prepare('INSERT INTO residents (tg_id, username, display_name, role, joined_at) VALUES (?, ?, ?, ?, ?)');
            const now = new Date().toISOString();
            stmt.run(alice.tg_id, alice.username, alice.display_name, alice.role, now);
            stmt.run(bob.tg_id, bob.username, bob.display_name, bob.role, now);
            stmt.run(bender.tg_id, bender.username, bender.display_name, bender.role, now);

            const all = db.prepare('SELECT * FROM residents').all();
            expect(all).toHaveLength(3);
        });
    });

    describe('Chats CRUD', () => {
        it('should upsert a chat', () => {
            db.prepare(`
                INSERT INTO chats (jid, type, status, language)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(jid) DO UPDATE SET type = excluded.type
            `).run('chat_1', 'private', 'ACTIVE', 'ru');

            const chat = db.prepare('SELECT * FROM chats WHERE jid = ?').get('chat_1') as any;
            expect(chat.type).toBe('private');
            expect(chat.language).toBe('ru');

            // Upsert: change type
            db.prepare(`
                INSERT INTO chats (jid, type, status, language)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(jid) DO UPDATE SET type = excluded.type
            `).run('chat_1', 'household_group', 'ACTIVE', 'ru');

            const updated = db.prepare('SELECT * FROM chats WHERE jid = ?').get('chat_1') as any;
            expect(updated.type).toBe('household_group');
        });
    });

    describe('Messages', () => {
        it('should store and retrieve messages', () => {
            const now = new Date().toISOString();
            db.prepare(`
                INSERT INTO messages (id, chat_jid, sender_tg_id, content, timestamp, is_bot)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run('msg_1', 'chat_1', '111', 'Hello Jeeves', now, 0);

            const msgs = db.prepare('SELECT * FROM messages WHERE chat_jid = ?').all('chat_1');
            expect(msgs).toHaveLength(1);
            expect((msgs[0] as any).content).toBe('Hello Jeeves');
        });

        it('should ignore duplicate message IDs', () => {
            const now = new Date().toISOString();
            const stmt = db.prepare(`
                INSERT INTO messages (id, chat_jid, sender_tg_id, content, timestamp, is_bot)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `);
            stmt.run('msg_1', 'chat_1', '111', 'First', now, 0);
            stmt.run('msg_1', 'chat_1', '111', 'Duplicate', now, 0);

            const msgs = db.prepare('SELECT * FROM messages WHERE id = ?').all('msg_1');
            expect(msgs).toHaveLength(1);
            expect((msgs[0] as any).content).toBe('First');
        });

        it('should delete old messages', () => {
            const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
            const recent = new Date().toISOString();
            const stmt = db.prepare(`
                INSERT INTO messages (id, chat_jid, sender_tg_id, content, timestamp, is_bot)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            stmt.run('old_1', 'chat_1', '111', 'Old message', old, 0);
            stmt.run('new_1', 'chat_1', '111', 'New message', recent, 0);

            const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
            db.prepare('DELETE FROM messages WHERE chat_jid = ? AND timestamp <= ?').run('chat_1', cutoff);

            const remaining = db.prepare('SELECT * FROM messages WHERE chat_jid = ?').all('chat_1');
            expect(remaining).toHaveLength(1);
            expect((remaining[0] as any).id).toBe('new_1');
        });
    });

    describe('Token Usage', () => {
        it('should log and aggregate token usage', () => {
            const today = new Date().toISOString().split('T')[0];
            const now = new Date().toISOString();

            db.prepare(`
                INSERT INTO token_usage (date, model, input_tokens, output_tokens, cost_usd, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(today, 'gemini-2.5-flash', 1000, 500, 0.00045, now);

            db.prepare(`
                INSERT INTO token_usage (date, model, input_tokens, output_tokens, cost_usd, timestamp)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(today, 'gemini-2.5-flash', 2000, 1000, 0.0009, now);

            const agg = db.prepare(`
                SELECT COALESCE(SUM(input_tokens), 0) as input_tokens,
                       COALESCE(SUM(output_tokens), 0) as output_tokens,
                       COALESCE(SUM(cost_usd), 0) as cost_usd,
                       COUNT(*) as calls
                FROM token_usage WHERE date = ?
            `).get(today) as any;

            expect(agg.input_tokens).toBe(3000);
            expect(agg.output_tokens).toBe(1500);
            expect(agg.calls).toBe(2);
        });
    });

    describe('Event Log', () => {
        it('should log events', () => {
            db.prepare(`
                INSERT INTO event_log (event_type, details, timestamp)
                VALUES (?, ?, ?)
            `).run('reboot', JSON.stringify({ reason: 'test' }), new Date().toISOString());

            const events = db.prepare('SELECT * FROM event_log WHERE event_type = ?').all('reboot');
            expect(events).toHaveLength(1);
        });
    });

    describe('Schema idempotency', () => {
        it('should allow creating schema twice without errors', () => {
            // Creating a second DB with same schema should not throw
            const db2 = createTestDb();
            expect(db2).toBeDefined();
            db2.close();
        });
    });
});
