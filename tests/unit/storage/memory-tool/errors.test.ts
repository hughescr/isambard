import { describe, expect, it } from 'bun:test';
import {
    MemoryToolError,
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError as _TextNotFoundError,
    ContentTooLargeError as _ContentTooLargeError,
    TextNotUniqueError as _TextNotUniqueError,
    InvalidLineNumberError as _InvalidLineNumberError
} from '../../../../src/storage/memory-tool/errors';

describe('Memory Tool Errors', () => {
    describe('MemoryToolError', () => {
        it('should be an instance of MemoryToolError and Error', () => {
            const error = new MemoryToolError('Test error', 'TEST_ERROR');
            expect(error).toBeInstanceOf(MemoryToolError);
            expect(error).toBeInstanceOf(Error);
        });

        it('should have correct name', () => {
            const error = new MemoryToolError('Test error', 'TEST_ERROR');
            expect(error.name).toBe('MemoryToolError');
        });

        it('should have correct message', () => {
            const error = new MemoryToolError('Test error', 'TEST_ERROR');
            expect(error.message).toBe('Test error');
        });

        it('should have correct code', () => {
            const error = new MemoryToolError('Test error', 'TEST_ERROR');
            expect(error.code).toBe('TEST_ERROR');
        });

        it('should preserve stack trace', () => {
            const error = new MemoryToolError('Test error', 'TEST_ERROR');
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('MemoryToolError');
        });
    });

    describe('PathNotFoundError', () => {
        const testPath = '/memories/test/path';

        it('should be an instance of PathNotFoundError', () => {
            const error = new PathNotFoundError(testPath);
            expect(error).toBeInstanceOf(PathNotFoundError);
        });

        it('should have correct name', () => {
            const error = new PathNotFoundError(testPath);
            expect(error.name).toBe('PathNotFoundError');
        });

        it('should have correct message format', () => {
            const error = new PathNotFoundError(testPath);
            expect(error.message).toBe(`Memory not found at path: ${testPath}`);
        });

        it('should have correct code', () => {
            const error = new PathNotFoundError(testPath);
            expect(error.code).toBe('PATH_NOT_FOUND');
        });

        it('should store path property', () => {
            const error = new PathNotFoundError(testPath);
            expect(error.path).toBe(testPath);
        });
    });

    describe('PathAlreadyExistsError', () => {
        const testPath = '/memories/existing/path';

        it('should be an instance of PathAlreadyExistsError', () => {
            const error = new PathAlreadyExistsError(testPath);
            expect(error).toBeInstanceOf(PathAlreadyExistsError);
        });

        it('should have correct name', () => {
            const error = new PathAlreadyExistsError(testPath);
            expect(error.name).toBe('PathAlreadyExistsError');
        });

        it('should have correct message format', () => {
            const error = new PathAlreadyExistsError(testPath);
            expect(error.message).toBe(`Memory already exists at path: ${testPath}`);
        });

        it('should have correct code', () => {
            const error = new PathAlreadyExistsError(testPath);
            expect(error.code).toBe('PATH_ALREADY_EXISTS');
        });

        it('should store path property', () => {
            const error = new PathAlreadyExistsError(testPath);
            expect(error.path).toBe(testPath);
        });
    });

    describe('InvalidPathError', () => {
        const testPath = 'invalid/path';
        const testReason = 'does not start with /memories';

        it('should be an instance of InvalidPathError', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error).toBeInstanceOf(InvalidPathError);
        });

        it('should have correct name', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error.name).toBe('InvalidPathError');
        });

        it('should have correct message format', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error.message).toBe(`Invalid memory path "${testPath}": ${testReason}`);
        });

        it('should have correct code', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error.code).toBe('INVALID_PATH');
        });

        it('should store path property', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error.path).toBe(testPath);
        });

        it('should store reason property', () => {
            const error = new InvalidPathError(testPath, testReason);
            expect(error.reason).toBe(testReason);
        });

        it('should handle different invalid path reasons', () => {
            const reasons = [
                'does not start with /memories',
                'contains directory traversal (..)',
                'contains double slashes',
                'ends with trailing slash',
            ];

            for(const reason of reasons) {
                const error = new InvalidPathError(testPath, reason);
                expect(error.reason).toBe(reason);
                expect(error.message).toContain(reason);
            }
        });
    });
});
