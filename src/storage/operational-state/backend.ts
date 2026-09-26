import {
    GetCommand,
    PutCommand,
    QueryCommand,
    type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { DynamoTableAccess } from '../repositories/base';
import { decodeOperationalState } from './decode';
import type {
    OperationalStateItem,
    OperationalStateKey,
    OperationalStateOwner,
    OperationalStateRead,
    OperationalStateSchema,
    OperationalStateStore
} from './types';

function partitionKey(owner: OperationalStateOwner): string {
    return `OPERATIONAL_STATE#${owner}`;
}

function toItem(key: OperationalStateKey, value: unknown): OperationalStateItem {
    return {
        PK:        partitionKey(key.owner),
        SK:        key.name,
        content:   JSON.stringify(value),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * DynamoDB backend for the `OPERATIONAL_STATE#<owner>` partitions (key scheme: ./types.ts).
 * Rows carry no `GSI1PK`/`GSI1SK`, no tag rows and no vector-index job, so replay cursors never
 * reach `LAYER#state` queries — the same deliberate isolation as the session journal
 * (src/storage/session-journal/backend.ts).
 *
 * Reads use `ConsistentRead: true`: the Discord checkpoint manager's read-modify-write treats a
 * primary miss as "fall back to the frozen legacy row", so an eventually-consistent miss straight
 * after a put could otherwise resurrect a stale cursor.
 */
export class OperationalStateBackend extends DynamoTableAccess implements OperationalStateStore {
    async read<T>(key: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<OperationalStateRead<T>> {
        const result = await this.docClient.send(new GetCommand({
            TableName:      this.tableName,
            Key:            { PK: partitionKey(key.owner), SK: key.name },
            ConsistentRead: true,
        }));
        if(result.Item === undefined) {
            return { status: 'absent' };
        }
        return decodeOperationalState(result.Item.content, schema);
    }

    async put(key: OperationalStateKey, value: unknown): Promise<void> {
        await this.putItem(toItem(key, value));
    }

    /**
     * Writes `value` under `key` only when no row exists there yet, as one conditional PutItem.
     * It exists for the one-shot checkpoint migration (tools/migrate-checkpoints.ts): a row the bot
     * wrote since the deploy is newer than any legacy row, so it always wins, even when the bot
     * writes between a check and the put. Deliberately not on {@link OperationalStateStore}.
     *
     * @returns `'created'` when the row was written, `'exists'` when a row was already there.
     * @throws Any DynamoDB error other than the conditional-check failure.
     */
    async putIfAbsent(key: OperationalStateKey, value: unknown): Promise<'created' | 'exists'> {
        try {
            await this.docClient.send(new PutCommand({
                TableName:           this.tableName,
                Item:                toItem(key, value),
                ConditionExpression: 'attribute_not_exists(PK)',
            }));
            return 'created';
        } catch (error) {
            if(error instanceof Error && error.name === 'ConditionalCheckFailedException') {
                return 'exists';
            }
            throw error;
        }
    }

    async listByPrefix<T>(prefix: OperationalStateKey, schema: OperationalStateSchema<T>): Promise<T[]> {
        const values: T[] = [];
        let lastEvaluatedKey: Record<string, unknown> | undefined;

        do {
            const params: QueryCommandInput = {
                TableName:                 this.tableName,
                KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
                ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
                ExpressionAttributeValues: { ':pk': partitionKey(prefix.owner), ':prefix': prefix.name },
                ConsistentRead:            true,
                ExclusiveStartKey:         lastEvaluatedKey,
            };
            // eslint-disable-next-line no-await-in-loop -- sequential pagination required by DynamoDB
            const result = await this.docClient.send(new QueryCommand(params));
            for(const raw of result.Items ?? []) {
                const decoded = decodeOperationalState(raw.content, schema);
                if(decoded.status === 'valid') {
                    values.push(decoded.value);
                } else {
                    logger.warn({
                        owner:  prefix.owner,
                        name:   raw.SK,
                        reason: decoded.reason,
                        err:    decoded.error,
                        msg:    'OperationalStateBackend.listByPrefix(): skipping undecodable row',
                    });
                }
            }
            lastEvaluatedKey = result.LastEvaluatedKey;
        } while(lastEvaluatedKey);

        return values;
    }
}
