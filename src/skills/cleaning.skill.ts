import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';

const skill: SkillManifest = {
    name: 'cleaning',
    description: 'Расписание уборки: задачи на сегодня, отметить выполнение, назначить, статистика, оптимизация графика',
    version: '1.2.0',

    migrations: [
        `INSERT OR IGNORE INTO cleaning_tasks (task_name, frequency, status) VALUES ('Мытье пола', 'weekly', 'pending')`,
        `INSERT OR IGNORE INTO cleaning_tasks (task_name, frequency, status) VALUES ('Дезинфекция туалета', 'weekly', 'pending')`,
        `INSERT OR IGNORE INTO cleaning_tasks (task_name, frequency, status) VALUES ('Чистка ванны', 'weekly', 'pending')`,
        `INSERT OR IGNORE INTO cleaning_tasks (task_name, frequency, status) VALUES ('Чистка плиты', 'weekly', 'pending')`,
        `INSERT OR IGNORE INTO cleaning_tasks (task_name, frequency, status) VALUES ('Протирка окон', 'monthly', 'pending')`,
    ],

    tools: [
        {
            name: 'cleaning_tasks_today',
            description: 'Show cleaning tasks due today or overdue.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'cleaning_complete',
            description: 'Mark a cleaning task as completed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_name: { type: Type.STRING, description: 'Name of the completed task.' },
                    notes: { type: Type.STRING, description: 'Optional notes.' }
                },
                required: ['task_name'],
            }
        },
        {
            name: 'cleaning_assign',
            description: 'Assign a cleaning task to a resident.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_name: { type: Type.STRING, description: 'Task name.' },
                    assignee: { type: Type.STRING, description: 'Name of the person.' }
                },
                required: ['task_name', 'assignee'],
            }
        },
        {
            name: 'cleaning_get_stats',
            description: 'Get cleaning statistics: when specific tasks were last completed.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_fragment: { type: Type.STRING, description: 'Optional: filter by task name (e.g. "пол", "окна").' }
                }
            }
        },
        {
            name: 'cleaning_suggest_pro',
            description: 'Suggest calling a professional cleaner. Use when residents seem overwhelmed or tired of cleaning.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'cleaning_optimize_schedule',
            description: 'Capture a resident suggestion to optimize the cleaning schedule (e.g. change frequency, move tasks).',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    suggestion: { type: Type.STRING, description: 'The optimization suggestion.' }
                },
                required: ['suggestion'],
            }
        },
        {
            name: 'cleaning_checkin',
            description: 'Register an NFC check-in for a room cleaning. Called by iPhone Shortcut after NFC tap.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    room: { type: Type.STRING, description: 'Room name (e.g. bathroom, kitchen, bedroom).' },
                    resident: { type: Type.STRING, description: 'Who did the cleaning.' }
                },
                required: ['room'],
            }
        },
        {
            name: 'cleaning_add_task',
            description: 'Add a new recurring cleaning/maintenance task. Frequency: daily, weekly, biweekly, monthly.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    task_name: { type: Type.STRING, description: 'Task name, e.g. "Поменять фильтр воды".' },
                    frequency: { type: Type.STRING, enum: ['daily', 'weekly', 'biweekly', 'monthly'], description: 'How often to repeat.' },
                    assigned_to: { type: Type.STRING, description: 'Optional name of resident.' }
                },
                required: ['task_name', 'frequency'],
            }
        },
    ],
    handlers: {
        async cleaning_tasks_today(_args: any, _context: any) {
            const db = getDb();
            const today = new Date().toISOString().split('T')[0];
            const tasks = db.prepare(
                "SELECT * FROM cleaning_tasks WHERE (next_due <= ? OR status = 'overdue') AND status != 'completed' ORDER BY next_due"
            ).all(today) as any[];
            if (tasks.length === 0) return '[TOOL_RESULT] На сегодня по уборке всё на чиле, сэр. Никаких горящих задач.';
            return '[TOOL_RESULT] Задачи уборки на горизонте:\n' + tasks.map((t: any, i: number) =>
                `${i + 1}. ${t.task_name}${t.assigned_to ? ` (${t.assigned_to})` : ''} — ${t.status}, до ${t.next_due}`
            ).join('\n');
        },
        async cleaning_complete(args: { task_name: string; notes?: string }, _context: any) {
            const db = getDb();
            const task = db.prepare("SELECT * FROM cleaning_tasks WHERE task_name LIKE ?").get(`%${args.task_name}%`) as any;
            if (!task) return `[TOOL_RESULT] Задачу "${args.task_name}" не нашел. Видимо, она самоликвидировалась.`;

            const now = new Date().toISOString();
            db.prepare("INSERT INTO cleaning_log (task_id, completed_at, notes) VALUES (?, ?, ?)").run(task.id, now, args.notes || null);

            // Calculate next due date based on frequency
            const next = new Date();
            if (task.frequency === 'daily') next.setDate(next.getDate() + 1);
            else if (task.frequency === 'weekly') next.setDate(next.getDate() + 7);
            else if (task.frequency === 'biweekly') next.setDate(next.getDate() + 14);
            else if (task.frequency === 'monthly') next.setMonth(next.getMonth() + 1);

            db.prepare("UPDATE cleaning_tasks SET last_completed = ?, next_due = ?, status = 'pending' WHERE id = ?")
                .run(now, next.toISOString().split('T')[0], task.id);

            return `[TOOL_RESULT] Ок, "${task.task_name}" — сделано. Следующий раз будет ${next.toISOString().split('T')[0]}. Но это будет еще не скоро!`;
        },
        async cleaning_assign(args: { task_name: string; assignee: string }, _context: any) {
            const db = getDb();
            const result = db.prepare("UPDATE cleaning_tasks SET assigned_to = ? WHERE task_name LIKE ?")
                .run(args.assignee, `%${args.task_name}%`);
            return result.changes > 0
                ? `[TOOL_RESULT] "${args.task_name}" теперь на совести ${args.assignee}.`
                : `[TOOL_RESULT] Не нашел такой задачи, чтобы ее на кого-то вешать.`;
        },
        async cleaning_get_stats(args: { task_fragment?: string }) {
            const db = getDb();
            let query = "SELECT task_name, last_completed FROM cleaning_tasks WHERE last_completed IS NOT NULL";
            const params: any[] = [];
            if (args.task_fragment) {
                query += " AND task_name LIKE ?";
                params.push(`%${args.task_fragment}%`);
            }
            query += " ORDER BY last_completed DESC";
            const results = db.prepare(query).all(...params) as any[];
            if (results.length === 0) return '[TOOL_RESULT] В логах пока пусто. Сэр, кажется, мы только начинаем этот путь.';
            return '[TOOL_RESULT] История чистоты:\n' + results.map(r => `- ${r.task_name}: последний раз мыли ${r.last_completed.substring(0, 10)}`).join('\n');
        },
        async cleaning_suggest_pro() {
            return `[TOOL_RESULT] Сэр, я вижу, что уборка начинает вас утомлять. Возможно, стоит вызвать профессионального клинера? Я могу поискать контакты хороших сервисов поблизости. Без лишнего стресса, на чиле.`;
        },
        async cleaning_optimize_schedule(args: { suggestion: string }) {
            const db = getDb();
            const now = new Date().toISOString();
            db.prepare("INSERT INTO resident_notes (fact, category, source, created_at, updated_at) VALUES (?, 'schedule', 'optim_suggestion', ?, ?)").run(args.suggestion, now, now);
            return `[TOOL_RESULT] Запомнил ваше пожелание по оптимизации: "${args.suggestion}". Обсудим это на досуге, когда будем пересматривать график.`;
        },
        async cleaning_checkin(args: { room: string; resident?: string }) {
            const db = getDb();
            const now = new Date().toISOString();
            const who = args.resident || 'Unknown';
            db.prepare("INSERT INTO cleaning_log (completed_at, notes) VALUES (?, ?)")
                .run(now, `NFC check-in: ${args.room} by ${who}`);
            return `[TOOL_RESULT] Зафиксировал! Комната "${args.room}" теперь сияет.`;
        },
        async cleaning_add_task(args: { task_name: string; frequency: string; assigned_to?: string }) {
            const db = getDb();
            const today = new Date().toISOString().split('T')[0];
            db.prepare(
                "INSERT INTO cleaning_tasks (task_name, frequency, assigned_to, next_due) VALUES (?, ?, ?, ?)"
            ).run(args.task_name, args.frequency, args.assigned_to || null, today);
            return `[TOOL_RESULT] Добавлена регулярная задача: "${args.task_name}" (${args.frequency}). Первое выполнение — сегодня.`;
        },
    }
};

export default skill;
