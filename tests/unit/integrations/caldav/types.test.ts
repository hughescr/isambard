import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createCalendarTimeRange, createLocalDate, createLocalDateTime, type CalendarTimeRange } from '@/integrations/caldav/types';

describe.concurrent('createLocalDate', () => {
    test('createLocalDate accepts a real calendar date including a leap day', () => {
        expect(String(createLocalDate('2026-03-01'))).toBe('2026-03-01');
        expect(String(createLocalDate('2028-02-29'))).toBe('2028-02-29');
    });

    test('createLocalDate rejects an impossible date with its value in the message', () => {
        expect(() => createLocalDate('2026-02-29')).toThrow(new RangeError('Invalid calendar date: 2026-02-29'));
    });

    test('createLocalDate rejects other shapes than YYYY-MM-DD', () => {
        for(const value of ['2026-3-01', '20260301', '+002026-03-01', '2026-03-01T09:00:00', '']) {
            expect(() => createLocalDate(value)).toThrow(RangeError);
        }
    });

    test('createLocalDate rejects the Luxon Invalid DateTime sentinel that round-trips to itself', () => {
        expect(() => createLocalDate('Invalid DateTime')).toThrow(new RangeError('Invalid calendar date: Invalid DateTime'));
    });
});

describe.concurrent('createLocalDateTime', () => {
    test('createLocalDateTime accepts an offset-free wall-clock time', () => {
        expect(String(createLocalDateTime('2026-03-01T09:00:00'))).toBe('2026-03-01T09:00:00');
    });

    test('createLocalDateTime rejects an impossible time with its value in the message', () => {
        expect(() => createLocalDateTime('2026-03-01T25:00:00')).toThrow(new RangeError('Invalid floating calendar time: 2026-03-01T25:00:00'));
    });

    test('createLocalDateTime rejects offsets, Z, fractions and partial times', () => {
        for(const value of ['2026-03-01T09:00:00Z', '2026-03-01T09:00:00-08:00', '2026-03-01T09:00:00.500', '2026-03-01T09:00', '2026-03-01']) {
            expect(() => createLocalDateTime(value)).toThrow(RangeError);
        }
    });

    test('createLocalDateTime rejects values Luxon parses as valid but that do not round-trip exactly', () => {
        expect(() => createLocalDateTime('2026-03-01T24:00:00')).toThrow(new RangeError('Invalid floating calendar time: 2026-03-01T24:00:00'));
        expect(() => createLocalDateTime('2026-03-01t09:00:00')).toThrow(new RangeError('Invalid floating calendar time: 2026-03-01t09:00:00'));
    });

    test('createLocalDateTime rejects the Luxon Invalid DateTime sentinel that round-trips to itself', () => {
        expect(() => createLocalDateTime('Invalid DateTime')).toThrow(new RangeError('Invalid floating calendar time: Invalid DateTime'));
    });
});

describe('createLocalDateTime under a DST host zone', () => {
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

    test('createLocalDateTime accepts a wall time that falls in the host zone spring-forward gap', () => {
        expect(String(createLocalDateTime('2026-03-08T02:30:00'))).toBe('2026-03-08T02:30:00');
    });
});

describe.concurrent('createCalendarTimeRange', () => {
    test('createCalendarTimeRange builds a one-day all-day range', () => {
        expect(createCalendarTimeRange({ kind: 'all_day', start: '2026-03-01', endExclusive: '2026-03-02' }))
            .toEqual({ kind: 'all_day', start: createLocalDate('2026-03-01'), endExclusive: createLocalDate('2026-03-02') });
    });

    test('createCalendarTimeRange rejects an all-day range that covers no date', () => {
        expect(() => createCalendarTimeRange({ kind: 'all_day', start: '2026-03-02', endExclusive: '2026-03-02' }))
            .toThrow(new RangeError('All-day end 2026-03-02 must be after start 2026-03-02'));
        expect(() => createCalendarTimeRange({ kind: 'all_day', start: '2026-03-02', endExclusive: '2026-03-01' })).toThrow(RangeError);
    });

    test('createCalendarTimeRange validates each all-day endpoint', () => {
        expect(() => createCalendarTimeRange({ kind: 'all_day', start: 'bad', endExclusive: '2026-03-02' })).toThrow('Invalid calendar date: bad');
        expect(() => createCalendarTimeRange({ kind: 'all_day', start: '2026-03-01', endExclusive: 'bad' })).toThrow('Invalid calendar date: bad');
    });

    test('createCalendarTimeRange builds floating ranges including zero duration', () => {
        expect(createCalendarTimeRange({ kind: 'floating', start: '2026-03-01T09:00:00', end: '2026-03-01T10:00:00' }))
            .toEqual({ kind: 'floating', start: createLocalDateTime('2026-03-01T09:00:00'), end: createLocalDateTime('2026-03-01T10:00:00') });
        expect(createCalendarTimeRange({ kind: 'floating', start: '2026-03-01T09:00:00', end: '2026-03-01T09:00:00' }).kind).toBe('floating');
    });

    test('createCalendarTimeRange rejects a floating end before its start', () => {
        expect(() => createCalendarTimeRange({ kind: 'floating', start: '2026-03-01T09:00:00', end: '2026-03-01T08:59:59' }))
            .toThrow(new RangeError('Floating end 2026-03-01T08:59:59 precedes start 2026-03-01T09:00:00'));
    });

    test('createCalendarTimeRange validates each floating endpoint', () => {
        expect(() => createCalendarTimeRange({ kind: 'floating', start: 'bad', end: '2026-03-01T10:00:00' })).toThrow('Invalid floating calendar time: bad');
        expect(() => createCalendarTimeRange({ kind: 'floating', start: '2026-03-01T09:00:00', end: 'bad' })).toThrow('Invalid floating calendar time: bad');
    });

    test('createCalendarTimeRange rejects Invalid DateTime sentinel endpoints for floating and all-day ranges', () => {
        expect(() => createCalendarTimeRange({ kind: 'floating', start: 'Invalid DateTime', end: 'Invalid DateTime' })).toThrow(new RangeError('Invalid floating calendar time: Invalid DateTime'));
        expect(() => createCalendarTimeRange({ kind: 'all_day', start: '2026-03-01', endExclusive: 'Invalid DateTime' })).toThrow(new RangeError('Invalid calendar date: Invalid DateTime'));
    });

    test('createCalendarTimeRange copies timed endpoints and keeps the source timezone', () => {
        const start = new Date('2026-03-01T09:00:00.000Z');
        const end = new Date('2026-03-01T10:00:00.000Z');
        const range = createCalendarTimeRange({ kind: 'timed', start, end, timezone: 'America/New_York' });
        expect(range).toEqual({ kind: 'timed', start, end, timezone: 'America/New_York' });
        const timed = range as Extract<CalendarTimeRange, { kind: 'timed' }>;
        expect(timed.start).not.toBe(start);
        expect(timed.end).not.toBe(end);
    });

    test('createCalendarTimeRange accepts a zero-duration timed range', () => {
        const at = new Date('2026-03-01T09:00:00.000Z');
        expect(createCalendarTimeRange({ kind: 'timed', start: at, end: at })).toEqual({ kind: 'timed', start: at, end: at, timezone: undefined });
    });

    test('createCalendarTimeRange rejects an invalid timed start, an invalid end, and an end before start', () => {
        const valid = new Date('2026-03-01T09:00:00.000Z');
        const invalid = new Date(Number.NaN);
        const message = new RangeError('Invalid timed calendar endpoints');
        expect(() => createCalendarTimeRange({ kind: 'timed', start: invalid, end: valid })).toThrow(message);
        expect(() => createCalendarTimeRange({ kind: 'timed', start: valid, end: invalid })).toThrow(message);
        expect(() => createCalendarTimeRange({ kind: 'timed', start: valid, end: new Date('2026-03-01T08:59:59.999Z') })).toThrow(message);
    });

    test('CalendarTimeRange variants cannot mix date-only and instant endpoints at compile time', () => {
        // @ts-expect-error -- an all-day range has LocalDate endpoints, not Dates
        const allDayWithInstant: CalendarTimeRange = { kind: 'all_day', start: new Date(), endExclusive: createLocalDate('2026-03-02') };
        // @ts-expect-error -- a floating range has no end-exclusive date
        const floatingWithDate: CalendarTimeRange = { kind: 'floating', start: createLocalDateTime('2026-03-01T09:00:00'), endExclusive: createLocalDate('2026-03-02') };
        // @ts-expect-error -- a plain string is not a checked LocalDate
        const uncheckedDate: CalendarTimeRange = { kind: 'all_day', start: '2026-03-01', endExclusive: '2026-03-02' };
        expect([allDayWithInstant.kind, floatingWithDate.kind, uncheckedDate.kind]).toEqual(['all_day', 'floating', 'all_day']);
    });
});
