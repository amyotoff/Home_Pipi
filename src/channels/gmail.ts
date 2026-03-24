/**
 * Gmail channel — outbound email via SMTP (nodemailer).
 *
 * Self-registers when CONCIERGE_SMTP_HOST and CONCIERGE_SMTP_USER are set.
 * Wraps existing nodemailer logic from concierge.skill.ts into the channel interface.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { OutboundChannel, SendResult, MessageOptions } from './_types';
import { registerChannel } from './_registry';

class GmailChannel implements OutboundChannel {
    readonly type = 'gmail' as const;
    private transporter: Transporter | null = null;
    private connected = false;

    async connect(): Promise<void> {
        const host = process.env.CONCIERGE_SMTP_HOST;
        const user = process.env.CONCIERGE_SMTP_USER;
        const pass = process.env.CONCIERGE_SMTP_PASS;

        if (!host || !user || !pass) {
            throw new Error('SMTP not configured: set CONCIERGE_SMTP_HOST, _USER, _PASS');
        }

        this.transporter = nodemailer.createTransport({
            host,
            port: parseInt(process.env.CONCIERGE_SMTP_PORT || '587'),
            secure: false,
            auth: { user, pass },
        });

        // Verify connection
        try {
            await this.transporter.verify();
            this.connected = true;
        } catch (err: any) {
            // SMTP verify may fail in some environments but sending still works
            console.warn(`[GMAIL] SMTP verify warning: ${err.message} — will try sending anyway`);
            this.connected = true;
        }
    }

    async disconnect(): Promise<void> {
        if (this.transporter) {
            this.transporter.close();
            this.transporter = null;
        }
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected && this.transporter !== null;
    }

    async sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult> {
        if (!this.isConnected() || !this.transporter) {
            return { success: false, error: 'SMTP not connected' };
        }

        const fromName = process.env.CONCIERGE_FROM_NAME || 'PiPi Bot';
        const fromAddr = process.env.CONCIERGE_SMTP_USER!;

        try {
            const info = await this.transporter.sendMail({
                from: `"${fromName}" <${fromAddr}>`,
                to,
                subject: opts?.subject || 'Service Request',
                text,
            });

            return { success: true, messageId: info.messageId };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    // TODO: IMAP polling for inbound replies (deferred)
}

// ==========================================
// Self-registration
// ==========================================

if (process.env.CONCIERGE_SMTP_HOST && process.env.CONCIERGE_SMTP_USER) {
    registerChannel('gmail', () => new GmailChannel());
}
