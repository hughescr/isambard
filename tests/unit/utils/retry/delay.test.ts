/* eslint-disable lodash/prefer-constant -- test uses simple arrow functions for clarity */
import { describe, expect, it, mock } from 'bun:test';
import { calculateDelay } from '../../../../src/utils/retry/delay';
import type { RetryPolicy } from '../../../../src/utils/retry/types';

describe.concurrent('calculateDelay', () => {
    const defaultPolicy: RetryPolicy = {
        maxAttempts:       3,
        baseDelayMs:       1000,
        maxDelayMs:        30000,
        backoffMultiplier: 2,
        jitterFraction:    0.1,
    };

    describe('Exponential backoff without jitter', () => {
        it('should calculate delay for attempt 1 as baseDelayMs', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(1, defaultPolicy, random);

            expect(delay).toBe(1000);
        });

        it('should calculate delay for attempt 2 with backoff multiplier', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(2, defaultPolicy, random);

            expect(delay).toBe(2000); // 1000 * 2^1
        });

        it('should calculate delay for attempt 3 with backoff multiplier', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(3, defaultPolicy, random);

            expect(delay).toBe(4000); // 1000 * 2^2
        });

        it('should calculate delay for attempt 4 with backoff multiplier', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(4, defaultPolicy, random);

            expect(delay).toBe(8000); // 1000 * 2^3
        });
    });

    describe('Jitter calculation', () => {
        it('should add positive jitter when random is 1', () => {
            const random = () => 1; // Max positive jitter
            const delay = calculateDelay(1, defaultPolicy, random);

            // delay * (1 + jitterFraction * (1 * 2 - 1))
            // 1000 * (1 + 0.1 * 1) = 1100
            expect(delay).toBe(1100);
        });

        it('should add negative jitter when random is 0', () => {
            const random = () => 0; // Max negative jitter
            const delay = calculateDelay(1, defaultPolicy, random);

            // delay * (1 + jitterFraction * (0 * 2 - 1))
            // 1000 * (1 + 0.1 * -1) = 900
            expect(delay).toBe(900);
        });

        it('should apply no jitter when random is 0.5', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(1, defaultPolicy, random);

            // delay * (1 + jitterFraction * (0.5 * 2 - 1))
            // 1000 * (1 + 0.1 * 0) = 1000
            expect(delay).toBe(1000);
        });

        it('should apply jitter to exponentially backed off delay', () => {
            const random = () => 1; // Max positive jitter
            const delay = calculateDelay(2, defaultPolicy, random);

            // Base: 1000 * 2^1 = 2000
            // With jitter: 2000 * (1 + 0.1 * 1) = 2200
            expect(delay).toBe(2200);
        });

        it('should handle zero jitterFraction', () => {
            const policy: RetryPolicy = { ...defaultPolicy, jitterFraction: 0 };
            const random = () => Math.random(); // Any random value
            const delay = calculateDelay(1, policy, random);

            expect(delay).toBe(1000); // No jitter applied
        });

        it('should handle maximum jitterFraction (0.5)', () => {
            const policy: RetryPolicy = { ...defaultPolicy, jitterFraction: 0.5 };
            const random = () => 1; // Max positive jitter
            const delay = calculateDelay(1, policy, random);

            // 1000 * (1 + 0.5 * 1) = 1500
            expect(delay).toBe(1500);
        });
    });

    describe('Max delay capping', () => {
        it('should cap delay at maxDelayMs', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(10, defaultPolicy, random);

            // 1000 * 2^9 = 512000, but capped at 30000
            expect(delay).toBe(30000);
        });

        it('should cap delay at maxDelayMs even with positive jitter', () => {
            const random = () => 1; // Max positive jitter
            const delay = calculateDelay(10, defaultPolicy, random);

            // Without cap: 1000 * 2^9 * 1.1 = 563200
            // Capped at 30000
            expect(delay).toBe(30000);
        });

        it('should not cap delay below maxDelayMs', () => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(3, defaultPolicy, random);

            // 1000 * 2^2 = 4000, below 30000
            expect(delay).toBe(4000);
        });

        it('should cap at maxDelayMs exactly at boundary', () => {
            const policy: RetryPolicy = { ...defaultPolicy, baseDelayMs: 15000, maxDelayMs: 30000 };
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(2, policy, random);

            // 15000 * 2^1 = 30000, exactly at max
            expect(delay).toBe(30000);
        });

        it('should cap at maxDelayMs just above boundary', () => {
            const policy: RetryPolicy = { ...defaultPolicy, baseDelayMs: 15001, maxDelayMs: 30000 };
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(2, policy, random);

            // 15001 * 2^1 = 30002, capped at 30000
            expect(delay).toBe(30000);
        });
    });

    describe('Edge cases', () => {
        it('should handle attempt 0', () => {
            const random = () => 0.5;
            const delay = calculateDelay(0, defaultPolicy, random);

            // 1000 * 2^(-1) = 500
            expect(delay).toBe(500);
        });

        it('should handle minimum baseDelayMs', () => {
            const policy: RetryPolicy = { ...defaultPolicy, baseDelayMs: 100 };
            const random = () => 0.5;
            const delay = calculateDelay(1, policy, random);

            expect(delay).toBe(100);
        });

        it('should handle backoffMultiplier of 1 (no exponential growth)', () => {
            const policy: RetryPolicy = { ...defaultPolicy, backoffMultiplier: 1 };
            const random = () => 0.5;

            expect(calculateDelay(1, policy, random)).toBe(1000);
            expect(calculateDelay(2, policy, random)).toBe(1000);
            expect(calculateDelay(3, policy, random)).toBe(1000);
        });

        it('should handle high backoffMultiplier', () => {
            const policy: RetryPolicy = { ...defaultPolicy, backoffMultiplier: 4 };
            const random = () => 0.5;
            const delay = calculateDelay(2, policy, random);

            // 1000 * 4^1 = 4000
            expect(delay).toBe(4000);
        });

        it('should call random function once', () => {
            const random = mock(() => 0.5);
            calculateDelay(1, defaultPolicy, random);

            expect(random).toHaveBeenCalledTimes(1);
        });

        it('should use Math.random if no random function provided', () => {
            const delay = calculateDelay(1, defaultPolicy);

            // Should be between 900 (min jitter) and 1100 (max jitter)
            expect(delay).toBeGreaterThanOrEqual(900);
            expect(delay).toBeLessThanOrEqual(1100);
        });
    });

    describe('Realistic scenarios', () => {
        it('should produce different delays with different random values', () => {
            const delay1 = calculateDelay(1, defaultPolicy, () => 0);
            const delay2 = calculateDelay(1, defaultPolicy, () => 0.5);
            const delay3 = calculateDelay(1, defaultPolicy, () => 1);

            expect(delay1).toBe(900);
            expect(delay2).toBe(1000);
            expect(delay3).toBe(1100);
            expect(delay1).not.toBe(delay3);
        });

        it('should apply jitter consistently across attempts', () => {
            const random = () => 0.5; // No jitter

            const delay1 = calculateDelay(1, defaultPolicy, random);
            const delay2 = calculateDelay(2, defaultPolicy, random);
            const delay3 = calculateDelay(3, defaultPolicy, random);

            // Verify exponential backoff: each delay is 2x previous
            expect(delay2).toBe(delay1 * 2);
            expect(delay3).toBe(delay2 * 2);
        });
    });
});
