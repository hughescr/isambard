import { describe, test, expect, spyOn, afterEach, jest } from 'bun:test';
import {
    formatRelativeTime,
    formatMemoryTimestamp,
    formatShortRelativeTime,
    formatEnvelopeStamp
} from '@/utils/time';

describe.concurrent('formatRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    test.each([
        ['same time', baseDate, 'just now'],
        ['59 seconds ago', new Date('2025-01-15T11:59:01.000Z'), 'just now']
    ])('should return "%s" for %s', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-15T11:59:00.000Z'), '1 minute ago'],
        [59, new Date('2025-01-15T11:01:00.000Z'), '59 minutes ago']
    ])('should return "%d minutes ago" for %d minutes', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-15T11:00:00.000Z'), '1 hour ago'],
        [23, new Date('2025-01-14T13:00:00.000Z'), '23 hours ago']
    ])('should return "%d hours ago" for %d hours', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-14T12:00:00.000Z'), '1 day ago'],
        [6, new Date('2025-01-09T12:00:00.000Z'), '6 days ago']
    ])('should return "%d days ago" for %d days', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-08T12:00:00.000Z'), '1 week ago'],
        [4, new Date('2024-12-18T12:00:00.000Z'), '4 weeks ago']
    ])('should return "%d weeks ago" for %d weeks', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test('should transition from weeks to months at 5 weeks (35 days)', () => {
        // 35 days = 5 weeks = WEEKS_THRESHOLD, should transition to months
        const date = new Date('2024-12-11T12:00:00.000Z');
        expect(formatRelativeTime(date, baseDate)).toBe('1 month ago');
    });

    test.each([
        [1, new Date('2024-12-15T12:00:00.000Z'), '1 month ago'],
        [11, new Date('2024-02-15T12:00:00.000Z'), '11 months ago']
    ])('should return "%d months ago" for %d months', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2024-01-15T12:00:00.000Z'), '1 year ago'],
        [2, new Date('2023-01-15T12:00:00.000Z'), '2 years ago']
    ])('should return "%d years ago" for %d years', (_, date, expected) => {
        expect(formatRelativeTime(date, baseDate)).toBe(expected);
    });

    test('should use current time when now is not provided', () => {
        const recentDate = new Date(Date.now() - 30_000);
        expect(formatRelativeTime(recentDate)).toBe('just now');
    });
});

describe('formatMemoryTimestamp', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    test('should format timestamp with relative time and ISO string', () => {
        const updatedAt = '2025-01-13T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 days ago, 2025-01-13T10:00:00.000Z)');
    });

    test('should use current time when now is not provided', () => {
        const recentDate = new Date(Date.now() - 30_000).toISOString();
        const result = formatMemoryTimestamp(recentDate);
        expect(result).toMatch(/^\(just now, /);
    });

    test('should format with local + UTC when timezone is provided', () => {
        const updatedAt = '2025-01-13T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate, 'America/Los_Angeles');
        expect(result).toBe('(2 days ago, 2025-01-13T02:00:00 America/Los_Angeles | UTC: 2025-01-13T10:00:00.000Z)');
    });

    test('should show correct local time for different timezones', () => {
        const updatedAt = '2025-01-13T14:30:45.000Z';

        // UTC+9 (Tokyo)
        const tokyoResult = formatMemoryTimestamp(updatedAt, baseDate, 'Asia/Tokyo');
        expect(tokyoResult).toBe('(1 day ago, 2025-01-13T23:30:45 Asia/Tokyo | UTC: 2025-01-13T14:30:45.000Z)');

        // UTC+0 (London)
        const londonResult = formatMemoryTimestamp(updatedAt, baseDate, 'Europe/London');
        expect(londonResult).toBe('(1 day ago, 2025-01-13T14:30:45 Europe/London | UTC: 2025-01-13T14:30:45.000Z)');
    });
});

describe('formatShortRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    test.each([
        ['same time', baseDate, 'now'],
        ['30 seconds ago', new Date('2025-01-15T11:59:30.000Z'), 'now']
    ])('should return "now" for %s', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-15T11:59:00.000Z'), '1m ago'],
        [30, new Date('2025-01-15T11:30:00.000Z'), '30m ago']
    ])('should return "%dm ago" for %d minutes', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-15T11:00:00.000Z'), '1h ago'],
        [12, new Date('2025-01-15T00:00:00.000Z'), '12h ago']
    ])('should return "%dh ago" for %d hours', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-14T12:00:00.000Z'), '1d ago'],
        [5, new Date('2025-01-10T12:00:00.000Z'), '5d ago']
    ])('should return "%dd ago" for %d days', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2025-01-08T12:00:00.000Z'), '1w ago'],
        [4, new Date('2024-12-18T12:00:00.000Z'), '4w ago']
    ])('should return "%dw ago" for %d weeks', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test('should transition from weeks to months at 5 weeks (35 days)', () => {
        // 35 days = 5 weeks = WEEKS_THRESHOLD, should transition to months
        const date = new Date('2024-12-11T12:00:00.000Z');
        expect(formatShortRelativeTime(date, baseDate)).toBe('1mo ago');
    });

    test.each([
        [1, new Date('2024-12-15T12:00:00.000Z'), '1mo ago'],
        [11, new Date('2024-02-15T12:00:00.000Z'), '11mo ago']
    ])('should return "%dmo ago" for %d months', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test.each([
        [1, new Date('2024-01-15T12:00:00.000Z'), '1y ago'],
        [2, new Date('2023-01-15T12:00:00.000Z'), '2y ago']
    ])('should return "%dy ago" for %d years', (_, date, expected) => {
        expect(formatShortRelativeTime(date, baseDate)).toBe(expected);
    });

    test('should use current time when now is not provided', () => {
        const recentDate = new Date(Date.now() - 30_000);
        expect(formatShortRelativeTime(recentDate)).toBe('now');
    });
});

describe.concurrent('formatEnvelopeStamp', () => {
    const now = new Date('2026-09-04T22:07:00Z');

    test('formats Pacific time with the PST/PDT->PT fold', () => {
        expect(formatEnvelopeStamp(now, 'America/Los_Angeles')).toBe('2026-09-04 14:07 PT');
    });

    test('formats Eastern time with the EST/EDT->ET fold', () => {
        expect(formatEnvelopeStamp(now, 'America/New_York')).toBe('2026-09-04 17:07 ET');
    });

    test('passes an unmapped zone abbreviation through verbatim, including a day rollover', () => {
        expect(formatEnvelopeStamp(now, 'Asia/Tokyo')).toBe('2026-09-05 07:07 JST');
    });

    test('passes UTC through verbatim', () => {
        expect(formatEnvelopeStamp(now, 'UTC')).toBe('2026-09-04 22:07 UTC');
    });

    test('rejects an invalid timezone with a RangeError', () => {
        expect(() => formatEnvelopeStamp(now, 'Not/AZone')).toThrow(RangeError);
    });
});

// Not describe.concurrent: this block spies on the process-global Intl.DateTimeFormat.prototype,
// which would race the concurrent block above if they overlapped.
describe('formatEnvelopeStamp — full DST abbreviation fold table', () => {
    const now = new Date('2026-09-04T22:07:00Z');

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // Drives every ENVELOPE_ZONE_ABBREVIATION_FOLD entry directly by faking the short
    // timeZoneName Intl part; the tests/setup.ts Intl mock only ever reports fixed, DST-free
    // abbreviations (PST/EST/...), so PDT/EDT/CST/CDT/MST/MDT are otherwise unreachable.
    test.each([
        ['PDT', 'PT'],
        ['EDT', 'ET'],
        ['CST', 'CT'],
        ['CDT', 'CT'],
        ['MST', 'MT'],
        ['MDT', 'MT']
    ])('folds the %s abbreviation to %s', (rawAbbreviation, foldedLabel) => {
        const original = Intl.DateTimeFormat.prototype.formatToParts;
        spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(function(this: Intl.DateTimeFormat, ...args: Parameters<typeof original>) {
            const { options } = this as unknown as { options: Intl.DateTimeFormatOptions };
            if(options.timeZoneName === 'short') {
                return [{ type: 'timeZoneName', value: rawAbbreviation }] satisfies Intl.DateTimeFormatPart[];
            }
            return original.apply(this, args);
        });

        expect(formatEnvelopeStamp(now, 'UTC')).toBe(`2026-09-04 22:07 ${foldedLabel}`);
    });
});
