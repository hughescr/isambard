import { defaultClassifier } from './classifier';
import { calculateDelay } from './delay';
import { type ErrorClassifier, type RetryDeps, type RetryPolicy, retryPolicySchema  } from './types';

interface RetryAsyncOptions {
    policy?:     Partial<RetryPolicy>
    classifier?: ErrorClassifier
    deps?:       Partial<RetryDeps>
}

// Stryker disable all: Default fallback for incomplete DI - used in production only
const defaultDeps: RetryDeps = {
    sleep:  (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now:    () => Date.now(),
    logger: {
        warn:  () => undefined,
        error: () => undefined,
        debug: () => undefined,
    },
};
// Stryker restore all

/**
 * Retries an async operation with exponential backoff, jitter, and error classification.
 *
 * @param operation - The async operation to retry
 * @param options - Configuration options
 * @returns The result of the operation
 * @throws The last error if all retry attempts are exhausted or a permanent error occurs
 *
 * @warning Total wall-clock time grows exponentially with maxAttempts due to exponential backoff.
 * With default settings (1s base delay), maxAttempts=5 takes ~15s total, maxAttempts=10 takes
 * ~17 minutes. Consider the total wall-clock time impact when setting maxAttempts.
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

    for(let attempt = 1; attempt <= maxAttempts; /* Stryker disable next-line UpdateOperator: Decrement creates infinite retry loop */ attempt++) {
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop, each attempt depends on prior failure
            return await operation();
        } catch (error) {
            lastError = error;

            // Classify the error
            const classification = classifier(error);
            const { category, message: errorMessage, retryAfterMs } = classification;

            // Permanent errors are not retried
            if(category === 'permanent') {
                // Stryker disable next-line ArithmeticOperator: Elapsed time calculation for logging
                logger.error({
                    msg:       'Retry aborted due to permanent error',
                    category,
                    errorMessage,
                    attempt,
                    // Stryker disable next-line ArithmeticOperator: Elapsed time for logging
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
                    // Stryker disable next-line ArithmeticOperator: Elapsed time calculation
                    elapsedMs: now() - startTime,
                });
                throw error;
            }

            // Calculate delay for next retry
            const delayMs = retryAfterMs ?? calculateDelay(attempt, policy);

            logger.warn({
                // Stryker disable next-line StringLiteral: log message string is observability-only configuration
                msg:       'Retrying after error',
                attempt,
                maxAttempts,
                category,
                errorMessage,
                delayMs,
                // Stryker disable next-line ArithmeticOperator: Elapsed time calculation for logging
                elapsedMs: now() - startTime,
            });

            // Wait before retrying
            // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between attempts
            await sleep(delayMs);
        }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError;
}
