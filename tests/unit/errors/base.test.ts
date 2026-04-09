import { describe, test, expect, spyOn } from 'bun:test';
import { IsambardError } from '@/errors/base';
import { ErrorCode } from '@/errors/codes';

describe.concurrent('IsambardError', () => {
    test('should be an instance of IsambardError and Error', () => {
        const error = new IsambardError('test error', ErrorCode.STORAGE_ERROR);
        expect(error).toBeInstanceOf(IsambardError);
        expect(error).toBeInstanceOf(Error);
    });

    test('should have correct name', () => {
        const error = new IsambardError('test error', ErrorCode.STORAGE_ERROR);
        expect(error.name).toBe('IsambardError');
    });

    test('should have correct message', () => {
        const error = new IsambardError('something went wrong', ErrorCode.STORAGE_ERROR);
        expect(error.message).toBe('something went wrong');
    });

    test('should have correct code', () => {
        const error = new IsambardError('test', ErrorCode.DISCORD_ERROR);
        expect(error.code).toBe(ErrorCode.DISCORD_ERROR);
    });

    test('should have correct context', () => {
        const ctx = { key: 'value', num: 42 };
        const error = new IsambardError('test', ErrorCode.STORAGE_ERROR, ctx);
        expect(error.context).toEqual(ctx);
    });

    test('should have undefined context when not provided', () => {
        const error = new IsambardError('test', ErrorCode.STORAGE_ERROR);
        expect(error.context).toBeUndefined();
    });

    test('should preserve stack trace', () => {
        const error = new IsambardError('test', ErrorCode.STORAGE_ERROR);
        expect(error.stack).toBeDefined();
    });
});

describe.concurrent('Error.captureStackTrace handling', () => {
    test('should use captureStackTrace when available', () => {
        const spy = spyOn(Error, 'captureStackTrace');
        const error = new IsambardError('test', ErrorCode.STORAGE_ERROR);
        expect(spy).toHaveBeenCalledWith(error, IsambardError);
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
            const error = new IsambardError('test without capture', ErrorCode.STORAGE_ERROR);
            expect(error.message).toBe('test without capture');
            expect(error.name).toBe('IsambardError');
        } finally {
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });

    test('should actually invoke captureStackTrace function', () => {
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

        const error = new IsambardError('capture test', ErrorCode.STORAGE_ERROR);

        expect(captureWasCalled).toBe(true);
        expect(receivedTarget).toBe(error);
        expect(receivedConstructor).toBe(IsambardError);

        spy.mockRestore();
    });
});

describe.concurrent('ErrorCode', () => {
    test('should have storage error codes', () => {
        expect(ErrorCode.STORAGE_ERROR as string).toBe('STORAGE_ERROR');
        expect(ErrorCode.ITEM_NOT_FOUND as string).toBe('ITEM_NOT_FOUND');
        expect(ErrorCode.VALIDATION_ERROR as string).toBe('VALIDATION_ERROR');
        expect(ErrorCode.DYNAMO_TIMEOUT as string).toBe('DYNAMO_TIMEOUT');
    });

    test('should have memory tool error codes', () => {
        expect(ErrorCode.MEMORY_TOOL_ERROR as string).toBe('MEMORY_TOOL_ERROR');
        expect(ErrorCode.PATH_NOT_FOUND as string).toBe('PATH_NOT_FOUND');
        expect(ErrorCode.PATH_ALREADY_EXISTS as string).toBe('PATH_ALREADY_EXISTS');
        expect(ErrorCode.INVALID_PATH as string).toBe('INVALID_PATH');
        expect(ErrorCode.TEXT_NOT_FOUND as string).toBe('TEXT_NOT_FOUND');
        expect(ErrorCode.CONTENT_TOO_LARGE as string).toBe('CONTENT_TOO_LARGE');
        expect(ErrorCode.TEXT_NOT_UNIQUE as string).toBe('TEXT_NOT_UNIQUE');
        expect(ErrorCode.INVALID_LINE_NUMBER as string).toBe('INVALID_LINE_NUMBER');
    });

    test('should have discord error codes', () => {
        expect(ErrorCode.DISCORD_ERROR as string).toBe('DISCORD_ERROR');
        expect(ErrorCode.CHANNEL_NOT_FOUND_BY_ID as string).toBe('CHANNEL_NOT_FOUND_BY_ID');
    });

    test('should have utility error codes', () => {
        expect(ErrorCode.PATH_SECURITY_ERROR as string).toBe('PATH_SECURITY_ERROR');
    });
});
