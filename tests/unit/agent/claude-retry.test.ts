/* eslint-disable @typescript-eslint/await-thenable -- testing promise rejection */
/* eslint-disable @typescript-eslint/no-empty-function -- test mocks */
/* eslint-disable lodash/prefer-noop -- test clarity */
/* eslint-disable require-yield -- testing generators that throw before yield */
/* eslint-disable @typescript-eslint/only-throw-error -- testing HTTP error objects */
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { classifyClaudeError, createRetryableQuery } from '../../../src/agent/claude-retry';
import type { RetryDeps, RetryLogger } from '../../../src/utils/retry/types';

describe('classifyClaudeError', () => {
    it('should classify network ECONNRESET as transient', () => {
        const error = { code: 'ECONNRESET', message: 'Connection reset' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Connection reset',
        });
    });

    it('should classify network ETIMEDOUT as transient', () => {
        const error = { code: 'ETIMEDOUT', message: 'Request timeout' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Request timeout',
        });
    });

    it('should classify network ECONNREFUSED as transient', () => {
        const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Connection refused',
        });
    });

    it('should classify HTTP 502 as transient', () => {
        const error = { status: 502, message: 'Bad Gateway' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Bad Gateway',
        });
    });

    it('should classify HTTP 503 as transient', () => {
        const error = { status: 503, message: 'Service Unavailable' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Service Unavailable',
        });
    });

    it('should classify HTTP 504 as transient', () => {
        const error = { status: 504, message: 'Gateway Timeout' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'Gateway Timeout',
        });
    });

    it('should classify HTTP 429 as rate_limited without retryAfter', () => {
        const error = { status: 429, message: 'Too Many Requests' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category:     'rate_limited',
            message:      'Too Many Requests',
            retryAfterMs: undefined,
        });
    });

    it('should classify HTTP 429 as rate_limited with retryAfter from headers', () => {
        const error = {
            status:  429,
            message: 'Too Many Requests',
            headers: { 'retry-after': '5' },
        };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category:     'rate_limited',
            message:      'Too Many Requests',
            retryAfterMs: 5000, // Convert seconds to milliseconds
        });
    });

    it('should classify HTTP 429 as rate_limited with numeric retryAfter in response', () => {
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

    it('should classify HTTP 400 as permanent', () => {
        const error = { status: 400, message: 'Bad Request' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'permanent',
            message:  'Bad Request',
        });
    });

    it('should classify HTTP 401 as permanent', () => {
        const error = { status: 401, message: 'Unauthorized' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'permanent',
            message:  'Unauthorized',
        });
    });

    it('should classify HTTP 404 as permanent', () => {
        const error = { status: 404, message: 'Not Found' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'permanent',
            message:  'Not Found',
        });
    });

    it('should classify unknown errors as permanent', () => {
        const error = { message: 'Unknown error' };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'permanent',
            message:  'Unknown error',
        });
    });

    it('should classify string errors as permanent', () => {
        const error = 'Something went wrong';
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'permanent',
            message:  'Something went wrong',
        });
    });

    it('should handle errors without message property', () => {
        const error = { status: 500 };
        const result = classifyClaudeError(error);

        expect(result).toEqual({
            category: 'transient',
            message:  'HTTP 500',
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
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
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

            // Should get partial message from first attempt, then success from retry
            expect(messages).toHaveLength(2);
            expect(messages[0]).toEqual({ type: 'message', content: 'partial' });
            expect(messages[1]).toEqual({ type: 'message', content: 'success' });
            expect(mockQueryFn).toHaveBeenCalledTimes(2);
            expect(sleepMock).toHaveBeenCalledTimes(1);
        });

        it('should retry on HTTP 502 error', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    throw { status: 502, message: 'Bad Gateway' };
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

        it('should retry on HTTP 503 error', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    throw { status: 503, message: 'Service Unavailable' };
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

        it('should retry on HTTP 504 error', async () => {
            let callCount = 0;

            async function* mockQueryGenerator() {
                callCount++;
                if(callCount === 1) {
                    throw { status: 504, message: 'Gateway Timeout' };
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
        it('should not retry on permanent error', async () => {
            async function* mockQueryGenerator() {
                throw { status: 400, message: 'Bad Request' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        it('should not retry on HTTP 401 error', async () => {
            async function* mockQueryGenerator() {
                throw { status: 401, message: 'Unauthorized' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(1);
            expect(sleepMock).not.toHaveBeenCalled();
        });

        it('should not retry on HTTP 404 error', async () => {
            async function* mockQueryGenerator() {
                throw { status: 404, message: 'Not Found' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(1);
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
            expect(sleepMock).toHaveBeenCalledWith(5000); // 5 seconds in ms
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

            expect(sleepMock).toHaveBeenCalledWith(3000);
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

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(2); // maxAttempts = 2
            expect(sleepMock).toHaveBeenCalledTimes(1); // 1 retry
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
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

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

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

            // Should get all messages from both attempts (stream restarts from beginning)
            expect(messages).toHaveLength(5);
            expect(messages[0]).toEqual({ type: 'message', content: 'attempt1_msg1' });
            expect(messages[1]).toEqual({ type: 'message', content: 'attempt1_msg2' });
            expect(messages[2]).toEqual({ type: 'message', content: 'attempt2_msg1' });
            expect(messages[3]).toEqual({ type: 'message', content: 'attempt2_msg2' });
            expect(messages[4]).toEqual({ type: 'message', content: 'attempt2_msg3' });
        });
    });

    describe('Default options', () => {
        it('should use default maxAttempts of 2 for Claude calls', async () => {
            async function* mockQueryGenerator() {
                throw { status: 502, message: 'Bad Gateway' };
            }

            mockQueryFn.mockImplementation(() => mockQueryGenerator());

            const retryableQuery = createRetryableQuery(mockQueryFn, { deps });
            const result = retryableQuery({ prompt: 'test', options: {} });

            await expect(async () => {
                for await (const _ of result) {
                    // Should not get here
                }
            }).toThrow();

            expect(mockQueryFn).toHaveBeenCalledTimes(2);
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

            // Should be assignable to Query type
            expect(result).toBeDefined();
            expect(typeof result[Symbol.asyncIterator]).toBe('function');
        });
    });
});
