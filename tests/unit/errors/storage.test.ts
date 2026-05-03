import { describe, test, expect, spyOn } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';
import {
    StorageError,
    ItemNotFoundError,
    ValidationError,
    DynamoTimeoutError,
    MemoryToolError,
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    ContentTooLargeError,
    TextNotUniqueError,
    InvalidLineNumberError,
    ReconciliationError,
    ReconciliationThrottledError,
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

describe.concurrent('MemoryToolError', () => {
    test('should have correct inheritance chain', () => {
        const error = new MemoryToolError('Test error');
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new MemoryToolError('Test error');
        expect(error.name).toBe('MemoryToolError');
    });

    test('should have correct message', () => {
        const error = new MemoryToolError('Test error');
        expect(error.message).toBe('Test error');
    });

    test('should have default code', () => {
        const error = new MemoryToolError('Test error');
        expect(error.code).toBe(ErrorCode.MEMORY_TOOL_ERROR);
    });

    test('should preserve stack trace', () => {
        const error = new MemoryToolError('Test error');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('MemoryToolError');
    });
});

describe.concurrent('PathNotFoundError', () => {
    const testPath = '/memories/test/path';

    test('should have correct inheritance chain', () => {
        const error = new PathNotFoundError(testPath);
        expect(error).toBeInstanceOf(PathNotFoundError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new PathNotFoundError(testPath);
        expect(error.name).toBe('PathNotFoundError');
    });

    test('should have correct message format', () => {
        const error = new PathNotFoundError(testPath);
        expect(error.message).toBe(`Memory not found at path: ${testPath}`);
    });

    test('should have correct code', () => {
        const error = new PathNotFoundError(testPath);
        expect(error.code).toBe(ErrorCode.PATH_NOT_FOUND);
    });

    test('should store path in context', () => {
        const error = new PathNotFoundError(testPath);
        expect(error.context.path).toBe(testPath);
    });
});

describe.concurrent('PathAlreadyExistsError', () => {
    const testPath = '/memories/existing/path';

    test('should have correct inheritance chain', () => {
        const error = new PathAlreadyExistsError(testPath);
        expect(error).toBeInstanceOf(PathAlreadyExistsError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new PathAlreadyExistsError(testPath);
        expect(error.name).toBe('PathAlreadyExistsError');
    });

    test('should have correct message format', () => {
        const error = new PathAlreadyExistsError(testPath);
        expect(error.message).toBe(`Memory already exists at path: ${testPath}`);
    });

    test('should have correct code', () => {
        const error = new PathAlreadyExistsError(testPath);
        expect(error.code).toBe(ErrorCode.PATH_ALREADY_EXISTS);
    });

    test('should store path in context', () => {
        const error = new PathAlreadyExistsError(testPath);
        expect(error.context.path).toBe(testPath);
    });
});

describe.concurrent('InvalidPathError', () => {
    test('should have correct inheritance and properties', () => {
        const error = new InvalidPathError('invalid/path', 'does not start with /memories');
        expect(error).toBeInstanceOf(InvalidPathError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error.name).toBe('InvalidPathError');
        expect(error.code).toBe(ErrorCode.INVALID_PATH);
        expect(error.message).toBe('Invalid memory path "invalid/path": does not start with /memories');
        expect(error.context.path).toBe('invalid/path');
        expect(error.context.reason).toBe('does not start with /memories');
    });
});

describe.concurrent('TextNotFoundError', () => {
    test('should have correct error properties', () => {
        const error = new TextNotFoundError('/memories/search/location', 'search query');
        expect(error).toBeInstanceOf(TextNotFoundError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error.name).toBe('TextNotFoundError');
        expect(error.code).toBe(ErrorCode.TEXT_NOT_FOUND);
        expect(error.message).toBe('Text "search query" not found in memory at /memories/search/location');
        expect(error.context.path).toBe('/memories/search/location');
        expect(error.context.text).toBe('search query');
    });
});

describe.concurrent('ContentTooLargeError', () => {
    test('should have correct properties with default max size', () => {
        const error = new ContentTooLargeError('/memories/large/content', 400_000);
        expect(error).toBeInstanceOf(ContentTooLargeError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error.name).toBe('ContentTooLargeError');
        expect(error.code).toBe(ErrorCode.CONTENT_TOO_LARGE);
        expect(error.message).toBe(
            'Memory content at /memories/large/content is too large: 400000 bytes (max: 350000 bytes)'
        );
        expect(error.context.path).toBe('/memories/large/content');
        expect(error.context.size).toBe(400_000);
        expect(error.context.maxSize).toBe(350_000);
    });

    test('should handle custom max size', () => {
        const error = new ContentTooLargeError('/memories/large/content', 400_000, 300_000);
        expect(error.message).toContain('max: 300000 bytes');
        expect(error.context.maxSize).toBe(300_000);
    });
});

describe.concurrent('TextNotUniqueError', () => {
    test.each([
        { count: 2, description: 'count=2' },
        { count: 5, description: 'count=5' },
        { count: 100, description: 'count=100' }
    ])('should have correct error properties with $description', ({ count }) => {
        const error = new TextNotUniqueError('/memories/search/location', 'duplicate text', count);
        expect(error).toBeInstanceOf(TextNotUniqueError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error.name).toBe('TextNotUniqueError');
        expect(error.code).toBe(ErrorCode.TEXT_NOT_UNIQUE);
        expect(error.context.path).toBe('/memories/search/location');
        expect(error.context.text).toBe('duplicate text');
        expect(error.context.count).toBe(count);
        expect(error.message).toBe(`Text "duplicate text" appears ${count} times in memory at /memories/search/location, expected exactly once`);
    });
});

describe.concurrent('InvalidLineNumberError', () => {
    test.each([
        { lineNumber: 0, totalLines: 100, description: 'line number 0' },
        { lineNumber: -5, totalLines: 100, description: 'negative line number' },
        { lineNumber: 150, totalLines: 100, description: 'line exceeding total' }
    ])('should have correct error properties with $description', ({ lineNumber, totalLines }) => {
        const error = new InvalidLineNumberError('/memories/line/location', lineNumber, totalLines);
        expect(error).toBeInstanceOf(InvalidLineNumberError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error.name).toBe('InvalidLineNumberError');
        expect(error.code).toBe(ErrorCode.INVALID_LINE_NUMBER);
        expect(error.context.path).toBe('/memories/line/location');
        expect(error.context.lineNumber).toBe(lineNumber);
        expect(error.context.totalLines).toBe(totalLines);
        expect(error.message).toBe(`Invalid line number ${lineNumber} in memory at /memories/line/location (total lines: ${totalLines})`);
    });
});

describe.concurrent('ReconciliationError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ReconciliationError('Test error');
        expect(error).toBeInstanceOf(ReconciliationError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ReconciliationError('Test error');
        expect(error.name).toBe('ReconciliationError');
    });

    test('should have correct message', () => {
        const error = new ReconciliationError('Test error');
        expect(error.message).toBe('Test error');
    });

    test('should have default code', () => {
        const error = new ReconciliationError('Test error');
        expect(error.code).toBe(ErrorCode.RECONCILIATION_ERROR);
    });

    test('should preserve stack trace', () => {
        const error = new ReconciliationError('Test error');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('ReconciliationError');
    });
});

describe.concurrent('ReconciliationThrottledError', () => {
    test('should have correct inheritance chain', () => {
        const error = new ReconciliationThrottledError('scan');
        expect(error).toBeInstanceOf(ReconciliationThrottledError);
        expect(error).toBeInstanceOf(ReconciliationError);
        expect(error).toBeInstanceOf(MemoryToolError);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new ReconciliationThrottledError('scan');
        expect(error.name).toBe('ReconciliationThrottledError');
    });

    test('should have correct message format', () => {
        const error = new ReconciliationThrottledError('scan');
        expect(error.message).toBe('Reconciliation throttled during scan');
    });

    test('should have correct code', () => {
        const error = new ReconciliationThrottledError('scan');
        expect(error.code).toBe(ErrorCode.RECONCILIATION_THROTTLED);
    });

    test('should store operation in context', () => {
        const error = new ReconciliationThrottledError('putItem');
        expect(error.context.operation).toBe('putItem');
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

    test('should include operation in message', () => {
        const error = new BatchWriteExhaustedError('myOperation', 7, 10);
        expect(error.message).toContain('myOperation');
    });

    test('should include remainingCount in message', () => {
        const error = new BatchWriteExhaustedError('myOperation', 7, 10);
        expect(error.message).toContain('7');
    });

    test('should include maxRetries in message', () => {
        const error = new BatchWriteExhaustedError('myOperation', 7, 10);
        expect(error.message).toContain('10');
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
