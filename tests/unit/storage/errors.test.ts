import { describe, test, expect, spyOn } from 'bun:test';
import { StorageError, ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';

describe.concurrent('StorageError', () => {
    test('should be an instance of StorageError', () => {
        const error = new StorageError('test error');
        expect(error).toBeInstanceOf(StorageError);
    });

    test('should have correct name', () => {
        const error = new StorageError('test error');
        expect(error.name).toBe('StorageError');
    });

    test('should have correct message', () => {
        const error = new StorageError('something went wrong');
        expect(error.message).toBe('something went wrong');
    });

    test('should preserve stack trace', () => {
        const error = new StorageError('test');
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('ItemNotFoundError', () => {
    test('should be an instance of ItemNotFoundError', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error).toBeInstanceOf(ItemNotFoundError);
    });

    test('should have correct name', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.name).toBe('ItemNotFoundError');
    });

    test('should include item ID in message', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.message).toContain('item-123');
    });

    test('should store itemId property', () => {
        const error = new ItemNotFoundError('item-456');
        expect(error.itemId).toBe('item-456');
    });
});

describe.concurrent('ConflictError', () => {
    test('should be an instance of ConflictError', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error).toBeInstanceOf(ConflictError);
    });

    test('should have correct name', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error.name).toBe('ConflictError');
    });

    test('should include version info in message', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error.message).toContain('1');
        expect(error.message).toContain('2');
    });

    test('should store itemId and version properties', () => {
        const error = new ConflictError('item-789', 5, 6);
        expect(error.itemId).toBe('item-789');
        expect(error.expectedVersion).toBe(5);
        expect(error.actualVersion).toBe(6);
    });
});

describe.concurrent('ValidationError', () => {
    test('should be an instance of ValidationError', () => {
        const error = new ValidationError([{ path: 'content', message: 'required' }]);
        expect(error).toBeInstanceOf(ValidationError);
    });

    test('should have correct name', () => {
        const error = new ValidationError([]);
        expect(error.name).toBe('ValidationError');
    });

    test('should store issues array', () => {
        const issues = [{ path: 'content', message: 'required' }];
        const error = new ValidationError(issues);
        expect(error.issues).toEqual(issues);
    });

    test('should include issues in message', () => {
        const error = new ValidationError([{ path: 'id', message: 'invalid' }]);
        expect(error.message).toContain('id');
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
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing method for restoration
        const original = Error.captureStackTrace;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Intentionally testing behavior when captureStackTrace is undefined
        (Error as any).captureStackTrace = undefined;

        const error = new StorageError('test without capture');
        expect(error.message).toBe('test without capture');
        expect(error.name).toBe('StorageError');

        Error.captureStackTrace = original;
    });
});
