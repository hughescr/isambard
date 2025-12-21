import { describe, it, expect, spyOn } from 'bun:test';
import { StorageError, ItemNotFoundError, ConflictError, ValidationError } from '@/storage/errors';

describe('StorageError', () => {
    it('should be an instance of Error', () => {
        const error = new StorageError('test error');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(StorageError);
    });

    it('should have correct name', () => {
        const error = new StorageError('test error');
        expect(error.name).toBe('StorageError');
    });

    it('should have correct message', () => {
        const error = new StorageError('something went wrong');
        expect(error.message).toBe('something went wrong');
    });

    it('should preserve stack trace', () => {
        const error = new StorageError('test');
        expect(error.stack).toBeDefined();
    });
});

describe('ItemNotFoundError', () => {
    it('should be an instance of StorageError', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(ItemNotFoundError);
    });

    it('should have correct name', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.name).toBe('ItemNotFoundError');
    });

    it('should include item ID in message', () => {
        const error = new ItemNotFoundError('item-123');
        expect(error.message).toContain('item-123');
    });

    it('should store itemId property', () => {
        const error = new ItemNotFoundError('item-456');
        expect(error.itemId).toBe('item-456');
    });
});

describe('ConflictError', () => {
    it('should be an instance of StorageError', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(ConflictError);
    });

    it('should have correct name', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error.name).toBe('ConflictError');
    });

    it('should include version info in message', () => {
        const error = new ConflictError('item-123', 1, 2);
        expect(error.message).toContain('1');
        expect(error.message).toContain('2');
    });

    it('should store itemId and version properties', () => {
        const error = new ConflictError('item-789', 5, 6);
        expect(error.itemId).toBe('item-789');
        expect(error.expectedVersion).toBe(5);
        expect(error.actualVersion).toBe(6);
    });
});

describe('ValidationError', () => {
    it('should be an instance of StorageError', () => {
        const error = new ValidationError([{ path: 'content', message: 'required' }]);
        expect(error).toBeInstanceOf(StorageError);
        expect(error).toBeInstanceOf(ValidationError);
    });

    it('should have correct name', () => {
        const error = new ValidationError([]);
        expect(error.name).toBe('ValidationError');
    });

    it('should store issues array', () => {
        const issues = [{ path: 'content', message: 'required' }];
        const error = new ValidationError(issues);
        expect(error.issues).toEqual(issues);
    });

    it('should include issues in message', () => {
        const error = new ValidationError([{ path: 'id', message: 'invalid' }]);
        expect(error.message).toContain('id');
    });
});

describe('Error.captureStackTrace handling', () => {
    it('should use captureStackTrace when available', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new StorageError('test');
        expect(spy).toHaveBeenCalledWith(error, StorageError);
        spy.mockRestore();
    });

    it('should handle missing captureStackTrace gracefully', () => {
        const original = Error.captureStackTrace;
        (Error as any).captureStackTrace = undefined;

        const error = new StorageError('test without capture');
        expect(error.message).toBe('test without capture');
        expect(error.name).toBe('StorageError');

        Error.captureStackTrace = original;
    });
});
