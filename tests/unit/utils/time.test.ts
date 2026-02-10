import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { isString as _isString, split as _split, some as _some, startsWith as _startsWith } from 'lodash';
import {
    timeContextSchema,
    timeOfDaySchema,
    dayOfWeekSchema,
    formatRelativeTime,
    formatShortRelativeTime,
    getCurrentTimeContext,
    formatTimeSince,
    formatTimeHeader,
    resolveTimezone,
    type TimeContext
} from '@/utils/time';

describe.concurrent('timeOfDaySchema', () => {
    test.each(['morning', 'afternoon', 'evening', 'night'])('should accept valid time of day "%s"', (timeOfDay) => {
        expect(timeOfDaySchema.safeParse(timeOfDay).success).toBe(true);
    });

    test.each(['dawn', ''])('should reject invalid time of day "%s"', (invalid) => {
        expect(timeOfDaySchema.safeParse(invalid).success).toBe(false);
    });
});

describe('dayOfWeekSchema', () => {
    test.each(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])(
        'should accept valid day "%s"', (day) => {
            expect(dayOfWeekSchema.safeParse(day).success).toBe(true);
        }
    );

    test.each(['Funday', ''])('should reject invalid day "%s"', (invalid) => {
        expect(dayOfWeekSchema.safeParse(invalid).success).toBe(false);
    });
});

describe('timeContextSchema', () => {
    test('should validate complete and minimal TimeContext', () => {
        const completeContext: TimeContext = {
            utc:           '2025-01-15T12:00:00.000Z',
            dayOfWeek:     'Wednesday',
            timeOfDay:     'afternoon',
            utcDayOfWeek:  'Wednesday',
            utcTimeOfDay:  'afternoon',
            userTimezone:  'America/Los_Angeles',
            userLocalTime: '2025-01-15T04:00:00',
        };
        expect(timeContextSchema.safeParse(completeContext).success).toBe(true);

        const minimalContext = {
            utc:          '2025-01-15T12:00:00.000Z',
            dayOfWeek:    'Wednesday',
            timeOfDay:    'afternoon',
            utcDayOfWeek: 'Wednesday',
            utcTimeOfDay: 'afternoon',
        };
        expect(timeContextSchema.safeParse(minimalContext).success).toBe(true);
    });

    test.each([
        { utc: '2025-01-15T12:00:00.000Z', dayOfWeek: 'Wednesday', timeOfDay: 'invalid' },
        { utc: '2025-01-15T12:00:00.000Z', dayOfWeek: 'Funday', timeOfDay: 'afternoon' },
        { utc: '2025-01-15T12:00:00.000Z' },
    ])('should reject invalid TimeContext: %o', (context) => {
        expect(timeContextSchema.safeParse(context).success).toBe(false);
    });
});

describe('relative time formatting boundary conditions', () => {
    test.each([
        {
            desc:          '29 days as weeks (days < 30)',
            now:           new Date('2024-01-30T12:00:00Z'),
            date:          new Date('2024-01-01T12:00:00Z'),
            expectedLong:  '4 weeks ago',
            expectedShort: '4w ago'
        },
        {
            desc:          'exactly 30 days as weeks (not months yet)',
            now:           new Date('2024-01-31T12:00:00Z'),
            date:          new Date('2024-01-01T12:00:00Z'),
            expectedLong:  '4 weeks ago',
            expectedShort: '4w ago'
        },
        {
            desc:          '364 days as months (days < 365)',
            now:           new Date('2024-12-30T12:00:00Z'),
            date:          new Date('2024-01-01T12:00:00Z'),
            expectedLong:  /\d+ months ago/,
            expectedShort: /\d+mo ago/
        },
        {
            desc:          'exactly 365 days as years (days >= 365)',
            now:           new Date('2025-01-01T12:00:00Z'),
            date:          new Date('2024-01-01T12:00:00Z'),
            expectedLong:  '1 year ago',
            expectedShort: '1y ago'
        }
    ])('should format $desc', ({ date, now, expectedLong, expectedShort }) => {
        if(_isString(expectedLong)) {
            expect(formatRelativeTime(date, now)).toBe(expectedLong);
        } else {
            expect(formatRelativeTime(date, now)).toMatch(expectedLong);
        }

        if(_isString(expectedShort)) {
            expect(formatShortRelativeTime(date, now)).toBe(expectedShort);
        } else {
            expect(formatShortRelativeTime(date, now)).toMatch(expectedShort);
        }
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

describe('formatTimeSince', () => {
    let RealDate: DateConstructor;

    beforeEach(() => {
        RealDate = global.Date;
    });

    afterEach(() => {
        global.Date = RealDate;
    });

    test.each([
        // Test all boundary conditions (< not <=)
        { hours: 0.5, expected: 'a few minutes' },
        { hours: 0.9999, expected: 'a few minutes' }, // Just before 1 hour boundary
        { hours: 1.0, expected: 'an hour' },          // Exact boundary
        { hours: 1.5, expected: 'an hour' },
        { hours: 1.9999, expected: 'an hour' },       // Just before 2 hour boundary
        { hours: 2.0, expected: '2 hours' },          // Exact boundary
        { hours: 3, expected: '3 hours' },
        { hours: 5.9999, expected: '6 hours' },       // Just before 6 hour boundary
        { hours: 6.0, expected: 'half a day' },       // Exact boundary
        { hours: 9, expected: 'half a day' },
        { hours: 11.9999, expected: 'half a day' },   // Just before 12 hour boundary
        { hours: 12.0, expected: 'overnight' },       // Exact boundary
        { hours: 15, expected: 'overnight' },
        { hours: 17.9999, expected: 'overnight' },    // Just before 18 hour boundary
        { hours: 18.0, expected: 'a day' },           // Exact boundary
        { hours: 24, expected: 'a day' },
        { hours: 35.9999, expected: 'a day' },        // Just before 36 hour boundary
        { hours: 36.0, expected: '2 days' },          // Exact boundary
        { hours: 48, expected: '2 days' },
        { hours: 71.9999, expected: '3 days' },       // Just before 72 hour boundary
        { hours: 72.0, expected: 'a few days' },      // Exact boundary
        { hours: 96, expected: 'a few days' },
    ])('should format $hours hours as "$expected"', ({ hours, expected }) => {
        const now = new RealDate('2025-01-15T12:00:00Z');
        const since = new RealDate(now.getTime() - hours * 60 * 60 * 1000);

        // Mock Date constructor to return fixed 'now'
        const DateMock = function(this: Date | undefined, ...args: unknown[]): Date | string {
            if(new.target) {
                if(args.length === 0) {
                    return now;
                }
                return Reflect.construct(RealDate, args) as Date;
            } else {
                return now.toString();
            }
        };
        DateMock.prototype = RealDate.prototype;
        Object.setPrototypeOf(DateMock, RealDate);
        DateMock.now = () => now.getTime();
        DateMock.parse = RealDate.parse;
        DateMock.UTC = RealDate.UTC;

        global.Date = DateMock as DateConstructor;

        const result = formatTimeSince(since);
        expect(result).toBe(expected);
    });
});

describe('formatTimeHeader', () => {
    let RealDate: DateConstructor;
    const FIXED_TIME = new Date('2026-02-09T22:30:00.000Z');

    beforeEach(() => {
        RealDate = global.Date;

        // Mock Date constructor to return fixed time
        const DateMock = function(this: Date | undefined, ...args: unknown[]): Date | string {
            if(new.target) {
                if(args.length === 0) {
                    return FIXED_TIME;
                }
                return Reflect.construct(RealDate, args) as Date;
            } else {
                return FIXED_TIME.toString();
            }
        };
        DateMock.prototype = RealDate.prototype;
        Object.setPrototypeOf(DateMock, RealDate);
        DateMock.now = () => FIXED_TIME.getTime();
        DateMock.parse = RealDate.parse;
        DateMock.UTC = RealDate.UTC;

        global.Date = DateMock as DateConstructor;
    });

    afterEach(() => {
        global.Date = RealDate;
    });

    test('should include header and UTC+Izzy lines when no user timezone', () => {
        const result = formatTimeHeader();
        const lines = _split(result, '\n');

        expect(lines[0]).toBe('## Current Time');
        expect(lines[1]).toStartWith('- UTC: 2026-02-09T22:30:00.000Z (');
        expect(lines[2]).toStartWith('- Izzy: ');
        expect(lines[2]).toContain(resolveTimezone());
        expect(lines).toHaveLength(3);
    });

    test('should omit User line when userTimezone equals server timezone', () => {
        const serverTz = resolveTimezone();
        const result = formatTimeHeader(serverTz);
        const lines = _split(result, '\n');

        expect(lines).toHaveLength(3);
        expect(_some(lines, l => _startsWith(l, '- User:'))).toBe(false);
    });

    test('should include User line when userTimezone differs from server timezone', () => {
        const serverTz = resolveTimezone();
        // Pick a timezone that's definitely different from the server
        const differentTz = serverTz === 'America/New_York' ? 'America/Los_Angeles' : 'America/New_York';
        const result = formatTimeHeader(differentTz);
        const lines = _split(result, '\n');

        expect(lines).toHaveLength(4);
        expect(lines[3]).toStartWith('- User: ');
        expect(lines[3]).toContain(differentTz);
    });

    test('should format UTC line with day of week and time of day', () => {
        const result = formatTimeHeader();
        // 22:30 UTC is Monday night (not Sunday evening - that would be local time in PST)
        expect(result).toContain('- UTC: 2026-02-09T22:30:00.000Z (Monday night)');
    });

    test('should format Izzy line with local time, timezone, day of week, and time of day', () => {
        const result = formatTimeHeader();
        const lines = _split(result, '\n');
        const izzyLine = lines[2];

        expect(izzyLine).toStartWith('- Izzy: ');
        expect(izzyLine).toContain(resolveTimezone());
        // Should contain day of week (one of the seven days)
        expect(izzyLine).toMatch(/\((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (?:morning|afternoon|evening|night)\)/);
    });

    test('should format User line with local time, timezone, day of week, and time of day when different from server', () => {
        const serverTz = resolveTimezone();
        const differentTz = serverTz === 'Europe/London' ? 'America/New_York' : 'Europe/London';
        const result = formatTimeHeader(differentTz);
        const lines = _split(result, '\n');
        const userLine = lines[3];

        expect(userLine).toStartWith('- User: ');
        expect(userLine).toContain(differentTz);
        // Should contain day of week and time of day
        expect(userLine).toMatch(/\((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (?:morning|afternoon|evening|night)\)/);
    });
});
