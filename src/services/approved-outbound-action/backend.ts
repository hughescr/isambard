import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import {
    approvedOutboundActionSchema,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionState,
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

function describeState(action: ApprovedOutboundAction): string {
    return action.state === 'failed' ? `failed(${action.failureKind ?? 'unclassified'})` : action.state;
}

function isLegalTransition(prior: ApprovedOutboundAction, to: ApprovedOutboundActionState): boolean {
    switch(prior.state) {
        case 'approved': {
            return to !== 'approved';
        }
        case 'failed': {
            return to === 'approved' && prior.failureKind === 'transient';
        }
        case 'executed': {
            return false;
        }
    }
}

/**
 * Enforce the ApprovedOutboundAction lifecycle: `approved → executed`, `approved → failed`,
 * and `failed(transient) → approved` (retry on reconnect). Anything else — including
 * `executed → approved` and resetting a permanent or unclassified failure — throws.
 */
export function assertTransition(prior: ApprovedOutboundAction, to: ApprovedOutboundActionState): void {
    if(!isLegalTransition(prior, to)) {
        throw new InvariantViolationError(
            'ApprovedOutboundActionBackend.updateState',
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
     * Move an action to a new state. The prior row is read consistently, the move is checked by
     * {@link assertTransition}, and the whole row is rewritten with a put conditioned on the
     * state and `updatedAt` revision that was read — plus, for a retry reset, on the stored
     * failure still being transient — so a move that raced another writer fails instead of
     * overwriting it. The TTL is recomputed from `createdAt`, so a state change never removes
     * the row's expiry. If the action is not found, logs a warning and returns.
     */
    async updateState(id: string, to: 'approved' | 'executed'): Promise<void>;
    async updateState(id: string, to: 'failed', failure: ActionFailure): Promise<void>;
    async updateState(id: string, to: ApprovedOutboundActionState, failure?: ActionFailure): Promise<void> {
        const prior = await this.get(id);
        if(prior === undefined) {
            logger.warn({ id, to }, 'ApprovedOutboundActionBackend.updateState: action not found');
            return;
        }

        assertTransition(prior, to);

        // failureKind describes only the current failure; a reset or completion drops it.
        const { failureKind: _priorFailureKind, ...rest } = prior;
        const next: ApprovedOutboundAction = {
            ...rest,
            ...failure,
            state:     to,
            updatedAt: new Date().toISOString(),
        };

        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:  ACTION_PK,
                SK:  actionSK(id),
                ...next,
                TTL: ApprovedOutboundActionBackend.expiresAt(new Date(prior.createdAt), { days: TTL_DAYS }),
            },
            ...transitionCondition(prior, to),
        }));
    }

    /**
     * List all actions that are in the given state.
     */
    async listByState(state: ApprovedOutboundActionState): Promise<ApprovedOutboundAction[]> {
        const items = await this.query({
            KeyConditionExpression:    '#pk = :pk',
            FilterExpression:          '#state = :state',
            ExpressionAttributeNames:  { '#pk': 'PK', '#state': 'state' },
            ExpressionAttributeValues: {
                ':pk':    ACTION_PK,
                ':state': state,
            },
        });

        const results: ApprovedOutboundAction[] = [];
        for(const item of items) {
            const parsed = approvedOutboundActionSchema.safeParse(item);
            if(parsed.success) {
                results.push(parsed.data);
            } else {
                // Stryker disable next-line llm: zod's ZodError.toString() is defined as () => this.message, so both spellings log the identical string.
                logger.warn({ item, error: parsed.error.message }, 'ApprovedOutboundActionBackend.listByState: failed to parse action');
            }
        }
        return results;
    }
}

function transitionCondition(prior: ApprovedOutboundAction, to: ApprovedOutboundActionState): {
    ConditionExpression:       string
    ExpressionAttributeNames:  Record<string, string>
    ExpressionAttributeValues: Record<string, string>
} {
    const revision = {
        ConditionExpression:       '#state = :from AND #updatedAt = :revision',
        ExpressionAttributeNames:  { '#state': 'state', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':from': prior.state, ':revision': prior.updatedAt },
    };
    if(to !== 'approved') {
        return revision;
    }
    // A retry reset must never overwrite a failure that became permanent after the read.
    return {
        ConditionExpression:       `${revision.ConditionExpression} AND #failureKind = :transient`,
        ExpressionAttributeNames:  { ...revision.ExpressionAttributeNames, '#failureKind': 'failureKind' },
        ExpressionAttributeValues: { ...revision.ExpressionAttributeValues, ':transient': 'transient' },
    };
}
