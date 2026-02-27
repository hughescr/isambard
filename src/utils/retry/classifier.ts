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
function getHttpErrorMessage(error: object & { message?: unknown }, status: number): string {
    if('message' in error && typeof error.message === 'string' && error.message) {
        return error.message;
    }
    return `HTTP ${status}`;
}

/**
 * Extract retry after value from HTTP error
 */
function getRetryAfter(error: object & { retryAfter?: unknown }): number | undefined {
    // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: Property check for retryAfter field, return undefined on missing property
    if(!('retryAfter' in error)) {
        return undefined;
    }

    const retryAfter = typeof error.retryAfter === 'string'
        ? Number.parseInt(error.retryAfter, 10)
        : (error.retryAfter as number);

    return retryAfter >= 0 ? retryAfter : undefined;
}

/**
 * Classify HTTP status error
 */
function classifyHttpStatus(
    error: object & { status: unknown, message?: unknown, retryAfter?: unknown },
    permanentStatuses: number[]
): ErrorClassification | undefined {
    const status = typeof error.status === 'string'
        ? Number.parseInt(error.status, 10)
        : (error.status as number);

    const message = getHttpErrorMessage(error, status);

    // Check custom permanent statuses first
    if(permanentStatuses.includes(status)) {
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
function classifyNetworkError(error: object & { code?: unknown, message?: unknown }): ErrorClassification | undefined {
    // Stryker disable next-line ConditionalExpression,StringLiteral,BlockStatement: Property check for code field
    if(!('code' in error)) {
        return undefined;
    }

    // Stryker disable next-line StringLiteral: Network error code configuration — exact strings are protocol constants
    const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];

    if(typeof error.code === 'string' && networkErrorCodes.includes(error.code)) {
        const message = 'message' in error && typeof error.message === 'string' && error.message
            ? error.message
            : 'Unknown error';

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
            const result = classifyHttpStatus(error as object & { status: unknown }, permanentStatuses);
            if(result) {
                return result;
            }
        }

        // Try network error classification
        const networkResult = classifyNetworkError(error as object & { code?: unknown });
        if(networkResult) {
            return networkResult;
        }

        // Fall back to default classifier
        return defaultClassifier(error);
    };
};
