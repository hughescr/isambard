/**
 * Error hierarchy for the memory-vec-store module.
 */
import { StorageError, ErrorCode } from '@/errors';

/**
 * Base error for all vector index errors.
 */
export class VectorIndexError extends StorageError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.VECTOR_INDEX_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'VectorIndexError';
    }
}

/**
 * Thrown when an operation is attempted on a closed VectorIndex.
 */
export class VectorIndexClosedError extends VectorIndexError {
    constructor() {
        super('VectorIndex has been closed. Create a new VectorIndex to continue.', ErrorCode.VECTOR_INDEX_CLOSED);
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'VectorIndexClosedError';
    }
}

/**
 * Thrown when the VectorIndex cannot be opened (e.g. file permission error, disk full,
 * corrupt database, or schema migration failure).
 */
export class VectorIndexUnavailableError extends VectorIndexError {
    declare public readonly context: { reason: string };

    constructor(reason: string, cause?: Error) {
        // Stryker disable next-line StringLiteral: template literal prefix is cosmetic — the reason string is tested separately
        // Stryker disable next-line ObjectLiteral: context bag is debug-only metadata — mutation to {} doesn't affect throw behavior or message
        super(`VectorIndex unavailable: ${reason}`, ErrorCode.VECTOR_INDEX_UNAVAILABLE, { reason });
        // Stryker disable next-line StringLiteral: error class name is debug-only metadata
        this.name = 'VectorIndexUnavailableError';
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: cause assignment is debug-only metadata — mutation doesn't affect throw behavior
        if(cause !== undefined) {
            this.cause = cause;
        }
    }
}
