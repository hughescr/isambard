import { logger } from '@hughescr/logger';
import { RESTJSONErrorCodes } from 'discord-api-types/v10';
import { approvalCardEditGate, type ApprovalCardEditGate } from './card-edit-gate';
import { buildEmailApprovalCard, currentCardDraftUid, type EmailApprovalCard } from './email-approval-card';
import type { ApprovalCardPresentation, EmailApprovalCardPort } from '@/agent';
import { EmailFolder } from '@/config';
import type { SendResult } from '@/integrations/discord/capability';
import { withDiscordRetry } from '@/integrations/discord/retry';
import {
    buildDraftSummary,
    hasDecisionMarker,
    readDraftApprovalMeta,
    type DraftApprovalCardLink,
    type EmailOutboundApprovals,
    type WildDuckClient,
    type WildDuckMessage
} from '@/integrations/email';
import type { OutboxCompletion } from '@/services';

/** Where a queued approval card was posted. */
export type DeliveredCard = Pick<DraftApprovalCardLink, 'channelId' | 'messageId'>;

/**
 * What {@link EmailApprovalCardPresenter.inspectQueuedCard} found: whether the draft has moved
 * on, the stored card when it proves delivery, and `inconclusive` when the stored card was
 * fetched but this bot's identity is unavailable, so whether it is the bot's own card is unknown.
 */
export interface QueuedCardInspection {
    obsolete:      boolean
    delivered?:    DeliveredCard
    inconclusive?: true
}

/** A posted approval card, as far as the presenter reads and edits it. */
export interface ApprovalCardMessage {
    author:     { id: string }
    client:     { user: { id: string } | null }
    components: readonly unknown[]
    edit(payload: EmailApprovalCard & { content?: string }): Promise<unknown>
}

/** True only when the live controls are on this bot's message and still target this draft. */
function isCurrentOwnCard(message: ApprovalCardMessage, uid: number): boolean {
    return message.client.user?.id === message.author.id && currentCardDraftUid(message) === uid;
}

/** A channel the presenter can read an approval card from, bypassing the cache. */
export interface ApprovalCardChannel {
    messages: { fetch(options: { message: string, force: boolean }): Promise<ApprovalCardMessage> }
}

export interface EmailApprovalCardPresenterDeps {
    wildDuckClient: Pick<WildDuckClient, 'getMessage'>
    /** The only writer of an existing draft's metaData (link, supersede), under the draft's lock. */
    draftMeta:      Pick<EmailOutboundApprovals, 'linkCard' | 'markSupersededLocked' | 'readCardTarget' | 'reconcileCardLink'>
    /** Post a new card to the admin channel (the outbox may queue it while Discord is offline). */
    postCard:       (card: EmailApprovalCard, completion: OutboxCompletion) => Promise<SendResult>
    /** The card's channel, or null when it cannot be reached. */
    fetchChannel:   (channelId: string) => Promise<ApprovalCardChannel | null>
    /** Post a short reply to the card, so the admin is notified of an in-place edit. */
    reply:          (card: { channelId: string, messageId: string }, text: string) => Promise<void>
    /** Orders card repaints against clicks on the same card; the process-wide gate when omitted. */
    cardEdits?:     ApprovalCardEditGate
    /**
     * The preview page URL for a draft and its token; absent when the preview is off, and
     * answering undefined while it is not published on the tailnet.
     */
    previewUrlFor?: (uid: number, token: string) => string | undefined
}

/**
 * Presents outbound drafts to the admin as approval cards (#158), always rendered from the draft
 * as WildDuck stores it. A new draft gets a new card, linked to the draft in its metaData. An
 * amended draft's card is edited in place — new content, buttons re-keyed to the new UID,
 * "Edited (n)" — with a reply under it so the admin is notified, but only while the card's live
 * controls still act on the previous UID: a decided, deleted or foreign card is never painted
 * over, and the amended draft gets a new card instead. A deleted draft's live card is marked
 * deleted. Card edits hold the card's key on the shared gate, as clicks do; the card key is
 * never held while posting.
 */
export class EmailApprovalCardPresenter implements EmailApprovalCardPort {
    private readonly cardEdits: ApprovalCardEditGate;

    constructor(private readonly deps: EmailApprovalCardPresenterDeps) {
        this.cardEdits = deps.cardEdits ?? approvalCardEditGate;
    }

    /**
     * Show draft `uid` to the admin: edit the linked card in place when the draft replaces
     * `previousUid` and that card still acts on it, otherwise post (and link) a new card.
     */
    async present(uid: number, previousUid?: number): Promise<ApprovalCardPresentation> {
        const draft = await this.deps.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
        if(draft === null) {
            return 'missing';
        }
        const summary = buildDraftSummary(draft);
        const { card: link, previewToken } = readDraftApprovalMeta(draft.metaData);
        const previewUrl = this.previewUrl(uid, previewToken);

        if(previousUid !== undefined && link !== undefined) {
            const card = buildEmailApprovalCard({ uid, summary, edits: link.edits, state: 'pending', previewUrl });
            if(await this.editInPlace(link, previousUid, uid, card)) {
                await this.replyEdited(link, uid);
                return 'updated';
            }
        }

        const edits = previousUid === undefined ? link?.edits ?? 0 : 0;
        return this.post(uid, buildEmailApprovalCard({ uid, summary, edits, state: 'pending', previewUrl }), edits);
    }

    /**
     * An advisory draft read, followed by proof of delivery if there is a stored card link. A
     * stored card that was fetched while the bot's identity is unavailable is `inconclusive`:
     * like an unattributable history read, it neither proves nor disproves delivery.
     */
    async inspectQueuedCard({ draftUid }: OutboxCompletion): Promise<QueuedCardInspection> {
        const target = await this.deps.draftMeta.readCardTarget(draftUid);
        const obsolete = target.status === 'obsolete';
        if(target.status !== 'unreadable' && target.card !== undefined) {
            const { channelId, messageId } = target.card;
            const message = await this.fetchCard(target.card);
            if(message?.client.user === null) {
                return { obsolete, inconclusive: true };
            }
            if(message && isCurrentOwnCard(message, draftUid)) {
                return { obsolete, delivered: { channelId, messageId } };
            }
        }
        return { obsolete };
    }

    /** Link a delivered outbox card, or retire it if its draft is obsolete or has another live card. */
    async reconcileQueuedCard({ draftUid, edits }: OutboxCompletion, delivered: DeliveredCard): Promise<void> {
        const link = { ...delivered, edits };
        const result = await this.deps.draftMeta.reconcileCardLink(draftUid, link);
        if(result.status === 'obsolete' || (result.status === 'conflict' && await this.resolveCardConflict(draftUid, link, result.existing))) {
            await this.retireQueuedCard(draftUid, link);
        }
    }

    /** True when the new card should retire. Only a verified stale link is eligible for replacement. */
    private async resolveCardConflict(uid: number, link: DraftApprovalCardLink, existing: DraftApprovalCardLink): Promise<boolean> {
        const release = await this.cardEdits.acquire(existing.messageId);
        try {
            const message = await this.fetchCard(existing);
            if(message === undefined || message?.client.user === null) {
                return false; // An inconclusive read is not proof that the existing card is unusable.
            }
            if(message && isCurrentOwnCard(message, uid)) {
                return true;
            }
            // Keep the existing card key across the compare-and-replace, ordered card then draft.
            const result = await this.deps.draftMeta.reconcileCardLink(uid, link, existing);
            if(result.status === 'conflict') {
                logger.warn({ uid, ...link, msg: 'Approval card link changed during replay reconciliation' });
            }
            return result.status === 'obsolete';
        } finally {
            release();
        }
    }

    /** Guard the repaint against concurrent edits or decisions on the delivered card. */
    private async retireQueuedCard(uid: number, link: DraftApprovalCardLink): Promise<void> {
        const release = await this.cardEdits.acquire(link.messageId);
        try {
            const message = await this.fetchCard(link);
            if(message && isCurrentOwnCard(message, uid)) {
                await withDiscordRetry(() => message.edit({ ...buildEmailApprovalCard({ state: 'retired' }), content: '' }));
            }
        } finally {
            release();
        }
    }

    /** The draft's preview link, when the preview server is running and the draft has a token. */
    private previewUrl(uid: number, token: string | undefined): string | undefined {
        return token === undefined ? undefined : this.deps.previewUrlFor?.(uid, token);
    }

    /**
     * Mark the card of a just-deleted draft as deleted, when the card's live controls still act
     * on it and it carries no decision. Every failure is logged and swallowed: a later click on
     * the card is refused as gone anyway.
     */
    async markDeleted(draft: WildDuckMessage, uid: number): Promise<void> {
        const meta = readDraftApprovalMeta(draft.metaData);
        const link = meta.card;
        if(link === undefined || hasDecisionMarker(meta)) {
            return;
        }
        const release = await this.cardEdits.acquire(link.messageId);
        try {
            const message = await this.fetchCard(link);
            if(message && currentCardDraftUid(message) === uid) {
                const card = buildEmailApprovalCard({ uid, summary: buildDraftSummary(draft), edits: link.edits, state: 'deleted' });
                await withDiscordRetry(() => message.edit(card));
            }
        } catch (err: unknown) {
            logger.warn({ err, uid, ...link, msg: 'Could not mark the deleted draft’s approval card' });
        } finally {
            release();
        }
    }

    /** The amend calls this holding `email-draft:<oldUid>`, so the write must not take that key again. */
    async markSuperseded(oldUid: number, newUid: number): Promise<boolean> {
        return this.deps.draftMeta.markSupersededLocked(oldUid, newUid);
    }

    /**
     * Under the card's key: edit it to `card` if its live controls act on `previousUid`. After
     * a failed edit (whose response may have been lost after Discord applied it), the card is
     * read again and the edit counts as done if it already acts on `uid`.
     */
    private async editInPlace(link: DraftApprovalCardLink, previousUid: number, uid: number, card: EmailApprovalCard): Promise<boolean> {
        const release = await this.cardEdits.acquire(link.messageId);
        try {
            const message = await this.fetchCard(link);
            if(!message || currentCardDraftUid(message) !== previousUid) {
                return false;
            }
            try {
                await withDiscordRetry(() => message.edit(card));
                return true;
            } catch (err: unknown) {
                logger.warn({ err, uid, previousUid, ...link, msg: 'Editing the approval card in place failed — checking whether it landed' });
                const fresh = await this.fetchCard(link);
                return Boolean(fresh && currentCardDraftUid(fresh) === uid);
            }
        } finally {
            release();
        }
    }

    /** Read the card fresh: null when deleted, undefined (logged) when inconclusive. */
    private async fetchCard(link: DraftApprovalCardLink): Promise<ApprovalCardMessage | null | undefined> {
        try {
            const channel = await this.deps.fetchChannel(link.channelId);
            if(channel === null) {
                logger.warn({ ...link, msg: 'Approval card channel unavailable' });
                return undefined;
            }
            return await channel.messages.fetch({ message: link.messageId, force: true });
        } catch (err: unknown) {
            if(typeof err === 'object' && err !== null && (err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownMessage) {
                return null;
            }
            logger.warn({ err, ...link, msg: 'Could not read the approval card' });
            return undefined;
        }
    }

    /** Tell the admin the card above was edited; Discord does not notify on edits. A failure is only logged. */
    private async replyEdited(link: DraftApprovalCardLink, uid: number): Promise<void> {
        try {
            await this.deps.reply(link, `Draft edited (${link.edits}): now ${EmailFolder.Drafts}:${uid}. The card above shows the new version; its buttons act on it.`);
        } catch (err: unknown) {
            logger.warn({ err, uid, ...link, msg: 'Could not reply under the edited approval card' });
        }
    }

    /** Post and link a new card, or persist the intent for replay to link it when delivered. */
    private async post(uid: number, card: EmailApprovalCard, edits: number): Promise<ApprovalCardPresentation> {
        let result: SendResult;
        try {
            result = await this.deps.postCard(card, { kind: 'email_approval_card', draftUid: uid, edits });
        } catch (err: unknown) {
            logger.warn({ err, uid, msg: 'Failed to post the outbound email approval card' });
            return 'failed';
        }
        if(result.status === 'queued') {
            return 'queued';
        }
        if(result.status === 'unavailable') {
            return 'failed';
        }
        if(result.message !== undefined) {
            await this.deps.draftMeta.linkCard(uid, { channelId: result.message.channelId, messageId: result.message.id, edits });
        }
        return 'posted';
    }
}
