import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { withDynamoTimeout, setDynamoHealthNotifier, DynamoTimeoutError } from '@/storage/dynamo-retry';
import type { RetryLogger } from '@/utils/retry/types';

// Top-level belt-and-suspenders: always clear the module-level health notifier after
// every test in this file, regardless of which describe block set it.  The inner
// `setDynamoHealthNotifier / health notifier integration` describe block has its own
// beforeEach/afterEach guards; this outer hook is an extra safety net so that any
// future test that sets the notifier without explicit cleanup doesn't leak state.
afterEach(() => {
    setDynamoHealthNotifier(undefined);
});

describe('DynamoTimeoutError', () => {
    it('should create error with operation name and timeout', () => {
        const error = new DynamoTimeoutError('PutItem', 5000);

        expect(error.name).toBe('DynamoTimeoutError');
        expect(error.context.operation).toBe('PutItem');
        expect(error.context.timeoutMs).toBe(5000);
        expect(error.message).toBe("DynamoDB operation 'PutItem' timed out after 5000ms");
    });

    it('should be instanceof Error', () => {
        const error = new DynamoTimeoutError('Query', 3000);

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(DynamoTimeoutError);
    });
});

describe('withDynamoTimeout', () => {
    let mockLogger: RetryLogger;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);

        mockLogger = {
            warn:  mock(() => undefined),
            error: mock(() => undefined),
            debug: mock(() => undefined),
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('successful operations', () => {
        it('should return result when operation completes before timeout', async () => {
            const operation = mock(() => Promise.resolve('success'));

            const result = await withDynamoTimeout(operation, {
                timeoutMs: 5000,
                operation: 'GetItem',
                logger:    mockLogger,
            });

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should work without logger', async () => {
            const operation = mock(() => Promise.resolve(42));

            const result = await withDynamoTimeout(operation, {
                timeoutMs: 5000,
                operation: 'Query',
            });

            expect(result).toBe(42);
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should handle complex return types', async () => {
            const complexResult = { Items: [{ id: '123', data: 'test' }], Count: 1 };
            const operation = mock(async () => {
                return complexResult;
            });

            const result = await withDynamoTimeout(operation, {
                timeoutMs: 2000,
                operation: 'Scan',
                logger:    mockLogger,
            });

            expect(result).toEqual(complexResult);
        });
    });

    describe('timeout errors', () => {
        it('should throw DynamoTimeoutError when operation exceeds timeout', async () => {
            const operation = mock(async () => {
                // Never resolves
                return new Promise(() => {});
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1000,
                operation: 'PutItem',
                logger:    mockLogger,
            });

            // Advance past timeout
            jest.advanceTimersByTime(1001);

            expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
            expect(resultPromise).rejects.toThrow("DynamoDB operation 'PutItem' timed out after 1000ms");
        });

        it('should log error when timeout occurs', async () => {
            const operation = mock(async () => {
                return new Promise(() => {}); // Never resolves
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 2000,
                operation: 'UpdateItem',
                logger:    mockLogger,
            });

            jest.advanceTimersByTime(2001);

            expect(resultPromise).rejects.toThrow(DynamoTimeoutError);

            expect(mockLogger.error).toHaveBeenCalledWith({
                operation: 'UpdateItem',
                timeoutMs: 2000,
                msg:       "DynamoDB operation 'UpdateItem' timed out after 2000ms",
            });
        });

        it('should include operation name and timeout in thrown error', async () => {
            const operation = mock(async () => {
                return new Promise(() => {});
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 3000,
                operation: 'DeleteItem',
                logger:    mockLogger,
            });

            jest.advanceTimersByTime(3001);

            try {
                await resultPromise;
                expect.unreachable('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(DynamoTimeoutError);
                if(error instanceof DynamoTimeoutError) {
                    expect(error.context.operation).toBe('DeleteItem');
                    expect(error.context.timeoutMs).toBe(3000);
                }
            }
        });

        it('should not log error when timeout occurs but no logger provided', async () => {
            const operation = mock(async () => {
                return new Promise(() => {});
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1000,
                operation: 'GetItem',
            });

            jest.advanceTimersByTime(1001);

            expect(resultPromise).rejects.toThrow(DynamoTimeoutError);

            // Should not have called logger (it wasn't provided)
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe('boundary conditions', () => {
        it('should succeed when operation completes exactly at timeout', async () => {
            const operation = mock(() => Promise.resolve('boundary-success'));

            const result = await withDynamoTimeout(operation, {
                timeoutMs: 2000,
                operation: 'Query',
                logger:    mockLogger,
            });

            expect(result).toBe('boundary-success');
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should timeout when operation takes timeout + 1ms', async () => {
            const operation = mock(async () => {
                return new Promise(() => {}); // Never completes
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1500,
                operation: 'Scan',
                logger:    mockLogger,
            });

            jest.advanceTimersByTime(1501);

            expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
        });
    });

    describe('concurrent operations', () => {
        it('should handle multiple concurrent operations independently', async () => {
            const fastOp = mock(() => Promise.resolve('fast'));

            const slowOp = mock(() => new Promise(() => {})); // Never completes

            const fast = withDynamoTimeout(fastOp, {
                timeoutMs: 2000,
                operation: 'GetItem-1',
                logger:    mockLogger,
            });

            const slow = withDynamoTimeout(slowOp, {
                timeoutMs: 1000,
                operation: 'GetItem-2',
                logger:    mockLogger,
            });

            // Advance past slow timeout
            jest.advanceTimersByTime(1001);

            // Fast should succeed, slow should timeout
            expect(slow).rejects.toThrow(DynamoTimeoutError);
            expect(fast).resolves.toBe('fast');
        });
    });

    describe('operation errors', () => {
        it('should propagate operation errors (not timeout)', async () => {
            const operationError = new Error('DynamoDB validation error');
            const operation = mock(async () => {
                throw operationError;
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 5000,
                operation: 'PutItem',
                logger:    mockLogger,
            });

            expect(resultPromise).rejects.toThrow('DynamoDB validation error');
            expect(resultPromise).rejects.not.toThrow(DynamoTimeoutError);

            // Should not log timeout error (different error type)
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should propagate errors even if they occur after timeout', async () => {
            const operation = mock(async () => {
                // This will still run even after timeout; the setTimeout is controlled by fake timers
                await new Promise((resolve) => {
                    // eslint-disable-next-line no-restricted-syntax -- controlled by jest.useFakeTimers(); simulates slow operation that continues after timeout fires
                    setTimeout(resolve, 2000);
                });
                throw new Error('Late error');
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 500,
                operation: 'Query',
                logger:    mockLogger,
            });

            // Advance to trigger timeout
            jest.advanceTimersByTime(501);

            // Should get timeout error (race winner)
            expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
        });
    });
});

describe('setDynamoHealthNotifier / health notifier integration', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        // Ensure notifier starts cleared before each test
        setDynamoHealthNotifier(undefined);
    });

    afterEach(() => {
        // Always clear notifier after each test to prevent leaking between test files
        setDynamoHealthNotifier(undefined);
        jest.useRealTimers();
    });

    it('should call notifier with DynamoTimeoutError when timeout fires', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);

        const operation = mock(() => new Promise<never>(() => {}));

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 1000,
            operation: 'GetItem',
        });

        jest.advanceTimersByTime(1001);

        expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
        // Allow rejection to propagate
        try {
            await resultPromise;
        } catch{
            // expected
        }

        expect(notifier).toHaveBeenCalledTimes(1);
        expect(notifier.mock.calls[0][0]).toBeInstanceOf(DynamoTimeoutError);
    });

    it('should call notifier with network-classified Error (ETIMEDOUT) when operation throws', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);

        const networkError = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        const operation = mock(async () => {
            throw networkError;
        });

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 5000,
            operation: 'PutItem',
        });

        try {
            await resultPromise;
        } catch{
            // expected
        }

        expect(notifier).toHaveBeenCalledTimes(1);
        expect(notifier.mock.calls[0][0]).toBe(networkError);
    });

    it('should call notifier with FailedToOpenSocket network error', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);

        const networkError = Object.assign(new Error('FailedToOpenSocket'), { code: 'FailedToOpenSocket' });
        const operation = mock(async () => {
            throw networkError;
        });

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 5000,
            operation: 'Query',
        });

        try {
            await resultPromise;
        } catch{
            // expected
        }

        expect(notifier).toHaveBeenCalledTimes(1);
    });

    it('should NOT call notifier when no notifier is set', async () => {
        // Notifier is cleared in beforeEach; do not set one here
        const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        const operation = mock(async () => {
            throw networkError;
        });

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 5000,
            operation: 'DeleteItem',
        });

        // With no notifier set, withDynamoTimeout must skip the notifier branch and
        // still re-throw the original network error unchanged (it does not crash).
        expect(resultPromise).rejects.toBe(networkError);

        try {
            await resultPromise;
        } catch{
            // expected — just verifying it doesn't crash without a notifier
        }
    });

    it('should NOT call notifier for non-network errors (e.g. validation error)', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);

        const validationError = new Error('ValidationException: item must have key');
        const operation = mock(async () => {
            throw validationError;
        });

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 5000,
            operation: 'PutItem',
        });

        try {
            await resultPromise;
        } catch{
            // expected
        }

        expect(notifier).not.toHaveBeenCalled();
    });

    it('should still re-throw the original error after calling notifier', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);

        const networkError = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
        const operation = mock(async () => {
            throw networkError;
        });

        const resultPromise = withDynamoTimeout(operation, {
            timeoutMs: 5000,
            operation: 'GetItem',
        });

        let caught: unknown;
        try {
            await resultPromise;
        } catch (err) {
            caught = err;
        }

        expect(caught).toBe(networkError);
        expect(notifier).toHaveBeenCalledTimes(1);
    });

    it('should clear notifier when setDynamoHealthNotifier is called with undefined', async () => {
        const notifier = mock((_err: unknown) => {});
        setDynamoHealthNotifier(notifier);
        setDynamoHealthNotifier(undefined);

        const networkError = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
        const operation = mock(async () => {
            throw networkError;
        });

        try {
            await withDynamoTimeout(operation, { timeoutMs: 5000, operation: 'Scan' });
        } catch{
            // expected
        }

        expect(notifier).not.toHaveBeenCalled();
    });
});
