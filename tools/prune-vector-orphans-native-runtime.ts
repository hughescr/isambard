import { BatchGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Resource } from 'sst';
import { clientDestroyer, sleepForRateLimit } from './backfill-vectors-runtime-builder';
import type { BatchGetKeysResult, ItemKey, PruneDependencies } from './prune-vector-orphans';
import { loadDynamoDBConfig } from '@/config';
import { createDynamoDBClient, VectorIndex } from '@/storage';

function toKey(item: Record<string, unknown>): ItemKey {
    return { PK: String(item.PK), SK: String(item.SK) };
}

/**
 * A keys-only, strongly consistent BatchGetItem against one table. A delete decision must not
 * rest on an eventually consistent read; a missing key still costs 1 RCU either way.
 */
export function createBatchGetKeys(
    docClient: Pick<DynamoDBDocumentClient, 'send'>,
    tableName: string
): (keys: ItemKey[]) => Promise<BatchGetKeysResult> {
    return async (keys) => {
        const output = await docClient.send(new BatchGetCommand({
            RequestItems: {
                [tableName]: {
                    Keys:                     keys.map(key => ({ PK: key.PK, SK: key.SK })),
                    ProjectionExpression:     '#pk, #sk',
                    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
                    ConsistentRead:           true,
                },
            },
            ReturnConsumedCapacity: 'TOTAL',
        }));
        const units = (output.ConsumedCapacity ?? [])
            .filter(entry => entry.TableName === tableName && entry.CapacityUnits !== undefined)
            .map(entry => entry.CapacityUnits ?? 0);
        return {
            found:             (output.Responses?.[tableName] ?? []).map(item => toKey(item)),
            unprocessed:       (output.UnprocessedKeys?.[tableName]?.Keys ?? []).map(item => toKey(item)),
            consumedReadUnits: units.length === 0 ? undefined : units.reduce((sum, value) => sum + value, 0),
        };
    };
}

export interface PruneNativeServices {
    resource:     typeof Resource
    loadConfig:   typeof loadDynamoDBConfig
    createClient: typeof createDynamoDBClient
    Index:        Pick<typeof VectorIndex, 'open'>
    now:          () => number
    sleep:        (ms: number) => Promise<void>
    write:        (message: string) => void
}

export const productionPruneServices: PruneNativeServices = {
    resource:     Resource,
    loadConfig:   loadDynamoDBConfig,
    createClient: createDynamoDBClient,
    Index:        VectorIndex,
    now:          Date.now,
    sleep:        sleepForRateLimit,
    write:        (message) => { process.stdout.write(message); },
};

export function createNativePruneDependencies(services: PruneNativeServices = productionPruneServices): PruneDependencies {
    return {
        openStorage: () => {
            const { client, docClient, tableName } = services.createClient(services.loadConfig(services.resource));
            return {
                tableName,
                batchGetKeys: createBatchGetKeys(docClient, tableName),
                destroy:      clientDestroyer(client),
            };
        },
        openVectorIndex: dbPath => services.Index.open(dbPath),
        now:             () => services.now(),
        sleep:           ms => services.sleep(ms),
        write:           (message) => { services.write(message); },
    };
}
