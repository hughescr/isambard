import type { Client, Message, TextChannel, EmbedBuilder, ActionRowBuilder } from 'discord.js';
import type { ChannelId } from '@/config';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { deliveryTokenFor } from '@/integrations/discord/outbox-replay';
import { withDiscordRetry } from '@/integrations/discord/retry';
import { appendDeliveryCode, maxContentLengthForDeliveryCode } from '@/integrations/discord/zero-width-delivery-code';
import { serializedDiscordPayloadSchema, type ServiceHealthRegistry, type OutboxBackend, type OutboxItem, type OutboxPriority, type OutboxItemType } from '@/services';

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
    sendToChannel(channelId: ChannelId, content: ChannelContent, options?: SendOptions): Promise<SendResult>
    /**
     * Fetch a text channel by ID. Returns null when Discord is not ready or the
     * channel cannot be resolved.
     */
    fetchChannel(channelId: ChannelId): Promise<TextChannel | null>
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
function buildOutboxItem(channelId: ChannelId, content: ChannelContent, options: SendOptions | undefined): OutboxItem {
    return {
        id:          crypto.randomUUID(),
        createdAt:   new Date().toISOString(),
        type:        options?.type ?? 'agent_response',
        service:     'discord',
        destination: channelId,
        payload:     typeof content === 'string'
            ? { text: content }
            : serializedDiscordPayloadSchema.parse({
                text:       content.content,
                embeds:     content.embeds?.map(embed => embed.toJSON()),
                components: content.components?.map(component => component.toJSON()),
            }),
        priority:  options?.priority ?? 'medium',
        dedupeKey: options?.dedupeKey ?? crypto.randomUUID(),
        progress:  { attemptCount: 0, deliveryToken: crypto.randomUUID().replaceAll('-', '').slice(0, 16) },
        epoch:     options?.epoch ?? 0,
    };
}

function sendPayloadWithDeliveryToken(content: ChannelContent, item: OutboxItem): Parameters<TextChannel['send']>[0] {
    const nonce = deliveryTokenFor(item, 0);
    const payload = typeof content === 'string'
        ? { content }
        : content;
    // A component-only payload receives an otherwise invisible content field so an
    // ambiguous initial send remains discoverable during outbox replay.
    return { ...payload, content: appendDeliveryCode(payload.content ?? '', nonce), nonce, enforceNonce: true } as unknown as Parameters<TextChannel['send']>[0];
}

function exceedsOutboxDeliveryBudget(content: ChannelContent, item: OutboxItem): boolean {
    const text = typeof content === 'string' ? content : content.content;
    // Any part index gives the same budget: the part suffix is fixed-width, so every delivery code has the same length.
    return text !== undefined && text.length > maxContentLengthForDeliveryCode(deliveryTokenFor(item, item.progress.attemptCount), DISCORD_MAX_LENGTH);
}

function canAttemptImmediateSend(content: ChannelContent, item: OutboxItem | undefined, ready: boolean): boolean {
    return (item === undefined || !exceedsOutboxDeliveryBudget(content, item)) && ready;
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

    // eslint-disable-next-line sonarjs/cognitive-complexity -- readiness, ambiguous-send persistence, and no-outbox fallback are distinct recovery contracts.
    async sendToChannel(channelId: ChannelId, content: ChannelContent, options?: SendOptions): Promise<SendResult> {
        const outboxItem = this.deps.outboxBackend !== undefined && options?.skipOutbox !== true
            ? buildOutboxItem(channelId, content, options)
            : undefined;
        const client = this.client;
        if(canAttemptImmediateSend(content, outboxItem, this.isReady())) {
            try {
                const channel = await client!.channels.fetch(channelId);
                if(!isTextSendable(channel)) {
                    return { status: 'unavailable' };
                }
                const payload = outboxItem === undefined ? content as Parameters<TextChannel['send']>[0] : sendPayloadWithDeliveryToken(content, outboxItem);
                const message = await withDiscordRetry(() => channel.send(payload));
                return { status: 'sent', message };
            } catch (err) {
                this.deps.logger.warn(
                    { error: err instanceof Error ? err.message : String(err), channelId },
                    'Discord send failed, attempting outbox queue'
                );
                if(outboxItem !== undefined) {
                    outboxItem.progress.outcome = 'unknown';
                    outboxItem.progress.lastError = err instanceof Error ? err.message : String(err);
                    outboxItem.progress.lastAttemptAt = new Date().toISOString();
                }
            }
        }

        if(outboxItem !== undefined && this.deps.outboxBackend !== undefined) {
            await this.deps.outboxBackend.enqueue(outboxItem);
            return { status: 'queued', outboxId: outboxItem.id };
        }

        return { status: 'unavailable' };
    }

    async fetchChannel(channelId: ChannelId): Promise<TextChannel | null> {
        // Stryker disable next-line llm: this.client is Client | undefined and never null, and !isReady() already short-circuits when it is undefined, so loose nullish and strict undefined checks coincide.
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
            this.deps.logger.warn(
                { error: err instanceof Error ? err.message : String(err), channelId },
                'Discord fetchChannel failed, returning null'
            );
            return null;
        }
    }
}
