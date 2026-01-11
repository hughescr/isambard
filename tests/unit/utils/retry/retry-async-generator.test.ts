/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test mock values */
/* eslint-disable @typescript-eslint/await-thenable -- testing promise rejection */
/* eslint-disable @typescript-eslint/no-empty-function -- test mocks */
/* eslint-disable lodash/prefer-noop -- test clarity */
/* eslint-disable require-yield -- testing generators that throw before yield */
import _ from 'lodash';
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { retryAsyncGenerator } from '../../../../src/utils/retry/retry-async-generator';
import type { ErrorClassification, RetryDeps, RetryLogger, RetryPolicy } from '../../../../src/utils/retry/types';

describe('retryAsyncGenerator', () => {
    let mockLogger: RetryLogger;
    let sleepMock: ReturnType<typeof mock>;
    let nowMock: ReturnType<typeof mock>;
    let deps: RetryDeps;

    const defaultPolicy: RetryPolicy = {
        maxAttempts:       3,
        baseDelayMs:       1000,
        maxDelayMs:        30000,
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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Immediate error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'permanent', message: 'Permanent error' } as ErrorClassification));

            const results: number[] = [];

            await expect(async () => {
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
            const classifier = mock((error: unknown) => {
                if(error === transientError) {
                    return { category: 'transient', message: 'Transient error' } as ErrorClassification;
                }
                return { category: 'permanent', message: 'Permanent error' } as ErrorClassification;
            });

            const results: number[] = [];

            await expect(async () => {
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
        it('should respect retryAfterMs from rate limit response', async () => {
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
            const classifier = mock(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 5000,
            } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1, 2]);
            expect(sleepMock).toHaveBeenCalledWith(5000);
        });
    });

    describe('Max attempts exhausted', () => {
        it('should throw after maxAttempts transient errors', async () => {
            async function* generator() {
                throw new Error('Transient error');
            }

            const generatorFactory = mock(generator);
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await expect(async () => {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await expect(async () => {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Network timeout' } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            await expect(async () => {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: invalidPolicy as Partial<RetryPolicy>, classifier, deps })) {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: partialPolicy as Partial<RetryPolicy>, classifier, deps })) {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

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
            const classifier = mock(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 7500,
            } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            // Should use retryAfterMs (7500) not calculated delay
            expect(sleepMock).toHaveBeenCalledWith(7500);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it('should use zero retryAfterMs when provided', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw new Error('No delay retry');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock(() => ({
                category:     'rate_limited',
                message:      'No delay retry',
                retryAfterMs: 0,
            } as ErrorClassification));

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(sleepMock).toHaveBeenCalledWith(0);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it('should use alternating retryAfterMs values across multiple retries', async () => {
            let callCount = 0;

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error(`Retry ${callCount}`);
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock((error: unknown) => {
                const err = error as Error;
                if(err.message === 'Retry 1') {
                    return {
                        category:     'rate_limited',
                        message:      'Retry 1',
                        retryAfterMs: 1000,
                    } as ErrorClassification;
                }
                return {
                    category:     'rate_limited',
                    message:      'Retry 2',
                    retryAfterMs: 3000,
                } as ErrorClassification;
            });

            const results: number[] = [];
            for await (const value of retryAsyncGenerator(generatorFactory, { policy: defaultPolicy, classifier, deps })) {
                results.push(value);
            }

            expect(results).toEqual([1]);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            expect(sleepMock.mock.calls[0][0]).toBe(1000);
            expect(sleepMock.mock.calls[1][0]).toBe(3000);
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
            const classifier = mock(() => ({
                category:     'transient',
                message:      'Transient error',
                retryAfterMs: undefined, // Explicitly undefined
            } as ErrorClassification));

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

            async function* generator() {
                callCount++;
                if(callCount === 1) {
                    throw transientError;
                }
                yield 1;
                throw permanentError;
            }

            const generatorFactory = mock(generator);
            const classifier = mock((error: unknown) => {
                if(error === transientError) {
                    return { category: 'transient', message: 'Transient error' } as ErrorClassification;
                }
                return { category: 'permanent', message: 'Permanent error' } as ErrorClassification;
            });

            const results: number[] = [];

            await expect(async () => {
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
            const classifier = mock((error: unknown) => {
                if(error === rateLimitError) {
                    return {
                        category:     'rate_limited',
                        message:      'Rate limited',
                        retryAfterMs: 2000,
                    } as ErrorClassification;
                }
                return { category: 'transient', message: 'Transient error' } as ErrorClassification;
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
            const classifier = mock((error: unknown) => {
                const err = error as Error;
                if(_.startsWith(err.message, 'Rate limit')) {
                    return {
                        category:     'rate_limited',
                        message:      err.message,
                        retryAfterMs: 1500,
                    } as ErrorClassification;
                }
                return { category: 'transient', message: err.message } as ErrorClassification;
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

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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

            async function* generator() {
                callCount++;
                if(callCount < 3) {
                    throw new Error('Transient error');
                }
                yield 1;
            }

            const generatorFactory = mock(generator);
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

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
            const classifier = mock(() => ({ category: 'permanent', message: 'Permanent error' } as ErrorClassification));

            const results: number[] = [];

            await expect(async () => {
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
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await expect(async () => {
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
});

// Separate test suite for real timers
describe('retryAsyncGenerator with real timers', () => {
    it('should use default deps when not provided', async () => {
        async function* generator() {
            yield 1;
        }

        const generatorFactory = mock(generator);
        const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

        const results: number[] = [];
        for await (const value of retryAsyncGenerator(generatorFactory, { classifier })) {
            results.push(value);
        }

        expect(results).toEqual([1]);
    });
});
