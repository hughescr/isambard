import { describe, it, expect } from 'bun:test';
import {
    formatRelativeTime,
    getTimeOfDay,
    getDayOfWeek,
    getCurrentTimeContext,
    formatMemoryTimestamp,
    formatShortRelativeTime,
    timeContextSchema,
    timeOfDaySchema,
    dayOfWeekSchema,
    type TimeContext
} from '@/utils/time';

describe('timeOfDaySchema', () => {
    it('should accept "morning"', () => {
        expect(timeOfDaySchema.safeParse('morning').success).toBe(true);
    });

    it('should accept "afternoon"', () => {
        expect(timeOfDaySchema.safeParse('afternoon').success).toBe(true);
    });

    it('should accept "evening"', () => {
        expect(timeOfDaySchema.safeParse('evening').success).toBe(true);
    });

    it('should accept "night"', () => {
        expect(timeOfDaySchema.safeParse('night').success).toBe(true);
    });

    it('should reject invalid time of day', () => {
        expect(timeOfDaySchema.safeParse('dawn').success).toBe(false);
    });

    it('should reject empty string', () => {
        expect(timeOfDaySchema.safeParse('').success).toBe(false);
    });
});

describe('dayOfWeekSchema', () => {
    it('should accept "Sunday"', () => {
        expect(dayOfWeekSchema.safeParse('Sunday').success).toBe(true);
    });

    it('should accept "Monday"', () => {
        expect(dayOfWeekSchema.safeParse('Monday').success).toBe(true);
    });

    it('should accept "Tuesday"', () => {
        expect(dayOfWeekSchema.safeParse('Tuesday').success).toBe(true);
    });

    it('should accept "Wednesday"', () => {
        expect(dayOfWeekSchema.safeParse('Wednesday').success).toBe(true);
    });

    it('should accept "Thursday"', () => {
        expect(dayOfWeekSchema.safeParse('Thursday').success).toBe(true);
    });

    it('should accept "Friday"', () => {
        expect(dayOfWeekSchema.safeParse('Friday').success).toBe(true);
    });

    it('should accept "Saturday"', () => {
        expect(dayOfWeekSchema.safeParse('Saturday').success).toBe(true);
    });

    it('should reject invalid day name', () => {
        expect(dayOfWeekSchema.safeParse('Funday').success).toBe(false);
    });

    it('should reject empty string', () => {
        expect(dayOfWeekSchema.safeParse('').success).toBe(false);
    });
});

describe('formatRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    describe('just now (< 1 minute)', () => {
        it('should return "just now" for same time', () => {
            const result = formatRelativeTime(baseDate, baseDate);
            expect(result).toBe('just now');
        });

        it('should return "just now" for 30 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:30.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('just now');
        });

        it('should return "just now" for 59 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:01.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('just now');
        });
    });

    describe('minutes (1-59 minutes)', () => {
        it('should return "1 minute ago" for exactly 1 minute', () => {
            const date = new Date('2025-01-15T11:59:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 minute ago');
        });

        it('should return "2 minutes ago" for 2 minutes', () => {
            const date = new Date('2025-01-15T11:58:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 minutes ago');
        });

        it('should return "59 minutes ago" for 59 minutes', () => {
            const date = new Date('2025-01-15T11:01:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('59 minutes ago');
        });
    });

    describe('hours (1-23 hours)', () => {
        it('should return "1 hour ago" for exactly 1 hour', () => {
            const date = new Date('2025-01-15T11:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 hour ago');
        });

        it('should return "2 hours ago" for 2 hours', () => {
            const date = new Date('2025-01-15T10:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 hours ago');
        });

        it('should return "23 hours ago" for 23 hours', () => {
            const date = new Date('2025-01-14T13:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('23 hours ago');
        });
    });

    describe('days (1-6 days)', () => {
        it('should return "1 day ago" for exactly 1 day', () => {
            const date = new Date('2025-01-14T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 day ago');
        });

        it('should return "2 days ago" for 2 days', () => {
            const date = new Date('2025-01-13T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 days ago');
        });

        it('should return "6 days ago" for 6 days', () => {
            const date = new Date('2025-01-09T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('6 days ago');
        });
    });

    describe('weeks (1-4 weeks)', () => {
        it('should return "1 week ago" for exactly 7 days', () => {
            const date = new Date('2025-01-08T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 week ago');
        });

        it('should return "2 weeks ago" for 14 days', () => {
            const date = new Date('2025-01-01T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 weeks ago');
        });

        it('should return "3 weeks ago" for 21 days', () => {
            const date = new Date('2024-12-25T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('3 weeks ago');
        });

        it('should return "4 weeks ago" at exactly 30 days (MS_PER_MONTH boundary)', () => {
            // At exactly MS_PER_MONTH, the condition `diffMs < MS_PER_MONTH` is false
            // so it falls through to the months calculation, but 30 days / 7 days = 4 weeks
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_MONTH = 30 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_MONTH);
            expect(formatRelativeTime(date, baseDate)).toBe('1 month ago');
        });
    });

    describe('months (1-11 months)', () => {
        it('should return "1 month ago" for ~30 days', () => {
            const date = new Date('2024-12-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('1 month ago');
        });

        it('should return "2 months ago" for ~60 days', () => {
            const date = new Date('2024-11-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 months ago');
        });

        it('should return "11 months ago" for ~330 days', () => {
            const date = new Date('2024-02-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('11 months ago');
        });

        it('should return "12 months ago" at exactly 360 days (boundary before 1 year)', () => {
            // 360 days = 12 months (30 days each), just before 365 days
            const date = new Date(baseDate.getTime() - 360 * 24 * 60 * 60 * 1000);
            expect(formatRelativeTime(date, baseDate)).toBe('12 months ago');
        });
    });

    describe('years (1+ years)', () => {
        it('should return "1 year ago" at exactly 365 days (MS_PER_YEAR boundary)', () => {
            // At exactly MS_PER_YEAR, the condition `diffMs < MS_PER_YEAR` is false
            // so it falls through to the years calculation: 365 / 365 = 1 year
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_YEAR = 365 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_YEAR);
            expect(formatRelativeTime(date, baseDate)).toBe('1 year ago');
        });

        it('should return "2 years ago" for 2 years', () => {
            const date = new Date('2023-01-15T12:00:00.000Z');
            expect(formatRelativeTime(date, baseDate)).toBe('2 years ago');
        });
    });

    describe('default now parameter', () => {
        it('should use current time when now is not provided', () => {
            const recentDate = new Date(Date.now() - 30000); // 30 seconds ago
            expect(formatRelativeTime(recentDate)).toBe('just now');
        });
    });
});

describe('getTimeOfDay', () => {
    describe('morning (5:00-11:59 UTC)', () => {
        it('should return "morning" at 5:00 UTC', () => {
            const date = new Date('2025-01-15T05:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('morning');
        });

        it('should return "morning" at 11:59 UTC', () => {
            const date = new Date('2025-01-15T11:59:59.000Z');
            expect(getTimeOfDay(date)).toBe('morning');
        });

        it('should return "morning" at 8:00 UTC', () => {
            const date = new Date('2025-01-15T08:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('morning');
        });
    });

    describe('afternoon (12:00-16:59 UTC)', () => {
        it('should return "afternoon" at 12:00 UTC', () => {
            const date = new Date('2025-01-15T12:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('afternoon');
        });

        it('should return "afternoon" at 16:59 UTC', () => {
            const date = new Date('2025-01-15T16:59:59.000Z');
            expect(getTimeOfDay(date)).toBe('afternoon');
        });

        it('should return "afternoon" at 14:00 UTC', () => {
            const date = new Date('2025-01-15T14:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('afternoon');
        });
    });

    describe('evening (17:00-20:59 UTC)', () => {
        it('should return "evening" at 17:00 UTC', () => {
            const date = new Date('2025-01-15T17:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('evening');
        });

        it('should return "evening" at 20:59 UTC', () => {
            const date = new Date('2025-01-15T20:59:59.000Z');
            expect(getTimeOfDay(date)).toBe('evening');
        });

        it('should return "evening" at 19:00 UTC', () => {
            const date = new Date('2025-01-15T19:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('evening');
        });
    });

    describe('night (21:00-4:59 UTC)', () => {
        it('should return "night" at 21:00 UTC', () => {
            const date = new Date('2025-01-15T21:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('night');
        });

        it('should return "night" at 23:59 UTC', () => {
            const date = new Date('2025-01-15T23:59:59.000Z');
            expect(getTimeOfDay(date)).toBe('night');
        });

        it('should return "night" at 0:00 UTC', () => {
            const date = new Date('2025-01-15T00:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('night');
        });

        it('should return "night" at 4:59 UTC', () => {
            const date = new Date('2025-01-15T04:59:59.000Z');
            expect(getTimeOfDay(date)).toBe('night');
        });

        it('should return "night" at 2:00 UTC', () => {
            const date = new Date('2025-01-15T02:00:00.000Z');
            expect(getTimeOfDay(date)).toBe('night');
        });
    });
});

describe('getDayOfWeek', () => {
    it('should return "Monday" for a Monday', () => {
        const date = new Date('2025-01-13T12:00:00.000Z'); // Monday
        expect(getDayOfWeek(date)).toBe('Monday');
    });

    it('should return "Tuesday" for a Tuesday', () => {
        const date = new Date('2025-01-14T12:00:00.000Z'); // Tuesday
        expect(getDayOfWeek(date)).toBe('Tuesday');
    });

    it('should return "Wednesday" for a Wednesday', () => {
        const date = new Date('2025-01-15T12:00:00.000Z'); // Wednesday
        expect(getDayOfWeek(date)).toBe('Wednesday');
    });

    it('should return "Thursday" for a Thursday', () => {
        const date = new Date('2025-01-16T12:00:00.000Z'); // Thursday
        expect(getDayOfWeek(date)).toBe('Thursday');
    });

    it('should return "Friday" for a Friday', () => {
        const date = new Date('2025-01-17T12:00:00.000Z'); // Friday
        expect(getDayOfWeek(date)).toBe('Friday');
    });

    it('should return "Saturday" for a Saturday', () => {
        const date = new Date('2025-01-18T12:00:00.000Z'); // Saturday
        expect(getDayOfWeek(date)).toBe('Saturday');
    });

    it('should return "Sunday" for a Sunday', () => {
        const date = new Date('2025-01-19T12:00:00.000Z'); // Sunday
        expect(getDayOfWeek(date)).toBe('Sunday');
    });
});

describe('getCurrentTimeContext', () => {
    describe('without user timezone', () => {
        it('should return basic time context', () => {
            const context = getCurrentTimeContext();
            expect(context.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(context.dayOfWeek);
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(context.timeOfDay);
            expect(context.userTimezone).toBeUndefined();
            expect(context.userLocalTime).toBeUndefined();
        });
    });

    describe('with user timezone', () => {
        it('should include user timezone and local time for America/Los_Angeles', () => {
            const context = getCurrentTimeContext('America/Los_Angeles');
            expect(context.userTimezone).toBe('America/Los_Angeles');
            expect(context.userLocalTime).toBeDefined();
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });

        it('should include user timezone and local time for Europe/London', () => {
            const context = getCurrentTimeContext('Europe/London');
            expect(context.userTimezone).toBe('Europe/London');
            expect(context.userLocalTime).toBeDefined();
        });

        it('should include user timezone and local time for Asia/Tokyo', () => {
            const context = getCurrentTimeContext('Asia/Tokyo');
            expect(context.userTimezone).toBe('Asia/Tokyo');
            expect(context.userLocalTime).toBeDefined();
        });

        it('should handle invalid timezone gracefully', () => {
            const context = getCurrentTimeContext('Invalid/Timezone');
            expect(context.userTimezone).toBe('Invalid/Timezone');
            expect(context.userLocalTime).toBeUndefined();
        });

        it('should format local time in 24-hour format', () => {
            const context = getCurrentTimeContext('UTC');
            expect(context.userLocalTime).toBeDefined();
            // Verify no AM/PM in the output (24-hour format)
            expect(context.userLocalTime).not.toContain('AM');
            expect(context.userLocalTime).not.toContain('PM');
            // Verify ISO-like format
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        });

        it('should use 24-hour format (hour12=false) not 12-hour format', () => {
            // Compare two timezones that differ by exactly 12 hours.
            // With hour12=false, the hours will differ by 12 (mod 24).
            // With hour12=true, both would show the same 1-12 range value.
            const utcContext = getCurrentTimeContext('UTC');
            const pacificContext = getCurrentTimeContext('Pacific/Kwajalein'); // UTC+12

            expect(utcContext.userLocalTime).toBeDefined();
            expect(pacificContext.userLocalTime).toBeDefined();

            // Extract hours from both contexts
            const utcHourMatch = utcContext.userLocalTime?.match(/T(\d{2}):/);
            const pacificHourMatch = pacificContext.userLocalTime?.match(/T(\d{2}):/);
            expect(utcHourMatch).toBeTruthy();
            expect(pacificHourMatch).toBeTruthy();

            const utcHour = parseInt(utcHourMatch![1], 10);
            const pacificHour = parseInt(pacificHourMatch![1], 10);

            // With hour12=false (correct): Pacific hour = (UTC hour + 12) mod 24
            // With hour12=true (mutant): Both would be in 1-12 range, so the difference
            // would be 0 or 12, but never match the 24-hour pattern correctly.
            const expectedPacificHour = (utcHour + 12) % 24;
            expect(pacificHour).toBe(expectedPacificHour);
        });
    });
});

describe('timeContextSchema', () => {
    it('should validate a complete TimeContext', () => {
        const context: TimeContext = {
            utc:           '2025-01-15T12:00:00.000Z',
            dayOfWeek:     'Wednesday',
            timeOfDay:     'afternoon',
            userTimezone:  'America/Los_Angeles',
            userLocalTime: '2025-01-15T04:00:00',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(true);
    });

    it('should validate TimeContext without optional fields', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Wednesday',
            timeOfDay: 'afternoon',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(true);
    });

    it('should reject invalid timeOfDay', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Wednesday',
            timeOfDay: 'invalid',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });

    it('should reject invalid dayOfWeek', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Funday',
            timeOfDay: 'afternoon',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });

    it('should reject missing required fields', () => {
        const context = {
            utc: '2025-01-15T12:00:00.000Z',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });
});

describe('formatMemoryTimestamp', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    it('should format timestamp with relative time and ISO string', () => {
        const updatedAt = '2025-01-13T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 days ago, 2025-01-13T10:00:00.000Z)');
    });

    it('should format just now timestamp', () => {
        const updatedAt = '2025-01-15T11:59:30.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(just now, 2025-01-15T11:59:30.000Z)');
    });

    it('should format hours ago timestamp', () => {
        const updatedAt = '2025-01-15T10:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 hours ago, 2025-01-15T10:00:00.000Z)');
    });

    it('should format weeks ago timestamp', () => {
        const updatedAt = '2025-01-01T12:00:00.000Z';
        const result = formatMemoryTimestamp(updatedAt, baseDate);
        expect(result).toBe('(2 weeks ago, 2025-01-01T12:00:00.000Z)');
    });

    it('should use current time when now is not provided', () => {
        const recentDate = new Date(Date.now() - 30000).toISOString(); // 30 seconds ago
        const result = formatMemoryTimestamp(recentDate);
        expect(result).toMatch(/^\(just now, /);
    });
});

describe('formatShortRelativeTime', () => {
    const baseDate = new Date('2025-01-15T12:00:00.000Z');

    describe('just now (< 1 minute)', () => {
        it('should return "now" for same time', () => {
            expect(formatShortRelativeTime(baseDate, baseDate)).toBe('now');
        });

        it('should return "now" for 30 seconds ago', () => {
            const date = new Date('2025-01-15T11:59:30.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('now');
        });
    });

    describe('minutes', () => {
        it('should return "1m ago" for 1 minute', () => {
            const date = new Date('2025-01-15T11:59:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1m ago');
        });

        it('should return "30m ago" for 30 minutes', () => {
            const date = new Date('2025-01-15T11:30:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('30m ago');
        });
    });

    describe('hours', () => {
        it('should return "1h ago" for 1 hour', () => {
            const date = new Date('2025-01-15T11:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1h ago');
        });

        it('should return "12h ago" for 12 hours', () => {
            const date = new Date('2025-01-15T00:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('12h ago');
        });
    });

    describe('days', () => {
        it('should return "1d ago" for 1 day', () => {
            const date = new Date('2025-01-14T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1d ago');
        });

        it('should return "5d ago" for 5 days', () => {
            const date = new Date('2025-01-10T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('5d ago');
        });
    });

    describe('weeks', () => {
        it('should return "1w ago" for 7 days', () => {
            const date = new Date('2025-01-08T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1w ago');
        });

        it('should return "3w ago" for 21 days', () => {
            const date = new Date('2024-12-25T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('3w ago');
        });

        it('should return "4w ago" at exactly 30 days (MS_PER_MONTH boundary)', () => {
            // At exactly MS_PER_MONTH, the condition `diffMs < MS_PER_MONTH` is false
            // so it falls through to the months calculation: 30 / 30 = 1 month
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_MONTH = 30 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_MONTH);
            expect(formatShortRelativeTime(date, baseDate)).toBe('1mo ago');
        });
    });

    describe('months', () => {
        it('should return "1mo ago" for ~30 days', () => {
            const date = new Date('2024-12-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('1mo ago');
        });

        it('should return "6mo ago" for ~180 days', () => {
            const date = new Date('2024-07-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('6mo ago');
        });

        it('should return "12mo ago" at exactly 360 days (boundary before 1 year)', () => {
            // 360 days = 12 months (30 days each), just before 365 days
            const date = new Date(baseDate.getTime() - 360 * 24 * 60 * 60 * 1000);
            expect(formatShortRelativeTime(date, baseDate)).toBe('12mo ago');
        });
    });

    describe('years', () => {
        it('should return "1y ago" at exactly 365 days (MS_PER_YEAR boundary)', () => {
            // At exactly MS_PER_YEAR, the condition `diffMs < MS_PER_YEAR` is false
            // so it falls through to the years calculation: 365 / 365 = 1 year
            const MS_PER_DAY = 24 * 60 * 60 * 1000;
            const MS_PER_YEAR = 365 * MS_PER_DAY;
            const date = new Date(baseDate.getTime() - MS_PER_YEAR);
            expect(formatShortRelativeTime(date, baseDate)).toBe('1y ago');
        });

        it('should return "2y ago" for 2 years', () => {
            const date = new Date('2023-01-15T12:00:00.000Z');
            expect(formatShortRelativeTime(date, baseDate)).toBe('2y ago');
        });
    });

    describe('default now parameter', () => {
        it('should use current time when now is not provided', () => {
            const recentDate = new Date(Date.now() - 30000); // 30 seconds ago
            expect(formatShortRelativeTime(recentDate)).toBe('now');
        });
    });
});
