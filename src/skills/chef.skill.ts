import { Type } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb, getResident } from '../db';

const skill: SkillManifest = {
    name: 'chef',
    description: 'Личный шеф-повар (Джейми Оливер): советы по еде, рецепты, учет аллергий и планирование покупок',
    version: '1.0.0',
    tools: [
        {
            name: 'chef_suggest_meal',
            description: 'Propose meal ideas (breakfast, lunch, dinner) based on available ingredients and dietary restrictions. Be energetic and "Jamie Oliver" style - use words like "pukka", "lovely", "brilliant". Ask for missing details like people count if unknown.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    meal_type: { type: Type.STRING, description: 'Type of meal: breakfast, lunch, dinner, snack.' },
                    ingredients: { type: Type.STRING, description: 'List of available ingredients.' },
                    people_count: { type: Type.INTEGER, description: 'Number of people to cook for.' }
                },
                required: ['meal_type'],
            }
        },
        {
            name: 'chef_set_dietary',
            description: 'Set an allergy or specific food preference for a resident. Use for: allergies, vegan, keto, no-gluten, etc.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tg_id: { type: Type.STRING, description: 'Telegram ID of the resident.' },
                    type: { type: Type.STRING, enum: ['allergy', 'preference'], description: 'Type of record.' },
                    fact: { type: Type.STRING, description: 'The dietary fact, e.g. "allergic to nuts", "vegetarian".' }
                },
                required: ['tg_id', 'type', 'fact'],
            }
        },
        {
            name: 'chef_get_dietary',
            description: 'Get dietary information (allergies and preferences) for all or specific residents.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    tg_id: { type: Type.STRING, description: 'Optional Telegram ID.' }
                }
            }
        },
        {
            name: 'chef_add_to_shopping_list',
            description: 'Add specific ingredients for a meal to the household shopping list.',
            parameters: {
                type: Type.OBJECT,
                properties: {
                    ingredients: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of ingredients to buy.' }
                },
                required: ['ingredients'],
            }
        },
    ],
    handlers: {
        async chef_suggest_meal(args: { meal_type: string; ingredients?: string; people_count?: number }) {
            // This tool is mainly a trigger for the LLM to generate a recipe in character.
            // We just provide the context and let the LLM do the "Oliver" magic in the response.
            let context = `[CHEF_MODE] Оливер стайл! Планируем ${args.meal_type}.`;
            if (args.ingredients) context += ` В наличии: ${args.ingredients}.`;
            if (args.people_count) context += ` На ${args.people_count} чел.`;

            return `[TOOL_RESULT] ${context} Давай придумаем что-то по-настоящему pukka!`;
        },

        async chef_set_dietary(args: { tg_id: string; type: string; fact: string }) {
            const resident = getResident(args.tg_id);
            if (!resident) return `[TOOL_RESULT] Resident ${args.tg_id} not found.`;

            const db = getDb();
            const now = new Date().toISOString();
            db.prepare(
                "INSERT INTO resident_notes (resident_tg_id, resident_name, fact, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'conversation', ?, ?)"
            ).run(args.tg_id, resident.nickname || resident.display_name, args.fact, args.type, now, now);

            return `[TOOL_RESULT] Brilliant! Записал ${args.type} для ${resident.nickname || resident.display_name}: ${args.fact}.`;
        },

        async chef_get_dietary(args: { tg_id?: string }) {
            const db = getDb();
            let query = "SELECT resident_name, fact, category FROM resident_notes WHERE category IN ('allergy', 'preference')";
            const params: any[] = [];

            if (args.tg_id) {
                query += " AND resident_tg_id = ?";
                params.push(args.tg_id);
            }

            query += " ORDER BY resident_name";
            const notes = db.prepare(query).all(...params) as any[];

            if (notes.length === 0) return "[TOOL_RESULT] No dietary restrictions or preferences found. Pukka!";

            const lines = notes.map(n => `- ${n.resident_name}: ${n.fact} (${n.category})`);
            return `[TOOL_RESULT] Вот что я знаю о вкусах резидентов:\n${lines.join('\n')}`;
        },

        async chef_add_to_shopping_list(args: { ingredients: string[] }) {
            const db = getDb();
            const now = new Date().toISOString();
            for (const item of args.ingredients) {
                db.prepare('INSERT INTO shopping_list (item, added_at) VALUES (?, ?)').run(item, now);
            }
            return `[TOOL_RESULT] Добавлено в список покупок: ${args.ingredients.join(', ')}. Lovely jubbly!`;
        }
    }
};

export default skill;
