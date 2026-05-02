/**
 * Discord Retry Logic
 *
 * Provides retry logic specifically for Discord operations.
 * Retries transient errors: network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED)
 * and request timeouts (AbortError from Discord.js REST).
 * Does NOT retry rate limit errors (429) - Discord.js handles those internally.
 *
 * Key design principles:
 * - Network errors are transient and worth retrying
 * - Rate limit errors are permanent (Discord.js auto-retries with proper retry-after)
 * - All other Discord errors are permanent (invalid input, permissions, etc.)
 */
import { retryAsync, classifyNetworkError, type ErrorClassification, type ErrorClassifier, type RetryPolicy, type RetryDeps  } from '@/utils';

interface DiscordRetryOptions {
    policy?: Partial<RetryPolicy>
    deps?:   Partial<RetryDeps>
}

/**
 * Classify Discord errors for retry logic.
 *
 * - AbortError -> transient (Discord.js REST timeout after exhausting internal retries)
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) -> transient (retry)
 * - Rate limit errors (429) -> permanent (Discord.js handles internally)
 * - All other errors -> permanent (don't retry)
 *
 * @param error The error to classify
 * @returns ErrorClassification indicating if/how to retry
 */
export function classifyDiscordError(error: unknown): ErrorClassification {
    // Extract message for all error types
    let message = 'Unknown error';

    if(error instanceof Error && error.message) {
        message = error.message;
    } else if(typeof error === 'string' && error) {
        message = error;
    }

    // Check for AbortError (transient - request timed out after Discord.js exhausted internal retries)
    // Stryker disable next-line ConditionalExpression: AbortError check — mutating causes test timeout (all errors treated as transient, retry loop never exits)
    if(error instanceof Error && error.name === 'AbortError') {
        return {
            category: 'transient',
            message,
        };
    }

    // Check for network errors (transient)
    const networkResult = classifyNetworkError(error);
    if(networkResult) {
        // Use the Discord-extracted message (from Error instance or string) for consistency
        return {
            category: 'transient',
            message,
        };
    }

    // All other errors are permanent (invalid input, permissions, rate limits, etc.)
    // Rate limits are also permanent here because Discord.js handles retry internally.
    return {
        category: 'permanent',
        message,
    };
}

/**
 * Discord-specific error classifier instance.
 * Use this classifier when calling retryAsync for Discord operations.
 */
const discordErrorClassifier: ErrorClassifier = classifyDiscordError;

/**
 * Retry a Discord operation with exponential backoff.
 * Only retries transient network errors. Rate limit errors and other errors are not retried.
 *
 * @param operation The async operation to retry
 * @param options Retry configuration (policy, deps)
 * @returns The result of the operation
 * @throws The error if all retries are exhausted or a permanent error occurs
 *
 * @example
 * ```typescript
 * const message = await withDiscordRetry(
 *   () => channel.send('Hello'),
 *   { policy: { maxAttempts: 5 } }
 * );
 * ```
 */
export async function withDiscordRetry<T>(
    operation: () => Promise<T>,
    options: DiscordRetryOptions = {}
): Promise<T> {
    const { policy = {}, deps = {} } = options;

    return retryAsync(operation, {
        classifier: discordErrorClassifier,
        policy,
        deps,
    });
}
