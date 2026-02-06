/**
 * Tag Index Reconciliation Error Classes
 *
 * Hierarchical error classes for reconciliation operations.
 * All errors extend ReconciliationError which provides error codes for programmatic handling.
 */

/**
 * Base error class for all reconciliation errors
 */
export class ReconciliationError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'ReconciliationError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        /* Stryker disable ConditionalExpression: V8-specific runtime feature detection */
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
        /* Stryker restore ConditionalExpression */
    }
}

/**
 * Error thrown when DynamoDB operations are throttled during reconciliation
 */
export class ReconciliationThrottledError extends ReconciliationError {
    constructor(public readonly operation: string) {
        super(`Reconciliation throttled during ${operation}`, 'RECONCILIATION_THROTTLED');
        this.name = 'ReconciliationThrottledError';
    }
}
