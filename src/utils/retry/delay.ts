import type { RetryPolicy } from './types';

/**
 * Calculates the retry delay for a given attempt using exponential backoff with jitter.
 *
 * Formula: min(baseDelayMs * backoffMultiplier^(attempt - 1) * (1 + jitterFraction * (random() * 2 - 1)), maxDelayMs)
 *
 * @param attemptNumber - The current attempt number (1-indexed)
 * @param policy - The retry policy containing backoff parameters
 * @param random - Optional random function (defaults to Math.random). Returns value in [0, 1]
 * @returns The calculated delay in milliseconds
 */
export const calculateDelay = (
    attemptNumber: number,
    policy: RetryPolicy,
    random: () => number = Math.random
): number => {
    const { baseDelayMs, backoffMultiplier, jitterFraction, maxDelayMs } = policy;

    // Calculate exponential backoff: baseDelayMs * backoffMultiplier^(attempt - 1)
    const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attemptNumber - 1);

    // Apply jitter: delay * (1 + jitterFraction * (random() * 2 - 1))
    // This gives us ±jitterFraction variance
    const jitter = 1 + jitterFraction * (random() * 2 - 1);
    const delayWithJitter = exponentialDelay * jitter;

    // Cap at maxDelayMs
    return Math.min(delayWithJitter, maxDelayMs);
};
