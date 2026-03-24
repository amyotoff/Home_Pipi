import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';

const skill: SkillManifest = {
    name: 'reminders',
    description: 'Manage personal and household reminders',
    version: '1.0.0',
    tools: [
        {
            name: 'reminder_set',
            description: 'Set a new reminder at a specific time',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    content: { type: Type.STRING, description: 'What to remind about' },
                    remind_at: { type: Type.STRING, description: 'ISO date/time string' },
                },
                required: ['content', 'remind_at']
            }
        },
        {
            name: 'reminder_list',
            description: 'List all pending reminders for the current chat',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    all: { type: Type.BOOLEAN, description: 'Whether to show all reminders or just upcoming (default: false)' }
                }
            }
        },
        {
            name: 'reminder_cancel',
            description: 'Cancel (delete) a reminder by ID',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.NUMBER, description: 'Reminder ID to cancel' }
                },
                required: ['id']
            }
        }
    ],
    handlers: {
        async reminder_set(args: { content: string; remind_at: string }, context?: { chatId: string, userId: string }) {
            if (!context) return '[TOOL_ERROR] Context missing.';
            const db = getDb();
            const res = db.prepare(`
                INSERT INTO reminders (chat_jid, sender_tg_id, content, remind_at, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(context.chatId, context.userId, args.content, args.remind_at, new Date().toISOString());

            return `[TOOL_RESULT] Reminder set (ID: ${res.lastInsertRowid}) for ${args.remind_at}.`;
        },

        async reminder_list(args: { all?: boolean }, context?: { chatId: string, userId: string }) {
            if (!context) return '[TOOL_ERROR] Context missing.';
            const db = getDb();
            const now = new Date().toISOString();
            const query = args.all
                ? 'SELECT * FROM reminders WHERE chat_jid = ? ORDER BY remind_at ASC'
                : 'SELECT * FROM reminders WHERE chat_jid = ? AND status = \'pending\' AND remind_at > ? ORDER BY remind_at ASC';

            const params = args.all ? [context.chatId] : [context.chatId, now];
            const rows = db.prepare(query).all(...params) as any[];

            if (rows.length === 0) return '[TOOL_RESULT] No reminders found.';

            const lines = rows.map((r: any) => `[#${r.id}] ${new Date(r.remind_at).toLocaleString('ru-RU')} - ${r.content} (${r.status})`);
            return `[TOOL_RESULT] Reminders:\n${lines.join('\n')}`;
        },

        async reminder_cancel(args: { id: number }, context?: { chatId: string, userId: string }) {
            if (!context) return '[TOOL_ERROR] Context missing.';
            const db = getDb();
            const res = db.prepare('DELETE FROM reminders WHERE id = ? AND chat_jid = ?').run(args.id, context.chatId);

            if (res.changes === 0) return `[TOOL_RESULT] Reminder #${args.id} not found or not in this chat.`;
            return `[TOOL_RESULT] Reminder #${args.id} cancelled.`;
        }
    }
};

export default skill;
