import { describe, test, expect } from 'bun:test';
import {
    timeContextSchema,
    timeOfDaySchema,
    dayOfWeekSchema,
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
