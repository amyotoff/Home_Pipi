import { describe, it, expect } from 'vitest';

/**
 * Router logic tests.
 * Tests the pure functions used in router.ts without requiring Telegraf context.
 */

// Replicate the isEmotionalOrPersonal function from router.ts for unit testing
function isEmotionalOrPersonal(text: string): boolean {
    const t = text.toLowerCase();
    if (/(устал|вымотал|выдохся|нет сил|задолбал|бесит|злюсь|грустн|тоскл|скучн|одинок|тревожн|стресс|паник|нервнич|расстроен|обидн|раздража|не могу больше|сил нет|хреново|плохо себя|болит|заболе|температур|простуд|голова раскал|мигрень|тошнит)/i.test(t)) return true;
    if (/(ура!|получилось|наконец-то|вау|офигеть|круто!|победа|сдал|прошёл|прошел|повысил|приняли|оффер|предложили работу)/i.test(t)) return true;
    if (/(приехал|уехал|улетаю|вернулся|вернулась|гости придут|гости приед|день рождения|годовщин|юбилей|свадьб|новоселье)/i.test(t)) return true;
    if (/(обними|поддержи|что делать|как быть|не знаю что|посоветуй|помоги разобраться)/i.test(t)) return true;
    return false;
}

// Replicate trigger detection logic
function hasTriggerWord(text: string): boolean {
    return /(батлер|butler|jivs|дживс|jeeves|свет|ламп|включи|выключи|выкл|вкл|список|купить|покупк|купил|взял|надо\s|нужн|кончил|закончил|нет больше|докупи|забыл купить|уборк|кто дома|статус|температур|погод|пипи|pipi|бот|bot|охран|безопасн|стирк|отоплен|террас|балкон|стиралк|кондиц|фото|чист|грязн|устройств|девайс|сеть|сканир|определи|найди|провер|порт|ip|mac|ping|arp|dns|trace|еда|ужин|обед|завтрак|готовка|повар|кушать|аллерг|рецепт|меню|ингредиент|вкусн|ешь|эй|слушай|расскажи|подскажи|помоги|можешь|сделай|пожалуйста|найди|сравни|какой|почему|как\s|жарко|холодно|влажно|сухо|плесень|душно|замерз|замерзла)/i.test(text);
}

describe('Router — Emotional Detection', () => {
    it('should detect tiredness', () => {
        expect(isEmotionalOrPersonal('Устал как собака')).toBe(true);
        expect(isEmotionalOrPersonal('Сил нет вообще')).toBe(true);
    });

    it('should detect excitement', () => {
        expect(isEmotionalOrPersonal('Ура! Получилось!')).toBe(true);
        expect(isEmotionalOrPersonal('Мне предложили работу!')).toBe(true);
    });

    it('should detect life events', () => {
        expect(isEmotionalOrPersonal('Гости придут завтра')).toBe(true);
        expect(isEmotionalOrPersonal('У нас новоселье!')).toBe(true);
    });

    it('should detect calls for help', () => {
        expect(isEmotionalOrPersonal('Обними меня')).toBe(true);
        expect(isEmotionalOrPersonal('Что делать?')).toBe(true);
    });

    it('should NOT detect neutral messages', () => {
        expect(isEmotionalOrPersonal('Привет')).toBe(false);
        expect(isEmotionalOrPersonal('Окей')).toBe(false);
        expect(isEmotionalOrPersonal('Понял')).toBe(false);
    });
});

describe('Router — Trigger Words', () => {
    it('should detect butler name triggers', () => {
        expect(hasTriggerWord('Дживс, включи свет')).toBe(true);
        expect(hasTriggerWord('Hey Jeeves')).toBe(true);
        expect(hasTriggerWord('butler please help')).toBe(true);
    });

    it('should detect smart home triggers', () => {
        expect(hasTriggerWord('Включи лампу')).toBe(true);
        expect(hasTriggerWord('Какая температура?')).toBe(true);
        expect(hasTriggerWord('Кто дома?')).toBe(true);
    });

    it('should detect shopping triggers', () => {
        expect(hasTriggerWord('Надо купить молоко')).toBe(true);
        expect(hasTriggerWord('Забыл купить хлеб')).toBe(true);
    });

    it('should detect network triggers', () => {
        expect(hasTriggerWord('Сканируй сеть')).toBe(true);
        expect(hasTriggerWord('ping 192.168.1.1')).toBe(true);
    });

    it('should detect polite requests', () => {
        expect(hasTriggerWord('Помоги мне пожалуйста')).toBe(true);
        expect(hasTriggerWord('Подскажи рецепт')).toBe(true);
    });

    it('should NOT trigger on random conversation', () => {
        expect(hasTriggerWord('Я вчера был в кино')).toBe(false);
        expect(hasTriggerWord('Отличный фильм')).toBe(false);
    });
});

describe('Router — Access Control logic', () => {
    it('should identify owner from set', () => {
        const ownerIds = new Set(['111', '222']);
        expect(ownerIds.has('111')).toBe(true);  // Alice is owner
        expect(ownerIds.has('222')).toBe(true);  // Bob is owner
        expect(ownerIds.has('999')).toBe(false); // Stranger is not
    });

    it('should allow all when owner set is empty', () => {
        const ownerIds = new Set<string>();
        // Empty set means no restrictions (matches isOwner logic)
        const isOwner = (id: string) => ownerIds.size === 0 || ownerIds.has(id);
        expect(isOwner('anyone')).toBe(true);
    });
});

describe('Router — Reply Context', () => {
    it('should format reply context correctly', () => {
        const replyAuthor = 'Alice';
        const replyText = 'Купи молоко';
        const userText = 'Хорошо, куплю';

        const snippet = replyText.length > 150 ? replyText.substring(0, 150) + '...' : replyText;
        const finalContent = `[В ответ на сообщение от ${replyAuthor}: "${snippet}"]\n${userText}`;

        expect(finalContent).toContain('В ответ на сообщение от Alice');
        expect(finalContent).toContain('Купи молоко');
        expect(finalContent).toContain('Хорошо, куплю');
    });

    it('should trim long reply context', () => {
        const longText = 'A'.repeat(200);
        const snippet = longText.length > 150 ? longText.substring(0, 150) + '...' : longText;
        expect(snippet.length).toBe(153); // 150 + '...'
    });
});
