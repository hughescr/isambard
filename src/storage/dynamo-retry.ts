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
 */

import { DynamoTimeoutError } from '@/errors';
import type { RetryLogger } from '@/utils';

export interface DynamoTimeoutOptions {
    timeoutMs: number
    operation: string
    logger?:   RetryLogger
}

/**
 * Wrap a DynamoDB operation with a timeout.
 *
 * The AWS SDK handles retries internally (maxAttempts: 3 with exponential backoff).
 * This adds an outer timeout to prevent indefinite waiting.
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
    return Promise.race([
        operation(),
        timeoutPromise,
    ]);
}

export { DynamoTimeoutError } from '@/errors';
