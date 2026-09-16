import { classifyNetworkError, classifyHttpStatus, type ErrorClassification } from '@/utils';

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
    // Stryker restore StringLiteral,ConditionalExpression,BlockStatement

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
