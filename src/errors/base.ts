/**
 * Base error class for all Isambard errors.
 *
 * Provides a consistent API with:
 * - `code`: ErrorCode enum value for programmatic handling
 * - `context`: Typed bag for error-specific data
 * - Stack trace support via Error.captureStackTrace
 */

import { ErrorCode } from './codes';

export class IsambardError extends Error {
    // eslint-disable-next-line @stylistic/key-spacing -- The rule mistakes this typed class field for an object key.
    public readonly code: ErrorCode;
    public readonly context?: Record<string, unknown>;

    constructor(
        message: string,
        code: ErrorCode,
        context?: Record<string, unknown>
    ) {
        super(message);
        this.code = code;
        this.context = context;
        this.name = 'IsambardError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        const errorWithOptionalCapture: { captureStackTrace?: typeof Error.captureStackTrace } = Error;
        if(errorWithOptionalCapture.captureStackTrace) {
            errorWithOptionalCapture.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when an invariant that should always hold is violated.
 * These guards exist to catch bugs that should be unreachable in correct code;
 * if thrown, it indicates a logic error in the calling code.
 *
 * @example
 * // After a length check guarantees arr is non-empty, noUncheckedIndexedAccess
 * // forces an explicit guard — use this error to mark it as unreachable:
 * if (arr[0] === undefined) throw new InvariantViolationError('loadFoo', 'arr[0] undefined despite non-empty length guard');
 */
export class InvariantViolationError extends IsambardError {
    declare public readonly context: { location: string, invariant: string };

    constructor(location: string, invariant: string) {
        super(
            `Invariant violated in ${location}: ${invariant}`,
            ErrorCode.INVARIANT_VIOLATION,
            { location, invariant }
        );
        this.name = 'InvariantViolationError';
    }
}
