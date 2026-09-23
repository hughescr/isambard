import { describe, test, expect, beforeEach, afterEach, spyOn, jest, type mock } from 'bun:test';
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@hughescr/logger';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoTimeoutError } from '@/errors';
import { CalendarRegistryBackend } from '@/integrations/caldav/calendar-registry/backend';
import { createCalendarServerId, type CalendarRegistryRecord, type CalendarServerEntry } from '@/integrations/caldav/calendar-registry/types';
import { type DynamoTimeoutOptions } from '@/storage/dynamo-retry';
import * as dynamoRetry from '@/storage/dynamo-retry';

const VALID_UUID_1 = createCalendarServerId('550e8400-e29b-41d4-a716-446655440001');
const VALID_UUID_2 = createCalendarServerId('550e8400-e29b-41d4-a716-446655440002');
const VALID_URL    = 'https://caldav.example.com/';
const TABLE_NAME   = 'test-table';

const makeServer = (overrides?: Partial<CalendarServerEntry>): CalendarServerEntry => ({
    serverId:    VALID_UUID_1,
    description: 'My CalDAV server',
    serverUrl:   VALID_URL,
    username:    'alice',
    password:    'secret',
    calendars:   [{ calendarPath: '/calendars/alice/personal/', label: 'Personal' }],
    ...overrides,
});

const makeRecord = (userId: string, servers: CalendarServerEntry[] = []): CalendarRegistryRecord => ({
    scope:     userId === 'SHARED' ? { kind: 'shared' } : { kind: 'personal', userId },
    servers,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('CalendarRegistryBackend', () => {
    const ddbMock = mockClient(DynamoDBDocumentClient);
    let backend: CalendarRegistryBackend;
    let withDynamoTimeoutSpy: ReturnType<typeof mock>;

    beforeEach(() => {
        ddbMock.reset();

        withDynamoTimeoutSpy = spyOn(dynamoRetry, 'withDynamoTimeout').mockImplementation(
            async <T>(operation: () => Promise<T>): Promise<T> => operation()
        );

        backend = new CalendarRegistryBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            TABLE_NAME
        );
    });

    afterEach(() => {
        ddbMock.restore();
        withDynamoTimeoutSpy.mockRestore();
        jest.useRealTimers();
    });

    test('legacy body owner cannot override the authoritative personal PK scope', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { ...makeRecord('user-123'), userId: 'SHARED', scope: { kind: 'shared' }, PK: 'CALCAL#user-123', SK: 'CALENDARS' } });
        expect(await backend.getUserRecord('user-123')).toEqual(makeRecord('user-123'));
    });

    test('a pre-scope personal row with only a userId body decodes its scope from the PK', async () => {
        const { scope: _scope, ...legacyBody } = makeRecord('user-123', [makeServer()]);
        ddbMock.on(GetCommand).resolves({ Item: { ...legacyBody, userId: 'user-123', PK: 'CALCAL#user-123', SK: 'CALENDARS' } });
        expect(await backend.getUserRecord('user-123')).toEqual(makeRecord('user-123', [makeServer()]));
    });

    test('a pre-scope shared row with userId SHARED decodes to the shared scope', async () => {
        const { scope: _scope, ...legacyBody } = makeRecord('SHARED', [makeServer()]);
        ddbMock.on(GetCommand).resolves({ Item: { ...legacyBody, userId: 'SHARED', PK: 'CALCAL#SHARED', SK: 'CALENDARS' } });
        expect(await backend.getSharedRecord()).toEqual(makeRecord('SHARED', [makeServer()]));
    });

    test('rewriting a pre-scope row writes the scope and keeps the legacy userId', async () => {
        const { scope: _scope, ...legacyBody } = makeRecord('SHARED', [makeServer()]);
        ddbMock.on(GetCommand).resolves({ Item: { ...legacyBody, userId: 'SHARED', PK: 'CALCAL#SHARED', SK: 'CALENDARS' } });
        ddbMock.on(PutCommand).resolves({});

        expect(await backend.removeSharedServer(VALID_UUID_1)).toBe(true);

        const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
        expect(putItem).toEqual({ scope: { kind: 'shared' }, userId: 'SHARED', servers: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: expect.any(String), PK: 'CALCAL#SHARED', SK: 'CALENDARS' });
    });

    test('legacy shared body decodes from its PK despite a conflicting personal owner', async () => {
        ddbMock.on(GetCommand).resolves({ Item: { ...makeRecord('SHARED'), userId: 'u1', scope: { kind: 'personal', userId: 'u1' }, PK: 'CALCAL#SHARED', SK: 'CALENDARS' } });
        expect(await backend.getSharedRecord()).toEqual(makeRecord('SHARED'));
    });

    describe('getUserRecord', () => {
        test('should return record when found', async () => {
            const record = makeRecord('user-123', [makeServer()]);
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...record,
                    PK: 'CALCAL#user-123',
                    SK: 'CALENDARS',
                },
            });

            const result = await backend.getUserRecord('user-123');

            expect(result).toEqual(record);
            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.TableName).toBe(TABLE_NAME);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'CALCAL#user-123',
                SK: 'CALENDARS',
            });
        });

        test('should return null when record not found', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.getUserRecord('user-missing');

            expect(result).toBeNull();
        });

        test('should strip DynamoDB keys from response', async () => {
            const record = makeRecord('user-123');
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...record,
                    PK: 'CALCAL#user-123',
                    SK: 'CALENDARS',
                },
            });

            const result = await backend.getUserRecord('user-123');

            expect(result).not.toHaveProperty('PK');
            expect(result).not.toHaveProperty('SK');
        });

        test('should pass operation name to withDynamoTimeout', async () => {
            ddbMock.on(GetCommand).resolves({});

            await backend.getUserRecord('user-123');

            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'CalendarRegistry.getRecord' })
            );
        });

        test('returns null and logs when the stored row fails schema validation', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(GetCommand).resolves({
                Item: {
                    servers:   [{ serverId: VALID_UUID_1 }], // missing required calendarServerEntrySchema fields
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    PK:        'CALCAL#user-123',
                    SK:        'CALENDARS',
                },
            });

            const result = await backend.getUserRecord('user-123');

            expect(result).toBeNull();
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ pk: 'CALCAL#user-123' }),
                'CalendarRegistryBackend.getRecord: stored row failed validation'
            );

            warnSpy.mockRestore();
        });
    });

    describe('getSharedRecord', () => {
        test('should return shared record when found', async () => {
            const record = makeRecord('SHARED', [makeServer()]);
            ddbMock.on(GetCommand).resolves({
                Item: {
                    ...record,
                    PK: 'CALCAL#SHARED',
                    SK: 'CALENDARS',
                },
            });

            const result = await backend.getSharedRecord();

            expect(result).toEqual(record);
            const calls = ddbMock.commandCalls(GetCommand);
            expect(calls).toHaveLength(1);
            expect(calls[0].args[0].input.Key).toEqual({
                PK: 'CALCAL#SHARED',
                SK: 'CALENDARS',
            });
        });

        test('should return null when shared record not found', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.getSharedRecord();

            expect(result).toBeNull();
        });
    });

    describe('getAllCalendars', () => {
        test('should merge user and shared calendars', async () => {
            const userServer = makeServer({ serverId: VALID_UUID_1, description: 'User server' });
            const sharedServer = makeServer({ serverId: VALID_UUID_2, description: 'Shared server' });
            const userRecord = makeRecord('user-123', [userServer]);
            const sharedRecord = makeRecord('SHARED', [sharedServer]);

            ddbMock.on(GetCommand)
                .resolvesOnce({
                    Item: { ...userRecord, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
                })
                .resolvesOnce({
                    Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
                });

            const result = await backend.getAllCalendars('user-123');

            expect(result).toHaveLength(2);
            expect(result[0].description).toBe('User server');
            expect(result[1].description).toBe('Shared server');
        });

        test('should return only user calendars when no shared record', async () => {
            const userServer = makeServer();
            const userRecord = makeRecord('user-123', [userServer]);

            ddbMock.on(GetCommand)
                .resolvesOnce({
                    Item: { ...userRecord, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
                })
                .resolvesOnce({});

            const result = await backend.getAllCalendars('user-123');

            expect(result).toHaveLength(1);
            expect(result[0].description).toBe('My CalDAV server');
        });

        test('should return only shared calendars when no user record', async () => {
            const sharedServer = makeServer({ serverId: VALID_UUID_2, description: 'Shared server' });
            const sharedRecord = makeRecord('SHARED', [sharedServer]);

            ddbMock.on(GetCommand)
                .resolvesOnce({})
                .resolvesOnce({
                    Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
                });

            const result = await backend.getAllCalendars('user-123');

            expect(result).toHaveLength(1);
            expect(result[0].description).toBe('Shared server');
        });

        test('should return empty array when both records missing', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.getAllCalendars('user-123');

            expect(result).toEqual([]);
        });
    });

    describe('addServer', () => {
        test('does not report completion until the registry write completes', async () => {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate = Promise.withResolvers<void>();
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});
            withDynamoTimeoutSpy.mockImplementation(async <T>(operation: () => Promise<T>, options: DynamoTimeoutOptions): Promise<T> => {
                if(options.operation === 'CalendarRegistry.putRecord') {
                    writeStarted.resolve();
                    await writeGate.promise;
                }
                return operation();
            });

            const operation = backend.addServer('user-123', makeServer());
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await Bun.sleep(0);
                expect(completed).toBe(false);
            } finally {
                writeGate.resolve();
                await operation;
            }
        });

        test('should create new record when none exists', async () => {
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            const server = makeServer();
            await backend.addServer('user-123', server);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const putItem = putCalls[0].args[0].input.Item;
            expect(putItem?.PK).toBe('CALCAL#user-123');
            expect(putItem?.SK).toBe('CALENDARS');
            expect(putItem?.userId).toBe('user-123');
            expect(putItem?.scope).toEqual({ kind: 'personal', userId: 'user-123' });
            expect(putItem?.servers).toHaveLength(1);
            expect(putItem?.servers[0].serverId).toBe(VALID_UUID_1);
            expect(putItem?.createdAt).toBeDefined();
            expect(putItem?.updatedAt).toBeDefined();
        });

        test('should append server to existing record', async () => {
            const existingServer = makeServer({
                serverId:    VALID_UUID_2,
                description: 'Existing server',
            });
            const existingRecord = makeRecord('user-123', [existingServer]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...existingRecord, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const newServer = makeServer({
                serverId:    VALID_UUID_1,
                description: 'New server',
            });
            await backend.addServer('user-123', newServer);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const putItem = putCalls[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(2);
            expect(putItem?.scope).toEqual({ kind: 'personal', userId: 'user-123' });
            expect(putItem?.userId).toBe('user-123');
        });

        test('should pass operation name to withDynamoTimeout', async () => {
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            await backend.addServer('user-123', makeServer());

            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'CalendarRegistry.putRecord' })
            );
        });
    });

    describe('removeServer', () => {
        test('returns only after the removal has been persisted', async () => {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate = Promise.withResolvers<void>();
            const record = makeRecord('user-123', [makeServer()]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});
            withDynamoTimeoutSpy.mockImplementation(async <T>(operation: () => Promise<T>, options: DynamoTimeoutOptions): Promise<T> => {
                if(options.operation === 'CalendarRegistry.putRecord') {
                    writeStarted.resolve();
                    await writeGate.promise;
                }
                return operation();
            });

            const operation = backend.removeServer('user-123', VALID_UUID_1);
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await Bun.sleep(0);
                expect(completed).toBe(false);
            } finally {
                writeGate.resolve();
                await operation;
            }
        });

        test('should remove matching server and return true', async () => {
            const server1 = makeServer({ serverId: VALID_UUID_1, description: 'Server 1' });
            const server2 = makeServer({ serverId: VALID_UUID_2, description: 'Server 2' });
            const record = makeRecord('user-123', [server1, server2]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeServer('user-123', VALID_UUID_1);

            expect(result).toBe(true);
            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const putItem = putCalls[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(1);
            expect(putItem?.servers[0].serverId).toBe(VALID_UUID_2);
        });

        test('updates the removal timestamp and persists it with the revised server list', async () => {
            jest.useFakeTimers();
            try {
                jest.setSystemTime(new Date('2026-03-14T10:00:00.000Z'));
                const record = makeRecord('user-123', [makeServer(), makeServer({ serverId: VALID_UUID_2 })]);
                ddbMock.on(GetCommand).resolves({
                    Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
                });
                ddbMock.on(PutCommand).resolves({});

                await backend.removeServer('user-123', VALID_UUID_1);

                const putItem = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
                expect(putItem).toMatchObject({
                    servers:   [expect.objectContaining({ serverId: VALID_UUID_2 })],
                    updatedAt: '2026-03-14T10:00:00.000Z',
                });
            } finally {
                jest.useRealTimers();
            }
        });

        test('should return false when server not found', async () => {
            const record = makeRecord('user-123', []);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });

            const result = await backend.removeServer('user-123', VALID_UUID_1);

            expect(result).toBe(false);
            expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
        });

        test('should return false when record does not exist', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.removeServer('user-missing', VALID_UUID_1);

            expect(result).toBe(false);
        });
    });

    describe('removeCalendar', () => {
        test('returns only after the calendar removal has been persisted', async () => {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate = Promise.withResolvers<void>();
            const record = makeRecord('user-123', [makeServer()]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});
            withDynamoTimeoutSpy.mockImplementation(async <T>(operation: () => Promise<T>, options: DynamoTimeoutOptions): Promise<T> => {
                if(options.operation === 'CalendarRegistry.putRecord') {
                    writeStarted.resolve();
                    await writeGate.promise;
                }
                return operation();
            });

            const operation = backend.removeCalendar('user-123', VALID_UUID_1, '/calendars/alice/personal/');
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await Bun.sleep(0);
                expect(completed).toBe(false);
            } finally {
                writeGate.resolve();
                await operation;
            }
        });

        test('should remove matching calendar and return true', async () => {
            const server = makeServer({
                calendars: [
                    { calendarPath: '/cal/path1/', label: 'Cal 1' },
                    { calendarPath: '/cal/path2/', label: 'Cal 2' },
                ],
            });
            const record = makeRecord('user-123', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/path1/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers[0].calendars).toHaveLength(1);
            expect(putItem?.servers[0].calendars[0].calendarPath).toBe('/cal/path2/');
        });

        test('should remove entire server when last calendar is removed', async () => {
            const server = makeServer({
                calendars: [{ calendarPath: '/cal/only/', label: 'Only Cal' }],
            });
            const record = makeRecord('user-123', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/only/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(0);
        });

        test('should return false when server not found', async () => {
            const record = makeRecord('user-123', []);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });

            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/path/');

            expect(result).toBe(false);
        });

        test('should return false when calendar not found in server', async () => {
            const server = makeServer({
                calendars: [{ calendarPath: '/cal/different/', label: 'Cal' }],
            });
            const record = makeRecord('user-123', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });

            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/not-here/');

            expect(result).toBe(false);
        });

        test('should return false when record does not exist', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.removeCalendar('user-missing', VALID_UUID_1, '/cal/path/');

            expect(result).toBe(false);
        });

        test('should target correct server when multiple servers exist', async () => {
            const server1 = makeServer({
                serverId:  VALID_UUID_1,
                calendars: [{ calendarPath: '/cal/s1/', label: 'S1 Cal' }],
            });
            const server2 = makeServer({
                serverId:  VALID_UUID_2,
                calendars: [{ calendarPath: '/cal/s2/', label: 'S2 Cal' }],
            });
            const record = makeRecord('user-123', [server1, server2]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            // Remove the only calendar from server2 — server2 should be removed, server1 should remain
            const result = await backend.removeCalendar('user-123', VALID_UUID_2, '/cal/s2/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(1);
            expect(putItem?.servers[0].serverId).toBe(VALID_UUID_1);
        });

        test('should only update target server when multiple servers exist', async () => {
            const server1 = makeServer({
                serverId:  VALID_UUID_1,
                calendars: [
                    { calendarPath: '/cal/s1-a/', label: 'S1 Cal A' },
                    { calendarPath: '/cal/s1-b/', label: 'S1 Cal B' },
                ],
            });
            const server2 = makeServer({
                serverId:  VALID_UUID_2,
                calendars: [{ calendarPath: '/cal/s2/', label: 'S2 Cal' }],
            });
            const record = makeRecord('user-123', [server1, server2]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            // Remove one calendar from server1 — server1 should have 1 calendar, server2 unchanged
            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/s1-a/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(2);
            const updatedServer1 = putItem?.servers.find((s: { serverId: string }) => s.serverId === VALID_UUID_1);
            const updatedServer2 = putItem?.servers.find((s: { serverId: string }) => s.serverId === VALID_UUID_2);
            expect(updatedServer1?.calendars).toHaveLength(1);
            expect(updatedServer1?.calendars[0].calendarPath).toBe('/cal/s1-b/');
            expect(updatedServer2?.calendars).toHaveLength(1);
            expect(updatedServer2?.calendars[0].calendarPath).toBe('/cal/s2/');
        });

        test('should not add extraneous fields to the updated server entry', async () => {
            const server = makeServer({
                calendars: [
                    { calendarPath: '/cal/path1/', label: 'Cal 1' },
                    { calendarPath: '/cal/path2/', label: 'Cal 2' },
                ],
            });
            const record = makeRecord('user-123', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/path1/');

            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers[0]).toEqual({
                ...server,
                calendars: [{ calendarPath: '/cal/path2/', label: 'Cal 2' }],
            });
        });

        test('should set updatedAt to the current time, not the epoch', async () => {
            jest.useFakeTimers();
            try {
                jest.setSystemTime(new Date('2026-03-14T10:00:00.000Z'));
                const server = makeServer({
                    calendars: [{ calendarPath: '/cal/only/', label: 'Only Cal' }],
                });
                const record = makeRecord('user-123', [server]);
                ddbMock.on(GetCommand).resolves({
                    Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
                });
                ddbMock.on(PutCommand).resolves({});

                await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/only/');

                const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
                expect(putItem?.updatedAt).toBe('2026-03-14T10:00:00.000Z');
            } finally {
                jest.useRealTimers();
            }
        });

        test('should remove every entry matching the target serverId when the last calendar is removed', async () => {
            // Two server entries sharing the same serverId (a malformed-but-possible record):
            // findIndex locks onto the first match, but the final removal branch filters by
            // serverId — so removing the last calendar from the first entry must also drop the
            // second entry sharing that id, not merely the entry at the matched index.
            const duplicateServerA = makeServer({
                serverId:  VALID_UUID_1,
                calendars: [{ calendarPath: '/cal/dup-a/', label: 'Dup A' }],
            });
            const duplicateServerB = makeServer({
                serverId:  VALID_UUID_1,
                calendars: [{ calendarPath: '/cal/dup-b/', label: 'Dup B' }],
            });
            const record = makeRecord('user-123', [duplicateServerA, duplicateServerB]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...record, PK: 'CALCAL#user-123', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeCalendar('user-123', VALID_UUID_1, '/cal/dup-a/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(0);
        });
    });

    describe('addSharedServer', () => {
        test('does not report completion until the shared registry write completes', async () => {
            const writeStarted = Promise.withResolvers<void>();
            const writeGate = Promise.withResolvers<void>();
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});
            withDynamoTimeoutSpy.mockImplementation(async <T>(operation: () => Promise<T>, options: DynamoTimeoutOptions): Promise<T> => {
                if(options.operation === 'CalendarRegistry.putRecord') {
                    writeStarted.resolve();
                    await writeGate.promise;
                }
                return operation();
            });

            const operation = backend.addSharedServer(makeServer());
            let completed = false;
            void operation.then(() => {
                completed = true;
                return undefined;
            });

            try {
                await writeStarted.promise;
                await Bun.sleep(0);
                expect(completed).toBe(false);
            } finally {
                writeGate.resolve();
                await operation;
            }
        });

        test('should create new shared record when none exists', async () => {
            ddbMock.on(GetCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            const server = makeServer();
            await backend.addSharedServer(server);

            const putCalls = ddbMock.commandCalls(PutCommand);
            expect(putCalls).toHaveLength(1);
            const putItem = putCalls[0].args[0].input.Item;
            expect(putItem?.PK).toBe('CALCAL#SHARED');
            expect(putItem?.SK).toBe('CALENDARS');
            expect(putItem?.userId).toBe('SHARED');
            expect(putItem?.scope).toEqual({ kind: 'shared' });
            expect(putItem?.servers).toHaveLength(1);
        });

        test('should append server to existing shared record', async () => {
            const existingServer = makeServer({ serverId: VALID_UUID_2 });
            const sharedRecord = makeRecord('SHARED', [existingServer]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const newServer = makeServer({ serverId: VALID_UUID_1 });
            await backend.addSharedServer(newServer);

            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(2);
            expect(putItem?.scope).toEqual({ kind: 'shared' });
            expect(putItem?.userId).toBe('SHARED');
        });
    });

    describe('removeSharedServer', () => {
        test('should remove matching server from shared record and return true', async () => {
            const server = makeServer({ serverId: VALID_UUID_1 });
            const sharedRecord = makeRecord('SHARED', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeSharedServer(VALID_UUID_1);

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(0);
            expect(putItem?.scope).toEqual({ kind: 'shared' });
            expect(putItem?.userId).toBe('SHARED');
        });

        test('should return false when server not found in shared record', async () => {
            const sharedRecord = makeRecord('SHARED', []);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });

            const result = await backend.removeSharedServer(VALID_UUID_1);

            expect(result).toBe(false);
        });

        test('should return false when shared record does not exist', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.removeSharedServer(VALID_UUID_1);

            expect(result).toBe(false);
        });
    });

    describe('removeSharedCalendar', () => {
        test('should remove matching calendar from shared record and return true', async () => {
            const server = makeServer({
                calendars: [
                    { calendarPath: '/cal/path1/', label: 'Cal 1' },
                    { calendarPath: '/cal/path2/', label: 'Cal 2' },
                ],
            });
            const sharedRecord = makeRecord('SHARED', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeSharedCalendar(VALID_UUID_1, '/cal/path1/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers[0].calendars).toHaveLength(1);
        });

        test('should remove server from shared record when last calendar removed', async () => {
            const server = makeServer({
                calendars: [{ calendarPath: '/cal/only/', label: 'Only' }],
            });
            const sharedRecord = makeRecord('SHARED', [server]);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });
            ddbMock.on(PutCommand).resolves({});

            const result = await backend.removeSharedCalendar(VALID_UUID_1, '/cal/only/');

            expect(result).toBe(true);
            const putItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
            expect(putItem?.servers).toHaveLength(0);
        });

        test('should return false when server not in shared record', async () => {
            const sharedRecord = makeRecord('SHARED', []);
            ddbMock.on(GetCommand).resolves({
                Item: { ...sharedRecord, PK: 'CALCAL#SHARED', SK: 'CALENDARS' },
            });

            const result = await backend.removeSharedCalendar(VALID_UUID_1, '/cal/path/');

            expect(result).toBe(false);
        });

        test('should return false when shared record does not exist', async () => {
            ddbMock.on(GetCommand).resolves({});

            const result = await backend.removeSharedCalendar(VALID_UUID_1, '/cal/path/');

            expect(result).toBe(false);
        });
    });

    describe('listRegisteredUserIds', () => {
        test('should return user IDs from scan results', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CALCAL#user-alice' },
                    { PK: 'CALCAL#user-bob' },
                ],
            });

            const result = await backend.listRegisteredUserIds();

            expect(result).toEqual(['user-alice', 'user-bob']);

            const scanCalls = ddbMock.commandCalls(ScanCommand);
            expect(scanCalls).toHaveLength(1);
            expect(scanCalls[0].args[0].input.TableName).toBe(TABLE_NAME);
        });

        test('should exclude SHARED from results', async () => {
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CALCAL#user-alice' },
                    { PK: 'CALCAL#SHARED' },
                ],
            });

            const result = await backend.listRegisteredUserIds();

            expect(result).toEqual(['user-alice']);
            expect(result).not.toContain('SHARED');
        });

        test('should return empty array when no registrations exist', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            const result = await backend.listRegisteredUserIds();

            expect(result).toEqual([]);
        });

        test('should return empty array when Items is undefined', async () => {
            ddbMock.on(ScanCommand).resolves({});

            const result = await backend.listRegisteredUserIds();

            expect(result).toEqual([]);
        });

        test('should pass operation name to withDynamoTimeout', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.listRegisteredUserIds();

            expect(withDynamoTimeoutSpy).toHaveBeenCalledWith(
                expect.any(Function),
                expect.objectContaining({ operation: 'CalendarRegistry.listRegisteredUserIds' })
            );
        });

        test('should use FilterExpression to find CALCAL# items with CALENDARS SK', async () => {
            ddbMock.on(ScanCommand).resolves({ Items: [] });

            await backend.listRegisteredUserIds();

            const scanCalls = ddbMock.commandCalls(ScanCommand);
            const input = scanCalls[0].args[0].input;
            expect(input).toMatchObject({
                FilterExpression:          'begins_with(PK, :prefix) AND SK = :sk',
                ExpressionAttributeValues: {
                    ':prefix': 'CALCAL#',
                    ':sk':     'CALENDARS',
                },
                ProjectionExpression: 'PK',
            });
        });

        test('skips a row with no PK and logs a warning', async () => {
            const warnSpy = spyOn(logger, 'warn');
            ddbMock.on(ScanCommand).resolves({
                Items: [
                    { PK: 'CALCAL#user-alice' },
                    {}, // no PK
                ],
            });

            const result = await backend.listRegisteredUserIds();

            expect(result).toEqual(['user-alice']);
            expect(warnSpy).toHaveBeenCalledWith(
                expect.objectContaining({ issues: expect.anything() }),
                'CalendarRegistryBackend.listRegisteredUserIds: skipping row with invalid PK'
            );

            warnSpy.mockRestore();
        });
    });

    describe('timeout configuration', () => {
        test('should use default timeout when not specified', () => {
            const defaultBackend = new CalendarRegistryBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                TABLE_NAME
            );

            expect(defaultBackend).toBeDefined();
        });

        test('should accept custom timeout', () => {
            const customBackend = new CalendarRegistryBackend(
                ddbMock as unknown as DynamoDBDocumentClient,
                TABLE_NAME,
                5000
            );

            expect(customBackend).toBeDefined();
        });

        test('default timeout fires at exactly 10 seconds, not before and not after', async () => {
            // Use the real withDynamoTimeout (the outer beforeEach replaces it with a
            // passthrough that ignores timeoutMs entirely) so the 10_000 default constructor
            // argument actually drives a race against a hanging DynamoDB call.
            withDynamoTimeoutSpy.mockRestore();
            jest.useFakeTimers();
            try {
                const defaultBackend = new CalendarRegistryBackend(
                    ddbMock as unknown as DynamoDBDocumentClient,
                    TABLE_NAME
                );
                ddbMock.on(GetCommand).callsFake(async () => new Promise(() => {
                    // Never resolves — only the timeout can settle the race.
                }));

                let rejection: unknown;
                let settled = false;
                const pending = defaultBackend.getUserRecord('user-123').catch((err: unknown) => {
                    rejection = err;
                }).finally(() => {
                    settled = true;
                });

                for(let i = 0; i < 10; i++) {
                    // eslint-disable-next-line no-await-in-loop -- flush microtasks before checking timer state
                    await Promise.resolve();
                }
                expect(settled).toBe(false);

                jest.advanceTimersByTime(9999);
                for(let i = 0; i < 10; i++) {
                    // eslint-disable-next-line no-await-in-loop -- flush microtasks after partial timer advance
                    await Promise.resolve();
                }
                expect(settled).toBe(false);

                jest.advanceTimersByTime(1);
                await pending;
                expect(settled).toBe(true);
                expect(rejection).toBeInstanceOf(DynamoTimeoutError);
            } finally {
                jest.useRealTimers();
            }
        });
    });
});
