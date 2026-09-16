/**
 * Tests for Discord Retry Logic
 *
 * Verifies that:
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) are classified as transient and trigger retry
 * - Rate limit errors (429) are classified as permanent (Discord.js handles internally)
 * - Other Discord errors are classified as permanent (no retry)
 * - retryAsync is properly configured with Discord-specific classifier
 */

import { describe, expect, test, mock } from 'bun:test';
import { originalWithDiscordRetry as withDiscordRetry, originalClassifyDiscordError as classifyDiscordError } from '../../../setup';

describe('classifyDiscordError', () => {
    // CRITICAL: Must be transient for network errors (also kills network error conditional)
    test.each([
        { code: 'ECONNRESET', message: 'Connection reset' },
        { code: 'ETIMEDOUT', message: 'Connection timed out' },
        { code: 'ECONNREFUSED', message: 'Connection refused' }
    ])('classifies $code as transient', ({ code, message }) => {
        const error = new Error(message);
        (error as NodeJS.ErrnoException).code = code;

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe(message);
    });

    test('classifies rate limit error as permanent', () => {
        const error = new Error('rate limit exceeded');

        const result = classifyDiscordError(error);

        expect(result.category).toBe('permanent');
        expect(result.message).toContain('rate limit');
    });

    test('classifies generic Error as permanent', () => {
        const error = new Error('Generic Discord error');

        const result = classifyDiscordError(error);

        expect(result.category).toBe('permanent');
        expect(result.message).toBe('Generic Discord error');
    });

    test('classifies unknown error type as permanent', () => {
        const error = 'String error';

        const result = classifyDiscordError(error);

        expect(result.category).toBe('permanent');
        expect(result.message).toBe('String error');
    });

    test('classifies Error with empty message as permanent with default message', () => {
        const error = new Error('placeholder');
        error.message = '';

        const result = classifyDiscordError(error);

        expect(result.category).toBe('permanent');
        expect(result.message).toBe('Unknown error');
    });

    test('classifies Error with falsy non-string message as permanent with default message', () => {
        const error = new Error('placeholder');
        // Error#message is typed string, but a JS caller can leave any falsy non-string value there;
        // the guard must treat it as "no usable message" rather than adopting it.
        Object.defineProperty(error, 'message', { value: null, writable: true });

        const result = classifyDiscordError(error);

        expect(result.category).toBe('permanent');
        expect(result.message).toBe('Unknown error');
    });

    test('classifies empty string error as permanent with default message', () => {
        const result = classifyDiscordError('');

        expect(result.category).toBe('permanent');
        expect(result.message).toBe('Unknown error');
    });

    test('classifies network error without message as transient with default message', () => {
        const error = { code: 'ETIMEDOUT' };

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe('Unknown error');
    });

    test('classifies AbortError as transient', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe('The operation was aborted');
    });

    test('classifies non-Error object with AbortError name as permanent', () => {
        const error = { name: 'AbortError', message: 'not a real Error' };
        const result = classifyDiscordError(error);
        expect(result.category).toBe('permanent');
    });

    test('classifies error without code property as permanent', () => {
        const error = { message: 'Some error without code' };

        const result = classifyDiscordError(error);

        // Plain objects without Error type result in 'Unknown error' message
        expect(result.category).toBe('permanent');
        expect(result.message).toBe('Unknown error');
    });
});

describe('withDiscordRetry', () => {
    test('succeeds on first attempt without retry', async () => {
        const operation = mock().mockResolvedValue('success');

        const result = await withDiscordRetry(operation);

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    test('retries transient network error (ECONNRESET)', async () => {
        const networkError = new Error('Connection reset');
        (networkError as NodeJS.ErrnoException).code = 'ECONNRESET';

        const operation = mock()
            .mockRejectedValueOnce(networkError)
            .mockResolvedValueOnce('success');

        const mockSleep = mock().mockResolvedValue(undefined);
        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        const result = await withDiscordRetry(operation, {
            deps: { sleep: mockSleep, logger: mockLogger },
        });

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                msg:      'Retrying after error',
                category: 'transient',
            })
        );
    });

    test('does NOT retry rate limit error (permanent)', async () => {
        const rateLimitError = new Error('rate limit exceeded');
        const operation = mock().mockRejectedValue(rateLimitError);

        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        await expect(
            withDiscordRetry(operation, {
                deps: { logger: mockLogger },
            })
        ).rejects.toThrow('rate limit exceeded');

        expect(operation).toHaveBeenCalledTimes(1); // No retry
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                msg:      'Retry aborted due to permanent error',
                category: 'permanent',
            })
        );
    });

    test('exhausts retries on repeated transient failures', async () => {
        const networkError = new Error('Connection reset');
        (networkError as NodeJS.ErrnoException).code = 'ECONNRESET';

        const operation = mock().mockRejectedValue(networkError);

        const mockSleep = mock().mockResolvedValue(undefined);
        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        await expect(
            withDiscordRetry(operation, {
                policy: { maxAttempts: 3 },
                deps:   { sleep: mockSleep, logger: mockLogger },
            })
        ).rejects.toThrow('Connection reset');

        expect(operation).toHaveBeenCalledTimes(3);
        expect(mockLogger.warn).toHaveBeenCalledTimes(2); // 2 retries (attempt 1, attempt 2)
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                msg:      'Max retry attempts exhausted',
                attempts: 3,
            })
        );
    });

    test('uses custom retry policy', async () => {
        const networkError = new Error('Timeout');
        (networkError as NodeJS.ErrnoException).code = 'ETIMEDOUT';

        const operation = mock().mockRejectedValue(networkError);

        const mockSleep = mock().mockResolvedValue(undefined);
        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        await expect(
            withDiscordRetry(operation, {
                policy: {
                    maxAttempts: 5,
                    baseDelayMs: 2000,
                },
                deps: { sleep: mockSleep, logger: mockLogger },
            })
        ).rejects.toThrow('Timeout');

        expect(operation).toHaveBeenCalledTimes(5); // Custom maxAttempts
    });

    test('does NOT retry generic Discord error', async () => {
        const genericError = new Error('Invalid channel ID');
        const operation = mock().mockRejectedValue(genericError);

        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        await expect(
            withDiscordRetry(operation, {
                deps: { logger: mockLogger },
            })
        ).rejects.toThrow('Invalid channel ID');

        expect(operation).toHaveBeenCalledTimes(1); // No retry
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                msg:      'Retry aborted due to permanent error',
                category: 'permanent',
            })
        );
    });
});
