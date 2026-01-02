import { describe, test, expect } from 'bun:test';
import {
    formatRelativeTime,
    formatMemoryTimestamp,
    formatShortRelativeTime
} from '@/utils/time';

describe.concurrent('formatRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    describe('just now (< 1 minute)', () => {
        test('should return "just now" for same time', () => {
            const result = formatRelativeTime(baseDate, baseDate);
            expect(result).toBe('just now');
        });

        test('should return "just now" for 30 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:30.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('just now');
        });

        test('should return "just now" for 59 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:01.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('just now');
        });
    });

    describe('minutes (1-59 minutes)', () => {
        test('should return "1 minute ago" for exactly 1 minute', () => {
            const date = new Date('2025-01-15T11:59:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 minute ago');
        });

        test('should return "2 minutes ago" for 2 minutes', () => {
            const date = new Date('2025-01-15T11:58:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 minutes ago');
        });

        test('should return "59 minutes ago" for 59 minutes', () => {
            const date = new Date('2025-01-15T11:01:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('59 minutes ago');
        });
    });

    describe('hours (1-23 hours)', () => {
        test('should return "1 hour ago" for exactly 1 hour', () => {
            const date = new Date('2025-01-15T11:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 hour ago');
        });

        test('should return "2 hours ago" for 2 hours', () => {
            const date = new Date('2025-01-15T10:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 hours ago');
        });

        test('should return "23 hours ago" for 23 hours', () => {
            const date = new Date('2025-01-14T13:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('23 hours ago');
        });
    });

    describe('days (1-6 days)', () => {
        test('should return "1 day ago" for exactly 1 day', () => {
            const date = new Date('2025-01-14T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 day ago');
        });

        test('should return "2 days ago" for 2 days', () => {
            const date = new Date('2025-01-13T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 days ago');
        });

        test('should return "6 days ago" for 6 days', () => {
            const date = new Date('2025-01-09T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('6 days ago');
        });
    });

    describe('weeks (1-4 weeks)', () => {
        test('should return "1 week ago" for exactly 7 days', () => {
            const date = new Date('2025-01-08T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 week ago');
        });

        test('should return "2 weeks ago" for 14 days', () => {
            const date = new Date('2025-01-01T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 weeks ago');
        });

        test('should return "3 weeks ago" for 21 days', () => {
            const date = new Date('2024-12-25T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('3 weeks ago');
        });

        test('should return "4 weeks ago" at exactly 30 days (MS_PER_MONTH boundary)', () => {
            // At exactly MS_PER_MONTH, the condition `diffMs < MS_PER_MONTH` is false
            // so it falls through to the months calculation, but 30 days / 7 days = 4 weeks
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_MONTH = 30 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_MONTH);
            expect(formatRelativeTime(date, baseDate)).toBe('1 month ago');
        });
    });

    describe('months (1-11 months)', () => {
        test('should return "1 month ago" for ~30 days', () => {
            const date = new Date('2024-12-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 month ago');
        });

        test('should return "2 months ago" for ~60 days', () => {
            const date = new Date('2024-11-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 months ago');
        });

        test('should return "11 months ago" for ~330 days', () => {
            const date = new Date('2024-02-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('11 months ago');
        });

        test('should return "12 months ago" at exactly 360 days (boundary before 1 year)', () => {
            // 360 days = 12 months (30 days each), just before 365 days
            const date = new Date(baseDate.getTime() - 360 * 24 * 60 * 60 * 1000);
            expect(formatRelativeTime(date, baseDate)).toBe('12 months ago');
        });
    });

    describe('years (1+ years)', () => {
        test('should return "1 year ago" at exactly 365 days (MS_PER_YEAR boundary)', () => {
            // At exactly MS_PER_YEAR, the condition `diffMs < MS_PER_YEAR` is false
            // so it falls through to the years calculation: 365 / 365 = 1 year
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_YEAR = 365 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_YEAR);
            expect(formatRelativeTime(date, baseDate)).toBe('1 year ago');
        });

        test('should return "2 years ago" for 2 years', () => {
            const date = new Date('2023-01-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 years ago');
        });
    });

    describe('default now parameter', () => {
        test('should use current time when now is not provided', () => {
            const recentDate = new Date(Date.now() - 30000); // 30 seconds ago
            expect(formatRelativeTime(recentDate)).toBe('just now');
        });
    });
});

describe('formatMemoryTimestamp', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    test('should format timestamp with relative time and ISO string', () => {
        const updatedAt = '2025-01-13T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 days ago, 2025-01-13T10:00:00.000Z)');
    });

    test('should format just now timestamp', () => {
        const updatedAt = '2025-01-15T11:59:30.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(just now, 2025-01-15T11:59:30.000Z)');
    });

    test('should format hours ago timestamp', () => {
        const updatedAt = '2025-01-15T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 hours ago, 2025-01-15T10:00:00.000Z)');
    });

    test('should format weeks ago timestamp', () => {
        const updatedAt = '2025-01-01T12:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 weeks ago, 2025-01-01T12:00:00.000Z)');
    });

    test('should use current time when now is not provided', () => {
        const recentDate = new Date(Date.now() - 30000).toISOString(); // 30 seconds ago
        const result = formatMemoryTimestamp(recentDate);
        expect(result).toMatch(/^\(just now, /);
    });
});

describe('formatShortRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    describe('just now (< 1 minute)', () => {
        test('should return "now" for same time', () => {
            expect(formatShortRelativeTime(baseDate, baseDate)).toBe('now');
        });

        test('should return "now" for 30 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:30.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('now');
        });
    });

    describe('minutes', () => {
        test('should return "1m ago" for 1 minute', () => {
            const date = new Date('2025-01-15T11:59:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1m ago');
        });

        test('should return "30m ago" for 30 minutes', () => {
            const date = new Date('2025-01-15T11:30:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('30m ago');
        });
    });

    describe('hours', () => {
        test('should return "1h ago" for 1 hour', () => {
            const date = new Date('2025-01-15T11:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1h ago');
        });

        test('should return "12h ago" for 12 hours', () => {
            const date = new Date('2025-01-15T00:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('12h ago');
        });
    });

    describe('days', () => {
        test('should return "1d ago" for 1 day', () => {
            const date = new Date('2025-01-14T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1d ago');
        });

        test('should return "5d ago" for 5 days', () => {
            const date = new Date('2025-01-10T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('5d ago');
        });
    });

    describe('weeks', () => {
        test('should return "1w ago" for 7 days', () => {
            const date = new Date('2025-01-08T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1w ago');
        });

        test('should return "3w ago" for 21 days', () => {
            const date = new Date('2024-12-25T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('3w ago');
        });

        test('should return "4w ago" at exactly 30 days (MS_PER_MONTH boundary)', () => {
            // At exactly MS_PER_MONTH, the condition `diffMs < MS_PER_MONTH` is false
            // so it falls through to the months calculation: 30 / 30 = 1 month
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_MONTH = 30 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_MONTH);
            expect(formatShortRelativeTime(date, baseDate)).toBe('1mo ago');
        });
    });

    describe('months', () => {
        test('should return "1mo ago" for ~30 days', () => {
            const date = new Date('2024-12-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1mo ago');
        });

        test('should return "6mo ago" for ~180 days', () => {
            const date = new Date('2024-07-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('6mo ago');
        });

        test('should return "12mo ago" at exactly 360 days (boundary before 1 year)', () => {
            // 360 days = 12 months (30 days each), just before 365 days
            const date = new Date(baseDate.getTime() - 360 * 24 * 60 * 60 * 1000);
            expect(formatShortRelativeTime(date, baseDate)).toBe('12mo ago');
        });
    });

    describe('years', () => {
        test('should return "1y ago" at exactly 365 days (MS_PER_YEAR boundary)', () => {
            // At exactly MS_PER_YEAR, the condition `diffMs < MS_PER_YEAR` is false
            // so it falls through to the years calculation: 365 / 365 = 1 year
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_YEAR = 365 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_YEAR);
            expect(formatShortRelativeTime(date, baseDate)).toBe('1y ago');
        });

        test('should return "2y ago" for 2 years', () => {
            const date = new Date('2023-01-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('2y ago');
        });
    });

    describe('default now parameter', () => {
        test('should use current time when now is not provided', () => {
            const recentDate = new Date(Date.now() - 30000); // 30 seconds ago
            expect(formatShortRelativeTime(recentDate)).toBe('now');
        });
    });
});
