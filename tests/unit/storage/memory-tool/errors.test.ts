import { describe, expect, it } from 'bun:test';
import {
    MemoryToolError,
    PathNotFoundError,
    PathAlreadyExistsError,
    InvalidPathError,
    TextNotFoundError,
    ContentTooLargeError,
    TextNotUniqueError,
    InvalidLineNumberError
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

    describe('TextNotFoundError', () => {
        const testPath = '/memories/search/location';
        const testText = 'search query';

        it('should be an instance of TextNotFoundError', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error).toBeInstanceOf(TextNotFoundError);
        });

        it('should have correct name', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error.name).toBe('TextNotFoundError');
        });

        it('should have correct message format', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error.message).toBe(`Text "${testText}" not found in memory at ${testPath}`);
        });

        it('should have correct code', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error.code).toBe('TEXT_NOT_FOUND');
        });

        it('should store path property', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error.path).toBe(testPath);
        });

        it('should store text property', () => {
            const error = new TextNotFoundError(testPath, testText);
            expect(error.text).toBe(testText);
        });
    });

    describe('ContentTooLargeError', () => {
        const testPath = '/memories/large/content';
        const testSize = 400000;

        it('should be an instance of ContentTooLargeError', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error).toBeInstanceOf(ContentTooLargeError);
        });

        it('should have correct name', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.name).toBe('ContentTooLargeError');
        });

        it('should have correct message format with default max size', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.message).toBe(
                `Memory content at ${testPath} is too large: ${testSize} bytes (max: 350000 bytes)`
            );
        });

        it('should have correct message format with custom max size', () => {
            const customMax = 300000;
            const error = new ContentTooLargeError(testPath, testSize, customMax);
            expect(error.message).toBe(
                `Memory content at ${testPath} is too large: ${testSize} bytes (max: ${customMax} bytes)`
            );
        });

        it('should have correct code', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.code).toBe('CONTENT_TOO_LARGE');
        });

        it('should store path property', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.path).toBe(testPath);
        });

        it('should store size property', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.size).toBe(testSize);
        });

        it('should store maxSize property with default value', () => {
            const error = new ContentTooLargeError(testPath, testSize);
            expect(error.maxSize).toBe(350000);
        });

        it('should store maxSize property with custom value', () => {
            const customMax = 300000;
            const error = new ContentTooLargeError(testPath, testSize, customMax);
            expect(error.maxSize).toBe(customMax);
        });
    });

    describe('TextNotUniqueError', () => {
        const testPath = '/memories/search/location';
        const testText = 'duplicate text';
        const testCount = 3;

        it('should be an instance of TextNotUniqueError', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error).toBeInstanceOf(TextNotUniqueError);
        });

        it('should have correct name', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.name).toBe('TextNotUniqueError');
        });

        it('should have correct message format', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.message).toBe(
                `Text "${testText}" appears ${testCount} times in memory at ${testPath}, expected exactly once`
            );
        });

        it('should have correct code', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.code).toBe('TEXT_NOT_UNIQUE');
        });

        it('should store path property', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.path).toBe(testPath);
        });

        it('should store text property', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.text).toBe(testText);
        });

        it('should store count property', () => {
            const error = new TextNotUniqueError(testPath, testText, testCount);
            expect(error.count).toBe(testCount);
        });

        it('should handle different count values', () => {
            const counts = [2, 5, 10, 100];

            for(const count of counts) {
                const error = new TextNotUniqueError(testPath, testText, count);
                expect(error.count).toBe(count);
                expect(error.message).toContain(`appears ${count} times`);
            }
        });
    });

    describe('InvalidLineNumberError', () => {
        const testPath = '/memories/line/location';
        const testLineNumber = 150;
        const testTotalLines = 100;

        it('should be an instance of InvalidLineNumberError', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error).toBeInstanceOf(InvalidLineNumberError);
        });

        it('should have correct name', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.name).toBe('InvalidLineNumberError');
        });

        it('should have correct message format', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.message).toBe(
                `Invalid line number ${testLineNumber} in memory at ${testPath} (total lines: ${testTotalLines})`
            );
        });

        it('should have correct code', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.code).toBe('INVALID_LINE_NUMBER');
        });

        it('should store path property', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.path).toBe(testPath);
        });

        it('should store lineNumber property', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.lineNumber).toBe(testLineNumber);
        });

        it('should store totalLines property', () => {
            const error = new InvalidLineNumberError(testPath, testLineNumber, testTotalLines);
            expect(error.totalLines).toBe(testTotalLines);
        });

        it('should handle edge case: line number 0', () => {
            const error = new InvalidLineNumberError(testPath, 0, testTotalLines);
            expect(error.lineNumber).toBe(0);
            expect(error.message).toContain('Invalid line number 0');
        });

        it('should handle edge case: negative line number', () => {
            const error = new InvalidLineNumberError(testPath, -5, testTotalLines);
            expect(error.lineNumber).toBe(-5);
            expect(error.message).toContain('Invalid line number -5');
        });

        it('should handle edge case: large line numbers', () => {
            const largeLineNumber = 999999;
            const error = new InvalidLineNumberError(testPath, largeLineNumber, testTotalLines);
            expect(error.lineNumber).toBe(largeLineNumber);
            expect(error.message).toContain(`Invalid line number ${largeLineNumber}`);
        });

        it('should handle various totalLines values', () => {
            const totalLinesCases = [0, 1, 50, 1000];

            for(const total of totalLinesCases) {
                const error = new InvalidLineNumberError(testPath, testLineNumber, total);
                expect(error.totalLines).toBe(total);
                expect(error.message).toContain(`total lines: ${total}`);
            }
        });
    });
});
