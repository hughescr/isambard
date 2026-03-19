import { describe, test, expect, beforeEach, afterEach, spyOn, type mock } from 'bun:test';
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { CalendarRegistryBackend } from '@/integrations/caldav/calendar-registry/backend';
import { createCalendarServerId, type CalendarRegistryRecord, type CalendarServerEntry } from '@/integrations/caldav/calendar-registry/types';
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
    userId,
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bypass generic type mismatch in test spy
            async (operation: () => Promise<any>) => operation()
        );

        backend = new CalendarRegistryBackend(
            ddbMock as unknown as DynamoDBDocumentClient,
            TABLE_NAME
        );
    });

    afterEach(() => {
        ddbMock.restore();
        withDynamoTimeoutSpy.mockRestore();
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
    });

    describe('addSharedServer', () => {
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
            expect(input.FilterExpression).toBeDefined();
            expect(input.ExpressionAttributeValues).toBeDefined();
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
    });
});
