import _ from 'lodash';
import type { ErrorClassification, ErrorClassifier } from './types';

/**
 * Default error classifier that treats all errors as transient.
 * Falls back to 'Unknown error' message if error has no message.
 */
export const defaultClassifier: ErrorClassifier = (error: unknown): ErrorClassification => {
    let message = 'Unknown error';

    if(_.isError(error) && error.message) {
        message = error.message;
    } else if(_.isString(error) && error) {
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
    if('message' in error && _.isString(error.message) && error.message) {
        return error.message;
    }
    return `HTTP ${status}`;
}

/**
 * Extract retry after value from HTTP error
 */
function getRetryAfter(error: object & { retryAfter?: unknown }): number | undefined {
    if(!('retryAfter' in error)) {
        return undefined;
    }

    const retryAfter = _.isString(error.retryAfter)
        ? parseInt(error.retryAfter, 10)
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
    const status = _.isString(error.status)
        ? parseInt(error.status, 10)
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
    if(status >= 400 && status < 500) {
        return { category: 'permanent', message };
    }

    return undefined;
}

/**
 * Classify network error
 */
function classifyNetworkError(error: object & { code?: unknown, message?: unknown }): ErrorClassification | undefined {
    if(!('code' in error)) {
        return undefined;
    }

    const networkErrorCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];

    if(_.isString(error.code) && networkErrorCodes.includes(error.code)) {
        const message = 'message' in error && _.isString(error.message) && error.message
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
        if(!_.isObject(error)) {
            return defaultClassifier(error);
        }

        // Try HTTP status classification
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
