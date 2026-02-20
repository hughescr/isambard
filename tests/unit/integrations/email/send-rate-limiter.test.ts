import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { SendRateLimiter } from '../../../../src/integrations/email/send-rate-limiter';

describe('SendRateLimiter', () => {
    // Use fake timers to control Date.now()
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-06-15T10:00:00.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        test('should use default softLimit of 50', () => {
            const limiter = new SendRateLimiter();
            const result  = limiter.check();
            expect(result.limit).toBe(50);
        });

        test('should accept custom softLimit', () => {
            const limiter = new SendRateLimiter({ softLimit: 10 });
            const result  = limiter.check();
            expect(result.limit).toBe(10);
        });

        test('should start with count of 0', () => {
            const limiter = new SendRateLimiter();
            expect(limiter.getCount()).toBe(0);
        });
    });

    describe('check()', () => {
        test('should allow when count is below limit', () => {
            const limiter = new SendRateLimiter({ softLimit: 5 });
            const result  = limiter.check();
            expect(result.allowed).toBe(true);
            expect(result.count).toBe(0);
            expect(result.limit).toBe(5);
        });

        test('should not allow when count equals limit', () => {
            const limiter = new SendRateLimiter({ softLimit: 2 });
            limiter.increment();
            limiter.increment();
            const result = limiter.check();
            expect(result.allowed).toBe(false);
            expect(result.count).toBe(2);
        });

        test('should not allow when count exceeds limit', () => {
            const limiter = new SendRateLimiter({ softLimit: 1 });
            limiter.increment();
            limiter.increment(); // over limit
            const result = limiter.check();
            expect(result.allowed).toBe(false);
            expect(result.count).toBe(2);
        });

        test('should return correct count and limit together', () => {
            const limiter = new SendRateLimiter({ softLimit: 3 });
            limiter.increment();
            const result = limiter.check();
            expect(result.allowed).toBe(true);
            expect(result.count).toBe(1);
            expect(result.limit).toBe(3);
        });
    });

    describe('increment()', () => {
        test('should increment count by 1', () => {
            const limiter = new SendRateLimiter();
            limiter.increment();
            expect(limiter.getCount()).toBe(1);
        });

        test('should increment count multiple times', () => {
            const limiter = new SendRateLimiter();
            limiter.increment();
            limiter.increment();
            limiter.increment();
            expect(limiter.getCount()).toBe(3);
        });
    });

    describe('getCount()', () => {
        test('should return current count', () => {
            const limiter = new SendRateLimiter();
            expect(limiter.getCount()).toBe(0);
            limiter.increment();
            expect(limiter.getCount()).toBe(1);
        });
    });

    describe('daily reset', () => {
        test('should reset count to 0 when day changes', () => {
            const limiter = new SendRateLimiter({ softLimit: 5 });
            limiter.increment();
            limiter.increment();
            expect(limiter.getCount()).toBe(2);

            // Advance time to next day
            jest.setSystemTime(new Date('2025-06-16T00:01:00.000Z'));

            // Count should reset
            expect(limiter.getCount()).toBe(0);
        });

        test('should reset allowed state when day changes', () => {
            const limiter = new SendRateLimiter({ softLimit: 2 });
            limiter.increment();
            limiter.increment();
            expect(limiter.check().allowed).toBe(false);

            // Advance time to next day
            jest.setSystemTime(new Date('2025-06-16T00:01:00.000Z'));

            // Should be allowed again
            expect(limiter.check().allowed).toBe(true);
        });

        test('should reset on increment when day changes', () => {
            const limiter = new SendRateLimiter({ softLimit: 5 });
            limiter.increment();
            limiter.increment();

            // Advance time to next day
            jest.setSystemTime(new Date('2025-06-16T00:01:00.000Z'));

            // Increment on new day should start from 1
            limiter.increment();
            expect(limiter.getCount()).toBe(1);
        });

        test('should not reset within same day', () => {
            const limiter = new SendRateLimiter({ softLimit: 50 });
            limiter.increment();
            limiter.increment();

            // Advance time within same day
            jest.setSystemTime(new Date('2025-06-15T23:59:59.000Z'));

            expect(limiter.getCount()).toBe(2);
        });
    });
});
