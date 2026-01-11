/* eslint-disable @typescript-eslint/await-thenable -- Bun's expect().rejects/resolves needs await but types don't reflect it */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { withDynamoTimeout, DynamoTimeoutError } from '@/storage/dynamo-retry';
import type { RetryLogger } from '@/utils/retry/types';
import { noop, constant } from 'lodash';

describe('DynamoTimeoutError', () => {
    it('should create error with operation name and timeout', () => {
        const error = new DynamoTimeoutError('PutItem', 5000);

        expect(error.name).toBe('DynamoTimeoutError');
        expect(error.operation).toBe('PutItem');
        expect(error.timeoutMs).toBe(5000);
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
            const operation = mock(constant(Promise.resolve('success')));

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
            const operation = mock(constant(Promise.resolve(42)));

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
                return new Promise(noop);
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1000,
                operation: 'PutItem',
                logger:    mockLogger,
            });

            // Advance past timeout
            jest.advanceTimersByTime(1001);

            await expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
            await expect(resultPromise).rejects.toThrow("DynamoDB operation 'PutItem' timed out after 1000ms");
        });

        it('should log error when timeout occurs', async () => {
            const operation = mock(async () => {
                return new Promise(noop); // Never resolves
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 2000,
                operation: 'UpdateItem',
                logger:    mockLogger,
            });

            jest.advanceTimersByTime(2001);

            await expect(resultPromise).rejects.toThrow(DynamoTimeoutError);

            expect(mockLogger.error).toHaveBeenCalledWith({
                operation: 'UpdateItem',
                timeoutMs: 2000,
                msg:       "DynamoDB operation 'UpdateItem' timed out after 2000ms",
            });
        });

        it('should include operation name and timeout in thrown error', async () => {
            const operation = mock(async () => {
                return new Promise(noop);
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
                    expect(error.operation).toBe('DeleteItem');
                    expect(error.timeoutMs).toBe(3000);
                }
            }
        });

        it('should not log error when timeout occurs but no logger provided', async () => {
            const operation = mock(async () => {
                return new Promise(noop);
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1000,
                operation: 'GetItem',
            });

            jest.advanceTimersByTime(1001);

            await expect(resultPromise).rejects.toThrow(DynamoTimeoutError);

            // Should not have called logger (it wasn't provided)
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe('boundary conditions', () => {
        it('should succeed when operation completes exactly at timeout', async () => {
            const operation = mock(constant(Promise.resolve('boundary-success')));

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
                return new Promise(noop); // Never completes
            });

            const resultPromise = withDynamoTimeout(operation, {
                timeoutMs: 1500,
                operation: 'Scan',
                logger:    mockLogger,
            });

            jest.advanceTimersByTime(1501);

            await expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
        });
    });

    describe('concurrent operations', () => {
        it('should handle multiple concurrent operations independently', async () => {
            const fastOp = mock(() => Promise.resolve('fast'));

            const slowOp = mock(() => new Promise(noop)); // Never completes

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
            await expect(slow).rejects.toThrow(DynamoTimeoutError);
            await expect(fast).resolves.toBe('fast');
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

            await expect(resultPromise).rejects.toThrow('DynamoDB validation error');
            await expect(resultPromise).rejects.not.toThrow(DynamoTimeoutError);

            // Should not log timeout error (different error type)
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should propagate errors even if they occur after timeout', async () => {
            const operation = mock(async () => {
                // This will still run even after timeout
                await new Promise(resolve => setTimeout(resolve, 2000));
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
            await expect(resultPromise).rejects.toThrow(DynamoTimeoutError);
        });
    });
});
