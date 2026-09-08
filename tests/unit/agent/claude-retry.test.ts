import { describe, expect, it } from 'bun:test';
import { classifyClaudeError } from '../../../src/agent/claude-retry';

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
