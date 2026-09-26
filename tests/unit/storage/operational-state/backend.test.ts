import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    QueryCommand,
    type GetCommandInput,
    type PutCommandInput,
    type QueryCommandInput
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { z } from 'zod';
import { mockLogger } from '../../../setup';
import { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import { MemoryToolBackend } from '@/storage/memory-tool/backend';
import { createMemoryPath, createContentType } from '@/storage/memory-tool/types';
import { OperationalStateBackend, type OperationalStateKey } from '@/storage/operational-state';

const TABLE = 'TestTable';
const schema = z.object({ n: z.number() });
const channelKey: OperationalStateKey = { owner: 'discord', name: 'channels/123/checkpoint' };

describe('OperationalStateBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: OperationalStateBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new OperationalStateBackend(ddbMock as unknown as DynamoDBDocumentClient, TABLE);
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        ddbMock.restore();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('put', () => {
        test('sends exactly one PutCommand whose item is the partition, name, JSON content and updatedAt only', async () => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2026-09-24T01:02:03.456Z'));
            ddbMock.on(PutCommand).resolves({});

            await backend.put(channelKey, { n: 1 });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0]?.args[0].input;
            expect(input.TableName).toBe(TABLE);
            expect(input.Item).toEqual({
                PK:        'OPERATIONAL_STATE#discord',
                SK:        'channels/123/checkpoint',
                content:   '{"n":1}',
                updatedAt: '2026-09-24T01:02:03.456Z',
            });
            expect(Object.keys(input.Item ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual(['content', 'PK', 'SK', 'updatedAt']);
        });

        test('put rejects with the DynamoDB error when the PutCommand fails', async () => {
            ddbMock.on(PutCommand).rejects(new Error('throttled'));
            await expect(backend.put(channelKey, { n: 1 })).rejects.toThrow('throttled');
        });

        test('uses the bsky partition for a bsky key', async () => {
            ddbMock.on(PutCommand).resolves({});
            await backend.put({ owner: 'bsky', name: 'dm/checkpoint' }, { n: 2 });
            const input = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
            expect(input.Item?.PK).toBe('OPERATIONAL_STATE#bsky');
            expect(input.Item?.SK).toBe('dm/checkpoint');
        });
    });

    describe('read', () => {
        test('a missing item is absent and the GetCommand is a strongly consistent read of exactly PK and SK', async () => {
            ddbMock.on(GetCommand).resolves({});

            await expect(backend.read(channelKey, schema)).resolves.toEqual({ status: 'absent' });

            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.args[0].input).toEqual({
                TableName:      TABLE,
                Key:            { PK: 'OPERATIONAL_STATE#discord', SK: 'channels/123/checkpoint' },
                ConsistentRead: true,
            });
        });

        test('a stored row decodes to a valid read', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { PK: 'OPERATIONAL_STATE#discord', SK: 'channels/123/checkpoint', content: '{"n":5}', updatedAt: 'x' } });
            await expect(backend.read(channelKey, schema)).resolves.toEqual({ status: 'valid', value: { n: 5 } });
        });

        test('a row with corrupt JSON content is invalid json', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { PK: 'p', SK: 's', content: '{oops' } });
            const read = await backend.read(channelKey, schema);
            expect(read).toEqual({ status: 'invalid', reason: 'json', error: expect.any(SyntaxError) });
        });

        test('a row whose content fails the schema is invalid schema', async () => {
            ddbMock.on(GetCommand).resolves({ Item: { PK: 'p', SK: 's', content: '{"n":"x"}' } });
            const read = await backend.read(channelKey, schema);
            expect(read.status).toBe('invalid');
            expect((read as { reason: string }).reason).toBe('schema');
        });
    });

    describe('listByPrefix', () => {
        test('queries the owner partition by name prefix with a consistent read and exact expression', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [{ SK: 'channels/1/checkpoint', content: '{"n":1}' }] });

            await expect(backend.listByPrefix({ owner: 'discord', name: 'channels/' }, schema)).resolves.toEqual([{ n: 1 }]);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.args[0].input).toEqual({
                TableName:                 TABLE,
                KeyConditionExpression:    '#pk = :pk AND begins_with(#sk, :prefix)',
                ExpressionAttributeNames:  { '#pk': 'PK', '#sk': 'SK' },
                ExpressionAttributeValues: { ':pk': 'OPERATIONAL_STATE#discord', ':prefix': 'channels/' },
                ConsistentRead:            true,
                ExclusiveStartKey:         undefined,
            });
        });

        test('pages through LastEvaluatedKey and concatenates the pages in order', async () => {
            const pageKey = { PK: 'OPERATIONAL_STATE#bsky', SK: 'feeds/a/checkpoint' };
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [{ SK: 'feeds/a/checkpoint', content: '{"n":1}' }], LastEvaluatedKey: pageKey })
                .resolvesOnce({ Items: [{ SK: 'feeds/b/checkpoint', content: '{"n":2}' }] });

            await expect(backend.listByPrefix({ owner: 'bsky', name: 'feeds/' }, schema)).resolves.toEqual([{ n: 1 }, { n: 2 }]);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(2);
            expect(calls[0]?.args[0].input.ExclusiveStartKey).toBeUndefined();
            expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual(pageKey);
        });

        test('a page with no Items contributes nothing and logs nothing', async () => {
            ddbMock.on(QueryCommand).resolves({});
            await expect(backend.listByPrefix({ owner: 'discord', name: 'channels/' }, schema)).resolves.toEqual([]);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('an undecodable row is skipped with one exact warning while the rows around it are returned', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [
                { SK: 'channels/1/checkpoint', content: '{"n":1}' },
                { SK: 'channels/2/checkpoint', content: '{"n":"bad"}' },
                { SK: 'channels/3/checkpoint', content: '{"n":3}' },
            ] });

            await expect(backend.listByPrefix({ owner: 'discord', name: 'channels/' }, schema)).resolves.toEqual([{ n: 1 }, { n: 3 }]);

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({
                owner:  'discord',
                name:   'channels/2/checkpoint',
                reason: 'schema',
                err:    expect.any(z.ZodError),
                msg:    'OperationalStateBackend.listByPrefix(): skipping undecodable row',
            });
        });
    });
});

/**
 * An in-memory single-table fake: PutCommand stores the item by PK/SK; GetCommand serves
 * strongly consistent reads from the live rows but eventually consistent reads from a frozen
 * snapshot (modelling a replica that has not seen recent writes); QueryCommand filters by PK, or
 * by GSI1PK when IndexName is GSI1.
 */
function installTableFake(ddbMock: ReturnType<typeof mockClient>): { rows: Map<string, Record<string, unknown>>, freeze: () => void, gets: GetCommandInput[] } {
    const rows = new Map<string, Record<string, unknown>>();
    let snapshot: Map<string, Record<string, unknown>> | undefined;
    const gets: GetCommandInput[] = [];
    const rowKey = (pk: unknown, sk: unknown): string => `${String(pk)}\u0000${String(sk)}`;

    ddbMock.on(PutCommand).callsFake((input: PutCommandInput) => {
        const item = input.Item ?? {};
        rows.set(rowKey(item.PK, item.SK), item);
        return {};
    });
    ddbMock.on(GetCommand).callsFake((input: GetCommandInput) => {
        gets.push(input);
        const source = input.ConsistentRead === true || snapshot === undefined ? rows : snapshot;
        return { Item: source.get(rowKey(input.Key?.PK, input.Key?.SK)) };
    });
    ddbMock.on(QueryCommand).callsFake((input: QueryCommandInput) => {
        const attr = input.IndexName === 'GSI1' ? 'GSI1PK' : 'PK';
        const pk = input.ExpressionAttributeValues?.[':pk'];
        return { Items: [...rows.values()].filter(row => row[attr] === pk) };
    });

    return { rows, freeze: () => {
        snapshot = new Map(rows);
    }, gets };
}

describe('operational-state isolation and consistency against a table fake', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let docClient: DynamoDBDocumentClient;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        docClient = ddbMock as unknown as DynamoDBDocumentClient;
    });

    afterEach(() => {
        ddbMock.restore();
        jest.restoreAllMocks();
    });

    test('a checkpoint written through the store never appears in state scoring beside an ordinary state memory', async () => {
        installTableFake(ddbMock);
        const memoryBackend = new MemoryToolBackend(docClient, TABLE);
        const store = new OperationalStateBackend(docClient, TABLE);

        await store.put(channelKey, { n: 1 });
        await memoryBackend.create({ path: createMemoryPath('/state/notes.md'), content: 'hello', contentType: createContentType('text/markdown') });

        const scored = await memoryBackend.getStateItemsScored();
        expect(scored.map(s => s.item.path)).toEqual([createMemoryPath('/state/notes.md')]);
    });

    test('sequential receipt and handled updates lose no progress when eventual reads are stale', async () => {
        const table = installTableFake(ddbMock);
        const channelId = createChannelId('123456789012345678');
        const guildId = createGuildId('987654321098765432');
        // From here on an eventually consistent read sees the empty table, never a new put.
        table.freeze();
        const manager = new CheckpointManager({ store: new OperationalStateBackend(docClient, TABLE) });

        await manager.updateLastSeen(channelId, guildId, '2026-09-24T00:00:01.000Z', '200');
        await manager.updateHandled(channelId, '200', '2026-09-24T00:00:02.000Z');
        await manager.updateLastSeen(channelId, guildId, '2026-09-24T00:00:03.000Z', '300');

        expect(await manager.load(channelId)).toMatchObject({
            lastSeenAt:        '2026-09-24T00:00:03.000Z',
            lastSeenMessageId: '300',
            handled:           { messageId: '200', at: '2026-09-24T00:00:02.000Z' },
        });
        // Every read, the final load included, is a strongly consistent read of the discord partition.
        expect(table.gets.map(get => [get.Key?.PK, get.ConsistentRead])).toEqual(Array.from({ length: 4 }, () => ['OPERATIONAL_STATE#discord', true]));
    });
});
