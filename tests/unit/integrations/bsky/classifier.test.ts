import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError } from '@/errors';
import { createBskyClassifier } from '@/integrations/bsky/classifier';
import { retryAsync } from '@/utils';

describe.concurrent('createBskyClassifier', () => {
    describe.concurrent('BskyRateLimitError classification', () => {
        it('classifies BskyRateLimitError as rate_limited', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyRateLimitError('Too many requests');
            const result     = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.message).toBe('Too many requests');
        });

        it('classifies BskyRateLimitError without retryAfterMs as rate_limited with no retryAfterMs', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyRateLimitError('Rate limited', { originalMessage: 'RateLimitExceeded' });
            const result     = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('classifies BskyRateLimitError with retryAfterMs in context as rate_limited with retryAfterMs', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyRateLimitError('Rate limited', { retryAfterMs: 30_000 });
            const result     = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(30_000);
        });

        it('ignores non-number retryAfterMs in context', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyRateLimitError('Rate limited', { retryAfterMs: 'not-a-number' });
            const result     = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('handles zero retryAfterMs correctly', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyRateLimitError('Rate limited', { retryAfterMs: 0 });
            const result     = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(0);
        });
    });

    describe.concurrent('BskyAuthError classification', () => {
        it('classifies BskyAuthError as permanent (auth needs re-login, not retry)', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyAuthError('Authentication required');
            const result     = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('Authentication required');
        });
    });

    describe.concurrent('BskyError classification', () => {
        it('classifies base BskyError as permanent (domain errors should not be retried)', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyError('Post not found');
            const result     = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('Post not found');
        });

        it('classifies BskyValidationError as permanent (validation errors should not be retried)', () => {
            const classifier = createBskyClassifier();
            const error      = new BskyValidationError('Post too long');
            const result     = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('Post too long');
        });
    });

    describe.concurrent('Non-Bsky error fallback to HTTP status classifier', () => {
        it('classifies non-Error value as transient (default classifier fallback)', () => {
            const classifier = createBskyClassifier();
            const result     = classifier('something went wrong');

            expect(result.category).toBe('transient');
            expect(result.message).toBe('something went wrong');
        });

        it('classifies generic Error as transient', () => {
            const classifier = createBskyClassifier();
            const error      = new Error('Network error');
            const result     = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Network error');
        });
    });
});

describe('createBskyClassifier — retry integration with fake timers', () => {
    let sleepCalls: number[];

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        sleepCalls = [];
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('retries on BskyRateLimitError and succeeds on second attempt', async () => {
        const classifier = createBskyClassifier();

        let callCount = 0;
        const operation = mock(async () => {
            callCount++;
            if(callCount === 1) {
                throw new BskyRateLimitError('Too many requests');
            }
            return 'success';
        });

        const sleepMock = mock((ms: number) => {
            sleepCalls.push(ms);
            jest.advanceTimersByTime(ms);
            return Promise.resolve();
        });

        const result = await retryAsync(operation, {
            classifier,
            policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0 },
            deps:   {
                sleep:  sleepMock,
                now:    () => Date.now(),
                logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
            },
        });

        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
        expect(sleepCalls).toHaveLength(1);
    });

    it('respects retryAfterMs from BskyRateLimitError context', async () => {
        const classifier = createBskyClassifier();

        let callCount = 0;
        const operation = mock(async () => {
            callCount++;
            if(callCount === 1) {
                throw new BskyRateLimitError('Too many requests', { retryAfterMs: 60_000 });
            }
            return 'ok';
        });

        const sleepMock = mock((ms: number) => {
            sleepCalls.push(ms);
            jest.advanceTimersByTime(ms);
            return Promise.resolve();
        });

        const result = await retryAsync(operation, {
            classifier,
            policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0 },
            deps:   {
                sleep:  sleepMock,
                now:    () => Date.now(),
                logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
            },
        });

        expect(result).toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
        // Should use retryAfterMs (60_000) not the default backoff (1000)
        expect(sleepCalls[0]).toBe(60_000);
    });

    it('exhausts retries and throws on repeated BskyRateLimitError', async () => {
        const classifier     = createBskyClassifier();
        const rateLimitError = new BskyRateLimitError('Rate limit exceeded');
        const operation      = mock(async () => {
            throw rateLimitError;
        });

        const sleepMock = mock((ms: number) => {
            sleepCalls.push(ms);
            jest.advanceTimersByTime(ms);
            return Promise.resolve();
        });

        const prom = retryAsync(operation, {
            classifier,
            policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0 },
            deps:   {
                sleep:  sleepMock,
                now:    () => Date.now(),
                logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
            },
        });

        expect(prom).rejects.toBeInstanceOf(BskyRateLimitError);
        // Need to advance timers to let sleep promises resolve
        jest.runAllTimers();
        await prom.catch(() => undefined);

        expect(operation).toHaveBeenCalledTimes(3);
        expect(sleepCalls).toHaveLength(2); // 2 sleeps between 3 attempts
    });

    it('does not retry on BskyAuthError (permanent)', async () => {
        const classifier = createBskyClassifier();
        const authError  = new BskyAuthError('Auth required');
        const operation  = mock(async () => {
            throw authError;
        });

        const sleepMock = mock((ms: number) => {
            sleepCalls.push(ms);
            jest.advanceTimersByTime(ms);
            return Promise.resolve();
        });

        const prom = retryAsync(operation, {
            classifier,
            policy: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0 },
            deps:   {
                sleep:  sleepMock,
                now:    () => Date.now(),
                logger: { warn: () => undefined, error: () => undefined, debug: () => undefined },
            },
        });

        expect(prom).rejects.toBeInstanceOf(BskyAuthError);
        await prom.catch(() => undefined);

        expect(operation).toHaveBeenCalledTimes(1);
        expect(sleepCalls).toHaveLength(0);
    });
});
