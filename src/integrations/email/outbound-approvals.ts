import { logger } from '@hughescr/logger';
import { chain } from 'lodash-es';
import { markDraftReviewState } from './draft-review-state';
import type { WildDuckClient } from './wildduck-client';
import type { ActivityLogger, NotifyFn } from '@/agent';
import { EmailFolder } from '@/config';
import type { ApprovalCardRef, ApprovedOutboundActionWriter } from '@/services';

/** Which admin control approved the send; only the activity-log failure text differs. */
export type EmailApprovalRoute = 'direct' | 'allowlist';

export interface EmailOutboundApprovalsDeps {
    wildDuckClient:  Pick<WildDuckClient, 'getMessage' | 'updateMessageMetadata' | 'updateMessageFlags'>
    actionWriter:    ApprovedOutboundActionWriter
    activityLogger?: ActivityLogger
    /** Shared notification bridge (Q7, plan amendment B2) — approvals leave a note, rejections wake Izzy. */
    notify:          NotifyFn
}

/**
 * The outbound-email approval operations an admin decision triggers, independent of the UI
 * that collected the decision (the Discord adapter lives in src/integrations/discord/approvals).
 * Inputs are draft UIDs and decisions, never interactions.
 */
export class EmailOutboundApprovals {
    constructor(private readonly deps: EmailOutboundApprovalsDeps) {}

    /**
     * Record the approved send as a durable ApprovedOutboundAction for the executor, carrying
     * the approval card so the real outcome can be shown on it, then log the activity
     * (fire-and-forget). The rate limiter is intentionally not charged here: the admin's manual
     * approval is itself the rate control for non-allowlisted sends.
     */
    async approveSend(uid: number, via: EmailApprovalRoute, card: ApprovalCardRef): Promise<void> {
        const now = new Date().toISOString();
        await this.deps.actionWriter.create({
            id:           crypto.randomUUID(),
            state:        'approved',
            type:         'email_send',
            params:       { uid },
            approvalCard: card,
            createdAt:    now,
            updatedAt:    now,
        });

        void this.deps.activityLogger?.log({ type: 'email-sent', summary: 'Email approved for sending' }).catch((err: unknown) => {
            logger.warn({ err, msg: `Activity log failed for email send (${via} path)` });
        });
    }

    /**
     * Persist the admin's rejection on the draft (metadata, then review-state flag), then log
     * the activity (fire-and-forget). A WildDuck failure propagates so the caller can leave its
     * UI active for a retry.
     */
    async rejectSend(uid: number, reason: string): Promise<void> {
        await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, {
            rejectedAt: new Date().toISOString(),
            reason,
        });

        await markDraftReviewState(this.deps.wildDuckClient, uid, 'rejected_by_admin');

        void this.deps.activityLogger?.log({ type: 'email-rejected', summary: 'Email rejected' }).catch((err: unknown) => {
            logger.warn({ err, msg: 'Activity log failed for email rejection' });
        });
    }

    /**
     * The draft's distinct to + cc addresses, for choosing whom to allowlist. Returns undefined
     * (and warns) when the draft cannot be fetched, so the caller can fall back to a plain approve.
     */
    async draftRecipients(uid: number): Promise<string[] | undefined> {
        let toAddresses: string[];
        let ccAddresses: string[];
        try {
            const msg   = await this.deps.wildDuckClient.getMessage(EmailFolder.Drafts, uid);
            toAddresses = chain(msg?.to).map('address').compact().value();
            ccAddresses = chain(msg?.cc).map('address').compact().value();
        } catch (error) {
            logger.warn({ err: error, uid, msg: 'Failed to fetch draft message before allowlist select — falling back to simple approve' });
            return undefined;
        }
        return [...new Set([...toAddresses, ...ccAddresses])];
    }

    /**
     * Note an approved send for Izzy without opening a turn: the send has not happened yet, and
     * the outcome reporter tells Izzy (waking her) once it has succeeded or failed. A thrown or
     * false-returning notify never fails the approval.
     */
    announceApproved(uid: number): void {
        try {
            this.deps.notify({
                source: 'email-approval',
                wake:   false,
                key:    `${uid}:approved`,
                text:   `Outbound email (uid ${uid}) approved by admin; sending now. You will be notified when it has been sent or has failed.`,
            });
        } catch (err) {
            logger.warn({ err, uid, msg: 'Notify failed for email approval' });
        }
    }

    /** Wake the conductor about a rejected send. A thrown or false-returning notify never fails the rejection. */
    announceRejected(uid: number, reason: string): void {
        try {
            this.deps.notify({
                source: 'email-approval',
                wake:   true,
                key:    `${uid}:rejected`,
                text:   `Outbound email (uid ${uid}) rejected by admin. Reason: ${reason}`,
            });
        } catch (err) {
            logger.warn({ err, uid, msg: 'Notify failed for email rejection' });
        }
    }
}
