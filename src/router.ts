import { Context } from 'telegraf';
import { storeMessage, upsertChat, getChat, getResident, upsertResident } from './db';
import { handleButlerMessage, handleButlerPhoto } from './agents/butler';
import { isHouseholdChat, isOwner } from './config';

const groupMessageCounters: Record<string, number> = {};

/** Detect messages that express emotion, mood, or personal context worth noticing */
function isEmotionalOrPersonal(text: string): boolean {
    const t = text.toLowerCase();
    // Mood / feelings / state
    if (/(устал|вымотал|выдохся|нет сил|задолбал|бесит|злюсь|грустн|тоскл|скучн|одинок|тревожн|стресс|паник|нервнич|расстроен|обидн|раздража|не могу больше|сил нет|хреново|плохо себя|болит|заболе|температур|простуд|голова раскал|мигрень|тошнит)/i.test(t)) return true;
    // Excitement / celebration
    if (/(ура!|получилось|наконец-то|вау|офигеть|круто!|победа|сдал|прошёл|прошел|повысил|приняли|оффер|предложили работу)/i.test(t)) return true;
    // Life events
    if (/(приехал|уехал|улетаю|вернулся|вернулась|гости придут|гости приед|день рождения|годовщин|юбилей|свадьб|новоселье)/i.test(t)) return true;
    // Asking for comfort / help
    if (/(обними|поддержи|что делать|как быть|не знаю что|посоветуй|помоги разобраться)/i.test(t)) return true;
    return false;
}

export async function handleIncomingMessage(ctx: Context) {
    const message = ctx.message;
    if (!message) return;

    const chatId = ctx.chat?.id.toString();
    const senderId = ctx.from?.id.toString();
    const chatType = ctx.chat?.type;
    const botUsername = ctx.botInfo?.username;

    console.log(`[ROUTER] Incoming: chat=${chatId} (${chatType}), sender=${senderId}, text="${(message as any).text || ''}"`);

    if (!chatId || !senderId || !chatType) return;

    const isPrivate = chatType === 'private';
    const isHousehold = !isPrivate && isHouseholdChat(chatId);

    // 0. Access control — only owners can use the bot
    if (!isOwner(senderId)) {
        console.warn(`[ROUTER] Ignored: sender ${senderId} is not an owner.`);
        if (isPrivate) {
            await ctx.reply('Извини, я работаю только с жильцами этой квартиры.');
        }
        return;
    }

    // 1. Ensure chat is tracked
    let chat = getChat(chatId);
    if (!chat) {
        upsertChat({
            jid: chatId,
            type: isPrivate ? 'private' : 'household_group',
            status: 'ACTIVE'
        });
    }

    // 2. Auto-register resident
    const resident = getResident(senderId);
    if (!resident) {
        upsertResident({
            tg_id: senderId,
            username: ctx.from?.username || null,
            display_name: ctx.from?.first_name || null,
        });
    }

    // Determine message type
    const hasText = 'text' in message;
    const hasPhoto = 'photo' in message;
    const text = hasText ? (message as any).text : (message as any).caption || '';

    // 3. Extract reply context if user is replying to a specific message
    const replyTo = (message as any).reply_to_message;
    let finalContent = text;
    if (replyTo && ('text' in replyTo || 'caption' in replyTo)) {
        const replyText = replyTo.text || replyTo.caption || '';
        const replyAuthor = replyTo.from?.first_name || replyTo.from?.username || 'Кто-то';
        if (replyText) {
            // Trim to avoid absurdly long context blocks
            let snippet = replyText.length > 150 ? replyText.substring(0, 150) + '...' : replyText;
            finalContent = `[В ответ на сообщение от ${replyAuthor}: "${snippet}"]\n${text}`;
            console.log(`[ROUTER] Injected reply context: to ${replyAuthor}`);
        }
    }

    // 4. Store message
    storeMessage({
        id: `${chatId}_${message.message_id}`,
        chat_jid: chatId,
        sender_tg_id: senderId,
        content: hasPhoto ? `[ФОТО] ${finalContent}` : finalContent,
        timestamp: new Date().toISOString(),
        is_bot: 0
    });

    // 5. Handle photo messages
    if (hasPhoto) {
        if (isPrivate || isHousehold) {
            await handleButlerPhoto(ctx, chatId, senderId, finalContent);
        }
        return;
    }

    // 6. Skip non-text messages
    if (!hasText) return;

    // 7. Route text messages
    if (isPrivate) {
        // DMs always go to Butler
        await handleButlerMessage(ctx, chatId, senderId, finalContent);

    } else if (isHousehold) {
        // Group: wake Butler on triggers
        const isMentioned = botUsername && text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
        const replyFrom = (message as any).reply_to_message?.from;
        const isReplyToBot = !!(replyFrom && (
            replyFrom.username === botUsername ||
            replyFrom.id === ctx.botInfo?.id ||
            replyFrom.is_bot
        ));
        const hasTrigger = /(батлер|butler|jivs|дживс|jeeves|свет|ламп|включи|выключи|выкл|вкл|список|купить|покупк|купил|взял|надо\s|нужн|кончил|закончил|нет больше|докупи|забыл купить|уборк|кто дома|статус|температур|погод|пипи|pipi|бот|bot|охран|безопасн|стирк|отоплен|террас|балкон|стиралк|кондиц|фото|чист|грязн|устройств|девайс|сеть|сканир|определи|найди|провер|порт|ip|mac|ping|arp|dns|trace|еда|ужин|обед|завтрак|готовка|повар|кушать|аллерг|рецепт|меню|ингредиент|вкусн|ешь|эй|слушай|расскажи|подскажи|помоги|можешь|сделай|пожалуйста|найди|сравни|какой|почему|как\s|жарко|холодно|влажно|сухо|плесень|душно|замерз|замерзла)/i.test(text);
        const isQuestion = /\?/.test(text);

        const isEmotional = isEmotionalOrPersonal(text);

        if (!groupMessageCounters[chatId]) groupMessageCounters[chatId] = 0;
        groupMessageCounters[chatId]++;
        const isPassive = groupMessageCounters[chatId] >= 5;
        if (isPassive) groupMessageCounters[chatId] = 0;

        if (isMentioned || isReplyToBot || hasTrigger || isQuestion || isEmotional || isPassive) {
            await handleButlerMessage(ctx, chatId, senderId, finalContent);
        }
    }
    // Unknown groups — silently ignore
}
