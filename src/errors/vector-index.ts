/**
 * Error hierarchy for the memory-vec-store module.
 */
import { ErrorCode } from './codes';
import { StorageError } from './storage';

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
        this.name = 'VectorIndexError';
    }
}

/**
 * Thrown when an operation is attempted on a closed VectorIndex.
 */
export class VectorIndexClosedError extends VectorIndexError {
    constructor() {
        super('VectorIndex has been closed. Create a new VectorIndex to continue.', ErrorCode.VECTOR_INDEX_CLOSED);
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
        super(`VectorIndex unavailable: ${reason}`, ErrorCode.VECTOR_INDEX_UNAVAILABLE, { reason });
        this.name = 'VectorIndexUnavailableError';
        if(cause !== undefined) {
            this.cause = cause;
        }
    }
}
