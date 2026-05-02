import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { classifyClaudeError, createRetryableQuery } from '../../../src/agent/claude-retry';
import type { RetryDeps, RetryLogger } from '../../../src/utils/retry/types';

describe('classifyClaudeError', () => {
    describe('Network errors', () => {
        it.each([
            { error: { code: 'ECONNRESET', message: 'Connection reset' }, desc: 'ECONNRESET by code' },
            { error: { code: 'ETIMEDOUT', message: 'Request timeout' }, desc: 'ETIMEDOUT by code' },
            { error: { code: 'ECONNREFUSED', message: 'Connection refused' }, desc: 'ECONNREFUSED by code' },
            { error: new Error('Connection failed: ECONNRESET'), desc: 'ECONNRESET in message' },
            { error: new Error('Request timeout: ETIMEDOUT'), desc: 'ETIMEDOUT in message' },
            { error: new Error('Connection refused: ECONNREFUSED'), desc: 'ECONNREFUSED in message' },
        ])('should classify $desc as transient', ({ error }) => {
            const result = classifyClaudeError(error);
            expect(result.category).toBe('transient');
        });

        it('should use "Network error" fallback message when message is empty', () => {
            const error = { code: 'ECONNRESET' };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category: 'transient',
                message:  'Network error',
            });
        });
    });

    describe('HTTP status codes', () => {
        it.each([
            { status: 502, desc: 'Bad Gateway' },
            { status: 503, desc: 'Service Unavailable' },
            { status: 504, desc: 'Gateway Timeout' },
            { status: 500, desc: 'Internal Server Error' },
            { status: 599, desc: 'upper 5xx boundary' },
        ])('should classify HTTP $status as transient', ({ status, desc }) => {
            const error = { status, message: desc };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category: 'transient',
                message:  desc,
            });
        });

        it.each([
            { status: 400, desc: 'Bad Request' },
            { status: 401, desc: 'Unauthorized' },
            { status: 404, desc: 'Not Found' },
            { status: 499, desc: 'upper 4xx boundary' },
        ])('should classify HTTP $status as permanent', ({ status, desc }) => {
            const error = { status, message: desc };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category: 'permanent',
                message:  desc,
            });
        });

        it('should handle string status codes', () => {
            const error = { status: '502', message: 'Bad Gateway' };
            const result = classifyClaudeError(error);
            expect(result.category).toBe('transient');
        });

        it('should use fallback message when message is missing', () => {
            const error = { status: 500 };
            const result = classifyClaudeError(error);
            expect(result.message).toBe('HTTP 500');
        });
    });

    describe('Rate limiting (HTTP 429)', () => {
        it('should classify HTTP 429 as rate_limited without retryAfter', () => {
            const error = { status: 429, message: 'Too Many Requests' };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category:     'rate_limited',
                message:      'Too Many Requests',
                retryAfterMs: undefined,
            });
        });

        it('should extract retryAfter from headers (seconds to milliseconds)', () => {
            const error = {
                status:  429,
                message: 'Too Many Requests',
                headers: { 'retry-after': '5' },
            };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category:     'rate_limited',
                message:      'Too Many Requests',
                retryAfterMs: 5000,
            });
        });

        it('should extract retryAfter from response body (milliseconds)', () => {
            const error = {
                status:     429,
                message:    'Too Many Requests',
                retryAfter: 3000,
            };
            const result = classifyClaudeError(error);
            expect(result).toEqual({
                category:     'rate_limited',
                message:      'Too Many Requests',
                retryAfterMs: 3000,
            });
        });

        it.each([
            { retryAfter: 0, expected: 0, desc: 'zero retryAfter' },
            { retryAfter: -5, expected: undefined, desc: 'negative retryAfter' },
            { retryAfter: 'invalid', expected: undefined, desc: 'non-numeric retryAfter' },
        ])('should handle $desc', ({ retryAfter, expected }) => {
            const error = { status: 429, retryAfter };
            const result = classifyClaudeError(error);
            expect(result.retryAfterMs).toBe(expected);
        });

        it('should return 0 when retry-after header is "0"', () => {
            const error = { status: 429, headers: { 'retry-after': '0' } };
            const result = classifyClaudeError(error);

            expect(result).toEqual({
                category:     'rate_limited',
                message:      'HTTP 429',
                retryAfterMs: 0,
            });
        });

        it('should return undefined for negative retry-after header', () => {
            const error = { status: 429, headers: { 'retry-after': '-5' } };
            const result = classifyClaudeError(error);

            expect(result).toEqual({
                category:     'rate_limited',
                message:      'HTTP 429',
                retryAfterMs: undefined,
            });
        });
    });

    describe('Unknown errors', () => {
        it.each([
            { error: { message: 'Unknown error' }, desc: 'object with message' },
            { error: 'Something went wrong', desc: 'string error' },
            { error: { status: 600, message: 'Unknown status' }, desc: 'status outside valid range' },
        ])('should classify $desc as permanent', ({ error }) => {
            const result = classifyClaudeError(error);
            expect(result.category).toBe('permanent');
        });

        it.each([
            { error: { message: '' }, desc: 'empty string message' },
            { error: { message: null }, desc: 'null message' },
            { error: '', desc: 'empty string error' },
            { error: null, desc: 'null error' },
            { error: undefined, desc: 'undefined error' },
        ])('should use "Unknown error" fallback for $desc', ({ error }) => {
            const result = classifyClaudeError(error);
            expect(result.message).toBe('Unknown error');
        });

        it('should extract message from string error', () => {
            const error = 'Something went wrong';
            const result = classifyClaudeError(error);
            expect(result.message).toBe('Something went wrong');
        });

        it('should extract message from object error', () => {
            const error = { message: 'Custom error message' };
            const result = classifyClaudeError(error);
            expect(result.message).toBe('Custom error message');
        });
    });

    describe('Network error code edge cases', () => {
        it('should not classify error with non-network code', () => {
            const error = { code: 'ENOTFOUND', message: 'Not a network retry code' };
            const result = classifyClaudeError(error);
            expect(result.category).toBe('permanent');
        });

        it('should not classify error with numeric code', () => {
            const error = { code: 123, message: 'Numeric code' };
            const result = classifyClaudeError(error);
            expect(result.category).toBe('permanent');
        });
    });
});

describe('createRetryableQuery', () => {
    let mockLogger: RetryLogger;
    let sleepMock: ReturnType<typeof mock>;
    let nowMock: ReturnType<typeof mock>;
    let deps: RetryDeps;
    let mockQueryFn: ReturnType<typeof mock>;

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

        mockQueryFn = mock();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Success cases', () => {
        it('should return values from query on first successful attempt', async () => {
            async function* mockQuery() {
                yield { type: 'message', content: 'Hello' };
                yield { type: 'message', content: 'World' };
            }

            mockQueryFn.mockReturnValue(mockQuery());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(2);
            expect(mockQueryFn).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
        });

        it('should pass through query parameters correctly', async () => {
            async function* mockQuery() {
                yield { type: 'message', content: 'test' };
            }

            mockQueryFn.mockReturnValue(mockQuery());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const params = {
                prompt:  'Test prompt',
                options: { model: 'claude-3-5-sonnet-20241022' },
            };

            await retryableQuery(params).next();

            expect(mockQueryFn).toHaveBeenCalledWith(params);
        });
    });

    describe('Transient error retry', () => {
        it('should retry on transient error and succeed on second attempt', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    yield { type: 'message', content: 'partial' };
                    throw new Error('ECONNRESET');
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(2);
            expect(messages[0]).toEqual({ type: 'message', content: 'partial' });
            expect(messages[1]).toEqual({ type: 'message', content: 'success' });
            expect(mockQueryFn).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it.each([
            { status: 502, desc: 'HTTP 502' },
            { status: 503, desc: 'HTTP 503' },
            { status: 504, desc: 'HTTP 504' },
        ])('should retry on $desc error', async ({ status }) => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    throw { status, message: 'Server error' };
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(1);
            expect(mockQueryFn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Permanent error handling', () => {
        it.each([
            { status: 400, desc: 'HTTP 400' },
            { status: 401, desc: 'HTTP 401' },
            { status: 404, desc: 'HTTP 404' },
        ])('should not retry on $desc error', async ({ status }) => {
            async function* mockQueryGenerator() {
                throw { status, message: 'Client error' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const consumeGenerator = async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            };

            expect(consumeGenerator()).rejects.toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
        });
    });

    describe('Rate limiting', () => {
        it('should retry on HTTP 429 and extract retryAfter from headers', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    const error: { status: number, message: string, headers?: Record<string, string> } = {
                        status:  429,
                        message: 'Too Many Requests',
                        headers: { 'retry-after': '5' },
                    };
                    throw error;
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(1);
            expect(mockQueryFn).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledWith(5000);
        });

        it('should retry on HTTP 429 with retryAfter in response body', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    const error: { status: number, message: string, retryAfter?: number } = {
                        status:     429,
                        message:    'Too Many Requests',
                        retryAfter: 3000,
                    };
                    throw error;
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            // Verify retry happened (sleep was called with retryAfter) and stream completed
            expect(sleepMock).toHaveBeenCalledWith(3000);
            expect(messages.length).toBeGreaterThan(0);
        });

        it('should use exponential backoff when retryAfterMs is less than computed backoff', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    // retryAfter=10ms < backoff for attempt 1 (base 1000ms), so backoff wins
                    const error: { status: number, message: string, retryAfter?: number } = {
                        status:     429,
                        message:    'Too Many Requests',
                        retryAfter: 10,
                    };
                    throw error;
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, {
                policy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0.1 },
                deps,
            });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(1);
            // Must use the exponential backoff (~1000ms), not the server hint (10ms)
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900);
            expect(sleepDuration).toBeLessThanOrEqual(1100);
        });

        it('should use exponential backoff when retryAfterMs is zero', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    // retryAfter=0 — clock-skew / rolled-over window; backoff must take over
                    const error: { status: number, message: string, retryAfter?: number } = {
                        status:     429,
                        message:    'Too Many Requests',
                        retryAfter: 0,
                    };
                    throw error;
                }
                yield { type: 'message', content: 'success' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, {
                policy: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 30_000, backoffMultiplier: 2, jitterFraction: 0.1 },
                deps,
            });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(1);
            // With max(0, backoff), the sleep must be the exponential value, not 0
            const sleepDuration = sleepMock.mock.calls[0][0];
            expect(sleepDuration).toBeGreaterThanOrEqual(900);
            expect(sleepDuration).toBeLessThanOrEqual(1100);
        });
    });

    describe('Max attempts exhausted', () => {
        it('should throw after maxAttempts (default 2)', async () => {
            async function* mockQueryGenerator() {
                throw { status: 502, message: 'Bad Gateway' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            // eslint-disable-next-line sonarjs/no-identical-functions -- same consume pattern as other max-attempts tests; different assertion context (default maxAttempts)
            const consumeGenerator = async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            };

            expect(consumeGenerator()).rejects.toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it('should respect custom maxAttempts', async () => {
            async function* mockQueryGenerator() {
                throw { status: 503, message: 'Service Unavailable' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, {
                policy: { maxAttempts: 4 },
                deps,
            });
            const result = retryableQuery({ prompt: 'test', options: {} });

            // eslint-disable-next-line sonarjs/no-identical-functions -- same consume pattern as other max-attempts tests; different assertion context (custom maxAttempts=4)
            const consumeGenerator = async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            };

            expect(consumeGenerator()).rejects.toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(4);
            expect(sleepMock).toHaveBeenCalledTimes(3);
        });
    });

    describe('Stream restart semantics', () => {
        it('should provide fresh stream after error', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    yield { type: 'message', content: 'attempt1_msg1' };
                    yield { type: 'message', content: 'attempt1_msg2' };
                    throw new Error('ECONNRESET');
                }
                // Fresh stream on retry
                yield { type: 'message', content: 'attempt2_msg1' };
                yield { type: 'message', content: 'attempt2_msg2' };
                yield { type: 'message', content: 'attempt2_msg3' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            const messages: unknown[] = [];
            for await (const msg of result) {
                messages.push(msg);
            }

            expect(messages).toHaveLength(5);
            expect(messages[0]).toEqual({ type: 'message', content: 'attempt1_msg1' });
            expect(messages[1]).toEqual({ type: 'message', content: 'attempt1_msg2' });
            expect(messages[2]).toEqual({ type: 'message', content: 'attempt2_msg1' });
            expect(messages[3]).toEqual({ type: 'message', content: 'attempt2_msg2' });
            expect(messages[4]).toEqual({ type: 'message', content: 'attempt2_msg3' });
        });
    });

    describe('Type compatibility', () => {
        it('should return Query type compatible with SDK', async () => {
            async function* mockQueryGenerator() {
                yield { type: 'message', content: 'test' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result: Query = retryableQuery({ prompt: 'test', options: {} });

            expect(result).toBeDefined();
            expect(typeof result[Symbol.asyncIterator]).toBe('function');
        });
    });
});
