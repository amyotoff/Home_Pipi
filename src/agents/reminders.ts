import { getDb, logEvent } from '../db';
import { sendMessageToChat } from '../channels/telegram';

/**
 * Checks for pending reminders that are due and notifies the user.
 * Marks them as 'done' after notification.
 */
export async function checkReminders(): Promise<void> {
    const db = getDb();
    const now = new Date().toISOString();

    const dueReminders = db.prepare(`
        SELECT * FROM reminders 
        WHERE status = 'pending' AND remind_at <= ?
    `).all(now) as any[];

    if (dueReminders.length === 0) return;

    console.log(`[REMINDERS] Firing ${dueReminders.length} reminders.`);

    for (const r of dueReminders) {
        try {
            const message = `🛎 **НАПОМИНАНИЕ**: ${r.content}`;

            // If it's a private chat, send to that user. 
            // If it's the group chat (HOUSEHOLD_CHAT_ID), send there.
            // We'll genericize it by chat_jid.
            await sendMessageToChat(r.chat_jid, message);

            db.prepare('UPDATE reminders SET status = \'done\' WHERE id = ?').run(r.id);
            logEvent('reminder_fired', { id: r.id, chat_jid: r.chat_jid });
        } catch (err) {
            console.error(`[REMINDERS] Failed to send reminder #${r.id}:`, err);
        }
    }
}
