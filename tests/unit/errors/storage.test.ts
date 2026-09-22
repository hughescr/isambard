import { describe, test, expect, spyOn } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    StorageError,
    ItemNotFoundError,
    ValidationError,
    DynamoTimeoutError,
    ContactNotFoundError,
    ContactLastIdentifierError,
    ContactNoIdentifiersError,
    BatchWriteExhaustedError
} from '@/errors/storage';

describe.concurrent('StorageError', () => {
    test('should be an instance of StorageError, IsambardError, and Error', () => {
        const error = new StorageError('test error');
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new StorageError('test error');
        expect(error.name).toBe('StorageError');
    });

    test('should have correct message', () => {
        const error = new StorageError('something went wrong');
        expect(error.message).toBe('something went wrong');
    });

    test('should have default code', () => {
        const error = new StorageError('test');
        expect(error.code).toBe(ErrorCode.STORAGE_ERROR);
    });

    test('should preserve stack trace', () => {
        const error = new StorageError('test');
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('ItemNotFoundError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error).toBeInstanceOf(ItemNotFoundError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.name).toBe('ItemNotFoundError');
    });

    test('should include item ID in message', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.message).toContain('item-123');
    });

    test('should store itemId in context', () => {
        const error = new ItemNotFoundError('item-456');
        expect(error.context.itemId).toBe('item-456');
    });

    test('should have correct code', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.code).toBe(ErrorCode.ITEM_NOT_FOUND);
    });
});

describe.concurrent('ValidationError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ValidationError([{ path: 'content', message: 'required' }]);
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ValidationError([]);
        expect(error.name).toBe('ValidationError');
    });

    test('should store issues in context', () => {
        const issues = [{ path: 'content', message: 'required' }];
        const error = new ValidationError(issues);
        expect(error.context.issues).toEqual(issues);
    });

    test('should include issues in message', () => {
        const error = new ValidationError([{ path: 'id', message: 'invalid' }]);
        expect(error.message).toContain('id');
    });

    test('should have correct code', () => {
        const error = new ValidationError([]);
        expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
});

describe.concurrent('DynamoTimeoutError', () => {
    test('should have correct inheritance chain', () => {
        const error = new DynamoTimeoutError('GetItem', 5000);
        expect(error).toBeInstanceOf(DynamoTimeoutError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new DynamoTimeoutError('GetItem', 5000);
        expect(error.name).toBe('DynamoTimeoutError');
    });

    test('should have correct message', () => {
        const error = new DynamoTimeoutError('GetItem', 5000);
        expect(error.message).toBe("DynamoDB operation 'GetItem' timed out after 5000ms");
    });

    test('should store operation and timeoutMs in context', () => {
        const error = new DynamoTimeoutError('PutItem', 3000);
        expect(error.context.operation).toBe('PutItem');
        expect(error.context.timeoutMs).toBe(3000);
    });

    test('should have correct code', () => {
        const error = new DynamoTimeoutError('GetItem', 5000);
        expect(error.code).toBe(ErrorCode.DYNAMO_TIMEOUT);
    });
});

describe.concurrent('ContactNotFoundError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ContactNotFoundError('alice-smith');
        expect(error).toBeInstanceOf(ContactNotFoundError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ContactNotFoundError('alice-smith');
        expect(error.name).toBe('ContactNotFoundError');
    });

    test('should include personId in message', () => {
        const error = new ContactNotFoundError('alice-smith');
        expect(error.message).toContain('alice-smith');
    });

    test('should store personId in context', () => {
        const error = new ContactNotFoundError('alice-smith');
        expect(error.context.personId).toBe('alice-smith');
    });

    test('should have correct code', () => {
        const error = new ContactNotFoundError('alice-smith');
        expect(error.code).toBe(ErrorCode.CONTACT_NOT_FOUND);
    });
});

describe.concurrent('ContactLastIdentifierError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ContactLastIdentifierError('alice-smith');
        expect(error).toBeInstanceOf(ContactLastIdentifierError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ContactLastIdentifierError('alice-smith');
        expect(error.name).toBe('ContactLastIdentifierError');
    });

    test('should include personId in message', () => {
        const error = new ContactLastIdentifierError('alice-smith');
        expect(error.message).toContain('alice-smith');
    });

    test('should store personId in context', () => {
        const error = new ContactLastIdentifierError('alice-smith');
        expect(error.context.personId).toBe('alice-smith');
    });

    test('should have correct code', () => {
        const error = new ContactLastIdentifierError('alice-smith');
        expect(error.code).toBe(ErrorCode.CONTACT_LAST_IDENTIFIER);
    });
});

describe.concurrent('ContactNoIdentifiersError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ContactNoIdentifiersError('alice-smith');
        expect(error).toBeInstanceOf(ContactNoIdentifiersError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ContactNoIdentifiersError('alice-smith');
        expect(error.name).toBe('ContactNoIdentifiersError');
    });

    test('should include personId in message', () => {
        const error = new ContactNoIdentifiersError('alice-smith');
        expect(error.message).toContain('alice-smith');
    });

    test('should store personId in context', () => {
        const error = new ContactNoIdentifiersError('alice-smith');
        expect(error.context.personId).toBe('alice-smith');
    });

    test('should have correct code', () => {
        const error = new ContactNoIdentifiersError('alice-smith');
        expect(error.code).toBe(ErrorCode.CONTACT_NO_IDENTIFIERS);
    });
});

describe.concurrent('BatchWriteExhaustedError', () => {
    test('should have correct inheritance chain', () => {
        const error = new BatchWriteExhaustedError('batchWriteItem', 3, 5);
        expect(error).toBeInstanceOf(BatchWriteExhaustedError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new BatchWriteExhaustedError('batchWriteItem', 3, 5);
        expect(error.name).toBe('BatchWriteExhaustedError');
    });

    test('should have correct code', () => {
        const error = new BatchWriteExhaustedError('batchWriteItem', 3, 5);
        expect(error.code).toBe(ErrorCode.BATCH_WRITE_EXHAUSTED);
    });

    test.each([
        { field: 'operation', expected: 'myOperation' },
        { field: 'remainingCount', expected: '7' },
        { field: 'maxRetries', expected: '10' }
    ])('should include $field in message', ({ expected }) => {
        const error = new BatchWriteExhaustedError('myOperation', 7, 10);
        expect(error.message).toContain(expected);
    });

    test('should have correct message format', () => {
        const error = new BatchWriteExhaustedError('putTagIndex', 4, 8);
        expect(error.message).toBe('putTagIndex: 4 items remain unprocessed after 8 attempts');
    });

    test('should store operation in context', () => {
        const error = new BatchWriteExhaustedError('deleteTagIndex', 2, 5);
        expect(error.context.operation).toBe('deleteTagIndex');
    });

    test('should store remainingCount in context', () => {
        const error = new BatchWriteExhaustedError('putTagIndex', 11, 5);
        expect(error.context.remainingCount).toBe(11);
    });

    test('should store maxRetries in context', () => {
        const error = new BatchWriteExhaustedError('putTagIndex', 2, 13);
        expect(error.context.maxRetries).toBe(13);
    });

    test('should store all context fields with distinct values', () => {
        const error = new BatchWriteExhaustedError('distinctOperation', 17, 23);
        expect(error.context.operation).toBe('distinctOperation');
        expect(error.context.remainingCount).toBe(17);
        expect(error.context.maxRetries).toBe(23);
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should use captureStackTrace when available', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new StorageError('test');
        expect(spy).toHaveBeenCalledWith(error, StorageError);
        spy.mockRestore();
    });

    test('should handle missing captureStackTrace gracefully', () => {
        const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');
        Object.defineProperty(Error, 'captureStackTrace', {
            value:        undefined,
            writable:     true,
            configurable: true,
        });

        try {
            const error = new StorageError('test without capture');
            expect(error.message).toBe('test without capture');
            expect(error.name).toBe('StorageError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});
