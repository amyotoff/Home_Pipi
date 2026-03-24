import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { GEMINI_API_KEY, OLLAMA_URL, OLLAMA_MODEL } from '../config';
import { getRegisteredTools, getRegisteredHandlers } from '../skills/_registry';
import { logEvent, logTokenUsage, getDailyTokenCost } from '../db';
import { notifyHousehold, sendTypingAction, sendMessageToChat } from '../channels/telegram';
import { guardLLMCall, reportGeminiResult, isOllamaHealthy } from './healthcheck';

// Tools that take a long time and warrant a "working on it" heads-up
const LONG_RUNNING_TOOLS = new Set([
    'groceries_search', 'browse_web', 'webrun_execute',
    'network_scan_devices', 'network_full_scan',
]);

const LONG_TASK_MESSAGES = [
    '🔍 Сейчас посмотрю, секунду...',
    '⏳ Работаю над этим...',
    '🔎 Ищу информацию, подождите...',
    '⚙️ Выполняю запрос...',
];

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// Meta-tools that live outside the skill system
const REQUEST_NEW_SKILL_TOOL: FunctionDeclaration = {
    name: 'request_new_skill',
    description: 'Use when you cannot fulfill a request with your current skills. Log a request to the Atelier for a new capability. Actively suggest this when users ask for unsupported things. Be sure to note if extra IoT hardware is needed. IMPORTANT: derive skill_name directly from the user\'s own wording — do NOT invent a different category or rename the concept. If the user says "напитки и коктейли" → skill_name should be "drinks_and_cocktails", not some unrelated umbrella term.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            skill_name: { type: Type.STRING, description: 'Short snake_case ID derived from user\'s own words (e.g. if user says "отследи посылку" → package_tracker, "включи музыку" → music_control). MUST reflect the user\'s intent, not your interpretation.' },
            user_title: { type: Type.STRING, description: 'Human-readable title of the skill IN THE USER\'S OWN WORDS (e.g. "Отслеживание посылок", "Управление музыкой"). Copy the user\'s phrasing as closely as possible.' },
            description: { type: Type.STRING, description: 'What this skill should do and why it is needed. Be specific about capabilities.' },
            user_request: { type: Type.STRING, description: 'The original user message (verbatim quote) that triggered this request.' },
            hardware_needed: { type: Type.STRING, description: 'Any required IoT hardware (sensors, relays, cameras) needed to make this work. Leave empty if purely software.' }
        },
        required: ['skill_name', 'user_title', 'description', 'user_request'],
    }
};

const LIST_SKILLS_TOOL: FunctionDeclaration = {
    name: 'list_skills',
    description: 'List all currently loaded skills and their capabilities.',
    parameters: { type: Type.OBJECT, properties: {} }
};

const CLEAR_SKILL_REQUESTS_TOOL: FunctionDeclaration = {
    name: 'clear_skill_requests',
    description: 'Очистить историю запросов в Ателье. Используй, когда пользователь просит "очистить запросы", "удали запросы навыков" и т.д.',
    parameters: { type: Type.OBJECT, properties: {} }
};

function handleMetaTool(callName: string, args: any): string | null {
    if (callName === 'request_new_skill') {
        const { getDb } = require('../db');
        const db = getDb();
        const hw = args.hardware_needed || '';
        const titleText = args.user_title ? `[${args.user_title}] ` : '';
        const hwText = hw ? `[Нужно железо: ${hw}] ` : '';
        const fullDesc = titleText + hwText + args.description;
        const priority = hw ? 'low' : 'normal';
        const requestedBy = args.requested_by || 'unknown';

        // Deduplication: check if a pending/in_progress request with same skill_name exists
        const existing = db.prepare(
            "SELECT * FROM skill_requests WHERE skill_name = ? AND status IN ('pending', 'in_progress') LIMIT 1"
        ).get(args.skill_name) as any;

        if (existing) {
            const votersList = existing.voters ? existing.voters.split(',') : [];
            if (!votersList.includes(requestedBy)) {
                votersList.push(requestedBy);
            }
            const newVotes = (existing.votes || 1) + 1;
            const appendedDesc = existing.description + `\n---\nДоп. запрос: "${args.user_request}"`;
            db.prepare(
                "UPDATE skill_requests SET votes = ?, voters = ?, description = ? WHERE id = ?"
            ).run(newVotes, votersList.join(','), appendedDesc, existing.id);
            return `Голос добавлен к запросу "${args.user_title || args.skill_name}" (теперь ${newVotes} голос(ов)).`;
        }

        // New request
        db.prepare(`
            INSERT INTO skill_requests (skill_name, description, requested_by, user_request, status, created_at, votes, voters, hardware_needed, priority)
            VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?)
        `).run(args.skill_name, fullDesc, requestedBy, args.user_request, new Date().toISOString(), requestedBy, hw, priority);

        // Auto-add hardware to shopping list
        if (hw) {
            try {
                const { getRegisteredHandlers } = require('../skills/_registry');
                const handlers = getRegisteredHandlers();
                if (handlers.shopping_add) {
                    handlers.shopping_add({ items: [`[Ателье] ${hw}`] });
                }
            } catch (e) {
                console.warn('[ATELIER] Failed to auto-add hardware to shopping:', e);
            }
        }

        const hwNote = hw ? ` Железо (${hw}) добавлено в список покупок.` : '';
        return `Запрос на навык "${args.user_title || args.skill_name}" направлен в Ателье.${hwNote}`;
    }
    if (callName === 'list_skills') {
        const { getRegisteredSkills } = require('../skills/_registry');
        const skills = getRegisteredSkills();
        return skills.map((s: any) => `${s.name} v${s.version}: ${s.description} (${s.tools.length} tools)`).join('\n');
    }
    if (callName === 'clear_skill_requests') {
        const { getDb } = require('../db');
        const result = getDb().prepare(`
            UPDATE skill_requests SET status = 'cleared' WHERE status = 'pending'
        `).run();
        return `Запросы в Ателье очищены (затронуто: ${result.changes}).`;
    }
    return null;
}

// Offline fallback — lights only (the one thing that works without LLM)
function tryOfflineFallback(text: string): string | null {
    const t = text.toLowerCase();
    const { getRegisteredHandlers } = require('../skills/_registry');
    const h = getRegisteredHandlers();

    if (/включи\s*(свет|ламп|всё)|свет\s*вкл/i.test(t) && h.lights_on) {
        h.lights_on({ light_name: 'all', brightness: 100 });
        return 'Включаю весь свет. (офлайн-режим)';
    }
    if (/выключи\s*(свет|ламп|всё)|свет\s*выкл/i.test(t) && h.lights_off) {
        h.lights_off({ light_name: 'all' });
        return 'Выключаю свет. (офлайн-режим)';
    }

    return null;
}

export async function processWithLLM(
    messages: LLMMessage[],
    context: { chatId: string, userId: string }
): Promise<{ text: string }> {
    console.log(`[LLM] processWithLLM called, ${messages.length} messages`);
    // Kill switch / rate guard
    const blocked = guardLLMCall();
    if (blocked) {
        console.warn(`[LLM] Blocked by guard: ${blocked}`);
        const userText = messages.filter(m => m.role === 'user').pop()?.content || '';
        const offline = tryOfflineFallback(userText);
        if (offline) return { text: offline };
        return { text: '' }; // Suppressed error
    }

    try {
        const systemInstruction = messages.find(m => m.role === 'system')?.content;

        // Build conversation history, merging consecutive same-role messages
        // (Gemini API requires strict user/model alternation)
        const rawHistory = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const conversationHistory: any[] = [];
        for (const msg of rawHistory) {
            const last = conversationHistory[conversationHistory.length - 1];
            if (last && last.role === msg.role) {
                last.parts.push({ text: msg.parts[0].text });
            } else {
                conversationHistory.push({ role: msg.role, parts: [...msg.parts] });
            }
        }

        if (conversationHistory.length === 0) {
            conversationHistory.push({ role: 'user', parts: [{ text: 'Start.' }] });
        }

        // Collect all tools: skills + meta
        const skillTools = getRegisteredTools();
        const allTools = [...skillTools, REQUEST_NEW_SKILL_TOOL, LIST_SKILLS_TOOL, CLEAR_SKILL_REQUESTS_TOOL];

        const baseConfig: any = {
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
            tools: [{ functionDeclarations: allTools }],
            temperature: 0.7,
        };

        const callGemini = async (modelToUse: string, contents: any[], extraConfig?: any) => {
            const mergedConfig = extraConfig ? { ...baseConfig, ...extraConfig } : baseConfig;

            const requestPromise = ai.models.generateContent({
                model: modelToUse,
                contents,
                config: mergedConfig,
            });

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`[TIMEOUT] ${modelToUse} did not respond within 45s`)), 45000)
            );

            return await Promise.race([requestPromise, timeoutPromise]);
        };

        // Attempts: model + optional config overrides
        // gemini-2.5-flash is a "thinking" model — first try with thinking, then without
        const attempts = [
            { model: 'gemini-2.5-flash', label: '2.5-flash' },
            { model: 'gemini-2.5-flash', label: '2.5-flash-nothink', extra: { thinkingConfig: { thinkingBudget: 0 } } },
        ];

        let response: any = null;
        let lastError: any = null;
        let usedModel = attempts[0].model;

        const isEmptyResponse = (resp: any): boolean => {
            if (!resp) return true;
            try {
                const hasText = !!resp.text;
                const hasTools = resp.functionCalls && resp.functionCalls.length > 0;
                if (!hasText && !hasTools) {
                    const parts = resp.candidates?.[0]?.content?.parts;
                    console.log(`[LLM] Empty response parts: ${JSON.stringify(parts)?.substring(0, 200) || 'none'}`);
                    return true;
                }
                return false;
            } catch {
                return true;
            }
        };

        for (const att of attempts) {
            try {
                const candidate: any = await callGemini(att.model, conversationHistory, att.extra);

                if (isEmptyResponse(candidate)) {
                    console.warn(`[LLM] Empty response from ${att.label}, finishReason=${candidate?.candidates?.[0]?.finishReason || 'N/A'}`);
                    continue;
                }

                response = candidate;
                usedModel = att.model;
                console.log(`[LLM] Got response from ${att.label}`);
                break;
            } catch (err: any) {
                lastError = err;
                const isRateLimit = err.status === 429 || err.message?.includes('429');

                if (isRateLimit) {
                    const delay = 2000 + Math.random() * 1000;
                    console.warn(`[LLM] Rate limit on ${att.label}, waiting ${Math.round(delay)}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                console.warn(`[LLM] ${att.label} failed: ${err.message}`);
            }
        }

        if (!response) {
            console.error('[LLM] All Gemini attempts exhausted.', lastError);
            reportGeminiResult(false);

            // Ollama fallback — text-only, no tool calls
            if (isOllamaHealthy()) {
                try {
                    console.log(`[LLM] Trying Ollama fallback (${OLLAMA_MODEL})...`);
                    const ollamaPrompt = [
                        systemInstruction || '',
                        ...messages.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
                    ].join('\n');

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 30000);

                    const ollamaRes = await fetch(`${OLLAMA_URL}/api/generate`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: OLLAMA_MODEL,
                            prompt: ollamaPrompt,
                            stream: false,
                        }),
                        signal: controller.signal,
                    });
                    clearTimeout(timeout);

                    if (ollamaRes.ok) {
                        const ollamaData = await ollamaRes.json();
                        const ollamaText = ollamaData.response?.trim();
                        if (ollamaText) {
                            console.log(`[LLM] Ollama responded: ${ollamaText.substring(0, 80)}...`);
                            logTokenUsage(OLLAMA_MODEL, ollamaData.prompt_eval_count || 0, ollamaData.eval_count || 0);
                            return { text: ollamaText };
                        }
                    }
                    console.warn(`[LLM] Ollama returned empty or error: ${ollamaRes.status}`);
                } catch (ollamaErr: any) {
                    console.error(`[LLM] Ollama fallback failed: ${ollamaErr.message}`);
                }
            }

            const userText = messages.filter(m => m.role === 'user').pop()?.content || '';
            const offline = tryOfflineFallback(userText);
            if (offline) return { text: offline };
            return { text: '' }; // Suppressed error
        }

        reportGeminiResult(true);
        try {
            console.log(`[LLM] Gemini raw: text=${!!response.text}, tools=${response.functionCalls?.length || 0}, finishReason=${response.candidates?.[0]?.finishReason || 'N/A'}`);
            console.log(`[LLM] Gemini content: ${JSON.stringify(response.candidates?.[0]?.content)?.substring(0, 300)}`);
        } catch (logErr: any) {
            console.log(`[LLM] Gemini raw log error: ${logErr.message}`);
            console.log(`[LLM] Gemini candidates: ${JSON.stringify(response.candidates)?.substring(0, 300)}`);
        }

        // Track token usage
        const trackTokens = (resp: any) => {
            const inputTokens = resp.usageMetadata?.promptTokenCount || 0;
            const outputTokens = resp.usageMetadata?.candidatesTokenCount || 0;
            if (inputTokens > 0 || outputTokens > 0) {
                logTokenUsage(usedModel, inputTokens, outputTokens);
            }
        };

        trackTokens(response);

        // Tool call loop: execute tools → send results back to Gemini → repeat (max 3 rounds)
        const handlers = getRegisteredHandlers();
        const MAX_TOOL_ROUNDS = 3;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (!response.functionCalls || response.functionCalls.length === 0) break;

            console.log(`[LLM] Tool round ${round + 1}: ${response.functionCalls.map((c: any) => c.name).join(', ')}`);

            // Execute all tool calls and collect results
            const functionResponseParts: any[] = [];

            // UX: Send a "working on it" message for long-running tools
            const hasLongTool = response.functionCalls.some((c: any) => LONG_RUNNING_TOOLS.has(c.name));
            if (hasLongTool) {
                const msg = LONG_TASK_MESSAGES[Math.floor(Math.random() * LONG_TASK_MESSAGES.length)];
                try {
                    await sendTypingAction(context.chatId);
                    await sendMessageToChat(context.chatId, msg);
                } catch (e) {
                    // Non-critical, don't crash if notification fails
                }
            }

            for (const call of response.functionCalls) {
                const callStart = Date.now();
                let result: string;

                try {
                    // Try meta-tools first
                    const metaResult = handleMetaTool(call.name, call.args);
                    if (metaResult !== null) {
                        result = metaResult;
                        logEvent('tool_call', { tool: call.name, args: call.args, duration_ms: Date.now() - callStart, ok: true });
                    } else {
                        const handler = handlers[call.name];
                        if (handler) {
                            result = await handler(call.args || {}, context);
                            logEvent('tool_call', { tool: call.name, args: call.args, duration_ms: Date.now() - callStart, ok: true });
                        } else {
                            result = `No handler found for tool "${call.name}"`;
                            console.warn(`[LLM] No handler for tool "${call.name}"`);
                            logEvent('tool_call', { tool: call.name, error: 'no handler' });
                        }
                    }
                } catch (err: any) {
                    result = `Error executing "${call.name}": ${err.message}`;
                    console.error(`[LLM] Tool "${call.name}" execution error:`, err.message);
                    logEvent('tool_call', { tool: call.name, args: call.args, duration_ms: Date.now() - callStart, ok: false, error: err.message });
                }

                functionResponseParts.push({
                    functionResponse: {
                        name: call.name,
                        response: { content: result }
                    }
                });
            }

            // Add model's function call turn + our function response turn to history
            conversationHistory.push({
                role: 'model',
                parts: response.functionCalls.map((c: any) => ({
                    functionCall: { name: c.name, args: c.args }
                }))
            });

            conversationHistory.push({
                role: 'user',
                parts: functionResponseParts
            });

            // Call Gemini again with function results
            try {
                response = await callGemini(usedModel, conversationHistory);
                trackTokens(response);
            } catch (err: any) {
                console.error(`[LLM] Follow-up call failed: ${err.message}`);
                // Fallback: return the raw tool results
                const fallbackText = functionResponseParts
                    .map(p => p.functionResponse.response.content)
                    .join('\n');
                return { text: fallbackText };
            }
        }

        const textResponse = response.text || '';

        // Check daily cost and warn
        const dailyCost = getDailyTokenCost();
        if (dailyCost.cost_usd >= 1.80 && dailyCost.cost_usd < 2.00) {
            setTimeout(() => {
                notifyHousehold(`Кстати, сегодня уже $${dailyCost.cost_usd.toFixed(2)} потратил на разговоры. Если так пойдёт, дойдём до $2 — буду вынужден намекнуть на экономию.`);
            }, 2000);
        } else if (dailyCost.cost_usd >= 2.00) {
            setTimeout(() => {
                notifyHousehold(`Всё, господа. $2 потрачено. Больше не разговариваю сегодня. Шучу. Но если серьёзно — может стоит притормозить?`);
            }, 2000);
        }

        return { text: textResponse };
    } catch (error) {
        console.error('Gemini LLM Error:', error);
        return { text: '' }; // Suppressed error
    }
}

export async function processWithVision(
    systemPrompt: string,
    userPrompt: string,
    base64Image: string,
    mimeType: string = 'image/jpeg'
): Promise<{ text: string }> {
    try {
        logEvent('tool_call', { tool: 'vision_analyze', ok: true });

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{
                role: 'user',
                parts: [
                    { inlineData: { data: base64Image, mimeType } },
                    { text: userPrompt }
                ]
            }],
            config: {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                temperature: 0.7,
            }
        });

        return { text: response.text || '' }; // Suppressed fallback
    } catch (error: any) {
        console.error('[VISION] Error:', error.message);
        logEvent('tool_call', { tool: 'vision_analyze', ok: false, error: error.message });
        return { text: '' }; // Suppressed error
    }
}
