import { describe, test, expect } from 'bun:test';
import { AmbiguousCalendarMatchError } from '@/errors';
import { resolveServer, resolveCalendar } from '@/integrations/caldav/calendar-registry/resolve';
import { createCalendarServerId, type CalendarServerEntry } from '@/integrations/caldav/calendar-registry/types';

// Stryker disable next-line StringLiteral: Test UUID constants are test configuration
const SERVER_UUID_1 = createCalendarServerId('550e8400-e29b-41d4-a716-446655440001');
// Stryker disable next-line StringLiteral: Test UUID constants are test configuration
const SERVER_UUID_2 = createCalendarServerId('550e8400-e29b-41d4-a716-446655440002');

function makeServer(overrides: Partial<CalendarServerEntry> & { serverId: CalendarServerEntry['serverId'], description: string }): CalendarServerEntry {
    return {
        serverId:    overrides.serverId,
        description: overrides.description,
        serverUrl:   overrides.serverUrl ?? 'https://caldav.example.com',
        username:    overrides.username ?? 'user',
        password:    overrides.password ?? 'pass',
        calendars:   overrides.calendars ?? [{ calendarPath: '/cal/default', label: 'Default' }],
    };
}

// ─── resolveServer ────────────────────────────────────────────────────────────

describe.concurrent('resolveServer()', () => {
    test('returns matching server on exact UUID match', () => {
        const server1 = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        const server2 = makeServer({ serverId: SERVER_UUID_2, description: 'Google' });
        const result = resolveServer([server1, server2], SERVER_UUID_1);
        expect(result).toBe(server1);
    });

    test('returns null when UUID does not match any server', () => {
        const server = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        // Stryker disable next-line StringLiteral: Non-existent UUID is test input data
        const result = resolveServer([server], 'ffffffff-aaaa-bbbb-cccc-dddddddddddd');
        expect(result).toBeNull();
    });

    test('returns matching server on case-insensitive description match', () => {
        const server = makeServer({ serverId: SERVER_UUID_1, description: 'Apple iCloud' });
        const result = resolveServer([server], 'apple icloud');
        expect(result).toBe(server);
    });

    test('returns matching server on exact case description match', () => {
        const server = makeServer({ serverId: SERVER_UUID_1, description: 'Apple iCloud' });
        const result = resolveServer([server], 'Apple iCloud');
        expect(result).toBe(server);
    });

    test('returns null when description does not match any server', () => {
        const server = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        const result = resolveServer([server], 'Google');
        expect(result).toBeNull();
    });

    test('returns null when server list is empty', () => {
        const result = resolveServer([], 'anything');
        expect(result).toBeNull();
    });

    test('throws AmbiguousCalendarMatchError when multiple servers match by description', () => {
        const server1 = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        const server2 = makeServer({ serverId: SERVER_UUID_2, description: 'iCloud' });
        expect(() => resolveServer([server1, server2], 'icloud')).toThrow(AmbiguousCalendarMatchError);
    });

    test('AmbiguousCalendarMatchError includes match details for ambiguous description', () => {
        const server1 = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        const server2 = makeServer({ serverId: SERVER_UUID_2, description: 'iCloud' });
        let thrown: AmbiguousCalendarMatchError | null = null;
        try {
            resolveServer([server1, server2], 'icloud');
        } catch (e) {
            thrown = e as AmbiguousCalendarMatchError;
        }
        expect(thrown).not.toBeNull();
        expect(thrown?.context.entityType).toBe('server');
        expect(thrown?.context.input).toBe('icloud');
        expect(thrown?.context.matches).toHaveLength(2);
        expect(thrown?.context.matches.map(m => m.id)).toContain(SERVER_UUID_1);
        expect(thrown?.context.matches.map(m => m.id)).toContain(SERVER_UUID_2);
    });

    test('UUID input does not fall back to description matching', () => {
        // Even if a server has description matching the UUID pattern, UUID path is used
        const server = makeServer({ serverId: SERVER_UUID_1, description: SERVER_UUID_2 });
        // Input is a valid UUID but doesn't match SERVER_UUID_1
        const result = resolveServer([server], SERVER_UUID_2);
        expect(result).toBeNull();
    });

    test('should return null for empty string input', () => {
        const serverA = makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' });
        expect(resolveServer([serverA], '')).toBeNull();
    });

    test('should not match partial substrings (regression: was .includes, now ===)', () => {
        // 'cloud' should NOT match 'iCloud' or 'Apple iCloud'
        expect(resolveServer([makeServer({ serverId: SERVER_UUID_1, description: 'iCloud' })], 'cloud')).toBeNull();
    });
});

// ─── resolveCalendar ──────────────────────────────────────────────────────────

describe.concurrent('resolveCalendar()', () => {
    const server = makeServer({
        serverId:    SERVER_UUID_1,
        description: 'iCloud',
        calendars:   [
            { calendarPath: '/cal/home',   label: 'Home Calendar' },
            { calendarPath: '/cal/work',   label: 'Work Calendar' },
            { calendarPath: '/cal/family', label: 'Family' },
        ],
    });

    test('returns calendar entry on exact calendarPath match (starts with /)', () => {
        const result = resolveCalendar(server, '/cal/home');
        expect(result).toEqual({ calendarPath: '/cal/home', label: 'Home Calendar' });
    });

    test('returns calendar entry on URL-like path match (starts with http)', () => {
        const httpServer = makeServer({
            serverId:    SERVER_UUID_1,
            description: 'Google',
            calendars:   [
                { calendarPath: 'https://caldav.google.com/user/calendar', label: 'My Calendar' },
            ],
        });
        const result = resolveCalendar(httpServer, 'https://caldav.google.com/user/calendar');
        expect(result).toEqual({ calendarPath: 'https://caldav.google.com/user/calendar', label: 'My Calendar' });
    });

    test('returns null when path input does not match any calendarPath', () => {
        const result = resolveCalendar(server, '/cal/nonexistent');
        expect(result).toBeNull();
    });

    test('returns calendar entry on case-insensitive label match', () => {
        const result = resolveCalendar(server, 'home calendar');
        expect(result).toEqual({ calendarPath: '/cal/home', label: 'Home Calendar' });
    });

    test('returns calendar entry on exact label match', () => {
        const result = resolveCalendar(server, 'Family');
        expect(result).toEqual({ calendarPath: '/cal/family', label: 'Family' });
    });

    test('returns null when label does not match any calendar', () => {
        const result = resolveCalendar(server, 'Nonexistent');
        expect(result).toBeNull();
    });

    test('throws AmbiguousCalendarMatchError when multiple calendars match by label', () => {
        const ambigServer = makeServer({
            serverId:    SERVER_UUID_1,
            description: 'iCloud',
            calendars:   [
                { calendarPath: '/cal/home-1', label: 'Home' },
                { calendarPath: '/cal/home-2', label: 'Home' },
            ],
        });
        expect(() => resolveCalendar(ambigServer, 'home')).toThrow(AmbiguousCalendarMatchError);
    });

    test('should return null for empty string input', () => {
        expect(resolveCalendar(server, '')).toBeNull();
    });

    test('should not match partial substrings (regression: was .includes, now ===)', () => {
        // 'Airlines' should NOT match 'Alaska Airlines'
        const airlineServer = makeServer({
            serverId:    SERVER_UUID_1,
            description: 'iCloud',
            calendars:   [{ calendarPath: '/cal/alaska', label: 'Alaska Airlines' }],
        });
        expect(resolveCalendar(airlineServer, 'Airlines')).toBeNull();
    });

    test('AmbiguousCalendarMatchError includes match details for ambiguous label', () => {
        const ambigServer = makeServer({
            serverId:    SERVER_UUID_1,
            description: 'iCloud',
            calendars:   [
                { calendarPath: '/cal/home-1', label: 'Home' },
                { calendarPath: '/cal/home-2', label: 'Home' },
            ],
        });
        let thrown: AmbiguousCalendarMatchError | null = null;
        try {
            resolveCalendar(ambigServer, 'home');
        } catch (e) {
            thrown = e as AmbiguousCalendarMatchError;
        }
        expect(thrown).not.toBeNull();
        expect(thrown?.context.entityType).toBe('calendar');
        expect(thrown?.context.input).toBe('home');
        expect(thrown?.context.matches).toHaveLength(2);
        expect(thrown?.context.matches.map(m => m.id)).toContain('/cal/home-1');
        expect(thrown?.context.matches.map(m => m.id)).toContain('/cal/home-2');
    });
});
