import { describe, it, expect } from 'bun:test';
import {
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
