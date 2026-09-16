import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { TokenBucketRateLimiter } from '../../../../src/services/rate-limiters/token-bucket';

describe('TokenBucketRateLimiter', () => {
    // Use fake timers to control Date.now()
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-06-15T10:00:00.000Z'));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        test('should use default capacity of 24', () => {
            const limiter = new TokenBucketRateLimiter();
            expect(limiter.tokensRemaining()).toBe(24);
        });

        test('should accept custom capacity', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 10 });
            expect(limiter.tokensRemaining()).toBe(10);
        });

        test('should accept custom refillRatePerHour', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 6, refillRatePerHour: 2 });
            expect(limiter.tokensRemaining()).toBe(6);
        });

        test('should start not at limit when capacity > 0', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 5 });
            expect(limiter.isAtLimit()).toBe(false);
        });

        test('should use default refillRatePerHour of 1 per hour', () => {
            const limiter = new TokenBucketRateLimiter();
            for(let i = 0; i < 24; i++) {
                limiter.increment();
            }
            expect(limiter.tokensRemaining()).toBe(0);

            // One elapsed hour refills exactly 1 token at the default rate
            jest.setSystemTime(new Date('2025-06-15T11:00:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(1);

            // A second elapsed hour refills exactly 1 more
            jest.setSystemTime(new Date('2025-06-15T12:00:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(2);
        });
    });

    describe('isAtLimit()', () => {
        test('should return false when tokens remain', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 5 });
            expect(limiter.isAtLimit()).toBe(false);
        });

        test('should return true when tokens are 0', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 2 });
            limiter.increment();
            limiter.increment();
            expect(limiter.isAtLimit()).toBe(true);
        });

        test('should return false after refill restores a token', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 1, refillRatePerHour: 1 });
            limiter.increment();
            expect(limiter.isAtLimit()).toBe(true);

            // Advance time by 1 hour — refills 1 token
            jest.setSystemTime(new Date('2025-06-15T11:00:00.000Z'));
            expect(limiter.isAtLimit()).toBe(false);
        });
    });

    describe('tokensRemaining()', () => {
        test('should return full capacity initially', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 8 });
            expect(limiter.tokensRemaining()).toBe(8);
        });

        test('should decrease by 1 after increment', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 8 });
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(7);
        });

        test('should return 0 when exhausted', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 2 });
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(0);
        });

        test('should never go below 0', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 1 });
            limiter.increment();
            limiter.increment(); // extra increment on empty bucket
            expect(limiter.tokensRemaining()).toBe(0);
        });
    });

    describe('increment()', () => {
        test('should consume 1 token', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 10 });
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(9);
        });

        test('should consume multiple tokens', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 10 });
            limiter.increment();
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(7);
        });

        test('should not go below 0 when bucket is empty', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 1 });
            limiter.increment();
            limiter.increment(); // second call on empty bucket
            expect(limiter.tokensRemaining()).toBe(0);
        });

        test('should apply elapsed-time refill before decrement', () => {
            // Start with capacity 4, use 3 tokens
            const limiter = new TokenBucketRateLimiter({ capacity: 4, refillRatePerHour: 2 });
            limiter.increment();
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(1);

            // Advance 1 hour: +2 tokens => 3 tokens, then increment => 2 tokens
            jest.setSystemTime(new Date('2025-06-15T11:00:00.000Z'));
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(2);
        });

        test('should cap refill at reservoir capacity', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 4, refillRatePerHour: 2 });
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(3);

            // Advance 10 hours: would be +20 tokens but capped at capacity 4
            jest.setSystemTime(new Date('2025-06-16T20:00:00.000Z'));
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(3); // capped at 4, then consumed 1
        });
    });

    describe('token refill', () => {
        test('refills only after each complete hour has elapsed', () => {
            let now = 0;
            const limiter = new TokenBucketRateLimiter({ capacity: 3, refillRatePerHour: 1, now: () => now });
            limiter.increment();
            limiter.increment();
            limiter.increment();

            now = 3_600_000 - 1;
            expect(limiter.tokensRemaining()).toBe(0);

            now = 3_600_000;
            expect(limiter.tokensRemaining()).toBe(1);

            now = 7_200_000 - 1;
            expect(limiter.tokensRemaining()).toBe(1);
        });

        test('zero refill rate leaves the bucket empty over time', () => {
            let now = 0;
            const limiter = new TokenBucketRateLimiter({ capacity: 1, refillRatePerHour: 0, now: () => now });
            limiter.increment();
            now = 86_400_000;
            expect(limiter.tokensRemaining()).toBe(0);
        });

        test('does not lose tokens when the clock moves backwards', () => {
            let now = 3_600_000;
            const limiter = new TokenBucketRateLimiter({ capacity: 3, refillRatePerHour: 1, now: () => now });
            limiter.increment();
            now = 0;
            expect(limiter.tokensRemaining()).toBe(2);
            now = 7_200_000;
            expect(limiter.tokensRemaining()).toBe(3);
        });

        test('preserves fractional refill time across reads', () => {
            let now = 0;
            const limiter = new TokenBucketRateLimiter({ capacity: 3, refillRatePerHour: 2, now: () => now });
            limiter.increment();
            limiter.increment();
            now = 30 * 60 * 1000;
            expect(limiter.tokensRemaining()).toBe(2);
            now = 45 * 60 * 1000;
            expect(limiter.tokensRemaining()).toBe(2);
            now = 60 * 60 * 1000;
            expect(limiter.tokensRemaining()).toBe(3);
        });

        test('rounds fractional millisecond refill boundaries to avoid an early token', () => {
            let now = 0;
            const limiter = new TokenBucketRateLimiter({ capacity: 10, refillRatePerHour: 7, now: () => now });
            for(let index = 0; index < 10; index++) {
                limiter.increment();
            }

            now = 514_286;
            expect(limiter.tokensRemaining()).toBe(1);

            now = 1_028_571;
            expect(limiter.tokensRemaining()).toBe(1);
        });

        test('should refill 1 token per hour with default rate', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 24, refillRatePerHour: 1 });
            // Drain it
            for(let i = 0; i < 24; i++) {
                limiter.increment();
            }
            expect(limiter.tokensRemaining()).toBe(0);

            // Advance 6 hours
            jest.setSystemTime(new Date('2025-06-15T16:00:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(6);
        });

        test('should not refill partial hours (floor semantics)', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 10, refillRatePerHour: 1 });
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(8);

            // Advance 30 minutes — less than 1 hour, no refill
            jest.setSystemTime(new Date('2025-06-15T10:30:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(8);
        });

        test('should refill based on elapsed hours (floor)', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 10, refillRatePerHour: 2 });
            limiter.increment();
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(7);

            // Advance 1.5 hours: floor(1.5 * 2) = floor(3) = 3 tokens refilled => 7 + 3 = 10, capped at 10
            jest.setSystemTime(new Date('2025-06-15T11:30:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(10);
        });

        test('should not exceed capacity on refill', () => {
            const limiter = new TokenBucketRateLimiter({ capacity: 5, refillRatePerHour: 10 });
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(4);

            // Advance 1 hour: +10 tokens, capped at 5
            jest.setSystemTime(new Date('2025-06-15T11:00:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(5);
        });

        test('should use injected clock source for testability', () => {
            let fakeNow = 1_000_000;
            const limiter = new TokenBucketRateLimiter({ capacity: 4, refillRatePerHour: 1, now: () => fakeNow });

            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(3);

            // Advance 2 hours via fake clock: 3 + 2 = 5, capped at capacity 4
            fakeNow += 2 * 3600 * 1000;
            expect(limiter.tokensRemaining()).toBe(4);
        });
    });

    describe('injected clock', () => {
        test('should use Date.now() by default', () => {
            // Fake timers are active, so Date.now() is controlled
            const limiter = new TokenBucketRateLimiter({ capacity: 6, refillRatePerHour: 1 });
            limiter.increment();
            limiter.increment();
            expect(limiter.tokensRemaining()).toBe(4);

            // Advance via jest fake timers (+2h)
            jest.setSystemTime(new Date('2025-06-15T12:00:00.000Z'));
            expect(limiter.tokensRemaining()).toBe(6); // 4 + 2 = 6, capped at 6
        });
    });
});
