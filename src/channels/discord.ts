/**
 * Discord channel — notifications to household Discord server.
 *
 * Self-registers when DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are set.
 * Outbound-only: sends service updates, appointment reminders, escalations.
 */

import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { OutboundChannel, SendResult, MessageOptions } from './_types';
import { registerChannel } from './_registry';

class DiscordChannel implements OutboundChannel {
    readonly type = 'discord' as const;
    private client: Client;
    private channelId: string;
    private connected = false;

    constructor() {
        this.channelId = process.env.DISCORD_CHANNEL_ID || '';
        this.client = new Client({
            intents: [GatewayIntentBits.Guilds],
        });
    }

    async connect(): Promise<void> {
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) throw new Error('DISCORD_BOT_TOKEN not set');
        if (!this.channelId) throw new Error('DISCORD_CHANNEL_ID not set');

        await this.client.login(token);

        await new Promise<void>((resolve) => {
            this.client.once('ready', () => {
                this.connected = true;
                console.log(`[DISCORD] Logged in as ${this.client.user?.tag}`);
                resolve();
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.destroy();
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected && this.client.isReady();
    }

    async sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult> {
        // `to` can be a channel ID override, or we use the default channel
        const targetId = to || this.channelId;

        if (!this.isConnected()) {
            return { success: false, error: 'Discord not connected' };
        }

        try {
            const channel = await this.client.channels.fetch(targetId);
            if (!channel || !channel.isTextBased()) {
                return { success: false, error: `Channel ${targetId} not found or not text-based` };
            }

            const sent = await (channel as TextChannel).send(text);
            return { success: true, messageId: sent.id };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // Discord is notification-only, no onReply needed
}

// ==========================================
// Self-registration
// ==========================================

if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID) {
    registerChannel('discord', () => new DiscordChannel());
}
