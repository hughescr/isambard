import type { Client, Message, TextChannel, EmbedBuilder, ActionRowBuilder } from 'discord.js';
import type { ChannelId } from '@/config';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { deliveryTokenFor, isIndeterminateDiscordError, messageChunksFor, textPartPayload } from '@/integrations/discord/outbox-replay';
import { withDiscordRetry } from '@/integrations/discord/retry';
import { serializedDiscordPayloadSchema, type ServiceHealthRegistry, type OutboxBackend, type OutboxItem, type OutboxPriority, type OutboxItemType } from '@/services';
import { appendDeliveryCode, maxContentLengthForDeliveryCode } from '@/utils';

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

/** Options for {@link DiscordCapability.sendText}. */
export interface TextSendOptions extends SendOptions {
    /** Message the first part replies to; the reply is never posted without its reference. */
    replyToMessageId?:         string
    /** Response-only: queue a definitive rejection as an unknown outcome so replay verifies history. */
    queueOnDefinitiveFailure?: boolean
    /** `notification` when Izzy sends the text during a notification turn (see `OutboxItem.origin`). */
    origin?:                   'notification'
}

/**
 * Result of {@link DiscordCapability.sendText}. `sentMessageIds` lists the parts Discord confirmed
 * before the send stopped, in order.
 * - sent: every part was delivered
 * - queued: Discord was unavailable, the outcome was indeterminate, or a definitive rejection
 *   was queued with queueOnDefinitiveFailure; the whole message (with the confirmed prefix
 *   recorded) is in the outbox for history-verified replay, but may be discarded rather than delivered
 * - failed: Discord definitively rejected a part (unless queueOnDefinitiveFailure was set), or
 *   the channel cannot receive messages; nothing was queued
 * - unavailable: Discord was unavailable and no outbox is configured (or skipOutbox was set)
 */
export type TextSendResult
    = | { status: 'sent', messageIds: string[], chunkCount: number }
      | { status: 'queued', outboxId: string, sentMessageIds: string[], chunkCount: number }
      | { status: 'failed', error: string, sentMessageIds: string[], chunkCount: number }
      | { status: 'unavailable', sentMessageIds: string[], chunkCount: number };

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
     * Send text as one outbox-backed message: it is split within the delivery-code budget and
     * every part carries its own complete delivery code and nonce, exactly as a replay would
     * send it. Indeterminate failures and an unavailable Discord queue the whole message;
     * definitive rejections fail by default, or queue for history-verified replay when
     * queueOnDefinitiveFailure is set for envelope responses.
     */
    sendText(channelId: ChannelId, text: string, options?: TextSendOptions): Promise<TextSendResult>
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
    /**
     * Called once a send has been written to the outbox, to wake the drainer. A send can be
     * queued while Discord stays online (an indeterminate REST failure), and then no health
     * transition would ever start a drain to deliver it.
     */
    onQueued?:      () => void
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
function buildOutboxItem(channelId: ChannelId, content: ChannelContent, options: TextSendOptions | undefined): OutboxItem {
    const replyToMessageId = options?.replyToMessageId;
    return {
        id:          crypto.randomUUID(),
        createdAt:   new Date().toISOString(),
        type:        options?.type ?? 'agent_response',
        service:     'discord',
        destination: channelId,
        payload:     typeof content === 'string'
            // An empty reply id means "no reply" (as the direct send treats it) and would not parse back.
            ? { text: content, ...(replyToMessageId === undefined || replyToMessageId === '' ? {} : { replyToMessageId }) }
            : serializedDiscordPayloadSchema.parse({
                text:       content.content,
                embeds:     content.embeds?.map(embed => embed.toJSON()),
                components: content.components?.map(component => component.toJSON()),
            }),
        priority:  options?.priority ?? 'medium',
        dedupeKey: options?.dedupeKey ?? crypto.randomUUID(),
        progress:  { attemptCount: 0, deliveryToken: crypto.randomUUID().replaceAll('-', '').slice(0, 16) },
        epoch:     options?.epoch ?? 0,
        ...originOf(options),
    };
}

/** The queued item's `origin`, present only for text sent during a notification turn. */
function originOf(options: TextSendOptions | undefined): Pick<OutboxItem, 'origin'> {
    return options?.origin === undefined ? {} : { origin: options.origin };
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

function shouldQueueTextFailure(err: unknown, options?: TextSendOptions): boolean {
    return isIndeterminateDiscordError(err) || options?.queueOnDefinitiveFailure === true;
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
            await this.enqueue(this.deps.outboxBackend, outboxItem);
            return { status: 'queued', outboxId: outboxItem.id };
        }

        return { status: 'unavailable' };
    }

    async sendText(channelId: ChannelId, text: string, options?: TextSendOptions): Promise<TextSendResult> {
        // The item is built even for an immediate send: its token sizes and tags every part.
        const item = buildOutboxItem(channelId, text, options);
        const chunks = messageChunksFor(item);
        const chunkCount = chunks.length;
        const sentMessageIds: string[] = [];
        const client = this.client;
        if(this.isReady()) {
            try {
                const channel = await withDiscordRetry(() => client!.channels.fetch(channelId));
                if(!isTextSendable(channel)) {
                    return { status: 'failed', error: `Channel ${channelId} cannot receive messages`, sentMessageIds, chunkCount };
                }
                for(const [part, chunk] of chunks.entries()) {
                    // eslint-disable-next-line no-await-in-loop -- parts are sent in order; each must be confirmed before the next
                    const message = await withDiscordRetry(() => channel.send(textPartPayload(item, part, chunk)));
                    sentMessageIds.push(message.id);
                }
                return { status: 'sent', messageIds: sentMessageIds, chunkCount };
            } catch (err: unknown) {
                const error = err instanceof Error ? err.message : String(err);
                this.deps.logger.warn({ error, channelId, sentParts: sentMessageIds.length }, 'Discord text send failed');
                if(!shouldQueueTextFailure(err, options)) {
                    return { status: 'failed', error, sentMessageIds, chunkCount };
                }
                // A retry may have delivered a part before the final definitive error.
                // Keep the outcome unknown so replay checks history before resending.
                item.progress = { ...item.progress, outcome: 'unknown', lastError: error, lastAttemptAt: new Date().toISOString(), deliveredParts: sentMessageIds.length };
            }
        }
        if(this.deps.outboxBackend !== undefined && options?.skipOutbox !== true) {
            await this.enqueue(this.deps.outboxBackend, item);
            return { status: 'queued', outboxId: item.id, sentMessageIds, chunkCount };
        }
        return { status: 'unavailable', sentMessageIds, chunkCount };
    }

    /** Writes a queued send and only then wakes the drainer, so its scan can find the row. */
    private async enqueue(outboxBackend: OutboxBackend, item: OutboxItem): Promise<void> {
        await outboxBackend.enqueue(item);
        this.deps.onQueued?.();
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
