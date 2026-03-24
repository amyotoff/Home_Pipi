import { getDb } from '../db';
import { notifyHousehold } from '../channels/telegram';
import { processWithOllama } from '../core/ollama';

const JEEVES_SYSTEM = 'Ты Дживс, дворецкий квартиры Palazzo Olmata в Риме. Отвечай кратко (2-3 предложения), в стиле Дживса. Без markdown.';

export async function sendCleaningReminder() {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const tasks = db.prepare(
        "SELECT * FROM cleaning_tasks WHERE next_due <= ? AND status != 'completed'"
    ).all(today) as any[];

    if (tasks.length === 0) return;

    const taskList = tasks.map((t: any) =>
        `${t.task_name}${t.assigned_to ? ` (${t.assigned_to})` : ''}`
    ).join(', ');

    const response = await processWithOllama(
        `Напиши краткое напоминание об уборке. Задачи на сегодня: ${taskList}.`,
        JEEVES_SYSTEM
    );

    await notifyHousehold(response.text);
}

export async function sendShoppingReminder() {
    const db = getDb();
    const items = db.prepare("SELECT item FROM shopping_list WHERE purchased = 0").all() as any[];
    if (items.length === 0) return;

    const itemList = items.map((i: any) => i.item).join(', ');

    const response = await processWithOllama(
        `Сегодня пятница вечер. Напомни о списке покупок на выходные. Товары: ${itemList}.`,
        JEEVES_SYSTEM
    );

    await notifyHousehold(response.text);
}

export async function checkOverdueTasks() {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const overdue = db.prepare(
        "SELECT * FROM cleaning_tasks WHERE next_due < ? AND status = 'pending'"
    ).all(today) as any[];

    if (overdue.length === 0) return;

    db.prepare("UPDATE cleaning_tasks SET status = 'overdue' WHERE next_due < ? AND status = 'pending'").run(today);

    const taskList = overdue.map((t: any) => t.task_name).join(', ');
    await notifyHousehold(`Позвольте обратить внимание, сэр. Имеются просроченные задачи по уборке: ${taskList}. Осмелюсь напомнить, что чистота -- залог порядка.`);
}

export async function checkCleaningInactivity() {
    const db = getDb();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    // Check for cleaning-related messages
    const recentMessages = db.prepare(
        "SELECT content FROM messages WHERE is_bot = 0 AND timestamp > ? AND (content LIKE '%уборк%' OR content LIKE '%пылесос%' OR content LIKE '%чист%')"
    ).all(threeDaysAgo) as any[];

    // Check for cleaning tool calls in event_log
    const recentEvents = db.prepare(
        "SELECT details FROM event_log WHERE event_type = 'tool_call' AND timestamp > ? AND details LIKE '%cleaning_%'"
    ).all(threeDaysAgo) as any[];

    if (recentMessages.length === 0 && recentEvents.length === 0) {
        const response = await processWithOllama(
            "Напиши очень мягкое и ненавязчивое предложение запустить пылесос или слегка прибраться, так как последние 3 дня об этом не вспоминали. Тон: расслабленный, 'на чиле', никакого давления. Стиль Дживса.",
            JEEVES_SYSTEM
        );
        await notifyHousehold(response.text);
    }
}
