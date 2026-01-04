import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    timeContextSchema,
    timeOfDaySchema,
    dayOfWeekSchema,
    formatRelativeTime,
    formatShortRelativeTime,
    getCurrentTimeContext,
    type TimeContext
} from '@/utils/time';

describe.concurrent('timeOfDaySchema', () => {
    test('should accept "morning"', () => {
        expect(timeOfDaySchema.safeParse('morning').success).toBe(true);
    });

    test('should accept "afternoon"', () => {
        expect(timeOfDaySchema.safeParse('afternoon').success).toBe(true);
    });

    test('should accept "evening"', () => {
        expect(timeOfDaySchema.safeParse('evening').success).toBe(true);
    });

    test('should accept "night"', () => {
        expect(timeOfDaySchema.safeParse('night').success).toBe(true);
    });

    test('should reject invalid time of day', () => {
        expect(timeOfDaySchema.safeParse('dawn').success).toBe(false);
    });

    test('should reject empty string', () => {
        expect(timeOfDaySchema.safeParse('').success).toBe(false);
    });
});

describe('dayOfWeekSchema', () => {
    test('should accept "Sunday"', () => {
        expect(dayOfWeekSchema.safeParse('Sunday').success).toBe(true);
    });

    test('should accept "Monday"', () => {
        expect(dayOfWeekSchema.safeParse('Monday').success).toBe(true);
    });

    test('should accept "Tuesday"', () => {
        expect(dayOfWeekSchema.safeParse('Tuesday').success).toBe(true);
    });

    test('should accept "Wednesday"', () => {
        expect(dayOfWeekSchema.safeParse('Wednesday').success).toBe(true);
    });

    test('should accept "Thursday"', () => {
        expect(dayOfWeekSchema.safeParse('Thursday').success).toBe(true);
    });

    test('should accept "Friday"', () => {
        expect(dayOfWeekSchema.safeParse('Friday').success).toBe(true);
    });

    test('should accept "Saturday"', () => {
        expect(dayOfWeekSchema.safeParse('Saturday').success).toBe(true);
    });

    test('should reject invalid day name', () => {
        expect(dayOfWeekSchema.safeParse('Funday').success).toBe(false);
    });

    test('should reject empty string', () => {
        expect(dayOfWeekSchema.safeParse('').success).toBe(false);
    });
});

describe('timeContextSchema', () => {
    test('should validate a complete TimeContext', () => {
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

    test('should validate TimeContext without optional fields', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Wednesday',
            timeOfDay: 'afternoon',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(true);
    });

    test('should reject invalid timeOfDay', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Wednesday',
            timeOfDay: 'invalid',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });

    test('should reject invalid dayOfWeek', () => {
        const context = {
            utc:       '2025-01-15T12:00:00.000Z',
            dayOfWeek: 'Funday',
            timeOfDay: 'afternoon',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });

    test('should reject missing required fields', () => {
        const context = {
            utc: '2025-01-15T12:00:00.000Z',
        };
        const result = timeContextSchema.safeParse(context);
        expect(result.success).toBe(false);
    });
});

describe('formatRelativeTime boundary conditions', () => {
    test('should format 29 days as weeks (days < 30 boundary)', () => {
        const now = new Date('2024-01-30T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 29 days ago
        expect(formatRelativeTime(date, now)).toBe('4 weeks ago');
    });

    test('should format exactly 30 days as months (days >= 30 transition)', () => {
        const now = new Date('2024-01-31T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 30 days ago
        // At exactly 30 days, differenceInMonths returns 0
        expect(formatRelativeTime(date, now)).toBe('0 months ago');
    });

    test('should format 364 days as months (days < 365 boundary)', () => {
        const now = new Date('2024-12-30T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 364 days ago
        expect(formatRelativeTime(date, now)).toMatch(/\d+ months ago/);
    });

    test('should format exactly 365 days as years (days >= 365 transition)', () => {
        const now = new Date('2025-01-01T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 365 days ago (leap year)
        expect(formatRelativeTime(date, now)).toBe('1 year ago');
    });
});

describe('formatShortRelativeTime boundary conditions', () => {
    test('should format 29 days as weeks (days < 30 boundary)', () => {
        const now = new Date('2024-01-30T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 29 days ago
        expect(formatShortRelativeTime(date, now)).toBe('4w ago');
    });

    test('should format exactly 30 days as months (days >= 30 transition)', () => {
        const now = new Date('2024-01-31T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 30 days ago
        // At exactly 30 days, differenceInMonths returns 0
        expect(formatShortRelativeTime(date, now)).toBe('0mo ago');
    });

    test('should format 364 days as months (days < 365 boundary)', () => {
        const now = new Date('2024-12-30T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 364 days ago
        expect(formatShortRelativeTime(date, now)).toMatch(/\d+mo ago/);
    });

    test('should format exactly 365 days as years (days >= 365 transition)', () => {
        const now = new Date('2025-01-01T12:00:00Z');
        const date = new Date('2024-01-01T12:00:00Z'); // 365 days ago (leap year)
        expect(formatShortRelativeTime(date, now)).toBe('1y ago');
    });
});

describe('getCurrentTimeContext', () => {
    let RealDate: DateConstructor;

    beforeEach(() => {
        RealDate = global.Date;
    });

    afterEach(() => {
        global.Date = RealDate;
    });

    test('should format userLocalTime in 24-hour format', () => {
        // Use a fixed afternoon time (14:30:45 PST = 22:30:45 UTC on 2025-01-01)
        // to ensure we're testing afternoon hours that differ in 12/24 hour format
        const fixedTime = new RealDate('2025-01-01T22:30:45Z');

        // Mock Date constructor to return our fixed time
        const DateMock = function(this: Date | undefined, ...args: unknown[]): Date | string {
            if(new.target) {
                // Called with 'new'
                if(args.length === 0) {
                    return fixedTime;
                }
                return Reflect.construct(RealDate, args) as Date;
            } else {
                // Called without 'new' - Date() returns a string
                return fixedTime.toString();
            }
        };
        DateMock.prototype = RealDate.prototype;
        Object.setPrototypeOf(DateMock, RealDate);
        DateMock.now = () => fixedTime.getTime();
        DateMock.parse = RealDate.parse;
        DateMock.UTC = RealDate.UTC;

        // Type assertion needed for mocking global Date constructor
        global.Date = DateMock as DateConstructor;

        const context = getCurrentTimeContext('America/Los_Angeles');

        // Should use 24-hour format (14:30:45), not 12-hour format (02:30:45 PM)
        // The mutant (hour12: true) would produce "T02:30:45" instead of "T14:30:45"
        expect(context.userLocalTime).toBe('2025-01-01T14:30:45');
    });
});
