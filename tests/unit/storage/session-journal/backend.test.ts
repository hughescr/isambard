import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { SessionJournalBackend } from '@/storage/session-journal/backend';

describe('SessionJournalBackend', () => {
    let ddbMock: ReturnType<typeof mockClient>;
    let backend: SessionJournalBackend;

    beforeEach(() => {
        ddbMock = mockClient(DynamoDBDocumentClient);
        backend = new SessionJournalBackend(ddbMock as unknown as DynamoDBDocumentClient, 'TestTable');
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        ddbMock.restore();
        jest.restoreAllMocks();
    });

    describe('append', () => {
        test('writes PK/SK/TTL shape with no GSI1PK/GSI1SK', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.append('conversation', { type: 'shutdown', at: new Date('2026-09-05T10:00:00.000Z') });

            const calls = ddbMock.commandCalls(PutCommand);
            expect(calls).toHaveLength(1);
            const item = calls[0].args[0].input.Item as Record<string, unknown>;
            expect(item.PK).toBe('SESSION_JOURNAL#conversation');
            expect(item.SK).toBe('2026-09-05T10:00:00.000Z#000000');
            expect(typeof item.TTL).toBe('number');
            expect(item.GSI1PK).toBeUndefined();
            expect(item.GSI1SK).toBeUndefined();
            expect(item.type).toBe('shutdown');
            expect(item.at).toBe('2026-09-05T10:00:00.000Z');
        });

        test('pads seq to 6 digits and increments across successive appends to the same role', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.append('conversation', { type: 'shutdown', at: new Date('2026-09-05T10:00:00.000Z') });
            await backend.append('conversation', { type: 'shutdown', at: new Date('2026-09-05T10:00:00.000Z') });

            const calls = ddbMock.commandCalls(PutCommand);
            const firstItem = calls[0].args[0].input.Item as Record<string, unknown>;
            const secondItem = calls[1].args[0].input.Item as Record<string, unknown>;
            expect(firstItem.SK).toBe('2026-09-05T10:00:00.000Z#000000');
            expect(secondItem.SK).toBe('2026-09-05T10:00:00.000Z#000001');
        });

        test('honors an explicit ttlDays', async () => {
            ddbMock.on(PutCommand).resolves({});
            const nowSeconds = Math.floor(Date.now() / 1000);

            await backend.append('perch', { type: 'shutdown', at: new Date() }, 7);

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            const ttl = item.TTL as number;
            expect(ttl).toBeGreaterThanOrEqual(nowSeconds + 6 * 86_400);
            expect(ttl).toBeLessThanOrEqual(nowSeconds + 8 * 86_400);
        });

        test('TTL defaults to 30 days out when ttlDays is omitted', async () => {
            ddbMock.on(PutCommand).resolves({});
            const nowSeconds = Math.floor(Date.now() / 1000);

            await backend.append('perch', { type: 'shutdown', at: new Date() });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            const ttl = item.TTL as number;
            expect(ttl).toBeGreaterThanOrEqual(nowSeconds + 29 * 86_400);
            expect(ttl).toBeLessThanOrEqual(nowSeconds + 31 * 86_400);
        });

        test('carries entry-specific fields onto the stored item', async () => {
            ddbMock.on(PutCommand).resolves({});

            await backend.append('conversation', {
                type: 'response_delivered', at: new Date('2026-09-05T10:00:00.000Z'), envelopeId: 'e1', channelId: 'chan-1', messageIds: ['m1'],
            });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item.envelopeId).toBe('e1');
            expect(item.channelId).toBe('chan-1');
            expect(item.messageIds).toEqual(['m1']);
        });
    });

    describe('readSince', () => {
        test('queries ascending with KeyConditionExpression #pk = :pk AND #sk >= :since', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [] });

            await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            const calls = ddbMock.commandCalls(QueryCommand);
            expect(calls).toHaveLength(1);
            const input = calls[0].args[0].input;
            expect(input.KeyConditionExpression).toBe('#pk = :pk AND #sk >= :since');
            expect(input.ExpressionAttributeNames).toEqual({ '#pk': 'PK', '#sk': 'SK' });
            expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'SESSION_JOURNAL#conversation', ':since': '2026-09-01T00:00:00.000Z' });
            expect(input.ScanIndexForward).toBe(true);
        });

        test('follows LastEvaluatedKey across two pages and concatenates results in order', async () => {
            const rowA = {
                PK: 'SESSION_JOURNAL#conversation', SK: 'a', TTL: 1, type: 'shutdown', at: '2026-09-05T10:00:00.000Z',
            };
            const rowB = {
                PK: 'SESSION_JOURNAL#conversation', SK: 'b', TTL: 1, type: 'shutdown', at: '2026-09-05T10:00:01.000Z',
            };
            ddbMock.on(QueryCommand)
                .resolvesOnce({ Items: [rowA], LastEvaluatedKey: { PK: 'x', SK: 'a' } })
                .resolvesOnce({ Items: [rowB] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
            expect(entries.map(entry => entry.at.toISOString())).toEqual(['2026-09-05T10:00:00.000Z', '2026-09-05T10:00:01.000Z']);
        });

        test('skips a row that fails journalEntrySchema with exactly one logger.warn, keeping the rest', async () => {
            const badRow = {
                PK: 'SESSION_JOURNAL#conversation', SK: 'bad', TTL: 1, type: 'not_a_real_kind',
            };
            const goodRow = {
                PK: 'SESSION_JOURNAL#conversation', SK: 'good', TTL: 1, type: 'shutdown', at: '2026-09-05T10:00:00.000Z',
            };
            ddbMock.on(QueryCommand).resolves({ Items: [badRow, goodRow] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(entries).toHaveLength(1);
            expect(entries[0]?.type).toBe('shutdown');
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        // Every JournalEntry['type'] member round-trips through journalEntrySchema, exercising
        // every z.enum member list on the way (envelopeKind, sessionRole, compaction trigger) —
        // `satisfies z.ZodType<JournalEntry>` cannot catch a schema whose output union is merely a
        // SUBSET of JournalEntry (e.g. a deleted union member, or an enum narrowed to fewer
        // values), so this table is the runtime guarantee that gap leaves open.
        const BASE = { PK: 'SESSION_JOURNAL#conversation', TTL: 1, at: '2026-09-05T10:00:00.000Z' };
        const ALL_ENTRY_ROWS: Record<string, unknown>[] = [
            {
                ...BASE, SK: 'a', type: 'envelope_submitted', envelopeId: 'e1', kind: 'discord', channelId: 'chan-1',
            },
            {
                ...BASE, SK: 'b', type: 'response_delivered', envelopeId: 'e1', channelId: 'chan-1', messageIds: ['m1'],
            },
            {
                ...BASE, SK: 'c', type: 'turn_completed', envelopeId: 'e1', kind: 'catchup', responseText: 'hi', truncated: false,
            },
            {
                ...BASE, SK: 'd', type: 'turn_failed', envelopeId: 'e1', kind: 'perch', error: 'boom',
            },
            {
                ...BASE, SK: 'e', type: 'task_started', taskId: 't1', description: 'do the thing',
            },
            { ...BASE, SK: 'f', type: 'task_completed', taskId: 't1', description: 'do the thing' },
            { ...BASE, SK: 'g', type: 'task_lost', taskId: 't1', description: 'do the thing' },
            { ...BASE, SK: 'h', type: 'compaction_started', trigger: 'manual' },
            { ...BASE, SK: 'i', type: 'compaction_completed', summaryPath: '/events/compaction/x' },
            { ...BASE, SK: 'j', type: 'compaction_failed', error: 'timeout' },
            {
                ...BASE, SK: 'k', type: 'session_opened', role: 'perch', sessionId: 'sess-1', resumed: true, fallback: true,
            },
            { ...BASE, SK: 'l', type: 'session_ended', sessionId: 'sess-1' },
            { ...BASE, SK: 'm', type: 'shutdown' },
            {
                ...BASE, SK: 'n', type: 'cost_ceiling_snapshot', dateKey: '2026-09-05', totalUsd: 1.23, paused: true,
            },
        ];

        test('every JournalEntry member round-trips through readSince with no malformed rows', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: ALL_ENTRY_ROWS });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(entries.map(entry => entry.type as string)).toEqual(ALL_ENTRY_ROWS.map(row => row.type as string));
            expect(entries).toHaveLength(ALL_ENTRY_ROWS.length);
        });

        test.each(ALL_ENTRY_ROWS.map(row => [row.type as string, row] as const))('%s parses to its own type with fields intact', async (type, row) => {
            ddbMock.on(QueryCommand).resolves({ Items: [row] });
            const { PK: _pk, SK: _sk, TTL: _ttl, ...expectedFields } = row;

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ ...expectedFields, at: expect.any(Date) as Date });
            expect(entries[0]?.type as string).toBe(type);
        });
    });
});
