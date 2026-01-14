/**
 * Tests for Discord Retry Logic
 *
 * Verifies that:
 * - Network errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED) are classified as transient and trigger retry
 * - Rate limit errors (429) are classified as permanent (Discord.js handles internally)
 * - Other Discord errors are classified as permanent (no retry)
 * - retryAsync is properly configured with Discord-specific classifier
 */

/* eslint-disable @typescript-eslint/await-thenable -- expect().rejects returns a promise */

import { describe, expect, test, mock } from 'bun:test';
import { classifyDiscordError, withDiscordRetry } from '@/integrations/discord/retry';
import { RateLimitError } from '@/integrations/discord/errors';
import type { RetryDeps } from '@/utils/retry/types';

describe('classifyDiscordError', () => {
    test('classifies ECONNRESET as transient', () => {
        const error = new Error('Connection reset');
        (error as NodeJS.ErrnoException).code = 'ECONNRESET';

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe('Connection reset');
    });

    test('classifies ETIMEDOUT as transient', () => {
        const error = new Error('Connection timed out');
        (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe('Connection timed out');
    });

    test('classifies ECONNREFUSED as transient (kills network error conditional)', () => {
        const error = new Error('Connection refused');
        (error as NodeJS.ErrnoException).code = 'ECONNREFUSED';

        const result = classifyDiscordError(error);

        // CRITICAL: Must be transient for network errors
        expect(result.category).toBe('transient');
        expect(result.message).toBe('Connection refused');
    });

    test('classifies RateLimitError as permanent', () => {
        const error = new RateLimitError(5000);

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

    test('classifies network error without message as transient with default message', () => {
        const error = { code: 'ETIMEDOUT' };

        const result = classifyDiscordError(error);

        expect(result.category).toBe('transient');
        expect(result.message).toBe('Unknown error');
    });

    // Stryker disable next-line ConditionalExpression, BlockStatement: Testing error without code property
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

        const result = await withDiscordRetry(operation, 'test-operation');

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

        const result = await withDiscordRetry(operation, 'test-operation', {
            deps: { sleep: mockSleep, logger: mockLogger } as Partial<RetryDeps>,
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
        const rateLimitError = new RateLimitError(5000);
        const operation = mock().mockRejectedValue(rateLimitError);

        const mockLogger = {
            warn:  mock(),
            error: mock(),
            debug: mock(),
        };

        await expect(
            withDiscordRetry(operation, 'test-operation', {
                deps: { logger: mockLogger } as Partial<RetryDeps>,
            })
        ).rejects.toThrow(RateLimitError);

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
            withDiscordRetry(operation, 'test-operation', {
                policy: { maxAttempts: 3 },
                deps:   { sleep: mockSleep, logger: mockLogger } as Partial<RetryDeps>,
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
            withDiscordRetry(operation, 'test-operation', {
                policy: {
                    maxAttempts: 5,
                    baseDelayMs: 2000,
                },
                deps: { sleep: mockSleep, logger: mockLogger } as Partial<RetryDeps>,
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
            withDiscordRetry(operation, 'test-operation', {
                deps: { logger: mockLogger } as Partial<RetryDeps>,
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
