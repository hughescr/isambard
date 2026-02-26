import { describe, expect, it, mock } from 'bun:test';
import { calculateDelay } from '../../../../src/utils/retry/delay';
import type { RetryPolicy } from '../../../../src/utils/retry/types';

describe.concurrent('calculateDelay', () => {
    const defaultPolicy: RetryPolicy = {
        maxAttempts:       3,
        baseDelayMs:       1000,
        maxDelayMs:        30_000,
        backoffMultiplier: 2,
        jitterFraction:    0.1,
    };

    describe('Exponential backoff without jitter', () => {
        it.each([
            { attempt: 1, expected: 1000, comment: 'baseDelayMs' },
            { attempt: 2, expected: 2000, comment: '1000 * 2^1' },
            { attempt: 3, expected: 4000, comment: '1000 * 2^2' },
            { attempt: 4, expected: 8000, comment: '1000 * 2^3' },
        ])('should calculate delay for attempt $attempt as $expected ($comment)', ({ attempt, expected }) => {
            const random = () => 0.5; // No jitter
            const delay = calculateDelay(attempt, defaultPolicy, random);

            expect(delay).toBe(expected);
        });
    });

    describe('Jitter calculation', () => {
        it.each([
            { random: 0,   expected: 900,  comment: 'max negative jitter: 1000 * (1 + 0.1 * -1)' },
            { random: 0.5, expected: 1000, comment: 'no jitter: 1000 * (1 + 0.1 * 0)' },
            { random: 1,   expected: 1100, comment: 'max positive jitter: 1000 * (1 + 0.1 * 1)' },
        ])('should calculate jitter correctly when random is $random ($comment)', ({ random, expected }) => {
            const randomFn = () => random;
            const delay = calculateDelay(1, defaultPolicy, randomFn);

            expect(delay).toBe(expected);
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
            expect(delay).toBe(30_000);
        });

        it('should cap delay at maxDelayMs even with positive jitter', () => {
            const random = () => 1; // Max positive jitter
            const delay = calculateDelay(10, defaultPolicy, random);

            // Without cap: 1000 * 2^9 * 1.1 = 563200
            // Capped at 30000
            expect(delay).toBe(30_000);
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
});
