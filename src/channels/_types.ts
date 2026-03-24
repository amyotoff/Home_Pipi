/**
 * Channel abstraction for outbound concierge communications.
 *
 * Channels are self-registering modules that allow the concierge skill
 * to send messages via WhatsApp, Discord, Gmail without direct coupling.
 */

export type ChannelType = 'whatsapp' | 'discord' | 'gmail';

export interface MessageOptions {
    subject?: string;       // email subject
    threadId?: string;      // for threading replies
    requestId?: number;     // concierge service_request.id for audit logging
}

export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: string;
    fallbackUrl?: string;   // e.g. wa.me deep-link when WhatsApp not connected
}

export type ReplyHandler = (
    from: string,
    text: string,
    meta?: { subject?: string; threadId?: string; channelType?: ChannelType }
) => void;

export interface OutboundChannel {
    readonly type: ChannelType;

    /** Connect to the service (authenticate, open socket, etc.) */
    connect(): Promise<void>;

    /** Gracefully disconnect */
    disconnect(): Promise<void>;

    /** Whether the channel is currently connected and ready to send */
    isConnected(): boolean;

    /** Send a message to a recipient (phone number, email, channel ID) */
    sendMessage(to: string, text: string, opts?: MessageOptions): Promise<SendResult>;

    /** Register a handler for incoming replies (optional — not all channels support it) */
    onReply?(handler: ReplyHandler): void;
}

/** Factory function that creates a channel instance, or null if not configured */
export type ChannelFactory = () => OutboundChannel | null;
