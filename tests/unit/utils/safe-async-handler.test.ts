import { describe, test, expect, mock, type Mock } from 'bun:test';
import { safeAsyncHandler, type SafeAsyncLogger } from '@/utils/safe-async-handler';

/**
 * Creates a test logger with a mock error method.
 */
function createTestLogger(): { logger: SafeAsyncLogger, errorMock: Mock<(message: string, meta: { error: unknown }) => undefined> } {
    const errorMock = mock((_message: string, _meta: { error: unknown }): undefined => undefined);
    return { logger: { error: errorMock }, errorMock };
}

describe('safeAsyncHandler', () => {
    test('returns a synchronous (void-returning) function', () => {
        const handler = async (): Promise<void> => { /* empty */ };
        const { logger } = createTestLogger();

        const wrapped = safeAsyncHandler(handler, logger);

        // The result should be a function
        expect(typeof wrapped).toBe('function');
        // Calling it should return void (undefined), not a Promise
        // The TypeScript return type is void — the function executes without throwing
        wrapped();
    });

    test('calls the wrapped async handler', async () => {
        const handlerMock = mock(async (): Promise<void> => { /* empty */ });
        const { logger } = createTestLogger();

        const wrapped = safeAsyncHandler(handlerMock, logger);
        wrapped();

        // Give the async handler a chance to run
        await Promise.resolve();

        expect(handlerMock).toHaveBeenCalledTimes(1);
    });

    test('when the async handler rejects, calls logger.error with the error', async () => {
        const error = new Error('test error');
        const handler = async (): Promise<void> => {
            throw error;
        };
        const { logger, errorMock } = createTestLogger();

        const wrapped = safeAsyncHandler(handler, logger);
        wrapped();

        // Give the async rejection a chance to be caught
        await Promise.resolve();

        expect(errorMock).toHaveBeenCalledTimes(1);
        const [_message, meta] = errorMock.mock.calls[0];
        expect(meta).toEqual({ error });
    });

    test('when the async handler rejects with a non-Error, still logs', async () => {
        const handler = async (): Promise<void> => {
            throw 'string error';
        };
        const { logger, errorMock } = createTestLogger();

        const wrapped = safeAsyncHandler(handler, logger);
        wrapped();

        await Promise.resolve();

        expect(errorMock).toHaveBeenCalledTimes(1);
        const [_message, meta] = errorMock.mock.calls[0];
        expect(meta).toEqual({ error: 'string error' });
    });

    test('does NOT throw even if the handler rejects', async () => {
        const handler = async (): Promise<void> => {
            throw new Error('boom');
        };
        const { logger } = createTestLogger();

        const wrapped = safeAsyncHandler(handler, logger);

        // Should not throw synchronously
        expect(() => wrapped()).not.toThrow();

        await Promise.resolve();
    });

    test('passes through all arguments to the wrapped handler', async () => {
        const handlerMock = mock(async (_a: string, _b: number): Promise<void> => { /* empty */ });
        const { logger } = createTestLogger();

        const wrapped = safeAsyncHandler(handlerMock, logger);
        wrapped('hello', 42);

        await Promise.resolve();

        expect(handlerMock).toHaveBeenCalledWith('hello', 42);
    });

    test('works with handlers that take multiple arguments (like process.on signal handler)', async () => {
        const handlerMock = mock(async (_signal: string): Promise<void> => { /* empty */ });
        const { logger } = createTestLogger();

        const wrapped = safeAsyncHandler(handlerMock, logger);
        wrapped('SIGTERM');

        await Promise.resolve();

        expect(handlerMock).toHaveBeenCalledWith('SIGTERM');
    });

    describe('context parameter', () => {
        test('includes context in logged message when context is provided', async () => {
            const error = new Error('oops');
            const handler = async (): Promise<void> => {
                throw error;
            };
            const { logger, errorMock } = createTestLogger();

            const wrapped = safeAsyncHandler(handler, logger, 'SIGINT handler');
            wrapped();

            await Promise.resolve();

            expect(errorMock).toHaveBeenCalledTimes(1);
            const [message, _meta] = errorMock.mock.calls[0];
            expect(message).toBe('SIGINT handler: Error: oops');
        });

        test('logs just the error string when no context is provided', async () => {
            const error = new Error('bare error');
            const handler = async (): Promise<void> => {
                throw error;
            };
            const { logger, errorMock } = createTestLogger();

            const wrapped = safeAsyncHandler(handler, logger);
            wrapped();

            await Promise.resolve();

            expect(errorMock).toHaveBeenCalledTimes(1);
            const [message, _meta] = errorMock.mock.calls[0];
            expect(message).toBe('Error: bare error');
        });
    });
});
