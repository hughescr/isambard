import type { Client, Message, TextChannel, EmbedBuilder, ActionRowBuilder } from 'discord.js';
import { withDiscordRetry } from '@/integrations/discord/retry';
import type { ServiceHealthRegistry, OutboxBackend, OutboxItem, OutboxPriority, OutboxItemType } from '@/services';

/**
 * Result of a Discord send operation.
 * - sent: message was delivered to Discord successfully
 * - queued: Discord was offline; item was written to the outbox
 * - unavailable: Discord was offline and no outbox is configured (or skipOutbox was set)
 */
export type SendResult
    = | { status: 'sent', message?: Message }
      | { status: 'queued', outboxId: string }
      | { status: 'unavailable' };

/**
 * Options controlling how a send is handled when Discord is offline.
 */
export interface SendOptions {
    /** Outbox priority when queuing. Defaults to 'medium'. */
    priority?:   OutboxPriority
    /** Outbox item type. Defaults to 'agent_response'. */
    type?:       OutboxItemType
    /** Dedupe key for idempotent delivery. Defaults to crypto.randomUUID(). */
    dedupeKey?:  string
    /** Current service epoch — stored on the outbox item. Defaults to 0. */
    epoch?:      number
    /** When true, never queue to outbox on failure — return 'unavailable' instead. */
    skipOutbox?: boolean
}

/**
 * Message payload accepted by sendToChannel.
 * Either a plain string or a structured embed/component payload.
 */
export type ChannelContent
    = | string
      | { content?: string, embeds?: EmbedBuilder[], components?: ActionRowBuilder[] };

/**
 * Facade for Discord send operations.
 * Checks readiness before every send and falls back to the outbox when Discord is offline.
 */
export interface DiscordCapability {
    /** Register the Discord.js client once it has connected. */
    setClient(client: Client): void
    /**
     * Returns true when a Discord client has been registered AND
     * the health registry reports discord as available.
     */
    isReady(): boolean
    /**
     * Send content to a channel by ID.
     * Falls back to outbox when Discord is not ready (unless skipOutbox is set).
     */
    sendToChannel(channelId: string, content: ChannelContent, options?: SendOptions): Promise<SendResult>
    /**
     * Fetch a text channel by ID. Returns null when Discord is not ready or the
     * channel cannot be resolved.
     */
    fetchChannel(channelId: string): Promise<TextChannel | null>
}

export interface DiscordCapabilityLogger {
    warn:  (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    info:  (...args: unknown[]) => void
}

export interface DiscordCapabilityDeps {
    registry:       ServiceHealthRegistry
    /** Optional — if not provided, outbox fallback is disabled. */
    outboxBackend?: OutboxBackend
    logger:         DiscordCapabilityLogger
}

/**
 * Check whether a Discord channel object supports sending messages.
 * Using a type guard avoids the sonarjs/in-operator-type-error that fires when
 * using `'send' in channel` on a value whose type might be primitive.
 */
function isTextSendable(channel: unknown): channel is TextChannel {
    return typeof channel === 'object' && channel !== null && 'send' in channel;
}

/**
 * Build an OutboxItem for a failed Discord send, ready to enqueue.
 */
function buildOutboxItem(channelId: string, content: ChannelContent, options: SendOptions | undefined): OutboxItem {
    return {
        id:          crypto.randomUUID(),
        createdAt:   new Date().toISOString(),
        type:        options?.type ?? 'agent_response',
        service:     'discord',
        destination: channelId,
        payload:     typeof content === 'string'
            ? { text: content }
            : {
                text:       content.content,
                embeds:     content.embeds as unknown[],
                components: content.components as unknown[],
            },
        priority:  options?.priority ?? 'medium',
        dedupeKey: options?.dedupeKey ?? crypto.randomUUID(),
        progress:  {},
        epoch:     options?.epoch ?? 0,
    };
}

export class DiscordCapabilityImpl implements DiscordCapability {
    private client: Client | undefined;

    constructor(private readonly deps: DiscordCapabilityDeps) {}

    setClient(client: Client): void {
        this.client = client;
    }

    isReady(): boolean {
        return this.client !== undefined && this.deps.registry.isAvailable('discord');
    }

    async sendToChannel(channelId: string, content: ChannelContent, options?: SendOptions): Promise<SendResult> {
        if(this.isReady() && this.client !== undefined) {
            try {
                const channel = await this.client.channels.fetch(channelId);
                if(!isTextSendable(channel)) {
                    return { status: 'unavailable' };
                }
                const message = await withDiscordRetry(() => channel.send(content as Parameters<TextChannel['send']>[0]));
                return { status: 'sent', message };
            } catch (err) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                this.deps.logger.warn(
                    { error: err instanceof Error ? err.message : String(err), channelId },
                    'Discord send failed, attempting outbox queue'
                );
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }

        if(this.deps.outboxBackend !== undefined && options?.skipOutbox !== true) {
            const item = buildOutboxItem(channelId, content, options);
            await this.deps.outboxBackend.enqueue(item);
            return { status: 'queued', outboxId: item.id };
        }

        return { status: 'unavailable' };
    }

    async fetchChannel(channelId: string): Promise<TextChannel | null> {
        if(!this.isReady() || this.client === undefined) {
            return null;
        }
        try {
            const channel = await this.client.channels.fetch(channelId);
            if(!isTextSendable(channel)) {
                return null;
            }
            return channel;
        } catch (err) {
            // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
            this.deps.logger.warn(
                { error: err instanceof Error ? err.message : String(err), channelId },
                'Discord fetchChannel failed, returning null'
            );
            // Stryker restore ObjectLiteral,StringLiteral
            return null;
        }
    }
}
