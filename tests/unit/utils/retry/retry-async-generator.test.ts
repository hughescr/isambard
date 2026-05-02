import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { retryAsyncGenerator } from '../../../../src/utils/retry/retry-async-generator';
import type { ErrorClassifier, RetryDeps, RetryLogger, RetryPolicy } from '../../../../src/utils/retry/types';

describe('retryAsyncGenerator', () => {
    let mockLogger: RetryLogger;
    let sleepMock: ReturnType<typeof mock>;
    let nowMock: ReturnType<typeof mock>;
    let deps: RetryDeps;

    const defaultPolicy: RetryPolicy = {
        maxAttempts:       3,
        baseDelayMs:       1000,
        maxDelayMs:        30_000,
        backoffMultiplier: 2,
        jitterFraction:    0.1,
    };

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);

        mockLogger = {
            warn:  mock(() => {}),
            error: mock(() => {}),
            debug: mock(() => {}),
        };

        sleepMock = mock((ms: number) => {
            jest.advanceTimersByTime(ms);
            return Promise.resolve();
        });

        nowMock = mock(() => Date.now());

        deps = {
            sleep:  sleepMock,
            now:    nowMock,
            logger: mockLogger,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Successful generators', () => {
        it('should yield all values from generator on first successful attempt', async () => {
            async function* generator() {
                yield 1;
                yield 2;
                yield 3;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2, 3]);
            expect(generatorFactory).toHaveBeenCalledTimes(1);
            expect(classifier).not.toHaveBeenCalled();
            expect(sleepMock).not.toHaveBeenCalled();
        });

        it('should restart generator from beginning after transient error', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    yield 1;
                    throw new Error('Transient error');
                }
                yield 1;
                yield 2;
                yield 3;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            // Should get fresh stream from restart
            expect(results).toEqual([1, 1, 2, 3]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
            expect(classifier).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it('should succeed after multiple retries', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    yield callCount;
                    throw new Error('Transient error');
                }
                yield 1;
                yield 2;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            // Gets partial results from failed attempts, then full results on success
            expect(results).toEqual([1, 2, 1, 2]);
            expect(generatorFactory).toHaveBeenCalledTimes(3);
            expect(classifier).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('Generator without yields before error', () => {
        it('should retry generator that throws before yielding', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Immediate error');
                }
                yield 1;
                yield 2;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Immediate error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
        });
    });

    describe('Empty generators', () => {
        it('should handle generator that yields nothing', async () => {
            async function* generator() {
                // Yields nothing
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([]);
            expect(generatorFactory).toHaveBeenCalledTimes(1);
        });

        it('should retry empty generator that throws', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Transient error');
                }
                // Success on second attempt, but yields nothing
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('Permanent errors', () => {
        it('should throw immediately on permanent error without retrying', async () => {
            async function* generator() {
                yield 1;
                throw new Error('Permanent error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'permanent', message: 'Permanent error' }));

            const results: number[] = [];

            expect(async () => {
                for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    results.push(value);
                }
            }).toThrow('Permanent error');

            expect(results).toEqual([1]); // Got value before error
            expect(generatorFactory).toHaveBeenCalledTimes(1);
            expect(classifier).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        it('should throw permanent error after initial transient errors', async () => {
            let callCount = 0;
            const transientError = new Error('Transient error');
            const permanentError = new Error('Permanent error');

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw transientError;
                }
                yield 1;
                throw permanentError;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>((error: unknown) => {
                if(error === transientError) {
                    return { category: 'transient', message: 'Transient error' };
                }
                return { category: 'permanent', message: 'Permanent error' };
            });

            const results: number[] = [];

            expect(async () => {
                for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    results.push(value);
                }
            }).toThrow('Permanent error');

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('Rate limiting', () => {
        it('should respect retryAfterMs when it exceeds exponential backoff', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Rate limited');
                }
                yield 1;
                yield 2;
            }

            const generatorFactory = mock(generator);
            // retryAfterMs=5000 > backoff for attempt 1 (base 1000ms), so server hint wins
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 5000,
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2]);
            expect(sleepMock).toHaveBeenCalledWith(5000); // Server hint (5000) > backoff (~1000) → use server hint
        });

        it('should use exponential backoff when retryAfterMs is less than computed backoff', async () => {
            let callCount = 0;

            // eslint-disable-next-line sonarjs/no-identical-functions -- distinct test context (retryAfterMs<backoff), identical generator structure intentional for test isolation
            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Rate limited');
                }
                yield 1;
                yield 2;
            }

            const generatorFactory = mock(generator);
            // retryAfterMs=10ms < backoff for attempt 1 (base 1000ms), so backoff wins
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 10,
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2]);
            // Must use the exponential backoff (~1000ms), not the server hint (10ms)
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900); // Exponential backoff floor with jitter
            expect(sleepDuration).toBeLessThanOrEqual(1100); // Exponential backoff ceiling with jitter
        });

        it('should use exponential backoff when retryAfterMs is zero (clock-skew / rolled-over window)', async () => {
            let callCount = 0;

            // eslint-disable-next-line sonarjs/no-identical-functions -- distinct test context (retryAfterMs=0/zero-hint), identical generator structure intentional for test isolation
            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Rate limited');
                }
                yield 1;
                yield 2;
            }

            const generatorFactory = mock(generator);
            // retryAfterMs=0 — server hint is useless; backoff must take over
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 0,
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2]);
            // With max(0, backoff), the sleep must be the exponential value, not 0
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900);
            expect(sleepDuration).toBeLessThanOrEqual(1100);
        });
    });

    describe('Max attempts exhausted', () => {
        it('should throw after maxAttempts transient errors', async () => {
            async function* generator() {
                throw new Error('Transient error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    // Never gets here
                }
            }).toThrow('Transient error');

            expect(generatorFactory).toHaveBeenCalledTimes(3); // maxAttempts
            expect(classifier).toHaveBeenCalledTimes(3);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        it('should throw original error on final attempt', async () => {
            const originalError = new Error('Original error message');

            async function* generator() {
                throw originalError;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    // Never gets here
                }
            }).toThrow('Original error message');
        });
    });

    describe('Logging', () => {
        it('should log warning on transient error with retry details', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Network timeout');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Network timeout' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const logCall = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];

            expect(logCall).toHaveProperty('msg');
            expect(logCall).toHaveProperty('attempt', 1);
            expect(logCall).toHaveProperty('maxAttempts', 3);
            expect(logCall).toHaveProperty('category', 'transient');
            expect(logCall).toHaveProperty('errorMessage', 'Network timeout');
            expect(logCall).toHaveProperty('delayMs');
        });
    });

    describe('Edge cases', () => {
        it('should handle generator yielding undefined', async () => {
            async function* generator() {
                yield undefined;
                yield undefined;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: (undefined)[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([undefined, undefined]);
        });

        it('should handle generator yielding null', async () => {
            async function* generator() {
                yield null;
                yield null;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: (null)[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([null, null]);
        });

        it('should handle maxAttempts of 1', async () => {
            const policy: RetryPolicy = { ...defaultPolicy, maxAttempts: 1 };

            async function* generator() {
                throw new Error('Error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, { policy, classifier, deps })) {
                    // Never gets here
                }
            }).toThrow();

            expect(generatorFactory).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
        });

        it('should handle generator yielding many values before error', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    for(let i = 0; i < 100; i++) {
                        yield i;
                    }
                    throw new Error('Transient error');
                }
                yield 200;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            // Gets all 100 values from first attempt, then 1 value from second attempt
            expect(results.length).toBe(101);
            expect(results.slice(0, 100)).toEqual(Array.from({ length: 100 }, (_, i) => i));
            expect(results[100]).toBe(200);
        });
    });

    describe('Default behavior', () => {
        it('should use default policy when not provided', async () => {
            async function* generator() {
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
        });

        it('should use default classifier when not provided', async () => {
            async function* generator() {
                yield 1;
            }

            const generatorFactory = mock(generator);

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
        });
    });

    describe('Policy validation', () => {
        it('should revert to defaults when policy has invalid values', async () => {
            const invalidPolicy = {
                maxAttempts: -1, // Invalid
                baseDelayMs: -100, // Invalid
            };

            let callCount = 0;
            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: invalidPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            // Should use default maxAttempts (5) instead of invalid -1
            expect(generatorFactory).toHaveBeenCalledTimes(3);
        });

        it('should revert to defaults when policy is completely invalid', async () => {
            const invalidPolicy = {
                maxAttempts: 'not-a-number', // Invalid type
                baseDelayMs: null, // Invalid type
            };

            async function* generator() {
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: invalidPolicy as unknown as Partial<RetryPolicy>, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(1);
        });

        it('should accept partially valid policy and merge with defaults', async () => {
            const partialPolicy = {
                maxAttempts: 2, // Valid
                baseDelayMs: -100, // Invalid - should use default
            };

            let callCount = 0;
            async function* generator() {
                callCount++;
                if(callCount < 2) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: partialPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
        });

        it('should handle empty policy object', async () => {
            async function* generator() {
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: {}, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(1);
        });
    });

    describe('retryAfterMs precedence', () => {
        it('should use retryAfterMs when provided instead of calculated delay', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Rate limited');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 7500,
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            // Should use retryAfterMs (7500) not calculated delay
            expect(sleepMock).toHaveBeenCalledWith(7500);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it('should use exponential backoff when retryAfterMs is zero (not bypass backoff)', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Zero hint');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            // retryAfterMs=0 means the server hint is useless (clock-skew / just-rolled-over window);
            // backoff must take over via Math.max(0, backoff)
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'rate_limited',
                message:      'Zero hint',
                retryAfterMs: 0,
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            // With max(0, backoff), must use the exponential backoff value, not 0
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900);
            expect(sleepDuration).toBeLessThanOrEqual(1100);
        });

        it('should use retryAfterMs when it dominates computed backoff across multiple retries', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error(`Retry ${callCount}`);
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            // retryAfterMs=5000 for retry 1 and 7000 for retry 2 both exceed backoff (~1000ms and ~2000ms),
            // so the server hint wins for both via Math.max(retryAfterMs, backoff)
            const classifier = mock<ErrorClassifier>((error: unknown) => {
                const err = error as Error;
                if(err.message === 'Retry 1') {
                    return {
                        category:     'rate_limited',
                        message:      'Retry 1',
                        retryAfterMs: 5000,
                    };
                }
                return {
                    category:     'rate_limited',
                    message:      'Retry 2',
                    retryAfterMs: 7000,
                };
            });

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            // Server hints (5000 and 7000) exceed backoff (~1000ms and ~2000ms), so they win
            expect(sleepMock.mock.calls[0][0]).toBe(5000);
            expect(sleepMock.mock.calls[1][0]).toBe(7000);
        });

        it('should fall back to calculated delay when retryAfterMs is undefined', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({
                category:     'transient',
                message:      'Transient error',
                retryAfterMs: undefined, // Explicitly undefined
            }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            // Should use calculated delay, not 0 or undefined
            expect(sleepMock).toHaveBeenCalledTimes(1);
            const delayUsed = sleepMock.mock.calls[0][0] as number;
            expect(delayUsed).toBeGreaterThan(0);
            // Should be roughly baseDelayMs (1000) with jitter
            expect(delayUsed).toBeGreaterThanOrEqual(900);
            expect(delayUsed).toBeLessThanOrEqual(1100);
        });
    });

    describe('Mixed error sequences', () => {
        it('should handle transient error followed by permanent error', async () => {
            let callCount = 0;
            const transientError = new Error('Transient error');
            const permanentError = new Error('Permanent error');

            // eslint-disable-next-line sonarjs/no-identical-functions -- distinct test context (mixed-error sequence), identical structure intentional for test isolation
            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw transientError;
                }
                yield 1;
                throw permanentError;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>((error: unknown) => {
                if(error === transientError) {
                    return { category: 'transient', message: 'Transient error' };
                }
                return { category: 'permanent', message: 'Permanent error' };
            });

            const results: number[] = [];

            expect(async () => {
                for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    results.push(value);
                }
            }).toThrow('Permanent error');

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        it('should handle rate limited then transient then success', async () => {
            let callCount = 0;
            const rateLimitError = new Error('Rate limited');
            const transientError = new Error('Transient error');

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw rateLimitError;
                }
                if(callCount === 2) {
                    throw transientError;
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>((error: unknown) => {
                if(error === rateLimitError) {
                    return {
                        category:     'rate_limited',
                        message:      'Rate limited',
                        retryAfterMs: 2000,
                    };
                }
                return { category: 'transient', message: 'Transient error' };
            });

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(3);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            // First delay should be retryAfterMs
            expect(sleepMock.mock.calls[0][0]).toBe(2000);
            // Second delay should be calculated
            const secondDelay = sleepMock.mock.calls[1][0] as number;
            expect(secondDelay).toBeGreaterThan(0);
        });

        it('should handle mixed error categories with different retry behaviors', async () => {
            let callCount = 0;
            const errors = [
                new Error('Rate limit 1'),
                new Error('Transient 1'),
            ];

            async function* generator() {
                callCount++;
                if(callCount <= 2) {
                    throw errors[callCount - 1];
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>((error: unknown) => {
                const err = error as Error;
                if(err.message.startsWith('Rate limit')) {
                    return {
                        category:     'rate_limited',
                        message:      err.message,
                        retryAfterMs: 1500,
                    };
                }
                return { category: 'transient', message: err.message };
            });

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(generatorFactory).toHaveBeenCalledTimes(3);
            expect(classifier).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            // Both delays should be 1500 (retryAfterMs) and calculated delay
            expect(sleepMock.mock.calls[0][0]).toBe(1500);
        });
    });

    describe('Elapsed time tracking', () => {
        it('should track elapsed time correctly across retries', async () => {
            let callCount = 0;

            // eslint-disable-next-line sonarjs/no-identical-functions -- distinct test context (elapsed time tracking), identical structure intentional for test isolation
            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            // Custom sleep that advances time by specific amounts
            const customSleep = mock((ms: number) => {
                jest.advanceTimersByTime(ms);
                return Promise.resolve();
            });

            const customDeps = {
                ...deps,
                sleep: customSleep,
            };

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps: customDeps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);

            // Check warn log calls for elapsed time
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
            const firstWarn = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];
            const secondWarn = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[1][0];

            expect(firstWarn).toHaveProperty('elapsedMs');
            expect(secondWarn).toHaveProperty('elapsedMs');

            // Second elapsed should be greater than first
            expect((secondWarn as { elapsedMs: number }).elapsedMs).toBeGreaterThan(
                (firstWarn as { elapsedMs: number }).elapsedMs
            );
        });

        it('should track attempt number correctly', async () => {
            let callCount = 0;

            // eslint-disable-next-line sonarjs/no-identical-functions -- distinct test context (attempt number tracking), identical structure intentional for test isolation
            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);

            // Verify attempt numbers in logs
            const firstWarn = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];
            const secondWarn = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[1][0];

            expect(firstWarn).toHaveProperty('attempt', 1);
            expect(secondWarn).toHaveProperty('attempt', 2);
        });

        it('should log elapsed time for permanent errors', async () => {
            async function* generator() {
                yield 1;
                throw new Error('Permanent error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'permanent', message: 'Permanent error' }));

            // eslint-disable-next-line sonarjs/no-unused-collection -- results collected within error-throwing async; test verifies error behavior not collection contents
            const results: number[] = [];

            expect(async () => {
                for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    results.push(value);
                }
            }).toThrow('Permanent error');

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const errorLog = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];

            expect(errorLog).toHaveProperty('elapsedMs');
            expect(errorLog).toHaveProperty('attempt', 1);
            expect((errorLog as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
        });

        it('should log elapsed time for max attempts exhausted', async () => {
            async function* generator() {
                throw new Error('Transient error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Transient error' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    // Never gets here
                }
            }).toThrow('Transient error');

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const errorLog = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];

            expect(errorLog).toHaveProperty('elapsedMs');
            expect(errorLog).toHaveProperty('attempts', 3);
            expect((errorLog as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Mutation testing: elapsed time tracking', () => {
        it('should track increasing elapsed time across retries (kills now() + startTime)', async () => {
            async function* generator() {
                throw new Error('transient');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'transient' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                    // Never gets here
                }
            }).toThrow();

            const firstWarnLog = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];
            const secondWarnLog = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[1][0];
            const errorLog = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];

            const firstElapsed = (firstWarnLog as { elapsedMs: number }).elapsedMs;
            const secondElapsed = (secondWarnLog as { elapsedMs: number }).elapsedMs;
            const finalElapsed = (errorLog as { elapsedMs: number }).elapsedMs;

            // CRITICAL: Elapsed time must strictly increase over time
            // With subtraction (now() - startTime), later calls have larger elapsed
            expect(secondElapsed).toBeGreaterThan(firstElapsed);
            expect(finalElapsed).toBeGreaterThanOrEqual(secondElapsed);

            // All must be non-negative
            expect(firstElapsed).toBeGreaterThanOrEqual(0);
            expect(secondElapsed).toBeGreaterThanOrEqual(0);
            expect(finalElapsed).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Mutation testing: attempt counting', () => {
        it('should make exactly maxAttempts attempts before giving up', async () => {
            async function* generator() {
                throw new Error('always fails');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'always fails' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 3 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            // Exactly 3 attempts, not 2 or 4 (kills attempt++ vs attempt-- mutations)
            expect(generatorFactory).toHaveBeenCalledTimes(3);
        });

        it('should make exactly maxAttempts attempts with different maxAttempts value', async () => {
            async function* generator() {
                throw new Error('always fails');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'always fails' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 5 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            // Exactly 5 attempts (verifies loop boundary)
            expect(generatorFactory).toHaveBeenCalledTimes(5);
        });

        it('should log correct attempt numbers in sequence', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('transient');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'transient' }));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);

            // Verify attempt numbers are sequential and correct
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);

            const firstWarnLog = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];
            const secondWarnLog = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[1][0];

            expect(firstWarnLog).toHaveProperty('attempt', 1);
            expect(secondWarnLog).toHaveProperty('attempt', 2);
        });
    });

    describe('Mutation testing: loop boundary conditions', () => {
        it('should respect loop boundary exactly at maxAttempts', async () => {
            async function* generator() {
                throw new Error('always fails');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'always fails' }));

            // Test with maxAttempts = 1 (boundary case)
            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 1 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            expect(generatorFactory).toHaveBeenCalledTimes(1);

            // Reset for next test
            generatorFactory.mockClear();

            // Test with maxAttempts = 2 (verifies < vs <= boundary)
            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 2 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            expect(generatorFactory).toHaveBeenCalledTimes(2);
        });

        it('should stop exactly at maxAttempts and not continue', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                throw new Error('always fails');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'always fails' }));

            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 4 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            // Exactly 4, not 3 or 5 (kills < vs <= mutations)
            expect(generatorFactory).toHaveBeenCalledTimes(4);
            expect(callCount).toBe(4);
        });

        it('should not call generator more than maxAttempts times (kills attempt <= maxAttempts)', async () => {
            // This test specifically targets the `attempt < maxAttempts` vs `attempt <= maxAttempts` boundary
            // If mutated to `<=`, it would run maxAttempts + 1 times
            let callCount = 0;

            async function* generator() {
                callCount++;
                throw new Error('always fails');
            }

            const generatorFactory = mock(generator);
            const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'always fails' }));

            // Use maxAttempts = 3 to make it clear
            expect(async () => {
                for await (const _ of retryAsyncGenerator(generatorFactory, {
                    policy: { ...defaultPolicy, maxAttempts: 3 },
                    classifier,
                    deps,
                })) {
                    // Never gets here
                }
            }).toThrow();

            // Must be exactly 3, not 4 (which would happen with <= mutation)
            expect(generatorFactory).toHaveBeenCalledTimes(3);
            expect(callCount).toBe(3);

            // Verify sleep was called maxAttempts - 1 times (between retries)
            expect(sleepMock).toHaveBeenCalledTimes(2);

            // Verify warn logs were called maxAttempts - 1 times
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);

            // Verify error log was called once (final failure)
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const errorLog = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];
            expect(errorLog).toHaveProperty('attempts', 3); // Not 4
        });
    });
});

// Separate test suite for real timers
describe('retryAsyncGenerator with real timers', () => {
    it('should use default deps when not provided', async () => {
        async function* generator() {
            yield 1;
        }

        const generatorFactory = mock(generator);
        const classifier = mock<ErrorClassifier>(() => ({ category: 'transient', message: 'Error' }));

        const results: number[] = [];
        for await (const value of retryAsyncGenerator(generatorFactory, { classifier })) {
            results.push(value);
        }

        expect(results).toEqual([1]);
    });
});
