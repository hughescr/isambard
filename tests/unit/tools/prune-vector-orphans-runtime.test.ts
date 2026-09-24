import { afterEach, describe, expect, jest, mock, spyOn, test } from 'bun:test';
import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import {
    createBatchGetKeys,
    createNativePruneDependencies,
    productionPruneServices,
    type PruneNativeServices
} from '../../../tools/prune-vector-orphans-native-runtime';

afterEach(() => {
    jest.restoreAllMocks();
});

const KEYS = [{ PK: 'DIR#/events/activity/chat', SK: 'FILE#a' }, { PK: 'DIR#/events/activity/chat', SK: 'FILE#b' }];

function fakeClient(output: Partial<BatchGetCommandOutput>) {
    return { send: mock(async (_command: BatchGetCommand) => output) };
}

describe('createBatchGetKeys', () => {
    test('sends a strongly consistent, keys-only BatchGetItem that reports consumed capacity', async () => {
        const client = fakeClient({ ConsumedCapacity: [{ TableName: 'memory', CapacityUnits: 2 }] });
        await createBatchGetKeys(client as never, 'memory')(KEYS);
        const command = client.send.mock.calls[0][0];
        expect(command).toBeInstanceOf(BatchGetCommand);
        expect(command.input).toEqual({
            RequestItems: {
                memory: {
                    Keys:                     KEYS,
                    ProjectionExpression:     '#pk, #sk',
                    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
                    ConsistentRead:           true,
                },
            },
            ReturnConsumedCapacity: 'TOTAL',
        });
    });

    test('maps the table\'s responses, unprocessed keys and summed capacity', async () => {
        const client = fakeClient({
            Responses:        { memory: [{ PK: KEYS[0].PK, SK: KEYS[0].SK }], other: [{ PK: 'x', SK: 'y' }] },
            UnprocessedKeys:  { memory: { Keys: [{ PK: KEYS[1].PK, SK: KEYS[1].SK }] } },
            ConsumedCapacity: [
                { TableName: 'memory', CapacityUnits: 1.5 },
                { TableName: 'other', CapacityUnits: 50 },
                { TableName: 'memory' },
                { TableName: 'memory', CapacityUnits: 0.5 },
            ],
        });
        expect(await createBatchGetKeys(client as never, 'memory')(KEYS)).toEqual({
            found:             [KEYS[0]],
            unprocessed:       [KEYS[1]],
            consumedReadUnits: 2,
        });
    });

    test('reports nothing found or unprocessed when the response omits them', async () => {
        const client = fakeClient({ ConsumedCapacity: [{ TableName: 'memory', CapacityUnits: 0 }], UnprocessedKeys: {} });
        expect(await createBatchGetKeys(client as never, 'memory')(KEYS)).toEqual({ found: [], unprocessed: [], consumedReadUnits: 0 });
    });

    test.each([
        ['no ConsumedCapacity at all', {}],
        ['capacity only for another table', { ConsumedCapacity: [{ TableName: 'other', CapacityUnits: 3 }] }],
        ['an entry without CapacityUnits', { ConsumedCapacity: [{ TableName: 'memory' }] }],
    ])('reports undefined consumed capacity for %s', async (_label, output) => {
        const client = fakeClient(output);
        const { consumedReadUnits } = await createBatchGetKeys(client as never, 'memory')(KEYS);
        expect(consumedReadUnits).toBeUndefined();
    });
});

describe('createNativePruneDependencies', () => {
    test('composes the configured client, table, index, clock, sleep and output', async () => {
        const client = { destroy: mock(() => undefined) };
        const docClient = fakeClient({ ConsumedCapacity: [{ TableName: 'isambard-memory', CapacityUnits: 1 }] });
        const resource = { marker: 'resource' };
        const config = { tableName: 'isambard-memory' };
        const loadConfig = mock((_resource: unknown) => config);
        const createClient = mock((_config: unknown) => ({ client, docClient, tableName: 'isambard-memory' }));
        const open = mock(async (dbPath: string) => ({ dbPath }));
        const now = mock(() => 123);
        const sleep = mock(async (_ms: number) => undefined);
        const write = mock((_message: string) => undefined);
        const services = { resource, loadConfig, createClient, Index: { open }, now, sleep, write } as unknown as PruneNativeServices;

        const deps = createNativePruneDependencies(services);
        const storage = deps.openStorage();
        expect(loadConfig).toHaveBeenCalledWith(resource);
        expect(createClient).toHaveBeenCalledWith(config);
        expect(storage.tableName).toBe('isambard-memory');
        expect(await storage.batchGetKeys(KEYS)).toEqual({ found: [], unprocessed: [], consumedReadUnits: 1 });
        expect((docClient.send.mock.calls[0][0].input.RequestItems as Record<string, unknown>)['isambard-memory']).toBeDefined();
        storage.destroy();
        expect(client.destroy).toHaveBeenCalledTimes(1);
        expect(await deps.openVectorIndex('live.sqlite') as unknown).toEqual({ dbPath: 'live.sqlite' });
        expect(deps.now()).toBe(123);
        await deps.sleep(250);
        deps.write('hello');
        expect(sleep).toHaveBeenCalledWith(250);
        expect(write).toHaveBeenCalledWith('hello');
    });

    test('production services bind real owners without opening anything, and write to stdout', () => {
        expect(Object.keys(productionPruneServices).toSorted((a, b) => a.localeCompare(b))).toEqual(['createClient', 'Index', 'loadConfig', 'now', 'resource', 'sleep', 'write']);
        const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
        const deps = createNativePruneDependencies();
        expect(typeof deps.now()).toBe('number');
        deps.write('production output');
        expect(output).toHaveBeenCalledWith('production output');
    });
});
