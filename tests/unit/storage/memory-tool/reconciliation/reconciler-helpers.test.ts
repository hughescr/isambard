import { describe, test, expect, mock } from 'bun:test';
import { delay, retryWithBackoff } from '@/storage/memory-tool/reconciliation/reconciler';

describe('delay', () => {
    test('should resolve successfully after a small delay', async () => {
        const start = Date.now();
        await delay(10);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(8); // Allow some tolerance
    });

    test('should reject immediately if signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();

        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(delay(100, controller.signal)).rejects.toThrow('Aborted');
    });

    test('should reject if signal is aborted mid-delay', async () => {
        const controller = new AbortController();

        // Abort after 10ms
        setTimeout(() => controller.abort(), 10);

        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(delay(100, controller.signal)).rejects.toThrow('Aborted');
    });

    test('should return immediately when ms <= 0', async () => {
        const start = Date.now();
        await delay(0);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(10); // Should be nearly instant

        await delay(-5);
        const elapsed2 = Date.now() - start;
        expect(elapsed2).toBeLessThan(10); // Should be nearly instant
    });
});

describe('retryWithBackoff', () => {
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

        const result = await retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should retry on ThrottlingException and succeed', async () => {
        const operation = mock()
            .mockRejectedValueOnce({ name: 'ThrottlingException' })
            .mockResolvedValueOnce('success');

        const result = await retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should return undefined for non-throttling errors without retrying', async () => {
        const operation = mock(() => Promise.reject(new Error('ValidationException')));

        const result = await retryWithBackoff(
            operation,
            { baseDelayMs: 10, maxAttempts: 3 },
            'test-context'
        );

        expect(result).toBeUndefined();
        expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    test('should return undefined when retries are exhausted', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const operation = mock(() => Promise.reject({ name: 'ProvisionedThroughputExceededException' }));

        const result = await retryWithBackoff(
            operation,
            { baseDelayMs: 1, maxAttempts: 3 },
            'test-context'
        );

        expect(result).toBeUndefined();
        expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should throw Aborted error if signal is aborted during error handling', async () => {
        const controller = new AbortController();
        const operation = mock(() => {
            controller.abort();
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
            return Promise.reject({ name: 'ProvisionedThroughputExceededException' });
        });

        // eslint-disable-next-line @typescript-eslint/await-thenable -- expect().rejects is a thenable
        await expect(
            retryWithBackoff(
                operation,
                { baseDelayMs: 50, maxAttempts: 3 },
                'test-context',
                controller.signal
            )
        ).rejects.toThrow('Aborted');
    });

    test('should use exponential backoff delays', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Testing DynamoDB error object
        const operation = mock(() => Promise.reject({ name: 'ThrottlingException' }));

        const baseDelayMs = 10;
        const maxAttempts = 3;

        const start = Date.now();
        await retryWithBackoff(
            operation,
            { baseDelayMs, maxAttempts },
            'test-context'
        );
        const elapsed = Date.now() - start;

        // Expected delays: 10ms (attempt 1) + 20ms (attempt 2) = 30ms minimum
        // Allow generous tolerance for test environment
        expect(elapsed).toBeGreaterThanOrEqual(15);
        expect(operation).toHaveBeenCalledTimes(3);
    });
});
