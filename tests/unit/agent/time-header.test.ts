import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { formatTimeHeader } from '@/agent/time-header';
import { resolveTimezone } from '@/utils';

/**
 * `formatTimeHeader` is the product's bound instance of `createTimeHeaderFormatter` (see
 * `tests/unit/utils/time.test.ts` for the factory's own parameterization coverage) — this file
 * pins its output byte-identical to before it moved out of `src/utils/time.ts` (#43).
 */
describe('formatTimeHeader', () => {
    let RealDate: DateConstructor;
    const FIXED_TIME = new Date('2026-02-09T22:30:00.000Z');

    beforeEach(() => {
        RealDate = globalThis.Date;

        // Mock Date constructor to return fixed time
        // eslint-disable-next-line sonarjs/function-return-type -- DateMock intentionally mirrors Date constructor signature
        const DateMock = function(this: Date | undefined, ...args: unknown[]): Date | string {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DateMock must support both constructor and function calls like Date
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

        globalThis.Date = DateMock as DateConstructor;
    });

    afterEach(() => {
        globalThis.Date = RealDate;
    });

    test('should include header and UTC+Izzy lines when no user timezone', () => {
        const result = formatTimeHeader();
        const lines = result.split('\n');

        expect(lines[0]).toBe('## Current Time');
        expect(lines[1]).toStartWith('- UTC: 2026-02-09T22:30:00.000Z (');
        expect(lines[2]).toStartWith('- Izzy: ');
        expect(lines[2]).toContain(resolveTimezone());
        expect(lines).toHaveLength(3);
    });

    test('should omit User line when userTimezone equals server timezone', () => {
        const serverTz = resolveTimezone();
        const result = formatTimeHeader(serverTz);
        const lines = result.split('\n');

        expect(lines).toHaveLength(3);
        expect(lines.some(l => l.startsWith('- User:'))).toBe(false);
    });

    test('should include User line when userTimezone differs from server timezone', () => {
        const serverTz = resolveTimezone();
        // Pick a timezone that's definitely different from the server
        const differentTz = serverTz === 'America/New_York' ? 'America/Los_Angeles' : 'America/New_York';
        const result = formatTimeHeader(differentTz);
        const lines = result.split('\n');

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
        const lines = result.split('\n');
        const izzyLine = lines[2];

        expect(izzyLine).toStartWith('- Izzy: ');
        expect(izzyLine).toContain(resolveTimezone());
        // Should contain day of week (one of the seven days)
        expect(izzyLine).toMatch(/\((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (?:morning|afternoon|evening|night)\)/);
    });

    test('derives Izzy header day and time from the captured UTC context', () => {
        const originalTimezone = process.env.TZ;
        process.env.TZ = 'UTC';
        let noArgCalls = 0;
        const laterTime = new RealDate('2026-02-10T12:30:00.000Z');
        // eslint-disable-next-line sonarjs/function-return-type -- DateMock intentionally mirrors Date constructor signature
        const DateMock = function(this: Date | undefined, ...args: unknown[]): Date | string {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- DateMock must support both constructor and function calls like Date
            if(new.target) {
                if(args.length === 0) {
                    noArgCalls++;
                    return noArgCalls === 1 ? FIXED_TIME : laterTime;
                }
                return Reflect.construct(RealDate, args) as Date;
            }
            return FIXED_TIME.toString();
        };
        DateMock.prototype = RealDate.prototype;
        Object.setPrototypeOf(DateMock, RealDate);
        DateMock.now = () => FIXED_TIME.getTime();
        DateMock.parse = RealDate.parse;
        DateMock.UTC = RealDate.UTC;
        globalThis.Date = DateMock as DateConstructor;

        try {
            const result = formatTimeHeader('Pacific/Kiritimati');
            expect(result).toContain('- Izzy: 2026-02-09T22:30:00 UTC (Monday night)');
        } finally {
            if(originalTimezone === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = originalTimezone;
            }
        }
    });

    test('gives Izzy her own time-of-day bucket, distinct from the user\'s', () => {
        const originalTimezone = process.env.TZ;
        process.env.TZ = 'UTC';

        try {
            // FIXED_TIME is 2026-02-09T22:30:00.000Z. Izzy's zone (forced to UTC via TZ) sees
            // hour 22 -> 'night'. America/Los_Angeles is fixed at UTC-8 in tests/setup.ts's
            // Intl.DateTimeFormat mock (no DST), so it sees hour (22 - 8) = 14 -> 'afternoon'.
            // The two zones land in different getTimeOfDay buckets so a mix-up between
            // izzyTimezone and userTimezone in formatTimeHeader is observable.
            const result = formatTimeHeader('America/Los_Angeles');
            const lines = result.split('\n');

            expect(lines[2]).toStartWith('- Izzy: ');
            expect(lines[2]).toContain('UTC');
            expect(lines[2]).toContain('night');

            expect(lines[3]).toStartWith('- User: ');
            expect(lines[3]).toContain('America/Los_Angeles');
            expect(lines[3]).toContain('afternoon');
        } finally {
            if(originalTimezone === undefined) {
                delete process.env.TZ;
            } else {
                process.env.TZ = originalTimezone;
            }
        }
    });

    test('should format User line with local time, timezone, day of week, and time of day when different from server', () => {
        const serverTz = resolveTimezone();
        const differentTz = serverTz === 'Europe/London' ? 'America/New_York' : 'Europe/London';
        const result = formatTimeHeader(differentTz);
        const lines = result.split('\n');
        const userLine = lines[3];

        expect(userLine).toStartWith('- User: ');
        expect(userLine).toContain(differentTz);
        // Should contain day of week and time of day
        expect(userLine).toMatch(/\((?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) (?:morning|afternoon|evening|night)\)/);
    });
});
