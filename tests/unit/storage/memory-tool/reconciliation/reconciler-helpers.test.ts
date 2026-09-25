import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import {
    delay, retryWithBackoff, isAbortError, createReconcilerPacers, rcuRateFor, waitBeforeReconcilerRead,
    type ReconcilerOptions
} from '@/storage/memory-tool/reconciliation/reconciler';

function baseOptions(overrides: Partial<ReconcilerOptions> = {}): ReconcilerOptions {
    return {
        operationDelayMs: 0,
        scanPageSize:     25,
        backoff:          { baseDelayMs: 100, maxAttempts: 3 },
        ...overrides,
    };
}

describe('createReconcilerPacers', () => {
    test('creates three independent pacers, each starting with no debt owed', () => {
        const pacers = createReconcilerPacers();
        expect(pacers).toEqual({
            gsi1: { nextAllowedAtMs: 0 },
            gsi2: { nextAllowedAtMs: 0 },
            base: { nextAllowedAtMs: 0 },
        });
        pacers.gsi1.nextAllowedAtMs = 5000;
        expect(pacers.gsi2.nextAllowedAtMs).toBe(0);
        expect(pacers.base.nextAllowedAtMs).toBe(0);
    });
});

describe('rcuRateFor', () => {
    test('defaults to each resource\'s provisioned RCU/s when options.rateLimitRcuPerSec is unset (sst/dynamo.ts)', () => {
        const options = baseOptions();
        expect(rcuRateFor('gsi1', options)).toBe(2);
        expect(rcuRateFor('gsi2', options)).toBe(1);
        expect(rcuRateFor('base', options)).toBe(5);
    });

    test('an override below every resource\'s provisioned RCU/s applies uniformly', () => {
        const options = baseOptions({ rateLimitRcuPerSec: 0.5 });
        expect(rcuRateFor('gsi1', options)).toBe(0.5);
        expect(rcuRateFor('gsi2', options)).toBe(0.5);
        expect(rcuRateFor('base', options)).toBe(0.5);
    });

    test('an override above a resource\'s provisioned RCU/s is capped at that resource\'s own budget, never raised', () => {
        const options = baseOptions({ rateLimitRcuPerSec: 3.5 });
        expect(rcuRateFor('gsi1', options)).toBe(2);
        expect(rcuRateFor('gsi2', options)).toBe(1);
        expect(rcuRateFor('base', options)).toBe(3.5);
    });

    test('an override exactly equal to a resource\'s provisioned RCU/s passes through unchanged', () => {
        const options = baseOptions({ rateLimitRcuPerSec: 2 });
        expect(rcuRateFor('gsi1', options)).toBe(2);
    });
});

describe('waitBeforeReconcilerRead', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('sleeps out debt already owed on the pacer', async () => {
        const pacer = { nextAllowedAtMs: Date.now() + 2000 };
        let resolved = false;
        const waiting = waitBeforeReconcilerRead(pacer, undefined).then(() => {
            resolved = true;
            return undefined;
        });
        await Promise.resolve();
        expect(resolved).toBe(false);
        jest.advanceTimersByTime(2000);
        await waiting;
        expect(resolved).toBe(true);
    });

    test('resolves immediately, with no timer, when no debt is owed', async () => {
        const pacer = { nextAllowedAtMs: 0 };
        await waitBeforeReconcilerRead(pacer, undefined);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('rejects with AbortError when the signal aborts mid-wait, instead of resolving', async () => {
        const controller = new AbortController();
        const pacer = { nextAllowedAtMs: Date.now() + 1000 };
        const waiting = waitBeforeReconcilerRead(pacer, controller.signal);
        controller.abort();
        await expect(waiting).rejects.toBeInstanceOf(DOMException);
        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    });
});

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
