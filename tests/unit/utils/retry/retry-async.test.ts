import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { retryAsync } from '../../../../src/utils/retry/retry-async';
import type { ErrorClassification, RetryDeps, RetryLogger, RetryPolicy } from '../../../../src/utils/retry/types';

describe('retryAsync', () => {
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

    describe('Successful operations', () => {
        it('should return result immediately on first successful attempt', async () => {
            const operation = mock(() => Promise.resolve('success'));
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(1);
            expect(classifier).not.toHaveBeenCalled();
            expect(sleepMock).not.toHaveBeenCalled();
        });

        it('should return result on second attempt after transient error', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Transient error'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(2);
            expect(classifier).toHaveBeenCalledTimes(1);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it('should return result on third attempt after multiple transient errors', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount < 3) {
                    return Promise.reject(new Error('Transient error'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            expect(operation).toHaveBeenCalledTimes(3);
            expect(classifier).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(2);
            expect(mockLogger.warn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Permanent errors', () => {
        it('should throw immediately on permanent error without retrying', async () => {
            const error = new Error('Permanent error');
            const operation = mock(() => Promise.reject(error));
            const classifier = mock(() => ({ category: 'permanent', message: 'Permanent error' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow('Permanent error');

            expect(operation).toHaveBeenCalledTimes(1);
            expect(classifier).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        it('should throw permanent error after initial transient errors', async () => {
            let callCount = 0;
            const transientError = new Error('Transient error');
            const permanentError = new Error('Permanent error');

            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(transientError);
                }
                return Promise.reject(permanentError);
            });

            const classifier = mock((error: unknown) => {
                if(error === transientError) {
                    return { category: 'transient', message: 'Transient error' } as ErrorClassification;
                }
                return { category: 'permanent', message: 'Permanent error' } as ErrorClassification;
            });

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow('Permanent error');

            expect(operation).toHaveBeenCalledTimes(2);
            expect(classifier).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });
    });

    describe('Rate limiting', () => {
        it('should respect retryAfterMs from rate limit response', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Rate limited'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 5000,
            } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            expect(sleepMock).toHaveBeenCalledWith(5000); // Should use retryAfterMs
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        it('should use exponential backoff when rate limit has no retryAfterMs', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Rate limited'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({
                category: 'rate_limited',
                message:  'Rate limited',
            } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            // Should use exponential backoff (1000ms base, attempt 1)
            expect(sleepMock).toHaveBeenCalled();
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900); // Min with jitter
            expect(sleepDuration).toBeLessThanOrEqual(1100); // Max with jitter
        });
    });

    describe('Max attempts exhausted', () => {
        it('should throw after maxAttempts transient errors', async () => {
            const error = new Error('Transient error');
            const operation = mock(() => Promise.reject(error));
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow('Transient error');

            expect(operation).toHaveBeenCalledTimes(3); // maxAttempts
            expect(classifier).toHaveBeenCalledTimes(3);
            expect(sleepMock).toHaveBeenCalledTimes(2); // Between attempts
            expect(mockLogger.warn).toHaveBeenCalledTimes(2); // Attempts 1 and 2
            expect(mockLogger.error).toHaveBeenCalledTimes(1); // Final failure
        });

        it('should throw original error on final attempt', async () => {
            const originalError = new Error('Original error message');
            const operation = mock(() => Promise.reject(originalError));
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow('Original error message');
        });
    });

    describe('Delay calculation', () => {
        it('should apply exponential backoff between retries', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount < 3) {
                    return Promise.reject(new Error('Transient error'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(sleepMock).toHaveBeenCalledTimes(2);

            // First retry delay (attempt 1): base 1000ms with jitter
            const firstDelay = sleepMock.mock.calls[0][0];
            expect(firstDelay).toBeGreaterThanOrEqual(900);
            expect(firstDelay).toBeLessThanOrEqual(1100);

            // Second retry delay (attempt 2): base 2000ms with jitter
            const secondDelay = sleepMock.mock.calls[1][0];
            expect(secondDelay).toBeGreaterThanOrEqual(1800);
            expect(secondDelay).toBeLessThanOrEqual(2200);
        });

        it('should cap delay at maxDelayMs', async () => {
            const policy: RetryPolicy = {
                ...defaultPolicy,
                maxAttempts: 10,
                maxDelayMs:  5000,
            };

            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount < 5) {
                    return Promise.reject(new Error('Transient error'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await retryAsync(operation, { policy, classifier, deps });

            // Check that all delays are capped
            for(const call of sleepMock.mock.calls) {
                const delay = call[0];
                expect(delay).toBeLessThanOrEqual(5000);
            }
        });
    });

    describe('Logging', () => {
        it('should log warning on transient error with retry details', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Network timeout'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Network timeout' } as ErrorClassification));

            await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            const logCall = (mockLogger.warn as ReturnType<typeof mock>).mock.calls[0][0];

            expect(logCall).toHaveProperty('msg');
            expect(logCall).toHaveProperty('attempt', 1);
            expect(logCall).toHaveProperty('maxAttempts', 3);
            expect(logCall).toHaveProperty('category', 'transient');
            expect(logCall).toHaveProperty('errorMessage', 'Network timeout');
            expect(logCall).toHaveProperty('delayMs');
        });

        it('should log error on permanent failure', async () => {
            const operation = mock(() => Promise.reject(new Error('Permanent error')));
            const classifier = mock(() => ({ category: 'permanent', message: 'Permanent error' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow();

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const logCall = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];

            expect(logCall).toHaveProperty('msg');
            expect(logCall).toHaveProperty('category', 'permanent');
            expect(logCall).toHaveProperty('errorMessage', 'Permanent error');
        });

        it('should log error on max attempts exhausted', async () => {
            const operation = mock(() => Promise.reject(new Error('Transient error')));
            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow();

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
            const logCall = (mockLogger.error as ReturnType<typeof mock>).mock.calls[0][0];

            expect(logCall).toHaveProperty('msg');
            expect(logCall).toHaveProperty('attempts', 3);
            expect(logCall).toHaveProperty('errorMessage', 'Transient error');
        });
    });

    describe('Edge cases', () => {
        it('should handle operation returning undefined', async () => {
            const operation = mock(() => Promise.resolve(undefined));
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBeUndefined();
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should handle operation returning null', async () => {
            const operation = mock(() => Promise.resolve(null));
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBeNull();
            expect(operation).toHaveBeenCalledTimes(1);
        });

        it('should handle maxAttempts of 1', async () => {
            const policy: RetryPolicy = { ...defaultPolicy, maxAttempts: 1 };
            const operation = mock(() => Promise.reject(new Error('Error')));
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            expect(retryAsync(operation, { policy, classifier, deps })).rejects.toThrow();

            expect(operation).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled(); // No retries
        });

        it('should handle zero retryAfterMs', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Rate limited'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({
                category:     'rate_limited',
                message:      'Rate limited',
                retryAfterMs: 0,
            } as ErrorClassification));

            const result = await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(result).toBe('success');
            expect(sleepMock).toHaveBeenCalledWith(0);
        });

        it('should call now() to track elapsed time', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount === 1) {
                    return Promise.reject(new Error('Transient error'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'Transient error' } as ErrorClassification));

            await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

            expect(nowMock).toHaveBeenCalled();
        });
    });

    describe('Mutation testing: elapsed time tracking', () => {
        it('should track increasing elapsed time across retries (kills now() + startTime)', async () => {
            const operation = mock(() => Promise.reject(new Error('transient')));
            const classifier = mock(() => ({ category: 'transient', message: 'transient' } as ErrorClassification));

            expect(retryAsync(operation, { policy: defaultPolicy, classifier, deps })).rejects.toThrow();

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
            const operation = mock(() => Promise.reject(new Error('always fails')));
            const classifier = mock(() => ({ category: 'transient', message: 'always fails' } as ErrorClassification));

            expect(retryAsync(operation, {
                policy: { ...defaultPolicy, maxAttempts: 3 },
                classifier,
                deps,
            })).rejects.toThrow();

            // Exactly 3 attempts, not 2 or 4 (kills attempt++ vs attempt-- mutations)
            expect(operation).toHaveBeenCalledTimes(3);
        });

        it('should make exactly maxAttempts attempts with different maxAttempts value', async () => {
            const operation = mock(() => Promise.reject(new Error('always fails')));
            const classifier = mock(() => ({ category: 'transient', message: 'always fails' } as ErrorClassification));

            expect(retryAsync(operation, {
                policy: { ...defaultPolicy, maxAttempts: 5 },
                classifier,
                deps,
            })).rejects.toThrow();

            // Exactly 5 attempts (verifies loop boundary)
            expect(operation).toHaveBeenCalledTimes(5);
        });

        it('should log correct attempt numbers in sequence', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                if(callCount < 3) {
                    return Promise.reject(new Error('transient'));
                }
                return Promise.resolve('success');
            });

            const classifier = mock(() => ({ category: 'transient', message: 'transient' } as ErrorClassification));

            await retryAsync(operation, { policy: defaultPolicy, classifier, deps });

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
            const operation = mock(() => Promise.reject(new Error('always fails')));
            const classifier = mock(() => ({ category: 'transient', message: 'always fails' } as ErrorClassification));

            // Test with maxAttempts = 1 (boundary case)
            expect(retryAsync(operation, {
                policy: { ...defaultPolicy, maxAttempts: 1 },
                classifier,
                deps,
            })).rejects.toThrow();

            expect(operation).toHaveBeenCalledTimes(1);

            // Reset for next test
            operation.mockClear();

            // Test with maxAttempts = 2 (verifies <= vs < boundary)
            expect(retryAsync(operation, {
                policy: { ...defaultPolicy, maxAttempts: 2 },
                classifier,
                deps,
            })).rejects.toThrow();

            expect(operation).toHaveBeenCalledTimes(2);
        });

        it('should stop exactly at maxAttempts and not continue', async () => {
            let callCount = 0;
            const operation = mock(() => {
                callCount++;
                return Promise.reject(new Error('always fails'));
            });

            const classifier = mock(() => ({ category: 'transient', message: 'always fails' } as ErrorClassification));

            expect(retryAsync(operation, {
                policy: { ...defaultPolicy, maxAttempts: 4 },
                classifier,
                deps,
            })).rejects.toThrow();

            // Exactly 4, not 3 or 5 (kills <= vs < mutations)
            expect(operation).toHaveBeenCalledTimes(4);
            expect(callCount).toBe(4);
        });
    });

    describe('Default behavior', () => {
        it('should use default policy when not provided', async () => {
            const operation = mock(() => Promise.resolve('success'));
            const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

            const result = await retryAsync(operation, { classifier, deps });

            expect(result).toBe('success');
        });

        it('should use default classifier when not provided', async () => {
            const operation = mock(() => Promise.resolve('success'));

            const result = await retryAsync(operation, { deps });

            expect(result).toBe('success');
        });
    });
});

// Separate test suite for real timers (no beforeEach/afterEach conflicts)
describe('retryAsync with real timers', () => {
    it('should use default deps when not provided', async () => {
        const operation = mock(() => Promise.resolve('success'));
        const classifier = mock(() => ({ category: 'transient', message: 'Error' } as ErrorClassification));

        const result = await retryAsync(operation, { classifier });

        expect(result).toBe('success');
    });
});
