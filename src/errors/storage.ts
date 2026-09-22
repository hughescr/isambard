/**
 * Storage Error Classes
 *
 * Hierarchical error classes for storage operations.
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
// Contact Errors
// ============================================================================

/**
 * Base error class for all contact-related errors.
 */
// REMOVED: ContactError intermediate base class — ContactNotFoundError and ContactLastIdentifierError now extend StorageError directly

/**
 * Error thrown when a contact is not found.
 */
export class ContactNotFoundError extends StorageError {
    declare public readonly context: { personId: string };

    constructor(personId: string) {
        super(`Contact not found: ${personId}`, ErrorCode.CONTACT_NOT_FOUND, { personId });
        this.name = 'ContactNotFoundError';
    }
}

/**
 * Error thrown when trying to remove the last identifier from a contact.
 */
export class ContactLastIdentifierError extends StorageError {
    declare public readonly context: { personId: string };

    constructor(personId: string) {
        super(
            `Cannot remove last identifier from contact: ${personId}`,
            ErrorCode.CONTACT_LAST_IDENTIFIER,
            { personId }
        );
        this.name = 'ContactLastIdentifierError';
    }
}

/**
 * Error thrown when attempting to put a contact with no identifiers.
 * A contact must have at least one identifier to be reachable via resolveIdentifier.
 */
export class ContactNoIdentifiersError extends StorageError {
    declare public readonly context: { personId: string };

    constructor(personId: string) {
        super(
            `Contact "${personId}" must have at least one identifier`,
            ErrorCode.CONTACT_NO_IDENTIFIERS,
            { personId }
        );
        this.name = 'ContactNoIdentifiersError';
    }
}

/**
 * Error thrown when a DynamoDB BatchWrite operation exhausts all retries with
 * items still unprocessed. Indicates persistent DynamoDB pressure or capacity issues.
 */
export class BatchWriteExhaustedError extends StorageError {
    declare public readonly context: { remainingCount: number, maxRetries: number, operation: string };

    constructor(operation: string, remainingCount: number, maxRetries: number) {
        super(
            `${operation}: ${remainingCount} items remain unprocessed after ${maxRetries} attempts`,
            ErrorCode.BATCH_WRITE_EXHAUSTED,
            { remainingCount, maxRetries, operation }
        );
        this.name = 'BatchWriteExhaustedError';
    }
}
