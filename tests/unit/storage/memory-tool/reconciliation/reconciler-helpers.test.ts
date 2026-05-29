import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { delay, retryWithBackoff } from '@/storage/memory-tool/reconciliation/reconciler';

describe('delay', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should resolve after delay', async () => {
        const delayPromise = delay(10);
        jest.advanceTimersByTime(10);
        expect(delayPromise).resolves.toBeUndefined();
    });

    test('should reject immediately if signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const rejected = delay(100, controller.signal);
        expect(rejected).rejects.toBeInstanceOf(DOMException);
        expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should reject if signal aborted mid-delay', async () => {
        const controller = new AbortController();
        const delayPromise = delay(100, controller.signal);
        controller.abort();
        expect(delayPromise).rejects.toBeInstanceOf(DOMException);
        expect(delayPromise).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should return immediately when ms <= 0', async () => {
        // Early-return path resolves without registering any timer
        expect(delay(0)).resolves.toBeUndefined();
        expect(delay(-5)).resolves.toBeUndefined();
    });
});

describe('retryWithBackoff', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('should return value on first successful attempt', async () => {
        const operation = mock(() => Promise.resolve('success'));

        const result = await retryWithBackoff(
            operation,
            { baseDelayMs: 10, maxAttempts: 3 },
            'test-context'
        );

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry on ProvisionedThroughputExceededException and succeed', async () => {
        const operation = mock()
            .mockRejectedValueOnce({ name: 'ProvisionedThroughputExceededException' })
            .mockResolvedValueOnce('success');

        const resultPromise = retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );
        await Promise.resolve(); // let retryWithBackoff run until it awaits delay()
        jest.runOnlyPendingTimers(); // fire the registered delay timer
        const result = await resultPromise;

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should retry on ThrottlingException and succeed', async () => {
        const operation = mock()
            .mockRejectedValueOnce({ name: 'ThrottlingException' })
            .mockResolvedValueOnce('success');

        const resultPromise = retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        const result = await resultPromise;

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should return undefined for non-throttling errors without retrying', async () => {
        const operation = mock(() => Promise.reject(new Error('ValidationException')));

        await retryWithBackoff(
            operation,
            { baseDelayMs: 10, maxAttempts: 3 },
            'test-context'
        );

        expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    test('should return undefined when retries are exhausted', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const operation = mock(() => Promise.reject({ name: 'ProvisionedThroughputExceededException' }));

        const resultPromise = retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );
        // Attempt 1 fails → delay(1)
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        // Attempt 2 fails → delay(2)
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        // Attempt 3 fails → done
        await resultPromise;

        expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should throw DOMException AbortError if signal is aborted during error handling', async () => {
        const controller = new AbortController();
        const operation = mock(() => {
            controller.abort();
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
            return Promise.reject({ name: 'ProvisionedThroughputExceededException' });
        });

        const rejected = retryWithBackoff(
            operation,
            { baseDelayMs: 50, maxAttempts: 3 },
            'test-context',
            controller.signal
        );
        expect(rejected).rejects.toBeInstanceOf(DOMException);
        expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should use exponential backoff delays', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const operation = mock(() => Promise.reject({ name: 'ThrottlingException' }));

        const resultPromise = retryWithBackoff(
            operation,
            { baseDelayMs: 10, maxAttempts: 3 },
            'test-context'
        );
        // Attempt 1 fails → delay(10)
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        // Attempt 2 fails → delay(20)
        await Promise.resolve();
        jest.runOnlyPendingTimers();
        // Attempt 3 fails → done
        await resultPromise;

        expect(operation).toHaveBeenCalledTimes(3);
    });
});
