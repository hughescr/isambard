/**
 * Base error class for all storage-related errors.
 */
export class StorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StorageError';
        // Maintains proper stack trace for where error was thrown (V8 engines)
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when an item is not found in storage.
 */
export class ItemNotFoundError extends StorageError {
    public readonly itemId: string;

    constructor(itemId: string) {
        super(`Item not found: ${itemId}`);
        this.name = 'ItemNotFoundError';
        this.itemId = itemId;
    }
}

/**
 * Error thrown when an optimistic locking conflict occurs.
 * This happens when the item's version has changed since it was read.
 */
export class ConflictError extends StorageError {
    public readonly itemId:          string;
    public readonly expectedVersion: number;
    public readonly actualVersion:   number;

    constructor(itemId: string, expectedVersion: number, actualVersion: number) {
        super(`Version conflict for item ${itemId}: expected ${expectedVersion}, got ${actualVersion}`);
        this.name = 'ConflictError';
        this.itemId = itemId;
        this.expectedVersion = expectedVersion;
        this.actualVersion = actualVersion;
    }
}

/**
 * Error thrown when validation fails.
 */
export class ValidationError extends StorageError {
    public readonly issues: unknown[];

    constructor(issues: unknown[]) {
        super(`Validation failed: ${JSON.stringify(issues)}`);
        this.name = 'ValidationError';
        this.issues = issues;
    }
}
