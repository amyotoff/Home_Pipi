import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';

const skill: SkillManifest = {
    name: 'shopping',
    description: 'Управление списком покупок: добавить, удалить, показать, очистить',
    version: '1.0.0',
    tools: [
        {
            name: 'shopping_add',
            description: 'Add physical items/goods to the shopping list. ONLY use for products to buy (milk, bread, etc). STOP: Do not use for actions, tasks, or cleaning (e.g. "wash car" is a task, not a shopping item).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    items: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Items to buy, e.g. ["молоко", "мыло"].' }
                },
                required: ['items'],
            }
        },
        {
            name: 'shopping_remove',
            description: 'Remove or mark an item as purchased from the shopping list.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    item: { type: Type.STRING, description: 'Item name to remove or mark purchased.' }
                },
                required: ['item'],
            }
        },
        {
            name: 'shopping_list',
            description: 'Show the current shopping list with all unpurchased items.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'shopping_clear',
            description: 'Clear the entire shopping list (mark all as purchased).',
            parameters: { type: Type.OBJECT, properties: {} }
        },
    ],
    handlers: {
        async shopping_add(args: { items: string[] }, _context: any) {
            const db = getDb();
            const now = new Date().toISOString();
            for (const item of args.items) {
                db.prepare('INSERT INTO shopping_list (item, added_at) VALUES (?, ?)').run(item, now);
            }
            return `[TOOL_RESULT] Добавлено ${args.items.length} товаров: ${args.items.join(', ')}`;
        },
        async shopping_remove(args: { item: string }, _context: any) {
            const db = getDb();
            const result = db.prepare(
                "UPDATE shopping_list SET purchased = 1, purchased_at = ? WHERE item LIKE ? AND purchased = 0"
            ).run(new Date().toISOString(), `%${args.item}%`);
            return result.changes > 0
                ? `[TOOL_RESULT] "${args.item}" отмечено как купленное.`
                : `[TOOL_RESULT] "${args.item}" не найдено в списке.`;
        },
        async shopping_list(_args: any, _context: any) {
            const db = getDb();
            const items = db.prepare(
                "SELECT item, added_at FROM shopping_list WHERE purchased = 0 ORDER BY added_at"
            ).all() as any[];
            if (items.length === 0) return '[TOOL_RESULT] Список покупок пуст.';
            return '[TOOL_RESULT] Список покупок:\n' + items.map((i: any, idx: number) => `${idx + 1}. ${i.item}`).join('\n');
        },
        async shopping_clear(_args: any, _context: any) {
            const db = getDb();
            const result = db.prepare("UPDATE shopping_list SET purchased = 1, purchased_at = ? WHERE purchased = 0")
                .run(new Date().toISOString());
            return `[TOOL_RESULT] Список покупок очищен. Отмечено ${result.changes} товаров.`;
        },
    }
};

export default skill;
