import cron from 'node-cron';
import { handleButlerMessage } from './agents/butler';
import { sendCleaningReminder, sendShoppingReminder, checkOverdueTasks, checkCleaningInactivity } from './agents/housekeeper';
import { runPresenceCheck, runSystemHealthCheck, runNetworkScan, runZombieCheck, runWeatherAlert, runServiceWatchdog, runDatabaseBackup } from './agents/sysadmin';
import { checkAmbientComfort } from './agents/climate';
import { checkReminders } from './agents/reminders';
import { runHeartbeat } from './core/healthcheck';
import { HOUSEHOLD_CHAT_ID } from './config';
import { storeMessage, getDb, getAllResidents } from './db';

const TZ = process.env.TZ ? { timezone: process.env.TZ } : {};

/** Store a cron instruction in DB so handleButlerMessage sees it in context */
function sendCronToButler(chatId: string, text: string) {
    storeMessage({
        id: `cron-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        chat_jid: chatId,
        sender_tg_id: 'system_cron',
        content: text,
        timestamp: new Date().toISOString(),
        is_bot: 0,
    });
    return handleButlerMessage(null, chatId, 'system_cron', text);
}

/** Get user messages from the last N hours across all chats */
function getRecentChatHistory(hours: number): string {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = getDb().prepare(
        `SELECT m.content, m.timestamp, r.nickname, r.display_name
         FROM messages m
         LEFT JOIN residents r ON m.sender_tg_id = r.tg_id
         WHERE m.is_bot = 0 AND m.sender_tg_id != 'system_cron' AND m.timestamp > ?
         ORDER BY m.timestamp ASC`
    ).all(cutoff) as { content: string; timestamp: string; nickname: string | null; display_name: string | null }[];

    if (rows.length === 0) return '';
    return `\n\nИстория чата за последние ${hours} часов (ВНИМАТЕЛЬНО ПРОЧИТАЙ И НЕ ПРОПУСТИ НИ ОДНОЙ ПРОСЬБЫ ИЛИ НАПОМИНАНИЯ):\n` +
        rows.map(m => {
            const name = m.nickname || m.display_name || 'Жилец';
            return `[${m.timestamp.substring(11, 16)}] ${name}: ${m.content}`;
        }).join('\n');
}

export function startTaskScheduler() {
    console.log('[SCHEDULER] Starting cron jobs...');

    // Heartbeat every 60 seconds
    cron.schedule('* * * * *', async () => {
        try { await runHeartbeat(); }
        catch (e) { console.error('[CRON] Heartbeat error:', e); }
    }, TZ);

    // Presence check every 5 minutes
    cron.schedule('*/5 * * * *', async () => {
        try { await runPresenceCheck(); }
        catch (e) { console.error('[CRON] Presence check error:', e); }

        // Service watchdog: checks all Docker containers + Z2M adapter
        try { await runServiceWatchdog(); }
        catch (e) { console.error('[CRON] Service watchdog error:', e); }
    }, TZ);

    // System health + weather alert every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        try { await runSystemHealthCheck(); }
        catch (e) { console.error('[CRON] Health check error:', e); }
        try { await runWeatherAlert(); }
        catch (e) { console.error('[CRON] Weather alert error:', e); }
    }, TZ);

    // Network scan every 2 hours
    cron.schedule('0 */2 * * *', async () => {
        try { await runNetworkScan(); }
        catch (e) { console.error('[CRON] Network scan error:', e); }
    }, TZ);

    // Zombie device check every 6 hours
    cron.schedule('0 */6 * * *', async () => {
        try { await runZombieCheck(); }
        catch (e) { console.error('[CRON] Zombie check error:', e); }
    }, TZ);

    // Daily database backup at 03:00
    cron.schedule('0 3 * * *', async () => {
        try { await runDatabaseBackup(); }
        catch (e) { console.error('[CRON] Database backup error:', e); }
    }, TZ);

    // Morning briefing 09:00
    cron.schedule('0 9 * * *', async () => {
        if (!HOUSEHOLD_CHAT_ID) return;
        try {
            const now = new Date();
            const dateStr = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: process.env.TZ || undefined });
            const history = getRecentChatHistory(14);
            const residentNames = getAllResidents().map(r => r.nickname || r.display_name || r.username).filter(Boolean).join(', ');

            await sendCronToButler(HOUSEHOLD_CHAT_ID,
                `[SYSTEM CRON]: Утренний брифинг. Сегодня ${dateStr}. 
ПОМНИ СВОЙ TOV: ты услужливый, элегантный британский дворецкий Дживс. Обращайся ко ВСЕМ жильцам (${residentNames}), не выделяй кого-то одного. Избегай сухого или "солдафонского" тона. Никаких докладов и рапортов — только изящный джентльменский брифинг.
Начни с даты и короткого приветствия всех, потом: погода (weather_now, weather_advice), задачи уборки (cleaning_tasks_today), список дел (todos_list), проблемы если есть (system_health). Если всё ок -- скажи что всё прекрасно. 
ВНИМАТЕЛЬНО ПРОЧИТАЙ ИСТОРИЮ ЧАТА: если есть пропущенные просьбы или напоминания с вечера/ночи -- обязательно включи их в брифинг.` + history);
        } catch (e) { console.error('[CRON] Morning briefing error:', e); }
    }, TZ);

    // Cleaning reminder 09:00
    cron.schedule('0 9 * * *', async () => {
        try { await sendCleaningReminder(); }
        catch (e) { console.error('[CRON] Cleaning reminder error:', e); }
    }, TZ);

    // Cleaning inactivity check 11:00
    cron.schedule('0 11 * * *', async () => {
        try { await checkCleaningInactivity(); }
        catch (e) { console.error('[CRON] Inactivity check error:', e); }
    }, TZ);

    // Overdue tasks check 12:00
    cron.schedule('0 12 * * *', async () => {
        try { await checkOverdueTasks(); }
        catch (e) { console.error('[CRON] Overdue check error:', e); }
    }, TZ);

    // Evening summary 21:00
    cron.schedule('0 21 * * *', async () => {
        if (!HOUSEHOLD_CHAT_ID) return;
        try {
            const history = getRecentChatHistory(14);
            const residentNames = getAllResidents().map(r => r.nickname || r.display_name || r.username).filter(Boolean).join(', ');

            await sendCronToButler(HOUSEHOLD_CHAT_ID,
                `[SYSTEM CRON]: Вечерний брифинг. 
ПОМНИ СВОЙ TOV: ты услужливый, элегантный британский дворецкий Дживс. Обращайся ко ВСЕМ жильцам (${residentNames}), не выделяй кого-то одного. Избегай сухого или "солдафонского" тона. Никаких докладов и рапортов — только изящный джентльменский вечерний итог-беседа.
Кратко подведи итоги дня: кто был дома, погода, выполненные задачи (cleaning, todos). Используй who_is_home, weather_now, system_health, todos_list. 
ВНИМАТЕЛЬНО ПРОЧИТАЙ ИСТОРИЮ ЧАТА: если есть незаконченные дела, просьбы или вопросы, оставшиеся без ответа за день -- обязательно изящно упомяни их.` + history);
        } catch (e) { console.error('[CRON] Evening summary error:', e); }
    }, TZ);

    // Shopping reminder Friday 18:00
    cron.schedule('0 18 * * 5', async () => {
        try { await sendShoppingReminder(); }
        catch (e) { console.error('[CRON] Shopping reminder error:', e); }
    }, TZ);

    // Smart Ambient Sensors
    // Check comfort every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
        try { await checkAmbientComfort(); }
        catch (e) { console.error('[CRON] Ambient comfort error:', e); }
    }, TZ);

    // Afternoon care check at 17:00 — Jivs reflects on home comfort, holidays, birthdays, and lifestyle
    cron.schedule('0 17 * * *', async () => {
        if (!HOUSEHOLD_CHAT_ID) return;
        try {
            const history = getRecentChatHistory(8);
            const residentNames = getAllResidents().map(r => r.nickname || r.display_name || r.username).filter(Boolean).join(', ');

            const now = new Date();
            const dateStr = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: process.env.TZ || undefined });
            const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: process.env.TZ || undefined }).toLowerCase();
            const month = now.getMonth() + 1;
            const day = now.getDate();

            // Check for important dates in resident_notes
            const db = getDb();
            const importantDates = db.prepare(
                "SELECT resident_name, fact FROM resident_notes WHERE category = 'important_date'"
            ).all() as { resident_name: string; fact: string }[];
            const datesContext = importantDates.length > 0
                ? `\nВажные даты жильцов (из памяти): ${importantDates.map(d => `${d.resident_name}: ${d.fact}`).join('; ')}`
                : '\nВажных дат в памяти пока нет. Если жильцы упоминали дни рождения или годовщины — запомни их через memory_remember с категорией important_date.';

            await sendCronToButler(HOUSEHOLD_CHAT_ID,
                `[SYSTEM CRON]: Дневная забота (17:00). Сегодня ${dateStr}.
ПОМНИ СВОЙ TOV: ты заботливый, элегантный британский дворецкий Дживс. Обращайся ко ВСЕМ жильцам (${residentNames}).

Твоя задача — ПОДУМАТЬ, есть ли что-то тёплое, полезное или важное для жильцов. Проверь:

1. 🎂 ПРАЗДНИКИ И ДНИ РОЖДЕНИЯ:${datesContext}
   Сегодня ${day}.${month.toString().padStart(2, '0')}. Проверь: совпадает ли эта дата с днём рождения кого-то из жильцов? Если да — поздравь тепло и элегантно.
   Также проверь через web_search: есть ли сегодня важный праздник (итальянский, российский, международный)? Примеры: Festa della Repubblica, 8 Марта, Пасха, Рождество, День святого Валентина, Ferragosto и др. Если есть — упомяни изящно. Не надо поздравлять с мелкими или неизвестными праздниками.

2. 🌡 КЛИМАТ: используй room_comfort — температура, влажность (датчик SNZB-02D). Если что-то не так — предложи решение.

3. 🔧 ДАТЧИКИ: проверь activity_log — если были sensor_offline или sensor_low_battery за сегодня, упомяни.

4. ⛅ ПОГОДА: используй weather_now — если на вечер ожидается дождь/холод/жара, подскажи.

5. 📋 УБОРКА/ЗАДАЧИ: используй cleaning_tasks_today и todos_list — если что-то забыто, деликатно напомни.

6. 💡 ЛАЙФХАКИ И ЗАБОТА: подумай, чем ещё можно помочь жильцам жить лучше:
   - ${dayOfWeek === 'friday' || dayOfWeek === 'saturday' ? 'Выходные на носу — может предложить план отдыха, куда сходить в городе, рецепт на ужин?' : ''}
   - Если в чате упоминалась усталость или стресс — предложи что-то приятное (чай, прогулка, расслабляющая музыка).
   - Если давно не проветривали и погода позволяет — напомни.
   - Если жарко/душно — предложи что приготовить холодное, или напомни пить воду.
   - Если холодно — предложи тёплый плед, горячий напиток.
   - Сезонные советы: ${month >= 6 && month <= 8 ? 'лето — защита от солнца, увлажнение, лёгкая еда' : month >= 11 || month <= 2 ? 'зима — тёплая одежда, витамины, уют' : month >= 3 && month <= 5 ? 'весна — аллергия, проветривание, прогулки' : 'осень — тёплые напитки, уютный свет, подготовка к холодам'}.

ВАЖНО: Не пиши обо ВСЁМ сразу. Выбери 1-2 самые актуальные темы. Если всё в порядке и праздников нет — НЕ ПИШИ НИЧЕГО. Молчание допустимо. Пиши ТОЛЬКО если есть реальная забота, праздник или полезный совет.
Если решишь написать — будь кратким (2-4 предложения), тёплым и ненавязчивым.` + history);
        } catch (e) { console.error('[CRON] Afternoon care error:', e); }
    }, TZ);

    // Check reminders every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
        try { await checkReminders(); }
        catch (e) { console.error('[CRON] Reminders check error:', e); }
    }, TZ);

    // Atelier weekly reminder — Monday 10:00
    cron.schedule('0 10 * * 1', async () => {
        if (!HOUSEHOLD_CHAT_ID) return;
        try {
            const db = getDb();
            const pending = db.prepare(
                "SELECT COUNT(*) as cnt, MIN(created_at) as oldest FROM skill_requests WHERE status IN ('pending', 'in_progress')"
            ).get() as any;
            if (pending.cnt > 0) {
                const oldestDate = pending.oldest?.substring(0, 10) || '?';
                const daysAgo = Math.floor((Date.now() - new Date(pending.oldest).getTime()) / 86400000);
                const { sendMessageToChat } = require('./channels/telegram');
                await sendMessageToChat(HOUSEHOLD_CHAT_ID,
                    `📋 В Ателье ${pending.cnt} запрос(ов). Самый старый: ${oldestDate} (${daysAgo} дн. назад). /atelier для деталей.`
                );
            }
        } catch (e) { console.error('[CRON] Atelier reminder error:', e); }
    }, TZ);

    console.log('[SCHEDULER] All cron jobs registered.');
}
