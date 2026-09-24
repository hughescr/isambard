import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { createChannelId } from '@/agent/types';
import { OutboxBackend } from '@/services/outbox/backend';
import type { OutboxItem } from '@/services/outbox/types';
import { createEpochSeconds } from '@/storage/repositories/types';

const ITEM_ID    = 'aaaaaaaa-1111-4222-8333-444444444444';
const DEDUPE_KEY = 'dedup-abc';
const CREATED   = '2026-03-30T12:00:00.000Z';

function makeItem(overrides?: Partial<OutboxItem>): OutboxItem {
    return {
        id:          ITEM_ID,
        createdAt:   CREATED,
        type:        'agent_response',
        service:     'discord',
        destination: createChannelId('channel-123'),
        payload:     { text: 'Hello world' },
        priority:    'medium',
        dedupeKey:   'dedup-abc',
        progress:    { attemptCount: 0 },
        epoch:       1,
        ...overrides,
    };
}

describe('OutboxBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: OutboxBackend;

    beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new OutboxBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            'TestTable'
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        ddbMock.restore();
    });

    describe('enqueue()', () => {
        test('calls putItem with correct PK, SK, and item fields', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem();

            await backend.enqueue(item);

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const stored = calls[0].args[0].input.Item!;
            expect(stored.PK).toBe('OUTBOX#discord');
            expect(stored.SK).toBe(`ITEM#1#${DEDUPE_KEY}`);
            expect(stored.id).toBe(ITEM_ID);
            expect(stored.service).toBe('discord');
            expect(stored.destination).toBe('channel-123');
            expect(stored.priority).toBe('medium');
            expect(stored.epoch).toBe(1);
        });

        test('uses default TTL of 24 hours from now when item.ttl is undefined', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem({ ttl: undefined });

            const before = Math.floor(Date.now() / 1000);
            await backend.enqueue(item);
            const after = Math.floor(Date.now() / 1000);

            const calls = ddbMock.commandCalls(PutCommand);
            const stored = calls[0].args[0].input.Item!;
            const twentyFourHours = 24 * 60 * 60;
            expect(stored.TTL as number).toBeGreaterThanOrEqual(before + twentyFourHours);
            expect(stored.TTL as number).toBeLessThanOrEqual(after + twentyFourHours);
        });

        test('uses custom TTL from item.ttl when provided', async () => {
            ddbMock.on(PutCommand).resolves({});
            const customTtl = createEpochSeconds(9_999_999);
            const item = makeItem({ ttl: customTtl });

            await backend.enqueue(item);

            const calls = ddbMock.commandCalls(PutCommand);
            const stored = calls[0].args[0].input.Item!;
            expect(stored.TTL).toBe(customTtl);
        });

        test('stores to the correct table', async () => {
            ddbMock.on(PutCommand).resolves({});
            await backend.enqueue(makeItem());

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls[0].args[0].input.TableName).toBe('TestTable');
        });

        test('propagates a failed write', async () => {
            ddbMock.on(PutCommand).rejects(new Error('write failed'));

            await expect(backend.enqueue(makeItem())).rejects.toThrow('write failed');
        });
    });

    describe('dequeue()', () => {
        test('queries with correct PK and default limit of 10', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.dequeue('discord');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.KeyConditionExpression).toBe('#pk = :pk');
            expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK' });
            expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'OUTBOX#discord' });
            expect(input.Limit).toBe(10);
            expect(input.ScanIndexForward).toBe(true);
            expect(input).not.toHaveProperty('ExclusiveStartKey');
        });

        test('queries with provided limit override', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.dequeue('discord', 5);

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls[0].args[0].input.Limit).toBe(5);
        });

        test('returns parsed OutboxItem objects from query results', async () => {
            const item = makeItem();
            ddbMock.on(QueryCommand).resolves({
                Items: [{ PK: 'OUTBOX#discord', SK: `ITEM#1#${DEDUPE_KEY}`, ...item }],
            });

            const result = await backend.dequeue('discord');

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                id:          ITEM_ID,
                service:     'discord',
                destination: createChannelId('channel-123'),
                priority:    'medium',
            });
            // PK/SK from DynamoDB should not blow up parse (extra keys are stripped by schema)
        });

        test('deletes an invalid destination, then pages to the next valid item', async () => {
            const invalid = { ...makeItem(), destination: '', PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' };
            const valid = { ...makeItem(), PK: 'OUTBOX#discord', SK: 'ITEM#1#good' };
            const cursor = { PK: invalid.PK, SK: invalid.SK };
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [invalid], LastEvaluatedKey: cursor })
                .resolvesOnce({ Items: [valid] });

            const result = await backend.dequeue('discord', 1);

            expect(result).toHaveLength(1);
            expect(result[0]?.destination).toBe(createChannelId('channel-123'));
            const queryCalls = ddbMock.commandCalls(QueryCommand);
            expect(queryCalls).toHaveLength(2);
            expect(queryCalls[1]?.args[0].input.ExclusiveStartKey).toEqual(cursor);
            expect(queryCalls[1]?.args[0].input.Limit).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ service: 'discord', pk: 'OUTBOX#discord', sk: 'ITEM#0#bad', error: expect.anything() }), 'Deleted malformed outbox item');
            const deleteCalls = ddbMock.commandCalls(DeleteCommand);
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0]?.args[0].input).toEqual({
                TableName: 'TestTable',
                Key:       { PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' },
            });
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('does not reprocess a malformed item after deleting it', async () => {
            const invalid = { ...makeItem(), destination: '', PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' };
            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [invalid] })
                .resolves({ Items: [] });

            await backend.dequeue('discord');
            await backend.dequeue('discord');

            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ service: 'discord', pk: 'OUTBOX#discord', sk: 'ITEM#0#bad', error: expect.anything() }), 'Deleted malformed outbox item');
        });

        test('keeps valid items when malformed item deletion fails', async () => {
            const cleanupError = new Error('delete failed');
            const invalid = { ...makeItem(), destination: '', PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' };
            const valid = { ...makeItem(), id: 'aaaaaaaa-0000-4000-8000-000000000001', PK: 'OUTBOX#discord', SK: 'ITEM#1#good' };
            ddbMock.on(DeleteCommand).rejects(cleanupError);
            ddbMock.on(QueryCommand).resolves({ Items: [invalid, valid] });

            const result = await backend.dequeue('discord');

            expect(result.map(item => item.id)).toEqual([valid.id]);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledWith(
                { service: 'discord', pk: 'OUTBOX#discord', sk: 'ITEM#0#bad', error: cleanupError },
                'Failed to delete malformed outbox item'
            );
        });

        test('requests only the remaining capacity after a page with both malformed and valid items', async () => {
            const invalid = { ...makeItem(), destination: '', PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' };
            const first = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
            const second = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            const cursor = { PK: 'OUTBOX#discord', SK: 'ITEM#1#first' };
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [invalid, first], LastEvaluatedKey: cursor })
                .resolvesOnce({ Items: [second] });

            const result = await backend.dequeue('discord', 2);

            expect(result.map(item => item.id)).toEqual([first.id, second.id]);
            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(2);
            expect(calls[0]?.args[0].input).not.toHaveProperty('ExclusiveStartKey');
            expect(calls[0]?.args[0].input.Limit).toBe(2);
            expect(calls[1]?.args[0].input.ExclusiveStartKey).toEqual(cursor);
            expect(calls[1]?.args[0].input.Limit).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        test('does not query past a full valid batch even when the page has a cursor', async () => {
            const first = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
            const second = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            ddbMock.on(QueryCommand).resolves({
                Items:            [first, second],
                LastEvaluatedKey: { PK: 'OUTBOX#discord', SK: 'ITEM#1#second' },
            });

            const result = await backend.dequeue('discord', 2);

            expect(result.map(item => item.id)).toEqual([first.id, second.id]);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
        });

        test('caps parsed results at the requested limit if a query returns excess rows', async () => {
            const first = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
            const second = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            const third = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' });
            ddbMock.on(QueryCommand).resolves({ Items: [first, second, third] });

            const result = await backend.dequeue('discord', 2);

            expect(result.map(item => item.id)).toEqual([first.id, second.id]);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
        });

        test('keeps valid priority order when a malformed row precedes them in one page', async () => {
            const first = { ...makeItem(), id: 'bbbbbbbb-1111-4222-8333-444444444444', destination: '', PK: 'OUTBOX#discord', SK: 'ITEM#0#bad' };
            const second = { ...makeItem(), id: 'cccccccc-1111-4222-8333-444444444444', destination: 'chan-2' };
            const third = { ...makeItem(), id: 'dddddddd-1111-4222-8333-444444444444', destination: 'chan-3' };
            ddbMock.on(QueryCommand).resolves({ Items: [first, second, third] });

            const result = await backend.dequeue('discord', 2);

            expect(result.map(item => item.id)).toEqual([second.id, third.id]);
            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        test('returns empty array when no items in query result', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.dequeue('discord');

            expect(result).toEqual([]);
        });

        // Legacy pre-#49 outbox rows: can be safely deleted after 2026-09-25.
        test('unwraps legacy marshalled Discord builders into API payload data', async () => {
            const item = {
                ...makeItem(),
                payload: {
                    embeds:     [{ data: { title: 'Approval needed' } }],
                    components: [{
                        data:       { type: 1 },
                        components: [{ data: { type: 2, custom_id: 'approve', label: 'Approve', style: 3 } }],
                    }],
                },
            };
            ddbMock.on(QueryCommand).resolves({ Items: [item] });

            const results = await backend.dequeue('discord');
            const result = results[0];

            expect(result.payload).toEqual({
                embeds:     [{ title: 'Approval needed' }],
                components: [{
                    type:       1,
                    components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }],
                }],
            });
        });

        test('preserves new Discord API payload data on dequeue', async () => {
            const item = makeItem({
                payload: {
                    embeds:     [{ title: 'Approval needed' }],
                    components: [{
                        type:       1,
                        components: [{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 }],
                    }],
                },
            });
            ddbMock.on(QueryCommand).resolves({ Items: [item] });

            const results = await backend.dequeue('discord');
            const result = results[0];

            expect(result.payload).toEqual(item.payload);
        });

        test('returns multiple parsed items in order returned by query', async () => {
            const item1 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', priority: 'high' });
            const item2 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002', priority: 'low' });
            ddbMock.on(QueryCommand).resolves({
                Items: [
                    { PK: 'OUTBOX#discord', SK: `ITEM#0#${item1.dedupeKey}`, ...item1 },
                    { PK: 'OUTBOX#discord', SK: `ITEM#2#${item2.dedupeKey}`, ...item2 },
                ],
            });

            const result = await backend.dequeue('discord', 2);

            expect(result).toHaveLength(2);
            expect(result[0]?.id).toBe(item1.id);
            expect(result[1]?.id).toBe(item2.id);
        });
    });

    test('parses legacy row without attemptCount as zero without deleting it', async () => {
        const item = makeItem({ progress: { attemptCount: 0 } });
        ddbMock.on(QueryCommand).resolves({ Items: [{ ...item, progress: {} }] });
        const result = await backend.dequeue('discord');
        expect(result[0]?.progress.attemptCount).toBe(0);
        expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    describe('discard()', () => {
        test('deletes by key and logs a named reason and count', async () => {
            ddbMock.on(DeleteCommand).resolves({});
            const item = makeItem({ progress: { attemptCount: 10 } });
            await backend.discard(item, 'permanent_error');
            expect(ddbMock.commandCalls(DeleteCommand)[0]?.args[0].input.Key).toEqual({ PK: 'OUTBOX#discord', SK: `ITEM#1#${DEDUPE_KEY}` });
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: item.id, reason: 'permanent_error', attemptCount: 10 }),
                'Discarded outbox item'
            );
        });

        test('propagates a failed discard delete without logging success', async () => {
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));
            await expect(backend.discard(makeItem(), 'stale_epoch')).rejects.toThrow('delete failed');
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });
    });

    describe('acknowledgeDelivered()', () => {
        test('deletes item with correct PK and SK', async () => {
            ddbMock.on(DeleteCommand).resolves({});
            const item = makeItem();

            await backend.acknowledgeDelivered(item);

            const calls = ddbMock.commandCalls(DeleteCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input).toMatchObject({
                TableName: 'TestTable',
                Key:       {
                    PK: 'OUTBOX#discord',
                    SK: `ITEM#1#${DEDUPE_KEY}`,
                },
            });
        });

        test('propagates a failed delete', async () => {
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));

            await expect(backend.acknowledgeDelivered(makeItem())).rejects.toThrow('delete failed');
        });
    });

    describe('markFailed()', () => {
        test('increments an existing retry count without deleting', async () => {
            ddbMock.on(PutCommand).resolves({});
            await backend.markFailed(makeItem({ progress: { attemptCount: 1 } }), 'still offline', { retryable: true });
            expect((ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.progress as { attemptCount: number }).attemptCount).toBe(2);
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
        });

        test('terminal failure deletes without a retry write', async () => {
            ddbMock.on(DeleteCommand).resolves({});
            await backend.markFailed(makeItem({ progress: { attemptCount: 9 } }), 'offline', { retryable: false });
            expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ reason: 'permanent_error', attemptCount: 10 }),
                'Discarded outbox item'
            );
        });

        test('failed terminal delete persists exhausted marker before rethrowing', async () => {
            ddbMock.on(DeleteCommand).rejects(new Error('delete failed'));
            ddbMock.on(PutCommand).resolves({});
            await expect(backend.markFailed(makeItem({ progress: { attemptCount: 9 } }), 'offline', { retryable: false })).rejects.toThrow('delete failed');
            expect((ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item?.progress as { attemptCount: number }).attemptCount).toBe(10);
        });

        test('puts item back with error message and lastAttemptAt timestamp', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem();

            const before = new Date().toISOString();
            await backend.markFailed(item, 'Connection refused', { retryable: true });
            const after = new Date().toISOString();

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const stored = calls[0].args[0].input.Item!;
            expect(stored.PK).toBe('OUTBOX#discord');
            expect(stored.SK).toBe(`ITEM#1#${DEDUPE_KEY}`);
            expect((stored.progress as { attemptCount: number }).attemptCount).toBe(1);
            expect((stored.progress as { lastError: string }).lastError).toBe('Connection refused');
            const lastAttemptAt = (stored.progress as { lastAttemptAt: string }).lastAttemptAt;
            expect(lastAttemptAt >= before).toBe(true);
            expect(lastAttemptAt <= after).toBe(true);
        });

        test('uses default TTL when item.ttl is undefined', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem({ ttl: undefined });

            const before = Math.floor(Date.now() / 1000);
            await backend.markFailed(item, 'err', { retryable: true });
            const after = Math.floor(Date.now() / 1000);

            const calls = ddbMock.commandCalls(PutCommand);
            const stored = calls[0].args[0].input.Item!;
            const twentyFourHours = 24 * 60 * 60;
            expect(stored.TTL as number).toBeGreaterThanOrEqual(before + twentyFourHours);
            expect(stored.TTL as number).toBeLessThanOrEqual(after + twentyFourHours);
        });

        test('uses custom TTL when item.ttl is provided', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem({ ttl: createEpochSeconds(1_234_567) });

            await backend.markFailed(item, 'err', { retryable: true });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls[0].args[0].input.Item!.TTL).toBe(1_234_567);
        });

        test('propagates a failed retry write', async () => {
            ddbMock.on(PutCommand).rejects(new Error('retry write failed'));

            await expect(backend.markFailed(makeItem(), 'err', { retryable: true })).rejects.toThrow('retry write failed');
        });
    });
});
