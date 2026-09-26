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
import { z } from 'zod';
import { mockLogger } from '../../../setup';
import { BskyRejectionBackend, type BskyRejectedReply, type BskyRejectedDM } from '@/integrations/bsky/rejection-backend';
import { createAtUri, createCid } from '@/integrations/bsky/types';

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

const REPLY_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DM_UUID    = 'bbbbbbbb-1111-4222-8333-444444444444';

const PARENT_URI = 'at://did:plc:test/app.bsky.feed.post/parent123';
const PARENT_CID = 'bafyreparentcid';
const ROOT_URI    = 'at://did:plc:test/app.bsky.feed.post/root456';
const ROOT_CID    = 'bafyrerootcid';

// Domain (in-memory) shape — the strong ref is a single nested BskyReplyInput.
const REPLY_ITEM: BskyRejectedReply = {
    type:         'reply',
    uuid:         REPLY_UUID,
    text:         'Great post!',
    targetHandle: 'someone.bsky.social',
    reply:        { parent: { uri: createAtUri(PARENT_URI), cid: createCid(PARENT_CID) } },
    reason:       'Too generic',
    rejectedAt:   '2026-03-22T15:30:00.000Z',
};

const REPLY_ITEM_WITH_ROOT: BskyRejectedReply = {
    ...REPLY_ITEM,
    reply: {
        ...REPLY_ITEM.reply,
        root: { uri: createAtUri(ROOT_URI), cid: createCid(ROOT_CID) },
    },
};

// Persisted (wire) shape — flat, independently-optional root fields. This is what actually
// lands in DynamoDB and what a raw QueryCommand response looks like.
const STORED_REPLY_ITEM = {
    type:         'reply' as const,
    uuid:         REPLY_UUID,
    text:         'Great post!',
    targetHandle: 'someone.bsky.social',
    parentUri:    PARENT_URI,
    parentCid:    PARENT_CID,
    reason:       'Too generic',
    rejectedAt:   '2026-03-22T15:30:00.000Z',
};

const STORED_REPLY_ITEM_WITH_ROOT = {
    ...STORED_REPLY_ITEM,
    rootUri: ROOT_URI,
    rootCid: ROOT_CID,
};

const DM_ITEM: BskyRejectedDM = {
    type:             'dm',
    uuid:             DM_UUID,
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
        jest.restoreAllMocks();
        jest.useRealTimers();
        ddbMock.restore();
    });

    describe('recordRejection', () => {
        test('does not report completion until persistence completes', async () => {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate = Promise.withResolvers<object>();
            ddbMock.on(PutCommand).callsFake(() => {
                writeStarted.resolve();
                return writeGate.promise;
            });

            const operation = backend.recordRejection(REPLY_ITEM);
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await drainMicrotasks();
                expect(completed).toBe(false);
            } finally {
                writeGate.resolve({});
                await operation;
            }
        });

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
                SK:           `REJECTION#${REPLY_UUID}`,
                type:         'reply',
                uuid:         REPLY_UUID,
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
                SK:               `REJECTION#${DM_UUID}`,
                type:             'dm',
                uuid:             DM_UUID,
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
            expect(item).toMatchObject(STORED_REPLY_ITEM_WITH_ROOT);
        });
    });

    describe('listRejections', () => {
        test('returns parsed reply items from query, round-tripping the stored flat row to the domain nested shape', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'BSKY#REJECTED',
                    SK: `REJECTION#${REPLY_UUID}`,
                    ...STORED_REPLY_ITEM,
                }],
            });

            const results = await backend.listRejections();

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(REPLY_ITEM);
            // PK/SK must be stripped
            expect(results[0]).not.toHaveProperty('PK');
            expect(results[0]).not.toHaveProperty('SK');
        });

        test('maps a legacy row with rootUri/rootCid absent to root: undefined, and back to the identical four-field stored row', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'BSKY#REJECTED',
                    SK: `REJECTION#${REPLY_UUID}`,
                    ...STORED_REPLY_ITEM,
                }],
            });

            const [domainItem] = await backend.listRejections();
            expect(domainItem.type).toBe('reply');
            expect((domainItem as BskyRejectedReply).reply.root).toBeUndefined();

            ddbMock.on(PutCommand).resolves({});
            await backend.recordRejection(domainItem);

            const putItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
            expect(putItem).toMatchObject(STORED_REPLY_ITEM);
            expect(putItem).not.toHaveProperty('rootUri');
            expect(putItem).not.toHaveProperty('rootCid');
        });

        test('skips an invalid strong ref and logs its UUID without hiding the valid reply', async () => {
            const malformedRow = { ...STORED_REPLY_ITEM, uuid: '55555555-1111-4222-8333-444444444444', parentUri: '', parentCid: '' };
            const warnSpy      = jest.spyOn(loggerModule.logger, 'warn');
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${malformedRow.uuid}`, ...malformedRow },
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID}`, ...STORED_REPLY_ITEM },
                ],
            });

            const results = await backend.listRejections();

            expect(results).toEqual([REPLY_ITEM]);
            expect(warnSpy).toHaveBeenCalledWith({
                err:  expect.anything(),
                uuid: malformedRow.uuid,
                msg:  'Skipping Bluesky rejection row with an invalid strong ref',
            });
        });

        test('skips a row failing the stored schema and logs its parse error without hiding the valid DM', async () => {
            const { convoId: _omitted, ...malformedDm } = { ...DM_ITEM, uuid: '66666666-1111-4222-8333-444444444444' };
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${malformedDm.uuid}`, ...malformedDm },
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${DM_UUID}`, ...DM_ITEM },
                ],
            });
            mockLogger.warn.mockClear();

            const results = await backend.listRejections();

            expect(results).toEqual([DM_ITEM]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ error: expect.any(z.ZodError), msg: 'Skipping malformed Bluesky rejection row' });
            const [[logged]] = mockLogger.warn.mock.calls as [[{ error: z.ZodError }]];
            expect(logged.error.issues.map(issue => issue.path)).toEqual([['convoId']]);
        });

        test('returns parsed DM items from query', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [{
                    PK: 'BSKY#REJECTED',
                    SK: `REJECTION#${DM_UUID}`,
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

        test('sorts results newest first by rejectedAt (client-side)', async () => {
            const OLDER_UUID = '33333333-1111-4222-8333-444444444444';
            const NEWER_UUID = '44444444-1111-4222-8333-444444444444';
            const olderStoredRow = {
                ...STORED_REPLY_ITEM,
                uuid:       OLDER_UUID,
                rejectedAt: '2026-03-21T10:00:00.000Z',
            };
            const newerItem: BskyRejectedDM = {
                ...DM_ITEM,
                uuid:       NEWER_UUID,
                rejectedAt: '2026-03-22T16:00:00.000Z',
            };
            // Return in ascending order (older first) — sort must reverse this
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${OLDER_UUID}`, ...olderStoredRow },
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${NEWER_UUID}`, ...newerItem },
                ],
            });

            const results = await backend.listRejections();

            expect(results).toHaveLength(2);
            expect(results[0]?.rejectedAt).toBe('2026-03-22T16:00:00.000Z');
            expect(results[1]?.rejectedAt).toBe('2026-03-21T10:00:00.000Z');
        });

        test('preserves query order when rejections share a rejectedAt timestamp', async () => {
            const matchingTimestamp = '2026-03-22T16:00:00.000Z';
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID}`, ...STORED_REPLY_ITEM, rejectedAt: matchingTimestamp },
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${DM_UUID}`, ...DM_ITEM, rejectedAt: matchingTimestamp },
                ],
            });

            const results = await backend.listRejections();

            expect(results.map(item => item.uuid)).toEqual([REPLY_UUID, DM_UUID]);
        });

        test('preserves query order for two reply rows sharing a rejectedAt timestamp', async () => {
            const REPLY_UUID_A     = 'cccccccc-1111-4222-8333-444444444444';
            const REPLY_UUID_B     = 'dddddddd-1111-4222-8333-444444444444';
            const matchingTimestamp = '2026-03-22T17:00:00.000Z';
            const storedReplyA = { ...STORED_REPLY_ITEM, uuid: REPLY_UUID_A, rejectedAt: matchingTimestamp };
            const storedReplyB = { ...STORED_REPLY_ITEM, uuid: REPLY_UUID_B, rejectedAt: matchingTimestamp };
            const replyA: BskyRejectedReply = { ...REPLY_ITEM, uuid: REPLY_UUID_A, rejectedAt: matchingTimestamp };
            const replyB: BskyRejectedReply = { ...REPLY_ITEM, uuid: REPLY_UUID_B, rejectedAt: matchingTimestamp };
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID_A}`, ...storedReplyA },
                    { PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID_B}`, ...storedReplyB },
                ],
            });

            const results = await backend.listRejections();

            expect(results).toEqual([replyA, replyB]);
        });

        test('does not pass ScanIndexForward to query (client-side sort)', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.listRejections();

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0]?.args[0].input).toMatchObject({
                KeyConditionExpression:   '#pk = :pk',
                ExpressionAttributeNames: { '#pk': 'PK' },
            });
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.ScanIndexForward).toBeUndefined();
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
        test('does not report completion until deletion completes', async () => {
            const deleteStarted = Promise.withResolvers<void>();
            const deleteGate = Promise.withResolvers<object>();
            ddbMock.on(DeleteCommand).callsFake(() => {
                deleteStarted.resolve();
                return deleteGate.promise;
            });

            const operation = backend.deleteRejection(REPLY_UUID);
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await deleteStarted.promise;
                await drainMicrotasks();
                expect(completed).toBe(false);
            } finally {
                deleteGate.resolve({});
                await operation;
            }
        });

        test('deletes with correct PK and SK using uuid', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            await backend.deleteRejection(REPLY_UUID);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       {
                    PK: 'BSKY#REJECTED',
                    SK: `REJECTION#${REPLY_UUID}`,
                },
            });
        });
    });

    describe('clearAll', () => {
        test('waits for the retry backoff before the next write attempt', async () => {
            jest.useFakeTimers();
            const firstAttempt = Promise.withResolvers<void>();
            let attempts = 0;
            ddbMock.on(QueryCommand).resolves({
                Items: [{ PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID}` }],
            });
            ddbMock.on(BatchWriteCommand).callsFake(() => {
                attempts += 1;
                if(attempts === 1) {
                    firstAttempt.resolve();
                    return {
                        UnprocessedItems: {
                            TestTable: [{ DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: `REJECTION#${REPLY_UUID}` } } }],
                        },
                    };
                }
                return {};
            });

            const operation = backend.clearAll();

            try {
                await firstAttempt.promise;
                await Promise.resolve();
                expect(attempts).toBe(1);
                jest.runAllTimers();
                await expect(operation).resolves.toBe(1);
                expect(attempts).toBe(2);
            } finally {
                jest.runAllTimers();
                await operation;
            }
        });

        test('returns 0 and does nothing when no items exist', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const count = await backend.clearAll();

            expect(count).toBe(0);
            const query = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
            expect(query).toEqual({
                TableName:                 'TestTable',
                KeyConditionExpression:    '#pk = :pk',
                ExpressionAttributeNames:  { '#pk': 'PK' },
                ExpressionAttributeValues: { ':pk': 'BSKY#REJECTED' },
                ProjectionExpression:      'PK, SK',
            });
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            expect(batchCalls).toHaveLength(0);
        });

        test('deletes all items via BatchWriteCommand and returns count', async () => {
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#cccccccc-1111-4222-8333-444444444444' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#dddddddd-1111-4222-8333-444444444444' },
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
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#cccccccc-1111-4222-8333-444444444444' } } },
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#dddddddd-1111-4222-8333-444444444444' } } },
                    ],
                },
            });
        });

        test('handles batches of 25 items and returns total count', async () => {
            // 26 items should produce 2 batch calls: 25 + 1
            const items = Array.from({ length: 26 }, (_, i) => ({
                PK: 'BSKY#REJECTED',
                SK: `REJECTION#cccccccc-${String(i).padStart(4, '0')}-4222-8333-444444444444`,
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

        test('accumulates failedCount across multiple failing batches rather than overwriting it', async () => {
            jest.useFakeTimers();
            // 26 items produce 2 batches (25 + 1); every attempt on every batch reports
            // its whole submitted set as unprocessed, so both batches exhaust retries
            // and fail entirely. A correct implementation sums the two batches'
            // failures (25 + 1 = 26 failed, 0 deleted); an implementation that
            // overwrites failedCount instead of accumulating it would report only
            // the last batch's failure count (1 failed, 25 deleted).
            const items = Array.from({ length: 26 }, (_, i) => ({
                PK: 'BSKY#REJECTED',
                SK: `REJECTION#gggggggg-${String(i).padStart(4, '0')}-4222-8333-444444444444`,
            }));
            ddbMock.on(QueryCommand).resolves({ Items: items });
            ddbMock.on(BatchWriteCommand).callsFake((input: { RequestItems?: Record<string, unknown[]> }) => ({
                UnprocessedItems: { TestTable: input.RequestItems?.TestTable },
            }));

            const promise = backend.clearAll();

            // Two batches, each exhausting MAX_RETRIES (3) attempts with a backoff
            // delay between attempts, needs more drain cycles than a single batch.
            for(let i = 0; i < 30; i++) {
                jest.runAllTimers();
                // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
                await Promise.resolve();
                // eslint-disable-next-line no-await-in-loop -- sequential: a second flush lets the awaited send() settle
                await Promise.resolve();
            }

            const count = await promise;

            expect(count).toBe(0);
            expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(6); // MAX_RETRIES (3) x 2 batches
        });

        test('does not send an empty batch at the 25-item boundary', async () => {
            const items = Array.from({ length: 25 }, (_, i) => ({ PK: 'BSKY#REJECTED', SK: `REJECTION#${i}` }));
            ddbMock.on(QueryCommand).resolves({ Items: items });
            ddbMock.on(BatchWriteCommand).resolves({});

            expect(await backend.clearAll()).toBe(25);
            const calls = ddbMock.commandCalls(BatchWriteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.RequestItems?.TestTable).toHaveLength(25);
        });

        test('warns and returns partial count when all retries exhausted', async () => {
            jest.useFakeTimers();
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            const timerSpy = jest.spyOn(globalThis, 'setTimeout');

            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#eeeeeeee-1111-4222-8333-444444444444' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#ffffffff-1111-4222-8333-444444444444' },
                ],
            });

            // BatchWriteCommand always returns 1 unprocessed item on every attempt
            ddbMock.on(BatchWriteCommand).resolves({
                UnprocessedItems: {
                    TestTable: [
                        { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#ffffffff-1111-4222-8333-444444444444' } } },
                    ],
                },
            });

            const promise = backend.clearAll();

            // Drain timers + microtasks for all retry attempts (MAX_RETRIES = 3)
            for(let i = 0; i < 10; i++) {
                jest.runAllTimers();
                // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
                await Promise.resolve();
            }

            const count = await promise;

            // 2 items queried, 1 unprocessed after retries exhausted → count = 2 - 1 = 1
            expect(count).toBe(1);
            expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(3);
            expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 100);
            expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), 200);
            expect(timerSpy).toHaveBeenCalledTimes(2);
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
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#11111111-1111-4222-8333-444444444444' },
                    { PK: 'BSKY#REJECTED', SK: 'REJECTION#22222222-1111-4222-8333-444444444444' },
                ],
            });

            // First call returns one unprocessed item; second call succeeds
            ddbMock.on(BatchWriteCommand)
                .resolvesOnce({
                    UnprocessedItems: {
                        TestTable: [
                            { DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#22222222-1111-4222-8333-444444444444' } } },
                        ],
                    },
                })
                .resolves({});

            const promise = backend.clearAll();

            // Drain timers to allow the backoff delay to resolve
            for(let i = 0; i < 5; i++) {
                jest.runAllTimers();
                // eslint-disable-next-line no-await-in-loop -- sequential: must run timers then flush microtasks each tick
                await Promise.resolve();
            }

            const count = await promise;

            expect(count).toBe(2);
            const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
            // First attempt: 2 items; retry: 1 unprocessed item
            expect(batchCalls).toHaveLength(2);
            const retryTable = batchCalls[1].args[0].input.RequestItems?.TestTable;
            expect(retryTable).toHaveLength(1);
            expect(retryTable![0]).toEqual({
                DeleteRequest: { Key: { PK: 'BSKY#REJECTED', SK: 'REJECTION#22222222-1111-4222-8333-444444444444' } },
            });
        });

        test('does not back off or warn when DynamoDB explicitly returns no unprocessed items', async () => {
            const timerSpy = jest.spyOn(globalThis, 'setTimeout');
            const loggerWarnSpy = jest.spyOn(loggerModule.logger, 'warn');
            // The test setup exports one shared logger mock, so only inspect warnings
            // emitted after this operation begins without consuming shared history.
            const warningCallCount = loggerWarnSpy.mock.calls.length;
            ddbMock.on(QueryCommand).resolves({ Items: [{ PK: 'BSKY#REJECTED', SK: 'REJECTION#one' }] });
            ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: { TestTable: [] } });

            await expect(backend.clearAll()).resolves.toBe(1);
            expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(1);
            expect(timerSpy).not.toHaveBeenCalled();
            expect(loggerWarnSpy.mock.calls.slice(warningCallCount)).toEqual([]);
            loggerWarnSpy.mockRestore();
        });
    });
});
