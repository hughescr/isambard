import { logger } from '@hughescr/logger';
import { chain } from 'lodash-es';
import { z } from 'zod';
import { draftLockKey, mergeDraftMeta, readDraftApprovalMeta, type DraftApprovalCardLink, type DraftApprovalMeta, type DraftLocks } from './draft-approval-meta';
import { markDraftReviewState } from './draft-review-state';
import type { WildDuckClient, WildDuckMessage } from './wildduck-client';
import type { ActivityLogger, NotifyFn } from '@/agent';
import { EmailFolder } from '@/config';
import { EmailProcessingError } from '@/errors';
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

/**
 * How long a replayed card's link reconciliation waits for the draft's key before giving up
 * (30 seconds). The Discord outbox drainer delivers one item at a time and an amend or delete
 * can hold the key across WildDuck calls that may hang, so an unbounded wait would stall every
 * later queued message. Longer than a normal amend, which holds the key through its attachment
 * fetches.
 */
export const CARD_LINK_LOCK_WAIT_MS = 30_000;

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

/**
 * What {@link EmailOutboundApprovals.reconcileCardLink} did: `linked` (the draft now carries the
 * link, or already did), `obsolete` (the draft is gone, not a draft or superseded), `unreadable`
 * (the read or the write failed or timed out, or the draft's key stayed held past
 * {@link CARD_LINK_LOCK_WAIT_MS}; logged) or `conflict` (the draft carries a different
 * card, returned as `existing`; nothing written).
 */
export type ReconcileCardLinkResult = { status: 'linked' | 'obsolete' | 'unreadable' } | { status: 'conflict', existing: DraftApprovalCardLink };

/**
 * What {@link EmailOutboundApprovals.readCardTarget} saw, advisory only (read without the draft's
 * key): `active` (a draft that is neither gone nor superseded, with its stored card if any; a
 * decision marker alone does not make it obsolete), `obsolete` (retaining any stored link as
 * possible proof of delivery), or `unreadable` (logged).
 */
export type CardTarget = { status: 'active' | 'obsolete', card?: DraftApprovalCardLink } | { status: 'unreadable' };

type FreshRead = { status: 'ok', draft: WildDuckMessage, meta: DraftApprovalMeta } | { status: 'obsolete', card?: DraftApprovalCardLink } | { status: 'unreadable' };

function cardTarget<T extends 'active' | 'obsolete'>(status: T, card: DraftApprovalCardLink | undefined): { status: T, card?: DraftApprovalCardLink } {
    return card === undefined ? { status } : { status, card };
}

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

/** Two links name the same card when they share a channel and message; `edits` only counts in-place edits of that card. */
function sameCard(a: DraftApprovalCardLink, b: DraftApprovalCardLink): boolean {
    return a.channelId === b.channelId && a.messageId === b.messageId;
}

/**
 * The outbound-email approval operations an admin decision triggers, independent of the UI
 * that collected the decision (the Discord adapter lives in src/integrations/discord/approvals).
 * Inputs are draft UIDs and decisions, never interactions.
 *
 * This class is the only writer of an existing draft's WildDuck metaData (#158). WildDuck
 * replaces metaData wholesale, so every write — the approval marker, the rejection, the card
 * link and `supersededBy` — runs under the draft's key `email-draft:<uid>` on the shared gate
 * (taken here, except for `supersededBy`, whose caller — the amend — already holds it) and
 * merges into a read taken inside that lock, never into an earlier snapshot. Decisions read
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
                    throw new EmailProcessingError(NO_ANSWER);
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
     * Make draft `uid` carry `link` as its approval card, under the draft's lock, from a fresh
     * bounded read, keeping every other metaData key. Idempotent: a stored card with the same
     * channel and message (whatever its `edits`) is already the link, and nothing is written. A
     * different stored card is a `conflict` (returned as `existing`, nothing written) unless it is
     * the one named by `replace` (same channel and message), which is swapped for `link` — a
     * compare-and-set. A draft with no valid card is simply linked. Read and write failures are
     * logged and reported `unreadable`, as is a draft key still held by someone else after
     * {@link CARD_LINK_LOCK_WAIT_MS}: the outbox replay calls this, and must not stall behind a
     * hung amend.
     */
    async reconcileCardLink(uid: number, link: DraftApprovalCardLink, replace?: DraftApprovalCardLink): Promise<ReconcileCardLinkResult> {
        try {
            const locked = await this.withDraftLockWithin(uid, CARD_LINK_LOCK_WAIT_MS, async (): Promise<ReconcileCardLinkResult> => {
                const fresh = await this.readFresh(uid, 'Could not read the draft to reconcile its approval card link');
                if(fresh.status !== 'ok') {
                    return { status: fresh.status };
                }
                const existing = fresh.meta.card;
                if(existing !== undefined) {
                    if(sameCard(existing, link)) {
                        return { status: 'linked' };
                    }
                    if(replace === undefined || !sameCard(existing, replace)) {
                        return { status: 'conflict', existing };
                    }
                }
                await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, uid, mergeDraftMeta(fresh.draft.metaData, { approvalCard: link }));
                return { status: 'linked' };
            });
            if(locked === undefined) {
                logger.warn({ uid, msg: `Could not reconcile the draft's approval card link: its key stayed held for ${CARD_LINK_LOCK_WAIT_MS / 1000}s` });
                return { status: 'unreadable' };
            }
            return locked.value;
        } catch (err: unknown) {
            logger.warn({ err, uid, msg: 'Could not reconcile the draft\'s approval card link' });
            return { status: 'unreadable' };
        }
    }

    /**
     * Where draft `uid`'s approval card is recorded, for deciding whether a card edit is still
     * wanted: a bounded read WITHOUT the draft's key, so advisory only (a decision or amend may
     * land right after). `obsolete` when the draft is gone, not a draft or superseded; a decision
     * marker alone leaves it `active`. A read failure or timeout is logged and `unreadable`.
     */
    async readCardTarget(uid: number): Promise<CardTarget> {
        const fresh = await this.readFresh(uid, 'Could not read the draft to find its approval card');
        if(fresh.status !== 'ok') {
            return fresh;
        }
        return cardTarget('active', fresh.meta.card);
    }

    /**
     * Mark `oldUid` as replaced by `newUid` (when an amend could not delete it), merging into a
     * fresh read so any decision marker is kept. The CALLER must already hold the old draft's key
     * `email-draft:<oldUid>` — the amend does, from its own read through this write, so no
     * decision can land on the old UID before it is superseded — and this method does not take
     * it: the gate is not re-entrant. True when written or when the old UID is already gone;
     * false (logged) on any failure.
     */
    async markSupersededLocked(oldUid: number, newUid: number): Promise<boolean> {
        try {
            const fresh = await this.readBounded(oldUid);
            if(fresh === null) {
                return true;
            }
            if(fresh === undefined) {
                throw new EmailProcessingError(NO_ANSWER);
            }
            await this.deps.wildDuckClient.updateMessageMetadata(EmailFolder.Drafts, oldUid, mergeDraftMeta(fresh.metaData, { supersededBy: newUid }));
            return true;
        } catch (err: unknown) {
            logger.error({ err, oldUid, newUid, msg: 'Could not mark the replaced draft as superseded' });
            return false;
        }
    }

    /**
     * Note an approved send for Izzy without opening a turn: the send has not happened yet, and
     * the outcome reporter tells Izzy (waking them) once it has succeeded or failed. A thrown or
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
     * Run `fn` holding the draft's key, waiting at most `waitMs` for it: `{ value }` with fn's
     * result, or undefined (fn not run) when the key was still held at the deadline. An acquire
     * abandoned that way may still be granted later; it is released at once, so the key is
     * never left held by nobody.
     */
    private async withDraftLockWithin<T>(uid: number, waitMs: number, fn: () => Promise<T>): Promise<{ value: T } | undefined> {
        const acquiring = this.deps.draftLocks.acquire(draftLockKey(uid));
        const acquired = await raceDeadline(acquiring, waitMs, () => {
            void acquiring.then(release => release());
        });
        if(acquired === undefined) {
            return undefined;
        }
        try {
            return { value: await fn() };
        } finally {
            acquired.value();
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

    /**
     * One bounded read of the draft for a card-link operation, never throwing: the draft and its
     * approval metaData, `obsolete` when gone, not a draft or superseded, or `unreadable` (logged
     * with `msg`) on a read error or no answer in time. Takes no lock; the caller decides.
     */
    private async readFresh(uid: number, msg: string): Promise<FreshRead> {
        let draft: WildDuckMessage | null | undefined;
        try {
            draft = await this.readBounded(uid);
        } catch (err: unknown) {
            logger.warn({ err, uid, msg });
            return { status: 'unreadable' };
        }
        if(draft === undefined) {
            logger.warn({ uid, msg: `${msg}: ${NO_ANSWER}` });
            return { status: 'unreadable' };
        }
        if(draft === null) {
            return { status: 'obsolete' };
        }
        const meta = readDraftApprovalMeta(draft.metaData);
        if(draft.draft !== true || meta.supersededBy !== undefined) {
            return cardTarget('obsolete', meta.card);
        }
        return { status: 'ok', draft, meta };
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
