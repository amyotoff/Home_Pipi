import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';

const skill: SkillManifest = {
    name: 'todos',
    description: 'Управление списком разовых дел: починить, выбросить, продать, съездить и т.д.',
    version: '1.0.0',

    migrations: [
        `CREATE TABLE IF NOT EXISTS todos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            added_at TEXT,
            completed_at TEXT
        )`
    ],

    tools: [
        {
            name: 'todos_add',
            description: 'Add a one-off task to the ToDo list. DO NOT use for shopping items or recurring cleaning.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task: { type: Type.STRING, description: 'Task description, e.g. "починить кран", "помыть машину", "выставить диван на Авито".' }
                },
                required: ['task'],
            }
        },
        {
            name: 'todos_list',
            description: 'Show all pending one-off tasks.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'todos_complete',
            description: 'Mark a ToDo task as completed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.INTEGER, description: 'ID of the task from the list.' }
                },
                required: ['task_id'],
            }
        },
        {
            name: 'todos_remove',
            description: 'Remove a task from the list entirely.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_id: { type: Type.INTEGER, description: 'ID of the task.' }
                },
                required: ['task_id'],
            }
        },
    ],
    handlers: {
        async todos_add(args: { task: string }) {
            const db = getDb();
            const now = new Date().toISOString();
            db.prepare('INSERT INTO todos (task, added_at) VALUES (?, ?)').run(args.task, now);
            return `[TOOL_RESULT] Добавлено в список дел: "${args.task}"`;
        },
        async todos_list() {
            const db = getDb();
            const items = db.prepare(
                "SELECT id, task, added_at FROM todos WHERE status = 'pending' ORDER BY added_at"
            ).all() as any[];
            if (items.length === 0) return '[TOOL_RESULT] Список дел пуст. Красота!';
            return '[TOOL_RESULT] Список дел:\n' + items.map((i: any) => `${i.id}. ${i.task}`).join('\n');
        },
        async todos_complete(args: { task_id: number }) {
            const db = getDb();
            const result = db.prepare(
                "UPDATE todos SET status = 'completed', completed_at = ? WHERE id = ?"
            ).run(new Date().toISOString(), args.task_id);
            return result.changes > 0
                ? `[TOOL_RESULT] Задача #${args.task_id} выполнена. Отлично работаем!`
                : `[TOOL_RESULT] Задача с ID ${args.task_id} не найдена.`;
        },
        async todos_remove(args: { task_id: number }) {
            const db = getDb();
            const result = db.prepare("DELETE FROM todos WHERE id = ?").run(args.task_id);
            return result.changes > 0
                ? `[TOOL_RESULT] Задача #${args.task_id} удалена из списка.`
                : `[TOOL_RESULT] Задача с ID ${args.task_id} не найдена.`;
        },
    }
};

export default skill;
