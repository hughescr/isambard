import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import {
    approvedOutboundActionSchema,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionState,
    type ClaimedApprovedOutboundAction,
    type FailureKind
} from './types';
import { InvariantViolationError } from '@/errors';
import { DynamoTableAccess, createPrefixedKey } from '@/storage';

// The DynamoDB key layout predates the ApprovedOutboundAction rename (#40) and is kept
// unchanged so existing rows stay addressable.
const ACTION_PK        = 'APPROVAL#SAGA';
const ACTION_SK_PREFIX = 'SAGA';

const TTL_DAYS = 30;

function actionSK(id: string): string {
    return createPrefixedKey(ACTION_SK_PREFIX, id);
}

/** What a failed execution records. */
export interface ActionFailure {
    lastError:   string
    failureKind: FailureKind
}

/** What the holder of a claim records once its send's outcome is known. */
export type ClaimOutcome = { state: 'executed' } | ({ state: 'failed' } & ActionFailure);

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
            return to === 'executed' || to === 'failed';
        }
        case 'failed': {
            return to === 'approved' && prior.failureKind === 'transient';
        }
        case 'executed': {
            return false;
        }
    }
}

function isConditionalCheckFailure(err: unknown): boolean {
    return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/**
 * The fields of `prior` that carry over into its next state. `failureKind` describes only the
 * current failure, `outcomeReportPending` and `outcomeNotified` only the current outcome (a retry
 * reset drops an unreported failure, because the new attempt's own outcome supersedes it, and a
 * new terminal revision must notify Izzy afresh), and `claimId` only the current claim, so every
 * transition drops all four and re-adds what it needs.
 */
function carriedFields(prior: ApprovedOutboundAction): Omit<ApprovedOutboundAction, 'failureKind' | 'outcomeReportPending' | 'outcomeNotified' | 'claimId'> {
    const { failureKind: _failureKind, outcomeReportPending: _reportPending, outcomeNotified: _notified, claimId: _claimId, ...rest } = prior;
    return rest;
}

/**
 * Enforce the ApprovedOutboundAction lifecycle: `approved → sending` (the executor's claim),
 * `sending → executed` and `sending → failed` (settling that claim), and
 * `failed(transient) → approved` (retry on reconnect). Anything else — including sending
 * without a claim, `executed → approved` and resetting a permanent or unclassified failure —
 * throws.
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
     * Reset a transiently failed action to `approved` so the executor retries it — the one
     * transition that is not the executor's claim or settle. The prior row is read consistently,
     * the move is checked by {@link assertTransition}, and the whole row is rewritten with a put
     * conditioned on the state and `updatedAt` revision that was read and on the stored failure
     * still being transient, so a reset that raced another writer fails instead of overwriting
     * it. If the action is not found, logs a warning and returns.
     */
    async updateState(id: string, to: 'approved'): Promise<void> {
        const prior = await this.get(id);
        if(prior === undefined) {
            logger.warn({ id, to }, 'ApprovedOutboundActionBackend.updateState: action not found');
            return;
        }

        assertTransition(prior, to);

        await this.putTransition(prior, { ...carriedFields(prior), state: to, updatedAt: new Date().toISOString() }, {
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
     * propagates, and the caller must then not send.
     */
    async claim(action: ApprovedOutboundAction): Promise<ClaimedApprovedOutboundAction | undefined> {
        assertTransition(action, 'sending');
        const claimed: ClaimedApprovedOutboundAction = {
            ...carriedFields(action),
            state:     'sending',
            claimId:   crypto.randomUUID(),
            updatedAt: new Date().toISOString(),
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
     * Record the outcome of a claimed send: `sending → executed`, or `sending → failed` with its
     * failure, in the same put as the outcome-report marker (`outcomeReportPending`). The put is
     * conditioned on the row still holding this claim's `claimId` — a random id, never a
     * wall-clock revision two claims could share — so a late settle can never overwrite a later
     * claim of the same row. No read. Returns false (writing nothing) when the claim was already
     * resolved: by an earlier attempt of this settle that landed though its response was lost,
     * or by another process's stale-claim sweep. Any other failure propagates.
     */
    async settleClaim(claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome): Promise<boolean> {
        const { state, ...failure } = outcome;
        assertTransition(claimed, state);
        try {
            await this.putTransition(claimed, {
                ...carriedFields(claimed),
                ...failure,
                outcomeReportPending: true,
                state,
                updatedAt:            new Date().toISOString(),
            }, {
                ConditionExpression:       '#state = :from AND #claimId = :claimId',
                ExpressionAttributeNames:  { '#state': 'state', '#claimId': 'claimId' },
                ExpressionAttributeValues: { ':from': 'sending', ':claimId': claimed.claimId },
            });
        } catch (err: unknown) {
            if(isConditionalCheckFailure(err)) {
                return false;
            }
            throw err;
        }
        return true;
    }

    /**
     * List all actions that are in the given state, with a strongly consistent query.
     */
    async listByState(state: ApprovedOutboundActionState): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listByState', {
            FilterExpression:          '#state = :state',
            ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
            ExpressionAttributeValues: { ':pk': ACTION_PK, ':state': state },
        });
    }

    /**
     * List the executor's open work — `approved` rows to claim and `sending` rows whose claim may
     * have been abandoned — with one strongly consistent query, so a pass never sees a row as
     * `approved` after its claim succeeded, and a wake right after a create sees the new row.
     */
    async listOpen(): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listOpen', {
            FilterExpression:          '#state IN (:approved, :sending)',
            ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
            ExpressionAttributeValues: { ':pk': ACTION_PK, ':approved': 'approved', ':sending': 'sending' },
        });
    }

    /**
     * List the terminal actions whose outcome has not yet been reported (see
     * `outcomeReportPending` on the schema), with a strongly consistent query so a report never
     * shows an outcome older than the latest one already written.
     */
    async listPendingOutcomeReports(): Promise<ApprovedOutboundAction[]> {
        return this.listWhere('listPendingOutcomeReports', {
            FilterExpression:          '#pending = :pending',
            ExpressionAttributeNames:  { '#pk': 'PK', '#pending': 'outcomeReportPending' },
            ExpressionAttributeValues: { ':pk': ACTION_PK, ':pending': true },
        });
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

    private async listWhere(operation: string, filter: {
        FilterExpression:          string
        ExpressionAttributeNames:  Record<string, string>
        ExpressionAttributeValues: Record<string, unknown>
    }): Promise<ApprovedOutboundAction[]> {
        const items = await this.query({
            KeyConditionExpression: '#pk = :pk',
            ...filter,
            ConsistentRead:         true,
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
