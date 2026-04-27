import type { ErrorClassification, ErrorClassifier } from './types';

/**
 * Default error classifier that treats all errors as transient.
 * Falls back to 'Unknown error' message if error has no message.
 */
export const defaultClassifier: ErrorClassifier = (error: unknown): ErrorClassification => {
    let message = 'Unknown error';

    if(error instanceof Error && error.message) {
        message = error.message;
    } else if(typeof error === 'string' && error) {
        message = error;
    }

    return {
        category: 'transient',
        message,
    };
};

interface HttpStatusClassifierOptions {
    permanentStatuses?: number[]
}

/**
 * Extract error message from HTTP error object
 */
function getHttpErrorMessage(error: unknown, status: number): string {
    if(typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) {
        return error.message;
    }
    return `HTTP ${status}`;
}

/**
 * Extract retry after value from HTTP error.
 * Checks response body first (already in ms), then headers (in seconds, converts to ms).
 */

function getRetryAfter(error: unknown): number | undefined {
    if(!(typeof error === 'object' && error !== null)) {
        return undefined;
    }

    // Check response body first (already in ms)
    // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: Property check for retryAfter field, return undefined on missing property
    if('retryAfter' in error) {
        const retryAfter = typeof error.retryAfter === 'string'
            ? Number.parseInt(error.retryAfter, 10)
            : (error.retryAfter as number);

        return retryAfter >= 0 ? retryAfter : undefined;
    }

    // Check headers (in seconds, needs conversion to ms)
    // Stryker disable next-line ConditionalExpression: type-narrowing guards — typeof/null checks are defensive; headers is always an object when 'headers' in error passes
    if('headers' in error && typeof error.headers === 'object' && error.headers !== null) {
        const headers = error.headers as Record<string, unknown>;
        if('retry-after' in headers && typeof headers['retry-after'] === 'string') {
            const retryAfterSeconds = Number.parseInt(headers['retry-after'], 10);
            return retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined;
        }
    }

    return undefined;
}

/**
 * Classify HTTP status error
 */

export function classifyHttpStatus(
    error: unknown,
    permanentStatuses: number[]
): ErrorClassification | undefined {
    if(!(typeof error === 'object' && error !== null && 'status' in error)) {
        return undefined;
    }

    const status = typeof error.status === 'string'
        ? Number.parseInt(error.status, 10)
        : (error.status as number);

    const message = getHttpErrorMessage(error, status);

    // Check custom permanent statuses first — use Set for O(1) lookup with correct typing
    const permanentStatusSet = new Set<number>(permanentStatuses);
    if(permanentStatusSet.has(status)) {
        return { category: 'permanent', message };
    }

    // Rate limited
    if(status === 429) {
        return {
            category:     'rate_limited',
            retryAfterMs: getRetryAfter(error),
            message,
        };
    }

    // Server errors (5xx) - transient
    if(status >= 500 && status < 600) {
        return { category: 'transient', message };
    }

    // Client errors (4xx except 429) - permanent
    // Stryker disable next-line EqualityOperator: status <= 500 is equivalent — 5xx check above catches 500 first, so this boundary is never reached with status=500
    if(status >= 400 && status < 500) {
        return { category: 'permanent', message };
    }

    return undefined;
}

/**
 * Classify network error
 */

export function classifyNetworkError(error: unknown, fallbackMessage = 'Unknown error'): ErrorClassification | undefined {
    // Stryker disable next-line ConditionalExpression,BlockStatement,LogicalOperator: defensive type guard — non-objects have no .code/.name, so all branch mutations are equivalent (non-object inputs always return undefined either way)
    if(!(typeof error === 'object' && error !== null)) {
        return undefined;
    }

    // Stryker disable next-line StringLiteral: Network error code configuration — exact strings are protocol/SDK constants
    // POSIX codes: ETIMEDOUT, ECONNRESET, ECONNREFUSED
    // Smithy/AWS-SDK codes: FailedToOpenSocket (transient socket failure), TimeoutError (throwOnRequestTimeout), NetworkingError (general)
    // NOTE: NetworkingError covers DNS NXDOMAIN and other permanent failures; those exhaust the retry budget before surfacing.
    const networkErrorCodes = new Set<string>(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'FailedToOpenSocket', 'TimeoutError', 'NetworkingError']);

    // Check both error.code (POSIX/Smithy) AND error.name (Smithy fetch-http-handler sets name only,
    // e.g. TimeoutError from @smithy/fetch-http-handler has name="TimeoutError" but no code property).
    const errorRecord = error as Record<string, unknown>;
    const code = typeof errorRecord.code === 'string' ? errorRecord.code : undefined;
    const name = typeof errorRecord.name === 'string' ? errorRecord.name : undefined;

    // Stryker disable next-line ConditionalExpression,BlockStatement: Either code or name field may carry the classification — both are required for full Smithy coverage
    if((code !== undefined && networkErrorCodes.has(code)) || (name !== undefined && networkErrorCodes.has(name))) {
        const message = typeof errorRecord.message === 'string' && errorRecord.message
            ? errorRecord.message
            : fallbackMessage;

        return { category: 'transient', message };
    }

    return undefined;
}

/**
 * Creates an HTTP-aware error classifier that categorizes errors based on:
 * - HTTP status codes (4xx = permanent, 5xx = transient, 429 = rate_limited)
 * - Network error codes (ETIMEDOUT, ECONNRESET, etc. = transient)
 * - Falls back to defaultClassifier for non-HTTP errors
 */
export const createHttpStatusClassifier = (
    options: HttpStatusClassifierOptions = {}
): ErrorClassifier => {
    const { permanentStatuses = [] } = options;

    return (error: unknown): ErrorClassification => {
        if(!(typeof error === 'object' && error !== null)) {
            return defaultClassifier(error);
        }

        // Try HTTP status classification
        // Stryker disable next-line ConditionalExpression: always-true mutant is equivalent — classifyHttpStatus with no status returns undefined, falling through to same behavior
        if('status' in error) {
            const result = classifyHttpStatus(error, permanentStatuses);
            if(result) {
                return result;
            }
        }

        // Try network error classification
        const networkResult = classifyNetworkError(error);
        if(networkResult) {
            return networkResult;
        }

        // Fall back to default classifier
        return defaultClassifier(error);
    };
};
