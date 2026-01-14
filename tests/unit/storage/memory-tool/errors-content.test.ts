import { describe, expect, test, spyOn } from 'bun:test';
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
    describe.concurrent('TextNotFoundError', () => {
        const testPath = '/memories/search/location';
        const testText = 'search query';

        test('should have correct error properties', () => {
            const error = new TextNotFoundError(testPath, testText);

            expect(error).toBeInstanceOf(TextNotFoundError);
            expect(error.name).toBe('TextNotFoundError');
            expect(error.code).toBe('TEXT_NOT_FOUND');
            expect(error.message).toBe(`Text "${testText}" not found in memory at ${testPath}`);
            expect(error.path).toBe(testPath);
            expect(error.text).toBe(testText);
        });
    });

    describe.concurrent('ContentTooLargeError', () => {
        const testPath = '/memories/large/content';
        const testSize = 400000;

        test('should have correct error properties with default max size', () => {
            const error = new ContentTooLargeError(testPath, testSize);

            expect(error).toBeInstanceOf(ContentTooLargeError);
            expect(error.name).toBe('ContentTooLargeError');
            expect(error.code).toBe('CONTENT_TOO_LARGE');
            expect(error.message).toBe(
                `Memory content at ${testPath} is too large: ${testSize} bytes (max: 350000 bytes)`
            );
            expect(error.path).toBe(testPath);
            expect(error.size).toBe(testSize);
            expect(error.maxSize).toBe(350000);
        });

        test('should handle custom max size', () => {
            const customMax = 300000;
            const error = new ContentTooLargeError(testPath, testSize, customMax);

            expect(error.message).toBe(
                `Memory content at ${testPath} is too large: ${testSize} bytes (max: ${customMax} bytes)`
            );
            expect(error.maxSize).toBe(customMax);
        });
    });

    describe.concurrent('TextNotUniqueError', () => {
        const testPath = '/memories/search/location';
        const testText = 'duplicate text';

        test.each([
            { count: 2, description: 'count=2' },
            { count: 5, description: 'count=5' },
            { count: 10, description: 'count=10' },
            { count: 100, description: 'count=100' }
        ])('should have correct error properties with $description', ({ count }) => {
            const error = new TextNotUniqueError(testPath, testText, count);

            expect(error).toBeInstanceOf(TextNotUniqueError);
            expect(error.name).toBe('TextNotUniqueError');
            expect(error.code).toBe('TEXT_NOT_UNIQUE');
            expect(error.message).toBe(
                `Text "${testText}" appears ${count} times in memory at ${testPath}, expected exactly once`
            );
            expect(error.path).toBe(testPath);
            expect(error.text).toBe(testText);
            expect(error.count).toBe(count);
        });
    });

    describe.concurrent('InvalidLineNumberError', () => {
        const testPath = '/memories/line/location';

        test.each([
            { lineNumber: 0, totalLines: 100, description: 'line number 0' },
            { lineNumber: -5, totalLines: 100, description: 'negative line number' },
            { lineNumber: 150, totalLines: 100, description: 'line exceeding total' },
            { lineNumber: 999999, totalLines: 100, description: 'large line number' },
            { lineNumber: 150, totalLines: 0, description: 'totalLines=0' },
            { lineNumber: 150, totalLines: 1, description: 'totalLines=1' },
            { lineNumber: 150, totalLines: 50, description: 'totalLines=50' },
            { lineNumber: 150, totalLines: 1000, description: 'totalLines=1000' }
        ])('should have correct error properties with $description', ({ lineNumber, totalLines }) => {
            const error = new InvalidLineNumberError(testPath, lineNumber, totalLines);

            expect(error).toBeInstanceOf(InvalidLineNumberError);
            expect(error.name).toBe('InvalidLineNumberError');
            expect(error.code).toBe('INVALID_LINE_NUMBER');
            expect(error.message).toBe(
                `Invalid line number ${lineNumber} in memory at ${testPath} (total lines: ${totalLines})`
            );
            expect(error.path).toBe(testPath);
            expect(error.lineNumber).toBe(lineNumber);
            expect(error.totalLines).toBe(totalLines);
        });
    });

    describe('Error.captureStackTrace handling', () => {
        test('should use captureStackTrace when available', () => {
            const spy = spyOn(Error, 'captureStackTrace');
            const error = new MemoryToolError('test', 'TEST_CODE');
            expect(spy).toHaveBeenCalledWith(error, MemoryToolError);
            spy.mockRestore();
        });

        test('should call captureStackTrace with correct constructor for subclasses', () => {
            const spy = spyOn(Error, 'captureStackTrace');

            const pathNotFoundError = new PathNotFoundError('/test/path');
            expect(spy).toHaveBeenCalledWith(pathNotFoundError, PathNotFoundError);

            spy.mockRestore();
        });

        test('should handle missing captureStackTrace gracefully', () => {
            // eslint-disable-next-line @typescript-eslint/unbound-method -- Storing method for restoration
            const original = Error.captureStackTrace;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- Intentionally testing behavior when captureStackTrace is undefined
            (Error as any).captureStackTrace = undefined;

            const error = new MemoryToolError('test without capture', 'TEST_CODE');
            expect(error.message).toBe('test without capture');
            expect(error.name).toBe('MemoryToolError');

            Error.captureStackTrace = original;
        });

        test('should actually invoke captureStackTrace function (not just check truthiness)', () => {
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

        test('should skip captureStackTrace when it is not available', () => {
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
