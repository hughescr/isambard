import { describe, it, expect } from 'bun:test';
import {
    getTimeOfDay,
    getDayOfWeek,
    getCurrentTimeContext
} from '@/utils/time';

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
