import { type query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { retryAsyncGenerator, classifyNetworkError, classifyHttpStatus, type ErrorClassification, type ErrorClassifier, type RetryDeps, type RetryPolicy  } from '@/utils';

interface ClaudeRetryOptions {
    policy?: Partial<RetryPolicy>
    deps?:   Partial<RetryDeps>
}

/**
 * Check if error is a network error by message content (Claude-specific)
 */

function isNetworkErrorByMessage(error: unknown): ErrorClassification | undefined {
    if(!(error instanceof Error)) {
        return undefined;
    }

    const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
    if(!networkErrorCodes.some(code => error.message.includes(code))) {
        return undefined;
    }

    return { category: 'transient', message: error.message };
}

/**
 * Extract error message from unknown value (handles strings, Error instances, and plain objects)
 */
function getErrorMessage(error: unknown): string {
    if(typeof error === 'string' && error) {
        return error;
    }

    if(typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) {
        return error.message;
    }

    return 'Unknown error';
}

/**
 * Classifier for Claude SDK errors.
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) -> transient
 * - HTTP 502, 503, 504 -> transient
 * - HTTP 429 -> rate_limited (extracts retryAfterMs if available, including from headers)
 * - HTTP 4xx (except 429) -> permanent
 * - All other errors -> permanent
 */
export function classifyClaudeError(error: unknown): ErrorClassification {
    // Handle non-object errors as permanent.
    // All downstream classifiers (classifyNetworkError, classifyHttpStatus) also guard against
    // non-objects, so removing this check produces the same 'permanent' result — equivalent mutants.
    // Stryker disable ConditionalExpression,LogicalOperator,BlockStatement: Equivalent — downstream classifiers also guard non-objects; removing this guard produces identical results for all tested inputs
    if(!(typeof error === 'object' && error !== null)) {
        return { category: 'permanent', message: getErrorMessage(error) };
    }
    // Stryker restore ConditionalExpression,LogicalOperator,BlockStatement

    // Check for network errors by code property (uses 'Network error' as fallback for Claude)
    const networkByCode = classifyNetworkError(error, 'Network error');
    if(networkByCode) {
        return networkByCode;
    }

    // Check for network errors by message content (Claude-specific)
    const networkByMessage = isNetworkErrorByMessage(error);
    if(networkByMessage) {
        return networkByMessage;
    }

    // Check for HTTP status errors (includes header-based retry-after)
    const httpStatus = classifyHttpStatus(error, []);
    if(httpStatus) {
        return httpStatus;
    }

    // Default to permanent for unknown errors
    return { category: 'permanent', message: getErrorMessage(error) };
}

/**
 * Creates a retryable version of the Claude SDK query function.
 * Wraps the query generator with retry logic that:
 * - Restarts the entire stream from the beginning on transient errors
 * - Uses classifyClaudeError for error classification
 * - Defaults to 2 max attempts (1 retry) for Claude calls
 *
 * @param queryFn - The Claude SDK query function to wrap
 * @param options - Retry policy and dependencies
 * @returns A retryable query function with the same signature as the original
 */
export function createRetryableQuery(
    queryFn: typeof query,
    options: ClaudeRetryOptions = {}
): typeof query {
    const { policy: policyInput = {}, deps = {} } = options;

    // Default to 2 max attempts (1 retry) for Claude calls
    const policy: Partial<RetryPolicy> = {
        maxAttempts: 2,
        ...policyInput,
    };

    const classifier: ErrorClassifier = classifyClaudeError;

    return (params: Parameters<typeof queryFn>[0]): Query => {
        // Create a generator factory that calls the original query function
        const generatorFactory = () => queryFn(params);

        // Wrap with retry logic
        return retryAsyncGenerator(generatorFactory, {
            policy,
            classifier,
            deps,
        }) as Query;
    };
}
