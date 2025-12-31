import { describe, expect, it, spyOn } from 'bun:test';
import {
    MemoryToolError,
    PathNotFoundError,
    PathAlreadyExistsError as _PathAlreadyExistsError,
    InvalidPathError as _InvalidPathError,
    TextNotFoundError,
    ContentTooLargeError,
    TextNotUniqueError,
    InvalidLineNumberError
} from '../../../../src/storage/memory-tool/errors';

describe('Memory Tool Content Errors', () => {
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

    describe('Error.captureStackTrace handling', () => {
        it('should use captureStackTrace when available', () => {
            const spy = spyOn(Error, 'captureStackTrace');
            const error = new MemoryToolError('test', 'TEST_CODE');
            expect(spy).toHaveBeenCalledWith(error, MemoryToolError);
            spy.mockRestore();
        });

        it('should call captureStackTrace with correct constructor for subclasses', () => {
            const spy = spyOn(Error, 'captureStackTrace');

            const pathNotFoundError = new PathNotFoundError('/test/path');
            expect(spy).toHaveBeenCalledWith(pathNotFoundError, PathNotFoundError);

            spy.mockRestore();
        });

        it('should handle missing captureStackTrace gracefully', () => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing method for restoration
            const original = Error.captureStackTrace;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Intentionally testing behavior when captureStackTrace is undefined
            (Error as any).captureStackTrace = undefined;

            const error = new MemoryToolError('test without capture', 'TEST_CODE');
            expect(error.message).toBe('test without capture');
            expect(error.name).toBe('MemoryToolError');

            Error.captureStackTrace = original;
        });

        it('should actually invoke captureStackTrace function (not just check truthiness)', () => {
            // This test kills mutants that replace the if-condition with true/false
            // by verifying the function is actually called, not just the condition checked
            let captureWasCalled = false;
            let receivedTarget: Error | undefined;
            let receivedConstructor: (new (...args: never[]) => Error) | undefined;

            const spy = spyOn(Error, 'captureStackTrace').mockImplementation(
                (target: object, constructorOpt?: (new (...args: never[]) => object)) => {
                    captureWasCalled = true;
                    receivedTarget = target as Error;
                    receivedConstructor = constructorOpt as (new (...args: never[]) => Error) | undefined;
                }
            );

            const error = new MemoryToolError('capture test', 'CAPTURE_TEST');

            // Verify the function body was executed (kills BlockStatement mutant)
            expect(captureWasCalled).toBe(true);
            // Verify correct arguments were passed
            expect(receivedTarget).toBe(error);
            expect(receivedConstructor).toBe(MemoryToolError);

            spy.mockRestore();
        });

        it('should skip captureStackTrace when it is not available', () => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing method for restoration
            const original = Error.captureStackTrace;

            // Track if captureStackTrace would be called
            const wasCalled = false;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Intentionally testing behavior when captureStackTrace is undefined
            (Error as any).captureStackTrace = undefined;

            // If the condition is replaced with `if(true)`, this would throw
            // because undefined() is not callable
            // If the condition is replaced with `if(false)`, this passes but
            // combined with the "actually invoke" test above, we ensure the real behavior
            const error = new MemoryToolError('no capture available', 'NO_CAPTURE');

            // Error should still be created successfully
            expect(error.message).toBe('no capture available');
            expect(error.code).toBe('NO_CAPTURE');
            expect(wasCalled).toBe(false);

            Error.captureStackTrace = original;
        });
    });
});
