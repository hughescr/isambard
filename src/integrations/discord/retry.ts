/**
 * Discord Retry Logic
 *
 * Provides retry logic specifically for Discord operations.
 * Only retries transient network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED).
 * Does NOT retry rate limit errors (429) - Discord.js handles those internally.
 *
 * Key design principles:
 * - Network errors are transient and worth retrying
 * - Rate limit errors are permanent (Discord.js auto-retries with proper retry-after)
 * - All other Discord errors are permanent (invalid input, permissions, etc.)
 */
import { retryAsync, type ErrorClassification, type ErrorClassifier, type RetryPolicy, type RetryDeps  } from '@/utils';

export interface DiscordRetryOptions {
    policy?: Partial<RetryPolicy>
    deps?:   Partial<RetryDeps>
}

/**
 * Classify Discord errors for retry logic.
 *
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) -> transient (retry)
 * - Rate limit errors (RateLimitError) -> permanent (Discord.js handles internally)
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

    // Check for network errors (transient)
    if(typeof error === 'object' && error !== null && 'code' in error) {
        const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
        if(typeof error.code === 'string' && networkErrorCodes.includes(error.code)) {
            return {
                category: 'transient',
                message,
            };
        }
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
export const discordErrorClassifier: ErrorClassifier = classifyDiscordError;

/**
 * Retry a Discord operation with exponential backoff.
 * Only retries transient network errors. Rate limit errors and other errors are not retried.
 *
 * @param operation The async operation to retry
 * @param operationName Name for logging purposes
 * @param options Retry configuration (policy, deps)
 * @returns The result of the operation
 * @throws The error if all retries are exhausted or a permanent error occurs
 *
 * @example
 * ```typescript
 * const message = await withDiscordRetry(
 *   () => channel.send('Hello'),
 *   'send-message',
 *   { policy: { maxAttempts: 5 } }
 * );
 * ```
 */
export async function withDiscordRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    options: DiscordRetryOptions = {}
): Promise<T> {
    const { policy = {}, deps = {} } = options;

    return retryAsync(operation, {
        classifier: discordErrorClassifier,
        policy,
        deps,
    });
}
