import { logger } from '@hughescr/logger';
import type { BskyRejectionBackend, BskyRejectionItem } from './rejection-backend';
import type { ActivityLogger, NotifyFn } from '@/agent';
import type { ApprovalCardRef, ApprovedOutboundActionWriter } from '@/services';

/**
 * An approved Bluesky reply, in the flat wire shape the executor's params schema parses
 * (src/index.ts). Kept flat so rows already persisted stay executable.
 */
export interface BskyApprovedReply {
    text:      string
    parentUri: string
    parentCid: string
    rootUri?:  string
    rootCid?:  string
}

/** An approved Bluesky DM. */
export interface BskyApprovedDm {
    text:    string
    convoId: string
}

export interface BskyOutboundApprovalsDeps {
    rejectionBackend: Pick<BskyRejectionBackend, 'recordRejection'>
    actionWriter:     ApprovedOutboundActionWriter
    activityLogger?:  ActivityLogger
    /** Q8: wakes the conductor after an admin rejects a Bluesky reply/DM. Omitted means `reject` never notifies. */
    notify?:          NotifyFn
}

/**
 * The outbound-Bluesky approval operations an admin decision triggers, independent of the UI
 * that collected the decision (the Discord adapter lives in src/integrations/discord/approvals).
 */
export class BskyOutboundApprovals {
    constructor(private readonly deps: BskyOutboundApprovalsDeps) {}

    /**
     * Record an approved reply for the executor, carrying the approval card so the real outcome
     * can be shown on it, then log the activity (fire-and-forget).
     */
    async approveReply(reply: BskyApprovedReply, card: ApprovalCardRef): Promise<void> {
        const now = new Date().toISOString();
        await this.deps.actionWriter.create({
            id:           crypto.randomUUID(),
            state:        'approved',
            type:         'bsky_reply',
            params:       { text: reply.text, parentUri: reply.parentUri, parentCid: reply.parentCid, rootUri: reply.rootUri, rootCid: reply.rootCid },
            approvalCard: card,
            createdAt:    now,
            updatedAt:    now,
        });

        void this.deps.activityLogger?.log({ type: 'bsky-post-sent', summary: 'Bluesky reply approved for posting' }).catch((err: unknown) => {
            logger.warn({ err, msg: 'Activity log failed for Bluesky post approval' });
        });
    }

    /** Record an approved DM for the executor with its approval card, then log the activity (fire-and-forget). */
    async approveDm(dm: BskyApprovedDm, card: ApprovalCardRef): Promise<void> {
        const now = new Date().toISOString();
        await this.deps.actionWriter.create({
            id:           crypto.randomUUID(),
            state:        'approved',
            type:         'bsky_dm',
            params:       { text: dm.text, convoId: dm.convoId },
            approvalCard: card,
            createdAt:    now,
            updatedAt:    now,
        });

        void this.deps.activityLogger?.log({ type: 'bsky-dm-sent', summary: 'Bluesky DM approved for sending' }).catch((err: unknown) => {
            logger.warn({ err, msg: 'Activity log failed for Bluesky DM approval' });
        });
    }

    /**
     * Durably record the rejection, then wake the conductor (keyed on the rejection's own uuid
     * so a retried delivery cannot wake it twice), then log the activity (fire-and-forget).
     * A failed record propagates before any notification.
     */
    async reject(item: BskyRejectionItem): Promise<void> {
        await this.deps.rejectionBackend.recordRejection(item);

        this.deps.notify?.({
            source: 'bsky-approval',
            text:   `Bluesky ${item.type} rejected: ${item.reason}`,
            wake:   true,
            key:    `${item.uuid}:rejected`,
        });

        void this.deps.activityLogger?.log({ type: item.type === 'dm' ? 'bsky-dm-rejected' : 'bsky-post-rejected', summary: 'Bluesky post/DM rejected' }).catch((err: unknown) => {
            logger.warn({ err, type: item.type, msg: 'Activity log failed for Bluesky rejection' });
        });
    }
}
