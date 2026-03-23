import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    DeleteCommand,
    BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import * as loggerModule from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { BskyRejectionBackend, type BskyRejectedReply, type BskyRejectedDM } from '@/integrations/bsky/rejection-backend';

const REPLY_ITEM: BskyRejectedReply = {
    type:         'reply',
    text:         'Great post!',
    targetHandle: 'someone.bsky.social',
    parentUri:    'at://did:plc:test/app.bsky.feed.post/parent123',
    parentCid:    'bafyreparentcid',
    reason:       'Too generic',
    rejectedAt:   '2026-03-22T15:30:00.000Z',
};

const REPLY_ITEM_WITH_ROOT: BskyRejectedReply = {
    ...REPLY_ITEM,
    rootUri: 'at://did:plc:test/app.bsky.feed.post/root456',
    rootCid: 'bafyrerootcid',
};

const DM_ITEM: BskyRejectedDM = {
    type:             'dm',
    text:             'Hey, want to collaborate?',
    recipientHandles: ['alice.bsky.social', 'bob.bsky.social'],
    convoId:          'convo-abc123',
    reason:           'Not appropriate',
    rejectedAt:       '2026-03-22T16:00:00.000Z',
};

describe('BskyRejectionBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: BskyRejectionBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new BskyRejectionBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        ddbMock.restore();
    });

    describe('recordRejection', () => {
        test('stores reply rejection with correct PK/SK and all fields including TTL', async () => {
            ddbMock.on(PutCommand).resolves({});

            const before = Math.floor(Date.now() / 1000);
            await backend.recordRejection(REPLY_ITEM);
            const after = Math.floor(Date.now() / 1000);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item!;
            expect(item).toMatchObject({
                PK:           'BSKY#REJECTED',
                SK:           'REJECTION#2026-03-22T15:30:00.000Z',
                type:         'reply',
                text:         'Great post!',
                targetHandle: 'someone.bsky.social',
                parentUri:    'at://did:plc:test/app.bsky.feed.post/parent123',
                parentCid:    'bafyreparentcid',
                reason:       'Too generic',
                rejectedAt:   '2026-03-22T15:30:00.000Z',
            });
            // TTL should be approximately 30 days from now
            const thirtyDays = 30 * 24 * 60 * 60;
            expect(item.TTL as number).toBeGreaterThanOrEqual(before + thirtyDays);
            expect(item.TTL as number).toBeLessThanOrEqual(after + thirtyDays);
        });

        test('stores DM rejection with correct PK/SK and all fields', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.recordRejection(DM_ITEM);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item!;
            expect(item).toMatchObject({
                PK:               'BSKY#REJECTED',
                SK:               'REJECTION#2026-03-22T16:00:00.000Z',
                type:             'dm',
                text:             'Hey, want to collaborate?',
                recipientHandles: ['alice.bsky.social', 'bob.bsky.social'],
                convoId:          'convo-abc123',
                reason:           'Not appropriate',
                rejectedAt:       '2026-03-22T16:00:00.000Z',
            });
            expect(typeof item.TTL).toBe('number');
        });

        test('stores reply with optional rootUri and rootCid', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.recordRejection(REPLY_ITEM_WITH_ROOT);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item;
            expect(item).toMatchObject({
                rootUri: 'at://did:plc:test/app.bsky.feed.post/root456',
                rootCid: 'bafyrerootcid',
            });
        });
    });

    describe('listRejections', () => {
        test('returns parsed reply items from query', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'BSKY#REJECTED',
                    SK: 'REJECTION#2026-03-22T15:30:00.000Z',
                    ...REPLY_ITEM,
                }],
            });

            const results = await backend.listRejections();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(REPLY_ITEM);
            // PK/SK must be stripped
            expect(results[0]).not.toHaveProperty('PK');
            expect(results[0]).not.toHaveProperty('SK');
        });

        test('returns parsed DM items from query', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'BSKY#REJECTED',
                    SK: 'REJECTION#2026-03-22T16:00:00.000Z',
                    ...DM_ITEM,
                }],
            });

            const results = await backend.listRejections();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(DM_ITEM);
            expect(results[0]).not.toHaveProperty('PK');
            expect(results[0]).not.toHaveProperty('SK');
        });

        test('returns empty array when no items', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const results = await backend.listRejections();

            expect(results).toEqual([]);
        });

        test('queries with ScanIndexForward false (newest first)', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listRejections();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ScanIndexForward).toBe(false);
        });

        test('queries with correct PK', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listRejections();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
                ':pk': 'BSKY#REJECTED',
            });
        });
    });

    describe('deleteRejection', () => {
        test('deletes with correct PK and SK', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteRejection('2026-03-22T15:30:00.000Z');

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       {
                    PK: 'BSKY#REJECTED',
                    SK: 'REJECTION#2026-03-22T15:30:00.000Z',
                },
            });
        });
    });

    describe('clearAll', () => {
        test('returns 0 and does nothing when no items exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const count = await backend.clearAll();

            expect(count).toBe(0);
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(0);
        });

        test('deletes all items via BatchWriteCommand and returns count', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T15:30:00.000Z' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' },
                ],
            });
            ddbMock.on(BatchWriteCommand).resolves({});

            const count = await backend.clearAll();

            expect(count).toBe(2);
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(1);
            expect(batchCalls[0].args[0].input).toEqual({
                RequestItems: {
                    TestTable: [
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T15:30:00.000Z' } } },
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' } } },
                    ],
                },
            });
        });

        test('handles batches of 25 items and returns total count', async () => {
            // 26 items should produce 2 batch calls: 25 + 1
            const items = Array.from({ length: 26 }, (_, i) => ({
                PK: 'BSKY#REJECTED',
                SK: `REJECTION#2026-03-22T${String(i).padStart(2, '0')}:00:00.000Z`,
            }));
            ddbMock.on(QueryCommand).resolves({ Items: items });
            ddbMock.on(BatchWriteCommand).resolves({});

            const count = await backend.clearAll();

            expect(count).toBe(26);
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(2);
            expect(batchCalls[0].args[0].input.RequestItems?.TestTable).toHaveLength(25);
            expect(batchCalls[1].args[0].input.RequestItems?.TestTable).toHaveLength(1);
        });

        test('warns and returns partial count when all retries exhausted', async () => {
            jest.useFakeTimers();
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');

            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T15:30:00.000Z' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' },
                ],
            });

            // BatchWriteCommand always returns 1 unprocessed item on every attempt
            ddbMock.on(BatchWriteCommand).resolves({
                UnprocessedItems: {
                    TestTable: [
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' } } },
                    ],
                },
            });

            const promise = backend.clearAll();

            // Drain timers + microtasks for all retry attempts (MAX_RETRIES = 3)
            for(let i = 0; i < 10; i++) {
                jest.runAllTimers();
                // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
                await new Promise((resolve) => {
                    process.nextTick(resolve);
                });
            }

            const count = await promise;

            // 2 items queried, 1 unprocessed after retries exhausted → count = 2 - 1 = 1
            expect(count).toBe(1);
            expect(loggerWarnSpy).toHaveBeenCalledWith(expect.objectContaining({
                count: 1,
                msg:   'Some rejections could not be deleted after retries',
            }));

            loggerWarnSpy.mockRestore();
        });

        test('retries unprocessed items from BatchWriteCommand', async () => {
            jest.useFakeTimers();

            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T15:30:00.000Z' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' },
                ],
            });

            // First call returns one unprocessed item; second call succeeds
            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [
                            { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' } } },
                        ],
                    },
                })
                .resolves({});

            const promise = backend.clearAll();

            // Drain timers to allow the backoff delay to resolve
            for(let i = 0; i < 5; i++) {
                jest.runAllTimers();
                // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
                await new Promise((resolve) => {
                    process.nextTick(resolve);
                });
            }

            const count = await promise;

            expect(count).toBe(2);
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // First attempt: 2 items; retry: 1 unprocessed item
            expect(batchCalls).toHaveLength(2);
            const retryTable = batchCalls[1].args[0].input.RequestItems?.TestTable;
            expect(retryTable).toHaveLength(1);
            expect(retryTable![0]).toEqual({
                DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#2026-03-22T16:00:00.000Z' } },
            });
        });
    });
});
