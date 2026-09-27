/**
 * Thin DynamoDB adapters for the one-off tag-index repair (tools/repair-tag-index.ts): the
 * data-plane {@link RepairStore} over the DocumentClient and the control-plane
 * {@link CapacityAdmin} over the low-level client. Throttling is retried with backoff and never
 * fails the run; a failed write condition is a result, not an error.
 */
import { DescribeTableCommand, UpdateTableCommand, type Capacity, type ConsumedCapacity, type DynamoDBClient, type TableDescription } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { CapacityAdmin, CapacityState, Resource, Throughput } from './repair-tag-index-capacity';
import { FIRST_BACKOFF_MS, MAX_BACKOFF_MS, type Memory, type Meta, type RepairStore, type TagRow, type Units, type WriteResult } from './repair-tag-index-core';
import { MemoryToolKeyGenerator } from '@/storage/memory-tool/key-generator';
import type { MemoryPath } from '@/storage/memory-tool/types';

const THROTTLE_ERRORS = new Set<string | undefined>(['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded']);
const ROW_FIELDS = ['updatedAt', 'tags', 'layer', 'contentPreview', 'memoryPath', 'TTL'] as const;

export interface AdapterDeps {
    sleep:  (ms: number) => Promise<void>
    signal: AbortSignal
}

function errorName(error: unknown): string | undefined {
    return (new Object(error) as { name?: string }).name;
}

/** Retries throttled requests from 1 s doubling to 30 s, until the request succeeds or the run is aborted. */
export async function retryThrottled<T>(operation: () => Promise<T>, deps: AdapterDeps): Promise<T> {
    let delay = FIRST_BACKOFF_MS;
    for(;;) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop
            return await operation();
        } catch (error) {
            if(!THROTTLE_ERRORS.has(errorName(error))) {
                throw error;
            }
            deps.signal.throwIfAborted();
            // eslint-disable-next-line no-await-in-loop -- sequential: backoff between retries
            await deps.sleep(delay);
            delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
    }
}

/** The units DynamoDB reported; a missing report stops the run rather than let it go unpaced. */
export function requireUnits(units: number | undefined, label: string): number {
    if(units === undefined) {
        throw new Error(`${label} reported no ConsumedCapacity; refusing to continue unpaced`);
    }
    return units;
}

function writeUnits(capacity: ConsumedCapacity | undefined, label: string): Units {
    // A write that does not touch GSI2 reports no GSI2 entry.
    const gsi2: Capacity | undefined = capacity?.GlobalSecondaryIndexes?.GSI2;
    return { baseWcu: requireUnits(capacity?.Table?.CapacityUnits, label), gsi2Wcu: gsi2?.CapacityUnits };
}

interface ConditionParts {
    ConditionExpression:        string
    ExpressionAttributeNames?:  Record<string, string>
    ExpressionAttributeValues?: Record<string, unknown>
}

/**
 * The condition for mutating an existing row: it still exists and every repaired attribute still
 * equals the observed value, or is still absent. 'absent' requires that no row exists.
 */
export function rowCondition(observed: TagRow | 'absent'): ConditionParts {
    if(observed === 'absent') {
        return { ConditionExpression: 'attribute_not_exists(PK)' };
    }
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const clauses = ['attribute_exists(PK)'];
    for(const field of ROW_FIELDS) {
        names[`#${field}`] = field;
        const value = observed[field];
        if(value === undefined) {
            clauses.push(`attribute_not_exists(#${field})`);
        } else {
            values[`:${field}`] = value;
            clauses.push(`#${field} = :${field}`);
        }
    }
    return {
        ConditionExpression:      clauses.join(' AND '),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
    };
}

/** META's count equals `expected`, or META has no count when `expected` is undefined. */
export function countCondition(expected: number | undefined): ConditionParts {
    return expected === undefined
        ? { ConditionExpression: 'attribute_not_exists(#count)', ExpressionAttributeNames: { '#count': 'count' } }
        : { ConditionExpression: '#count = :expected', ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':expected': expected } };
}

function toMemory(item: Record<string, unknown>): Memory {
    const { path, tags, updatedAt, content, TTL } = item as unknown as Memory;
    return { path, tags, updatedAt, content, TTL };
}

function tagKey(tag: string, path: string): { PK: string, SK: string } {
    return { PK: `TAG#${tag}`, SK: `PATH#${path}` };
}

function metaKey(tag: string): { PK: string, SK: string } {
    return { PK: `TAG#${tag}`, SK: 'META_COUNT' };
}

/** The data-plane port over the DocumentClient. */
export function createRepairStore(client: DynamoDBDocumentClient, tableName: string, deps: AdapterDeps): RepairStore {
    const query = async (label: string, input: Omit<QueryCommandInput, 'TableName' | 'ReturnConsumedCapacity'>): Promise<{ items: Record<string, unknown>[], next: Record<string, unknown> | undefined, units: number }> => {
        const output = await retryThrottled(async () => client.send(new QueryCommand({ TableName: tableName, ReturnConsumedCapacity: 'TOTAL', ...input })), deps);
        return { items: output.Items ?? [], next: output.LastEvaluatedKey, units: requireUnits(output.ConsumedCapacity?.CapacityUnits, label) };
    };
    const write = async (label: string, command: PutCommand | DeleteCommand | UpdateCommand): Promise<WriteResult> => {
        try {
            const output = await retryThrottled(async () => client.send(command as PutCommand), deps);
            return { status: 'ok', units: writeUnits(output.ConsumedCapacity, label) };
        } catch (error) {
            if(errorName(error) !== 'ConditionalCheckFailedException') {
                throw error;
            }
            return { status: 'conditionFailed', units: { baseWcu: 1 } };
        }
    };
    return {
        async listMetaCounts(start) {
            const page = await query('GSI2 TAG_COUNTS query', {
                IndexName:                 'GSI2',
                KeyConditionExpression:    'GSI2PK = :pk',
                ExpressionAttributeValues: { ':pk': 'TAG_COUNTS' },
                ExclusiveStartKey:         start,
            });
            return { items: page.items as unknown as Meta[], next: page.next, units: { gsi2Rcu: page.units } };
        },
        async readTagPartition(tag, start, strong) {
            const page = await query(`TAG#${tag} query`, {
                KeyConditionExpression:    'PK = :pk',
                ExpressionAttributeValues: { ':pk': `TAG#${tag}` },
                ExclusiveStartKey:         start,
                ConsistentRead:            strong,
            });
            const items = page.items as unknown as (TagRow | Meta)[];
            return {
                rows:  items.filter(item => item.SK.startsWith('PATH#')),
                meta:  items.find(item => item.SK === 'META_COUNT'),
                next:  page.next,
                units: { baseRcu: page.units },
            };
        },
        async walkNamespace(namespace, start) {
            const page = await query(`GSI1 LAYER#${namespace} query`, {
                IndexName:                 'GSI1',
                KeyConditionExpression:    'GSI1PK = :pk',
                ExpressionAttributeValues: { ':pk': `LAYER#${namespace}` },
                ExclusiveStartKey:         start,
            });
            return { items: page.items.map(item => toMemory(item)), next: page.next, units: { gsi1Rcu: page.units } };
        },
        async getMemory(path) {
            const { PK, SK } = MemoryToolKeyGenerator.createKeys(path as MemoryPath);
            const output = await retryThrottled(async () => client.send(new GetCommand({ TableName: tableName, Key: { PK, SK }, ConsistentRead: true, ReturnConsumedCapacity: 'TOTAL' })), deps);
            return { item: output.Item === undefined ? undefined : toMemory(output.Item), units: { baseRcu: requireUnits(output.ConsumedCapacity?.CapacityUnits, `GetItem ${path}`) } };
        },
        async getRows(path, tags) {
            const output = await retryThrottled(async () => client.send(new BatchGetCommand({
                RequestItems:           { [tableName]: { Keys: tags.map(tag => tagKey(tag, path)), ConsistentRead: true } },
                ReturnConsumedCapacity: 'TOTAL',
            })), deps);
            const unprocessed = (output.UnprocessedKeys?.[tableName]?.Keys ?? []) as { PK: string }[];
            return {
                items:       (output.Responses?.[tableName] ?? []) as unknown as TagRow[],
                unprocessed: unprocessed.map(key => key.PK.slice(4)),
                units:       { baseRcu: requireUnits(output.ConsumedCapacity?.[0]?.CapacityUnits, `BatchGetItem ${path}`) },
            };
        },
        async putRow(row, observed) {
            return write(`PutItem ${row.PK} ${row.SK}`, new PutCommand({ TableName: tableName, Item: row, ReturnConsumedCapacity: 'INDEXES', ...rowCondition(observed) }));
        },
        async deleteRow(observed) {
            return write(`DeleteItem ${observed.PK} ${observed.SK}`, new DeleteCommand({ TableName: tableName, Key: { PK: observed.PK, SK: observed.SK }, ReturnConsumedCapacity: 'INDEXES', ...rowCondition(observed) }));
        },
        async setMeta(tag, count, expected) {
            const condition = countCondition(expected);
            return write(`UpdateItem TAG#${tag} META_COUNT`, new UpdateCommand({
                TableName:                 tableName,
                Key:                       metaKey(tag),
                UpdateExpression:          'SET #count = :count, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
                ConditionExpression:       condition.ConditionExpression,
                ExpressionAttributeNames:  condition.ExpressionAttributeNames,
                ExpressionAttributeValues: { ...condition.ExpressionAttributeValues, ':count': count, ':gsi2pk': 'TAG_COUNTS', ':gsi2sk': `TAG#${tag}` },
                ReturnConsumedCapacity:    'INDEXES',
            }));
        },
        async deleteMeta(tag, expected) {
            return write(`DeleteItem TAG#${tag} META_COUNT`, new DeleteCommand({ TableName: tableName, Key: metaKey(tag), ReturnConsumedCapacity: 'INDEXES', ...countCondition(expected) }));
        },
    };
}

type Provisioned = TableDescription['ProvisionedThroughput'];

function throughput(status: string | undefined, provisioned: Provisioned): Throughput {
    return {
        status:         status ?? 'UNKNOWN',
        rcu:            provisioned?.ReadCapacityUnits ?? 0,
        wcu:            provisioned?.WriteCapacityUnits ?? 0,
        decreasesToday: provisioned?.NumberOfDecreasesToday ?? 0,
    };
}

/** The control-plane port over the low-level client: DescribeTable and one-resource UpdateTable. */
export function createCapacityAdmin(client: DynamoDBClient, tableName: string): CapacityAdmin {
    return {
        async describe(): Promise<CapacityState> {
            const output = await client.send(new DescribeTableCommand({ TableName: tableName }));
            const table = output.Table;
            if(table === undefined) {
                throw new Error(`DescribeTable returned no table for ${tableName}`);
            }
            const index = (name: Resource): Throughput => {
                const found = table.GlobalSecondaryIndexes?.find(gsi => gsi.IndexName === name);
                if(found === undefined) {
                    throw new Error(`DescribeTable shows no ${name} on ${tableName}`);
                }
                return throughput(found.IndexStatus, found.ProvisionedThroughput);
            };
            return {
                tableName,
                billing:   table.BillingModeSummary?.BillingMode ?? 'PROVISIONED',
                resources: { table: throughput(table.TableStatus, table.ProvisionedThroughput), GSI1: index('GSI1'), GSI2: index('GSI2') },
            };
        },
        async update(resource, rcu, wcu) {
            const provisioned = { ReadCapacityUnits: rcu, WriteCapacityUnits: wcu };
            await client.send(new UpdateTableCommand(resource === 'table'
                ? { TableName: tableName, ProvisionedThroughput: provisioned }
                : { TableName: tableName, GlobalSecondaryIndexUpdates: [{ Update: { IndexName: resource, ProvisionedThroughput: provisioned } }] }));
        },
    };
}
