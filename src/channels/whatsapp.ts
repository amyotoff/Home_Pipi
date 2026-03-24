/**
 * WhatsApp channel via Baileys (native WhatsApp Web protocol).
 *
 * Self-registers when WHATSAPP_ENABLED=true.
 * Auth credentials stored in DATA_DIR/whatsapp-auth/.
 * No browser needed — saves ~200-400MB RAM vs Playwright on RPi4.
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    WASocket,
    proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import fs from 'fs';
import { OutboundChannel, SendResult, MessageOptions, ReplyHandler } from './_types';
import { registerChannel } from './_registry';
import { DATA_DIR } from '../config';

const AUTH_DIR = path.join(DATA_DIR, 'whatsapp-auth');

class WhatsAppChannel implements OutboundChannel {
    readonly type = 'whatsapp' as const;
    private sock: WASocket | null = null;
    private connected = false;
    private replyHandler: ReplyHandler | null = null;
    private sentTo = new Set<string>(); // track JIDs we've messaged (for reply filtering)

    async connect(): Promise<void> {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        this.sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // Lightweight mode for RPi4
            browser: ['PiPi Bot', 'Chrome', '120.0'],
        });

        // Persist auth state on every update
        this.sock.ev.on('creds.update', saveCreds);

        // Connection status
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[WHATSAPP] Scan QR code above to authenticate');
            }

            if (connection === 'open') {
                this.connected = true;
                console.log('[WHATSAPP] Connected');
            }

            if (connection === 'close') {
                this.connected = false;
                const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

                if (reason === DisconnectReason.loggedOut) {
                    console.warn('[WHATSAPP] Logged out — delete auth folder and re-scan QR');
                    return;
                }

                // Auto-reconnect for transient failures
                console.log(`[WHATSAPP] Disconnected (reason: ${reason}), reconnecting...`);
                setTimeout(() => this.connect(), 5_000);
            }
        });

        // Listen for incoming messages (for reply detection)
        this.sock.ev.on('messages.upsert', ({ messages }) => {
            if (!this.replyHandler) return;

            for (const msg of messages) {
                if (msg.key.fromMe) continue; // skip our own messages
                const jid = msg.key.remoteJid;
                if (!jid || !this.sentTo.has(jid)) continue; // only replies to our messages

                const text =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    '';

                if (text) {
                    const phone = jidToPhone(jid);
                    this.replyHandler(phone, text, { channelType: 'whatsapp' });
                }
            }
        });

        // Wait for connection (max 30s)
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.connected) {
                    console.warn('[WHATSAPP] Connection timeout — will retry in background');
                }
                resolve(); // don't block bootstrap
            }, 30_000);

            this.sock!.ev.on('connection.update', (update) => {
                if (update.connection === 'open') {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        });
    }

    async disconnect(): Promise<void> {
        if (this.sock) {
            this.sock.end(undefined);
            this.sock = null;
        }
        this.connected = false;
        this.sentTo.clear();
    }

    isConnected(): boolean {
        return this.connected && this.sock !== null;
    }

    async sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult> {
        const jid = phoneToJid(to);

        if (!this.isConnected()) {
            // Fallback: return deep-link for manual sending
            const cleanPhone = to.replace(/[^+\d]/g, '');
            const waPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;
            return {
                success: false,
                error: 'WhatsApp not connected',
                fallbackUrl: `https://wa.me/${waPhone}?text=${encodeURIComponent(text)}`,
            };
        }

        try {
            const sent = await this.sock!.sendMessage(jid, { text });
            this.sentTo.add(jid);
            return {
                success: true,
                messageId: sent?.key?.id || undefined,
            };
        } catch (err: any) {
            const cleanPhone = to.replace(/[^+\d]/g, '');
            const waPhone = cleanPhone.startsWith('+') ? cleanPhone.slice(1) : cleanPhone;
            return {
                success: false,
                error: err.message,
                fallbackUrl: `https://wa.me/${waPhone}?text=${encodeURIComponent(text)}`,
            };
        }
    }

    onReply(handler: ReplyHandler): void {
        this.replyHandler = handler;
    }
}

// ==========================================
// JID helpers
// ==========================================

/** Convert phone number (+39 06 1234567) to WhatsApp JID (3906123456@s.whatsapp.net) */
function phoneToJid(phone: string): string {
    const digits = phone.replace(/[^0-9]/g, '');
    return `${digits}@s.whatsapp.net`;
}

/** Convert WhatsApp JID to phone number */
function jidToPhone(jid: string): string {
    const digits = jid.replace(/@.*$/, '');
    return `+${digits}`;
}

// ==========================================
// Self-registration
// ==========================================

if (process.env.WHATSAPP_ENABLED === 'true') {
    registerChannel('whatsapp', () => new WhatsAppChannel());
}
