import { FunctionDeclaration } from '@google/genai';
import { SkillManifest } from './_types';
import { getDb } from '../db';
import cron from 'node-cron';

// All skills imported statically (reliable, no dynamic magic)
import shoppingSkill from './shopping.skill';
import cleaningSkill from './cleaning.skill';
import weatherSkill from './weather.skill';
import presenceSkill from './presence.skill';
import networkSkill from './network.skill';
import lightsSkill from './lights.skill';
import acControlSkill from './ac-control.skill';
import roomSensorSkill from './room-sensor.skill';
import memorySkill from './memory.skill';
import netDebugSkill from './net-debug.skill';
import opsSkill from './ops.skill';
import chefSkill from './chef.skill';
import todosSkill from './todos.skill';
import browsingSkill from './browsing.skill';
import webrunSkill from './webrun.skill';
import remindersSkill from './reminders.skill';

const ALL_SKILLS: SkillManifest[] = [
    shoppingSkill,
    cleaningSkill,
    weatherSkill,
    presenceSkill,
    networkSkill,
    lightsSkill,
    acControlSkill,
    roomSensorSkill,
    memorySkill,
    netDebugSkill,
    opsSkill,
    chefSkill,
    todosSkill,
    browsingSkill,
    webrunSkill,
    remindersSkill,
];

// Collected tools and handlers from all skills
let allTools: FunctionDeclaration[] = [];
let allHandlers: Record<string, (args: any, context?: { chatId: string, userId: string }) => Promise<string>> = {};

export function getRegisteredTools(): FunctionDeclaration[] {
    return allTools;
}

export function getRegisteredHandlers(): Record<string, (args: any, context?: { chatId: string, userId: string }) => Promise<string>> {
    return allHandlers;
}

export function getRegisteredSkills(): SkillManifest[] {
    return ALL_SKILLS;
}

export async function initAllSkills(): Promise<void> {
    console.log(`[REGISTRY] Initializing ${ALL_SKILLS.length} skills...`);

    for (const skill of ALL_SKILLS) {
        // 1. Run migrations
        if (skill.migrations) {
            const db = getDb();
            for (const sql of skill.migrations) {
                try {
                    db.exec(sql);
                } catch (e) {
                    // Ignore "already exists" errors
                }
            }
        }

        // 2. Collect tools
        allTools.push(...skill.tools);

        // 3. Collect handlers
        for (const [toolName, handler] of Object.entries(skill.handlers)) {
            if (allHandlers[toolName]) {
                console.warn(`[REGISTRY] Duplicate handler for tool "${toolName}" from skill "${skill.name}". Overwriting.`);
            }
            allHandlers[toolName] = handler;
        }

        // 4. Register cron jobs
        if (skill.crons) {
            for (const job of skill.crons) {
                cron.schedule(job.expression, async () => {
                    try {
                        await job.handler();
                    } catch (err) {
                        console.error(`[CRON] Error in ${skill.name}/${job.description}:`, err);
                    }
                }, { timezone: 'Europe/Rome' });
                console.log(`  [CRON] ${skill.name}: ${job.description} (${job.expression})`);
            }
        }

        // 5. Run skill init
        if (skill.init) {
            try {
                await skill.init();
            } catch (err) {
                console.error(`[REGISTRY] Failed to init skill "${skill.name}":`, err);
            }
        }

        console.log(`  [OK] ${skill.name} v${skill.version} — ${skill.tools.length} tools`);
    }

    console.log(`[REGISTRY] Total: ${allTools.length} tools, ${Object.keys(allHandlers).length} handlers`);
}
