import { Context } from 'telegraf';
import fs from 'fs';
import path from 'path';
import { getRecentMessages, storeMessage, getResident, getAllResidents, logEvent } from '../db';
import { processWithLLM, processWithVision, LLMMessage } from '../core/llm';
import { processWithOllama } from '../core/ollama';
import { sendMessageToChat, bot } from '../channels/telegram';
import { getMemoryContext } from '../skills/memory.skill';

function isSimpleMessage(text: string): boolean {
    const t = text.toLowerCase().trim();
    if (/^(привет|здравствуй|хай|хей|добр(ое|ый|ой)|салют|здоров|йо)\b/.test(t)) return true;
    if (/^(спасибо|благодар|мерси|thx|thanks|спс|пасиб)\b/.test(t)) return true;
    if (/^(ок|окей|ладно|понял|ясно|хорошо|отлично|супер|класс|круто|ага|угу|да|нет|не надо|не нужно|ну ок)\s*[.!]?$/i.test(t)) return true;
    if (/^(пока|спокойной|до завтра|good night|доброй ночи|сладких снов)\b/.test(t)) return true;
    if (/^(который час|сколько время|какой день|какое число)\s*\??$/i.test(t)) return true;
    if (/^(как дела|что нового|как ты)\s*\??$/i.test(t)) return true;
    return false;
}

const SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, '../core/prompts/jeeves-system-prompt.md'), 'utf-8'
);

function buildContext(chatId: string, senderId: string, messageLimit: number = 40) {
    const recentMessages = getRecentMessages(chatId, messageLimit);
    const resident = getResident(senderId);

    const name = resident?.nickname || resident?.display_name || resident?.username || 'Неизвестный';
    let residentContext = resident
        ? `Говорит: ${name} (tg_id: ${senderId}, роль: ${resident.role})`
        : `Говорит: неизвестный жилец (tg_id: ${senderId})`;

    if (resident?.habits) {
        residentContext += `\nПривычки: ${resident.habits}`;
    }

    // Build a tg_id → display name lookup for all residents
    const residentMap: Record<string, string> = {};
    for (const r of getAllResidents()) {
        residentMap[r.tg_id] = r.nickname || r.display_name || r.username || `User ${r.tg_id}`;
    }

    const memoryContext = getMemoryContext(senderId);

    const now = new Date();
    const dateStr = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: process.env.TZ || undefined });
    const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || undefined });
    const dateIT = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: process.env.TZ || undefined }); // для использования в запросах поиска

    // Build resident directory for the system prompt
    const residentDirectory = Object.entries(residentMap)
        .map(([tgId, displayName]) => `  ${displayName} (tg_id: ${tgId})`)
        .join('\n');

    const systemParts = [
        SYSTEM_PROMPT,
        `\n[КОНТЕКСТ]\nСейчас: ${dateStr}, ${timeStr}\nДата для поисковых запросов (итальянский): ${dateIT}\nChat: ${chatId}\n${residentContext}` +
        `\n\n[ЖИЛЬЦЫ ДОМА]\n${residentDirectory}\nВНИМАНИЕ: Обращай внимание на имя перед каждым сообщением в истории. НЕ ПУТАЙ жильцов! Каждый жилец — отдельная личность со своим именем.`,
    ];
    if (memoryContext) {
        systemParts.push(`\n${memoryContext}`);
    }

    const llmMessages: LLMMessage[] = [
        { role: 'system', content: systemParts.join('\n') }
    ];

    for (const msg of recentMessages) {
        if (msg.is_bot) {
            llmMessages.push({ role: 'assistant', content: msg.content });
        } else {
            // Prefix user messages with sender name so LLM knows who said what
            const senderName = msg.sender_tg_id
                ? (residentMap[msg.sender_tg_id] || (msg.sender_tg_id === 'system_cron' ? '[SYSTEM]' : `User ${msg.sender_tg_id}`))
                : 'Неизвестный';
            llmMessages.push({ role: 'user', content: `[${senderName}]: ${msg.content}` });
        }
    }

    return { llmMessages, systemPrompt: systemParts.join('\n') };
}

export async function handleButlerMessage(
    ctx: Context | null,
    chatId: string,
    senderId: string,
    text: string
) {
    const simple = isSimpleMessage(text);
    console.log(`[BUTLER] chat=${chatId}, sender=${senderId}, simple=${simple}`);

    let responseText: string;

    if (simple) {
        // Simple message → Ollama (free, fast), with Gemini fallback built-in
        const { llmMessages, systemPrompt } = buildContext(chatId, senderId, 15);
        const history = llmMessages
            .filter(m => m.role !== 'system')
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n');
        const prompt = history ? `${history}\nUser: ${text}` : text;

        const result = await processWithOllama(prompt, systemPrompt);
        responseText = result.text;
        logEvent('triage', { simple: true, ollama: result.fromOllama });
        console.log(`[BUTLER] Triage → ${result.fromOllama ? 'Ollama' : 'Gemini fallback'}: ${responseText?.substring(0, 80)}...`);
    } else {
        // Complex message → Gemini with tools
        const { llmMessages } = buildContext(chatId, senderId);
        const response = await processWithLLM(llmMessages, { chatId, userId: senderId });
        responseText = response.text;
        logEvent('triage', { simple: false, ollama: false });
        console.log(`[BUTLER] Triage → Gemini: ${responseText?.substring(0, 80)}...`);
    }

    if (responseText) {
        await sendMessageToChat(chatId, responseText);

        storeMessage({
            id: `bot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            chat_jid: chatId,
            sender_tg_id: 'jivs',
            content: responseText,
            timestamp: new Date().toISOString(),
            is_bot: 1
        });
    }
}

export async function handleButlerPhoto(
    ctx: Context,
    chatId: string,
    senderId: string,
    caption: string
) {
    const message = ctx.message as any;
    if (!message.photo || message.photo.length === 0) return;

    // Get the largest photo
    const photo = message.photo[message.photo.length - 1];

    try {
        // Download photo from Telegram
        const file = await bot.telegram.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${bot.telegram.token}/${file.file_path}`;

        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64Image = buffer.toString('base64');
        const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';

        const { systemPrompt } = buildContext(chatId, senderId);

        const userPrompt = caption
            ? `Жилец отправил фото с подписью: "${caption}". Проанализируй фото и ответь по делу.`
            : 'Жилец отправил фото без подписи. Опиши что видишь и предложи как это связано с квартирой (чистота, состояние, что нужно сделать).';

        const visionResponse = await processWithVision(systemPrompt, userPrompt, base64Image, mimeType);

        if (visionResponse.text) {
            await sendMessageToChat(chatId, visionResponse.text);

            storeMessage({
                id: `bot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                chat_jid: chatId,
                sender_tg_id: 'jivs',
                content: visionResponse.text,
                timestamp: new Date().toISOString(),
                is_bot: 1
            });
        }
    } catch (err: any) {
        console.error('[BUTLER] Photo processing error:', err.message);
        await sendMessageToChat(chatId, 'Не удалось обработать фото. Попробуй ещё раз.');
    }
}
