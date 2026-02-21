import { describe, test, expect } from 'bun:test';
import {
    getTimeOfDay,
    getDayOfWeek,
    getCurrentTimeContext,
    resolveTimezone,
    formatLocalDateTime
} from '@/utils/time';

describe.concurrent('getTimeOfDay', () => {
    describe('with UTC timezone (explicit)', () => {
        describe('morning (5:00-11:59)', () => {
            test('should return "morning" at 5:00 UTC', () => {
                const date = new Date('2025-01-15T05:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('morning');
            });

            test('should return "morning" at 11:59 UTC', () => {
                const date = new Date('2025-01-15T11:59:59.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('morning');
            });

            test('should return "morning" at 8:00 UTC', () => {
                const date = new Date('2025-01-15T08:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('morning');
            });
        });

        describe('afternoon (12:00-16:59)', () => {
            test('should return "afternoon" at 12:00 UTC', () => {
                const date = new Date('2025-01-15T12:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('afternoon');
            });

            test('should return "afternoon" at 16:59 UTC', () => {
                const date = new Date('2025-01-15T16:59:59.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('afternoon');
            });

            test('should return "afternoon" at 14:00 UTC', () => {
                const date = new Date('2025-01-15T14:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('afternoon');
            });
        });

        describe('evening (17:00-20:59)', () => {
            test('should return "evening" at 17:00 UTC', () => {
                const date = new Date('2025-01-15T17:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('evening');
            });

            test('should return "evening" at 20:59 UTC', () => {
                const date = new Date('2025-01-15T20:59:59.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('evening');
            });

            test('should return "evening" at 19:00 UTC', () => {
                const date = new Date('2025-01-15T19:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('evening');
            });
        });

        describe('night (21:00-4:59)', () => {
            test('should return "night" at 21:00 UTC', () => {
                const date = new Date('2025-01-15T21:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('night');
            });

            test('should return "night" at 23:59 UTC', () => {
                const date = new Date('2025-01-15T23:59:59.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('night');
            });

            test('should return "night" at 0:00 UTC', () => {
                const date = new Date('2025-01-15T00:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('night');
            });

            test('should return "night" at 4:59 UTC', () => {
                const date = new Date('2025-01-15T04:59:59.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('night');
            });

            test('should return "night" at 2:00 UTC', () => {
                const date = new Date('2025-01-15T02:00:00.000Z');
                expect(getTimeOfDay(date, 'UTC')).toBe('night');
            });
        });
    });

    describe('with different timezones', () => {
        test('should return correct time of day for America/New_York', () => {
            // 2025-01-15T14:00:00Z = 09:00 EST (morning in New York)
            const date = new Date('2025-01-15T14:00:00.000Z');
            expect(getTimeOfDay(date, 'America/New_York')).toBe('morning');
        });

        test('should return correct time of day for America/Los_Angeles', () => {
            // 2025-01-15T20:00:00Z = 12:00 PST (afternoon in LA)
            const date = new Date('2025-01-15T20:00:00.000Z');
            expect(getTimeOfDay(date, 'America/Los_Angeles')).toBe('afternoon');
        });

        test('should return correct time of day for Asia/Tokyo', () => {
            // 2025-01-15T08:00:00Z = 17:00 JST (evening in Tokyo)
            const date = new Date('2025-01-15T08:00:00.000Z');
            expect(getTimeOfDay(date, 'Asia/Tokyo')).toBe('evening');
        });

        test('should return correct time of day for Europe/London', () => {
            // 2025-01-15T22:00:00Z = 22:00 GMT (night in London)
            const date = new Date('2025-01-15T22:00:00.000Z');
            expect(getTimeOfDay(date, 'Europe/London')).toBe('night');
        });
    });

    describe('without timezone (defaults to server timezone)', () => {
        test('should use server timezone when no timezone provided', () => {
            const date = new Date('2025-01-15T14:00:00.000Z');
            const result = getTimeOfDay(date);
            // Result depends on server timezone, just verify it returns a valid TimeOfDay
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(result);
        });
    });
});

describe('getDayOfWeek', () => {
    describe('with UTC timezone (explicit)', () => {
        test('should return "Monday" for a Monday in UTC', () => {
            const date = new Date('2025-01-13T12:00:00.000Z'); // Monday
            expect(getDayOfWeek(date, 'UTC')).toBe('Monday');
        });

        test('should return "Tuesday" for a Tuesday in UTC', () => {
            const date = new Date('2025-01-14T12:00:00.000Z'); // Tuesday
            expect(getDayOfWeek(date, 'UTC')).toBe('Tuesday');
        });

        test('should return "Wednesday" for a Wednesday in UTC', () => {
            const date = new Date('2025-01-15T12:00:00.000Z'); // Wednesday
            expect(getDayOfWeek(date, 'UTC')).toBe('Wednesday');
        });

        test('should return "Thursday" for a Thursday in UTC', () => {
            const date = new Date('2025-01-16T12:00:00.000Z'); // Thursday
            expect(getDayOfWeek(date, 'UTC')).toBe('Thursday');
        });

        test('should return "Friday" for a Friday in UTC', () => {
            const date = new Date('2025-01-17T12:00:00.000Z'); // Friday
            expect(getDayOfWeek(date, 'UTC')).toBe('Friday');
        });

        test('should return "Saturday" for a Saturday in UTC', () => {
            const date = new Date('2025-01-18T12:00:00.000Z'); // Saturday
            expect(getDayOfWeek(date, 'UTC')).toBe('Saturday');
        });

        test('should return "Sunday" for a Sunday in UTC', () => {
            const date = new Date('2025-01-19T12:00:00.000Z'); // Sunday
            expect(getDayOfWeek(date, 'UTC')).toBe('Sunday');
        });
    });

    describe('with different timezones', () => {
        test('should handle day boundary crossing', () => {
            // 2025-01-19T23:00:00Z (Sunday in UTC) = Monday in Pacific/Auckland (UTC+13)
            const date = new Date('2025-01-19T23:00:00.000Z');
            expect(getDayOfWeek(date, 'UTC')).toBe('Sunday');
            expect(getDayOfWeek(date, 'Pacific/Auckland')).toBe('Monday');
        });

        test('should return correct day for America/Los_Angeles', () => {
            // 2025-01-13T02:00:00Z (Monday in UTC) = Sunday in LA (still previous day)
            const date = new Date('2025-01-13T02:00:00.000Z');
            expect(getDayOfWeek(date, 'UTC')).toBe('Monday');
            expect(getDayOfWeek(date, 'America/Los_Angeles')).toBe('Sunday');
        });

        test('should return correct day for Asia/Tokyo', () => {
            // 2025-01-19T15:00:00Z (Sunday in UTC) = Monday in Tokyo (next day)
            const date = new Date('2025-01-19T15:00:00.000Z');
            expect(getDayOfWeek(date, 'UTC')).toBe('Sunday');
            expect(getDayOfWeek(date, 'Asia/Tokyo')).toBe('Monday');
        });
    });

    describe('without timezone (defaults to server timezone)', () => {
        test('should use server timezone when no timezone provided', () => {
            const date = new Date('2025-01-15T12:00:00.000Z');
            const result = getDayOfWeek(date);
            // Result depends on server timezone, just verify it returns a valid DayOfWeek
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(result);
        });
    });
});

describe('resolveTimezone', () => {
    test('should return passed timezone when valid', () => {
        const timezone = resolveTimezone('America/Los_Angeles');
        expect(timezone).toBe('America/Los_Angeles');
    });

    test('should return server TZ when no argument passed', () => {
        const expectedServerTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        const timezone = resolveTimezone();
        expect(timezone).toBe(expectedServerTz);
    });

    test('should return server TZ and log warning when invalid timezone passed', () => {
        const expectedServerTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        const timezone = resolveTimezone('Invalid/Timezone');
        expect(timezone).toBe(expectedServerTz);
        // Note: Can't easily test logger.warn was called without mocking
    });

    test('should return UTC when Intl.DateTimeFormat throws', () => {
        // Save original DateTimeFormat
        const originalDateTimeFormat = Intl.DateTimeFormat;

        try {
            // Mock Intl.DateTimeFormat to throw when resolvedOptions() is called
            (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = class {
                resolvedOptions(): never {
                    throw new Error('DateTimeFormat not supported');
                }
            };

            // Should fall back to UTC
            const timezone = resolveTimezone();
            expect(timezone).toBe('UTC');
        } finally {
            // Restore original DateTimeFormat
            Intl.DateTimeFormat = originalDateTimeFormat;
        }
    });
});

describe('formatLocalDateTime', () => {
    test('should format correctly for UTC timezone', () => {
        const isoString = '2025-01-15T14:30:45.000Z';
        const result = formatLocalDateTime(isoString, 'UTC');
        expect(result).toBe('2025-01-15T14:30:45');
    });

    test('should format correctly for America/Los_Angeles timezone', () => {
        // 2025-01-15T14:30:45Z UTC = 2025-01-15T06:30:45 PST (UTC-8)
        const isoString = '2025-01-15T14:30:45.000Z';
        const result = formatLocalDateTime(isoString, 'America/Los_Angeles');
        expect(result).toBe('2025-01-15T06:30:45');
    });

    test('should format correctly for Asia/Tokyo timezone', () => {
        // 2025-01-15T14:30:45Z UTC = 2025-01-15T23:30:45 JST (UTC+9)
        const isoString = '2025-01-15T14:30:45.000Z';
        const result = formatLocalDateTime(isoString, 'Asia/Tokyo');
        expect(result).toBe('2025-01-15T23:30:45');
    });

    test('should use 24-hour format (no AM/PM)', () => {
        const isoString = '2025-01-15T14:30:45.000Z';
        const result = formatLocalDateTime(isoString, 'UTC');
        expect(result).not.toContain('AM');
        expect(result).not.toContain('PM');
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    });

    test('should handle day boundary correctly', () => {
        // 2025-01-15T23:30:45Z UTC = 2025-01-16T08:30:45 JST (next day)
        const isoString = '2025-01-15T23:30:45.000Z';
        const result = formatLocalDateTime(isoString, 'Asia/Tokyo');
        expect(result).toBe('2025-01-16T08:30:45');
    });
});

describe('getCurrentTimeContext', () => {
    describe('without user timezone', () => {
        test('should return basic time context with server timezone', () => {
            const expectedServerTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
            const context = getCurrentTimeContext();
            expect(context.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(context.dayOfWeek);
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(context.timeOfDay);
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(context.utcDayOfWeek);
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(context.utcTimeOfDay);
            expect(context.userTimezone).toBe(expectedServerTz);
            expect(context.userLocalTime).toBeDefined();
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        });
    });

    describe('with user timezone', () => {
        test('should include user timezone and local time for America/Los_Angeles', () => {
            const context = getCurrentTimeContext('America/Los_Angeles');
            expect(context.userTimezone).toBe('America/Los_Angeles');
            expect(context.userLocalTime).toBeDefined();
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        });

        test('should include user timezone and local time for Europe/London', () => {
            const context = getCurrentTimeContext('Europe/London');
            expect(context.userTimezone).toBe('Europe/London');
            expect(context.userLocalTime).toBeDefined();
        });

        test('should include user timezone and local time for Asia/Tokyo', () => {
            const context = getCurrentTimeContext('Asia/Tokyo');
            expect(context.userTimezone).toBe('Asia/Tokyo');
            expect(context.userLocalTime).toBeDefined();
        });

        test('should handle invalid timezone gracefully', () => {
            const expectedServerTz = new Intl.DateTimeFormat().resolvedOptions().timeZone;
            const context = getCurrentTimeContext('Invalid/Timezone');
            expect(context.userTimezone).toBe(expectedServerTz);
            expect(context.userLocalTime).toBeDefined();
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        });

        test('should format local time in 24-hour format', () => {
            const context = getCurrentTimeContext('UTC');
            expect(context.userLocalTime).toBeDefined();
            // Verify no AM/PM in the output (24-hour format)
            expect(context.userLocalTime).not.toContain('AM');
            expect(context.userLocalTime).not.toContain('PM');
            // Verify ISO-like format
            expect(context.userLocalTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        });

        test('should use 24-hour format (hour12=false) not 12-hour format', () => {
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

        test('should have UTC-specific dayOfWeek/timeOfDay fields', () => {
            // Test at a specific UTC time that will differ in America/Los_Angeles
            // At 6am UTC Wednesday, it's 10pm Tuesday in Los Angeles (PST is UTC-8)
            const testDate = new Date('2025-01-15T06:00:00.000Z');

            // Verify getDayOfWeek and getTimeOfDay work correctly with timezones
            const utcDay = getDayOfWeek(testDate, 'UTC');
            const utcTime = getTimeOfDay(testDate, 'UTC');
            const localDay = getDayOfWeek(testDate, 'America/Los_Angeles');
            const localTime = getTimeOfDay(testDate, 'America/Los_Angeles');

            expect(utcDay).toBe('Wednesday');
            expect(utcTime).toBe('morning'); // 6am is morning
            expect(localDay).toBe('Tuesday');
            expect(localTime).toBe('night'); // 10pm is night
        });

        test('should populate both UTC and local day/time fields in getCurrentTimeContext', () => {
            const context = getCurrentTimeContext('America/Los_Angeles');

            // UTC fields should always be populated
            expect(context.utcDayOfWeek).toBeDefined();
            expect(context.utcTimeOfDay).toBeDefined();
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(context.utcDayOfWeek);
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(context.utcTimeOfDay);

            // Local fields should be populated with LA timezone
            expect(context.dayOfWeek).toBeDefined();
            expect(context.timeOfDay).toBeDefined();
            expect(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']).toContain(context.dayOfWeek);
            expect(['morning', 'afternoon', 'evening', 'night']).toContain(context.timeOfDay);
        });
    });
});
