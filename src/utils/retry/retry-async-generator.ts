import _ from 'lodash';
import { defaultClassifier } from './classifier';
import { calculateDelay } from './delay';
import type { ErrorClassifier, RetryDeps, RetryPolicy } from './types';
import { retryPolicySchema } from './types';

interface RetryAsyncGeneratorOptions {
    policy?:     Partial<RetryPolicy>
    classifier?: ErrorClassifier
    deps?:       Partial<RetryDeps>
}

// Stryker disable all: Default fallback for incomplete DI - used in production only
const defaultDeps: RetryDeps = {
    sleep:  (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    now:    () => Date.now(),
    logger: {
        warn:  _.noop.bind(_),
        error: _.noop.bind(_),
        debug: _.noop.bind(_),
    },
};
// Stryker restore all

/**
 * Retries an async generator with exponential backoff, jitter, and error classification.
 * On error, the generator is restarted from the beginning.
 *
 * @param generatorFactory - Function that creates a fresh async generator
 * @param options - Configuration options
 * @yields Values from the generator
 * @throws The last error if all retry attempts are exhausted or a permanent error occurs
 */
export async function* retryAsyncGenerator<T>(
    generatorFactory: () => AsyncGenerator<T>,
    options: RetryAsyncGeneratorOptions = {}
): AsyncGenerator<T> {
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
    let attempt = 0;

    // Stryker disable next-line EqualityOperator,BlockStatement: Retry loop with attempt counter prevents infinite retries
    while(attempt < maxAttempts) {
        // Stryker disable next-line UpdateOperator: Decrement creates infinite retry loop
        attempt++;
        const generator = generatorFactory();

        try {
            // Yield all values from the generator
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

            // Calculate delay for next retry
            const delayMs = retryAfterMs ?? calculateDelay(attempt, policy);

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
            await sleep(delayMs);

            // Loop will restart generator from beginning
        }
    }
}
