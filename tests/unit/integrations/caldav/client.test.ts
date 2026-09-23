import { describe, test, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import { DateTime } from 'luxon';
import * as ical from 'node-ical';
import { mockLogger } from '../../../setup';
import { CaldavAuthError, CaldavTimeoutError } from '@/errors';
import { createCalendarServerId, type CalendarServerEntry } from '@/integrations/caldav/calendar-registry/types';
import { CalDAVClient, type CalDAVClientDependencies } from '@/integrations/caldav/client';
import { createCalendarTimeRange, createLocalDateTime, type CalendarEventsResult, type LocalDateTime } from '@/integrations/caldav/types';
import type { ServiceHealthRegistry } from '@/services';

// ---------------------------------------------------------------------------
// Per-client tsdav test double
// ---------------------------------------------------------------------------

const mockFetchCalendars        = mock(async (): Promise<Record<string, unknown>[]> => ([]));
const mockFetchCalendarObjects  = mock(async (_params?: { calendar: { url: string } }): Promise<Record<string, unknown>[]> => ([]));

const mockDAVClient = {
    fetchCalendars:       mockFetchCalendars,
    fetchCalendarObjects: mockFetchCalendarObjects,
};

const mockCreateDAVClient = mock(async (): Promise<typeof mockDAVClient> => mockDAVClient);

// ---------------------------------------------------------------------------
// Per-client node-ical test double
// ---------------------------------------------------------------------------

const mockParseICS = mock((_body: string): Record<string, unknown> => ({}));

interface MockEventInstance {
    start:       Date
    end:         Date
    summary:     string
    isFullDay:   boolean
    isRecurring: boolean
    isOverride:  boolean
    event:       Record<string, unknown>
}

const mockExpandRecurringEvent = mock((_event: Record<string, unknown>, _options: Record<string, unknown>): MockEventInstance[] => ([]));

const TEST_DEPENDENCY_DOUBLES = {
    createDAVClient:      mockCreateDAVClient,
    parseICS:             mockParseICS,
    expandRecurringEvent: mockExpandRecurringEvent,
} satisfies Record<keyof CalDAVClientDependencies, unknown>;
// The test doubles return fixture data instead of the libraries' full response types.
const TEST_DEPENDENCIES = TEST_DEPENDENCY_DOUBLES as unknown as CalDAVClientDependencies;

function createClient(optionsOrCacheTtlMs: ConstructorParameters<typeof CalDAVClient>[0] = {}, timeoutMs = 15_000): CalDAVClient {
    if(typeof optionsOrCacheTtlMs === 'number') {
        return new CalDAVClient(optionsOrCacheTtlMs, timeoutMs, TEST_DEPENDENCIES);
    }
    return new CalDAVClient({ ...optionsOrCacheTtlMs, dependencies: TEST_DEPENDENCIES }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date('2025-06-15T12:00:00.000Z');

/** Flush the microtask queue N times to let async chains progress without advancing fake timers. */
async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

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

/** A timed node-ical value: a Date carrying node-ical's runtime `tz` (here the `Etc/UTC` it attaches to a `Z` DATE-TIME). */
function utcDate(iso: string): Date {
    return Object.assign(new Date(iso), { tz: 'Etc/UTC' });
}

/** The host-local wall clock of an instant: how the client reads a floating node-ical Date, which node-ical built from host-local components. */
function hostWallClock(iso: string): LocalDateTime {
    return createLocalDateTime(DateTime.fromJSDate(new Date(iso), { zone: 'system' }).toFormat("yyyy-MM-dd'T'HH:mm:ss"));
}

function makeHealthRegistry(): {
    registry:  ServiceHealthRegistry
    sendEvent: ReturnType<typeof mock>
} {
    const sendEvent = mock(() => undefined);
    return {
        registry: { sendEvent } as unknown as ServiceHealthRegistry,
        sendEvent,
    };
}

// Module-level helper used by event extraction and recurring expansion tests
async function extractEvents(vevents: Record<string, unknown>[]): Promise<CalendarEventsResult> {
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

    const client = createClient();
    return client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
}

// ---------------------------------------------------------------------------
// discoverCalendars
// ---------------------------------------------------------------------------

function prepareDistinctCacheResults(eventStart: string): void {
    let fetchNumber = 0;
    mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
    mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
    mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => {
        fetchNumber++;
        return [makeCalendarObject(`event-${fetchNumber}`)];
    });
    mockParseICS.mockImplementation((body: string): Record<string, unknown> => ({
        [body]: makeVEvent({
            uid:   body,
            start: new Date(eventStart),
            end:   new Date(new Date(eventStart).getTime() + 60_000),
        }),
    }));
}

describe('CalDAVClient.discoverCalendars', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
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

        const client = createClient();
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

        const client = createClient();
        const result = await client.discoverCalendars('https://caldav.example.com', 'user', 'pass');

        expect(result[0]?.displayName).toBe('/calendars/testuser/default/');
    });

    test('calls createDAVClient with correct params', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient();
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

        const client = createClient();
        await expect(
            client.discoverCalendars('https://bad.example.com', 'user', 'pass')
        ).rejects.toBeInstanceOf(CaldavAuthError);
    });

    test('includes serverUrl in CaldavAuthError context', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = createClient();
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

    test('originalError context carries the actual failure, not a blank string', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = createClient();
        let thrown: unknown;
        try {
            await client.discoverCalendars('https://bad.example.com', 'user', 'pass');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(CaldavAuthError);
        const err = thrown as CaldavAuthError;
        expect(err.context?.originalError).toBe(String(new Error('Connection refused')));
    });

    test('does not leak the username into CaldavAuthError context', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = createClient();
        let thrown: unknown;
        try {
            await client.discoverCalendars('https://bad.example.com', 'secret-user', 'pass');
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(CaldavAuthError);
        const err = thrown as CaldavAuthError;
        expect(Object.keys(err.context ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual(['originalError', 'serverUrl']);
    });

    test('labels discover-calendar timeouts as fetchCalendars', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation((): Promise<never> => new Promise(() => {}));

        jest.useFakeTimers();
        const client = createClient(300_000, 50);
        const pending = client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        await drainMicrotasks();
        jest.advanceTimersByTime(50);
        await expect(pending)
            .rejects.toMatchObject({ context: { operation: 'fetchCalendars' } });
    });

    test('includes the CalDAV server URL in authentication errors', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('Connection refused');
        });

        const client = createClient();
        await expect(client.discoverCalendars('https://bad.example.com', 'user', 'pass'))
            .rejects.toThrow('Failed to connect to CalDAV server: https://bad.example.com');
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
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('returns empty events and failed arrays for empty servers list', async () => {
        const client = createClient();
        const result = await client.getEvents([], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(result).toEqual({ events: [], failed: [] });
    });

    test('fetches independent calendars with at most two requests in flight', async () => {
        const firstGate = Promise.withResolvers<void>();
        const thirdStarted = Promise.withResolvers<void>();
        let active = 0;
        let maxActive = 0;
        const paths = ['/calendars/testuser/one/', '/calendars/testuser/two/', '/calendars/testuser/three/'];
        mockCreateDAVClient.mockImplementation(async () => mockDAVClient);
        mockFetchCalendars.mockImplementation(async () => paths.map(url => makeDAVCalendar({ url })));
        mockFetchCalendarObjects.mockImplementation(async (params) => {
            active++;
            maxActive = Math.max(maxActive, active);
            if(params?.calendar.url === paths[0]) {
                await firstGate.promise;
            }
            if(params?.calendar.url === paths[2]) {
                thirdStarted.resolve();
            }
            active--;
            return [];
        });
        const server = makeServer({ calendars: paths.map((calendarPath, index) => ({ calendarPath, label: `Calendar ${index}` })) });
        const client = createClient();
        const pending = client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        try {
            await Promise.race([
                thirdStarted.promise,
                Bun.sleep(1000).then(() => { throw new Error('third calendar did not start before the first completed'); }),
            ]);
            expect(maxActive).toBe(2);
        } finally {
            firstGate.resolve();
        }

        expect(await pending).toEqual({ events: [], failed: [] });
        expect(mockFetchCalendarObjects).toHaveBeenCalledTimes(3);
    });

    test('stops queued calendar fetches and returns after the first failure while another fetch is pending', async () => {
        const secondStarted = Promise.withResolvers<void>();
        const secondGate = Promise.withResolvers<Record<string, unknown>[]>();
        const paths = ['/calendars/testuser/one/', '/calendars/testuser/two/', '/calendars/testuser/three/'];
        mockCreateDAVClient.mockImplementation(async () => mockDAVClient);
        mockFetchCalendars.mockImplementation(async () => paths.map(url => makeDAVCalendar({ url })));
        mockFetchCalendarObjects.mockImplementation(async (params) => {
            if(params?.calendar.url === paths[0]) {
                await secondStarted.promise;
                throw new Error('first calendar failed');
            }
            if(params?.calendar.url === paths[1]) {
                secondStarted.resolve();
                return secondGate.promise;
            }
            throw new Error('queued calendar must not start');
        });
        const server = makeServer({ calendars: paths.map((calendarPath, index) => ({ calendarPath, label: `Calendar ${index}` })) });
        const client = createClient();
        const pending = client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        try {
            const result = await Promise.race([
                pending,
                Bun.sleep(250).then(() => { throw new Error('server result waited for another in-flight calendar'); }),
            ]);
            expect(result).toEqual({ events: [], failed: [] });
            expect(mockFetchCalendarObjects).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        } finally {
            secondGate.resolve([]);
        }
        await drainMicrotasks();
        expect(mockFetchCalendarObjects).toHaveBeenCalledTimes(2);
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

        const client = createClient();
        const server = makeServer();
        const { events, failed } = await client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events).toHaveLength(1);
        expect(failed).toHaveLength(0);
        expect(events[0]).toMatchObject({
            uid:           'event-uid-1',
            summary:       'Test Meeting',
            calendarLabel: 'Personal',
        });
        expect(events[0]?.time).toEqual({ kind: 'floating', start: hostWallClock('2025-06-15T14:00:00.000Z'), end: hostWallClock('2025-06-15T15:00:00.000Z') });
    });

    test('orders mixed all-day, floating and timed events by the zone-independent sort key', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({
            timed:    makeVEvent({ uid: 'timed', start: utcDate('2025-06-15T08:00:00.000Z'), end: utcDate('2025-06-15T09:00:00.000Z') }),
            floating: makeVEvent({ uid: 'floating', start: new Date(2025, 5, 15, 9), end: new Date(2025, 5, 15, 10) }),
            allDay:   makeVEvent({ uid: 'all-day', start: new Date(2025, 5, 15), end: new Date(2025, 5, 16), datetype: 'date' }),
            previous: makeVEvent({ uid: 'previous', start: utcDate('2025-06-14T23:00:00.000Z'), end: utcDate('2025-06-14T23:30:00.000Z') }),
        }));

        const { events } = await createClient().getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events.map(event => event.uid)).toEqual(['previous', 'all-day', 'floating', 'timed']);
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

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events).toHaveLength(2);
        expect(events[0]?.uid).toBe('event-1');
        expect(events[1]?.uid).toBe('event-2');
    });

    test('preserves server order when events have equal start times', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({ first: makeVEvent({ uid: 'first-server' }) }))
            .mockImplementationOnce((): Record<string, unknown> => ({ second: makeVEvent({ uid: 'second-server' }) }));
        const secondServer = makeServer({
            serverId:  '00000000-0000-0000-0000-000000000002' as CalendarServerEntry['serverId'],
            serverUrl: 'https://server2.example.com',
        });

        const result = await createClient({ cacheTtlMs: 0 }).getEvents(
            [makeServer(), secondServer], BASE_DATE, new Date('2025-06-18T12:00:00.000Z')
        );

        expect(result.events.map(event => event.uid)).toEqual(['first-server', 'second-server']);
    });

    test('preserves calendar-object order when events have equal start times', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('first'), makeCalendarObject('second'),
        ]);
        mockParseICS.mockImplementation((body): Record<string, unknown> => ({
            [body]: makeVEvent({ uid: body }),
        }));

        const result = await createClient().getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result.events.map(event => event.uid)).toEqual(['first', 'second']);
    });

    test('preserves every calendar result when concurrent fetches complete out of order', async () => {
        const firstFetch = Promise.withResolvers<Record<string, unknown>[]>();
        const paths = ['/calendars/testuser/first/', '/calendars/testuser/second/'];
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => paths.map(url => makeDAVCalendar({ url })));
        mockFetchCalendarObjects.mockImplementation(async (options) => {
            const calendar = options?.calendar;
            if(calendar === undefined) {
                throw new Error('Expected calendar fetch options');
            }
            if(calendar.url === paths[0]) {
                return firstFetch.promise;
            }
            firstFetch.resolve([makeCalendarObject('first')]);
            return [makeCalendarObject('second')];
        });
        mockParseICS.mockImplementation((body): Record<string, unknown> => ({
            [body]: makeVEvent({ uid: body }),
        }));
        const server = makeServer({ calendars: paths.map((calendarPath, index) => ({ calendarPath, label: `Calendar ${index}` })) });

        const result = await createClient().getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result.events.map(event => event.uid)).toHaveLength(2);
        expect(result.events.map(event => event.uid)).toEqual(expect.arrayContaining(['first', 'second']));
    });

    test('skips calendar objects with no data', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            { url: '/calendars/testuser/default/event1.ics' }, // no data
        ]);

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events).toHaveLength(0);
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

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        // Only the VEVENT should be extracted — VTIMEZONE and VCALENDAR must be skipped
        expect(events).toHaveLength(1);
        expect(events[0].uid).toBe('event-uid-1');
    });

    test('skips calendar paths not found in fetched calendars', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar({ url: '/calendars/testuser/OTHER/' }),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
        expect(events).toHaveLength(0);
    });

    test('calls fetchCalendarObjects with correct timeRange', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient();
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

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(events).toEqual([]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ serverUrl: expect.any(String) }),
            expect.stringContaining('Failed to fetch')
        );
    });

    test('labels event-fetch calendar discovery timeouts as fetchCalendars', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation((): Promise<never> => new Promise(() => {}));

        jest.useFakeTimers();
        const client = createClient(300_000, 50);
        const pending = client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        await drainMicrotasks();
        jest.advanceTimersByTime(50);
        await pending;
        const loggedError = (mockLogger.warn.mock.calls[0]?.[0] as { error: CaldavTimeoutError }).error;
        expect(loggedError.context).toMatchObject({ operation: 'fetchCalendars' });
    });

    test('returns empty results on auth error (partial failure)', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<never> => {
            throw new Error('401 Unauthorized');
        });

        const client = createClient();
        const { events } = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
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

        const client = createClient();
        const { events } = await client.getEvents([server1, server2], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events).toHaveLength(2);
        expect(mockCreateDAVClient).toHaveBeenCalledTimes(2);
    });

    // -----------------------------------------------------------------------
    // Health registry events
    // -----------------------------------------------------------------------

    test('no health events emitted when registry not configured', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<never> => {
            throw new Error('Network error');
        });

        // Should not crash when no health registry: getEvents swallows the
        // fetch failure, returns empty results, and emits no health events.
        const client = createClient();
        const result = await client.getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        expect(result).toEqual({ events: [], failed: [] });
    });

    test('no CONNECTION_LOST until 3 consecutive server failures', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<never> => {
            throw new Error('Network error');
        });

        const { registry, sendEvent } = makeHealthRegistry();
        const client = createClient({ healthRegistry: registry });
        const server = makeServer();
        const end    = new Date('2025-06-18T12:00:00.000Z');

        // Two failures — below threshold
        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);

        expect(sendEvent).not.toHaveBeenCalledWith('caldav', expect.objectContaining({ type: 'CONNECTION_LOST' }));
    });

    test('emits CONNECTION_LOST after 3 consecutive server failures', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<never> => {
            throw new Error('Network error');
        });

        const { registry, sendEvent } = makeHealthRegistry();
        // Use 0ms TTL so each call re-fetches (no cache hits that bypass failure tracking)
        const client = createClient({ healthRegistry: registry, cacheTtlMs: 0 });
        const server = makeServer();
        const end    = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([server], BASE_DATE, end); // failure 1
        await client.getEvents([server], BASE_DATE, end); // failure 2
        await client.getEvents([server], BASE_DATE, end); // failure 3 — threshold

        expect(sendEvent).toHaveBeenCalledWith('caldav', expect.objectContaining({
            type:  'CONNECTION_LOST',
            error: 'Network error',
        }));
    });

    test('emits CONNECT_SUCCESS after recovery from 3+ failures', async () => {
        let fetchCalendarsCallCount = 0;
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => {
            fetchCalendarsCallCount++;
            if(fetchCalendarsCallCount <= 3) {
                throw new Error('Network error');
            }
            return [makeDAVCalendar()];
        });
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const { registry, sendEvent } = makeHealthRegistry();
        const client = createClient({ healthRegistry: registry, cacheTtlMs: 0 });
        const server = makeServer();
        const end    = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([server], BASE_DATE, end); // failure 1
        await client.getEvents([server], BASE_DATE, end); // failure 2
        await client.getEvents([server], BASE_DATE, end); // failure 3 — CONNECTION_LOST emitted
        await client.getEvents([server], BASE_DATE, end); // success — CONNECT_SUCCESS emitted

        expect(sendEvent).toHaveBeenCalledWith('caldav', expect.objectContaining({ type: 'CONNECTION_LOST' }));
        expect(sendEvent).toHaveBeenCalledWith('caldav', { type: 'CONNECT_SUCCESS' });
    });

    test('a recovery resets the failure streak before counting later failures', async () => {
        let shouldFail = true;
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => {
            if(shouldFail) {
                throw new Error('Network error');
            }
            return [];
        });
        const { registry, sendEvent } = makeHealthRegistry();
        const client = createClient({ healthRegistry: registry, cacheTtlMs: 0 });
        const server = makeServer();
        const end = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);
        shouldFail = false;
        await client.getEvents([server], BASE_DATE, end);
        sendEvent.mockClear();
        shouldFail = true;
        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);
        expect(sendEvent).not.toHaveBeenCalledWith('caldav', expect.objectContaining({ type: 'CONNECTION_LOST' }));
        await client.getEvents([server], BASE_DATE, end);
        expect(sendEvent).toHaveBeenCalledWith('caldav', expect.objectContaining({ type: 'CONNECTION_LOST' }));
    });

    test('no CONNECT_SUCCESS on success when no prior failures', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const { registry, sendEvent } = makeHealthRegistry();
        const client = createClient({ healthRegistry: registry, cacheTtlMs: 0 });
        const server = makeServer();

        await client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        // No CONNECT_SUCCESS when already online (no failures tracked)
        expect(sendEvent).not.toHaveBeenCalledWith('caldav', { type: 'CONNECT_SUCCESS' });
    });

    test('CONNECTION_LOST stringifies a non-Error failure value', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<never> => {
            // Non-Error rejection: exercises the String(error) fallback in the health event payload
            throw 'socket hang up';
        });

        const { registry, sendEvent } = makeHealthRegistry();
        const client = createClient({ healthRegistry: registry, cacheTtlMs: 0 });
        const server = makeServer();
        const end    = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);
        await client.getEvents([server], BASE_DATE, end);

        expect(sendEvent).toHaveBeenCalledWith('caldav', { type: 'CONNECTION_LOST', error: 'socket hang up' });
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
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
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
        const client = createClient(300_000);
        const server = makeServer();

        await client.getEvents([server], start, end);
        const { events: events2 } = await client.getEvents([server], start, end);

        // fetchCalendars should only be called once (second call uses cache)
        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
        expect(events2).toHaveLength(1);
    });

    test('default options cache expires at exactly 300000ms', async () => {
        jest.useFakeTimers();
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient({});
        const server = makeServer();
        const end = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([server], BASE_DATE, end);
        jest.advanceTimersByTime(299_999);
        await client.getEvents([server], BASE_DATE, end);
        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await client.getEvents([server], BASE_DATE, end);
        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('a cache hit preserves failed recurrence expansions alongside cached events', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({
            'bad-event': makeVEvent({ uid: 'bad-event', rrule: { freq: 'WEEKLY' } }),
        }));
        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Malformed recurrence');
        });

        const start  = new Date('2025-06-15T00:00:00.000Z');
        const end    = new Date('2025-06-18T00:00:00.000Z');
        const client = createClient(300_000);
        const server = makeServer();

        const first  = await client.getEvents([server], start, end);
        const second = await client.getEvents([server], start, end);

        expect(first.failed).toEqual([expect.objectContaining({ uid: 'bad-event', reason: 'Malformed recurrence' })]);
        expect(second.failed).toEqual(first.failed);
        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });

    test('a later cached server keeps its equal-time event after an earlier fresh server event', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({ cached: makeVEvent({ uid: 'cached-second' }) }))
            .mockImplementationOnce((): Record<string, unknown> => ({ fresh: makeVEvent({ uid: 'fresh-first' }) }));
        const cachedServer = makeServer({
            serverId:  '00000000-0000-0000-0000-000000000002' as CalendarServerEntry['serverId'],
            serverUrl: 'https://cached.example.com',
        });
        const client = createClient(300_000);
        const end = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([cachedServer], BASE_DATE, end);
        const result = await client.getEvents([makeServer(), cachedServer], BASE_DATE, end);

        expect(result.events.map(event => event.uid)).toEqual(['fresh-first', 'cached-second']);
    });

    test('a later cached server keeps its failure after an earlier fresh server failure', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({ cached: makeVEvent({ uid: 'cached-failure', rrule: {} }) }))
            .mockImplementationOnce((): Record<string, unknown> => ({ fresh: makeVEvent({ uid: 'fresh-failure', rrule: {} }) }));
        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('bad recurrence');
        });
        const cachedServer = makeServer({
            serverId:  '00000000-0000-0000-0000-000000000002' as CalendarServerEntry['serverId'],
            serverUrl: 'https://cached.example.com',
        });
        const client = createClient(300_000);
        const end = new Date('2025-06-18T12:00:00.000Z');

        await client.getEvents([cachedServer], BASE_DATE, end);
        const result = await client.getEvents([makeServer(), cachedServer], BASE_DATE, end);

        expect(result.failed.map(failure => failure.uid)).toEqual(['fresh-failure', 'cached-failure']);
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
        const client = createClient(0); // 0ms TTL — immediately expired

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
        const client = createClient(300_000);

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

        const client = createClient(300_000);
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
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
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
        const client = createClient();
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
        const client = createClient();
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
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('extracts basic VEVENT fields', async () => {
        const { events } = await extractEvents([makeVEvent()]);

        expect(events[0]).toMatchObject({
            uid:     'event-uid-1',
            summary: 'Test Meeting',
        });
    });

    test('real node-ical ICS classifies DATE, floating, UTC and TZID values into time variants', async () => {
        const ics = [
            'BEGIN:VCALENDAR', 'VERSION:2.0',
            'BEGIN:VEVENT', 'UID:day', 'DTSTART;VALUE=DATE:20260301', 'DTEND;VALUE=DATE:20260302', 'SUMMARY:Day', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:float', 'DTSTART:20260301T090000', 'DTEND:20260301T100000', 'SUMMARY:Float', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:utc', 'DTSTART:20260301T090000Z', 'DTEND:20260301T100000Z', 'SUMMARY:UTC', 'END:VEVENT',
            'BEGIN:VEVENT', 'UID:zoned', 'DTSTART;TZID=America/New_York:20260301T090000', 'DTEND;TZID=America/New_York:20260301T100000', 'SUMMARY:Zoned', 'END:VEVENT',
            'END:VCALENDAR',
        ].join('\n');
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject(ics)]);
        mockParseICS.mockImplementation((body): Record<string, unknown> => ical.sync.parseICS(body));
        const { events, failed } = await createClient().getEvents([makeServer()], new Date('2026-03-01'), new Date('2026-03-03'));
        expect(failed).toEqual([]);
        expect(events.find(event => event.uid === 'day')?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2026-03-01', endExclusive: '2026-03-02' }));
        expect(events.find(event => event.uid === 'float')?.time).toEqual(createCalendarTimeRange({ kind: 'floating', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00' }));
        expect(events.find(event => event.uid === 'utc')?.time).toEqual({ kind: 'timed', start: new Date('2026-03-01T09:00:00Z'), end: new Date('2026-03-01T10:00:00Z'), timezone: 'Etc/UTC' });
        expect(events.find(event => event.uid === 'zoned')?.time).toEqual({ kind: 'timed', start: new Date('2026-03-01T14:00:00Z'), end: new Date('2026-03-01T15:00:00Z'), timezone: 'America/New_York' });
    });

    test('malformed timed endpoint reports one failed event without discarding a valid neighbor', async () => {
        const { events, failed } = await extractEvents([
            makeVEvent({ uid: 'bad', start: Object.assign(new Date('invalid'), { tz: 'Etc/UTC' }) }),
            makeVEvent({ uid: 'good' }),
        ]);
        expect(events.map(event => event.uid)).toEqual(['good']);
        expect(failed).toEqual([{ uid: 'bad', reason: 'RangeError: Invalid timed calendar endpoints' }]);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            { uid: 'bad', error: new RangeError('Invalid timed calendar endpoints') },
            'Failed to decode calendar event time; it will appear in failed[] for caller visibility'
        );
    });

    test('two malformed events land in failed[] in encounter order, not reversed', async () => {
        const { failed } = await extractEvents([
            makeVEvent({ uid: 'bad-1', start: Object.assign(new Date('invalid'), { tz: 'Etc/UTC' }) }),
            makeVEvent({ uid: 'bad-2', start: Object.assign(new Date('invalid'), { tz: 'Etc/UTC' }) }),
        ]);
        expect(failed.map(failure => failure.uid)).toEqual(['bad-1', 'bad-2']);
    });

    test('an invalid floating end Date reports a failed event instead of a sentinel wall time', async () => {
        const { events, failed } = await extractEvents([
            makeVEvent({ uid: 'nan-end', end: new Date(Number.NaN) }),
            makeVEvent({ uid: 'good' }),
        ]);
        expect(events.map(event => event.uid)).toEqual(['good']);
        expect(failed).toEqual([{ uid: 'nan-end', reason: 'RangeError: Invalid floating calendar time: Invalid DateTime' }]);
    });

    test('an invalid all-day end Date reports a failed event instead of a sentinel date', async () => {
        const { events, failed } = await extractEvents([
            makeVEvent({ uid: 'nan-day', start: new Date(2025, 5, 15), end: new Date(Number.NaN), datetype: 'date' }),
        ]);
        expect(events).toEqual([]);
        expect(failed).toEqual([{ uid: 'nan-day', reason: 'RangeError: Invalid calendar date: Invalid DateTime' }]);
    });

    test('malformed all-day dates report a failed event with the constructor reason', async () => {
        const { events, failed } = await extractEvents([
            makeVEvent({ uid: 'backwards', start: new Date(2025, 5, 16), end: new Date(2025, 5, 15), datetype: 'date' }),
        ]);
        expect(events).toEqual([]);
        expect(failed).toEqual([{ uid: 'backwards', reason: 'RangeError: All-day end 2025-06-15 must be after start 2025-06-16' }]);
    });

    test('maps a one-off floating VEVENT to its host-local wall-clock start and end', async () => {
        const { events } = await extractEvents([makeVEvent({
            start: new Date('2025-06-15T14:00:00.000Z'),
            end:   new Date('2025-06-15T15:30:00.000Z'),
        })]);

        expect(events[0]?.time).toEqual({ kind: 'floating', start: hostWallClock('2025-06-15T14:00:00.000Z'), end: hostWallClock('2025-06-15T15:30:00.000Z') });
    });

    test('maps a one-off all-day VEVENT to its host-local dates with exclusive end', async () => {
        const { events } = await extractEvents([makeVEvent({ start: new Date(2025, 5, 15), end: new Date(2025, 5, 17), datetype: 'date' })]);

        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2025-06-15', endExclusive: '2025-06-17' }));
    });

    test('an unparsed raw string end keeps the legacy instant reading even beside a zoned Date start', async () => {
        const { events } = await extractEvents([makeVEvent({ start: utcDate('2025-06-15T14:00:00.000Z'), end: '2025-06-15T15:00:00.000Z' })]);

        expect(events[0]?.time).toEqual({ kind: 'timed', start: new Date('2025-06-15T14:00:00.000Z'), end: new Date('2025-06-15T15:00:00.000Z'), timezone: undefined });
    });

    test('an unparseable raw string time reports a failed event', async () => {
        const { events, failed } = await extractEvents([makeVEvent({ uid: 'garbage', start: 'not-a-date', end: 'not-a-date' })]);

        expect(events).toEqual([]);
        expect(failed).toEqual([{ uid: 'garbage', reason: 'RangeError: Invalid timed calendar endpoints' }]);
    });

    test('uses (No title) when summary is missing', async () => {
        const { events } = await extractEvents([makeVEvent({ summary: undefined })]);
        expect(events[0]?.summary).toBe('(No title)');
    });

    test('extracts summary from ParameterValue object', async () => {
        const { events } = await extractEvents([
            makeVEvent({ summary: { val: 'Parameterized Title', params: { LANGUAGE: 'de' } } }),
        ]);
        expect(events[0]?.summary).toBe('Parameterized Title');
    });

    test('preserves one-character string and ParameterValue fields', async () => {
        const { events } = await extractEvents([
            makeVEvent({ summary: 'S', location: { val: 'L', params: {} } }),
        ]);

        expect(events[0]).toMatchObject({ summary: 'S', location: 'L' });
    });

    test('extracts location field', async () => {
        const { events } = await extractEvents([makeVEvent({ location: 'Conference Room A' })]);
        expect(events[0]?.location).toBe('Conference Room A');
    });

    test('extracts location from ParameterValue object', async () => {
        const { events } = await extractEvents([
            makeVEvent({ location: { val: 'Room B', params: { ALTREP: 'cid:room-b' } } }),
        ]);
        expect(events[0]?.location).toBe('Room B');
    });

    test('location is undefined when not present', async () => {
        const { events } = await extractEvents([makeVEvent()]);
        expect(events[0]?.location).toBeUndefined();
    });

    test('extracts description field', async () => {
        const { events } = await extractEvents([makeVEvent({ description: 'Meeting agenda' })]);
        expect(events[0]?.description).toBe('Meeting agenda');
    });

    test('description is undefined when empty string', async () => {
        const { events } = await extractEvents([makeVEvent({ description: '' })]);
        expect(events[0]?.description).toBeUndefined();
    });

    test('extracts recurrenceId', async () => {
        const recDate = new Date('2025-06-16T14:00:00.000Z');
        const { events } = await extractEvents([makeVEvent({ recurrenceid: recDate })]);
        expect(events[0]?.recurrenceId).toBe(String(recDate));
    });

    test('recurrenceId is undefined when not present', async () => {
        const { events } = await extractEvents([makeVEvent()]);
        expect(events[0]?.recurrenceId).toBeUndefined();
    });

    // --- isAllDay ---

    test('a DATE-TIME event is not all-day', async () => {
        const { events } = await extractEvents([makeVEvent({ datetype: 'date-time' })]);
        expect(events[0]?.time.kind).toBe('floating');
    });

    test('a datetype date event is all-day', async () => {
        const { events } = await extractEvents([makeVEvent({ datetype: 'date', start: new Date(2025, 5, 15), end: new Date(2025, 5, 16) })]);
        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2025-06-15', endExclusive: '2025-06-16' }));
    });

    test('a start.dateOnly event is all-day', async () => {
        const allDayStart = Object.assign(new Date(2025, 5, 15), { dateOnly: true as const });
        const { events } = await extractEvents([makeVEvent({ start: allDayStart, end: new Date(2025, 5, 16), datetype: 'date-time' })]);
        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2025-06-15', endExclusive: '2025-06-16' }));
    });

    // --- status normalization ---

    test('normalizes CONFIRMED status', async () => {
        const { events } = await extractEvents([makeVEvent({ status: 'CONFIRMED' })]);
        expect(events[0]?.status).toBe('confirmed');
    });

    test('normalizes TENTATIVE status', async () => {
        const { events } = await extractEvents([makeVEvent({ status: 'TENTATIVE' })]);
        expect(events[0]?.status).toBe('tentative');
    });

    test('normalizes CANCELLED status', async () => {
        const { events } = await extractEvents([makeVEvent({ status: 'CANCELLED' })]);
        expect(events[0]?.status).toBe('cancelled');
    });

    test.each([
        ['unknown status string', 'UNKNOWN_STATUS'],
        ['not present', undefined],
        ['whitespace-padded, not trimmed before comparing', ' CONFIRMED '],
        ['a superstring that merely contains "confirmed"', 'UNCONFIRMED'],
    ])('status is undefined for %s', async (_label, status) => {
        const { events } = await extractEvents([makeVEvent({ status })]);
        expect(events[0]?.status).toBeUndefined();
    });

    // --- attendees ---

    test('extracts attendees as string array from string attendees', async () => {
        const { events } = await extractEvents([
            makeVEvent({ attendee: ['mailto:alice@example.com', 'mailto:bob@example.com'] }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com', 'bob@example.com']);
    });

    test('extracts attendees from ParameterValue objects with CN', async () => {
        const { events } = await extractEvents([
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
        const { events } = await extractEvents([
            makeVEvent({
                attendee: [
                    { val: 'mailto:alice@example.com', params: {} },
                ],
            }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com']);
    });

    test('handles single attendee (not array)', async () => {
        const { events } = await extractEvents([
            makeVEvent({ attendee: 'mailto:alice@example.com' }),
        ]);
        expect(events[0]?.attendees).toEqual(['alice@example.com']);
    });

    test('preserves a one-character attendee name', async () => {
        const { events } = await extractEvents([makeVEvent({ attendee: 'A' })]);
        expect(events[0]?.attendees).toEqual(['A']);
    });

    test('preserves parsed component order for equal-time one-off and recurring events', async () => {
        const oneOff = makeVEvent({ uid: 'one-off' });
        const recurring = makeVEvent({ uid: 'recurring', rrule: {} });
        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
            start:       recurring.start as Date,
            end:         recurring.end as Date,
            summary:     'Recurring',
            isFullDay:   false,
            isRecurring: true,
            isOverride:  false,
            event:       recurring,
        }]);

        const { events } = await extractEvents([oneOff, recurring]);

        expect(events.map(event => event.uid)).toEqual(['one-off', 'recurring']);
    });

    test('preserves parsed component order for equal-time one-off events', async () => {
        const { events } = await extractEvents([
            makeVEvent({ uid: 'first' }),
            makeVEvent({ uid: 'second' }),
        ]);

        expect(events.map(event => event.uid)).toEqual(['first', 'second']);
    });

    test('attendees is undefined when no attendee field', async () => {
        const { events } = await extractEvents([makeVEvent({ attendee: undefined })]);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('attendees is undefined when all attendee values are empty after filtering', async () => {
        const { events } = await extractEvents([
            makeVEvent({ attendee: [{ val: '', params: {} }] }),
        ]);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('attendee object without params key falls back to empty string and is filtered out', async () => {
        // An object that has no 'params' key — should not crash and produce no names
        const { events } = await extractEvents([
            makeVEvent({ attendee: [{ val: 'mailto:alice@example.com' }] }),
        ]);
        // No CN, no params key — val extraction falls through to empty string
        expect(events).toHaveLength(1);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('attendee object with params but no val is filtered out', async () => {
        const { events } = await extractEvents([
            makeVEvent({ attendee: [{ params: {} }] }),
        ]);
        expect(events[0]?.attendees).toBeUndefined();
    });

    test('location with empty val string resolves to undefined', async () => {
        const { events } = await extractEvents([makeVEvent({ location: { val: '', params: {} } })]);
        expect(events[0]?.location).toBeUndefined();
    });

    // --- start/end conversion ---

    test('raw string start and end keep the legacy instant reading with no source timezone', async () => {
        const startStr = '2025-06-15T14:00:00.000Z';
        const endStr   = '2025-06-15T15:00:00.000Z';
        const { events } = await extractEvents([
            makeVEvent({ start: startStr, end: endStr }),
        ]);
        expect(events[0]?.time).toEqual({ kind: 'timed', start: new Date(startStr), end: new Date(endStr), timezone: undefined });
    });

    // --- timezone extraction ---

    test('a start carrying tz is a timed range in that source timezone', async () => {
        const startWithTz = Object.assign(new Date('2025-06-15T14:00:00.000Z'), { tz: 'America/New_York' });
        const { events } = await extractEvents([
            makeVEvent({ start: startWithTz, datetype: 'date-time' }),
        ]);
        expect(events[0]?.time).toEqual({ kind: 'timed', start: new Date('2025-06-15T14:00:00.000Z'), end: new Date('2025-06-15T15:00:00.000Z'), timezone: 'America/New_York' });
    });

    test('a start with an empty tz is floating rather than timed', async () => {
        const { events } = await extractEvents([makeVEvent({ start: Object.assign(new Date('2025-06-15T14:00:00.000Z'), { tz: '' }) })]);
        expect(events[0]?.time).toEqual({ kind: 'floating', start: hostWallClock('2025-06-15T14:00:00.000Z'), end: hostWallClock('2025-06-15T15:00:00.000Z') });
    });

    test('an all-day event ignores a start tz and stays date-valued', async () => {
        const startWithTz = Object.assign(new Date(2025, 5, 15), { tz: 'America/New_York', dateOnly: true as const });
        const { events } = await extractEvents([
            makeVEvent({ start: startWithTz, end: new Date(2025, 5, 16), datetype: 'date-time' }),
        ]);
        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2025-06-15', endExclusive: '2025-06-16' }));
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
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('Pacific fall-back repeated hours remain distinct in an isolated runtime', async () => {
        jest.useRealTimers();
        const parentTimeZone = process.env.TZ;
        const parentEffectiveZone = DateTime.local().zoneName;
        const child = Bun.spawn(['bun', 'tests/fixtures/caldav-cache-dst-probe.ts'], {
            cwd:    process.cwd(),
            env:    { ...process.env, TZ: 'America/Los_Angeles' },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const result = await Promise.race([
            child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
            new Promise<{ kind: 'timeout' }>((resolve) => {
                AbortSignal.timeout(4000).addEventListener('abort', () => resolve({ kind: 'timeout' }), { once: true });
            }),
        ]);
        if(result.kind === 'timeout') {
            child.kill('SIGKILL');
            const exitCode = await child.exited;
            const [stdout, stderr] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            throw new Error(`CalDAV DST fixture timed out and was reaped (exit ${exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        }
        const [exitCode, stdout, stderr] = await Promise.all([
            result.exitCode,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
        expect(JSON.parse(stdout)).toEqual({ timezone: 'America/Los_Angeles', startCalls: 2, endCalls: 2 });
        expect(process.env.TZ).toBe(parentTimeZone);
        expect(DateTime.local().zoneName).toBe(parentEffectiveZone);
    }, 5000);

    test('invalid dates still reject while constructing the public cache key', async () => {
        await expect(createClient(300_000).getEvents(
            [makeServer()],
            new Date(Number.NaN),
            new Date('2025-06-18T10:30:00.000Z')
        )).rejects.toThrow(RangeError);
    });

    test('same hour range maps to same cache key', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar(),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({}));

        const client = createClient(300_000);
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

        const client = createClient(300_000);
        const server = makeServer();

        // 10:30 and 14:30 on the same day — same minutes but different hours
        // setMinutes(0,0,0): 10:30→10:00 vs 14:30→14:00 (different → different keys)
        // setHours(0,0,0): 10:30→00:30 vs 14:30→00:30 (same → would incorrectly share cache)
        await client.getEvents([server], new Date('2025-06-15T10:30:00.000Z'), new Date('2025-06-18T10:30:00.000Z'));
        await client.getEvents([server], new Date('2025-06-15T14:30:00.000Z'), new Date('2025-06-18T14:30:00.000Z'));

        // Both should fetch independently — hour difference matters
        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('different start hours use different cache keys when end hour is unchanged', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient(300_000);
        const server = makeServer();
        const end = new Date('2025-06-18T12:30:00.000Z');
        await client.getEvents([server], new Date('2025-06-15T10:30:00.000Z'), end);
        await client.getEvents([server], new Date('2025-06-15T14:30:00.000Z'), end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('different end hours use different cache keys when start hour is unchanged', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient(300_000);
        const server = makeServer();
        const start = new Date('2025-06-15T10:30:00.000Z');
        await client.getEvents([server], start, new Date('2025-06-18T10:30:00.000Z'));
        await client.getEvents([server], start, new Date('2025-06-18T14:30:00.000Z'));

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('calendar path lists with different boundaries use different cache keys', async () => {
        const firstPath = '/calendars/testuser/a';
        const secondPath = '/calendars/testuser/b';
        const combinedPath = '/calendars/testuser/a/calendars/testuser/b';
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeDAVCalendar({ url: firstPath }),
            makeDAVCalendar({ url: secondPath }),
            makeDAVCalendar({ url: combinedPath }),
        ]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: firstPath, label: 'First' },
            { calendarPath: secondPath, label: 'Second' },
        ] })], start, end);
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: combinedPath, label: 'Combined' },
        ] })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('calendar path order does not change the cache key', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');

        await client.getEvents([makeServer({ calendars: [
            { calendarPath: '/a', label: 'A' },
            { calendarPath: '/b', label: 'B' },
        ] })], start, end);
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: '/b', label: 'B' },
            { calendarPath: '/a', label: 'A' },
        ] })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });

    test('server IDs differing only in UUID casing do not share cached results', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');
        const lower = createCalendarServerId('aabbccdd-1111-4222-8333-444455556666');
        const upper = createCalendarServerId('AABBCCDD-1111-4222-8333-444455556666');

        await client.getEvents([makeServer({ serverId: lower })], start, end);
        await client.getEvents([makeServer({ serverId: upper })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('fall-back repeated start hours remain distinct absolute cache buckets', async () => {
        prepareDistinctCacheResults('2026-11-02T10:00:00.000Z');
        const client = createClient(300_000);
        const server = makeServer();
        const end = new Date('2026-11-03T10:30:00.000Z');
        const originalTimeZone = process.env.TZ;
        const originalEffectiveZone = DateTime.local().zoneName;

        // These are the two absolute instants represented by 01:30 before and after Pacific's
        // fall-back. The cache rounds UTC instants, so changing the process-wide timezone is both
        // unnecessary and unsafe for concurrently running tests.
        const first = client.getEvents([server], new Date('2026-11-01T08:30:00.000Z'), end);
        expect(process.env.TZ).toBe(originalTimeZone);
        expect(DateTime.local().zoneName).toBe(originalEffectiveZone);
        const firstResult = await first;
        const second = client.getEvents([server], new Date('2026-11-01T09:30:00.000Z'), end);
        expect(process.env.TZ).toBe(originalTimeZone);
        expect(DateTime.local().zoneName).toBe(originalEffectiveZone);
        const secondResult = await second;

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
        expect([firstResult.events[0]?.uid, secondResult.events[0]?.uid]).toEqual(['event-1', 'event-2']);
    });

    test('fall-back repeated end hours remain distinct absolute cache buckets', async () => {
        prepareDistinctCacheResults('2026-10-31T10:00:00.000Z');
        const client = createClient(300_000);
        const server = makeServer();
        const start = new Date('2026-10-30T10:30:00.000Z');
        const originalTimeZone = process.env.TZ;
        const originalEffectiveZone = DateTime.local().zoneName;

        const first = client.getEvents([server], start, new Date('2026-11-01T08:30:00.000Z'));
        expect(process.env.TZ).toBe(originalTimeZone);
        expect(DateTime.local().zoneName).toBe(originalEffectiveZone);
        const firstResult = await first;
        const second = client.getEvents([server], start, new Date('2026-11-01T09:30:00.000Z'));
        expect(process.env.TZ).toBe(originalTimeZone);
        expect(DateTime.local().zoneName).toBe(originalEffectiveZone);
        const secondResult = await second;

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
        expect([firstResult.events[0]?.uid, secondResult.events[0]?.uid]).toEqual(['event-1', 'event-2']);
    });

    test('comma-containing calendar paths preserve list boundaries in cache keys', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');

        await client.getEvents([makeServer({ calendars: [
            { calendarPath: 'a', label: 'A' },
            { calendarPath: 'b,c', label: 'B,C' },
        ] })], start, end);
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: 'a,b', label: 'A,B' },
            { calendarPath: 'c', label: 'C' },
        ] })], start, end);
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: 'b,c', label: 'B,C' },
            { calendarPath: 'a', label: 'A' },
        ] })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('canonically equivalent calendar paths remain order-independent', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');
        const composedPath = 'caf\u00E9';
        const decomposedPath = 'cafe\u0301';

        await client.getEvents([makeServer({ calendars: [
            { calendarPath: composedPath, label: 'Composed' },
            { calendarPath: decomposedPath, label: 'Decomposed' },
        ] })], start, end);
        await client.getEvents([makeServer({ calendars: [
            { calendarPath: decomposedPath, label: 'Decomposed' },
            { calendarPath: composedPath, label: 'Composed' },
        ] })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });

    test('case-sensitive server URL paths use different cache keys', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const start = new Date('2025-06-15T10:30:00.000Z');
        const end = new Date('2025-06-18T10:30:00.000Z');

        await client.getEvents([makeServer({ serverUrl: 'https://example.com/CalDAV' })], start, end);
        await client.getEvents([makeServer({ serverUrl: 'https://example.com/caldav' })], start, end);

        expect(mockFetchCalendars).toHaveBeenCalledTimes(2);
    });

    test('millisecond differences within an hour share a cache key', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);
        const client = createClient(300_000);
        const server = makeServer();

        await client.getEvents([server], new Date('2025-06-15T10:30:00.001Z'), new Date('2025-06-18T10:30:00.001Z'));
        await client.getEvents([server], new Date('2025-06-15T10:30:00.999Z'), new Date('2025-06-18T10:30:00.999Z'));

        expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Timeout behavior
// ---------------------------------------------------------------------------

describe('CalDAVClient timeout', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('constructor accepts custom timeoutMs', () => {
        const client = createClient(300_000, 5000);
        expect(client).toBeDefined();
    });

    test('constructor uses default timeoutMs when not provided', () => {
        const client = createClient();
        expect(client).toBeDefined();
    });

    test.each([
        ['numeric overload', (): CalDAVClient => new CalDAVClient(300_000, undefined, TEST_DEPENDENCIES)],
        ['options overload', (): CalDAVClient => createClient({})],
    ])('the %s default timeout fires at exactly 15000ms', async (_label, makeClient) => {
        mockCreateDAVClient.mockImplementation((): Promise<never> => new Promise(() => {}));
        const pending = makeClient().discoverCalendars('https://caldav.example.com', 'user', 'pass');
        let settled = false;
        void pending.catch(() => {
            settled = true;
        });

        jest.advanceTimersByTime(14_999);
        await drainMicrotasks();
        try {
            expect(settled).toBe(false);
            jest.advanceTimersByTime(1);
            await drainMicrotasks();
            expect(settled).toBe(true);
        } finally {
            jest.advanceTimersByTime(1);
        }
        await expect(pending).rejects.toBeInstanceOf(CaldavTimeoutError);
    });

    test('throws CaldavTimeoutError when createDAVClient hangs', async () => {
        mockCreateDAVClient.mockImplementation(
            (): Promise<never> => new Promise(() => {}) // never resolves
        );

        const client = createClient(300_000, 50); // 50ms timeout
        const promise = client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        jest.advanceTimersByTime(50);
        await expect(promise).rejects.toBeInstanceOf(CaldavTimeoutError);
    });

    test('CaldavTimeoutError has correct context for connect timeout', async () => {
        mockCreateDAVClient.mockImplementation(
            (): Promise<never> => new Promise(() => {})
        );

        const client = createClient(300_000, 50);
        const promise = client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        jest.advanceTimersByTime(50);
        let thrown: unknown;
        try {
            await promise;
        } catch (e) {
            thrown = e;
        }

        expect(thrown).toBeInstanceOf(CaldavTimeoutError);
        const err = thrown as CaldavTimeoutError;
        expect(err.context).toMatchObject({ timeoutMs: 50, operation: 'connect' });
        expect(err.message).toContain('50ms');
        expect(err.message).toContain('connect');
    });

    test('throws CaldavTimeoutError when fetchCalendars hangs', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(
            (): Promise<never> => new Promise(() => {})
        );

        const client = createClient(300_000, 50);
        const promise = client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        // Drain microtasks to let createDAVClient resolve and its withTimeout chain complete,
        // so that discoverCalendars reaches the fetchCalendars withTimeout and registers its timer
        await drainMicrotasks(10);
        jest.advanceTimersByTime(50);
        await expect(promise).rejects.toBeInstanceOf(CaldavTimeoutError);
    });

    test('throws CaldavTimeoutError when fetchCalendarObjects hangs in getEvents', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            { url: '/calendars/testuser/default/', displayName: 'Personal Calendar' },
        ]);
        mockFetchCalendarObjects.mockImplementation(
            (): Promise<never> => new Promise(() => {})
        );

        const client = createClient(300_000, 50);
        const server = makeServer();
        // getEvents catches errors per-server, so this should not throw but log warning
        const resultPromise = client.getEvents([server], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));
        // Drain microtasks to let createDAVClient and fetchCalendars resolve through their withTimeout chains
        // before fetchCalendarObjects withTimeout registers its timer
        await drainMicrotasks(20);
        jest.advanceTimersByTime(50);
        const result = await resultPromise;
        expect(result).toEqual({ events: [], failed: [] });
        expect(mockLogger.warn).toHaveBeenCalledWith(
            { error: expect.any(CaldavTimeoutError), serverUrl: server.serverUrl },
            'Failed to fetch events from CalDAV server, continuing with partial results'
        );
        const loggedError = (mockLogger.warn.mock.calls[0]?.[0] as { error: CaldavTimeoutError }).error;
        expect(loggedError.context).toMatchObject({ timeoutMs: 50, operation: 'fetchCalendarObjects' });
        expect(loggedError.message).toContain('fetchCalendarObjects');
    });

    test('does not timeout when operations complete quickly', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient(300_000, 5000);
        const result = await client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        expect(result).toEqual([]);
    });

    test('clears timeout timer on successful operation', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => []);

        const client = createClient(300_000, 5000);
        // Should not leak timers: the connect + fetchCalendars withTimeout
        // wrappers both clear their timer in finally on success.
        const result = await client.discoverCalendars('https://caldav.example.com', 'user', 'pass');
        expect(result).toEqual([]);
        // If a timer wasn't cleared it would remain pending and fire after the test.
        expect(jest.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Recurring event expansion
// ---------------------------------------------------------------------------

describe('CalDAVClient recurring event expansion', () => {
    beforeEach(() => {
        mockCreateDAVClient.mockReset();
        mockFetchCalendars.mockReset();
        mockFetchCalendarObjects.mockReset();
        mockParseICS.mockReset();
        mockExpandRecurringEvent.mockReset();
        mockLogger.debug.mockClear();
        mockLogger.error.mockClear();
        mockLogger.warn.mockClear();
    });

    test('non-recurring events (no rrule) are returned unchanged', async () => {
        const vevent = makeVEvent({ uid: 'no-rrule', summary: 'One-off meeting' });
        const { events, failed } = await extractEvents([vevent]);
        expect(events).toHaveLength(1);
        expect(failed).toHaveLength(0);
        expect(events[0]?.uid).toBe('no-rrule');
        expect(events[0]?.summary).toBe('One-off meeting');
        expect(mockExpandRecurringEvent).not.toHaveBeenCalled();
    });

    test('recurring event with rrule produces expanded instances with correct occurrence dates', async () => {
        const masterStart = utcDate('2025-02-23T14:00:00.000Z');
        const masterEnd   = utcDate('2025-02-23T15:00:00.000Z');
        const occurrenceStart = utcDate('2025-06-15T14:00:00.000Z');
        const occurrenceEnd   = utcDate('2025-06-15T15:00:00.000Z');

        const masterEvent = makeVEvent({
            uid:     'recurring-uid',
            summary: 'Weekly Meeting',
            start:   masterStart,
            end:     masterEnd,
            rrule:   { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       occurrenceStart,
                end:         occurrenceEnd,
                summary:     'Weekly Meeting',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
        ]);

        const { events, failed } = await extractEvents([masterEvent]);
        expect(mockExpandRecurringEvent).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(1);
        expect(failed).toHaveLength(0);
        expect(events[0]?.uid).toBe('recurring-uid');
        expect(events[0]?.time).toEqual({ kind: 'timed', start: occurrenceStart, end: occurrenceEnd, timezone: 'Etc/UTC' });
        expect(events[0]?.summary).toBe('Weekly Meeting');
    });

    test('a timed recurrence instance keeps its own instant and copied source timezone', async () => {
        const masterEvent = makeVEvent({ uid: 'zoned-series', start: Object.assign(new Date('2026-03-02T14:00:00.000Z'), { tz: 'America/New_York' }), rrule: { freq: 'WEEKLY' } });
        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
            start:       Object.assign(new Date('2026-03-09T13:00:00.000Z'), { tz: 'America/New_York' }),
            end:         new Date('2026-03-09T14:00:00.000Z'),
            summary:     'Zoned',
            isFullDay:   false,
            isRecurring: true,
            isOverride:  false,
            event:       masterEvent,
        }]);

        const { events } = await extractEvents([masterEvent]);

        expect(events[0]?.time).toEqual({ kind: 'timed', start: new Date('2026-03-09T13:00:00.000Z'), end: new Date('2026-03-09T14:00:00.000Z'), timezone: 'America/New_York' });
    });

    test('a floating recurrence instance takes the series wall time on its nominal date', async () => {
        const seriesStart = new Date(2025, 1, 23, 9, 15, 30);
        const masterEvent = makeVEvent({ uid: 'floating-series', start: seriesStart, end: new Date(2025, 1, 23, 10), rrule: { freq: 'WEEKLY' } });
        // node-ical expands a floating RRULE in UTC: each instance is a whole number of UTC days after the series start.
        const instanceStart = new Date(seriesStart.getTime() + 112 * 86_400_000);
        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
            start:       instanceStart,
            end:         new Date(instanceStart.getTime() + 45 * 60_000),
            summary:     'Floating',
            isFullDay:   false,
            isRecurring: true,
            isOverride:  false,
            event:       masterEvent,
        }]);

        const { events, failed } = await extractEvents([masterEvent]);

        expect(failed).toEqual([]);
        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'floating', start: '2025-06-15T09:15:30', end: '2025-06-15T10:00:30' }));
    });

    test('a floating override instance keeps its own rescheduled wall time', async () => {
        const masterEvent = makeVEvent({ uid: 'floating-override', start: new Date(2025, 5, 9, 9), end: new Date(2025, 5, 9, 10), rrule: { freq: 'WEEKLY' } });
        const overrideEvent = makeVEvent({ uid: 'floating-override', start: new Date(2025, 5, 16, 13, 30), end: new Date(2025, 5, 16, 14), recurrenceid: new Date(2025, 5, 16, 9) });
        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
            start:       new Date(2025, 5, 16, 13, 30),
            end:         new Date(2025, 5, 16, 14),
            summary:     'Moved',
            isFullDay:   false,
            isRecurring: true,
            isOverride:  true,
            event:       overrideEvent,
        }]);

        const { events } = await extractEvents([masterEvent]);

        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'floating', start: '2025-06-16T13:30:00', end: '2025-06-16T14:00:00' }));
    });

    describe('under a DST host zone', () => {
        const originalTz = process.env.TZ;

        beforeEach(() => {
            process.env.TZ = 'America/Los_Angeles';
        });

        afterEach(() => {
            // Bun only re-reads TZ on assignment (deleting it keeps the last zone), and `bun test` defaults to UTC.
            process.env.TZ = originalTz ?? 'Etc/UTC';
            if(originalTz === undefined) {
                delete process.env.TZ;
            }
        });

        test('a floating daily recurrence keeps 09:00 wall time after the host springs forward', async () => {
            const master = makeVEvent({ uid: 'floating-dst', start: new Date(2026, 2, 7, 9), end: new Date(2026, 2, 7, 10), rrule: { freq: 'DAILY' } });
            // 09:00 PST on Mar 7 is 17:00Z; node-ical's UTC expansion keeps 17:00Z, which reads 10:00 PDT on Mar 9.
            mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
                start:       new Date('2026-03-09T17:00:00Z'),
                end:         new Date('2026-03-09T18:00:00Z'),
                summary:     'Daily',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       master,
            }]);

            const { events, failed } = await extractEvents([master]);

            expect(failed).toEqual([]);
            expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'floating', start: '2026-03-09T09:00:00', end: '2026-03-09T10:00:00' }));
        });

        test('a floating override after the host springs forward keeps its own wall time, not a series offset', async () => {
            const master = makeVEvent({ uid: 'floating-dst-override', start: new Date(2026, 2, 7, 9), end: new Date(2026, 2, 7, 10), rrule: { freq: 'DAILY' } });
            const moved = makeVEvent({ uid: 'floating-dst-override', start: new Date(2026, 2, 9, 13, 30), end: new Date(2026, 2, 9, 14), recurrenceid: new Date(2026, 2, 9, 9) });
            mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [{
                start:       moved.start as Date,
                end:         moved.end as Date,
                summary:     'Moved',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  true,
                event:       moved,
            }]);

            const { events } = await extractEvents([master]);

            expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'floating', start: '2026-03-09T13:30:00', end: '2026-03-09T14:00:00' }));
        });

        test('real node-ical floating weekly series whose first interval spans spring-forward keeps its five-hour wall-clock end', async () => {
            const ics = [
                'BEGIN:VCALENDAR', 'VERSION:2.0',
                'BEGIN:VEVENT', 'UID:overnight', 'DTSTART:20260307T230000', 'DTEND:20260308T040000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Overnight', 'END:VEVENT',
                'END:VCALENDAR',
            ].join('\n');
            mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
            mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
            mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject(ics)]);
            mockParseICS.mockImplementation((body): Record<string, unknown> => ical.sync.parseICS(body));
            mockExpandRecurringEvent.mockImplementation((event, options): MockEventInstance[] => ical.expandRecurringEvent(event as unknown as ical.VEvent, options as unknown as ical.ExpandRecurringEventOptions) as unknown as MockEventInstance[]);

            const { events, failed } = await createClient().getEvents([makeServer()], new Date('2026-03-01T00:00:00Z'), new Date('2026-03-31T00:00:00Z'));

            expect(failed).toEqual([]);
            expect(events.map(event => event.time)).toEqual([
                createCalendarTimeRange({ kind: 'floating', start: '2026-03-07T23:00:00', end: '2026-03-08T04:00:00' }),
                createCalendarTimeRange({ kind: 'floating', start: '2026-03-14T23:00:00', end: '2026-03-15T04:00:00' }),
                createCalendarTimeRange({ kind: 'floating', start: '2026-03-21T23:00:00', end: '2026-03-22T04:00:00' }),
            ]);
        });
    });

    test('recurring event produces multiple instances within the range', async () => {
        const masterEvent = makeVEvent({
            uid:   'weekly-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        const instance1Start = new Date('2025-06-15T10:00:00.000Z');
        const instance2Start = new Date('2025-06-16T10:00:00.000Z');

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       instance1Start,
                end:         new Date('2025-06-15T11:00:00.000Z'),
                summary:     'Weekly Event',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
            {
                start:       instance2Start,
                end:         new Date('2025-06-16T11:00:00.000Z'),
                summary:     'Weekly Event',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
        ]);

        const { events } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(2);
        expect(events.map(event => event.time)).toEqual([
            { kind: 'floating', start: hostWallClock('2025-06-15T10:00:00.000Z'), end: hostWallClock('2025-06-15T11:00:00.000Z') },
            { kind: 'floating', start: hostWallClock('2025-06-16T10:00:00.000Z'), end: hostWallClock('2025-06-16T11:00:00.000Z') },
        ]);
    });

    test('recurring event expansion passes start and end date range to expandRecurringEvent', async () => {
        const masterEvent = makeVEvent({
            uid:   'range-check-uid',
            rrule: { freq: 'DAILY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => []);

        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);
        mockParseICS.mockImplementation((): Record<string, unknown> => ({ 'range-check-uid': masterEvent }));

        const queryStart = new Date('2025-06-10T00:00:00.000Z');
        const queryEnd   = new Date('2025-06-20T00:00:00.000Z');

        const client = createClient();
        await client.getEvents([makeServer()], queryStart, queryEnd);

        expect(mockExpandRecurringEvent).toHaveBeenCalledWith(
            masterEvent,
            expect.objectContaining({ from: queryStart, to: queryEnd, expandOngoing: true })
        );
    });

    test('recurring event override uses override event data for summary and location', async () => {
        const masterEvent = makeVEvent({
            uid:      'override-uid',
            summary:  'Original Summary',
            location: 'Original Room',
            rrule:    { freq: 'WEEKLY', interval: 1 },
        });

        const overrideEvent = makeVEvent({
            uid:          'override-uid',
            summary:      'Rescheduled Meeting',
            location:     'New Room',
            recurrenceid: new Date('2025-06-15T14:00:00.000Z'),
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       new Date('2025-06-16T14:00:00.000Z'),
                end:         new Date('2025-06-16T15:00:00.000Z'),
                summary:     'Rescheduled Meeting',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  true,
                event:       overrideEvent,
            },
        ]);

        const { events } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(1);
        expect(events[0]?.summary).toBe('Rescheduled Meeting');
        expect(events[0]?.location).toBe('New Room');
        expect(events[0]?.recurrenceId).toBe(String(overrideEvent.recurrenceid));
    });

    test('all-day recurring events use isFullDay from EventInstance', async () => {
        const masterEvent = makeVEvent({
            uid:      'allday-recurring',
            datetype: 'date',
            start:    new Date('2025-01-01'),
            end:      new Date('2025-01-02'),
            rrule:    { freq: 'YEARLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       new Date(2025, 5, 15),
                end:         new Date(2025, 5, 16),
                summary:     'Annual Event',
                isFullDay:   true,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
        ]);

        const { events } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(1);
        expect(events[0]?.time).toEqual(createCalendarTimeRange({ kind: 'all_day', start: '2025-06-15', endExclusive: '2025-06-16' }));
    });

    // -----------------------------------------------------------------------
    // Failure surfacing — the core behavior this refactor adds
    // -----------------------------------------------------------------------

    test('malformed rrule error surfaces in failed[] with uid and reason', async () => {
        const masterEvent = makeVEvent({
            uid:   'error-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Expansion failed');
        });

        const { events, failed } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(0);
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ uid: 'error-uid', reason: 'Expansion failed' });
    });

    test('malformed rrule error includes rrule string when rrule is present', async () => {
        const rruleObj = { freq: 'WEEKLY', interval: 1, toString: () => 'FREQ=WEEKLY;INTERVAL=1' };
        const masterEvent = makeVEvent({
            uid:   'rrule-str-uid',
            rrule: rruleObj,
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Bad RRULE');
        });

        const { failed } = await extractEvents([masterEvent]);
        expect(failed[0]?.rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
    });

    test('malformed rrule: failed entry uid is undefined when rrule is absent (recurrences-only)', async () => {
        const masterEvent = makeVEvent({
            uid:         'no-rrule-fail-uid',
            recurrences: {},
            // no rrule field
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Expansion blew up');
        });

        const { events, failed } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(0);
        expect(failed).toHaveLength(1);
        expect(failed[0]?.uid).toBe('no-rrule-fail-uid');
        expect(failed[0]?.rrule).toBeUndefined();
    });

    test('logger.warn is called with uid and rrule when expansion fails', async () => {
        const masterEvent = makeVEvent({
            uid:   'warn-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Bad expansion');
        });

        await extractEvents([masterEvent]);

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ error: expect.any(Error), uid: 'warn-uid' }),
            expect.stringContaining('Failed to expand recurring event')
        );
    });

    test('mixed: 2 successful events + 1 failed → all 3 reflected correctly', async () => {
        const goodEvent1 = makeVEvent({ uid: 'good-1', summary: 'Good 1' });
        const goodEvent2 = makeVEvent({ uid: 'good-2', summary: 'Good 2', rrule: { freq: 'DAILY' } });
        const badEvent   = makeVEvent({ uid: 'bad-1', summary: 'Bad 1', rrule: { freq: 'WEEKLY' } });

        mockExpandRecurringEvent
            .mockImplementationOnce((): MockEventInstance[] => [
                {
                    start:       new Date('2025-06-15T10:00:00.000Z'),
                    end:         new Date('2025-06-15T11:00:00.000Z'),
                    summary:     'Good 2',
                    isFullDay:   false,
                    isRecurring: true,
                    isOverride:  false,
                    event:       goodEvent2,
                },
            ])
            .mockImplementationOnce((): never => {
                throw new Error('Malformed RRULE for bad-1');
            });

        const { events, failed } = await extractEvents([goodEvent1, goodEvent2, badEvent]);

        // goodEvent1 is non-recurring → events array; goodEvent2 expands fine; badEvent lands in failed
        expect(events).toHaveLength(2);
        expect(events.find(e => e.uid === 'good-1')).toBeDefined();
        expect(events.find(e => e.uid === 'good-2')).toBeDefined();
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ uid: 'bad-1', reason: 'Malformed RRULE for bad-1' });
    });

    test('all events succeed → failed is empty', async () => {
        const masterEvent = makeVEvent({
            uid:   'success-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       new Date('2025-06-15T14:00:00.000Z'),
                end:         new Date('2025-06-15T15:00:00.000Z'),
                summary:     'OK',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
        ]);

        const { failed } = await extractEvents([masterEvent]);
        expect(failed).toHaveLength(0);
    });

    test('non-Error thrown value surfaces as string reason in failed[]', async () => {
        const masterEvent = makeVEvent({
            uid:   'non-error-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw 'string-error';
        });

        const { failed } = await extractEvents([masterEvent]);
        expect(failed[0]?.reason).toBe('string-error');
    });

    test('failed entries from multiple servers are merged into top-level failed array', async () => {
        // Set up two servers, each returning one failing recurring event
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeCalendarObject('ics')]);

        const failingEvent1 = makeVEvent({ uid: 'fail-s1', rrule: { freq: 'WEEKLY' } });
        const failingEvent2 = makeVEvent({ uid: 'fail-s2', rrule: { freq: 'DAILY' } });

        mockParseICS
            .mockImplementationOnce((): Record<string, unknown> => ({ 'fail-s1': failingEvent1 }))
            .mockImplementationOnce((): Record<string, unknown> => ({ 'fail-s2': failingEvent2 }));

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Bad RRULE');
        });

        const server1 = makeServer({ serverUrl: 'https://server1.example.com' });
        const server2 = makeServer({
            serverId:  '00000000-0000-0000-0000-000000000002' as CalendarServerEntry['serverId'],
            serverUrl: 'https://server2.example.com',
        });

        const client = createClient({ cacheTtlMs: 0 });
        const { events, failed } = await client.getEvents([server1, server2], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(events).toHaveLength(0);
        expect(failed).toHaveLength(2);
        expect(failed.map(f => f.uid)).toEqual(['fail-s1', 'fail-s2']);
    });

    test('failed entries preserve calendar-object order', async () => {
        mockCreateDAVClient.mockImplementation(async (): Promise<typeof mockDAVClient> => mockDAVClient);
        mockFetchCalendars.mockImplementation(async (): Promise<Record<string, unknown>[]> => [makeDAVCalendar()]);
        mockFetchCalendarObjects.mockImplementation(async (): Promise<Record<string, unknown>[]> => [
            makeCalendarObject('first'), makeCalendarObject('second'),
        ]);
        mockParseICS.mockImplementation((body): Record<string, unknown> => ({
            [body]: makeVEvent({ uid: body, rrule: {} }),
        }));
        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('bad recurrence');
        });

        const result = await createClient().getEvents([makeServer()], BASE_DATE, new Date('2025-06-18T12:00:00.000Z'));

        expect(result.failed.map(failure => failure.uid)).toEqual(['first', 'second']);
    });

    test('failed entries preserve parsed component order', async () => {
        const first = makeVEvent({ uid: 'first', rrule: {} });
        const second = makeVEvent({ uid: 'second', rrule: {} });
        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('bad recurrence');
        });

        const result = await extractEvents([first, second]);

        expect(result.failed.map(failure => failure.uid)).toEqual(['first', 'second']);
    });

    test('error in expandRecurringEvent is logged, event skipped gracefully (legacy test updated)', async () => {
        const masterEvent = makeVEvent({
            uid:   'error-uid',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): never => {
            throw new Error('Expansion failed');
        });

        const { events } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(0);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ error: expect.any(Error) }),
            expect.stringContaining('recurring')
        );
    });

    test('timezone is extracted from instance.start.tz for timed recurring instances', async () => {
        const masterEvent = makeVEvent({
            uid:   'tz-recurring',
            rrule: { freq: 'WEEKLY', interval: 1 },
        });

        const instanceStart = Object.assign(new Date('2025-06-15T14:00:00.000Z'), { tz: 'America/Chicago' });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       instanceStart,
                end:         new Date('2025-06-15T15:00:00.000Z'),
                summary:     'Recurring TZ Event',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  false,
                event:       masterEvent,
            },
        ]);

        const { events } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(1);
        expect(events[0]?.time).toMatchObject({ kind: 'timed', timezone: 'America/Chicago' });
    });

    test('recurring event that produces zero instances is silently excluded and logs debug', async () => {
        const masterEvent = makeVEvent({
            uid:     'no-instances-uid',
            summary: 'Far Future Recurring',
            rrule:   { freq: 'DAILY', interval: 1 },
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => []);

        const { events, failed } = await extractEvents([masterEvent]);
        expect(events).toHaveLength(0);
        expect(failed).toHaveLength(0);
        expect(mockLogger.debug).toHaveBeenCalledWith(
            expect.objectContaining({ uid: 'no-instances-uid' }),
            expect.stringContaining('no instances in range')
        );
    });

    test('vevent with recurrences but no rrule triggers expansion path', async () => {
        const overrideEvent = makeVEvent({
            uid:          'recurrences-only-uid',
            summary:      'Override Instance',
            recurrenceid: new Date('2025-06-15T14:00:00.000Z'),
        });

        const masterEvent = makeVEvent({
            uid:         'recurrences-only-uid',
            summary:     'Master Event',
            recurrences: { '2025-06-15T14:00:00.000Z': overrideEvent },
            // no rrule
        });

        mockExpandRecurringEvent.mockImplementation((): MockEventInstance[] => [
            {
                start:       new Date('2025-06-15T14:00:00.000Z'),
                end:         new Date('2025-06-15T15:00:00.000Z'),
                summary:     'Override Instance',
                isFullDay:   false,
                isRecurring: true,
                isOverride:  true,
                event:       overrideEvent,
            },
        ]);

        const { events, failed } = await extractEvents([masterEvent]);
        expect(mockExpandRecurringEvent).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(1);
        expect(failed).toHaveLength(0);
        expect(events[0]?.summary).toBe('Override Instance');
    });
});
