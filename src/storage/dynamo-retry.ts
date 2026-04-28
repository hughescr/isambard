/**
 * DynamoDB Timeout Logic
 *
 * Provides timeout wrapper for DynamoDB operations.
 * The AWS SDK handles retries internally (maxAttempts: 3 with exponential backoff).
 * This module adds an outer timeout to prevent indefinite waiting and logs retry events.
 *
 * Key design principles:
 * - AWS SDK handles retries automatically (maxAttempts: 3)
 * - This timeout is a safety net to prevent hanging operations
 * - Timeout throws DynamoTimeoutError for observability
 * - Middleware logs timing for all operations
 * - On network-classified errors, signals health registry via injected notifier
 */

import { DynamoTimeoutError } from '@/errors';
import { classifyNetworkError, type RetryLogger  } from '@/utils';

export interface DynamoTimeoutOptions {
    timeoutMs: number
    operation: string
    logger?:   RetryLogger
}

/**
 * Module-level health notifier for DynamoDB connectivity failures.
 *
 * Set once at startup via {@link setDynamoHealthNotifier}.  When a network-classified
 * error (or DynamoTimeoutError) escapes `withDynamoTimeout`, the notifier is called
 * BEFORE re-throwing so the health registry can transition the service to offline and
 * start the reconnection loop.
 *
 * Not set in tests unless explicitly injected — callers without a notifier just
 * propagate errors as before.
 */
let _healthNotifier: ((error: unknown) => void) | undefined;

/**
 * Register a health notifier that `withDynamoTimeout` calls when a network-classified
 * error (including {@link DynamoTimeoutError}) exhausts retries.
 *
 * Typically called once from `createApp()` after the health registry is created.
 * Passing `undefined` clears the notifier (useful in tests).
 */
export function setDynamoHealthNotifier(fn: ((error: unknown) => void) | undefined): void {
    _healthNotifier = fn;
}

/**
 * Returns true when the error should trigger a CONNECTION_LOST health event.
 *
 * Covers two cases:
 * 1. Network errors classified by {@link classifyNetworkError} (ETIMEDOUT, FailedToOpenSocket, etc.)
 * 2. Our own {@link DynamoTimeoutError}, which means the socket was wedged long enough
 *    to exceed the outer timeout — also a network-level symptom.
 */
function isNetworkError(error: unknown): boolean {
    // Stryker disable next-line ConditionalExpression: DynamoTimeoutError instanceof check is paired with classifyNetworkError — both branches needed for full coverage
    if(error instanceof DynamoTimeoutError) {
        return true;
    }
    return classifyNetworkError(error) !== undefined;
}

/**
 * Wrap a DynamoDB operation with a timeout.
 *
 * The AWS SDK handles retries internally (maxAttempts: 3 with exponential backoff).
 * This adds an outer timeout to prevent indefinite waiting.
 *
 * When an error is network-classified (or is a DynamoTimeoutError), the module-level
 * health notifier (if set via {@link setDynamoHealthNotifier}) is called BEFORE
 * re-throwing so the health registry can react.
 *
 * Implementation notes:
 * - Uses Promise.race() with a timeout promise
 * - On timeout, logs error and throws DynamoTimeoutError
 * - The operation continues running in background (AWS SDK will retry internally)
 *
 * @param operation The DynamoDB operation to execute
 * @param options Configuration including timeout, operation name, and optional logger
 * @returns The result of the operation
 * @throws DynamoTimeoutError if the operation exceeds the timeout
 * @throws Any error thrown by the operation itself
 *
 * @example
 * ```typescript
 * const result = await withDynamoTimeout(
 *   () => docClient.get({ TableName: 'users', Key: { id: '123' } }),
 *   { timeoutMs: 5000, operation: 'GetItem', logger }
 * );
 * ```
 */
export async function withDynamoTimeout<T>(
    operation: () => Promise<T>,
    options: DynamoTimeoutOptions
): Promise<T> {
    const { timeoutMs, operation: operationName, logger } = options;

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
            const error = new DynamoTimeoutError(operationName, timeoutMs);

            // Log timeout if logger provided
            if(logger) {
                logger.error({
                    operation: operationName,
                    timeoutMs,
                    msg:       error.message,
                });
            }

            reject(error);
        }, timeoutMs);
    });

    // Race between operation and timeout
    try {
        return await Promise.race([
            operation(),
            timeoutPromise,
        ]);
    } catch (err) {
        if(_healthNotifier !== undefined && isNetworkError(err)) {
            _healthNotifier(err);
        }
        throw err;
    }
}

export { DynamoTimeoutError } from '@/errors';
