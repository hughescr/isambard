import { afterEach, describe, expect, jest, test } from 'bun:test';
import { DateTime, Zone } from 'luxon';
import { calendarSortKey, dayOrderMs, displayDay, resolveFloating, resolveToInstant } from '@/integrations/caldav/time-range';
import { createLocalDate, createLocalDateTime, type CalendarTimeRange } from '@/integrations/caldav/types';

const LA = 'America/Los_Angeles';

const SPRING_FORWARD_MS = Date.parse('2026-03-08T10:00:00.000Z'); // 02:00 PST -> 03:00 PDT
const FALL_BACK_MS = Date.parse('2026-11-01T09:00:00.000Z');      // 02:00 PDT -> 01:00 PST

/**
 * tests/setup.ts mocks Intl.DateTimeFormat with fixed, DST-free offsets, so IANA zones have no DST
 * in unit tests. This hand-built Luxon zone carries 2026's US Pacific transitions instead.
 */
class PacificDstZone extends Zone {
    override get type(): string {
        return 'test-pacific-dst';
    }

    override get name(): string {
        return 'Test/Pacific';
    }

    override get isUniversal(): boolean {
        return false;
    }

    override get isValid(): boolean {
        return true;
    }

    override offsetName(): string {
        return 'TPT';
    }

    override formatOffset(): string {
        return '';
    }

    override offset(ts: number): number {
        return ts >= SPRING_FORWARD_MS && ts < FALL_BACK_MS ? -420 : -480;
    }

    override equals(other: Zone): boolean {
        return other === this;
    }
}

// resolveFloating takes a zone name; Luxon also accepts a Zone instance wherever it takes one.
const DST_ZONE = new PacificDstZone() as unknown as string;

const allDay: CalendarTimeRange = { kind: 'all_day', start: createLocalDate('2026-03-01'), endExclusive: createLocalDate('2026-03-02') };
const floating: CalendarTimeRange = { kind: 'floating', start: createLocalDateTime('2026-03-01T09:00:00'), end: createLocalDateTime('2026-03-01T10:30:00') };
const timed: CalendarTimeRange = { kind: 'timed', start: new Date('2026-03-01T05:00:00.000Z'), end: new Date('2026-03-01T06:00:00.000Z'), timezone: 'Europe/London' };

describe.concurrent('resolveFloating', () => {
    test('resolveFloating reads a floating wall-clock time in the display zone', () => {
        expect(resolveFloating(createLocalDateTime('2026-03-01T09:00:00'), LA).toUTC().toISO()).toBe('2026-03-01T17:00:00.000Z');
        expect(resolveFloating(createLocalDateTime('2026-03-01T09:00:00'), 'Asia/Tokyo').toUTC().toISO()).toBe('2026-03-01T00:00:00.000Z');
    });

    test('resolveFloating resolves a repeated fall-back wall time to the earlier instant', () => {
        expect(resolveFloating(createLocalDateTime('2026-11-01T01:30:00'), DST_ZONE).toUTC().toISO()).toBe('2026-11-01T08:30:00.000Z');
        expect(resolveFloating(createLocalDateTime('2026-11-01T02:30:00'), DST_ZONE).toUTC().toISO()).toBe('2026-11-01T10:30:00.000Z');
    });

    test('resolveFloating shifts a spring-forward gap wall time forward by the gap', () => {
        expect(resolveFloating(createLocalDateTime('2026-03-08T02:30:00'), DST_ZONE).toUTC().toISO()).toBe('2026-03-08T10:30:00.000Z');
        expect(resolveFloating(createLocalDateTime('2026-03-08T01:30:00'), DST_ZONE).toUTC().toISO()).toBe('2026-03-08T09:30:00.000Z');
    });

    test('resolveFloating rejects an unknown display zone by name', () => {
        expect(() => resolveFloating(createLocalDateTime('2026-03-01T09:00:00'), 'Not/AZone')).toThrow(new RangeError('Invalid calendar display zone: Not/AZone'));
    });
});

describe('resolveFloating clock independence', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('resolveFloating picks the earlier repeated instant even when the current date is in standard time', () => {
        // Luxon's own guess for an ambiguous wall time starts from the zone's offset at the current date.
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-12-15T12:00:00.000Z'));
        expect(DateTime.fromISO('2026-11-01T01:30:00', { zone: DST_ZONE }).toUTC().toISO()).toBe('2026-11-01T09:30:00.000Z');
        expect(resolveFloating(createLocalDateTime('2026-11-01T01:30:00'), DST_ZONE).toUTC().toISO()).toBe('2026-11-01T08:30:00.000Z');
    });
});

describe.concurrent('resolveToInstant', () => {
    test('resolveToInstant resolves both floating endpoints in the display zone', () => {
        expect(resolveToInstant(floating, LA)).toEqual({
            startMs: Date.parse('2026-03-01T17:00:00.000Z'),
            endMs:   Date.parse('2026-03-01T18:30:00.000Z'),
        });
    });

    test('resolveToInstant keeps timed endpoints as instants whatever the display zone', () => {
        const expected = { startMs: Date.parse('2026-03-01T05:00:00.000Z'), endMs: Date.parse('2026-03-01T06:00:00.000Z') };
        expect(resolveToInstant(timed, LA)).toEqual(expected);
        expect(resolveToInstant(timed, 'Asia/Tokyo')).toEqual(expected);
    });
});

describe.concurrent('displayDay', () => {
    test('displayDay keeps an all-day date on its own date either side of UTC', () => {
        expect(displayDay(allDay, LA)).toBe('2026-03-01');
        expect(displayDay(allDay, 'Asia/Tokyo')).toBe('2026-03-01');
        expect(displayDay(allDay, 'UTC')).toBe('2026-03-01');
    });

    test('displayDay uses a floating range its own local date in any zone', () => {
        const lateFloating: CalendarTimeRange = { kind: 'floating', start: createLocalDateTime('2026-03-01T23:30:00'), end: createLocalDateTime('2026-03-01T23:45:00') };
        expect(displayDay(lateFloating, 'Asia/Tokyo')).toBe('2026-03-01');
        expect(displayDay(lateFloating, LA)).toBe('2026-03-01');
    });

    test('displayDay converts a timed start into the display zone date', () => {
        expect(displayDay(timed, LA)).toBe('2026-02-28');
        expect(displayDay(timed, 'UTC')).toBe('2026-03-01');
    });
});

describe.concurrent('dayOrderMs', () => {
    test('dayOrderMs places an all-day range ahead of every instant', () => {
        expect(dayOrderMs(allDay, LA)).toBe(Number.MIN_SAFE_INTEGER);
    });

    test('dayOrderMs orders floating by display-zone start and timed by instant', () => {
        expect(dayOrderMs(floating, LA)).toBe(Date.parse('2026-03-01T17:00:00.000Z'));
        expect(dayOrderMs(timed, LA)).toBe(Date.parse('2026-03-01T05:00:00.000Z'));
    });
});

describe.concurrent('calendarSortKey', () => {
    test('calendarSortKey encodes date, variant rank and time of day per variant', () => {
        expect(calendarSortKey(allDay)).toBe('2026-03-01|0|');
        expect(calendarSortKey(floating)).toBe('2026-03-01|1|09:00:00');
        expect(calendarSortKey(timed)).toBe('2026-03-01|2|05:00:00.000Z');
    });

    test('calendarSortKey gives a transitive zone-independent order over mixed variants', () => {
        const earlyTimed: CalendarTimeRange = { kind: 'timed', start: new Date('2026-02-28T23:00:00.000Z'), end: new Date('2026-02-28T23:30:00.000Z') };
        const keys = [calendarSortKey(timed), calendarSortKey(floating), calendarSortKey(earlyTimed), calendarSortKey(allDay)];
        expect(keys.toSorted((a, b) => a.localeCompare(b))).toEqual([
            '2026-02-28|2|23:00:00.000Z',
            '2026-03-01|0|',
            '2026-03-01|1|09:00:00',
            '2026-03-01|2|05:00:00.000Z',
        ]);
    });
});
