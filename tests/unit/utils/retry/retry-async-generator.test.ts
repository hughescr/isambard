/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test mock values */
/* eslint-disable @typescript-eslint/await-thenable -- testing promise rejection */
/* eslint-disable @typescript-eslint/no-empty-function -- test mocks */
/* eslint-disable lodash/prefer-noop -- test clarity */
/* eslint-disable require-yield -- testing generators that throw before yield */
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
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
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
