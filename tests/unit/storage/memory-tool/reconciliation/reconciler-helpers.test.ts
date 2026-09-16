import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { delay, retryWithBackoff, isAbortError } from '@/storage/memory-tool/reconciliation/reconciler';

describe('isAbortError', () => {
    test('recognizes only a DOMException with the AbortError name', () => {
        expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
        expect(isAbortError(new DOMException('bad data', 'DataError'))).toBe(false);
        const ordinaryError = new Error('not a DOM abort');
        ordinaryError.name = 'AbortError';
        expect(isAbortError(ordinaryError)).toBe(false);
    });
});

function namedError(name: string): Error {
    const error = new Error(name);
    error.name = name;
    return error;
}

describe('delay', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('should resolve after delay', async () => {
        const delayPromise = delay(10);
        jest.advanceTimersByTime(10);
        await expect(delayPromise).resolves.toBeUndefined();
    });

    test('should reject immediately if signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        const rejected = delay(100, controller.signal);
        await expect(rejected).rejects.toBeInstanceOf(DOMException);
        await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
        await expect(rejected).rejects.toMatchObject({ message: 'Aborted' });
        await expect(rejected).rejects.toMatchObject({ message: 'Aborted' });
    });

    test('should reject if signal aborted mid-delay', async () => {
        const controller = new AbortController();
        const addListener = jest.spyOn(controller.signal, 'addEventListener');
        const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
        const delayPromise = delay(100, controller.signal);
        controller.abort();
        await expect(delayPromise).rejects.toBeInstanceOf(DOMException);
        await expect(delayPromise).rejects.toMatchObject({ name: 'AbortError' });
        await expect(delayPromise).rejects.toMatchObject({ message: 'Aborted' });
        const registeredListener = addListener.mock.calls.find(([event]) => event === 'abort')?.[1];
        expect(registeredListener).toEqual(expect.any(Function));
        expect(removeListener).toHaveBeenCalledWith('abort', registeredListener);
    });

    test('removes its abort listener after the timer settles', async () => {
        const controller = new AbortController();
        const addListener = jest.spyOn(controller.signal, 'addEventListener');
        const removeListener = jest.spyOn(controller.signal, 'removeEventListener');
        const waiting = delay(10, controller.signal);
        jest.advanceTimersByTime(10);
        await waiting;
        const registeredListener = addListener.mock.calls.find(([event]) => event === 'abort')?.[1];
        expect(registeredListener).toEqual(expect.any(Function));
        expect(removeListener).toHaveBeenCalledWith('abort', registeredListener);
    });

    test('should return immediately when ms <= 0', async () => {
        // Early-return path resolves without registering any timer
        await expect(delay(0)).resolves.toBeUndefined();
        await expect(delay(-5)).resolves.toBeUndefined();
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
        const operation = mock(() => Promise.reject(namedError('ProvisionedThroughputExceededException')));

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
            return Promise.reject(namedError('ProvisionedThroughputExceededException'));
        });

        const rejected = retryWithBackoff(
            operation,
            { baseDelayMs: 50, maxAttempts: 3 },
            'test-context',
            controller.signal
        );
        await expect(rejected).rejects.toBeInstanceOf(DOMException);
        await expect(rejected).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('should use exponential backoff delays', async () => {
        const operation = mock(() => Promise.reject(namedError('ThrottlingException')));

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

    test('retries at 10ms then 20ms, with no early third request', async () => {
        const operation = mock()
            .mockRejectedValueOnce(namedError('ThrottlingException'))
            .mockRejectedValueOnce(namedError('ThrottlingException'))
            .mockResolvedValueOnce('complete');
        const waiting = retryWithBackoff(operation, { baseDelayMs: 10, maxAttempts: 3 }, 'timed');
        await Promise.resolve();
        jest.advanceTimersByTime(9);
        expect(operation).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(operation).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(19);
        expect(operation).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(1);
        expect(await waiting).toBe('complete');
        expect(operation).toHaveBeenCalledTimes(3);
    });
});
