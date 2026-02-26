/**
 * Storage Error Classes
 *
 * Hierarchical error classes for storage, memory tool, and reconciliation operations.
 * All errors extend StorageError which extends IsambardError.
 */

import { IsambardError } from './base';
import { ErrorCode } from './codes';

// ============================================================================
// Base Storage Errors
// ============================================================================

/**
 * Base error class for all storage-related errors.
 */
export class StorageError extends IsambardError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.STORAGE_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'StorageError';
    }
}

/**
 * Error thrown when an item is not found in storage.
 */
export class ItemNotFoundError extends StorageError {
    declare public readonly context: { itemId: string };

    constructor(itemId: string) {
        super(`Item not found: ${itemId}`, ErrorCode.ITEM_NOT_FOUND, { itemId });
        this.name = 'ItemNotFoundError';
    }
}

/**
 * Error thrown when validation fails.
 */
export class ValidationError extends StorageError {
    declare public readonly context: { issues: unknown[] };

    constructor(issues: unknown[]) {
        super(`Validation failed: ${JSON.stringify(issues)}`, ErrorCode.VALIDATION_ERROR, { issues });
        this.name = 'ValidationError';
    }
}

/**
 * Error thrown when a DynamoDB operation exceeds its timeout.
 * The AWS SDK may still be retrying internally when this is thrown.
 */
export class DynamoTimeoutError extends StorageError {
    declare public readonly context: { operation: string, timeoutMs: number };

    constructor(operation: string, timeoutMs: number) {
        super(
            `DynamoDB operation '${operation}' timed out after ${timeoutMs}ms`,
            ErrorCode.DYNAMO_TIMEOUT,
            { operation, timeoutMs }
        );
        this.name = 'DynamoTimeoutError';
    }
}

// ============================================================================
// Memory Tool Errors
// ============================================================================

/**
 * Base error class for all memory tool errors.
 */
export class MemoryToolError extends StorageError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.MEMORY_TOOL_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'MemoryToolError';
    }
}

/**
 * Error thrown when attempting to read a memory that doesn't exist.
 */
export class PathNotFoundError extends MemoryToolError {
    declare public readonly context: { path: string };

    constructor(path: string) {
        super(`Memory not found at path: ${path}`, ErrorCode.PATH_NOT_FOUND, { path });
        this.name = 'PathNotFoundError';
    }
}

/**
 * Error thrown when attempting to create a memory at a path that already exists.
 */
export class PathAlreadyExistsError extends MemoryToolError {
    declare public readonly context: { path: string };

    constructor(path: string) {
        super(`Memory already exists at path: ${path}`, ErrorCode.PATH_ALREADY_EXISTS, { path });
        this.name = 'PathAlreadyExistsError';
    }
}

/**
 * Error thrown when a memory path is invalid according to validation rules.
 */
export class InvalidPathError extends MemoryToolError {
    declare public readonly context: { path: string, reason: string };

    constructor(path: string, reason: string) {
        super(`Invalid memory path "${path}": ${reason}`, ErrorCode.INVALID_PATH, { path, reason });
        this.name = 'InvalidPathError';
    }
}

/**
 * Error thrown when text search doesn't find the specified text in a memory.
 */
export class TextNotFoundError extends MemoryToolError {
    declare public readonly context: { path: string, text: string };

    constructor(path: string, text: string) {
        super(`Text "${text}" not found in memory at ${path}`, ErrorCode.TEXT_NOT_FOUND, { path, text });
        this.name = 'TextNotFoundError';
    }
}

/**
 * Error thrown when memory content exceeds size limits.
 */
export class ContentTooLargeError extends MemoryToolError {
    declare public readonly context: { path: string, size: number, maxSize: number };

    constructor(path: string, size: number, maxSize = 350_000) {
        super(
            `Memory content at ${path} is too large: ${size} bytes (max: ${maxSize} bytes)`,
            ErrorCode.CONTENT_TOO_LARGE,
            { path, size, maxSize }
        );
        this.name = 'ContentTooLargeError';
    }
}

/**
 * Error thrown when text search finds multiple occurrences (expected exactly one).
 */
export class TextNotUniqueError extends MemoryToolError {
    declare public readonly context: { path: string, text: string, count: number };

    constructor(path: string, text: string, count: number) {
        super(
            `Text "${text}" appears ${count} times in memory at ${path}, expected exactly once`,
            ErrorCode.TEXT_NOT_UNIQUE,
            { path, text, count }
        );
        this.name = 'TextNotUniqueError';
    }
}

/**
 * Error thrown when a line number is invalid for the given memory content.
 */
export class InvalidLineNumberError extends MemoryToolError {
    declare public readonly context: { path: string, lineNumber: number, totalLines: number };

    constructor(path: string, lineNumber: number, totalLines: number) {
        super(
            `Invalid line number ${lineNumber} in memory at ${path} (total lines: ${totalLines})`,
            ErrorCode.INVALID_LINE_NUMBER,
            { path, lineNumber, totalLines }
        );
        this.name = 'InvalidLineNumberError';
    }
}

// ============================================================================
// Reconciliation Errors
// ============================================================================

/**
 * Base error class for all reconciliation errors.
 */
export class ReconciliationError extends MemoryToolError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.RECONCILIATION_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'ReconciliationError';
    }
}

/**
 * Error thrown when DynamoDB operations are throttled during reconciliation.
 */
export class ReconciliationThrottledError extends ReconciliationError {
    declare public readonly context: { operation: string };

    constructor(operation: string) {
        super(
            `Reconciliation throttled during ${operation}`,
            ErrorCode.RECONCILIATION_THROTTLED,
            { operation }
        );
        this.name = 'ReconciliationThrottledError';
    }
}
