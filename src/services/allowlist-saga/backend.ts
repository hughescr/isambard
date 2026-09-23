import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import {
    allowlistSagaSchema,
    type AllowlistSaga,
    type OpenAllowlistSaga,
    type PendingNameAllowlistSaga,
    type PendingReviewAllowlistSaga
} from './types';
import { BaseRepository, createPrefixedKey, type ContactId } from '@/storage';

const SAGA_PK        = 'ALLOWLIST#SAGA';
const SAGA_SK_PREFIX = 'SAGA';

const TTL_DAYS = 30;

function sagaSK(id: string): string {
    return createPrefixedKey(SAGA_SK_PREFIX, id);
}

/** Outcome of reading a saga row: present and valid, absent, or present but unparseable. */
export type AllowlistSagaLookup
    = | { status: 'found', saga: AllowlistSaga }
      | { status: 'not_found' }
      | { status: 'invalid' };

/**
 * DynamoDB backend for persisting allowlist saga state.
 * Makes multi-step allowlist workflows durable across service outages.
 *
 * State only moves through the typed transitions below. Each writes a whole,
 * schema-validated row conditioned on the state of the saga the caller loaded,
 * so a step that raced another step fails instead of overwriting it.
 */
export class AllowlistSagaBackend extends BaseRepository<AllowlistSaga> {
    /**
     * Persist a new allowlist saga with a 30-day TTL.
     */
    async create(saga: PendingNameAllowlistSaga): Promise<void> {
        await this.putItem({
            PK:  SAGA_PK,
            SK:  sagaSK(saga.id),
            ...saga,
            TTL: AllowlistSagaBackend.ttlFromDays(TTL_DAYS),
        });
    }

    /**
     * Retrieve a saga by ID with a strongly consistent read, so an interaction that
     * starts after a transition succeeded always observes that transition.
     * A stored row that fails validation is logged and reported as `invalid`.
     */
    async get(id: string): Promise<AllowlistSagaLookup> {
        const { Item } = await this.docClient.send(new GetCommand({
            TableName:      this.tableName,
            Key:            { PK: SAGA_PK, SK: sagaSK(id) },
            ConsistentRead: true,
        }));
        if(Item === undefined) {
            return { status: 'not_found' };
        }
        const result = allowlistSagaSchema.safeParse(Item);
        if(!result.success) {
            logger.warn({ id, issues: result.error.issues }, 'AllowlistSagaBackend.get: stored saga failed validation');
            return { status: 'invalid' };
        }
        return { status: 'found', saga: result.data };
    }

    /** pending_name → pending_review, reviewing the first fuzzy match. */
    async enterReview(
        saga: PendingNameAllowlistSaga,
        review: { adminDisplayName: string, fuzzyMatches: PendingReviewAllowlistSaga['fuzzyMatches'] }
    ): Promise<void> {
        await this.transition(saga, {
            ...saga,
            state:            'pending_review',
            adminDisplayName: review.adminDisplayName,
            fuzzyMatches:     review.fuzzyMatches,
            matchIndex:       0,
        });
    }

    /** pending_review → pending_review, moving the review cursor. */
    async advanceCursor(saga: PendingReviewAllowlistSaga, matchIndex: number): Promise<void> {
        await this.transition(saga, { ...saga, matchIndex });
    }

    /**
     * pending_name | pending_review → completed.
     * The completed arm's parse strips the review-only fields carried over from the prior row.
     */
    async complete(saga: OpenAllowlistSaga, resultPersonId: ContactId): Promise<void> {
        await this.transition(saga, { ...saga, state: 'completed', resultPersonId });
    }

    private async transition(prior: AllowlistSaga, next: AllowlistSaga): Promise<void> {
        // Validate before writing so a malformed row (e.g. an out-of-range cursor) is never persisted.
        const row = allowlistSagaSchema.parse({ ...next, updatedAt: new Date().toISOString() });

        // Recompute TTL from createdAt to match the TTL set at creation time.
        const originalTTL = Math.floor(new Date(row.createdAt).getTime() / 1000) + (TTL_DAYS * 24 * 60 * 60);

        // Use docClient directly to include ConditionExpression for optimistic concurrency.
        // putItem() in BaseRepository does not support condition expressions.
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:  SAGA_PK,
                SK:  sagaSK(row.id),
                ...row,
                TTL: originalTTL,
            },
            ConditionExpression:       '#state = :expectedState',
            ExpressionAttributeNames:  { '#state': 'state' },
            ExpressionAttributeValues: { ':expectedState': prior.state },
        }));
    }
}
