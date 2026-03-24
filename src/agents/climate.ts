import { getDb, logEvent, getAllResidents } from '../db';
import { HOUSEHOLD_CHAT_ID } from '../config';
import { handleButlerMessage } from './butler';

// Store cooldowns to avoid spamming the house chat
const lastAlertTimes: Record<string, number> = {};
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Get median or avg from an array of values */
function getAvg(values: number[]): number {
    if (!values.length) return 0;
    const sum = values.reduce((a, b) => a + b, 0);
    return Math.round((sum / values.length) * 10) / 10;
}

/** Check sensor readings every 10 mins */
export async function checkAmbientComfort() {
    if (!HOUSEHOLD_CHAT_ID) return;

    // Check if anyone is home
    const db = getDb();
    const homeCount = (db.prepare('SELECT COUNT(*) as c FROM residents WHERE is_home = 1').get() as any)?.c || 0;
    if (homeCount === 0) return; // Don't complain if no one is home

    // Get readings from last 20 mins to smooth out spikes
    const since20 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const rows = db.prepare(
        `SELECT type, value FROM sensor_readings WHERE sensor_id = 'studio' AND timestamp > ?`
    ).all(since20) as any[];

    if (rows.length === 0) return;

    const temps = rows.filter(r => r.type === 'temperature').map(r => r.value);
    const hums = rows.filter(r => r.type === 'humidity').map(r => r.value);
    const co2s = rows.filter(r => r.type === 'co2').map(r => r.value);

    const t = getAvg(temps);
    const h = getAvg(hums);
    const c = getAvg(co2s);

    let alertType = null;
    let reason = '';

    // Define thresholds
    if (t > 24.5) { alertType = 'hot'; reason = `Температура ${t}°C (выше нормы).`; }
    else if (t < 17.0) { alertType = 'cold'; reason = `Температура ${t}°C (ниже нормы).`; }
    else if (h > 80) { alertType = 'humid'; reason = `Влажность ${h}% (очень высокая, риск плесени).`; }
    else if (c > 1200) { alertType = 'co2'; reason = `CO2 ${c} ppm (может быть душно).`; }

    if (alertType) {
        const now = Date.now();
        if (!lastAlertTimes[alertType] || now - lastAlertTimes[alertType] > COOLDOWN_MS) {
            lastAlertTimes[alertType] = now;
            logEvent('ambient_alert', { type: alertType, temp: t, hum: h, co2: c });

            const residentNames = getAllResidents().map(r => r.nickname || r.display_name || r.username).filter(Boolean).join(', ');

            const instruction = `[SYSTEM AMBIENT ALERT]: Данные датчиков вышли за пределы комфорта: ${reason}
ПОМНИ СВОЙ TOV: ты элегантный британский дворецкий Дживс. Обращайся ко ВСЕМ жильцам (${residentNames}), не выделяй кого-то одного.
Напиши сообщение в чат. Начни с фразы в духе "Позвольте заметить..." или "Смею обратить ваше внимание...". Опиши ситуацию и деликатно предложи решение (например, включить кондиционер, отопление, осушитель или просто проветрить квартиру). Коротко и по делу, 1-2 предложения.`;

            await handleButlerMessage(null, HOUSEHOLD_CHAT_ID, 'system_climate', instruction);
        }
    }
}

/** Analyze historical climate every 24h */
export async function analyzeDailyClimate() {
    if (!HOUSEHOLD_CHAT_ID) return;

    const db = getDb();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(
        `SELECT type, value FROM sensor_readings WHERE sensor_id = 'studio' AND timestamp > ?`
    ).all(since24h) as any[];

    if (rows.length === 0) return;

    const temps = rows.filter(r => r.type === 'temperature').map(r => r.value);
    const hums = rows.filter(r => r.type === 'humidity').map(r => r.value);
    const co2s = rows.filter(r => r.type === 'co2').map(r => r.value);

    // Calculate daily analytics
    const tAvg = getAvg(temps);
    const hAvg = getAvg(hums);
    const cAvg = getAvg(co2s);

    // Find extremes
    const hMax = hums.length ? Math.max(...hums) : 0;
    const hMin = hums.length ? Math.min(...hums) : 0;
    const cMax = co2s.length ? Math.max(...co2s) : 0;

    let insights: string[] = [];

    // Only flag stuff that is consistently problematic over the day
    if (hAvg > 65 || hMax > 80) {
        insights.push(`Высокая влажность. В среднем ${hAvg}%, доходила до ${hMax}%. Это повышает риск образования плесени.`);
    } else if (hAvg < 35 || hMin < 30) {
        insights.push(`Пониженная влажность. В среднем ${hAvg}%, падала до ${hMin}%. Слишком сухой воздух вреден для дыхательных путей и мебели.`);
    }

    if (cAvg > 900 || cMax > 1500) {
        insights.push(`Повышенный уровень CO2. В среднем за сутки ${cAvg} ppm, пик ${cMax} ppm. Стоит чаще и качественнее проветривать.`);
    }

    if (insights.length > 0) {
        logEvent('daily_climate_insight', { tAvg, hAvg, cAvg, insights: insights.length });

        const residentNames = getAllResidents().map(r => r.nickname || r.display_name || r.username).filter(Boolean).join(', ');

        const instruction = `[SYSTEM DAILY CLIMATE]: Я собрал анализ климата в квартире за последние 24 часа. Средняя температура была комфортной (${tAvg}°C), но есть замечания:
${insights.map(i => '- ' + i).join('\n')}

ПОМНИ СВОЙ TOV: ты элегантный британский дворецкий Дживс. Обращайся ко ВСЕМ жильцам (${residentNames}), не выделяй кого-то одного.
Напиши короткое сообщение в чат. Поблагодари за день и деликатно обрати внимание на эти климатические наблюдения. Дай житейский совет (например, стоит ли подумать об увлажнителе/осушителе воздуха или просто чаще проветривать по вечерам). Коротко и по делу.`;

        await handleButlerMessage(null, HOUSEHOLD_CHAT_ID, 'system_climate', instruction);
    }
}
