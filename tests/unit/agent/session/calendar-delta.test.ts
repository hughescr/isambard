import { describe, test, expect, jest, spyOn, afterEach } from 'bun:test';
import {
    agendaKey,
    agendaFingerprint,
    diffAgenda,
    dayWindow,
    toAgenda,
    eventsInWindow,
    type AgendaEntry
} from '../../../../src/agent/session/calendar-delta';
import type { CalendarEvent } from '../../../../src/integrations/caldav';

function makeEntry(overrides: Partial<AgendaEntry> = {}): AgendaEntry {
    return {
        uid:      'uid-1',
        start:    '2026-03-08T17:00:00.000Z',
        end:      '2026-03-08T18:00:00.000Z',
        summary:  'Meeting',
        isAllDay: false,
        ...overrides,
    };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid:           'uid-1',
        summary:       'Meeting',
        start:         new Date('2026-03-08T17:00:00.000Z'),
        end:           new Date('2026-03-08T18:00:00.000Z'),
        isAllDay:      false,
        calendarLabel: 'Work',
        ...overrides,
    };
}

describe('agendaKey', () => {
    test('combines uid and recurrenceId with a pipe', () => {
        expect(agendaKey(makeEntry({ uid: 'series-1', recurrenceId: '2026-03-08' }))).toBe('series-1|2026-03-08');
    });

    test('uses an empty string for a missing recurrenceId', () => {
        expect(agendaKey(makeEntry({ uid: 'single-1' }))).toBe('single-1|');
    });

    test('two instances of the same series with different recurrenceIds are different keys', () => {
        const first  = agendaKey(makeEntry({ uid: 'series-1', recurrenceId: '2026-03-08' }));
        const second = agendaKey(makeEntry({ uid: 'series-1', recurrenceId: '2026-03-15' }));
        expect(first).not.toBe(second);
    });
});

describe('agendaFingerprint', () => {
    test('two field-for-field identical entries produce the same fingerprint', () => {
        const a = makeEntry({ location: 'Room 1', status: 'confirmed' });
        const b = makeEntry({ location: 'Room 1', status: 'confirmed' });
        expect(agendaFingerprint(a)).toBe(agendaFingerprint(b));
    });

    test.each([
        ['start', { start: '2026-03-08T18:00:00.000Z' }],
        ['end', { end: '2026-03-08T19:00:00.000Z' }],
        ['summary', { summary: 'Renamed meeting' }],
        ['location', { location: 'Room 2' }],
        ['status', { status: 'cancelled' }],
        ['isAllDay', { isAllDay: true }],
    ])('changing %s changes the fingerprint', (_field, overrides) => {
        const base    = makeEntry({ location: 'Room 1', status: 'confirmed' });
        const changed = makeEntry({ location: 'Room 1', status: 'confirmed', ...overrides });
        expect(agendaFingerprint(base)).not.toBe(agendaFingerprint(changed));
    });

    test('a fingerprint does not depend on uid or recurrenceId', () => {
        const a = makeEntry({ uid: 'uid-a' });
        const b = makeEntry({ uid: 'uid-b' });
        expect(agendaFingerprint(a)).toBe(agendaFingerprint(b));
    });
});

describe('diffAgenda', () => {
    test('isFirst is true with every list empty when baseline is undefined', () => {
        const current = [makeEntry(), makeEntry({ uid: 'uid-2' })];
        const result  = diffAgenda(undefined, current);

        expect(result).toEqual({ added: [], removed: [], changed: [], isFirst: true });
    });

    test('isFirst is true regardless of how many current entries there are', () => {
        expect(diffAgenda(undefined, [])).toEqual({ added: [], removed: [], changed: [], isFirst: true });
    });

    test('an entry present only in current is added', () => {
        const baseline = [makeEntry({ uid: 'uid-1' })];
        const current  = [makeEntry({ uid: 'uid-1' }), makeEntry({ uid: 'uid-2' })];

        const result = diffAgenda(baseline, current);

        expect(result.added).toEqual([makeEntry({ uid: 'uid-2' })]);
        expect(result.removed).toEqual([]);
        expect(result.changed).toEqual([]);
        expect(result.isFirst).toBe(false);
    });

    test('an entry present only in baseline is removed', () => {
        const baseline = [makeEntry({ uid: 'uid-1' }), makeEntry({ uid: 'uid-2' })];
        const current  = [makeEntry({ uid: 'uid-1' })];

        const result = diffAgenda(baseline, current);

        expect(result.removed).toEqual([makeEntry({ uid: 'uid-2' })]);
        expect(result.added).toEqual([]);
        expect(result.changed).toEqual([]);
    });

    test('same key with a different fingerprint is changed, not added/removed', () => {
        const baseline = [makeEntry({ uid: 'uid-1', summary: 'Original' })];
        const current  = [makeEntry({ uid: 'uid-1', summary: 'Updated' })];

        const result = diffAgenda(baseline, current);

        expect(result.changed).toEqual([makeEntry({ uid: 'uid-1', summary: 'Updated' })]);
        expect(result.added).toEqual([]);
        expect(result.removed).toEqual([]);
    });

    test('same key with an identical fingerprint produces no churn', () => {
        const baseline = [makeEntry({ uid: 'uid-1' })];
        const current  = [makeEntry({ uid: 'uid-1' })];

        const result = diffAgenda(baseline, current);

        expect(result).toEqual({ added: [], removed: [], changed: [], isFirst: false });
    });

    test('a recurring instance with a different recurrenceId is a different key (added + removed, not changed)', () => {
        const baseline = [makeEntry({ uid: 'series-1', recurrenceId: '2026-03-08', summary: 'Standup' })];
        const current  = [makeEntry({ uid: 'series-1', recurrenceId: '2026-03-15', summary: 'Standup' })];

        const result = diffAgenda(baseline, current);

        expect(result.added).toEqual([makeEntry({ uid: 'series-1', recurrenceId: '2026-03-15', summary: 'Standup' })]);
        expect(result.removed).toEqual([makeEntry({ uid: 'series-1', recurrenceId: '2026-03-08', summary: 'Standup' })]);
        expect(result.changed).toEqual([]);
    });

    test('identical agendas across a window that slides within the same local day produce an empty delta', () => {
        // Simulates two hourly polls on the same local day: the CalDAV rolling window's exact
        // fetch bounds differ, but toAgenda's day-aligned window keeps the same entries.
        const morningPollAgenda   = [makeEntry({ uid: 'uid-1' }), makeEntry({ uid: 'uid-2', start: '2026-03-08T20:00:00.000Z', end: '2026-03-08T21:00:00.000Z' })];
        const afternoonPollAgenda = [makeEntry({ uid: 'uid-1' }), makeEntry({ uid: 'uid-2', start: '2026-03-08T20:00:00.000Z', end: '2026-03-08T21:00:00.000Z' })];

        const result = diffAgenda(morningPollAgenda, afternoonPollAgenda);

        expect(result).toEqual({ added: [], removed: [], changed: [], isFirst: false });
    });

    test('empty baseline and empty current produce an empty, non-first delta', () => {
        expect(diffAgenda([], [])).toEqual({ added: [], removed: [], changed: [], isFirst: false });
    });
});

// tests/setup.ts's global Intl.DateTimeFormat mock gives every zone a single fixed offset (no
// DST — America/Los_Angeles is always PST/-8), so it cannot exercise a real spring-forward
// transition on its own. This override makes Luxon's own offset query for America/Los_Angeles
// flip across the real 2026 spring-forward instant (2026-03-08T10:00:00Z, 02:00 PST -> 03:00 PDT)
// while every other zone/query shape keeps using the setup mock unchanged. Mirrors the pattern in
// tests/unit/agent/session/cost-ceiling.test.ts's mockRealNewYorkDst.
const LA_SPRING_TRANSITION_UTC = Date.parse('2026-03-08T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function mockRealLosAngelesDst(): void {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function(this: Intl.DateTimeFormat, date?: Date | number) {
        const options = (this as unknown as { options: Intl.DateTimeFormatOptions }).options;
        const isLuxonOffsetQuery = options.timeZone === 'America/Los_Angeles' && !options.weekday && !options.timeZoneName && !(options.hour && !options.minute);
        if(!isLuxonOffsetQuery) {
            return original.call(this, date);
        }
        const ms = date instanceof Date ? date.getTime() : (date ?? Date.now());
        const isPdt = ms >= LA_SPRING_TRANSITION_UTC;
        const offsetMs = (isPdt ? -7 : -8) * HOUR_MS;
        const d = new Date(ms + offsetMs);
        return [
            { type: 'year', value: String(d.getUTCFullYear()) },
            { type: 'month', value: String(d.getUTCMonth() + 1).padStart(2, '0') },
            { type: 'day', value: String(d.getUTCDate()).padStart(2, '0') },
            { type: 'hour', value: String(d.getUTCHours()).padStart(2, '0') },
            { type: 'minute', value: String(d.getUTCMinutes()).padStart(2, '0') },
            { type: 'second', value: String(d.getUTCSeconds()).padStart(2, '0') },
        ] satisfies Intl.DateTimeFormatPart[];
    });
}

describe('dayWindow', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('America/Los_Angeles on a normal day spans a full 24 hours', () => {
        // 2026-01-15 is well clear of any DST transition in America/Los_Angeles.
        const nowMs = new Date('2026-01-15T20:00:00.000Z').getTime();
        const { startMs, endMs } = dayWindow(nowMs, 'America/Los_Angeles');

        expect(endMs - startMs).toBeCloseTo(24 * 60 * 60 * 1000, -3);
    });

    test('America/Los_Angeles on the spring-forward DST day is a short (23-hour) day', () => {
        // 2026-03-08 is the US spring-forward date: clocks jump 02:00 -> 03:00 local.
        mockRealLosAngelesDst();
        const nowMs = new Date('2026-03-08T20:00:00.000Z').getTime();
        const { startMs, endMs } = dayWindow(nowMs, 'America/Los_Angeles');

        expect(endMs - startMs).toBeCloseTo(23 * 60 * 60 * 1000, -3);
    });

    test('two instants on the same America/Los_Angeles calendar day produce the identical window', () => {
        const morning   = new Date('2026-01-15T16:00:00.000Z').getTime(); // 08:00 PST
        const afternoon = new Date('2026-01-16T02:00:00.000Z').getTime(); // 18:00 PST same local day

        expect(dayWindow(morning, 'America/Los_Angeles')).toEqual(dayWindow(afternoon, 'America/Los_Angeles'));
    });

    test('Pacific/Auckland (a positive UTC offset zone) computes local-day bounds distinct from UTC', () => {
        // 2026-01-15T10:00:00Z is 2026-01-15T23:00:00+13:00 in Auckland (NZDT, UTC+13 in January).
        const nowMs = new Date('2026-01-15T10:00:00.000Z').getTime();
        const { startMs, endMs } = dayWindow(nowMs, 'Pacific/Auckland');

        // Local midnight 2026-01-15T00:00:00+13:00 = 2026-01-14T11:00:00Z
        expect(startMs).toBe(new Date('2026-01-14T11:00:00.000Z').getTime());
        // Local end-of-day 2026-01-15T23:59:59.999+13:00 = 2026-01-15T10:59:59.999Z
        expect(endMs).toBe(new Date('2026-01-15T10:59:59.999Z').getTime());
    });
});

describe('toAgenda', () => {
    const window = { startMs: new Date('2026-03-08T08:00:00.000Z').getTime(), endMs: new Date('2026-03-09T07:59:59.999Z').getTime() };

    test('drops an event entirely before the window', () => {
        const event = makeEvent({ start: new Date('2026-03-08T01:00:00.000Z'), end: new Date('2026-03-08T02:00:00.000Z') });
        expect(toAgenda([event], window)).toEqual([]);
    });

    test('drops an event entirely after the window', () => {
        const event = makeEvent({ start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });
        expect(toAgenda([event], window)).toEqual([]);
    });

    test('keeps an event straddling the start of the window', () => {
        const event = makeEvent({ start: new Date('2026-03-08T07:00:00.000Z'), end: new Date('2026-03-08T09:00:00.000Z') });
        expect(toAgenda([event], window)).toHaveLength(1);
    });

    test('keeps an event straddling the end of the window (straddling midnight)', () => {
        const event = makeEvent({ start: new Date('2026-03-09T07:00:00.000Z'), end: new Date('2026-03-09T09:00:00.000Z') });
        expect(toAgenda([event], window)).toHaveLength(1);
    });

    test('keeps an event fully inside the window', () => {
        const event = makeEvent({ start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        expect(toAgenda([event], window)).toHaveLength(1);
    });

    test('keeps an event ending exactly at window.startMs (inclusive lower boundary)', () => {
        const event = makeEvent({ start: new Date('2026-03-08T07:00:00.000Z'), end: new Date(window.startMs) });
        expect(toAgenda([event], window)).toHaveLength(1);
    });

    test('drops an event ending one millisecond before window.startMs', () => {
        const event = makeEvent({ start: new Date('2026-03-08T06:00:00.000Z'), end: new Date(window.startMs - 1) });
        expect(toAgenda([event], window)).toEqual([]);
    });

    test('keeps an event starting exactly at window.endMs (inclusive upper boundary)', () => {
        const event = makeEvent({ start: new Date(window.endMs), end: new Date('2026-03-09T09:00:00.000Z') });
        expect(toAgenda([event], window)).toHaveLength(1);
    });

    test('drops an event starting one millisecond after window.endMs', () => {
        const event = makeEvent({ start: new Date(window.endMs + 1), end: new Date('2026-03-09T10:00:00.000Z') });
        expect(toAgenda([event], window)).toEqual([]);
    });

    test('maps CalendarEvent fields onto AgendaEntry, converting dates to ISO strings', () => {
        const event = makeEvent({
            uid:          'uid-9',
            recurrenceId: '2026-03-08',
            summary:      'Standup',
            location:     'Room 3',
            status:       'tentative',
            isAllDay:     false,
            start:        new Date('2026-03-08T17:00:00.000Z'),
            end:          new Date('2026-03-08T17:30:00.000Z'),
        });

        expect(toAgenda([event], window)).toEqual([{
            uid:          'uid-9',
            recurrenceId: '2026-03-08',
            start:        '2026-03-08T17:00:00.000Z',
            end:          '2026-03-08T17:30:00.000Z',
            summary:      'Standup',
            location:     'Room 3',
            status:       'tentative',
            isAllDay:     false,
        }]);
    });

    test('sorts by start time, then by agendaKey for same-start ties', () => {
        const later  = makeEvent({ uid: 'uid-b', start: new Date('2026-03-08T18:00:00.000Z'), end: new Date('2026-03-08T19:00:00.000Z') });
        const tieA   = makeEvent({ uid: 'uid-a', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') });
        const tieB   = makeEvent({ uid: 'uid-b-tie', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') });

        const result = toAgenda([later, tieB, tieA], window);

        expect(result.map(entry => entry.uid)).toEqual(['uid-a', 'uid-b-tie', 'uid-b']);
    });

    test('returns [] for an empty events array', () => {
        expect(toAgenda([], window)).toEqual([]);
    });
});

describe('eventsInWindow', () => {
    const window = { startMs: new Date('2026-03-08T08:00:00.000Z').getTime(), endMs: new Date('2026-03-09T07:59:59.999Z').getTime() };

    test('keeps only events overlapping the window, as the raw CalendarEvent (not an AgendaEntry projection)', () => {
        const inside  = makeEvent({ uid: 'inside', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        const outside = makeEvent({ uid: 'outside', start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });

        expect(eventsInWindow([inside, outside], window)).toEqual([inside]);
    });

    test('returns [] for an empty events array', () => {
        expect(eventsInWindow([], window)).toEqual([]);
    });

    test('toAgenda\'s output is exactly eventsInWindow\'s survivors, mapped to AgendaEntry', () => {
        const inside  = makeEvent({ uid: 'inside', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        const outside = makeEvent({ uid: 'outside', start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });

        expect(toAgenda([inside, outside], window).map(entry => entry.uid)).toEqual(eventsInWindow([inside, outside], window).map(event => event.uid));
    });
});
