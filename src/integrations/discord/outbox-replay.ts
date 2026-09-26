import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { MessageCreateOptions, TextChannel } from 'discord.js';
import type { NotifyFn, NotifyParams } from '@/agent';
import type { ChannelId } from '@/config';
import { ChannelNotFoundByIdError } from '@/errors';
import { DISCORD_MAX_LENGTH, splitMessage } from '@/integrations/discord/messages';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { appendDeliveryCode, decodeDeliveryCode, maxContentLengthForDeliveryCode } from '@/integrations/discord/zero-width-delivery-code';
import { OutboxDeliveryDeferredError, OutboxDiscardRequestedError, OutboxVerificationPendingError, type OutboxItem } from '@/services';

export interface OutboxReplayDeps {
    fetchChannel(channelId: ChannelId): Promise<TextChannel | null>
    /**
     * Tells Izzy that a queued reply was dropped because the message it answered was deleted.
     * A `false` return (Izzy cannot be told yet) defers the item instead of discarding it.
     */
    notify: NotifyFn
}

const DELIVERY_TOKEN_PREFIX = 'iz';
const DELIVERY_TOKEN_BASE_MAX_LENGTH = 17;
const DELIVERY_TOKEN_PART_LENGTH = 6;

/** Upper bound on delivery-token length, used by tests to assert the token and chunk budgets. */
export const DELIVERY_TOKEN_MAX_LENGTH = DELIVERY_TOKEN_PREFIX.length + DELIVERY_TOKEN_BASE_MAX_LENGTH + DELIVERY_TOKEN_PART_LENGTH;

/** A compact token that is both a Discord nonce and invisible history correlation code. */
export function deliveryTokenFor(item: OutboxItem, part: number): string {
    const base = item.progress.deliveryToken ?? item.id.replaceAll('-', '').slice(0, 16);
    return `${DELIVERY_TOKEN_PREFIX}${base.slice(0, DELIVERY_TOKEN_BASE_MAX_LENGTH)}${part.toString(36).padStart(DELIVERY_TOKEN_PART_LENGTH, '0')}`;
}

/**
 * Splits an item's text into its delivery parts. The first send and every replay must use this
 * one function, because `progress.deliveredParts` counts parts by these boundaries.
 */
export function messageChunksFor(item: OutboxItem): string[] {
    if(!item.payload.text) {
        return [];
    }
    // The six-character chunk suffix makes every delivery token (and therefore every
    // invisible code) the same size, so this budget safely applies to every chunk.
    // Any part index gives the same budget: the part suffix is fixed-width, so every delivery code has the same length.
    const maxContentLength = maxContentLengthForDeliveryCode(deliveryTokenFor(item, item.progress.attemptCount), DISCORD_MAX_LENGTH);
    return splitMessage(item.payload.text, maxContentLength);
}

/**
 * Send payload for text part `part`: its own complete delivery code and nonce. Part 0 of a reply
 * item also carries the reply reference, with `failIfNotExists` so it is never posted without it.
 */
export function textPartPayload(item: OutboxItem, part: number, chunk: string): MessageCreateOptions {
    const nonce = deliveryTokenFor(item, part);
    const replyTo = item.payload.replyToMessageId;
    return {
        content:      appendDeliveryCode(chunk, nonce),
        nonce,
        enforceNonce: true,
        ...(part === 0 && replyTo !== undefined ? { reply: { messageReference: replyTo, failIfNotExists: true } } : {}),
    };
}

/**
 * True when a failed Discord request may still have been applied: a transport timeout or network
 * error, or a server error. Anything else is a definitive rejection.
 */
export function isIndeterminateDiscordError(error: unknown): boolean {
    const details = typeof error === 'object' && error !== null ? error as { status?: unknown } : {};
    return classifyDiscordError(error).category === 'transient' || (typeof details.status === 'number' && details.status >= 500);
}

/** Most characters of undelivered text a discard notice repeats to Izzy (two Discord messages). */
export const DISCARD_NOTICE_TEXT_LIMIT = 4000;

/** Bounds undelivered text quoted in a discard notice, saying how much was cut. */
export function boundNoticeText(text: string): string {
    if(text.length <= DISCARD_NOTICE_TEXT_LIMIT) {
        return text;
    }
    return `${text.slice(0, DISCARD_NOTICE_TEXT_LIMIT)}… [${text.length - DISCARD_NOTICE_TEXT_LIMIT} more characters not shown]`;
}

/** The notification Izzy receives when a queued reply is dropped because its target was deleted. */
export function describeDroppedReply(item: OutboxItem, replyToMessageId: string): NotifyParams {
    return {
        source: 'discord-outbox',
        key:    item.id,
        wake:   true,
        text:   `A queued Discord reply was dropped and NOT posted: the message it replied to (${replyToMessageId}) in channel ${item.destination} was deleted before the reply could be delivered. Undelivered text:\n\n${boundNoticeText(item.payload.text ?? '')}`,
    };
}

function isUnknownMessageError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMessage;
}

/**
 * Returns the first part that still needs sending. Parts [0, deliveredParts) are confirmed. After
 * an unknown outcome, history is searched too: parts are sent strictly in order, so a later
 * part's code proves every earlier part was delivered, and no part whose code is present is resent.
 */
async function firstUndeliveredPart(channel: TextChannel, item: OutboxItem, parts: number): Promise<number> {
    const start = item.progress.deliveredParts ?? 0;
    if(item.progress.outcome !== 'unknown') {
        return start;
    }
    let history: Awaited<ReturnType<TextChannel['messages']['fetch']>>;
    try {
        history = await channel.messages.fetch({ limit: 100 });
    } catch{
        throw new OutboxVerificationPendingError();
    }
    const codes = new Set(Array.from(history.values(), message => decodeDeliveryCode(message.content)));
    let resume = start;
    for(let part = start; part < parts; part++) {
        if(codes.has(deliveryTokenFor(item, part))) {
            resume = part + 1;
        }
    }
    // Record the history-confirmed prefix before any send and settle the unknown outcome: a
    // definitive rejection of the next part then persists this progress as a retryable outcome
    // that the next replay trusts without history, and a discard notice calls it undelivered. A
    // failure before this point (the channel fetch) leaves the outcome unknown.
    // eslint-disable-next-line require-atomic-updates -- the drainer hands this item to one delivery at a time and reads its progress only after it settles
    item.progress.deliveredParts = resume;
    // eslint-disable-next-line require-atomic-updates -- as above: one delivery owns this item until it settles
    item.progress.outcome = 'retryable';
    return resume;
}

async function sendWithOutcomeVerification(channel: TextChannel, payload: Parameters<TextChannel['send']>[0]): Promise<void> {
    try {
        await withDiscordRetry(() => channel.send(payload));
    } catch (error: unknown) {
        if(isIndeterminateDiscordError(error)) {
            throw new OutboxVerificationPendingError();
        }
        throw error;
    }
}

/**
 * After Discord definitively rejected a reply, checks (bypassing the message cache) whether its
 * target was deleted. If so, tells Izzy and requests a discard, or defers while Izzy cannot be
 * told. Returns normally when the rejection had another cause, so the caller rethrows it.
 */
async function settleIfReplyTargetDeleted(channel: TextChannel, item: OutboxItem, replyToMessageId: string, notify: NotifyFn): Promise<void> {
    try {
        await channel.messages.fetch({ message: replyToMessageId, force: true });
    } catch (error: unknown) {
        if(isUnknownMessageError(error)) {
            if(notify(describeDroppedReply(item, replyToMessageId))) {
                throw new OutboxDiscardRequestedError('reply_target_deleted');
            }
            throw new OutboxDeliveryDeferredError('Reply target deleted; Izzy not yet notified');
        }
        if(isIndeterminateDiscordError(error)) {
            throw new OutboxVerificationPendingError('Reply target check indeterminate after a rejected reply');
        }
    }
}

async function sendTextPart(channel: TextChannel, item: OutboxItem, part: number, chunk: string, notify: NotifyFn): Promise<void> {
    try {
        await sendWithOutcomeVerification(channel, textPartPayload(item, part, chunk));
    } catch (error: unknown) {
        const replyTo = item.payload.replyToMessageId;
        if(part === 0 && replyTo !== undefined && !(error instanceof OutboxVerificationPendingError)) {
            await settleIfReplyTargetDeleted(channel, item, replyTo, notify);
        }
        throw error;
    }
}

/** Creates the Discord delivery function used by the persistent outbox drainer. */
export function createOutboxReplayDeliverFn(deps: OutboxReplayDeps): (item: OutboxItem) => Promise<void> {
    return async (item) => {
        const channel = await deps.fetchChannel(item.destination);
        if(channel === null) {
            throw new ChannelNotFoundByIdError(item.destination);
        }
        const chunks = messageChunksFor(item);
        const hasRichPayload = (item.payload.embeds ?? []).length > 0 || (item.payload.components ?? []).length > 0;
        const resume = await firstUndeliveredPart(channel, item, chunks.length + Number(hasRichPayload));
        for(let part = resume; part < chunks.length; part++) {
            // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
            await sendTextPart(channel, item, part, chunks[part]!, deps.notify);
            // The drainer persists this on any later failure, so a replay never resends this part.
            // eslint-disable-next-line require-atomic-updates -- the drainer hands this item to one delivery at a time and reads its progress only after it settles
            item.progress.deliveredParts = part + 1;
        }
        if(hasRichPayload && resume <= chunks.length) {
            const nonce = deliveryTokenFor(item, chunks.length);
            await sendWithOutcomeVerification(channel, {
                embeds:       item.payload.embeds,
                components:   item.payload.components,
                // An invisible content field tags component-only payloads for replay verification.
                content:      appendDeliveryCode('', nonce),
                nonce,
                enforceNonce: true,
            });
        }
    };
}
