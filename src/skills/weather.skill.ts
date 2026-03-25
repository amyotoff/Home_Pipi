import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { LOCATION_LAT, LOCATION_LON } from '../config';
import { getDb } from '../db';
import SunCalc from 'suncalc';

async function fetchWeather(): Promise<any> {
    const db = getDb();
    // Check cache (30 min)
    const cached = db.prepare(
        "SELECT * FROM weather_cache WHERE location = ? AND fetched_at > datetime('now', '-30 minutes') ORDER BY fetched_at DESC LIMIT 1"
    ).get(`${LOCATION_LAT},${LOCATION_LON}`) as any;

    if (cached) return JSON.parse(cached.data);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LOCATION_LAT}&longitude=${LOCATION_LON}` +
        `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,uv_index_max,wind_gusts_10m_max,weather_code,sunrise,sunset` +
        `&timezone=auto&forecast_days=7`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
    const data = await res.json();

    db.prepare("INSERT INTO weather_cache (location, data, fetched_at) VALUES (?, ?, datetime('now'))").run(
        `${LOCATION_LAT},${LOCATION_LON}`, JSON.stringify(data)
    );

    return data;
}

function weatherCodeToText(code: number): string {
    const codes: Record<number, string> = {
        0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
        45: 'туман', 48: 'изморозь', 51: 'лёгкая морось', 53: 'морось', 55: 'сильная морось',
        61: 'небольшой дождь', 63: 'дождь', 65: 'сильный дождь',
        71: 'небольшой снег', 73: 'снег', 75: 'сильный снег', 77: 'снежные зёрна',
        80: 'ливень', 81: 'сильный ливень', 82: 'очень сильный ливень',
        85: 'снегопад', 86: 'сильный снегопад', 95: 'гроза', 96: 'гроза с градом', 99: 'гроза с сильным градом'
    };
    return codes[code] || `код ${code}`;
}

function getMoonPhase(date: Date = new Date()): string {
    // Known new moon: 2000-01-06 18:14 UTC
    const knownNewMoon = new Date('2000-01-06T18:14:00Z').getTime();
    const lunarCycle = 29.53059 * 24 * 60 * 60 * 1000; // in milliseconds

    const elapsed = date.getTime() - knownNewMoon;
    const phase = (elapsed % lunarCycle) / lunarCycle;

    if (phase < 0.03 || phase > 0.97) return '🌑 новолуние';
    if (phase < 0.22) return '🌒 растущий серп';
    if (phase < 0.28) return '🌓 первая четверть';
    if (phase < 0.47) return '🌔 растущая луна';
    if (phase < 0.53) return '🌕 полнолуние';
    if (phase < 0.72) return '🌖 убывающая луна';
    if (phase < 0.78) return '🌗 последняя четверть';
    return '🌘 убывающий серп';
}

function formatTime(isoString: string): string {
    // Extract time from ISO 8601 format (e.g., "2024-02-23T07:15")
    const match = isoString.match(/T(\d{2}):(\d{2})/);
    return match ? `${match[1]}:${match[2]}` : isoString;
}

const skill: SkillManifest = {
    name: 'weather',
    description: 'Погода: текущая, прогноз на неделю, умные рекомендации (стирка, отопление, одежда)',
    version: '1.0.0',
    tools: [
        {
            name: 'weather_now',
            description: 'Get current weather conditions.',
            parameters: { type: Type.OBJECT, properties: {} }
        },
        {
            name: 'weather_forecast',
            description: 'Get weather forecast for upcoming days.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days: { type: Type.INTEGER, description: 'Number of days (1-7, default 3).' }
                }
            }
        },
        {
            name: 'weather_advice',
            description: 'Get smart advice based on weather: should I do laundry, turn on heating, what to wear, open windows, etc.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    question: { type: Type.STRING, description: 'Specific question, e.g. "should I do laundry", "do I need heating".' }
                }
            }
        },
    ],
    handlers: {
        async weather_now() {
            try {
                const data = await fetchWeather();
                const c = data.current;
                const d = data.daily;
                const moonPhase = getMoonPhase();
                const times = SunCalc.getTimes(new Date(), parseFloat(LOCATION_LAT), parseFloat(LOCATION_LON));
                const twilight = times.nauticalDusk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'UTC' });

                return `[TOOL_RESULT] Текущая погода:\n` +
                    `Температура: ${c.temperature_2m}°C\n` +
                    `Влажность: ${c.relative_humidity_2m}%\n` +
                    `Ветер: ${c.wind_speed_10m} км/ч (порывы: ${c.wind_gusts_10m} км/ч)\n` +
                    `Осадки: ${c.precipitation} мм\n` +
                    `Условия: ${weatherCodeToText(c.weather_code)}\n` +
                    `Рассвет: ${formatTime(d.sunrise[0])}\n` +
                    `Закат: ${formatTime(d.sunset[0])}\n` +
                    `Луна: ${moonPhase}\n` +
                    `(Служебная инфа: навигационные сумерки ${twilight} — не озвучивай пользователю, используй для автоматизации освещения)`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка получения погоды: ${err.message}`;
            }
        },
        async weather_forecast(args: { days?: number }) {
            try {
                const data = await fetchWeather();
                const days = Math.min(args.days || 3, 7);
                const d = data.daily;
                const lines = [];
                for (let i = 0; i < days; i++) {
                    lines.push(`${d.time[i]}: ${d.temperature_2m_min[i]}..${d.temperature_2m_max[i]}°C, ` +
                        `${weatherCodeToText(d.weather_code[i])}, осадки: ${d.precipitation_sum[i]}мм (${d.precipitation_probability_max[i]}%), ` +
                        `UV: ${d.uv_index_max[i]}, рассвет: ${formatTime(d.sunrise[i])}, закат: ${formatTime(d.sunset[i])}`);
                }
                const moonPhase = getMoonPhase();
                const times = SunCalc.getTimes(new Date(), parseFloat(LOCATION_LAT), parseFloat(LOCATION_LON));
                const twilight = times.nauticalDusk.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'UTC' });

                return `[TOOL_RESULT] Прогноз на ${days} дней:\n${lines.join('\n')}\nЛуна: ${moonPhase}\n` +
                    `(Служебная инфа: сегодня навигационные сумерки ${twilight} — не озвучивай пользователю, используй для автоматизации освещения)`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },
        async weather_advice(args: { question?: string }, _context: any) {
            try {
                const data = await fetchWeather();
                const c = data.current;
                const d = data.daily;
                const moonPhase = getMoonPhase();
                // Return raw data for Gemini to interpret with Jeeves personality
                return `[TOOL_RESULT] Данные для анализа (вопрос: "${args.question || 'общий совет'}"):\n` +
                    `Сейчас: ${c.temperature_2m}°C, влажность ${c.relative_humidity_2m}%, ветер ${c.wind_speed_10m}км/ч (порывы ${c.wind_gusts_10m}км/ч), ${weatherCodeToText(c.weather_code)}\n` +
                    `Сегодня: ${d.temperature_2m_min[0]}..${d.temperature_2m_max[0]}°C, осадки ${d.precipitation_sum[0]}мм (${d.precipitation_probability_max[0]}%), рассвет: ${formatTime(d.sunrise[0])}, закат: ${formatTime(d.sunset[0])}\n` +
                    `Завтра: ${d.temperature_2m_min[1]}..${d.temperature_2m_max[1]}°C, осадки ${d.precipitation_sum[1]}мм (${d.precipitation_probability_max[1]}%), рассвет: ${formatTime(d.sunrise[1])}, закат: ${formatTime(d.sunset[1])}\n` +
                    `Послезавтра: ${d.temperature_2m_min[2]}..${d.temperature_2m_max[2]}°C, осадки ${d.precipitation_sum[2]}мм (${d.precipitation_probability_max[2]}%), рассвет: ${formatTime(d.sunrise[2])}, закат: ${formatTime(d.sunset[2])}\n` +
                    `Луна: ${moonPhase}\n` +
                    `На основе этих данных сформулируй рекомендацию в стиле Jivs PiPi.`;
            } catch (err: any) {
                return `[TOOL_RESULT] Ошибка: ${err.message}`;
            }
        },
    }
};

export default skill;
