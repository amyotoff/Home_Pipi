import { FunctionDeclaration } from '@google/genai';

export interface CronJob {
    expression: string;
    handler: () => Promise<void>;
    description: string;
}

export interface SkillManifest {
    name: string;
    description: string;
    version: string;
    tools: FunctionDeclaration[];
    handlers: Record<string, (args: any, context?: { chatId: string, userId: string }) => Promise<string>>;
    crons?: CronJob[];
    migrations?: string[];
    init?: () => Promise<void>;
}
