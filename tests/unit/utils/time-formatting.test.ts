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

        test('should return "4 weeks ago" for 28 days (just before month boundary)', () => {
            // 28 days = 4 weeks, just before the 30-day month boundary
            const date = new Date('2024-12-18T12:00:00.000Z'); // 28 days before Jan 15
            expect(formatRelativeTime(date, baseDate)).toBe('4 weeks ago');
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

        test('should return "11 months ago" for 11 calendar months', () => {
            // 11 calendar months before Jan 15, 2025 = Feb 15, 2024
            const date = new Date('2024-02-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('11 months ago');
        });
    });

    describe('years (1+ years)', () => {
        test('should return "1 year ago" for 1 calendar year', () => {
            // 1 calendar year before Jan 15, 2025 = Jan 15, 2024
            const date = new Date('2024-01-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 year ago');
        });

        test('should return "2 years ago" for 2 calendar years', () => {
            // 2 calendar years before Jan 15, 2025 = Jan 15, 2023
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

        test('should return "4w ago" for 28 days (just before month boundary)', () => {
            // 28 days = 4 weeks, just before the 30-day month boundary
            const date = new Date('2024-12-18T12:00:00.000Z'); // 28 days before Jan 15
            expect(formatShortRelativeTime(date, baseDate)).toBe('4w ago');
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

        test('should return "11mo ago" for 11 calendar months', () => {
            // 11 calendar months before Jan 15, 2025 = Feb 15, 2024
            const date = new Date('2024-02-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('11mo ago');
        });
    });

    describe('years', () => {
        test('should return "1y ago" for 1 calendar year', () => {
            // 1 calendar year before Jan 15, 2025 = Jan 15, 2024
            const date = new Date('2024-01-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1y ago');
        });

        test('should return "2y ago" for 2 calendar years', () => {
            // 2 calendar years before Jan 15, 2025 = Jan 15, 2023
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
