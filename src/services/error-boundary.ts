/**
 * Process-level error boundary handlers.
 *
 * Registers handlers for `unhandledRejection` and `uncaughtException` so that
 * all unhandled async and synchronous errors are logged with structured context
 * before the process exits.
 */

/**
 * Logger interface required by registerErrorBoundaries.
 * Matches the shape of the project-wide logger.
 */
export interface ErrorBoundaryLogger {
    error: (obj: object, msg: string) => void
}

/**
 * Result returned by registerErrorBoundaries, allowing the caller to
 * remove the handlers (e.g., during hot-reload or test teardown).
 */
export interface ErrorBoundaryRegistration {
    /** Remove both process handlers registered by registerErrorBoundaries. */
    unregister: () => void
}

/**
 * Registers process-level error boundary handlers to ensure all unhandled
 * rejections and uncaught exceptions are logged with structured context.
 *
 * - `unhandledRejection`: logs the rejection reason; does NOT exit (Node.js
 *   will terminate automatically if no other handler is present in newer versions).
 * - `uncaughtException`: logs the error then calls `process.exit(1)` to ensure
 *   the process terminates after an unrecoverable synchronous exception.
 *
 * Returns an `unregister()` function that removes both handlers. Call it during
 * hot-reload teardown to prevent duplicate handlers accumulating over time.
 *
 * @param boundaryLogger - Structured logger to use for error output
 * @returns Registration object with an `unregister()` method
 */
export function registerErrorBoundaries(boundaryLogger: ErrorBoundaryLogger): ErrorBoundaryRegistration {
    const rejectionHandler = (reason: unknown, _promise: Promise<unknown>): void => {
        // Stryker disable ObjectLiteral,StringLiteral: observability-only logging
        boundaryLogger.error(
            {
                reason: reason instanceof Error ? reason.message : String(reason),
                stack:  reason instanceof Error ? reason.stack : undefined,
            },
            'unhandledRejection: a Promise was rejected without a rejection handler'
        );
        // Stryker restore ObjectLiteral,StringLiteral
    };

    const exceptionHandler = (err: Error): void => {
        // Stryker disable ObjectLiteral,StringLiteral: observability-only logging
        boundaryLogger.error(
            {
                err:   err.message,
                stack: err.stack,
            },
            'uncaughtException: an uncaught synchronous exception was thrown'
        );
        // Stryker restore ObjectLiteral,StringLiteral
        // Exit with failure code after logging — uncaughtException means the process
        // is in an indeterminate state and cannot continue safely.
        // Stryker disable next-line BlockStatement: process.exit is the required side effect
        // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- uncaughtException leaves the process in an indeterminate state; exit is mandatory
        process.exit(1);
    };

    process.on('unhandledRejection', rejectionHandler);
    process.on('uncaughtException', exceptionHandler);

    // Stryker disable next-line ObjectLiteral: return object is a thin wrapper
    return {
        unregister: () => {
            process.removeListener('unhandledRejection', rejectionHandler);
            process.removeListener('uncaughtException', exceptionHandler);
        },
    };
}
