import { logger } from '@hughescr/logger';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import type { Message, MessageCreateOptions, TextChannel } from 'discord.js';
import type { NotifyFn, NotifyParams } from '@/agent';
import type { ChannelId } from '@/config';
import { ChannelNotFoundByIdError } from '@/errors';
import { currentCardDraftUid } from '@/integrations/discord/approvals/email-approval-card';
import type { DeliveredCard, EmailApprovalCardPresenter, QueuedCardInspection } from '@/integrations/discord/approvals/email-approval-cards';
import { DISCORD_MAX_LENGTH, splitMessage } from '@/integrations/discord/messages';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { OutboxDeliveryDeferredError, OutboxDiscardRequestedError, OutboxVerificationPendingError, type OutboxCompletion, type OutboxItem } from '@/services';
import { appendDeliveryCode, decodeDeliveryCode, deliveryTokenForBase, maxContentLengthForDeliveryCode } from '@/utils';

export interface OutboxReplayDeps {
    fetchChannel(channelId: ChannelId): Promise<TextChannel | null>
    /**
     * Tells Izzy that a queued reply was dropped because the message it answered was deleted.
     * A `false` return (Izzy cannot be told yet) defers the item instead of discarding it.
     */
    notify:              NotifyFn
    /**
     * Settles rows that carry an `email_approval_card` completion: before sending, whether the
     * card already exists or its draft has moved on; after delivery, the link and repaint the
     * card still owes. Without it a completion is ignored and the row replays as plain content.
     */
    emailApprovalCards?: Pick<EmailApprovalCardPresenter, 'inspectQueuedCard' | 'reconcileQueuedCard'>
}

// Re-exported so existing consumers (the Discord outbox tests) keep importing it from here.
export { DELIVERY_TOKEN_MAX_LENGTH } from '@/utils';

/** A compact token that is both a Discord nonce and invisible history correlation code. */
export function deliveryTokenFor(item: OutboxItem, part: number): string {
    const base = item.progress.deliveryToken ?? item.id.replaceAll('-', '').slice(0, 16);
    return deliveryTokenForBase(base, part);
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

/** Where delivery resumes, and the card message when history already holds an email approval card. */
interface ResumePoint {
    part:       number
    delivered?: DeliveredCard
}

/**
 * The bot's own messages in `history`. Only these can prove a delivery: any other author could
 * have posted a copy of a code. A client with no user id cannot say which are its own, so the
 * history cannot be trusted either way.
 */
function ownMessagesOf(channel: TextChannel, history: Iterable<Message>): Message[] {
    const botId = (channel.client as { user: { id: string } | null }).user?.id;
    if(botId === undefined) {
        throw new OutboxVerificationPendingError();
    }
    return [...history].filter(message => message.author.id === botId);
}

/**
 * The card in `own` that proves `completion` delivered. A message carrying the item's final
 * part code is preferred (it may have lost its controls since); otherwise a message whose live
 * controls act on the draft, even though it carries no code.
 */
function findDeliveredCard(channel: TextChannel, item: OutboxItem, parts: number, completion: OutboxCompletion, own: readonly Message[]): DeliveredCard | undefined {
    const finalToken = deliveryTokenFor(item, parts - 1);
    const tagged = own.find(message => decodeDeliveryCode(message.content) === finalToken);
    const card = tagged ?? own.find(message => currentCardDraftUid(message) === completion.draftUid);
    return card === undefined ? undefined : { channelId: channel.id, messageId: card.id };
}

/**
 * Returns the first part that still needs sending. Parts [0, deliveredParts) are confirmed. After
 * an unknown outcome, history is searched too: parts are sent strictly in order, so a later
 * part's code proves every earlier part was delivered, and no part whose code is present is resent.
 * For an email approval card (`completion`), the final part's code or live controls on the draft
 * also prove the whole item delivered, and say which message is the card.
 */
async function firstUndeliveredPart(channel: TextChannel, item: OutboxItem, parts: number, completion?: OutboxCompletion): Promise<ResumePoint> {
    const start = item.progress.deliveredParts ?? 0;
    if(item.progress.outcome !== 'unknown') {
        return { part: start };
    }
    let history: Awaited<ReturnType<TextChannel['messages']['fetch']>>;
    try {
        history = await channel.messages.fetch({ limit: 100 });
    } catch{
        throw new OutboxVerificationPendingError();
    }
    const own = ownMessagesOf(channel, history.values());
    const codes = new Set(own.map(message => decodeDeliveryCode(message.content)));
    let resume = start;
    for(let part = start; part < parts; part++) {
        if(codes.has(deliveryTokenFor(item, part))) {
            resume = part + 1;
        }
    }
    const delivered = completion === undefined ? undefined : findDeliveredCard(channel, item, parts, completion, own);
    if(delivered !== undefined) {
        resume = parts;
    }
    // Record the history-confirmed prefix before any send and settle the unknown outcome: a
    // definitive rejection of the next part then persists this progress as a retryable outcome
    // that the next replay trusts without history, and a discard notice calls it undelivered. A
    // failure before this point (the channel fetch) leaves the outcome unknown.
    // eslint-disable-next-line eslint-core/require-atomic-updates -- the drainer hands this item to one delivery at a time and reads its progress only after it settles
    item.progress.deliveredParts = resume;
    // eslint-disable-next-line eslint-core/require-atomic-updates -- as above: one delivery owns this item until it settles
    item.progress.outcome = 'retryable';
    return { part: resume, delivered };
}

async function sendWithOutcomeVerification(channel: TextChannel, payload: Parameters<TextChannel['send']>[0]): Promise<Message> {
    try {
        return await withDiscordRetry(() => channel.send(payload));
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

async function sendTextPart(channel: TextChannel, item: OutboxItem, part: number, chunk: string, notify: NotifyFn): Promise<Message> {
    try {
        return await sendWithOutcomeVerification(channel, textPartPayload(item, part, chunk));
    } catch (error: unknown) {
        const replyTo = item.payload.replyToMessageId;
        if(part === 0 && replyTo !== undefined && !(error instanceof OutboxVerificationPendingError)) {
            await settleIfReplyTargetDeleted(channel, item, replyTo, notify);
        }
        throw error;
    }
}

/** A queued email approval card's completion and the presenter that settles it. */
interface CardSettlement {
    completion: OutboxCompletion
    cards:      NonNullable<OutboxReplayDeps['emailApprovalCards']>
}

/**
 * What the presenter says about a queued card before it is sent. Advisory: a failed read is
 * logged and counts as no information, so delivery falls back to the history checks.
 */
async function inspectCard({ completion, cards }: CardSettlement): Promise<QueuedCardInspection> {
    try {
        return await cards.inspectQueuedCard(completion);
    } catch (err: unknown) {
        logger.warn({ err, draftUid: completion.draftUid, msg: 'Could not inspect the queued approval card; delivering it without that check' });
        return { obsolete: false };
    }
}

/**
 * Lets the presenter finish what the delivered card owes. The card is already posted, so a
 * failure here is logged and swallowed: failing the item would resend a card that exists.
 */
async function reconcileCard({ completion, cards }: CardSettlement, delivered: DeliveredCard): Promise<void> {
    try {
        await cards.reconcileQueuedCard(completion, delivered);
    } catch (err: unknown) {
        logger.warn({ err, draftUid: completion.draftUid, ...delivered, msg: 'Could not reconcile the delivered approval card' });
    }
}

/**
 * Where delivery resumes. A card the presenter or history proves posted means nothing is left
 * to send; a card whose draft moved on and was never posted is discarded rather than posted stale.
 * A stored card the presenter could not attribute (no bot identity) leaves delivery unverified, as
 * an unattributable history read does: nothing is sent and the item is retried later.
 */
async function resolveStart(channel: TextChannel, item: OutboxItem, parts: number, settlement: CardSettlement | undefined): Promise<ResumePoint> {
    const inspection = settlement === undefined ? undefined : await inspectCard(settlement);
    if(inspection?.inconclusive === true) {
        throw new OutboxVerificationPendingError();
    }
    if(inspection?.delivered !== undefined) {
        // The stored link proves the card was posted, so every part of the item is delivered.
        item.progress.deliveredParts = parts;
        return { part: parts, delivered: inspection.delivered };
    }
    const point = await firstUndeliveredPart(channel, item, parts, settlement?.completion);
    if(inspection?.obsolete === true && point.part < parts) {
        // The draft moved on while the card waited and no card was ever posted (a card found in
        // history resumes at `parts`): posting one now would offer a stale draft.
        throw new OutboxDiscardRequestedError('card_target_gone');
    }
    return point;
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
        const parts = chunks.length + Number(hasRichPayload);
        const settlement: CardSettlement | undefined = parts === 0 || item.completion === undefined || deps.emailApprovalCards === undefined
            ? undefined
            : { completion: item.completion, cards: deps.emailApprovalCards };

        const { part: resume, delivered } = await resolveStart(channel, item, parts, settlement);

        let finalMessage: Message | undefined;
        for(let part = resume; part < chunks.length; part++) {
            // eslint-disable-next-line no-await-in-loop -- chunks must be sent sequentially to preserve message order
            finalMessage = await sendTextPart(channel, item, part, chunks[part]!, deps.notify);
            // The drainer persists this on any later failure, so a replay never resends this part.
            // eslint-disable-next-line eslint-core/require-atomic-updates -- the drainer hands this item to one delivery at a time and reads its progress only after it settles
            item.progress.deliveredParts = part + 1;
        }
        if(hasRichPayload && resume <= chunks.length) {
            const nonce = deliveryTokenFor(item, chunks.length);
            finalMessage = await sendWithOutcomeVerification(channel, {
                embeds:       item.payload.embeds,
                components:   item.payload.components,
                // An invisible content field tags component-only payloads for replay verification.
                content:      appendDeliveryCode('', nonce),
                nonce,
                enforceNonce: true,
            });
        }

        if(settlement !== undefined) {
            // A message sent just now is the item's last part (the loop above ends on it); otherwise the card was already posted.
            const posted = finalMessage === undefined ? delivered : { channelId: channel.id, messageId: finalMessage.id };
            if(posted !== undefined) {
                await reconcileCard(settlement, posted);
            }
        }
    };
}
