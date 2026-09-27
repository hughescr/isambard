import { logger } from '@hughescr/logger';
import { chain } from 'lodash-es';
import { z } from 'zod';
import { draftLockKey, mergeDraftMeta, readDraftApprovalMeta, type DraftApprovalCardLink, type DraftApprovalMeta, type DraftLocks } from './draft-approval-meta';
import { markDraftReviewState } from './draft-review-state';
import type { WildDuckClient, WildDuckMessage } from './wildduck-client';
import type { ActivityLogger, NotifyFn } from '@/agent';
import { EmailFolder } from '@/config';
import { raceDeadline, type ApprovalCardRef, type ApprovedOutboundActionBackend, type ApprovedOutboundActionWriter } from '@/services';

/** Which admin control approved the send; only the activity-log failure text differs. */
export type EmailApprovalRoute = 'direct' | 'allowlist';

/**
 * The stored params of an approved `email_send` action: the draft's uid, and its Message-ID and
 * Date header at approval, the fingerprint a delivery check looks for once the draft has left
 * Drafts (#108). Every row approved since #158 carries both; older rows may carry the uid only.
 */
export const emailSendParamsSchema = z.object({
    uid:       z.number().int(),
    messageId: z.string().optional(),
    draftDate: z.string().optional(),
});

/** How long a decision (or a card-link or supersede write) waits to read the draft before giving up (10 seconds). */
export const FINGERPRINT_READ_TIMEOUT_MS = 10_000;

export interface EmailOutboundApprovalsDeps {
    wildDuckClient:  Pick<WildDuckClient, 'getMessage' | 'updateMessageMetadata' | 'updateMessageFlags'>
    actionWriter:    ApprovedOutboundActionWriter
    /** Strongly consistent read of an approved action, to tell a complete approval from one whose row was never written. */
    actionReader:    Pick<ApprovedOutboundActionBackend, 'get'>
    /** The process-wide approval card gate; every draft write and decision holds `email-draft:<uid>` on it. */
    draftLocks:      DraftLocks
    activityLogger?: ActivityLogger
    /** Shared notification bridge (Q7, plan amendment B2) — approvals leave a note, rejections wake Izzy. */
    notify:          NotifyFn
}

/** Why an admin decision was not taken. Nothing was recorded, persisted or announced. */
export type EmailDecisionRefusalReason = 'gone' | 'decided' | 'unreadable' | 'unrecorded';

export interface EmailDecisionRefusal<R extends EmailDecisionRefusalReason = EmailDecisionRefusalReason> {
    status: 'refused'
    reason: R
    /** A short sentence for the admin. */
    detail: string
}

export type ApproveSendResult = { status: 'recorded' } | EmailDecisionRefusal;
export type RejectSendResult = { status: 'rejected' } | EmailDecisionRefusal<'gone' | 'decided' | 'unreadable'>;
export type AllowlistCandidatesResult = { status: 'ok', recipients: string[] } | EmailDecisionRefusal<'gone' | 'decided' | 'unreadable'>;

type DecisionRead = { status: 'ok', draft: WildDuckMessage, meta: DraftApprovalMeta } | EmailDecisionRefusal<'gone' | 'unreadable'>;

type DecisionState
    = | { kind: 'none' }
      | { kind: 'rejected' }
      | { kind: 'approved' }
      | { kind: 'approval-incomplete', actionId: string };

function refusal<R extends EmailDecisionRefusalReason>(reason: R, detail: string): EmailDecisionRefusal<R> {
    return { status: 'refused', reason, detail };
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const DECIDED = 'The draft was already approved or rejected';
const NO_ANSWER = `no answer within ${FINGERPRINT_READ_TIMEOUT_MS / 1000}s`;

/**
 * The outbound-email approval operations an admin decision triggers, independent of the UI
 * that collected the decision (the Discord adapter lives in src/integrations/discord/approvals).
 * Inputs are draft UIDs and decisions, never interactions.
 *
 * This class is the only writer of an existing draft's WildDuck metaData (#158). WildDuck
 * replaces metaData wholesale, so every write — the approval marker, the rejection, the card
 * link and `supersededBy` — runs under the draft's key `email-draft:<uid>` on the shared gate
 * and merges into a read taken inside that lock, never into an earlier snapshot. Decisions read
 * and write under the same key, so of two decisions for one UID — from one card or two — the
 * first wins and the second sees it.
 */
export class EmailOutboundApprovals {
    constructor(private readonly deps: EmailOutboundApprovalsDeps) {}

    /**
     * Approve the send of draft `uid`, holding its lock from the read through the row write:
     * refuse when the draft is gone, superseded, lacks its fingerprint or is already decided;
     * otherwise mark the draft approved in its metaData FIRST, then record the `email_send` row
     * (id = the marker's actionId) carrying the fingerprint and the approval card. A marker left
     * by a failed row write is resumed by the next approve with the same actionId (only when no
     * row exists), or cleared by a reject. The rate limiter is not charged: the admin's manual
     * approval is itself the rate control for non-allowlisted sends.
     */
    async approveSend(uid: number, via: EmailApprovalRoute, card: ApprovalCardRef): Promise<ApproveSendResult> {
        return this.withDraftLock(uid, async (): Promise<ApproveSendResult> => {
            const read = await this.readDraftForDecision(uid);
            if(read.status === 'refused') {
                return read;
            }
            const { draft, meta } = read;
            if(typeof draft.messageId !== 'string' || typeof draft.date !== 'string') {
                return refusal('unreadable', 'The draft has no Message-ID or Date');
            }
            const state = await this.decisionState(uid, meta);
            if(state.status === 'refused') {
                return state;
            }
            if(state.kind === 'rejected' || state.kind === 'approved') {
                return refusal('decided', DECIDED);
            }

            const now = new Date().toISOString();
            let actionId: string;
            if(state.kind === 'approval-incomplete') {
                actionId = state.actionId;
            } else {
                actionId = crypto.randomUUID();
                try {
                    await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, mergeDraftMeta(draft.metaData, { approval: { actionId, at: now } }));
                } catch (err: unknown) {
                    logger.warn({ err, uid, msg: 'Could not mark the draft approved — nothing was approved' });
                    return refusal('unreadable', `Couldn't mark the draft approved (${errorText(err)})`);
                }
            }

            try {
                await this.deps.actionWriter.create({
                    id:           actionId,
                    state:        'approved',
                    type:         'email_send',
                    params:       { uid, messageId: draft.messageId, draftDate: draft.date },
                    approvalCard: card,
                    createdAt:    now,
                    updatedAt:    now,
                });
            } catch (err: unknown) {
                logger.error({ err, uid, actionId, msg: 'Could not record the approved send — the draft keeps its approval marker for a retry' });
                return refusal('unrecorded', `Couldn't record the approval (${errorText(err)}) — nothing will be sent until it is; try again.`);
            }

            void this.deps.activityLogger?.log({ type: 'email-send-approved', summary: 'Email approved for sending' }).catch((err: unknown) => {
                logger.warn({ err, msg: `Activity log failed for email send (${via} path)` });
            });
            return { status: 'recorded' };
        });
    }

    /**
     * Persist the admin's rejection on draft `uid` under its lock, idempotently: refuse when the
     * draft is gone, superseded or approved (with its row); otherwise merge the rejection into
     * the draft's metaData (keeping an earlier `rejectedAt`, and clearing an approval marker that
     * has no row), then add the review-state flag, then log the activity (fire-and-forget). A
     * WildDuck write failure propagates so the caller can leave its UI active for a retry, which
     * completes whatever the failed attempt left undone.
     */
    async rejectSend(uid: number, reason: string): Promise<RejectSendResult> {
        return this.withDraftLock(uid, async (): Promise<RejectSendResult> => {
            const read = await this.readDraftForDecision(uid);
            if(read.status === 'refused') {
                return read;
            }
            const { draft, meta } = read;
            const state = await this.decisionState(uid, meta);
            if(state.status === 'refused') {
                return state;
            }
            if(state.kind === 'approved') {
                return refusal('decided', DECIDED);
            }

            await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, mergeDraftMeta(draft.metaData, {
                rejectedAt: meta.rejectedAt ?? new Date().toISOString(),
                reason,
                approval:   undefined,
            }));
            await markDraftReviewState(this.deps.wildDuckClient, uid, 'rejected_by_admin');

            void this.deps.activityLogger?.log({ type: 'email-rejected', summary: 'Email rejected' }).catch((err: unknown) => {
                logger.warn({ err, msg: 'Activity log failed for email rejection' });
            });
            return { status: 'rejected' };
        });
    }

    /**
     * The draft's distinct to + cc addresses, for choosing whom to allowlist, read under the
     * draft's lock; refused when the draft is gone, unreadable or already decided. The approval
     * that follows re-checks everything under the lock.
     */
    async allowlistCandidates(uid: number): Promise<AllowlistCandidatesResult> {
        return this.withDraftLock(uid, async (): Promise<AllowlistCandidatesResult> => {
            const read = await this.readDraftForDecision(uid);
            if(read.status === 'refused') {
                return read;
            }
            const state = await this.decisionState(uid, read.meta);
            if(state.status === 'refused') {
                return state;
            }
            if(state.kind === 'rejected' || state.kind === 'approved') {
                return refusal('decided', DECIDED);
            }
            const toAddresses = chain(read.draft.to).map('address').compact().value();
            const ccAddresses = chain(read.draft.cc).map('address').compact().value();
            return { status: 'ok', recipients: [...new Set([...toAddresses, ...ccAddresses])] };
        });
    }

    /**
     * Link draft `uid` to its approval card, merging `approvalCard` into a read taken under the
     * draft's lock, so a decision written first is kept and a decision written later sees the
     * link. False (and nothing written) when the draft is gone; false with a warning on any
     * failure — a missing link never fails the flow that posted the card.
     */
    async linkCard(uid: number, link: DraftApprovalCardLink): Promise<boolean> {
        try {
            return await this.withDraftLock(uid, async () => {
                const fresh = await this.readBounded(uid);
                if(fresh === undefined) {
                    throw new Error(NO_ANSWER);
                }
                if(fresh?.draft !== true) {
                    return false;
                }
                await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, mergeDraftMeta(fresh.metaData, { approvalCard: link }));
                return true;
            });
        } catch (err: unknown) {
            logger.warn({ err, uid, msg: 'Could not link the draft to its approval card' });
            return false;
        }
    }

    /**
     * Mark `oldUid` as replaced by `newUid` (when an amend could not delete it), merging into a
     * read taken under the old draft's lock so any decision marker is kept. True when written or
     * when the old UID is already gone; false (logged) on any failure.
     */
    async markSuperseded(oldUid: number, newUid: number): Promise<boolean> {
        try {
            return await this.withDraftLock(oldUid, async () => {
                const fresh = await this.readBounded(oldUid);
                if(fresh === null) {
                    return true;
                }
                if(fresh === undefined) {
                    throw new Error(NO_ANSWER);
                }
                await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, oldUid, mergeDraftMeta(fresh.metaData, { supersededBy: newUid }));
                return true;
            });
        } catch (err: unknown) {
            logger.error({ err, oldUid, newUid, msg: 'Could not mark the replaced draft as superseded' });
            return false;
        }
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

    /** Run `fn` holding the draft's key, released on every path. */
    private async withDraftLock<T>(uid: number, fn: () => Promise<T>): Promise<T> {
        const release = await this.deps.draftLocks.acquire(draftLockKey(uid));
        try {
            return await fn();
        } finally {
            release();
        }
    }

    /**
     * Read the draft, cancelled after {@link FINGERPRINT_READ_TIMEOUT_MS}: the message (null when
     * WildDuck has none), or undefined when no answer came in time. A read error propagates.
     */
    private async readBounded(uid: number): Promise<WildDuckMessage | null | undefined> {
        const controller = new AbortController();
        const read = await raceDeadline(
            this.deps.wildDuckClient.getMessage(EmailFolder.Drafts, uid, controller.signal),
            FINGERPRINT_READ_TIMEOUT_MS,
            () => controller.abort()
        );
        return read?.value;
    }

    /** The draft and its approval metaData, read under its lock; refused when unreadable, gone, not a draft or superseded. */
    private async readDraftForDecision(uid: number): Promise<DecisionRead> {
        let draft: WildDuckMessage | null | undefined;
        try {
            draft = await this.readBounded(uid);
        } catch (err: unknown) {
            logger.warn({ err, uid, msg: 'Could not read the draft for an admin decision' });
            return refusal('unreadable', `Couldn't read the draft from WildDuck (${errorText(err)})`);
        }
        if(draft === undefined) {
            logger.warn({ uid, msg: `Could not read the draft for an admin decision: ${NO_ANSWER}` });
            return refusal('unreadable', `Couldn't read the draft from WildDuck (${NO_ANSWER})`);
        }
        if(draft?.draft !== true) {
            return refusal('gone', 'The draft is no longer in Drafts');
        }
        const meta = readDraftApprovalMeta(draft.metaData);
        if(meta.supersededBy !== undefined) {
            return refusal('gone', `The draft was replaced by Drafts:${meta.supersededBy}`);
        }
        return { status: 'ok', draft, meta };
    }

    /** What the draft's markers (and, for an approval, its row) say was decided. */
    private async decisionState(uid: number, meta: DraftApprovalMeta): Promise<({ status: 'ok' } & DecisionState) | EmailDecisionRefusal<'unreadable'>> {
        if(meta.rejectedAt !== undefined) {
            return { status: 'ok', kind: 'rejected' };
        }
        if(meta.approval === undefined) {
            return { status: 'ok', kind: 'none' };
        }
        const actionId = meta.approval.actionId;
        try {
            return await this.deps.actionReader.get(actionId) === undefined
                ? { status: 'ok', kind: 'approval-incomplete', actionId }
                : { status: 'ok', kind: 'approved' };
        } catch (err: unknown) {
            logger.warn({ err, uid, actionId, msg: 'Could not read the approved action for an admin decision' });
            return refusal('unreadable', `Couldn't check the approval record (${errorText(err)})`);
        }
    }
}
