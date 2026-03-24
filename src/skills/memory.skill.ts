import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb, logEvent, getResident, updateResidentHabits, updateResidentNickname, getAllResidents } from '../db';

// In-memory cache to avoid re-reading DB on every message
let memoryCache: { context: string; cachedAt: number; key: string } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const skill: SkillManifest = {
    name: 'memory',
    description: 'Долгосрочная память: заметки о жильцах, привычки, дневник дома, компактизация',
    version: '1.0.0',

    migrations: [
        `CREATE TABLE IF NOT EXISTS resident_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            resident_tg_id TEXT,
            resident_name TEXT,
            fact TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source TEXT DEFAULT 'observation',
            created_at TEXT,
            updated_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS house_diary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            entry TEXT NOT NULL,
            type TEXT DEFAULT 'daily',
            token_count INTEGER DEFAULT 0,
            created_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS daily_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            resident_tg_id TEXT,
            insight TEXT NOT NULL,
            created_at TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_diary_date ON house_diary(date)`,
        `CREATE INDEX IF NOT EXISTS idx_notes_resident ON resident_notes(resident_tg_id)`,
        `CREATE INDEX IF NOT EXISTS idx_insights_date ON daily_insights(date)`,
    ],

    tools: [
        {
            name: 'memory_remember',
            description: 'Save a personal fact or preference about a resident. Use when you learn something worth remembering: preferences, habits, dislikes, important dates, allergies, etc. Examples: "sir prefers Earl Grey", "madam is allergic to cats", "guest room is kept at 22C".',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    resident_name: { type: Type.STRING, description: 'Name of the resident or "household" for general facts.' },
                    fact: { type: Type.STRING, description: 'The fact to remember. Be concise but specific.' },
                    category: {
                        type: Type.STRING,
                        description: 'Category of the fact.',
                        enum: ['preference', 'dislike', 'allergy', 'schedule', 'important_date', 'habit', 'general']
                    }
                },
                required: ['resident_name', 'fact', 'category'],
            }
        },
        {
            name: 'memory_forget',
            description: 'Remove an outdated or incorrect fact about a resident.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    fact_fragment: { type: Type.STRING, description: 'Part of the fact text to find and remove.' }
                },
                required: ['fact_fragment'],
            }
        },
        {
            name: 'memory_recall',
            description: 'Recall everything known about a specific resident or topic.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    query: { type: Type.STRING, description: 'Resident name or topic to recall.' }
                },
                required: ['query'],
            }
        },
        {
            name: 'diary_write',
            description: 'Write a diary entry for today. Called automatically by cron, but can also be triggered manually.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    entry: { type: Type.STRING, description: 'The diary entry text.' }
                },
                required: ['entry'],
            }
        },
        {
            name: 'diary_read',
            description: 'Read diary entries for a specific date or recent days.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days_back: { type: Type.INTEGER, description: 'How many days back to read (default 3, max 14).' }
                }
            }
        },
        {
            name: 'resident_set_name',
            description: 'Set how a resident prefers to be called (nickname). Use when someone introduces themselves or asks to be called differently.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tg_id: { type: Type.STRING, description: 'Telegram user ID of the resident.' },
                    nickname: { type: Type.STRING, description: 'How the person wants to be called.' }
                },
                required: ['tg_id', 'nickname'],
            }
        },
        {
            name: 'resident_learn_habit',
            description: 'Learn a habit, preference, like, or dislike about a resident. Call this when you notice or are told something about a person: what they like/dislike, their routines, food preferences, sleep schedule, etc. Keep each entry short (under 60 chars).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tg_id: { type: Type.STRING, description: 'Telegram user ID of the resident.' },
                    habit: { type: Type.STRING, description: 'Short description of the habit/preference. E.g. "любит кофе по утрам", "не ест глютен", "ложится поздно".' }
                },
                required: ['tg_id', 'habit'],
            }
        },
        {
            name: 'resident_profile',
            description: 'View the profile and habits of a resident or all residents.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tg_id: { type: Type.STRING, description: 'Telegram user ID. Omit to see all residents.' }
                }
            }
        },
        {
            name: 'activity_log',
            description: 'Show recent activity: tool calls, reboots, events. Use when asked "what did you do today?", "when was the last reboot?", "show me your activity".',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    type: { type: Type.STRING, description: 'Filter by event type: "tool_call", "reboot", or "all". Default: "all".', enum: ['tool_call', 'reboot', 'all'] },
                    limit: { type: Type.INTEGER, description: 'Max entries to show (default 20, max 50).' }
                }
            }
        },
        {
            name: 'insight_add',
            description: 'Record a real-time insight about today: something notable you noticed about a resident, the household mood, a recurring topic, or anything worth remembering but not formal enough for memory_remember. Call this proactively when you notice patterns. Examples: "Алёша сегодня много говорил о работе", "настроение домохозяйства низкое — два человека жаловались на усталость", "тема еды поднималась уже 3 раза сегодня".',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    insight: { type: Type.STRING, description: 'The insight text. Be concise (under 100 chars).' },
                    resident_tg_id: { type: Type.STRING, description: 'Telegram user ID if insight is about a specific resident. Omit for general household insights.' }
                },
                required: ['insight'],
            }
        },
        {
            name: 'insight_today',
            description: "Show all insights recorded today. Use when asked about today's observations, mood, or patterns.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    resident_tg_id: { type: Type.STRING, description: 'Filter by resident. Omit for all insights.' }
                }
            }
        },
    ],

    handlers: {
        async memory_remember(args: { resident_name: string; fact: string; category: string }) {
            const db = getDb();
            const now = new Date().toISOString();

            // Check for duplicate/update
            const existing = db.prepare(
                "SELECT * FROM resident_notes WHERE resident_name = ? AND fact LIKE ? LIMIT 1"
            ).get(args.resident_name, `%${args.fact.substring(0, 20)}%`) as any;

            if (existing) {
                db.prepare("UPDATE resident_notes SET fact = ?, category = ?, updated_at = ? WHERE id = ?")
                    .run(args.fact, args.category, now, existing.id);
                invalidateCache();
                return `[TOOL_RESULT] Заметка о ${args.resident_name} обновлена: "${args.fact}"`;
            }

            db.prepare(
                "INSERT INTO resident_notes (resident_name, fact, category, source, created_at, updated_at) VALUES (?, ?, ?, 'conversation', ?, ?)"
            ).run(args.resident_name, args.fact, args.category, now, now);

            invalidateCache();
            return `[TOOL_RESULT] Запомнено о ${args.resident_name}: "${args.fact}" [${args.category}]`;
        },

        async memory_forget(args: { fact_fragment: string }) {
            const db = getDb();
            const result = db.prepare("DELETE FROM resident_notes WHERE fact LIKE ?").run(`%${args.fact_fragment}%`);
            invalidateCache();
            return result.changes > 0
                ? `[TOOL_RESULT] Удалено ${result.changes} заметок содержащих "${args.fact_fragment}".`
                : `[TOOL_RESULT] Заметок с "${args.fact_fragment}" не найдено.`;
        },

        async memory_recall(args: { query: string }) {
            const db = getDb();
            const notes = db.prepare(
                "SELECT * FROM resident_notes WHERE resident_name LIKE ? OR fact LIKE ? ORDER BY updated_at DESC"
            ).all(`%${args.query}%`, `%${args.query}%`) as any[];

            if (notes.length === 0) return `[TOOL_RESULT] Ничего не помню о "${args.query}".`;

            return '[TOOL_RESULT] Из памяти:\n' + notes.map((n: any) =>
                `- [${n.category}] ${n.resident_name}: ${n.fact}`
            ).join('\n');
        },

        async diary_write(args: { entry: string }) {
            const db = getDb();
            const today = new Date().toISOString().split('T')[0];
            const tokenEstimate = Math.ceil(args.entry.length / 4); // rough estimate

            db.prepare(
                "INSERT INTO house_diary (date, entry, type, token_count, created_at) VALUES (?, ?, 'daily', ?, ?)"
            ).run(today, args.entry, tokenEstimate, new Date().toISOString());

            invalidateCache();
            return `[TOOL_RESULT] Запись в дневник за ${today} сохранена (${tokenEstimate} токенов).`;
        },

        async diary_read(args: { days_back?: number }) {
            const db = getDb();
            const days = Math.min(args.days_back || 3, 14);
            const since = new Date();
            since.setDate(since.getDate() - days);
            const sinceStr = since.toISOString().split('T')[0];

            const entries = db.prepare(
                "SELECT * FROM house_diary WHERE date >= ? ORDER BY date DESC, created_at DESC"
            ).all(sinceStr) as any[];

            if (entries.length === 0) return '[TOOL_RESULT] Дневник за этот период пуст.';

            return '[TOOL_RESULT] Дневник:\n' + entries.map((e: any) =>
                `[${e.date}] ${e.entry}`
            ).join('\n\n');
        },

        async resident_set_name(args: { tg_id: string; nickname: string }) {
            const resident = getResident(args.tg_id);
            if (!resident) return `[TOOL_RESULT] Жилец ${args.tg_id} не найден.`;

            updateResidentNickname(args.tg_id, args.nickname);
            invalidateCache();
            return `[TOOL_RESULT] Ок, буду звать "${args.nickname}".`;
        },

        async resident_learn_habit(args: { tg_id: string; habit: string }) {
            const resident = getResident(args.tg_id);
            if (!resident) return `[TOOL_RESULT] Жилец ${args.tg_id} не найден.`;

            const habit = args.habit.trim().substring(0, 80);
            const current = resident.habits || '';
            const habits = current ? `${current}; ${habit}` : habit;

            // Auto-compact if over 500 chars
            const compacted = habits.length > 500 ? compactHabits(habits) : habits;
            updateResidentHabits(args.tg_id, compacted);
            invalidateCache();

            const name = resident.nickname || resident.display_name || args.tg_id;
            return `[TOOL_RESULT] Запомнил о ${name}: "${habit}".`;
        },

        async resident_profile(args: { tg_id?: string }) {
            if (args.tg_id) {
                const r = getResident(args.tg_id);
                if (!r) return `[TOOL_RESULT] Жилец ${args.tg_id} не найден.`;
                return `[TOOL_RESULT] ${formatResidentProfile(r)}`;
            }

            const all = getAllResidents();
            if (all.length === 0) return '[TOOL_RESULT] Пока нет зарегистрированных жильцов.';
            return '[TOOL_RESULT] Жильцы:\n' + all.map(formatResidentProfile).join('\n\n');
        },

        async activity_log(args: { type?: string; limit?: number }) {
            const db = getDb();
            const limit = Math.min(Math.max(args.limit || 20, 1), 50);
            const filterType = args.type || 'all';

            let query = 'SELECT * FROM event_log';
            const params: any[] = [];

            if (filterType !== 'all') {
                query += ' WHERE event_type = ?';
                params.push(filterType);
            }
            query += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);

            const events = db.prepare(query).all(...params) as any[];
            if (events.length === 0) return '[TOOL_RESULT] Лог активности пуст.';

            const lines = events.map((e: any) => {
                const details = JSON.parse(e.details || '{}');
                const time = e.timestamp.substring(11, 19);
                const date = e.timestamp.substring(0, 10);

                if (e.event_type === 'reboot') {
                    return `[${date} ${time}] REBOOT`;
                }
                if (e.event_type === 'tool_call') {
                    const status = details.ok ? 'OK' : `ERR: ${details.error}`;
                    const duration = details.duration_ms ? ` (${details.duration_ms}ms)` : '';
                    return `[${date} ${time}] ${details.tool}${duration} — ${status}`;
                }
                return `[${date} ${time}] ${e.event_type}: ${JSON.stringify(details).substring(0, 100)}`;
            });

            return `[TOOL_RESULT] Лог активности (${events.length} записей):\n${lines.join('\n')}`;
        },

        async insight_add(args: { insight: string; resident_tg_id?: string }) {
            const db = getDb();
            const today = new Date().toISOString().split('T')[0];
            const insight = args.insight.trim().substring(0, 150);

            // Avoid near-duplicate insights (same day, same text start)
            const existing = db.prepare(
                'SELECT id FROM daily_insights WHERE date = ? AND insight LIKE ? LIMIT 1'
            ).get(today, `${insight.substring(0, 30)}%`) as any;

            if (existing) {
                db.prepare('UPDATE daily_insights SET insight = ? WHERE id = ?').run(insight, existing.id);
                invalidateCache();
                return `[TOOL_RESULT] Инсайт обновлён.`;
            }

            db.prepare(
                'INSERT INTO daily_insights (date, resident_tg_id, insight, created_at) VALUES (?, ?, ?, ?)'
            ).run(today, args.resident_tg_id || null, insight, new Date().toISOString());

            invalidateCache();
            return `[TOOL_RESULT] Инсайт дня записан: "${insight}"`;
        },

        async insight_today(args: { resident_tg_id?: string }) {
            const db = getDb();
            const today = new Date().toISOString().split('T')[0];

            let insights: any[];
            if (args.resident_tg_id) {
                insights = db.prepare(
                    'SELECT * FROM daily_insights WHERE date = ? AND (resident_tg_id = ? OR resident_tg_id IS NULL) ORDER BY created_at'
                ).all(today, args.resident_tg_id) as any[];
            } else {
                insights = db.prepare(
                    'SELECT * FROM daily_insights WHERE date = ? ORDER BY created_at'
                ).all(today) as any[];
            }

            if (insights.length === 0) return '[TOOL_RESULT] Инсайтов за сегодня пока нет.';

            const lines = insights.map((i: any) => {
                const time = i.created_at.substring(11, 16);
                const who = i.resident_tg_id ? ` [${i.resident_tg_id}]` : '';
                return `[${time}]${who} ${i.insight}`;
            });
            return `[TOOL_RESULT] Инсайты дня (${insights.length}):\n${lines.join('\n')}`;
        },
    },

    crons: [
        {
            expression: '0 23 * * *', // 23:00 — write daily diary
            description: 'Ежедневная запись в дневник дома',
            handler: async () => {
                const { processWithOllama } = require('../core/ollama');
                const db = getDb();
                const today = new Date().toISOString().split('T')[0];

                // Check if already written today
                const existing = db.prepare(
                    "SELECT * FROM house_diary WHERE date = ? AND type = 'daily'"
                ).get(today);
                if (existing) return;

                // Gather events from today
                const events = db.prepare(
                    "SELECT * FROM event_log WHERE timestamp >= ? ORDER BY timestamp"
                ).all(today + 'T00:00:00') as any[];

                if (events.length === 0) {
                    db.prepare(
                        "INSERT INTO house_diary (date, entry, type, token_count, created_at) VALUES (?, ?, 'daily', 20, ?)"
                    ).run(today, 'Спокойный день без примечательных событий.', new Date().toISOString());
                    return;
                }

                // Summarize events via Ollama
                const eventSummary = events.map((e: any) => {
                    const details = JSON.parse(e.details || '{}');
                    return `${e.event_type}: ${JSON.stringify(details)}`;
                }).join('; ');

                const result = await processWithOllama(
                    `Кратко опиши день дома (3-5 предложений, стиль дневника дворецкого). События: ${eventSummary}`,
                    'Ты Дживс, ведёшь дневник дома. Пиши кратко, по делу, с лёгким юмором.'
                );

                const entry = result.text || `События дня: ${eventSummary}`;
                const tokenEstimate = Math.ceil(entry.length / 4);

                db.prepare(
                    "INSERT INTO house_diary (date, entry, type, token_count, created_at) VALUES (?, ?, 'daily', ?, ?)"
                ).run(today, entry, tokenEstimate, new Date().toISOString());
            }
        },
        {
            expression: '0 4 * * 0', // Sunday 04:00 — weekly compaction
            description: 'Еженедельная компактизация дневника',
            handler: async () => {
                await compactDiary();
            }
        },
        {
            expression: '0 4 * * 0', // Sunday 04:00 — clean old insights
            description: 'Очистка старых инсайтов (старше 7 дней)',
            handler: async () => {
                const db = getDb();
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - 7);
                const cutoffStr = cutoff.toISOString().split('T')[0];
                const result = db.prepare('DELETE FROM daily_insights WHERE date < ?').run(cutoffStr);
                if (result.changes > 0) {
                    console.log(`[MEMORY] Cleaned ${result.changes} old daily insights`);
                }
                invalidateCache();
            }
        },
    ],
};

function invalidateCache() {
    memoryCache = null;
}

function compactHabits(habits: string): string {
    // Split into individual habits, deduplicate, keep unique ones
    const items = habits.split(';').map(s => s.trim()).filter(Boolean);

    // Remove exact duplicates
    const unique = [...new Set(items)];

    // Remove near-duplicates (items that are substrings of others)
    const filtered = unique.filter((item, i) =>
        !unique.some((other, j) => j !== i && other.length > item.length && other.includes(item))
    );

    // If still over 500 chars, keep the most recent entries
    let result = filtered.join('; ');
    if (result.length > 500) {
        // Keep last N entries that fit in 500 chars
        const kept: string[] = [];
        let len = 0;
        for (let i = filtered.length - 1; i >= 0; i--) {
            const add = filtered[i].length + (kept.length ? 2 : 0); // +2 for "; "
            if (len + add > 480) break;
            kept.unshift(filtered[i]);
            len += add;
        }
        result = kept.join('; ');
    }

    return result;
}

import { Resident } from '../db';

function formatResidentProfile(r: Resident): string {
    const name = r.nickname || r.display_name || r.username || r.tg_id;
    const parts = [`${name} (tg: ${r.tg_id}, роль: ${r.role})`];
    if (r.nickname && r.display_name) parts[0] = `${r.nickname} (${r.display_name}, tg: ${r.tg_id})`;
    if (r.is_home) parts.push('Дома: да');
    if (r.habits) parts.push(`Привычки: ${r.habits}`);
    if (!r.habits) parts.push('Привычки: пока не изучены');
    return parts.join('\n  ');
}

async function compactDiary() {
    const { processWithOllama } = require('../core/ollama');
    const db = getDb();

    // Get entries older than 7 days that haven't been compacted
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const oldEntries = db.prepare(
        "SELECT * FROM house_diary WHERE date < ? AND type = 'daily' ORDER BY date"
    ).all(cutoffStr) as any[];

    if (oldEntries.length < 3) return; // Not enough to compact

    // Group by week
    const weeks: Record<string, any[]> = {};
    for (const entry of oldEntries) {
        const d = new Date(entry.date);
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        const weekKey = weekStart.toISOString().split('T')[0];
        if (!weeks[weekKey]) weeks[weekKey] = [];
        weeks[weekKey].push(entry);
    }

    for (const [weekStart, entries] of Object.entries(weeks)) {
        if (entries.length < 2) continue;

        const merged = entries.map((e: any) => `[${e.date}] ${e.entry}`).join('\n');
        const weekEnd = entries[entries.length - 1].date;

        // Summarize via Ollama
        const result = await processWithOllama(
            `Сожми эти ежедневные записи в одно краткое резюме недели (3-5 предложений). Сохрани ключевые события.\n\n${merged}`,
            'Ты дворецкий, ведущий дневник дома. Пиши кратко и по делу.'
        );

        const compacted = result.text || (merged.length > 500 ? merged.substring(0, 500) + '...' : merged);
        const tokenEstimate = Math.ceil(compacted.length / 4);

        // Insert compacted entry
        db.prepare(
            "INSERT INTO house_diary (date, entry, type, token_count, created_at) VALUES (?, ?, 'weekly_summary', ?, ?)"
        ).run(weekStart, `Неделя ${weekStart}..${weekEnd}: ${compacted}`, tokenEstimate, new Date().toISOString());

        // Delete originals
        const ids = entries.map((e: any) => e.id);
        db.prepare(`DELETE FROM house_diary WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);

        console.log(`[MEMORY] Compacted ${entries.length} diary entries for week ${weekStart}`);
    }

    invalidateCache();
}

/**
 * Build memory context for injection into Butler's system prompt.
 * Accepts optional residentId to prioritize facts about the current resident.
 * Cached per-resident for 5 minutes.
 * Token budget: ~700 tokens max.
 */
export function getMemoryContext(residentId?: string): string {
    const cacheKey = residentId || '__global';
    const now = Date.now();
    if (memoryCache && memoryCache.key === cacheKey && (now - memoryCache.cachedAt) < CACHE_TTL_MS) {
        return memoryCache.context;
    }

    const db = getDb();
    const parts: string[] = [];

    // 1. Resident notes — prioritize current resident, then others
    const notes = db.prepare(
        "SELECT * FROM resident_notes ORDER BY resident_name, category"
    ).all() as any[];

    if (notes.length > 0) {
        const grouped: Record<string, string[]> = {};
        for (const n of notes) {
            const key = n.resident_name || 'Общее';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(`${n.fact} [${n.category}]`);
        }

        // If we know current resident's name — find their entry
        let currentResidentName: string | null = null;
        if (residentId) {
            const resident = db.prepare('SELECT nickname, display_name, username FROM residents WHERE tg_id = ?').get(residentId) as any;
            currentResidentName = resident?.nickname || resident?.display_name || resident?.username || null;
        }

        // Sort: current resident first, then others
        const sortedEntries = Object.entries(grouped).sort(([nameA], [nameB]) => {
            if (currentResidentName) {
                const aIsCurrentResident = nameA.toLowerCase().includes(currentResidentName.toLowerCase());
                const bIsCurrentResident = nameB.toLowerCase().includes(currentResidentName.toLowerCase());
                if (aIsCurrentResident && !bIsCurrentResident) return -1;
                if (!aIsCurrentResident && bIsCurrentResident) return 1;
            }
            return 0;
        });

        const noteLines = sortedEntries.map(([name, facts]) =>
            `${name}: ${facts.join('; ')}`
        );
        let notesText = noteLines.join('\n');
        if (notesText.length > 2000) notesText = notesText.substring(0, 2000) + '...';
        parts.push(`[ПАМЯТЬ О ЖИЛЬЦАХ]\n${notesText}`);
    }

    // 2. Recent diary (last 3 days + last 2 weekly summaries)
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const recentDiary = db.prepare(
        "SELECT date, entry FROM house_diary WHERE date >= ? AND type = 'daily' ORDER BY date DESC LIMIT 3"
    ).all(threeDaysAgo.toISOString().split('T')[0]) as any[];

    const weeklySummaries = db.prepare(
        "SELECT date, entry FROM house_diary WHERE type = 'weekly_summary' ORDER BY date DESC LIMIT 2"
    ).all() as any[];

    const diaryEntries = [...weeklySummaries, ...recentDiary];
    if (diaryEntries.length > 0) {
        let diaryText = diaryEntries.map((e: any) => `[${e.date}] ${e.entry}`).join('\n');
        if (diaryText.length > 1200) diaryText = diaryText.substring(0, 1200) + '...';
        parts.push(`[ДНЕВНИК ДОМА]\n${diaryText}`);
    }

    // 3. Today's insights (real-time observations)
    const today = new Date().toISOString().split('T')[0];
    const todayInsights = db.prepare(
        'SELECT insight, resident_tg_id, created_at FROM daily_insights WHERE date = ? ORDER BY created_at'
    ).all(today) as any[];

    if (todayInsights.length > 0) {
        let insightText = todayInsights.map((i: any) => {
            const time = i.created_at.substring(11, 16);
            return `[${time}] ${i.insight}`;
        }).join('\n');
        if (insightText.length > 600) insightText = insightText.substring(0, 600) + '...';
        parts.push(`[ИНСАЙТЫ СЕГОДНЯ]\n${insightText}`);
    }

    const context = parts.length > 0 ? parts.join('\n\n') : '';
    memoryCache = { context, cachedAt: now, key: cacheKey };
    return context;
}

export default skill;
