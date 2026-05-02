import { defaultClassifier } from './classifier';
import { setupRetryContext } from './defaults';
import { calculateDelay } from './delay';
import { type ErrorClassifier, type RetryDeps, type RetryPolicy } from './types';

interface RetryAsyncGeneratorOptions {
    policy?:     Partial<RetryPolicy>
    classifier?: ErrorClassifier
    deps?:       Partial<RetryDeps>
}

/**
 * Retries an async generator with exponential backoff, jitter, and error classification.
 * On error, the generator is restarted from the beginning.
 *
 * @param generatorFactory - Function that creates a fresh async generator
 * @param options - Configuration options
 * @yields Values from the generator
 * @throws The last error if all retry attempts are exhausted or a permanent error occurs
 *
 * @warning Total wall-clock time grows exponentially with maxAttempts due to exponential backoff.
 * With default settings (1s base delay), maxAttempts=5 takes ~15s total, maxAttempts=10 takes
 * ~17 minutes. Consider the total wall-clock time impact when setting maxAttempts.
 */
export async function* retryAsyncGenerator<T>(
    generatorFactory: () => AsyncGenerator<T>,
    options: RetryAsyncGeneratorOptions = {}
): AsyncGenerator<T> {
    const { classifier = defaultClassifier, policy: policyInput = {}, deps: depsInput = {} } = options;

    const { policy, deps } = setupRetryContext(policyInput, depsInput);

    const { maxAttempts } = policy;
    const { logger, sleep, now } = deps;

    const startTime = now();

    for(let attempt = 1; attempt <= maxAttempts; /* Stryker disable next-line UpdateOperator: Decrement creates infinite retry loop */ attempt++) {
        const generator = generatorFactory();

        try {
            // Yield all values from the generator
            // eslint-disable-next-line no-await-in-loop -- sequential: retry loop, generator replayed from start on error
            for await (const value of generator) {
                yield value;
            }

            // Generator completed successfully
            return;
        } catch (error) {
            // Classify the error
            const classification = classifier(error);
            const { category, message: errorMessage, retryAfterMs } = classification;

            // Permanent errors are not retried
            if(category === 'permanent') {
                logger.error({
                    // Stryker disable next-line StringLiteral: Log message for observability
                    msg:       'Retry aborted due to permanent error',
                    category,
                    errorMessage,
                    attempt,
                    // Stryker disable next-line ArithmeticOperator: Elapsed time calculation
                    elapsedMs: now() - startTime,
                });
                throw error;
            }

            // If we've exhausted all attempts, throw
            if(attempt === maxAttempts) {
                logger.error({
                    // Stryker disable next-line StringLiteral: Log message for observability
                    msg:       'Max retry attempts exhausted',
                    attempts:  maxAttempts,
                    errorMessage,
                    // Stryker disable next-line ArithmeticOperator: Elapsed time calculation
                    elapsedMs: now() - startTime,
                });
                throw error;
            }

            // Calculate delay for next retry.
            // Take the larger of the server's retry-after hint and the exponential backoff so that:
            // - A zero-valued server hint (clock skew / just-rolled-over window) does not bypass backoff.
            // - A large server hint (long rate-limit window) is respected even when backoff is smaller.
            const delayMs = Math.max(retryAfterMs ?? 0, calculateDelay(attempt, policy));

            // Log retry attempt
            logger.warn({
                // Stryker disable next-line StringLiteral: Log message for observability
                msg:       'Retrying generator after error',
                attempt,
                maxAttempts,
                category,
                errorMessage,
                delayMs,
                // Stryker disable next-line ArithmeticOperator: Time subtraction for elapsed calculation
                elapsedMs: now() - startTime,
            });

            // Wait before retrying
            // eslint-disable-next-line no-await-in-loop -- sequential: retry backoff delay between attempts
            await sleep(delayMs);

            // Loop will restart generator from beginning
        }
    }
}
