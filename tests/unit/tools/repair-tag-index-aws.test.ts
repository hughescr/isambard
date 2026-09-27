import { describe, test, expect } from 'bun:test';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
    countCondition,
    createCapacityAdmin,
    createRepairStore,
    requireUnits,
    retryThrottled,
    rowCondition,
    type AdapterDeps
} from '../../../tools/repair-tag-index-aws';
import type { TagRow } from '../../../tools/repair-tag-index-core';

interface Sent {
    name:  string
    input: Record<string, unknown>
}

/** Counts fake operations still settling; a request sent meanwhile means an await was skipped. */
const inFlight = { count: 0 };

async function settle(): Promise<void> {
    inFlight.count++;
    for(let turn = 0; turn < 3; turn++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each turn is one microtask
        await Promise.resolve();
    }
    inFlight.count--;
}

/** A client whose send records each command and replays scripted responses (an Error is thrown). */
function fakeClient(responses: unknown[]): { client: DynamoDBDocumentClient & DynamoDBClient, sent: Sent[] } {
    const sent: Sent[] = [];
    const send = async (command: { constructor: { name: string }, input: Record<string, unknown> }): Promise<unknown> => {
        if(inFlight.count > 0) {
            throw new Error('request sent before the previous operation settled');
        }
        await settle();
        sent.push({ name: command.constructor.name, input: command.input });
        const response = responses.shift();
        if(response instanceof Error) {
            throw response;
        }
        return response;
    };
    return { client: { send } as unknown as DynamoDBDocumentClient & DynamoDBClient, sent };
}

function named(name: string, message = name): Error {
    return Object.assign(new Error(message), { name });
}

/** Deps whose shared backoff records each hold and settles like the pacing's queued wait. */
function adapterDeps(): AdapterDeps & { throttles: string[] } {
    const throttles: string[] = [];
    return {
        throttles,
        onThrottle: async (keys, ms) => {
            throttles.push(`${keys.join('+')} ${ms}`);
            await settle();
        },
    };
}

/** A store over a client that throttles once, then answers `response`. */
function throttledOnce(response: unknown): { store: ReturnType<typeof createRepairStore>, deps: ReturnType<typeof adapterDeps> } {
    const { client } = fakeClient([named('ProvisionedThroughputExceededException'), response]);
    const deps = adapterDeps();
    return { store: createRepairStore(client, 'T', deps), deps };
}

const ROW: TagRow = {
    PK:             'TAG#x',
    SK:             'PATH#/events/a',
    memoryPath:     '/events/a',
    layer:          'events',
    updatedAt:      '2026-01-01T00:00:00.000Z',
    tags:           new Set(['x']),
    contentPreview: 'hello',
    TTL:            2_000_000_000,
};
const SECOND: TagRow = { ...ROW, PK: 'TAG#t5' };

describe('repair-tag-index aws helpers', () => {
    test('retryThrottled retries each throttling error with a doubling backoff capped at 30 s', async () => {
        const deps = adapterDeps();
        const errors = ['ProvisionedThroughputExceededException', 'ThrottlingException', 'RequestLimitExceeded', 'ThrottlingException', 'ThrottlingException', 'ThrottlingException', 'ThrottlingException'];
        let calls = 0;

        const result = await retryThrottled(async () => {
            const error = errors.at(calls++);
            if(error !== undefined) {
                throw named(error);
            }
            return 'done';
        }, ['baseRcu'], deps);

        expect(result).toBe('done');
        expect(deps.throttles).toStrictEqual(['baseRcu 1000', 'baseRcu 2000', 'baseRcu 4000', 'baseRcu 8000', 'baseRcu 16000', 'baseRcu 30000', 'baseRcu 30000']);
    });

    test('retryThrottled sends each retry only once the shared backoff of its resources has ended', async () => {
        const deps = adapterDeps();
        const events: string[] = [];
        let calls = 0;
        deps.onThrottle = async (keys, ms) => {
            events.push(`hold ${keys.join('+')} ${ms}`);
            await settle();
            events.push('hold ended');
        };

        await retryThrottled(async () => {
            events.push('send');
            if(calls++ < 2) {
                throw named('ThrottlingException');
            }
            return 'done';
        }, ['baseWcu', 'gsi2Wcu'], deps);

        expect(events).toStrictEqual(['send', 'hold baseWcu+gsi2Wcu 1000', 'hold ended', 'send', 'hold baseWcu+gsi2Wcu 2000', 'hold ended', 'send']);
    });

    test('retryThrottled rethrows any other error without retrying', async () => {
        const deps = adapterDeps();

        await expect(retryThrottled(async () => {
            throw named('ValidationException', 'bad request');
        }, ['baseRcu'], deps)).rejects.toThrow('bad request');
        await expect(retryThrottled(async () => {
            throw 'plain failure';
        }, ['baseRcu'], deps)).rejects.toBe('plain failure');
        expect(deps.throttles).toStrictEqual([]);
    });

    test('retryThrottled stops retrying once the pacing refuses the wait (abort or a fatal error)', async () => {
        const deps = adapterDeps();
        let calls = 0;
        deps.onThrottle = async () => {
            throw new Error('fatal elsewhere');
        };

        await expect(retryThrottled(async () => {
            calls++;
            throw named('ThrottlingException');
        }, ['baseRcu'], deps)).rejects.toThrow('fatal elsewhere');
        expect(calls).toBe(1);
    });

    test('every request holds the resources it uses when throttled', async () => {
        const page = { Items: [], ConsumedCapacity: { CapacityUnits: 1 } };
        const write = { ConsumedCapacity: { Table: { CapacityUnits: 1 } } };
        const calls: [string, (store: ReturnType<typeof createRepairStore>) => Promise<unknown>, unknown][] = [
            ['gsi2Rcu 1000', async store => store.listMetaCounts(undefined), page],
            ['baseRcu 1000', async store => store.readTagPartition('x', undefined, true), page],
            ['gsi1Rcu 1000', async store => store.walkNamespace('identity', undefined), page],
            ['baseRcu 1000', async store => store.getMemory('/identity/a'), { ConsumedCapacity: { CapacityUnits: 1 } }],
            ['baseRcu 1000', async store => store.getRows('/identity/a', ['x']), { ConsumedCapacity: [{ CapacityUnits: 1 }] }],
            ['baseWcu 1000', async store => store.putRow(ROW, 'absent'), write],
            ['baseWcu 1000', async store => store.deleteRow(ROW), write],
            ['baseWcu+gsi2Wcu 1000', async store => store.setMeta('x', 1, undefined), write],
            ['baseWcu+gsi2Wcu 1000', async store => store.deleteMeta('x', 1), write],
        ];

        for(const [expected, call, response] of calls) {
            const { store, deps } = throttledOnce(response);
            // eslint-disable-next-line no-await-in-loop -- sequential: one fake client per call
            await call(store);
            expect(deps.throttles).toStrictEqual([expected]);
        }
    });

    test('requireUnits returns reported units and refuses a missing report', () => {
        expect(requireUnits(0.5, 'label')).toBe(0.5);
        expect(() => requireUnits(undefined, 'Query X')).toThrow('Query X reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('rowCondition for an absent row requires that no row exists', () => {
        expect(rowCondition('absent')).toStrictEqual({ ConditionExpression: 'attribute_not_exists(PK)' });
    });

    test('rowCondition compares every repaired attribute of a row with a TTL', () => {
        expect(rowCondition(ROW)).toStrictEqual({
            ConditionExpression:       'attribute_exists(PK) AND #updatedAt = :updatedAt AND #tags = :tags AND #layer = :layer AND #contentPreview = :contentPreview AND #memoryPath = :memoryPath AND #TTL = :TTL',
            ExpressionAttributeNames:  { '#updatedAt': 'updatedAt', '#tags': 'tags', '#layer': 'layer', '#contentPreview': 'contentPreview', '#memoryPath': 'memoryPath', '#TTL': 'TTL' },
            ExpressionAttributeValues: {
                ':updatedAt':      '2026-01-01T00:00:00.000Z',
                ':tags':           new Set(['x']),
                ':layer':          'events',
                ':contentPreview': 'hello',
                ':memoryPath':     '/events/a',
                ':TTL':            2_000_000_000,
            },
        });
    });

    test('rowCondition requires absent attributes to stay absent', () => {
        const { TTL: _ttl, contentPreview: _preview, ...permanent } = ROW;
        expect(rowCondition(permanent).ConditionExpression).toBe('attribute_exists(PK) AND #updatedAt = :updatedAt AND #tags = :tags AND #layer = :layer AND attribute_not_exists(#contentPreview) AND #memoryPath = :memoryPath AND attribute_not_exists(#TTL)');
        expect(rowCondition(permanent).ExpressionAttributeValues).toStrictEqual({ ':updatedAt': ROW.updatedAt, ':tags': ROW.tags, ':layer': 'events', ':memoryPath': '/events/a' });
    });

    test('rowCondition omits empty attribute values for a row with only keys', () => {
        expect(rowCondition({ PK: 'TAG#x', SK: 'PATH#/a' })).toStrictEqual({
            ConditionExpression:      'attribute_exists(PK) AND attribute_not_exists(#updatedAt) AND attribute_not_exists(#tags) AND attribute_not_exists(#layer) AND attribute_not_exists(#contentPreview) AND attribute_not_exists(#memoryPath) AND attribute_not_exists(#TTL)',
            ExpressionAttributeNames: { '#updatedAt': 'updatedAt', '#tags': 'tags', '#layer': 'layer', '#contentPreview': 'contentPreview', '#memoryPath': 'memoryPath', '#TTL': 'TTL' },
        });
    });

    test('rowCondition includes attribute values when exactly one repaired attribute exists', () => {
        expect(rowCondition({ PK: 'TAG#x', SK: 'PATH#/a', layer: 'events' }).ExpressionAttributeValues).toStrictEqual({ ':layer': 'events' });
    });

    test('countCondition matches the count read or its absence', () => {
        expect(countCondition(3)).toStrictEqual({ ConditionExpression: '#count = :expected', ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':expected': 3 } });
        expect(countCondition(undefined)).toStrictEqual({ ConditionExpression: 'attribute_not_exists(#count)', ExpressionAttributeNames: { '#count': 'count' } });
    });
});

describe('repair-tag-index aws repair store reads', () => {
    test('listMetaCounts queries GSI2 TAG_COUNTS and charges GSI2 read units', async () => {
        const { client, sent } = fakeClient([{ Items: [{ PK: 'TAG#a', SK: 'META_COUNT', count: 1 }], LastEvaluatedKey: { k: 1 }, ConsumedCapacity: { CapacityUnits: 0.5 } }]);
        const store = createRepairStore(client, 'T', adapterDeps());

        const page = await store.listMetaCounts({ start: 1 });

        expect(page).toStrictEqual({ items: [{ PK: 'TAG#a', SK: 'META_COUNT', count: 1 }], next: { k: 1 }, units: { gsi2Rcu: 0.5 } });
        const input = {
            TableName:                 'T',
            ReturnConsumedCapacity:    'TOTAL',
            IndexName:                 'GSI2',
            KeyConditionExpression:    'GSI2PK = :pk',
            ExpressionAttributeValues: { ':pk': 'TAG_COUNTS' },
            ExclusiveStartKey:         { start: 1 },
        };
        expect(sent).toStrictEqual([{ name: 'QueryCommand', input }]);
    });

    test('listMetaCounts identifies the GSI2 query when capacity is missing', async () => {
        const { client } = fakeClient([{ Items: [] }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).listMetaCounts(undefined)).rejects.toThrow('GSI2 TAG_COUNTS query reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('readTagPartition splits PATH rows from META and honours strong reads', async () => {
        const meta = { PK: 'TAG#x', SK: 'META_COUNT', count: 2 };
        const { client, sent } = fakeClient([
            { Items: [meta, ROW, { PK: 'TAG#x', SK: 'OTHER' }], ConsumedCapacity: { CapacityUnits: 1 } },
            { ConsumedCapacity: { CapacityUnits: 0.5 } },
        ]);
        const store = createRepairStore(client, 'T', adapterDeps());

        expect(await store.readTagPartition('x', undefined, true)).toStrictEqual({ rows: [ROW], meta, next: undefined, units: { baseRcu: 1 } });
        expect(await store.readTagPartition('x', undefined, false)).toStrictEqual({ rows: [], meta: undefined, next: undefined, units: { baseRcu: 0.5 } });
        expect(sent[0]?.input).toStrictEqual({
            TableName:                 'T',
            ReturnConsumedCapacity:    'TOTAL',
            KeyConditionExpression:    'PK = :pk',
            ExpressionAttributeValues: { ':pk': 'TAG#x' },
            ExclusiveStartKey:         undefined,
            ConsistentRead:            true,
        });
        expect(sent[1]?.input.ConsistentRead).toBe(false);
    });

    test('readTagPartition excludes non-prefix PATH keys and finds META after a path row', async () => {
        const meta = { PK: 'TAG#x', SK: 'META_COUNT', count: 1 };
        const { client } = fakeClient([{ Items: [ROW, { PK: 'TAG#x', SK: 'OTHER_PATH#/events/a' }, meta], ConsumedCapacity: { CapacityUnits: 1 } }]);

        expect(await createRepairStore(client, 'T', adapterDeps()).readTagPartition('x', undefined, true)).toStrictEqual({ rows: [ROW], meta, next: undefined, units: { baseRcu: 1 } });
    });

    test('a read without ConsumedCapacity stops the run', async () => {
        const { client } = fakeClient([{ Items: [] }]);
        const store = createRepairStore(client, 'T', adapterDeps());

        await expect(store.readTagPartition('x', undefined, true)).rejects.toThrow('TAG#x query reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('walkNamespace queries GSI1 and maps memories', async () => {
        const item = { PK: 'DIR#/events', SK: 'FILE#a', path: '/events/a', tags: new Set(['x']), updatedAt: 'u', content: 'c', TTL: 5, metadata: {} };
        const { client, sent } = fakeClient([{ Items: [item, { path: '/events/b', updatedAt: 'v', content: 'd' }], ConsumedCapacity: { CapacityUnits: 2 } }]);
        const store = createRepairStore(client, 'T', adapterDeps());

        const page = await store.walkNamespace('events', undefined);

        expect(page).toStrictEqual({
            items: [
                { path: '/events/a', tags: new Set(['x']), updatedAt: 'u', content: 'c', TTL: 5 },
                { path: '/events/b', tags: undefined, updatedAt: 'v', content: 'd', TTL: undefined },
            ],
            next:  undefined,
            units: { gsi1Rcu: 2 },
        });
        expect(sent[0]?.input).toStrictEqual({
            TableName:                 'T',
            ReturnConsumedCapacity:    'TOTAL',
            IndexName:                 'GSI1',
            KeyConditionExpression:    'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': 'LAYER#events' },
            ExclusiveStartKey:         undefined,
        });
    });

    test('walkNamespace identifies its namespace when capacity is missing', async () => {
        const { client } = fakeClient([{ Items: [] }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).walkNamespace('events', undefined)).rejects.toThrow('GSI1 LAYER#events query reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('a query without Items yields no items', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: { CapacityUnits: 1 } }]);

        const page = await createRepairStore(client, 'T', adapterDeps()).walkNamespace('state', undefined);

        expect(page.items).toStrictEqual([]);
    });

    test('getMemory reads the memory row strongly by its directory keys', async () => {
        const { client, sent } = fakeClient([
            { Item: { path: '/identity/core.md', updatedAt: 'u', content: 'c' }, ConsumedCapacity: { CapacityUnits: 1 } },
            { ConsumedCapacity: { CapacityUnits: 0.5 } },
        ]);
        const store = createRepairStore(client, 'T', adapterDeps());

        expect(await store.getMemory('/identity/core.md')).toStrictEqual({ item: { path: '/identity/core.md', tags: undefined, updatedAt: 'u', content: 'c', TTL: undefined }, units: { baseRcu: 1 } });
        expect(await store.getMemory('/identity/core.md')).toStrictEqual({ item: undefined, units: { baseRcu: 0.5 } });
        expect(sent[0]).toStrictEqual({ name: 'GetCommand', input: { TableName: 'T', Key: { PK: 'DIR#/identity', SK: 'FILE#core.md' }, ConsistentRead: true, ReturnConsumedCapacity: 'TOTAL' } });
    });

    test('getMemory without ConsumedCapacity stops the run', async () => {
        const { client } = fakeClient([{}]);

        await expect(createRepairStore(client, 'T', adapterDeps()).getMemory('/identity/a')).rejects.toThrow('GetItem /identity/a reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('getRows sends one strong BatchGetItem and reports its rows, unprocessed tags and units', async () => {
        const { client, sent } = fakeClient([
            { Responses: { T: [ROW, SECOND] }, UnprocessedKeys: { T: { Keys: [{ PK: 'TAG#t7', SK: 'PATH#/events/a' }, { PK: 'TAG#t9', SK: 'PATH#/events/a' }] } }, ConsumedCapacity: [{ CapacityUnits: 2 }] },
        ]);
        const deps = adapterDeps();

        const result = await createRepairStore(client, 'T', deps).getRows('/events/a', ['t1', 't5', 't7', 't9']);

        expect(result).toStrictEqual({ items: [ROW, SECOND], unprocessed: ['t7', 't9'], units: { baseRcu: 2 } });
        expect(sent).toStrictEqual([{
            name:  'BatchGetCommand',
            input: {
                RequestItems:           { T: { Keys: ['t1', 't5', 't7', 't9'].map(tag => ({ PK: `TAG#${tag}`, SK: 'PATH#/events/a' })), ConsistentRead: true } },
                ReturnConsumedCapacity: 'TOTAL',
            },
        }]);
        expect(deps.throttles).toStrictEqual([]);
    });

    test('getRows reports no rows and no unprocessed tags when the response has neither', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: [{ CapacityUnits: 1 }] }]);

        expect(await createRepairStore(client, 'T', adapterDeps()).getRows('/a', ['x'])).toStrictEqual({ items: [], unprocessed: [], units: { baseRcu: 1 } });
    });

    test('getRows reports no unprocessed tags when UnprocessedKeys holds no other table entry', async () => {
        const { client } = fakeClient([{ Responses: {}, UnprocessedKeys: {}, ConsumedCapacity: [{ CapacityUnits: 1 }] }]);

        expect(await createRepairStore(client, 'T', adapterDeps()).getRows('/a', ['x'])).toStrictEqual({ items: [], unprocessed: [], units: { baseRcu: 1 } });
    });

    test('getRows without ConsumedCapacity stops the run', async () => {
        const { client } = fakeClient([{ Responses: { T: [] } }, { Responses: { T: [] }, ConsumedCapacity: [] }]);
        const store = createRepairStore(client, 'T', adapterDeps());

        await expect(store.getRows('/a', ['x'])).rejects.toThrow('BatchGetItem /a reported no ConsumedCapacity; refusing to continue unpaced');
        await expect(store.getRows('/a', ['x'])).rejects.toThrow('BatchGetItem /a reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('reads retry throttling', async () => {
        const { client, sent } = fakeClient([named('ThrottlingException'), { Item: undefined, ConsumedCapacity: { CapacityUnits: 1 } }]);
        const deps = adapterDeps();

        const read = await createRepairStore(client, 'T', deps).getMemory('/identity/a');

        expect(read.item).toBeUndefined();
        expect(sent).toHaveLength(2);
        expect(deps.throttles).toStrictEqual(['baseRcu 1000']);
    });
});

describe('repair-tag-index aws repair store writes', () => {
    test('putRow writes the row conditioned on the observed row and reports base and GSI2 units', async () => {
        const { client, sent } = fakeClient([{ ConsumedCapacity: { CapacityUnits: 1, Table: { CapacityUnits: 1 } } }]);
        const store = createRepairStore(client, 'T', adapterDeps());

        expect(await store.putRow(ROW, ROW)).toStrictEqual({ status: 'ok', units: { baseWcu: 1, gsi2Wcu: undefined } });
        expect(sent).toStrictEqual([{ name: 'PutCommand', input: { TableName: 'T', Item: ROW, ReturnConsumedCapacity: 'INDEXES', ...rowCondition(ROW) } }]);
    });

    test('putRow identifies the row when write capacity is missing', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: {} }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).putRow(ROW, ROW)).rejects.toThrow('PutItem TAG#x PATH#/events/a reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('putRow of a missing row requires that it is still absent', async () => {
        const { client, sent } = fakeClient([{ ConsumedCapacity: { Table: { CapacityUnits: 1 } } }]);

        await createRepairStore(client, 'T', adapterDeps()).putRow(ROW, 'absent');

        expect(sent[0]?.input).toStrictEqual({ TableName: 'T', Item: ROW, ReturnConsumedCapacity: 'INDEXES', ConditionExpression: 'attribute_not_exists(PK)' });
    });

    test('a failed condition is a result that charges one write unit', async () => {
        const { client } = fakeClient([named('ConditionalCheckFailedException')]);

        expect(await createRepairStore(client, 'T', adapterDeps()).deleteRow(ROW)).toStrictEqual({ status: 'conditionFailed', units: { baseWcu: 1 } });
    });

    test('other write errors propagate', async () => {
        const { client } = fakeClient([named('ValidationException', 'bad write')]);

        await expect(createRepairStore(client, 'T', adapterDeps()).deleteRow(ROW)).rejects.toThrow('bad write');
    });

    test('a write without table ConsumedCapacity stops the run', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: { CapacityUnits: 1 } }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).deleteRow(ROW)).rejects.toThrow('DeleteItem TAG#x PATH#/events/a reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('deleteRow deletes the observed row conditioned on it', async () => {
        const { client, sent } = fakeClient([{ ConsumedCapacity: { Table: { CapacityUnits: 1 } } }]);

        await createRepairStore(client, 'T', adapterDeps()).deleteRow(ROW);

        expect(sent).toStrictEqual([{ name: 'DeleteCommand', input: { TableName: 'T', Key: { PK: 'TAG#x', SK: 'PATH#/events/a' }, ReturnConsumedCapacity: 'INDEXES', ...rowCondition(ROW) } }]);
    });

    test('setMeta sets the count and both GSI2 keys conditioned on the count read', async () => {
        const { client, sent } = fakeClient([
            { ConsumedCapacity: { Table: { CapacityUnits: 1 }, GlobalSecondaryIndexes: { GSI2: { CapacityUnits: 1 } } } },
            { ConsumedCapacity: { Table: { CapacityUnits: 1 }, GlobalSecondaryIndexes: { GSI2: { CapacityUnits: 2 } } } },
        ]);
        const store = createRepairStore(client, 'T', adapterDeps());

        expect(await store.setMeta('x', 2, 5)).toStrictEqual({ status: 'ok', units: { baseWcu: 1, gsi2Wcu: 1 } });
        await store.setMeta('x', 2, undefined);

        const common = {
            TableName:              'T',
            Key:                    { PK: 'TAG#x', SK: 'META_COUNT' },
            UpdateExpression:       'SET #count = :count, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk',
            ReturnConsumedCapacity: 'INDEXES',
        };
        expect(sent).toStrictEqual([
            { name: 'UpdateCommand', input: { ...common, ConditionExpression: '#count = :expected', ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':expected': 5, ':count': 2, ':gsi2pk': 'TAG_COUNTS', ':gsi2sk': 'TAG#x' } } },
            { name: 'UpdateCommand', input: { ...common, ConditionExpression: 'attribute_not_exists(#count)', ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':count': 2, ':gsi2pk': 'TAG_COUNTS', ':gsi2sk': 'TAG#x' } } },
        ]);
    });

    test('setMeta identifies its tag when write capacity is missing', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: {} }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).setMeta('x', 2, 1)).rejects.toThrow('UpdateItem TAG#x META_COUNT reported no ConsumedCapacity; refusing to continue unpaced');
    });

    test('deleteMeta deletes META conditioned on the count read', async () => {
        const { client, sent } = fakeClient([{ ConsumedCapacity: { Table: { CapacityUnits: 1 }, GlobalSecondaryIndexes: { GSI2: { CapacityUnits: 1 } } } }]);

        await createRepairStore(client, 'T', adapterDeps()).deleteMeta('x', 4);

        expect(sent).toStrictEqual([{ name: 'DeleteCommand', input: { TableName: 'T', Key: { PK: 'TAG#x', SK: 'META_COUNT' }, ReturnConsumedCapacity: 'INDEXES', ...countCondition(4) } }]);
    });

    test('deleteMeta identifies its tag when write capacity is missing', async () => {
        const { client } = fakeClient([{ ConsumedCapacity: {} }]);

        await expect(createRepairStore(client, 'T', adapterDeps()).deleteMeta('x', 4)).rejects.toThrow('DeleteItem TAG#x META_COUNT reported no ConsumedCapacity; refusing to continue unpaced');
    });
});

describe('repair-tag-index aws capacity admin', () => {
    const description = {
        Table: {
            TableStatus:            'ACTIVE',
            ProvisionedThroughput:  { ReadCapacityUnits: 5, WriteCapacityUnits: 2, NumberOfDecreasesToday: 1 },
            GlobalSecondaryIndexes: [
                { IndexName: 'GSI2', IndexStatus: 'UPDATING', ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1, NumberOfDecreasesToday: 3 } },
                { IndexName: 'GSI1', IndexStatus: 'ACTIVE', ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 2, NumberOfDecreasesToday: 0 } },
            ],
        },
    };

    test('describe maps table and GSI status, capacity and decreases today', async () => {
        const { client, sent } = fakeClient([description]);

        expect(await createCapacityAdmin(client, 'T').describe()).toStrictEqual({
            tableName: 'T',
            billing:   'PROVISIONED',
            resources: {
                table: { status: 'ACTIVE', rcu: 5, wcu: 2, decreasesToday: 1 },
                GSI1:  { status: 'ACTIVE', rcu: 2, wcu: 2, decreasesToday: 0 },
                GSI2:  { status: 'UPDATING', rcu: 1, wcu: 1, decreasesToday: 3 },
            },
        });
        expect(sent).toStrictEqual([{ name: 'DescribeTableCommand', input: { TableName: 'T' } }]);
    });

    test('describe maps on-demand billing and missing throughput', async () => {
        const { client } = fakeClient([{ Table: {
            BillingModeSummary:     { BillingMode: 'PAY_PER_REQUEST' },
            GlobalSecondaryIndexes: [{ IndexName: 'GSI1' }, { IndexName: 'GSI2' }],
        } }]);

        expect(await createCapacityAdmin(client, 'T').describe()).toStrictEqual({
            tableName: 'T',
            billing:   'PAY_PER_REQUEST',
            resources: {
                table: { status: 'UNKNOWN', rcu: 0, wcu: 0, decreasesToday: 0 },
                GSI1:  { status: 'UNKNOWN', rcu: 0, wcu: 0, decreasesToday: 0 },
                GSI2:  { status: 'UNKNOWN', rcu: 0, wcu: 0, decreasesToday: 0 },
            },
        });
    });

    test('describe fails without a table or a GSI', async () => {
        await expect(createCapacityAdmin(fakeClient([{}]).client, 'T').describe()).rejects.toThrow('DescribeTable returned no table for T');
        await expect(createCapacityAdmin(fakeClient([{ Table: { GlobalSecondaryIndexes: [{ IndexName: 'GSI1' }] } }]).client, 'T').describe()).rejects.toThrow('DescribeTable shows no GSI2 on T');
        await expect(createCapacityAdmin(fakeClient([{ Table: {} }]).client, 'T').describe()).rejects.toThrow('DescribeTable shows no GSI1 on T');
    });

    test('update propagates an UpdateTable failure', async () => {
        const { client } = fakeClient([named('LimitExceededException', 'too many decreases')]);

        await expect(createCapacityAdmin(client, 'T').update('GSI1', 2, 2)).rejects.toThrow('too many decreases');
    });

    test('update sends one UpdateTable for the table or one GSI', async () => {
        const { client, sent } = fakeClient([{}, {}]);
        const admin = createCapacityAdmin(client, 'T');

        await admin.update('table', 50, 50);
        await admin.update('GSI2', 1, 50);

        expect(sent).toStrictEqual([
            { name: 'UpdateTableCommand', input: { TableName: 'T', ProvisionedThroughput: { ReadCapacityUnits: 50, WriteCapacityUnits: 50 } } },
            { name: 'UpdateTableCommand', input: { TableName: 'T', GlobalSecondaryIndexUpdates: [{ Update: { IndexName: 'GSI2', ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 50 } } }] } },
        ]);
    });
});
