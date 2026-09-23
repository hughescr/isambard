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
import { createLocalDate, createLocalDateTime, type CalendarEvent } from '../../../../src/integrations/caldav';

interface OldTime<T> { start?: T, end?: T, isAllDay?: boolean }
function makeEntry(overrides: Partial<AgendaEntry> & OldTime<string> = {}): AgendaEntry {
    const { start, end, isAllDay, ...fields } = overrides;
    return {
        uid:     'uid-1',
        summary: 'Meeting',
        time:    isAllDay
            ? { kind: 'all_day', start: createLocalDate('2026-03-08'), endExclusive: createLocalDate('2026-03-09') }
            : { kind: 'timed', start: new Date(start ?? '2026-03-08T17:00:00.000Z'), end: new Date(end ?? '2026-03-08T18:00:00.000Z') },
        ...fields,
    };
}

function makeEvent(overrides: Partial<CalendarEvent> & OldTime<Date> = {}): CalendarEvent {
    const { start, end, isAllDay, ...fields } = overrides;
    return {
        uid:     'uid-1',
        summary: 'Meeting',
        time:    isAllDay
            ? { kind: 'all_day', start: createLocalDate('2026-03-08'), endExclusive: createLocalDate('2026-03-09') }
            : { kind: 'timed', start: start ?? new Date('2026-03-08T17:00:00.000Z'), end: end ?? new Date('2026-03-08T18:00:00.000Z') },
        calendarLabel: 'Work',
        ...fields,
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
        ['time variant', { isAllDay: true }],
    ])('changing %s changes the fingerprint', (_field, overrides) => {
        const base    = makeEntry({ location: 'Room 1', status: 'confirmed' });
        const changed = makeEntry({ location: 'Room 1', status: 'confirmed', ...overrides });
        expect(agendaFingerprint(base)).not.toBe(agendaFingerprint(changed));
    });

    test('floating 09:00 and timed 09:00Z have distinct fingerprints even in UTC', () => {
        const floating = makeEntry({ time: { kind: 'floating', start: createLocalDateTime('2026-03-08T09:00:00'), end: createLocalDateTime('2026-03-08T10:00:00') } });
        const timed = makeEntry({ time: { kind: 'timed', start: new Date('2026-03-08T09:00:00Z'), end: new Date('2026-03-08T10:00:00Z') } });
        expect(agendaFingerprint(floating)).not.toBe(agendaFingerprint(timed));
        expect(agendaFingerprint(floating)).toContain('floating');
        expect(agendaFingerprint(timed)).toContain('timed');
    });

    test('date endExclusive and timed source zone each change the fingerprint', () => {
        const date = makeEntry({ time: { kind: 'all_day', start: createLocalDate('2026-03-08'), endExclusive: createLocalDate('2026-03-09') } });
        const extended = makeEntry({ time: { kind: 'all_day', start: createLocalDate('2026-03-08'), endExclusive: createLocalDate('2026-03-10') } });
        expect(agendaFingerprint(date)).not.toBe(agendaFingerprint(extended));
        const utc = makeEntry({ time: { kind: 'timed', start: new Date('2026-03-08T17:00:00Z'), end: new Date('2026-03-08T18:00:00Z'), timezone: 'Etc/UTC' } });
        const pacific = makeEntry({ time: { kind: 'timed', start: new Date('2026-03-08T17:00:00Z'), end: new Date('2026-03-08T18:00:00Z'), timezone: 'America/Los_Angeles' } });
        expect(agendaFingerprint(utc)).not.toBe(agendaFingerprint(pacific));
    });

    test('an all-day fingerprint serializes the variant and both dates exactly', () => {
        const entry = makeEntry({ isAllDay: true, location: 'Room 1', status: 'confirmed' });
        expect(agendaFingerprint(entry)).toBe('{"time":{"kind":"all_day","start":"2026-03-08","endExclusive":"2026-03-09"},"summary":"Meeting","location":"Room 1","status":"confirmed"}');
    });

    test('a floating fingerprint serializes the variant and both wall-clock times exactly', () => {
        const entry = makeEntry({ time: { kind: 'floating', start: createLocalDateTime('2026-03-08T09:00:00'), end: createLocalDateTime('2026-03-08T10:00:00') } });
        expect(agendaFingerprint(entry)).toBe('{"time":{"kind":"floating","start":"2026-03-08T09:00:00","end":"2026-03-08T10:00:00"},"summary":"Meeting"}');
    });

    test('a timed fingerprint serializes ISO instants and the source timezone exactly', () => {
        const entry = makeEntry({ time: { kind: 'timed', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z'), timezone: 'America/New_York' } });
        expect(agendaFingerprint(entry)).toBe('{"time":{"kind":"timed","start":"2026-03-08T17:00:00.000Z","end":"2026-03-08T18:00:00.000Z","timezone":"America/New_York"},"summary":"Meeting"}');
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

    // Each delta list preserves the order of the list it was derived from -- `current` for
    // added/changed, `baseline` for removed -- which is the day-ordered order `toAgenda`
    // produced. Callers render these lists in order (`formatCalendarContext`), so reversing
    // them is visible output, not an incidental implementation detail.
    test('added preserves the current agenda order across multiple new entries', () => {
        const result = diffAgenda([], [makeEntry({ uid: 'uid-a' }), makeEntry({ uid: 'uid-b' }), makeEntry({ uid: 'uid-c' })]);

        expect(result.added.map(entry => entry.uid)).toEqual(['uid-a', 'uid-b', 'uid-c']);
    });

    test('changed preserves the current agenda order across multiple changed entries', () => {
        const baseline = [makeEntry({ uid: 'uid-a', summary: 'Old A' }), makeEntry({ uid: 'uid-b', summary: 'Old B' })];
        const current  = [makeEntry({ uid: 'uid-a', summary: 'New A' }), makeEntry({ uid: 'uid-b', summary: 'New B' })];

        const result = diffAgenda(baseline, current);

        expect(result.changed.map(entry => entry.uid)).toEqual(['uid-a', 'uid-b']);
    });

    test('removed preserves the baseline agenda order across multiple removed entries', () => {
        const result = diffAgenda([makeEntry({ uid: 'uid-a' }), makeEntry({ uid: 'uid-b' })], []);

        expect(result.removed.map(entry => entry.uid)).toEqual(['uid-a', 'uid-b']);
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
        expect(toAgenda([event], window, 'America/Los_Angeles')).toEqual([]);
    });

    test('drops an event entirely after the window', () => {
        const event = makeEvent({ start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toEqual([]);
    });

    test('keeps an event straddling the start of the window', () => {
        const event = makeEvent({ start: new Date('2026-03-08T07:00:00.000Z'), end: new Date('2026-03-08T09:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toHaveLength(1);
    });

    test('keeps an event straddling the end of the window (straddling midnight)', () => {
        const event = makeEvent({ start: new Date('2026-03-09T07:00:00.000Z'), end: new Date('2026-03-09T09:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toHaveLength(1);
    });

    test('keeps an event fully inside the window', () => {
        const event = makeEvent({ start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toHaveLength(1);
    });

    test('keeps an event ending exactly at window.startMs (inclusive lower boundary)', () => {
        const event = makeEvent({ start: new Date('2026-03-08T07:00:00.000Z'), end: new Date(window.startMs) });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toHaveLength(1);
    });

    test('drops an event ending one millisecond before window.startMs', () => {
        const event = makeEvent({ start: new Date('2026-03-08T06:00:00.000Z'), end: new Date(window.startMs - 1) });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toEqual([]);
    });

    test('keeps an event starting exactly at window.endMs (inclusive upper boundary)', () => {
        const event = makeEvent({ start: new Date(window.endMs), end: new Date('2026-03-09T09:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toHaveLength(1);
    });

    test('drops an event starting one millisecond after window.endMs', () => {
        const event = makeEvent({ start: new Date(window.endMs + 1), end: new Date('2026-03-09T10:00:00.000Z') });
        expect(toAgenda([event], window, 'America/Los_Angeles')).toEqual([]);
    });

    test('maps CalendarEvent fields onto AgendaEntry, keeping the timed variant', () => {
        const event = makeEvent({
            uid:          'uid-9',
            recurrenceId: '2026-03-08',
            summary:      'Standup',
            location:     'Room 3',
            status:       'tentative',
            start:        new Date('2026-03-08T17:00:00.000Z'),
            end:          new Date('2026-03-08T17:30:00.000Z'),
        });

        expect(toAgenda([event], window, 'America/Los_Angeles')).toEqual([{
            uid:          'uid-9',
            recurrenceId: '2026-03-08',
            time:         { kind: 'timed', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') },
            summary:      'Standup',
            location:     'Room 3',
            status:       'tentative',
        }]);
    });

    test('timed agenda projection does not share mutable Date endpoints with cached events', () => {
        const event = makeEvent();
        const entry = toAgenda([event], window, 'America/Los_Angeles')[0];
        if(event.time.kind !== 'timed' || entry.time.kind !== 'timed') {
            throw new Error('Expected timed fixtures');
        }
        const original = agendaFingerprint(entry);
        event.time.start.setTime(0);
        event.time.end.setTime(0);
        expect(agendaFingerprint(entry)).toBe(original);
        expect(entry.time.start.getTime()).toBe(new Date('2026-03-08T17:00:00.000Z').getTime());
    });

    test('sorts by start time, then by agendaKey for same-start ties', () => {
        const later  = makeEvent({ uid: 'uid-b', start: new Date('2026-03-08T18:00:00.000Z'), end: new Date('2026-03-08T19:00:00.000Z') });
        const tieA   = makeEvent({ uid: 'uid-a', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') });
        const tieB   = makeEvent({ uid: 'uid-b-tie', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') });

        const result = toAgenda([later, tieB, tieA], window, 'America/Los_Angeles');

        expect(result.map(entry => entry.uid)).toEqual(['uid-a', 'uid-b-tie', 'uid-b']);
    });

    test('sorts by display day, then all-day first, then resolved start, then agendaKey', () => {
        const allDay = (uid: string, start: string, endExclusive: string): CalendarEvent => makeEvent({ uid, time: { kind: 'all_day', start: createLocalDate(start), endExclusive: createLocalDate(endExclusive) } });
        const events = [
            makeEvent({ uid: 'timed-0900', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T17:30:00.000Z') }),
            makeEvent({ uid: 'floating-0830', time: { kind: 'floating', start: createLocalDateTime('2026-03-08T08:30:00'), end: createLocalDateTime('2026-03-08T08:45:00') } }),
            allDay('all-day-b', '2026-03-08', '2026-03-09'),
            makeEvent({ uid: 'floating-0930', time: { kind: 'floating', start: createLocalDateTime('2026-03-08T09:30:00'), end: createLocalDateTime('2026-03-08T09:45:00') } }),
            allDay('all-day-a', '2026-03-08', '2026-03-09'),
            allDay('multi-day', '2026-03-07', '2026-03-10'),
        ];

        const result = toAgenda(events, window, 'America/Los_Angeles');

        expect(result.map(entry => entry.uid)).toEqual(['multi-day', 'all-day-a', 'all-day-b', 'floating-0830', 'timed-0900', 'floating-0930']);
        expect(result[1]).toEqual({ uid: 'all-day-a', recurrenceId: undefined, time: events[4].time, summary: 'Meeting', location: undefined, status: undefined });
    });

    test('a floating entry moves with the display zone while a timed entry keeps its instant', () => {
        const tokyoWindow = dayWindow(new Date('2026-03-08T03:00:00.000Z').getTime(), 'Asia/Tokyo');
        const events = [
            makeEvent({ uid: 'timed-0000z', start: new Date('2026-03-08T00:00:00.000Z'), end: new Date('2026-03-08T00:30:00.000Z') }),
            makeEvent({ uid: 'floating-0830', time: { kind: 'floating', start: createLocalDateTime('2026-03-08T08:30:00'), end: createLocalDateTime('2026-03-08T08:45:00') } }),
        ];

        // In Tokyo the timed event is 09:00 JST, after the floating 08:30.
        expect(toAgenda(events, tokyoWindow, 'Asia/Tokyo').map(entry => entry.uid)).toEqual(['floating-0830', 'timed-0000z']);
    });

    test('returns [] for an empty events array', () => {
        expect(toAgenda([], window, 'America/Los_Angeles')).toEqual([]);
    });
});

describe('eventsInWindow', () => {
    const window = { startMs: new Date('2026-03-08T08:00:00.000Z').getTime(), endMs: new Date('2026-03-09T07:59:59.999Z').getTime() };

    test('keeps only events overlapping the window, as the raw CalendarEvent (not an AgendaEntry projection)', () => {
        const inside  = makeEvent({ uid: 'inside', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        const outside = makeEvent({ uid: 'outside', start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });

        expect(eventsInWindow([inside, outside], window, 'America/Los_Angeles')).toEqual([inside]);
    });

    test('all-day March 1 exclusive end overlaps March 1 but not March 2', () => {
        const event = makeEvent({ time: { kind: 'all_day', start: createLocalDate('2026-03-01'), endExclusive: createLocalDate('2026-03-02') } });
        const march1 = dayWindow(new Date('2026-03-01T18:00:00Z').getTime(), 'America/Los_Angeles');
        const march2 = dayWindow(new Date('2026-03-02T18:00:00Z').getTime(), 'America/Los_Angeles');
        expect(eventsInWindow([event], march1, 'America/Los_Angeles')).toEqual([event]);
        expect(eventsInWindow([event], march2, 'America/Los_Angeles')).toEqual([]);
    });

    test('all-day dates starting after the window day are dropped and a multi-day span covering it is kept', () => {
        const march1 = dayWindow(new Date('2026-03-01T18:00:00Z').getTime(), 'America/Los_Angeles');
        const tomorrow = makeEvent({ uid: 'tomorrow', time: { kind: 'all_day', start: createLocalDate('2026-03-02'), endExclusive: createLocalDate('2026-03-03') } });
        const spanning = makeEvent({ uid: 'spanning', time: { kind: 'all_day', start: createLocalDate('2026-02-27'), endExclusive: createLocalDate('2026-03-04') } });
        expect(eventsInWindow([tomorrow, spanning], march1, 'America/Los_Angeles')).toEqual([spanning]);
    });

    test('all-day window dates come from the display zone, not UTC', () => {
        // 2026-03-01T20:00Z is already March 2 in Tokyo.
        const tokyoDay = dayWindow(new Date('2026-03-01T20:00:00Z').getTime(), 'Asia/Tokyo');
        const march1 = makeEvent({ uid: 'march-1', time: { kind: 'all_day', start: createLocalDate('2026-03-01'), endExclusive: createLocalDate('2026-03-02') } });
        const march2 = makeEvent({ uid: 'march-2', time: { kind: 'all_day', start: createLocalDate('2026-03-02'), endExclusive: createLocalDate('2026-03-03') } });
        expect(eventsInWindow([march1, march2], tokyoDay, 'Asia/Tokyo')).toEqual([march2]);
    });

    test('floating 09:00 resolves within the requested display-zone day, not UTC midnight', () => {
        const event = makeEvent({ time: { kind: 'floating', start: createLocalDateTime('2026-03-01T09:00:00'), end: createLocalDateTime('2026-03-01T09:30:00') } });
        const laWindow = dayWindow(new Date('2026-03-01T18:00:00Z').getTime(), 'America/Los_Angeles');
        expect(eventsInWindow([event], laWindow, 'America/Los_Angeles')).toEqual([event]);
        const instantWindow = { startMs: new Date('2026-03-01T17:15:00Z').getTime(), endMs: new Date('2026-03-01T17:20:00Z').getTime() };
        expect(eventsInWindow([event], instantWindow, 'UTC')).toEqual([]);
        expect(eventsInWindow([event], instantWindow, 'America/Los_Angeles')).toEqual([event]);
    });

    test('returns [] for an empty events array', () => {
        expect(eventsInWindow([], window, 'America/Los_Angeles')).toEqual([]);
    });

    test('toAgenda\'s output is exactly eventsInWindow\'s survivors, mapped to AgendaEntry', () => {
        const inside  = makeEvent({ uid: 'inside', start: new Date('2026-03-08T17:00:00.000Z'), end: new Date('2026-03-08T18:00:00.000Z') });
        const outside = makeEvent({ uid: 'outside', start: new Date('2026-03-09T09:00:00.000Z'), end: new Date('2026-03-09T10:00:00.000Z') });

        expect(toAgenda([inside, outside], window, 'America/Los_Angeles').map(entry => entry.uid)).toEqual(eventsInWindow([inside, outside], window, 'America/Los_Angeles').map(event => event.uid));
    });
});
