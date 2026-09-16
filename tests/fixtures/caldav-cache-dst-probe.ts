import type { CalendarServerEntry } from '../../src/integrations/caldav/calendar-registry/types';
import { CalDAVClient, type CalDAVClientDependencies } from '../../src/integrations/caldav/client';

const calendarPath = '/calendars/test/default/';
const server: CalendarServerEntry = {
    serverId:    '00000000-0000-0000-0000-000000000001' as CalendarServerEntry['serverId'],
    description: 'DST cache probe',
    serverUrl:   'https://caldav.example.com',
    username:    'test',
    password:    'test',
    calendars:   [{ calendarPath, label: 'Test' }],
};

function createProbe(): { client: CalDAVClient, calls: () => number } {
    let createCalls = 0;
    const dependencies = {
        createDAVClient: async () => {
            createCalls += 1;
            return {
                fetchCalendars:       async () => [{ url: calendarPath }],
                fetchCalendarObjects: async () => [],
            };
        },
        parseICS:             () => ({}),
        expandRecurringEvent: () => [],
    } as unknown as CalDAVClientDependencies;
    return {
        client: new CalDAVClient({ cacheTtlMs: 300_000, dependencies }),
        calls:  () => createCalls,
    };
}

const repeatedHour = [new Date('2026-11-01T08:30:00.000Z'), new Date('2026-11-01T09:30:00.000Z')] as const;
const startProbe = createProbe();
for(const start of repeatedHour) {
    // eslint-disable-next-line no-await-in-loop -- two ordered requests intentionally exercise cache identity
    await startProbe.client.getEvents([server], start, new Date('2026-11-03T10:30:00.000Z'));
}
const endProbe = createProbe();
for(const end of repeatedHour) {
    // eslint-disable-next-line no-await-in-loop -- two ordered requests intentionally exercise cache identity
    await endProbe.client.getEvents([server], new Date('2026-10-30T10:30:00.000Z'), end);
}

// eslint-disable-next-line no-console -- machine-readable result consumed by the parent test
console.log(JSON.stringify({
    timezone:   Intl.DateTimeFormat().resolvedOptions().timeZone,
    startCalls: startProbe.calls(),
    endCalls:   endProbe.calls(),
}));
