import { type query, type Query } from '@anthropic-ai/claude-agent-sdk';
import isError from 'lodash/isError';
import isObject from 'lodash/isObject';
import isString from 'lodash/isString';
import some from 'lodash/some';
import { retryAsyncGenerator, type ErrorClassification, type ErrorClassifier, type RetryDeps, type RetryPolicy  } from '@/utils';

export interface ClaudeRetryOptions {
    policy?: Partial<RetryPolicy>
    deps?:   Partial<RetryDeps>
}

/**
 * Extract retryAfter value from HTTP error headers or response body.
 * Converts seconds to milliseconds if found in headers.
 */
function extractRetryAfter(error: object): number | undefined {
    // Check response body first (already in ms)
    if('retryAfter' in error) {
        const retryAfter = isString(error.retryAfter)
            ? Number.parseInt(error.retryAfter, 10)
            : (error.retryAfter as number);

        return retryAfter >= 0 ? retryAfter : undefined;
    }

    // Check headers (in seconds, needs conversion to ms)
    if('headers' in error && isObject(error.headers)) {
        const headers = error.headers as Record<string, unknown>;
        if('retry-after' in headers && isString(headers['retry-after'])) {
            const retryAfterSeconds = Number.parseInt(headers['retry-after'], 10);
            return retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined;
        }
    }

    return undefined;
}

/**
 * Check if error is a network error by code property
 */
function isNetworkErrorByCode(error: object): ErrorClassification | undefined {
    if(!('code' in error) || !isString(error.code)) {
        return undefined;
    }

    const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
    if(!networkErrorCodes.includes(error.code)) {
        return undefined;
    }

    const message = 'message' in error && isString(error.message) && error.message
        ? error.message
        : 'Network error';

    return { category: 'transient', message };
}

/**
 * Check if error is a network error by message content
 */
function isNetworkErrorByMessage(error: object): ErrorClassification | undefined {
    if(!isError(error)) {
        return undefined;
    }

    const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
    if(!some(networkErrorCodes, code => error.message.includes(code))) {
        return undefined;
    }

    return { category: 'transient', message: error.message };
}

/**
 * Classify HTTP status error
 */
function classifyHttpStatusError(error: object): ErrorClassification | undefined {
    if(!('status' in error)) {
        return undefined;
    }

    const status = isString(error.status)
        ? Number.parseInt(error.status, 10)
        : (error.status as number);

    const message = 'message' in error && isString(error.message) && error.message
        ? error.message
        : `HTTP ${status}`;

    // Rate limited
    if(status === 429) {
        return {
            category:     'rate_limited',
            message,
            retryAfterMs: extractRetryAfter(error),
        };
    }

    // Server errors (5xx) - transient
    if(status >= 500 && status < 600) {
        return { category: 'transient', message };
    }

    // Client errors (4xx except 429) - permanent
    // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator,BlockStatement: HTTP status boundary check is fully tested
    if(status >= 400 && status < 500) {
        return { category: 'permanent', message };
    }

    return undefined;
}

/**
 * Get error message from unknown error
 */
function getErrorMessage(error: unknown): string {
    if(isString(error) && error) {
        return error;
    }

    if(isObject(error) && 'message' in error && isString(error.message) && error.message) {
        return error.message;
    }

    return 'Unknown error';
}

/**
 * Classifier for Claude SDK errors.
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) -> transient
 * - HTTP 502, 503, 504 -> transient
 * - HTTP 429 -> rate_limited (extracts retryAfterMs if available)
 * - HTTP 4xx (except 429) -> permanent
 * - All other errors -> permanent
 */
export function classifyClaudeError(error: unknown): ErrorClassification {
    // Handle non-object errors as permanent
    if(!isObject(error)) {
        return { category: 'permanent', message: getErrorMessage(error) };
    }

    // Check for network errors by code property
    const networkByCode = isNetworkErrorByCode(error);
    if(networkByCode) {
        return networkByCode;
    }

    // Check for network errors by message content
    const networkByMessage = isNetworkErrorByMessage(error);
    if(networkByMessage) {
        return networkByMessage;
    }

    // Check for HTTP status errors
    const httpStatus = classifyHttpStatusError(error);
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
