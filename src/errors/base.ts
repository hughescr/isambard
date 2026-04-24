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
    constructor(
        message: string,
        public readonly code: ErrorCode,
        public readonly context?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'IsambardError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Error.captureStackTrace is V8-specific and may not exist in all environments
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
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
            // Stryker disable next-line ObjectLiteral: context bag is debug-only — mutation to {} doesn't affect throw behavior
            { location, invariant }
        );
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'InvariantViolationError';
    }
}
