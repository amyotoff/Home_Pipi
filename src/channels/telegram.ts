import { Telegraf, Markup } from 'telegraf';
import { TELEGRAM_BOT_TOKEN, HOUSEHOLD_CHAT_ID, isOwner } from '../config';
import { upsertResident, logEvent } from '../db';

let messageHandler: ((ctx: any) => Promise<void>) | null = null;

export function setMessageHandler(handler: (ctx: any) => Promise<void>) {
    messageHandler = handler;
}

if (!TELEGRAM_BOT_TOKEN) {
    console.warn('TELEGRAM_BOT_TOKEN is not set.');
}

export const bot = new Telegraf(TELEGRAM_BOT_TOKEN || 'dummy_token');

// ==========================================
// Commands (visible in hamburger menu)
// ==========================================

// /start — greet residents
bot.command('start', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (ctx.chat?.type === 'private') {
        if (senderId && isOwner(senderId)) {
            await ctx.reply('Привет. Я батлер этой квартиры. Спрашивай, командуй, жалуйся -- разберёмся.\n\nМеню команд — в кнопке слева от поля ввода.');
        } else {
            await ctx.reply('Извини, я работаю только с жильцами этой квартиры.');
        }
    }
});

// /status + /dashboard — unified dashboard with emoji
async function handleStatusCommand(ctx: any) {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getHealthState, getSystemMetrics } = require('../core/healthcheck');
    const { getDailyTokenCost } = require('../db');

    const state = getHealthState();
    const m = getSystemMetrics();
    const daily = getDailyTokenCost();

    // Services
    const svc = [
        `${state.gemini ? '✅' : '❌'} Gemini`,
        `${state.ollama ? '✅' : '❌'} Ollama`,
        `${state.internet ? '✅' : '❌'} Internet`,
    ];
    if (state.killswitch) svc.push('⚠️ KILLSWITCH');
    if (!state.throttle_ok) svc.push('⚡ UNDERVOLT');
    if (!state.sdcard_ok) svc.push('💾 SD ERR');

    // Hardware (from cached metrics — no shell calls)
    const tempIcon = m.tempC > 70 ? '🔥' : '🌡️';
    const swap = m.swapTotalMB > 0 ? `\n🔄 Swap ${m.swapUsedMB}/${m.swapTotalMB} MB` : '';
    const hw = `${tempIcon} CPU ${m.tempC.toFixed(1)}°C\n🧠 RAM ${m.ramUsedMB}/${m.ramTotalMB} MB (${m.ramPercent}%)${swap}\n💾 Disk ${m.diskPercent}%\n⏱ ${m.uptime}`;

    // Room sensors
    let room = '';
    try {
        const { getRegisteredHandlers } = require('../skills/_registry');
        const h = getRegisteredHandlers();
        if (h.room_temperature && h.room_humidity) {
            const [t, hum] = await Promise.all([
                h.room_temperature({}),
                h.room_humidity({}),
            ]);
            const tVal = t.replace('[TOOL_RESULT] ', '');
            const hVal = hum.replace('[TOOL_RESULT] ', '');
            room = `🏠 ${tVal}\n💧 ${hVal}`;
        }
    } catch { }

    // Tokens
    const costIcon = daily.cost_usd >= 2 ? '💨' : daily.cost_usd >= 1 ? '⚠️' : '💰';
    const tokens = `${costIcon} $${daily.cost_usd.toFixed(2)} / ${daily.calls} calls\n⬆️ ${daily.input_tokens.toLocaleString()} in ⬇️ ${daily.output_tokens.toLocaleString()} out`;

    const sections = [
        `📡 PiPi Status\n${'_'.repeat(20)}`,
        svc.join(' | '),
    ];
    if (hw) sections.push(`\n⚙️ Hardware\n${hw}`);
    if (room) sections.push(`\n🏠 Studio\n${room}`);
    sections.push(`\n📊 Tokens today\n${tokens}`);

    await ctx.reply(sections.join('\n'));
}
bot.command('status', handleStatusCommand);
bot.command('dashboard', handleStatusCommand);

// /lighton — all lights on
bot.command('lighton', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getRegisteredHandlers } = require('../skills/_registry');
    const h = getRegisteredHandlers();
    if (h.lights_on) {
        const result = await h.lights_on({ light_name: 'all', brightness: 100 });
        await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
    } else {
        await ctx.reply('Скилл света не загружен.');
    }
});

// /lightoff — all lights off
bot.command('lightoff', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getRegisteredHandlers } = require('../skills/_registry');
    const h = getRegisteredHandlers();
    if (h.lights_off) {
        const result = await h.lights_off({ light_name: 'all' });
        await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
    } else {
        await ctx.reply('Скилл света не загружен.');
    }
});

// /shopping — show shopping list
bot.command('shopping', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getRegisteredHandlers } = require('../skills/_registry');
    const h = getRegisteredHandlers();
    if (h.shopping_list) {
        const result = await h.shopping_list({});
        await ctx.reply(result.replace('[TOOL_RESULT] ', ''));
    } else {
        await ctx.reply('Скилл покупок не загружен.');
    }
});

// /killswitch — toggle kill switch
bot.command('killswitch', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { isKillSwitchActive, setKillSwitch } = require('../core/healthcheck');
    const text = (ctx.message as any)?.text || '';
    const arg = text.split(/\s+/)[1]?.toLowerCase();

    if (arg === 'off' || arg === 'выкл') {
        setKillSwitch(false);
        await ctx.reply('Kill switch снят. Бот работает в штатном режиме.');
    } else if (arg === 'on' || arg === 'вкл') {
        setKillSwitch(true, 'ручное включение через /killswitch');
        await ctx.reply('Kill switch АКТИВИРОВАН. LLM-вызовы заблокированы.');
    } else {
        const active = isKillSwitchActive();
        if (active) {
            setKillSwitch(false);
            await ctx.reply('Kill switch снят. Бот работает в штатном режиме.');
        } else {
            setKillSwitch(true, 'ручное включение через /killswitch');
            await ctx.reply('Kill switch АКТИВИРОВАН. LLM-вызовы заблокированы.');
        }
    }
});

// /reset — clear conversation context (with pre-clear diary summary)
bot.command('reset', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    if (!chatId || !senderId || !isOwner(senderId)) return;

    const { clearMessages, getRecentMessages, getDb } = require('../db');
    const { processWithOllama } = require('../core/ollama');

    await ctx.reply('Сохраняю краткое резюме разговора...');

    try {
        const msgs = getRecentMessages(chatId, 30) as any[];

        if (msgs.length >= 5) {
            // Build readable transcript
            const transcript = msgs.map((m: any) => {
                const role = m.is_bot ? 'Jivs' : 'Жилец';
                const text = m.content?.substring(0, 200) || '';
                return `${role}: ${text}`;
            }).join('\n');

            const result = await processWithOllama(
                `Сделай краткое резюме этого разговора (3-4 предложения, по-русски). Отметь ключевые темы, просьбы и решения.\n\n${transcript}`,
                'Ты дворецкий Дживс. Пиши кратко, по делу.'
            );

            const summary = result.text?.trim();
            if (summary && summary.length > 20) {
                const today = new Date().toISOString().split('T')[0];
                const db = getDb();
                db.prepare(
                    "INSERT INTO house_diary (date, entry, type, token_count, created_at) VALUES (?, ?, 'pre_clear', ?, ?)"
                ).run(today, `[Архив разговора] ${summary}`, Math.ceil(summary.length / 4), new Date().toISOString());

                console.log(`[RESET] Pre-clear summary saved to diary (${summary.length} chars)`);
            }
        }
    } catch (err: any) {
        console.warn(`[RESET] Summary generation failed: ${err.message}`);
    }

    clearMessages(chatId);
    await ctx.reply('Контекст очищен. Начинаем с чистого листа.');
});

// /atelier — show skill requests with inline management (owners only)
bot.command('atelier', async (ctx) => {
    const senderId = ctx.from?.id.toString();
    if (!senderId || !isOwner(senderId)) return;

    const { getDb } = require('../db');
    const text = (ctx.message as any)?.text || '';
    const showAll = text.trim().toLowerCase().endsWith('all');

    const statusFilter = showAll
        ? "status IN ('pending', 'in_progress', 'done', 'rejected')"
        : "status IN ('pending', 'in_progress')";

    const requests = getDb().prepare(
        `SELECT * FROM skill_requests WHERE ${statusFilter} ORDER BY 
         CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'done' THEN 2 WHEN 'rejected' THEN 3 END,
         CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 END,
         votes DESC, created_at DESC LIMIT 15`
    ).all() as any[];

    if (requests.length === 0) {
        await ctx.reply(showAll ? 'Ателье пусто. Ни одного запроса.' : 'Ателье пусто. Все навыки на месте.\n\n/atelier all — показать завершённые.');
        return;
    }

    const STATUS_EMOJI: Record<string, string> = { pending: '⏳', in_progress: '🔧', done: '✅', rejected: '❌', cleared: '🗑' };
    const PRIORITY_EMOJI: Record<string, string> = { high: '🔴', normal: '🟢', low: '🟡' };

    for (const r of requests) {
        const status = STATUS_EMOJI[r.status] || '❓';
        const prio = PRIORITY_EMOJI[r.priority] || '';
        const date = r.created_at?.substring(0, 10) || '';
        const votes = (r.votes || 1) > 1 ? ` (${r.votes} голосов)` : '';
        const hw = r.hardware_needed ? `\n🔩 Железо: ${r.hardware_needed}` : '';

        const line = `${status}${prio} ${r.skill_name}${votes}\n"${r.user_request}"\n${r.description}${hw}\n${date}`;

        // Only show action buttons for active requests
        if (r.status === 'pending' || r.status === 'in_progress') {
            const buttons = [];
            if (r.status === 'pending') buttons.push(Markup.button.callback('🔧 В работу', `atl:ip:${r.id}`));
            if (r.status === 'in_progress') buttons.push(Markup.button.callback('✅ Готово', `atl:done:${r.id}`));
            buttons.push(Markup.button.callback('❌ Откл.', `atl:rej:${r.id}`));
            buttons.push(Markup.button.callback('🗑', `atl:del:${r.id}`));

            await ctx.reply(line, Markup.inlineKeyboard(buttons));
        } else {
            await ctx.reply(line);
        }
    }

    if (!showAll) {
        await ctx.reply('/atelier all — показать все (включая завершённые)');
    }
});

// Atelier status change callbacks
bot.action(/^atl:(ip|done|rej|del):(\d+)$/, async (ctx) => {
    const approverId = ctx.from?.id.toString();
    if (!approverId || !isOwner(approverId)) {
        await ctx.answerCbQuery('Только жильцы могут управлять Ателье.');
        return;
    }

    const action = ctx.match[1];
    const requestId = parseInt(ctx.match[2]);
    const { getDb } = require('../db');
    const db = getDb();

    const request = db.prepare('SELECT * FROM skill_requests WHERE id = ?').get(requestId) as any;
    if (!request) {
        await ctx.answerCbQuery('Запрос не найден.');
        return;
    }

    const STATUS_MAP: Record<string, string> = { ip: 'in_progress', done: 'done', rej: 'rejected', del: 'cleared' };
    const STATUS_LABEL: Record<string, string> = { ip: '🔧 В работе', done: '✅ Готово', rej: '❌ Отклонён', del: '🗑 Удалён' };
    const newStatus = STATUS_MAP[action];
    const label = STATUS_LABEL[action];
    const oldStatus = request.status;

    // Update status
    const resolvedAt = (newStatus === 'done' || newStatus === 'rejected') ? new Date().toISOString() : null;
    db.prepare(
        'UPDATE skill_requests SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?'
    ).run(newStatus, resolvedAt, requestId);

    // Log to history
    db.prepare(
        'INSERT INTO skill_request_history (request_id, old_status, new_status, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)'
    ).run(requestId, oldStatus, newStatus, approverId, new Date().toISOString());

    await ctx.editMessageText(`${label}: ${request.skill_name}\n"${request.user_request}"`);
    await ctx.answerCbQuery(label);

    // Notify household when skill is done
    if (newStatus === 'done' && HOUSEHOLD_CHAT_ID) {
        const title = request.description?.match(/\[([^\]]+)\]/)?.[1] || request.skill_name;
        await sendMessageToChat(HOUSEHOLD_CHAT_ID, `🎉 Навык "${title}" реализован! Попробуйте.`);
    }

    logEvent('atelier_status_change', { requestId, oldStatus, newStatus, by: approverId });
});

// Auto-register household group
bot.on('my_chat_member', async (ctx) => {
    const newStatus = ctx.myChatMember.new_chat_member.status;
    const chat = ctx.chat;
    if (chat.type === 'group' || chat.type === 'supergroup') {
        if (newStatus === 'member' || newStatus === 'administrator') {
            const { upsertChat } = require('../db');
            upsertChat({ jid: chat.id.toString(), type: 'household_group', status: 'ACTIVE' });
            console.log(`[BOT] Registered group ${chat.id} as household chat.`);
        }
    }
});

// Main message handler
bot.on('message', async (ctx) => {
    try {
        if (messageHandler) {
            await messageHandler(ctx);
        }
    } catch (error) {
        console.error('Error handling message:', error);
    }
});

export function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.log('Skipping Telegram bot (missing token).');
        return;
    }

    // Register hamburger menu commands
    bot.telegram.setMyCommands([
        { command: 'status', description: '📡 PiPi: железо, сенсоры, токены' },
        { command: 'lighton', description: '💡 Включить весь свет' },
        { command: 'lightoff', description: '🌑 Выключить весь свет' },
        { command: 'shopping', description: '🛒 Список покупок' },
        { command: 'killswitch', description: '⛔ Вкл/выкл kill switch' },
        { command: 'reset', description: '🔄 Очистить контекст' },
        { command: 'atelier', description: '🧰 Запросы новых навыков' },
    ]).catch(err => console.error('[BOT] Failed to set commands:', err.message));

    bot.launch();
    console.log('Telegram bot started.');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

export async function sendMessageToChat(chatId: string, text: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const cleanText = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
        await bot.telegram.sendMessage(chatId, cleanText);
    } catch (error) {
        console.error(`Failed to send to ${chatId}:`, error);
    }
}

export async function notifyHousehold(text: string) {
    if (HOUSEHOLD_CHAT_ID) {
        await sendMessageToChat(HOUSEHOLD_CHAT_ID, text);
    }
}

export async function sendTypingAction(chatId: string) {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        await bot.telegram.sendChatAction(chatId, 'typing');
    } catch {
        // Non-critical
    }
}
