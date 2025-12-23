/**
 * Memory Tool Error Classes
 *
 * Hierarchical error classes for memory tool operations.
 * All errors extend MemoryToolError which provides error codes for programmatic handling.
 */

/**
 * Base error class for all memory tool errors
 */
export class MemoryToolError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'MemoryToolError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when attempting to read a memory that doesn't exist
 */
export class PathNotFoundError extends MemoryToolError {
    constructor(public readonly path: string) {
        super(`Memory not found at path: ${path}`, 'PATH_NOT_FOUND');
        this.name = 'PathNotFoundError';
    }
}

/**
 * Error thrown when attempting to create a memory at a path that already exists
 */
export class PathAlreadyExistsError extends MemoryToolError {
    constructor(public readonly path: string) {
        super(`Memory already exists at path: ${path}`, 'PATH_ALREADY_EXISTS');
        this.name = 'PathAlreadyExistsError';
    }
}

/**
 * Error thrown when a memory path is invalid according to validation rules
 */
export class InvalidPathError extends MemoryToolError {
    constructor(
        public readonly path: string,
        public readonly reason: string
    ) {
        super(`Invalid memory path "${path}": ${reason}`, 'INVALID_PATH');
        this.name = 'InvalidPathError';
    }
}

/**
 * Error thrown when text search doesn't find the specified text in a memory
 */
export class TextNotFoundError extends MemoryToolError {
    constructor(
        public readonly path: string,
        public readonly text: string
    ) {
        super(`Text "${text}" not found in memory at ${path}`, 'TEXT_NOT_FOUND');
        this.name = 'TextNotFoundError';
    }
}

/**
 * Error thrown when memory content exceeds size limits
 */
export class ContentTooLargeError extends MemoryToolError {
    constructor(
        public readonly path: string,
        public readonly size: number,
        public readonly maxSize = 350_000
    ) {
        super(
            `Memory content at ${path} is too large: ${size} bytes (max: ${maxSize} bytes)`,
            'CONTENT_TOO_LARGE'
        );
        this.name = 'ContentTooLargeError';
    }
}

/**
 * Error thrown when text search finds multiple occurrences (expected exactly one)
 */
export class TextNotUniqueError extends MemoryToolError {
    constructor(
        public readonly path: string,
        public readonly text: string,
        public readonly count: number
    ) {
        super(
            `Text "${text}" appears ${count} times in memory at ${path}, expected exactly once`,
            'TEXT_NOT_UNIQUE'
        );
        this.name = 'TextNotUniqueError';
    }
}

/**
 * Error thrown when a line number is invalid for the given memory content
 */
export class InvalidLineNumberError extends MemoryToolError {
    constructor(
        public readonly path: string,
        public readonly lineNumber: number,
        public readonly totalLines: number
    ) {
        super(
            `Invalid line number ${lineNumber} in memory at ${path} (total lines: ${totalLines})`,
            'INVALID_LINE_NUMBER'
        );
        this.name = 'InvalidLineNumberError';
    }
}
