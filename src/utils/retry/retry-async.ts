import _ from 'lodash';
import { defaultClassifier } from './classifier';
import { calculateDelay } from './delay';
import type { ErrorClassifier, RetryDeps, RetryPolicy } from './types';
import { retryPolicySchema } from './types';

interface RetryAsyncOptions {
    policy?:     Partial<RetryPolicy>
    classifier?: ErrorClassifier
    deps?:       Partial<RetryDeps>
}

const defaultDeps: RetryDeps = {
    sleep:  (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    now:    () => Date.now(),
    logger: {
        warn:  _.noop.bind(_),
        error: _.noop.bind(_),
        debug: _.noop.bind(_),
    },
};

/**
 * Retries an async operation with exponential backoff, jitter, and error classification.
 *
 * @param operation - The async operation to retry
 * @param options - Configuration options
 * @returns The result of the operation
 * @throws The last error if all retry attempts are exhausted or a permanent error occurs
 */
export async function retryAsync<T>(
    operation: () => Promise<T>,
    options: RetryAsyncOptions = {}
): Promise<T> {
    const { classifier = defaultClassifier, policy: policyInput = {}, deps: depsInput = {} } = options;

    // Validate and merge policy with defaults
    const policyResult = retryPolicySchema.safeParse(policyInput);
    const policy: RetryPolicy = policyResult.success
        ? policyResult.data
        : retryPolicySchema.parse({});

    // Merge deps with defaults
    const deps: RetryDeps = {
        ...defaultDeps,
        ...depsInput,
    };

    const { maxAttempts } = policy;
    const { logger, sleep, now } = deps;

    const startTime = now();
    let lastError: unknown;

    for(let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await operation();
            return result;
        } catch (error) {
            lastError = error;

            // Classify the error
            const classification = classifier(error);
            const { category, message: errorMessage, retryAfterMs } = classification;

            // Permanent errors are not retried
            if(category === 'permanent') {
                logger.error({
                    msg:       'Retry aborted due to permanent error',
                    category,
                    errorMessage,
                    attempt,
                    elapsedMs: now() - startTime,
                });
                throw error;
            }

            // If we've exhausted all attempts, throw
            if(attempt === maxAttempts) {
                logger.error({
                    msg:       'Max retry attempts exhausted',
                    attempts:  maxAttempts,
                    errorMessage,
                    elapsedMs: now() - startTime,
                });
                throw error;
            }

            // Calculate delay for next retry
            const delayMs = retryAfterMs ?? calculateDelay(attempt, policy);

            // Log retry attempt
            logger.warn({
                msg:       'Retrying after error',
                attempt,
                maxAttempts,
                category,
                errorMessage,
                delayMs,
                elapsedMs: now() - startTime,
            });

            // Wait before retrying
            await sleep(delayMs);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError;
}
