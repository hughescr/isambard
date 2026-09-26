import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import {
    adminPingSchema,
    approvedOutboundActionSchema,
    type AdminPing,
    type ApprovalCardRef,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionState,
    type ClaimedApprovedOutboundAction,
    type FailureKind,
    type UnverifiedApprovedOutboundAction
} from './types';
import { InvariantViolationError } from '@/errors';
import { DynamoTableAccess, createPrefixedKey } from '@/storage';

// The DynamoDB key layout predates the ApprovedOutboundAction rename (#40) and is kept
// unchanged so existing rows stay addressable.
const ACTION_PK        = 'APPROVAL#SAGA';
const ACTION_SK_PREFIX = 'SAGA';
/** Each action's one admin-ping record (#125) sits under the action's own sort key, in its own partition. */
const ADMIN_PING_PK    = 'APPROVAL#ADMIN_PING';

const TTL_DAYS = 30;

function actionSK(id: string): string {
    return createPrefixedKey(ACTION_SK_PREFIX, id);
}

/** What a failed execution records. */
export interface ActionFailure {
    lastError:   string
    failureKind: FailureKind
}

/**
 * What the holder of a claim records once its send has ended: `executed`, `failed` with its
 * failure, or `unverified` when the send's outcome is unknown and must be checked at the
 * destination (#108).
 */
export type ClaimOutcome = { state: 'executed' } | ({ state: 'failed' } & ActionFailure) | { state: 'unverified', lastError: string };

/** What a destination check resolves an `unverified` row to: found, or definitely absent and so to be sent again. */
export type DeliveryResolution = 'executed' | 'approved';

interface WriteCondition {
    ConditionExpression:       string
    ExpressionAttributeNames:  Record<string, string>
    ExpressionAttributeValues: Record<string, string>
}

function describeState(action: ApprovedOutboundAction): string {
    return action.state === 'failed' ? `failed(${action.failureKind ?? 'unclassified'})` : action.state;
}

function isLegalTransition(prior: ApprovedOutboundAction, to: ApprovedOutboundActionState): boolean {
    switch(prior.state) {
        case 'approved': {
            return to === 'sending';
        }
        case 'sending': {
            return to === 'executed' || to === 'failed' || to === 'unverified';
        }
        case 'unverified': {
            return to === 'executed' || to === 'approved';
        }
        case 'failed': {
            return (to === 'approved' || to === 'unverified') && prior.failureKind === 'transient';
        }
        case 'executed': {
            return false;
        }
    }
}

function isConditionalCheckFailure(err: unknown): boolean {
    return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/** Who resolved an `unverified` row other than a destination check: the admin, from its escalated card (#125). */
export type UnverifiedResolver = 'admin';

/**
 * The fields of `prior` that carry over into its next state. `failureKind` describes only the
 * current failure, `outcomeReportPending` and `outcomeNotified` only the current outcome (a retry
 * reset drops an unreported failure, because the new attempt's own outcome supersedes it, and a
 * new terminal revision must notify Izzy afresh), `claimId` only the current claim, and
 * `escalated` only the current unknown episode (#125), so every transition drops all five and
 * re-adds what it needs. Everything else carries. (The row-lifetime admin ping is recorded in
 * its own item, so no transition can drop it.)
 */
function carriedFields(prior: ApprovedOutboundAction): Omit<ApprovedOutboundAction, 'failureKind' | 'outcomeReportPending' | 'outcomeNotified' | 'claimId' | 'escalated'> {
    const { failureKind: _failureKind, outcomeReportPending: _reportPending, outcomeNotified: _notified, claimId: _claimId, escalated: _escalated, ...rest } = prior;
    return rest;
}

/**
 * Enforce the ApprovedOutboundAction lifecycle: `approved → sending` (the executor's claim),
 * `sending → executed`, `sending → failed` and `sending → unverified` (settling that claim),
 * `unverified → executed` and `unverified → approved` (a destination check found it, or found it
 * definitely absent), and `failed(transient) → approved` or `failed(transient) → unverified`
 * (on reconnect: a retry, or a check first for a failure an older build may have mislabelled).
 * Anything else — including sending without a claim, resending an unverified row without a
 * check, `executed → approved` and resetting a permanent or unclassified failure — throws.
 */
export function assertTransition(prior: ApprovedOutboundAction, to: ApprovedOutboundActionState): void {
    if(!isLegalTransition(prior, to)) {
        throw new InvariantViolationError(
            'ApprovedOutboundActionBackend.assertTransition',
            `illegal transition ${describeState(prior)} -> ${to}`
        );
    }
}

/**
 * DynamoDB backend for approved outbound actions: durable records of already-approved Bluesky
 * replies/DMs and email sends, so they survive service outages until executed.
 */
export class ApprovedOutboundActionBackend extends DynamoTableAccess {
    /**
     * Persist a newly approved action with a 30-day TTL.
     */
    async create(action: ApprovedOutboundAction): Promise<void> {
        await this.putItem({
            PK:  ACTION_PK,
            SK:  actionSK(action.id),
            ...action,
            TTL: ApprovedOutboundActionBackend.expiresAt(Date.now(), { days: TTL_DAYS }),
        });
    }

    /**
     * Retrieve an action by ID with a strongly consistent read, so a transition that starts
     * after another one succeeded always observes it. Returns undefined if not found.
     */
    async get(id: string): Promise<ApprovedOutboundAction | undefined> {
        const { Item } = await this.docClient.send(new GetCommand({
            TableName:      this.tableName,
            Key:            { PK: ACTION_PK, SK: actionSK(id) },
            ConsistentRead: true,
        }));
        if(Item === undefined) {
            return undefined;
        }
        return approvedOutboundActionSchema.parse(Item);
    }

    /**
     * Move a transiently failed action on when its service reconnects: to `approved` so the
     * executor retries it, or to `unverified` so the executor checks the destination first (for a
     * failure an older build may have mislabelled transient). The prior row is read consistently,
     * the move is checked by {@link assertTransition}, and the whole row is rewritten with a put
     * conditioned on the state and `updatedAt` revision that was read and on the stored failure
     * still being transient, so a reset that raced another writer fails instead of overwriting
     * it. A move to `unverified` carries the outcome-report marker, so the approval card shows the
     * check. If the action is not found, logs a warning and returns.
     */
    async updateState(id: string, to: 'approved' | 'unverified'): Promise<void> {
        const prior = await this.get(id);
        if(prior === undefined) {
            logger.warn({ id, to }, 'ApprovedOutboundActionBackend.updateState: action not found');
            return;
        }

        assertTransition(prior, to);

        const marker = to === 'unverified' ? { outcomeReportPending: true } : {};
        await this.putTransition(prior, { ...carriedFields(prior), ...marker, state: to, updatedAt: new Date().toISOString() }, {
            ConditionExpression:       '#state = :from AND #updatedAt = :revision AND #failureKind = :transient',
            ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#failureKind': 'failureKind' },
            ExpressionAttributeValues: { ':from': prior.state, ':revision': prior.updatedAt, ':transient': 'transient' },
        });
    }

    /**
     * Claim a listed `approved` row for sending, before any external call: `approved → sending`
     * with a fresh random `claimId`, in a put conditioned on the state and `updatedAt` revision
     * that was listed. No read — the listing was strongly consistent, and the condition catches
     * anything newer. Returns the claimed row, or undefined (writing nothing) when the condition
     * fails because another process claimed the row first or it moved on. Any other failure
     * propagates, and the caller must then not send. The first claim of a row also records
     * `firstClaimedAt`, which later claims keep: the start of the window a destination check
     * searches.
     */
    async claim(action: ApprovedOutboundAction): Promise<ClaimedApprovedOutboundAction | undefined> {
        assertTransition(action, 'sending');
        const now = new Date().toISOString();
        const claimed: ClaimedApprovedOutboundAction = {
            ...carriedFields(action),
            state:          'sending',
            claimId:        crypto.randomUUID(),
            firstClaimedAt: action.firstClaimedAt ?? now,
            updatedAt:      now,
        };
        try {
            await this.putTransition(action, claimed, {
                ConditionExpression:       '#state = :from AND #updatedAt = :revision',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':from': 'approved', ':revision': action.updatedAt },
            });
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return undefined;
            }
            throw err;
        }
        return claimed;
    }

    /**
     * Record the outcome of a claimed send: `sending → executed`, `sending → failed` with its
     * failure, or `sending → unverified` (outcome unknown, which also counts one more
     * `ambiguousSends`), in the same put as the outcome-report marker (`outcomeReportPending`).
     * The put is conditioned on the row still holding this claim's `claimId` — a random id, never
     * a wall-clock revision two claims could share — so a late settle can never overwrite a later
     * claim of the same row. No read. Returns the exact written row, or undefined (writing
     * nothing) when the claim was already resolved: by an earlier attempt of this settle that
     * landed though its response was lost, or by another process's stale-claim sweep. Any other
     * failure propagates.
     */
    async settleClaim(claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome): Promise<ApprovedOutboundAction | undefined> {
        const { state, ...failure } = outcome;
        assertTransition(claimed, state);
        const ambiguous = state === 'unverified' ? { ambiguousSends: (claimed.ambiguousSends ?? 0) + 1 } : {};
        const next: ApprovedOutboundAction = {
            ...carriedFields(claimed),
            ...failure,
            ...ambiguous,
            outcomeReportPending: true,
            state,
            updatedAt:            new Date().toISOString(),
        };
        try {
            await this.putTransition(claimed, next, {
                ConditionExpression:       '#state = :from AND #claimId = :claimId',
                ExpressionAttributeNames:  { '#state': 'state', '#claimId': 'claimId' },
                ExpressionAttributeValues: { ':from': 'sending', ':claimId': claimed.claimId },
            });
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return undefined;
            }
            throw err;
        }
        return next;
    }

    /**
     * Resolve a listed `unverified` row once a destination check has decided: `executed` (found
     * there, with the outcome-report marker so the card and Izzy hear it was sent) or `approved`
     * (definitely absent, so the executor sends it again; like a retry reset, this drops any
     * unreported interim report). A whole-row put conditioned on the state and `updatedAt`
     * revision that was listed, so of two processes that checked the same row only one resolves
     * it. No read. Returns the written row, or undefined (writing nothing) when the row moved on.
     * Any other failure propagates.
     *
     * The admin resolves an escalated row through this same conditional put (#125): "Mark sent"
     * passes `resolvedBy: 'admin'`, recorded on the `executed` row only, so its report says the
     * destination never confirmed it; "Resend" resets to `approved` like a definite absence. The
     * row-lifetime admin-ping record is a separate item this put never touches, so a snapshot
     * taken before the ping — such as the one a timed-out send's late success resolves (#126) —
     * still resolves its episode.
     */
    async resolveUnverified(action: UnverifiedApprovedOutboundAction, to: DeliveryResolution, resolvedBy?: UnverifiedResolver): Promise<ApprovedOutboundAction | undefined> {
        assertTransition(action, to);
        const resolution = resolvedBy === undefined ? {} : { resolvedBy };
        const marker = to === 'executed' ? { outcomeReportPending: true, ...resolution } : {};
        const next: ApprovedOutboundAction = { ...carriedFields(action), ...marker, state: to, updatedAt: new Date().toISOString() };
        try {
            await this.putTransition(action, next, {
                ConditionExpression:       '#state = :from AND #updatedAt = :revision',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
                ExpressionAttributeValues: { ':from': 'unverified', ':revision': action.updatedAt },
            });
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return undefined;
            }
            throw err;
        }
        return next;
    }

    /**
     * List every action, in any state, with a strongly consistent query: what a destination check
     * compares an unverified row against, to tell whether another action could look the same there.
     */
    async listAll(): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listAll');
    }

    /**
     * List all actions that are in the given state, with a strongly consistent query.
     */
    async listByState(state: ApprovedOutboundActionState): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listByState', {
            FilterExpression:          '#state = :state',
            ExpressionAttributeNames:  { '#state': 'state' },
            ExpressionAttributeValues: { ':state': state },
        });
    }

    /**
     * List the executor's open work — `approved` rows to claim, `sending` rows whose claim may
     * have been abandoned, and `unverified` rows to check at their destination — with one
     * strongly consistent query, so a pass never sees a row as `approved` after its claim
     * succeeded, and a wake right after a create sees the new row.
     */
    async listOpen(): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listOpen', {
            FilterExpression:          '#state IN (:approved, :sending, :unverified)',
            ExpressionAttributeNames:  { '#state': 'state' },
            ExpressionAttributeValues: { ':approved': 'approved', ':sending': 'sending', ':unverified': 'unverified' },
        });
    }

    /**
     * List the outcome reporter's work with one strongly consistent query, so a report never shows
     * an outcome older than the latest one already written: the actions whose outcome has not yet
     * been reported (see `outcomeReportPending` on the schema), and the unescalated `unverified`
     * rows whose outcome has been unknown since `escalateBefore` or earlier (#125). The query reads
     * the same partition either way, so the escalation scan costs no extra read capacity. Every
     * `updatedAt` is written by `toISOString`, so comparing the strings compares the instants.
     */
    async listOutcomeReportWork(escalateBefore: string): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listOutcomeReportWork', {
            FilterExpression:          '#pending = :pending OR (#state = :unverified AND #updatedAt <= :escalateBefore AND attribute_not_exists(#escalated))',
            ExpressionAttributeNames:  { '#pending': 'outcomeReportPending', '#state': 'state', '#updatedAt': 'updatedAt', '#escalated': 'escalated' },
            ExpressionAttributeValues: { ':pending': true, ':unverified': 'unverified', ':escalateBefore': escalateBefore },
        });
    }

    /**
     * Escalate the listed unknown episode of an `unverified` row to the admin (#125): mark it
     * `escalated` with its outcome report pending, so the reporter redraws its card with the
     * admin's controls and pings the admin. When the listed row's report had already been
     * delivered, it is reopened, marked as notified to Izzy (she was already told the outcome is
     * unknown); when its interim report is still pending — Izzy or the card not yet told — the
     * escalation joins that report and leaves whether Izzy was told as it is, so an undelivered
     * interim report never holds the escalation back. Conditioned on the row still being
     * `unverified` at the listed `updatedAt` revision, not yet escalated, and with its report
     * still in the listed state, so of two processes only one escalates. `updatedAt` is left
     * unchanged: it stays the episode's clock and revision, so destination checks and a late
     * success still resolve it. Returns the escalated row, or undefined (writing nothing) when the
     * condition fails. Any other failure propagates.
     */
    async escalate(action: ApprovedOutboundAction): Promise<ApprovedOutboundAction | undefined> {
        const joinsPendingReport = action.outcomeReportPending === true;
        const update: { UpdateExpression: string, ConditionExpression: string, ExpressionAttributeNames: Record<string, string> } = joinsPendingReport
            ? {
                UpdateExpression:         'SET #escalated = :true',
                ConditionExpression:      '#state = :unverified AND #updatedAt = :revision AND #pending = :true AND attribute_not_exists(#escalated)',
                ExpressionAttributeNames: { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#escalated': 'escalated' },
            }
            : {
                UpdateExpression:         'SET #pending = :true, #notified = :true, #escalated = :true',
                ConditionExpression:      '#state = :unverified AND #updatedAt = :revision AND attribute_not_exists(#pending) AND attribute_not_exists(#escalated)',
                ExpressionAttributeNames: { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#notified': 'outcomeNotified', '#escalated': 'escalated' },
            };
        try {
            await this.docClient.send(new UpdateCommand({
                TableName:                 this.tableName,
                Key:                       { PK: ACTION_PK, SK: actionSK(action.id) },
                ...update,
                ExpressionAttributeValues: { ':unverified': 'unverified', ':revision': action.updatedAt, ':true': true },
            }));
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return undefined;
            }
            throw err;
        }
        return joinsPendingReport
            ? { ...action, escalated: true }
            : { ...action, outcomeReportPending: true, outcomeNotified: true, escalated: true };
    }

    /**
     * Read the record of this action's one admin ping (#125) with a strongly consistent read;
     * undefined when no ping has been recorded.
     */
    async getAdminPing(id: string): Promise<AdminPing | undefined> {
        const { Item } = await this.docClient.send(new GetCommand({
            TableName:      this.tableName,
            Key:            { PK: ADMIN_PING_PK, SK: actionSK(id) },
            ConsistentRead: true,
        }));
        return Item === undefined ? undefined : adminPingSchema.parse(Item);
    }

    /**
     * Record that the one admin ping for this row was accepted by Discord (#125), with the ping
     * message when it carried the controls, in its own item expiring with the row. The record is
     * independent of the row's state and revision: a ping accepted while a check or the admin
     * moved the row on is still recorded, and no later transition of the row can erase it. Written
     * only if absent, so the first record stands; one already there (another process pinged too —
     * the unavoidable window between an external send and its record) is left as it is. Any other
     * failure propagates.
     */
    async markAdminNotified(action: ApprovedOutboundAction, message?: ApprovalCardRef): Promise<void> {
        const item = {
            PK:  ADMIN_PING_PK,
            SK:  actionSK(action.id),
            ...(message === undefined ? {} : { message }),
            TTL: ApprovedOutboundActionBackend.expiresAt(new Date(action.createdAt), { days: TTL_DAYS }),
        };
        try {
            await this.docClient.send(new PutCommand({
                TableName:                this.tableName,
                Item:                     item,
                ConditionExpression:      'attribute_not_exists(#pk)',
                ExpressionAttributeNames: { '#pk': 'PK' },
            }));
        } catch (err: unknown) {
            if(!isConditionalCheckFailure(err)) {
                throw err;
            }
        }
    }

    /**
     * Record accepted notification for exactly the pending outcome revision. A conditional
     * failure means the row moved on; a real database failure propagates so delivery retries.
     * Leave updatedAt unchanged so concurrent state transitions retain their revision guard.
     */
    async markOutcomeNotified(action: ApprovedOutboundAction): Promise<boolean> {
        try {
            await this.docClient.send(new UpdateCommand({
                TableName:                 this.tableName,
                Key:                       { PK: ACTION_PK, SK: actionSK(action.id) },
                UpdateExpression:          'SET #notified = :notified',
                ConditionExpression:       '#state = :state AND #updatedAt = :revision AND #pending = :pending',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#notified': 'outcomeNotified' },
                ExpressionAttributeValues: { ':state': action.state, ':revision': action.updatedAt, ':pending': true, ':notified': true },
            }));
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return false;
            }
            throw err;
        }
        return true;
    }

    /**
     * Clear the outcome-report marker for exactly the outcome that was reported: the update is
     * conditioned on the state and `updatedAt` revision that was read. Returns false (and
     * changes nothing) when the row has moved on since — a retry reset or a newer outcome, whose
     * own report is still to come. Any other failure propagates. `updatedAt` is left unchanged,
     * so a concurrent retry reset's own conditional put still succeeds.
     */
    async markOutcomeReported(action: ApprovedOutboundAction): Promise<boolean> {
        try {
            await this.docClient.send(new UpdateCommand({
                TableName:                 this.tableName,
                Key:                       { PK: ACTION_PK, SK: actionSK(action.id) },
                UpdateExpression:          'REMOVE #pending, #notified',
                ConditionExpression:       '#state = :state AND #updatedAt = :revision AND #pending = :pending',
                ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt', '#pending': 'outcomeReportPending', '#notified': 'outcomeNotified' },
                ExpressionAttributeValues: { ':state': action.state, ':revision': action.updatedAt, ':pending': true },
            }));
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return false;
            }
            throw err;
        }
        return true;
    }

    /**
     * Rewrite the whole row as `next`, conditioned by `condition`. The TTL is recomputed from
     * `createdAt`, so a state change never removes the row's expiry.
     */
    private async putTransition(prior: ApprovedOutboundAction, next: ApprovedOutboundAction, condition: WriteCondition): Promise<void> {
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:  ACTION_PK,
                SK:  actionSK(prior.id),
                ...next,
                TTL: ApprovedOutboundActionBackend.expiresAt(new Date(prior.createdAt), { days: TTL_DAYS }),
            },
            ...condition,
        }));
    }

    /** Query the actions partition, optionally filtered, and parse each row (skipping unparseable ones). */
    private async listWhere(operation: string, filter?: {
        FilterExpression:          string
        ExpressionAttributeNames:  Record<string, string>
        ExpressionAttributeValues: Record<string, unknown>
    }): Promise<ApprovedOutboundAction[]> {
        const items = await this.query({
            KeyConditionExpression:    '#pk = :pk',
            ...filter,
            ExpressionAttributeNames:  { '#pk': 'PK', ...filter?.ExpressionAttributeNames },
            ExpressionAttributeValues: { ':pk': ACTION_PK, ...filter?.ExpressionAttributeValues },
            ConsistentRead:            true,
        });

        const results: ApprovedOutboundAction[] = [];
        for(const item of items) {
            const parsed = approvedOutboundActionSchema.safeParse(item);
            if(parsed.success) {
                results.push(parsed.data);
            } else {
                // Stryker disable next-line llm: zod's ZodError.toString() is defined as () => this.message, so both spellings log the identical string.
                logger.warn({ item, error: parsed.error.message }, `ApprovedOutboundActionBackend.${operation}: failed to parse action`);
            }
        }
        return results;
    }
}
