import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { CalendarServerEntry } from '@/integrations/caldav/calendar-registry/types';
import { CaldavAuthError } from '@/integrations/caldav/errors';
import type { CalendarEvent } from '@/integrations/caldav/types';

// ---------------------------------------------------------------------------
// Mock tsdav
// ---------------------------------------------------------------------------

const mockFetchCalendars        = mock(async (): Promise<Record<string, unknown>[]> => ([]));
const mockFetchCalendarObjects  = mock(async (): Promise<Record<string, unknown>[]> => ([]));

const mockDAVClient = {
    fetchCalendars:       mockFetchCalendars,
    fetchCalendarObjects: mockFetchCalendarObjects,
};

const mockCreateDAVClient = mock(async (): Promise<typeof mockDAVClient> => mockDAVClient);

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('tsdav', () => ({
    createDAVClient: mockCreateDAVClient,
}));

// ---------------------------------------------------------------------------
// Mock node-ical
// ---------------------------------------------------------------------------

const mockParseICS = mock((_body: string): Record<string, unknown> => ({}));

// eslint-disable-next-line @typescript-eslint/no-floating-promises -- Module mock setup
mock.module('node-ical', () => ({
    sync: {
        parseICS: mockParseICS,
    },
}));

// ---------------------------------------------------------------------------
// Import after mocks are set up
// ---------------------------------------------------------------------------

const { CalDAVClient } = await import('@/integrations/caldav/client');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date('2025-06-15T12:00:00.000Z');

function makeServer(overrides: Partial<CalendarServerEntry> = {}): CalendarServerEntry {
    return {
        serverId:    '00000000-0000-0000-0000-000000000001' as CalendarServerEntry['serverId'],
        description: 'Test Server',
        serverUrl:   'https://caldav.example.com',
        username:    'testuser',
        password:    'testpass',
        calendars:   [{ calendarPath: '/calendars/testuser/default/', label: 'Personal' }],
        ...overrides,
    };
}

function makeDAVCalendar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        url:         '/calendars/testuser/default/',
        displayName: 'Personal Calendar',
        ...overrides,
    };
}

function makeCalendarObject(data: string): Record<string, unknown> {
    return { url: '/calendars/testuser/default/event1.ics', data };
}

function makeVEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type:     'VEVENT',
        uid:      'event-uid-1',
        summary:  'Test Meeting',
        start:    new Date('2025-06-15T14:00:00.000Z'),
        end:      new Date('2025-06-15T15:00:00.000Z'),
        datetype: 'date-time',
        dtstamp:  new Date('2025-06-15T12:00:00.000Z'),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// discoverCalendars
// ---------------------------------------------------------------------------

describe('CalDAVClient.discoverCalendars', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('returns CalendarInfo[] from server', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
            makeDAVCalendar({
                url:                 '/calendars/testuser/work/',
                displayName:         'Work',
                calendarColor:       '#ff0000',
                calendarDescription: 'Work calendar',
            }),
        ]);

        const client = new CalDAVClient();
        const result = await client.discoverCalendars('https://caldav.example.com', 'user', 'pass');

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
            path:        '/calendars/testuser/default/',
            displayName: 'Personal Calendar',
            color:       undefined,
            description: undefined,
        });
        expect(result[1]).toEqual({
            path:        '/calendars/testuser/work/',
            displayName: 'Work',
            color:       '#ff0000',
            description: 'Work calendar',
        });
    });

    test('uses url as displayName when displayName is missing', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            { url: '/calendars/testuser/default/' },
        ]);

        const client = new CalDAVClient();
        const result = await client.discoverCalendars('https://caldav.example.com', 'user', 'pass');

        expect(result[0]?.displayName).toBe('/calendars/testuser/default/');
    });

    test('calls createDAVClient with correct params', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = new CalDAVClient();
        await client.discoverCalendars('https://caldav.example.com', 'myuser', 'mypass');

        expect(mockCreateDAVClient).toHaveBeenCalledWith({
            serverUrl:          'https://caldav.example.com',
            credentials:        { username: 'myuser', password: 'mypass' },
            authMethod:         'Basic',
            defaultAccountType: 'caldav',
        });
    });

    test('throws CaldavAuthError when createDAVClient fails', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = new CalDAVClient();
        expect(
            client.discoverCalendars('https://bad.example.com', 'user', 'pass')
        ).rejects.toBeInstanceOf(CaldavAuthError);
    });

    test('includes serverUrl in CaldavAuthError context', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = new CalDAVClient();
        let thrown: unknown;
        try {
            await client.discoverCalendars('https://bad.example.com', 'user', 'pass');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(CaldavAuthError);
        const err = thrown as CaldavAuthError;
        expect(err.context).toMatchObject({ serverUrl: 'https://bad.example.com' });
    });
});

// ---------------------------------------------------------------------------
// getEvents
// ---------------------------------------------------------------------------

describe('CalDAVClient.getEvents', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('returns empty array for empty servers list', async () => {
        const client = new CalDAVClient();
        const result = await client.getEvents([], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(result).toEqual([]);
    });

    test('fetches events from server and parses ICS data', async () => {
        const icsData = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR';
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject(icsData),
        ]);
        mockParseICS.mockImplementation((_body: string): Record<string, unknown> => ({
            'event-uid-1': makeVEvent(),
        }));

        const client = new CalDAVClient();
        const server = makeServer();
        const result = await client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            uid:           'event-uid-1',
            summary:       'Test Meeting',
            calendarLabel: 'Personal',
            isAllDay:      false,
        });
        expect(result[0]?.start).toBeInstanceOf(Date);
        expect(result[0]?.end).toBeInstanceOf(Date);
    });

    test('sorts events by start time', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('ics1'),
            makeCalendarObject('ics2'),
        ]);
        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({
                'event-2': makeVEvent({ uid: 'event-2', start: new Date('2025-06-15T16:00:00.000Z'), end: new Date('2025-06-15T17:00:00.000Z') }),
            }))
            .mockImplementationOnce((): Record<string, unknown> => ({
                'event-1': makeVEvent({ uid: 'event-1', start: new Date('2025-06-15T14:00:00.000Z'), end: new Date('2025-06-15T15:00:00.000Z') }),
            }));

        const client = new CalDAVClient();
        const result = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result).toHaveLength(2);
        expect(result[0]?.uid).toBe('event-1');
        expect(result[1]?.uid).toBe('event-2');
    });

    test('skips calendar objects with no data', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            { url: '/calendars/testuser/default/event1.ics' }, // no data
        ]);

        const client = new CalDAVClient();
        const result = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result).toHaveLength(0);
        expect(mockParseICS).not.toHaveBeenCalled();
    });

    test('skips non-VEVENT components', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('ics1'),
        ]);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({
            'timezone-1': { type: 'VTIMEZONE', tzid: 'America/New_York' },
            'event-1':    makeVEvent(),
            vcal:         { type: 'VCALENDAR', version: '2.0' },
        }));

        const client = new CalDAVClient();
        const result = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        // Only the VEVENT should be extracted — VTIMEZONE and VCALENDAR must be skipped
        expect(result).toHaveLength(1);
        expect(result[0]!.uid).toBe('event-uid-1');
    });

    test('skips calendar paths not found in fetched calendars', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar({ url: '/calendars/testuser/OTHER/' }),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = new CalDAVClient();
        const result = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
        expect(result).toHaveLength(0);
    });

    test('calls fetchCalendarObjects with correct timeRange', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = new CalDAVClient();
        const start = new Date('2025-06-10T00:00:00.000Z');
        const end   = new Date('2025-06-20T00:00:00.000Z');
        await client.getEvents([makeServer()], start, end);

        expect(mockFetchCalendarObjects).toHaveBeenCalledWith({
            calendar:  makeDAVCalendar(),
            timeRange: { start: start.toISOString(), end: end.toISOString() },
        });
    });

    test('returns empty results on network error (partial failure)', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<never> => {
            throw new Error('Network error');
        });

        const client = new CalDAVClient();
        const events = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(events).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ serverUrl: expect.any(String) }),
            expect.stringContaining('Failed to fetch')
        );
    });

    test('returns empty results on auth error (partial failure)', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('401 Unauthorized');
        });

        const client = new CalDAVClient();
        const events = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(events).toEqual([]);
    });

    test('handles multiple servers', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar({ url: '/calendars/testuser/default/' }),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('ics1'),
        ]);
        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({
                'event-a': makeVEvent({ uid: 'event-a' }),
            }))
            .mockImplementationOnce((): Record<string, unknown> => ({
                'event-b': makeVEvent({ uid: 'event-b', start: new Date('2025-06-16T10:00:00.000Z'), end: new Date('2025-06-16T11:00:00.000Z') }),
            }));

        const server1 = makeServer({ serverUrl: 'https://server1.example.com' });
        const server2 = makeServer({
            serverId:  '00000000-0000-0000-0000-000000000002' as CalendarServerEntry['serverId'],
            serverUrl: 'https://server2.example.com',
        });

        const client = new CalDAVClient();
        const result = await client.getEvents([server1, server2], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result).toHaveLength(2);
        expect(mockCreateDAVClient).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('CalDAVClient cache', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('second call within TTL hits cache and does not re-fetch', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('ics1'),
        ]);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({
            'event-1': makeVEvent(),
        }));

        const start = new Date('2025-06-15T00:00:00.000Z');
        const end   = new Date('2025-06-18T00:00:00.000Z');
        const client = new CalDAVClient(300_000);
        const server = makeServer();

        await client.getEvents([server], start, end);
        const result2 = await client.getEvents([server], start, end);

        // fetchCalendars should only be called once (second call uses cache)
        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
        expect(result2).toHaveLength(1);
    });

    test('expired cache re-fetches', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const start = new Date('2025-06-15T00:00:00.000Z');
        const end   = new Date('2025-06-18T00:00:00.000Z');
        const client = new CalDAVClient(0); // 0ms TTL — immediately expired

        await client.getEvents([makeServer()], start, end);
        await client.getEvents([makeServer()], start, end);

        // Should have fetched twice since TTL is 0
        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('invalidateCache clears cache and forces re-fetch', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const start = new Date('2025-06-15T00:00:00.000Z');
        const end   = new Date('2025-06-18T00:00:00.000Z');
        const client = new CalDAVClient(300_000);

        await client.getEvents([makeServer()], start, end);
        client.invalidateCache();
        await client.getEvents([makeServer()], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('different time ranges use different cache keys', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const client = new CalDAVClient(300_000);
        const server = makeServer();

        // Different date ranges (different hours) — each should fetch independently
        await client.getEvents([server], new Date('2025-06-15T00:00:00.000Z'), new Date('2025-06-18T00:00:00.000Z'));
        await client.getEvents([server], new Date('2025-06-20T00:00:00.000Z'), new Date('2025-06-23T00:00:00.000Z'));

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });
});

// ---------------------------------------------------------------------------
// getContextEvents
// ---------------------------------------------------------------------------

describe('CalDAVClient.getContextEvents', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('fetches events from 24h ago to 3 days in the future', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const now    = new Date('2025-06-15T12:00:00.000Z');
        const client = new CalDAVClient();
        await client.getContextEvents([makeServer()], now);

        const expectedStart = new Date('2025-06-14T12:00:00.000Z');
        const expectedEnd   = new Date('2025-06-18T12:00:00.000Z');

        expect(mockFetchCalendarObjects).toHaveBeenCalledWith({
            calendar:  makeDAVCalendar(),
            timeRange: {
                start: expectedStart.toISOString(),
                end:   expectedEnd.toISOString(),
            },
        });
    });

    test('uses current time when now is not provided', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const before = Date.now();
        const client = new CalDAVClient();
        await client.getContextEvents([makeServer()]);
        const after = Date.now();

        const calls = mockFetchCalendarObjects.mock.calls as unknown as [{ timeRange: { start: string, end: string } }][];
        const callArgs = calls[0]?.[0];
        const startTime = new Date(callArgs.timeRange.start).getTime();
        const endTime   = new Date(callArgs.timeRange.end).getTime();

        // start should be ~24h before now
        expect(startTime).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000 - 100);
        expect(startTime).toBeLessThanOrEqual(after - 24 * 60 * 60 * 1000 + 100);

        // end should be ~3 days after now
        expect(endTime).toBeGreaterThanOrEqual(before + 3 * 24 * 60 * 60 * 1000 - 100);
        expect(endTime).toBeLessThanOrEqual(after + 3 * 24 * 60 * 60 * 1000 + 100);
    });
});

// ---------------------------------------------------------------------------
// #extractEvents — VEVENT field extraction
// ---------------------------------------------------------------------------

describe('CalDAVClient event extraction', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    async function extractEvents(vevents: Record<string, unknown>[]): Promise<CalendarEvent[]> {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('ics'),
        ]);
        const parsed: Record<string, unknown> = {};
        for(const vevent of vevents) {
            parsed[vevent.uid as string] = vevent;
        }
        mockParseICS.mockImplementation((): Record<string, unknown> => parsed);

        const client = new CalDAVClient();
        return client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
    }

    test('extracts basic VEVENT fields', async () => {
        const events = await extractEvents([makeVEvent()]);

        expect(events[0]).toMatchObject({
            uid:      'event-uid-1',
            summary:  'Test Meeting',
            isAllDay: false,
        });
    });

    test('uses (No title) when summary is missing', async () => {
        const events = await extractEvents([makeVEvent({ summary: undefined })]);
        expect(events[0]?.summary).toBe('(No title)');
    });

    test('extracts summary from ParameterValue object', async () => {
        const events = await extractEvents([
            makeVEvent({ summary: { val: 'Parameterized Title', params: { LANGUAGE: 'de' } } }),
        ]);
        expect(events[0]?.summary).toBe('Parameterized Title');
    });

    test('extracts location field', async () => {
        const events = await extractEvents([makeVEvent({ location: 'Conference Room A' })]);
        expect(events[0]?.location).toBe('Conference Room A');
    });

    test('extracts location from ParameterValue object', async () => {
        const events = await extractEvents([
            makeVEvent({ location: { val: 'Room B', params: { ALTREP: 'cid:room-b' } } }),
        ]);
        expect(events[0]?.location).toBe('Room B');
    });

    test('location is undefined when not present', async () => {
        const events = await extractEvents([makeVEvent()]);
        expect(events[0]?.location).toBeUndefined();
    });

    test('extracts description field', async () => {
        const events = await extractEvents([makeVEvent({ description: 'Meeting agenda' })]);
        expect(events[0]?.description).toBe('Meeting agenda');
    });

    test('description is undefined when empty string', async () => {
        const events = await extractEvents([makeVEvent({ description: '' })]);
        expect(events[0]?.description).toBeUndefined();
    });

    test('extracts recurrenceId', async () => {
        const recDate = new Date('2025-06-16T14:00:00.000Z');
        const events = await extractEvents([makeVEvent({ recurrenceid: recDate })]);
        expect(events[0]?.recurrenceId).toBe(String(recDate));
    });

    test('recurrenceId is undefined when not present', async () => {
        const events = await extractEvents([makeVEvent()]);
        expect(events[0]?.recurrenceId).toBeUndefined();
    });

    // --- isAllDay ---

    test('isAllDay is false for DATE-TIME events', async () => {
        const events = await extractEvents([makeVEvent({ datetype: 'date-time' })]);
        expect(events[0]?.isAllDay).toBe(false);
    });

    test('isAllDay is true when datetype is date', async () => {
        const events = await extractEvents([makeVEvent({ datetype: 'date' })]);
        expect(events[0]?.isAllDay).toBe(true);
    });

    test('isAllDay is true when start.dateOnly is true', async () => {
        const allDayStart = Object.assign(new Date('2025-06-15'), { dateOnly: true as const });
        const events = await extractEvents([makeVEvent({ start: allDayStart, datetype: 'date-time' })]);
        expect(events[0]?.isAllDay).toBe(true);
    });

    // --- status normalization ---

    test('normalizes CONFIRMED status', async () => {
        const events = await extractEvents([makeVEvent({ status: 'CONFIRMED' })]);
        expect(events[0]?.status).toBe('confirmed');
    });

    test('normalizes TENTATIVE status', async () => {
        const events = await extractEvents([makeVEvent({ status: 'TENTATIVE' })]);
        expect(events[0]?.status).toBe('tentative');
    });

    test('normalizes CANCELLED status', async () => {
        const events = await extractEvents([makeVEvent({ status: 'CANCELLED' })]);
        expect(events[0]?.status).toBe('cancelled');
    });

    test('status is undefined for unknown status string', async () => {
        const events = await extractEvents([makeVEvent({ status: 'UNKNOWN_STATUS' })]);
        expect(events[0]?.status).toBeUndefined();
    });

    test('status is undefined when not present', async () => {
        const events = await extractEvents([makeVEvent({ status: undefined })]);
        expect(events[0]?.status).toBeUndefined();
    });

    // --- attendees ---

    test('extracts attendees as string array from string attendees', async () => {
        const events = await extractEvents([
            makeVEvent({ attendee: ['mailto:alice@example.com', 'mailto:bob@example.com'] }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com', 'bob@example.com']);
    });

    test('extracts attendees from ParameterValue objects with CN', async () => {
        const events = await extractEvents([
            makeVEvent({
                attendee: [
                    { val: 'mailto:alice@example.com', params: { CN: 'Alice' } },
                    { val: 'mailto:bob@example.com', params: { CN: 'Bob' } },
                ],
            }),
        ]);
        expect(events[0]?.attendees).toEqual(['Alice', 'Bob']);
    });

    test('extracts attendees from ParameterValue objects without CN using val', async () => {
        const events = await extractEvents([
            makeVEvent({
                attendee: [
                    { val: 'mailto:alice@example.com', params: {} },
                ],
            }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com']);
    });

    test('handles single attendee (not array)', async () => {
        const events = await extractEvents([
            makeVEvent({ attendee: 'mailto:alice@example.com' }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com']);
    });

    test('attendees is undefined when no attendee field', async () => {
        const events = await extractEvents([makeVEvent({ attendee: undefined })]);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('attendees is undefined when all attendee values are empty after filtering', async () => {
        const events = await extractEvents([
            makeVEvent({ attendee: [{ val: '', params: {} }] }),
        ]);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('attendee object without params key falls back to empty string and is filtered out', async () => {
        // An object that has no 'params' key — should not crash and produce no names
        const events = await extractEvents([
            makeVEvent({ attendee: [{ val: 'mailto:alice@example.com' }] }),
        ]);
        // No CN, no params key — val extraction falls through to empty string
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('location with empty val string resolves to undefined', async () => {
        const events = await extractEvents([makeVEvent({ location: { val: '', params: {} } })]);
        expect(events[0]?.location).toBeUndefined();
    });

    // --- start/end conversion ---

    test('converts non-Date start/end to Date objects', async () => {
        const startStr = '2025-06-15T14:00:00.000Z';
        const endStr   = '2025-06-15T15:00:00.000Z';
        const events = await extractEvents([
            makeVEvent({ start: startStr, end: endStr }),
        ]);
        expect(events[0]?.start).toBeInstanceOf(Date);
        expect(events[0]?.end).toBeInstanceOf(Date);
    });
});

// ---------------------------------------------------------------------------
// #buildCacheKey — hour rounding
// ---------------------------------------------------------------------------

describe('CalDAVClient cache key rounding', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('same hour range maps to same cache key', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const client = new CalDAVClient(300_000);
        const server = makeServer();

        // Different minutes within the same hour — should be same cache entry
        await client.getEvents([server], new Date('2025-06-15T14:05:00.000Z'), new Date('2025-06-18T14:45:00.000Z'));
        await client.getEvents([server], new Date('2025-06-15T14:30:00.000Z'), new Date('2025-06-18T14:15:00.000Z'));

        // Only one real fetch should happen (second hits cache)
        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });

    test('different hours on same day use different cache keys', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const client = new CalDAVClient(300_000);
        const server = makeServer();

        // 10:30 and 14:30 on the same day — same minutes but different hours
        // setMinutes(0,0,0): 10:30→10:00 vs 14:30→14:00 (different → different keys)
        // setHours(0,0,0): 10:30→00:30 vs 14:30→00:30 (same → would incorrectly share cache)
        await client.getEvents([server], new Date('2025-06-15T10:30:00.000Z'), new Date('2025-06-18T10:30:00.000Z'));
        await client.getEvents([server], new Date('2025-06-15T14:30:00.000Z'), new Date('2025-06-18T14:30:00.000Z'));

        // Both should fetch independently — hour difference matters
        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });
});
