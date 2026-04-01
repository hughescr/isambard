import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand,
    DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { OutboxBackend } from '@/services/outbox/backend';
import type { OutboxItem } from '@/services/outbox/types';

const ITEM_ID    = 'aaaaaaaa-1111-4222-8333-444444444444';
const DEDUPE_KEY = 'dedup-abc';
const CREATED   = '2026-03-30T12:00:00.000Z';

function makeItem(overrides?: Partial<OutboxItem>): OutboxItem {
    return {
        id:          ITEM_ID,
        createdAt:   CREATED,
        type:        'agent_response',
        service:     'discord',
        destination: 'channel-123',
        payload:     { text: 'Hello world' },
        priority:    'medium',
        dedupeKey:   'dedup-abc',
        progress:    {},
        epoch:       1,
        ...overrides,
    };
}

describe('OutboxBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: OutboxBackend;

    beforeEach(() => {
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
            const customTtl = 9_999_999;
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
    });

    describe('dequeue()', () => {
        test('queries with correct PK and default limit of 10', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.dequeue('discord');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.ExpressionAttributeValues).toMatchObject({ ':pk': 'OUTBOX#discord' });
            expect(input.Limit).toBe(10);
            expect(input.ScanIndexForward).toBe(true);
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
                destination: 'channel-123',
                priority:    'medium',
            });
            // PK/SK from DynamoDB should not blow up parse (extra keys are stripped by schema)
        });

        test('returns empty array when no items in query result', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            const result = await backend.dequeue('discord');

            expect(result).toEqual([]);
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

    describe('markSent()', () => {
        test('deletes item with correct PK and SK', async () => {
            ddbMock.on(DeleteCommand).resolves({});
            const item = makeItem();

            await backend.markSent(item);

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
    });

    describe('markFailed()', () => {
        test('puts item back with error message and lastAttemptAt timestamp', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem();

            const before = new Date().toISOString();
            await backend.markFailed(item, 'Connection refused');
            const after = new Date().toISOString();

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const stored = calls[0].args[0].input.Item!;
            expect(stored.PK).toBe('OUTBOX#discord');
            expect(stored.SK).toBe(`ITEM#1#${DEDUPE_KEY}`);
            expect((stored.progress as { lastError: string }).lastError).toBe('Connection refused');
            const lastAttemptAt = (stored.progress as { lastAttemptAt: string }).lastAttemptAt;
            expect(lastAttemptAt >= before).toBe(true);
            expect(lastAttemptAt <= after).toBe(true);
        });

        test('uses default TTL when item.ttl is undefined', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem({ ttl: undefined });

            const before = Math.floor(Date.now() / 1000);
            await backend.markFailed(item, 'err');
            const after = Math.floor(Date.now() / 1000);

            const calls = ddbMock.commandCalls(PutCommand);
            const stored = calls[0].args[0].input.Item!;
            const twentyFourHours = 24 * 60 * 60;
            expect(stored.TTL as number).toBeGreaterThanOrEqual(before + twentyFourHours);
            expect(stored.TTL as number).toBeLessThanOrEqual(after + twentyFourHours);
        });

        test('uses custom TTL when item.ttl is provided', async () => {
            ddbMock.on(PutCommand).resolves({});
            const item = makeItem({ ttl: 1_234_567 });

            await backend.markFailed(item, 'err');

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls[0].args[0].input.Item!.TTL).toBe(1_234_567);
        });
    });
});
