/**
 * Base error class for all Isambard errors.
 *
 * Provides a consistent API with:
 * - `code`: ErrorCode enum value for programmatic handling
 * - `context`: Typed bag for error-specific data
 * - Stack trace support via Error.captureStackTrace
 */

import { type ErrorCode } from './codes';

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
