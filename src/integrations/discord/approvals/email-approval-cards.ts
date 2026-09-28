import { logger } from '@hughescr/logger';
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

/** A posted approval card, as far as the presenter reads and edits it. */
export interface ApprovalCardMessage {
    components: readonly unknown[]
    edit(payload: EmailApprovalCard): Promise<unknown>
}

/** A channel the presenter can read an approval card from, bypassing the cache. */
export interface ApprovalCardChannel {
    messages: { fetch(options: { message: string, force: boolean }): Promise<ApprovalCardMessage> }
}

export interface EmailApprovalCardPresenterDeps {
    wildDuckClient: Pick<WildDuckClient, 'getMessage'>
    /** The only writer of an existing draft's metaData (link, supersede), under the draft's lock. */
    draftMeta:      Pick<EmailOutboundApprovals, 'linkCard' | 'markSuperseded'>
    /** Post a new card to the admin channel (the outbox may queue it while Discord is offline). */
    postCard:       (card: EmailApprovalCard) => Promise<SendResult>
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
            if(message !== undefined && currentCardDraftUid(message) === uid) {
                const card = buildEmailApprovalCard({ uid, summary: buildDraftSummary(draft), edits: link.edits, state: 'deleted' });
                await withDiscordRetry(() => message.edit(card));
            }
        } catch (err: unknown) {
            logger.warn({ err, uid, ...link, msg: 'Could not mark the deleted draft’s approval card' });
        } finally {
            release();
        }
    }

    async markSuperseded(oldUid: number, newUid: number): Promise<boolean> {
        return this.deps.draftMeta.markSuperseded(oldUid, newUid);
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
            if(message === undefined || currentCardDraftUid(message) !== previousUid) {
                return false;
            }
            try {
                await withDiscordRetry(() => message.edit(card));
                return true;
            } catch (err: unknown) {
                logger.warn({ err, uid, previousUid, ...link, msg: 'Editing the approval card in place failed — checking whether it landed' });
                const fresh = await this.fetchCard(link);
                return fresh !== undefined && currentCardDraftUid(fresh) === uid;
            }
        } finally {
            release();
        }
    }

    /** The card, read fresh from Discord; undefined (logged) when it cannot be read. */
    private async fetchCard(link: DraftApprovalCardLink): Promise<ApprovalCardMessage | undefined> {
        try {
            const channel = await this.deps.fetchChannel(link.channelId);
            if(channel === null) {
                logger.warn({ ...link, msg: 'Approval card channel unavailable' });
                return undefined;
            }
            return await channel.messages.fetch({ message: link.messageId, force: true });
        } catch (err: unknown) {
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

    /** Post a new card and link the draft to it; a queued card is not linked. */
    private async post(uid: number, card: EmailApprovalCard, edits: number): Promise<ApprovalCardPresentation> {
        let result: SendResult;
        try {
            result = await this.deps.postCard(card);
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
