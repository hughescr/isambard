import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import {
    DynamoDBDocumentClient,
    PutCommand,
    QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { mockLogger } from '../../../setup';
import { SessionJournalBackend } from '@/storage/session-journal/backend';
import { journalEntrySchema } from '@/storage/session-journal/types';

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
        jest.useRealTimers();
    });

    describe('journal entry schema', () => {
        const responseDelivered = {
            at: new Date('2026-09-05T10:00:00.000Z'), type: 'response_delivered', envelopeId: 'e1', channelId: 'chan-1', messageIds: ['m1'],
        } as const;

        test.each(['sent', 'queued'] as const)('accepts response_delivered disposition %s', (disposition) => {
            expect(journalEntrySchema.safeParse({ ...responseDelivered, disposition }).success).toBe(true);
        });

        test('rejects an unknown response_delivered disposition', () => {
            expect(journalEntrySchema.safeParse({ ...responseDelivered, disposition: 'delayed' }).success).toBe(false);
        });

        const sessionOpenedBase = {
            at: '2026-09-05T10:00:00.000Z', type: 'session_opened', role: 'conversation', sessionId: 'sess-1',
        } as const;

        test('a session_opened row with outcome and cause parses to that outcome and cause', () => {
            expect(journalEntrySchema.parse({ ...sessionOpenedBase, outcome: 'resumed', cause: 'crash_reopen' })).toEqual({
                type: 'session_opened', at: new Date('2026-09-05T10:00:00.000Z'), role: 'conversation', sessionId: 'sess-1', outcome: 'resumed', cause: 'crash_reopen',
            });
        });

        test.each(['fresh', 'resumed', 'resume_fallback'] as const)('accepts session_opened outcome %s', (outcome) => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, outcome, cause: 'boot' }).success).toBe(true);
        });

        test.each(['boot', 'crash_reopen', 'requested_reopen'] as const)('accepts session_opened cause %s', (cause) => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, outcome: 'fresh', cause }).success).toBe(true);
        });

        test('rejects an unknown session_opened outcome', () => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, outcome: 'reopened', cause: 'boot' }).success).toBe(false);
        });

        test('rejects an unknown session_opened cause', () => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, outcome: 'fresh', cause: 'restart' }).success).toBe(false);
        });

        test('rejects a new-shape session_opened row with no cause', () => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, outcome: 'fresh' }).success).toBe(false);
        });

        // Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25.
        test.each([
            ['{ resumed: true }', { resumed: true }, 'resumed'],
            ['{ resumed: false }', { resumed: false }, 'fresh'],
            ['{ resumed: false, fallback: true }', { resumed: false, fallback: true }, 'resume_fallback'],
            ['{ resumed: true, fallback: false }', { resumed: true, fallback: false }, 'resumed'],
            // Never produced by any writer; normalised deterministically (fallback wins) rather than rejected.
            ['{ resumed: true, fallback: true }', { resumed: true, fallback: true }, 'resume_fallback'],
        ] as const)('a legacy session_opened %s row normalises deterministically, with no cause', (_label, legacyFields, outcome) => {
            expect(journalEntrySchema.parse({ ...sessionOpenedBase, ...legacyFields })).toEqual({
                type: 'session_opened', at: new Date('2026-09-05T10:00:00.000Z'), role: 'conversation', sessionId: 'sess-1', outcome,
            });
        });

        // Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25.
        test('a legacy session_opened row still validates its common fields', () => {
            expect(journalEntrySchema.safeParse({ ...sessionOpenedBase, role: 'nobody', resumed: true }).success).toBe(false);
        });

        test.each(['completed', 'failed', 'stopped'] as const)('accepts task_finished outcome %s', (outcome) => {
            expect(journalEntrySchema.parse({
                at: '2026-09-05T10:00:00.000Z', type: 'task_finished', taskId: 't1', description: 'd', outcome,
            })).toEqual({ type: 'task_finished', at: new Date('2026-09-05T10:00:00.000Z'), taskId: 't1', description: 'd', outcome });
        });

        test('rejects a task_finished row with an unknown or missing outcome', () => {
            const row = { at: '2026-09-05T10:00:00.000Z', type: 'task_finished', taskId: 't1' };
            expect(journalEntrySchema.safeParse({ ...row, outcome: 'running' }).success).toBe(false);
            expect(journalEntrySchema.safeParse(row).success).toBe(false);
        });

        const envelopeSubmittedBase = {
            at: '2026-09-05T10:00:00.000Z', type: 'envelope_submitted', envelopeId: 'e1',
        } as const;

        // Legacy pre-#76 journal rows: can be safely deleted 30 days after deploy, once every
        // legacy row (30-day TTL) has expired — see the dated comment on envelopeKindSchema.
        test('a legacy envelope_submitted row with kind: \'resume\' parses to kind: \'continuation\'', () => {
            expect(journalEntrySchema.parse({ ...envelopeSubmittedBase, kind: 'resume' })).toEqual({
                type: 'envelope_submitted', at: new Date('2026-09-05T10:00:00.000Z'), envelopeId: 'e1', kind: 'continuation',
            });
        });

        test('an envelope_submitted row with kind: \'continuation\' parses unchanged', () => {
            expect(journalEntrySchema.parse({ ...envelopeSubmittedBase, kind: 'continuation' })).toEqual({
                type: 'envelope_submitted', at: new Date('2026-09-05T10:00:00.000Z'), envelopeId: 'e1', kind: 'continuation',
            });
        });

        test('rejects an unknown envelope_submitted kind', () => {
            expect(journalEntrySchema.safeParse({ ...envelopeSubmittedBase, kind: 'bogus' }).success).toBe(false);
        });
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

        test('TTL defaults to exactly 30 days out when ttlDays is omitted', async () => {
            const now = new Date('2026-09-05T10:00:00.000Z');
            jest.useFakeTimers();
            jest.setSystemTime(now);
            ddbMock.on(PutCommand).resolves({});

            await backend.append('perch', { type: 'shutdown', at: now });

            const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, unknown>;
            expect(item.TTL).toBe(Math.floor(now.getTime() / 1000) + 30 * 86_400);
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
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
                role:  'conversation',
                raw:   badRow,
                error: expect.anything(),
                msg:   'SessionJournalBackend.readSince(): skipping malformed journal row',
            }));
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
            // Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25.
            { ...BASE, SK: 'f', type: 'task_completed', taskId: 't1', description: 'do the thing' },
            {
                ...BASE, SK: 'f2', type: 'task_finished', taskId: 't1', description: 'do the thing', outcome: 'failed',
            },
            { ...BASE, SK: 'g', type: 'task_lost', taskId: 't1', description: 'do the thing' },
            { ...BASE, SK: 'h', type: 'compaction_started', trigger: 'manual' },
            { ...BASE, SK: 'i', type: 'compaction_completed' },
            { ...BASE, SK: 'j', type: 'compaction_failed', error: 'timeout' },
            {
                ...BASE, SK: 'k', type: 'session_opened', role: 'perch', sessionId: 'sess-1', outcome: 'resume_fallback', cause: 'requested_reopen',
            },
            { ...BASE, SK: 'l', type: 'session_ended', sessionId: 'sess-1' },
            { ...BASE, SK: 'm', type: 'shutdown' },
            {
                ...BASE, SK: 'n', type: 'cost_ceiling_snapshot', dateKey: '2026-09-05', totalUsd: 1.23, paused: true,
            },
            {
                ...BASE, SK: 'o', type: 'task_launched', taskId: 'task-1', toolUseId: 'tool-1', toolName: 'Agent', envelopeId: 'e2', kind: 'discord', channelId: 'chan-1', authorId: 'user-1', description: 'do background work',
            },
            {
                ...BASE, SK: 'p', type: 'turn_completed', envelopeId: 'e3', kind: 'task', responseText: 'done',
            },
            {
                ...BASE, SK: 'q', type: 'session_reopen_requested', role: 'conversation', reason: 'an identity change',
            },
        ];

        test('every JournalEntry member round-trips through readSince with no malformed rows', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: ALL_ENTRY_ROWS });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(entries.map(entry => entry.type as string)).toEqual(ALL_ENTRY_ROWS.map(row => row.type as string));
            expect(entries).toHaveLength(ALL_ENTRY_ROWS.length);
        });

        test('a pre-change response_delivered row without disposition still parses', async () => {
            const legacyRow = ALL_ENTRY_ROWS.find(row => row.type === 'response_delivered')!;
            ddbMock.on(QueryCommand).resolves({ Items: [legacyRow] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                type: 'response_delivered', envelopeId: 'e1', channelId: 'chan-1', messageIds: ['m1'],
            });
            expect('disposition' in entries[0]).toBe(false);
            expect(mockLogger.warn).not.toHaveBeenCalled();
        });

        test('a legacy response_delivered row with an empty channelId still parses', async () => {
            const legacyRow = ALL_ENTRY_ROWS.find(row => row.type === 'response_delivered')!;
            ddbMock.on(QueryCommand).resolves({ Items: [{ ...legacyRow, channelId: '' }] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(entries).toHaveLength(1);
            expect(entries[0]).toEqual({
                type: 'response_delivered', at: new Date(BASE.at), envelopeId: 'e1', channelId: '', messageIds: ['m1'],
            });
            expect(mockLogger.warn).not.toHaveBeenCalled();
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

        // Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25.
        test('stored legacy task_completed and session_opened rows still parse, the latter normalised to an outcome', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [
                { ...BASE, SK: 'r1', type: 'task_completed', taskId: 't1' },
                {
                    ...BASE, SK: 'r2', type: 'session_opened', role: 'conversation', sessionId: 'sess-1', resumed: false, fallback: true,
                },
            ] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(mockLogger.warn).not.toHaveBeenCalled();
            expect(entries).toEqual([
                { type: 'task_completed', at: new Date('2026-09-05T10:00:00.000Z'), taskId: 't1' },
                {
                    type: 'session_opened', at: new Date('2026-09-05T10:00:00.000Z'), role: 'conversation', sessionId: 'sess-1', outcome: 'resume_fallback',
                },
            ]);
        });

        test('a session_reopen_requested row with no reason is rejected as malformed', async () => {
            ddbMock.on(QueryCommand).resolves({ Items: [{
                ...BASE, SK: 'r', type: 'session_reopen_requested', role: 'conversation',
            }] });

            const entries = await backend.readSince('conversation', '2026-09-01T00:00:00.000Z');

            expect(entries).toHaveLength(0);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });
    });
});
