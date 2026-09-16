import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { allowlistSagaSchema, type AllowlistSaga } from './types';
import { BaseRepository, createPrefixedKey } from '@/storage';

const SAGA_PK        = 'ALLOWLIST#SAGA';
const SAGA_SK_PREFIX = 'SAGA';

const TTL_DAYS = 30;

function sagaSK(id: string): string {
    return createPrefixedKey(SAGA_SK_PREFIX, id);
}

/**
 * DynamoDB backend for persisting allowlist saga state.
 * Makes multi-step allowlist workflows durable across service outages.
 */
export class AllowlistSagaBackend extends BaseRepository<AllowlistSaga> {
    /**
     * Persist a new allowlist saga with a 30-day TTL.
     */
    async create(saga: AllowlistSaga): Promise<void> {
        await this.putItem({
            PK:  SAGA_PK,
            SK:  sagaSK(saga.id),
            ...saga,
            TTL: AllowlistSagaBackend.ttlFromDays(TTL_DAYS),
        });
    }

    /**
     * Retrieve a saga by ID. Returns undefined if not found.
     */
    async get(id: string): Promise<AllowlistSaga | undefined> {
        const item = await this.getItem<Record<string, unknown>>({
            PK: SAGA_PK,
            SK: sagaSK(id),
        });
        if(item === undefined) {
            return undefined;
        }
        return allowlistSagaSchema.parse(item);
    }

    /**
     * Update fields of an existing saga.
     * If the saga is not found, logs a warning and returns (idempotent).
     */
    async update(id: string, updates: Partial<AllowlistSaga>): Promise<void> {
        const saga = await this.get(id);
        if(saga === undefined) {
            logger.warn({ id, updates }, 'AllowlistSagaBackend.update: saga not found');
            return;
        }

        const updated: AllowlistSaga = {
            ...saga,
            ...updates,
            updatedAt: new Date().toISOString(),
        };

        // Recompute TTL from createdAt to match the TTL set at creation time.
        const originalTTL = Math.floor(new Date(saga.createdAt).getTime() / 1000) + (TTL_DAYS * 24 * 60 * 60);

        // Use docClient directly to include ConditionExpression for optimistic concurrency.
        // putItem() in BaseRepository does not support condition expressions.
        await this.docClient.send(new PutCommand({
            TableName: this.tableName,
            Item:      {
                PK:  SAGA_PK,
                SK:  sagaSK(id),
                ...updated,
                TTL: originalTTL,
            },
            ConditionExpression:       '#state = :expectedState',
            ExpressionAttributeNames:  { '#state': 'state' },
            ExpressionAttributeValues: { ':expectedState': saga.state },
        }));
    }
}
