import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createCaldavMCPServer, type UserResolveResult } from '../../../src/agent/caldav-mcp-server';
import type { CalDAVClient, CalendarRegistryBackend, CalendarEvent, CalendarEventsResult } from '../../../src/integrations/caldav';
import type { CalendarServerEntry } from '../../../src/integrations/caldav/calendar-registry/types';
import { textContent } from '../../setup';

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<CallToolResult>
    description: string
    inputSchema: { shape: Record<string, unknown> }
    annotations: Record<string, boolean>
}
interface RegisteredToolInstance { _registeredTools: Record<string, RegisteredTool>, server: { _serverInfo: { version: string } } }

// Helpers to build test data

const mockServerEntry = (overrides: Partial<CalendarServerEntry> = {}): CalendarServerEntry => ({
    serverId:    '00000000-0000-0000-0000-000000000001' as CalendarServerEntry['serverId'],
    description: 'Personal iCloud',
    serverUrl:   'https://caldav.icloud.com',
    username:    'test@icloud.com',
    password:    'super-secret',
    calendars:   [{ calendarPath: '/home/calendars/home/', label: 'Home' }],
    ...overrides,
});

const mockEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
    uid:           'event-uid-1',
    summary:       'Team standup',
    start:         new Date('2026-03-18T09:00:00.000Z'),
    end:           new Date('2026-03-18T09:30:00.000Z'),
    isAllDay:      false,
    calendarLabel: 'Home',
    ...overrides,
});

describe.concurrent('createCaldavMCPServer', () => {
    let mockClient:   CalDAVClient;
    let mockRegistry: CalendarRegistryBackend;

    beforeEach(() => {
        mockClient = {
            getEvents:         mock(async (): Promise<CalendarEventsResult> => ({ events: [mockEvent()], failed: [] })),
            getContextEvents:  mock(async (): Promise<CalendarEventsResult> => ({ events: [mockEvent()], failed: [] })),
            discoverCalendars: mock(async () => []),
            invalidateCache:   mock(() => undefined),
        } as unknown as CalDAVClient;

        mockRegistry = {
            getAllCalendars:      mock(async (): Promise<CalendarServerEntry[]> => [mockServerEntry()]),
            getUserRecord:        mock(async () => null),
            getSharedRecord:      mock(async () => null),
            addServer:            mock(async () => undefined),
            removeServer:         mock(async () => false),
            removeCalendar:       mock(async () => false),
            addSharedServer:      mock(async () => undefined),
            removeSharedServer:   mock(async () => false),
            removeSharedCalendar: mock(async () => false),
        } as unknown as CalendarRegistryBackend;
    });

    // Helper to get tool handler from server instance
    const getToolHandler = (server: ReturnType<typeof createCaldavMCPServer>, toolName: string): ((...args: unknown[]) => Promise<CallToolResult>) => {
        return (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName].handler;
    };

    describe('createCaldavMCPServer function', () => {
        test('should create MCP server with correct properties', () => {
            const server = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });

            expect(server).toBeDefined();
            expect(server.name).toBe('caldav');
            expect(server.instance).toBeDefined();
            expect(server.type).toBe('sdk');
            expect((server.instance as unknown as RegisteredToolInstance).server._serverInfo.version).toBe('1.0.0');
        });

        test.each([
            ['getCalendarEvents', 'Get calendar events for a user in a specific date range. Returns events from all calendars associated with the user plus shared/public calendars.'],
            ['getUpcomingEvents', 'Get upcoming calendar events for a user over the next N days. Convenience wrapper that defaults to 7 days.'],
            ['listUserCalendars', 'List all calendar labels configured for a user. Shows calendar names grouped by server, without exposing URLs or credentials.'],
        ])('should have %s tool with correct description', (toolName, expectedDescription) => {
            const server = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.description).toBe(expectedDescription);
        });

        test.each([
            ['getCalendarEvents', ['user', 'startDate', 'endDate']],
            ['getUpcomingEvents', ['user', 'days']],
            ['listUserCalendars', ['user']],
        ])('should have %s tool with correct input schema fields', (toolName, expectedFields) => {
            const server = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            for(const field of expectedFields) {
                expect(registeredTool.inputSchema.shape[field]).toBeDefined();
            }
        });

        test.each([
            ['getCalendarEvents'],
            ['getUpcomingEvents'],
            ['listUserCalendars'],
        ])('should have %s tool with readOnlyHint and idempotentHint annotations', (toolName) => {
            const server = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const registeredTool = (server.instance as unknown as RegisteredToolInstance)._registeredTools[toolName];

            expect(registeredTool.annotations.readOnlyHint).toBe(true);
            expect(registeredTool.annotations.idempotentHint).toBe(true);
        });
    });

    describe('getCalendarEvents tool', () => {
        test('should return events for a user with calendars', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            const result = await handler({ user: 'user-123', startDate: '2026-03-18', endDate: '2026-03-25' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: unknown[], count: number, failedCount?: number };
            expect(parsed.events).toHaveLength(1);
            expect(parsed.count).toBe(1);
            expect(parsed.failedCount).toBeUndefined();
        });

        test('should pass servers and parsed dates to client.getEvents', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            await handler({ user: 'user-123', startDate: '2026-03-18', endDate: '2026-03-25' });

            expect(mockRegistry.getAllCalendars).toHaveBeenCalledWith('user-123');
            expect(mockClient.getEvents).toHaveBeenCalledWith(
                [mockServerEntry()],
                new Date('2026-03-18'),
                new Date('2026-03-25')
            );
        });

        test('should include failedCount and failedEvents when expansion failures occur', async () => {
            (mockClient.getEvents as ReturnType<typeof mock>).mockImplementation(async (): Promise<CalendarEventsResult> => ({
                events: [mockEvent()],
                failed: [{ uid: 'bad-event', reason: 'Malformed RRULE' }],
            }));
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            const result = await handler({ user: 'user-123', startDate: '2026-03-18', endDate: '2026-03-25' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: unknown[], count: number, failedCount: number, failedEvents: string[] };
            expect(parsed.events).toHaveLength(1);
            expect(parsed.count).toBe(1);
            expect(parsed.failedCount).toBe(1);
            expect(parsed.failedEvents).toEqual(['bad-event']);
        });

        test('should serialize event dates to ISO strings', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            const result = await handler({ user: 'user-123', startDate: '2026-03-18', endDate: '2026-03-25' });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: { start: string, end: string }[] };
            expect(parsed.events[0].start).toBe('2026-03-18T09:00:00.000Z');
            expect(parsed.events[0].end).toBe('2026-03-18T09:30:00.000Z');
        });

        test('should return empty events with message when no calendars configured', async () => {
            (mockRegistry.getAllCalendars as ReturnType<typeof mock>).mockImplementation(async () => []);
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            const result = await handler({ user: 'user-with-no-calendars', startDate: '2026-03-18', endDate: '2026-03-25' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: unknown[], message: string };
            expect(parsed.events).toHaveLength(0);
            expect(parsed.message).toBe('No calendars configured for this user');
            expect(mockClient.getEvents).not.toHaveBeenCalled();
        });

        test('should handle errors gracefully', async () => {
            (mockClient.getEvents as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('CalDAV connection failed');
            });
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getCalendarEvents');

            const result = await handler({ user: 'user-123', startDate: '2026-03-18', endDate: '2026-03-25' });

            expect(result.isError).toBe(true);
            const text = textContent(result.content[0]);
            expect(text).toContain('CalDAV connection failed');
        });
    });

    describe('getUpcomingEvents tool', () => {
        test('should return upcoming events with default 7 days', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-123' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: unknown[], count: number, daysAhead: number, failedCount?: number };
            expect(parsed.events).toHaveLength(1);
            expect(parsed.count).toBe(1);
            expect(parsed.daysAhead).toBe(7);
            expect(parsed.failedCount).toBeUndefined();
        });

        test('should include failedCount and failedEvents in getUpcomingEvents when expansion failures occur', async () => {
            (mockClient.getEvents as ReturnType<typeof mock>).mockImplementation(async (): Promise<CalendarEventsResult> => ({
                events: [],
                failed: [{ uid: 'bad-weekly', reason: 'Unsupported BYDAY' }, { uid: 'bad-monthly', reason: 'Invalid COUNT' }],
            }));
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-123' });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { failedCount: number, failedEvents: string[] };
            expect(parsed.failedCount).toBe(2);
            expect(parsed.failedEvents).toEqual(['bad-weekly', 'bad-monthly']);
        });

        test('should accept custom days parameter', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-123', days: 14 });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { daysAhead: number };
            expect(parsed.daysAhead).toBe(14);
        });

        test('should pass the correct date range to client based on days', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            await handler({ user: 'user-123', days: 7 });

            expect(mockClient.getEvents).toHaveBeenCalledTimes(1);
            const [, callStart, callEnd] = (mockClient.getEvents as ReturnType<typeof mock>).mock.calls[0] as [unknown, Date, Date];
            const expectedEnd = new Date(callStart.getTime() + 7 * 24 * 60 * 60 * 1000);
            expect(callEnd.getTime()).toBe(expectedEnd.getTime());
        });

        test('should return empty events when no calendars configured', async () => {
            (mockRegistry.getAllCalendars as ReturnType<typeof mock>).mockImplementation(async () => []);
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-with-no-calendars' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: unknown[], message: string };
            expect(parsed.events).toHaveLength(0);
            expect(parsed.message).toBe('No calendars configured for this user');
            expect(mockClient.getEvents).not.toHaveBeenCalled();
        });

        test('should handle errors gracefully', async () => {
            (mockRegistry.getAllCalendars as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('Registry unavailable');
            });
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-123' });

            expect(result.isError).toBe(true);
            const text = textContent(result.content[0]);
            expect(text).toContain('Registry unavailable');
        });

        test('should serialize event dates to ISO strings', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'user-123' });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { events: { start: string, end: string }[] };
            expect(parsed.events[0].start).toBe('2026-03-18T09:00:00.000Z');
            expect(parsed.events[0].end).toBe('2026-03-18T09:30:00.000Z');
        });
    });

    describe('listUserCalendars tool', () => {
        test('should return calendar labels grouped by server description', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'listUserCalendars');

            const result = await handler({ user: 'user-123' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { calendars: { serverDescription: string, calendars: { label: string, path: string }[] }[] };
            expect(parsed.calendars).toHaveLength(1);
            expect(parsed.calendars[0].serverDescription).toBe('Personal iCloud');
            expect(parsed.calendars[0].calendars).toHaveLength(1);
            expect(parsed.calendars[0].calendars[0].label).toBe('Home');
        });

        test('should strip credentials from output', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'listUserCalendars');

            const result = await handler({ user: 'user-123' });

            const text   = textContent(result.content[0]);
            // Credentials and server URL must not appear in output
            expect(text).not.toContain('super-secret');
            expect(text).not.toContain('https://caldav.icloud.com');
            // The output should not contain serverUrl, username, or password keys
            const parsed = JSON.parse(text) as { calendars: Record<string, unknown>[] };
            expect(parsed.calendars[0].serverUrl).toBeUndefined();
            expect(parsed.calendars[0].username).toBeUndefined();
            expect(parsed.calendars[0].password).toBeUndefined();
        });

        test('should include calendar path in output', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'listUserCalendars');

            const result = await handler({ user: 'user-123' });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { calendars: { calendars: { path: string }[] }[] };
            expect(parsed.calendars[0].calendars[0].path).toBe('/home/calendars/home/');
        });

        test('should return empty when no calendars configured', async () => {
            (mockRegistry.getAllCalendars as ReturnType<typeof mock>).mockImplementation(async () => []);
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'listUserCalendars');

            const result = await handler({ user: 'user-with-no-calendars' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { calendars: unknown[], message: string };
            expect(parsed.calendars).toHaveLength(0);
            expect(parsed.message).toBe('No calendars configured for this user');
        });

        test('should handle errors gracefully', async () => {
            (mockRegistry.getAllCalendars as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('DynamoDB timeout');
            });
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'listUserCalendars');

            const result = await handler({ user: 'user-123' });

            expect(result.isError).toBe(true);
            const text = textContent(result.content[0]);
            expect(text).toContain('DynamoDB timeout');
        });
    });

    describe('user resolution', () => {
        test('should resolve user name to userId and fetch calendars', async () => {
            const resolveUser = mock(async (): Promise<UserResolveResult> => ({
                status: 'resolved',
                user:   { userId: 'discord-123', username: 'craig', displayName: 'Craig', nickname: null },
            }));
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry, resolveUser });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            await handler({ user: 'Craig' });

            expect(resolveUser).toHaveBeenCalledWith('Craig');
            expect(mockRegistry.getAllCalendars).toHaveBeenCalledWith('discord-123');
        });

        test('should return ambiguous matches when multiple users found', async () => {
            const resolveUser = mock(async (): Promise<UserResolveResult> => ({
                status:  'ambiguous',
                matches: [
                    { username: 'craig1', displayName: 'Craig H', nickname: null },
                    { username: 'craig2', displayName: 'Craig S', nickname: null },
                ],
            }));
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry, resolveUser });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'Craig' });

            expect(result.isError).toBeUndefined();
            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { error: string, matches: unknown[] };
            expect(parsed.error).toBe('ambiguous_user');
            expect(parsed.matches).toHaveLength(2);
            expect(mockRegistry.getAllCalendars).not.toHaveBeenCalled();
        });

        test('should return not_found when no user matches', async () => {
            const resolveUser = mock(async (): Promise<UserResolveResult> => ({
                status: 'not_found',
            }));
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry, resolveUser });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            const result = await handler({ user: 'Unknown' });

            const text   = textContent(result.content[0]);
            const parsed = JSON.parse(text) as { error: string };
            expect(parsed.error).toBe('user_not_found');
            expect(mockRegistry.getAllCalendars).not.toHaveBeenCalled();
        });

        test('should fall back to raw input when resolveUser not provided', async () => {
            const server  = createCaldavMCPServer({ client: mockClient, registry: mockRegistry });
            const handler = getToolHandler(server, 'getUpcomingEvents');

            await handler({ user: 'raw-id-123' });

            expect(mockRegistry.getAllCalendars).toHaveBeenCalledWith('raw-id-123');
        });
    });
});
