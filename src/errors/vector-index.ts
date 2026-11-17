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

/** Why a vector cross-check run refused to complete. */
export type VectorCrossCheckReason = 'mass_absence' | 'unprocessed_keys_exhausted' | 'requeue_not_converged';

/**
 * Thrown when a vector cross-check run cannot complete safely: a page the table reports wholly
 * absent, UnprocessedKeys retries spent, or a requeued row that never converged.
 */
export class VectorCrossCheckError extends VectorIndexError {
    declare public readonly context: { reason: VectorCrossCheckReason };

    constructor(message: string, reason: VectorCrossCheckReason) {
        super(message, ErrorCode.VECTOR_CROSS_CHECK_ERROR, { reason });
        this.name = 'VectorCrossCheckError';
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
