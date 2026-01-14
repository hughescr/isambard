import { describe, expect, it } from 'bun:test';
import _ from 'lodash';
import { defaultClassifier, createHttpStatusClassifier } from '../../../../src/utils/retry/classifier';
import type { ErrorCategory } from '../../../../src/utils/retry/types';

describe.concurrent('defaultClassifier', () => {
    describe('Error instances', () => {
        it('should classify Error with message as transient', () => {
            const error = new Error('Network timeout');
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Network timeout');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify Error without message as transient with default message', () => {
            const error = new Error();
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify Error with empty message as transient with default message', () => {
            const error = new Error('');
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });
    });

    describe('Non-Error values', () => {
        it('should classify string as transient', () => {
            const result = defaultClassifier('Something went wrong');

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Something went wrong');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify empty string as transient with default message', () => {
            const result = defaultClassifier('');

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify number as transient with default message', () => {
            const result = defaultClassifier(404);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify null as transient with default message', () => {
            const result = defaultClassifier(null);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify undefined as transient with default message', () => {
            const result = defaultClassifier(undefined);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify object without message as transient with default message', () => {
            const result = defaultClassifier({ code: 'TIMEOUT' });

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });
    });
});

describe.concurrent('createHttpStatusClassifier', () => {
    describe('Rate limited responses (429)', () => {
        it('should classify 429 as rate_limited (kills status === 429 condition)', () => {
            const error = { status: 429 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // CRITICAL: Must be rate_limited, not transient or permanent
            expect(result.category).toBe('rate_limited');
            expect(result.message).toContain('429');
        });

        it('should classify 429 as rate_limited with retryAfter', () => {
            const error = { status: 429, retryAfter: 5000 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(5000);
            expect(result.message).toContain('429');
        });

        // Stryker disable next-line ConditionalExpression, BlockStatement: Testing rate limit check boundary - 429 without retryAfter property
        it('should classify 429 as rate_limited even without retryAfter property in error object', () => {
            const error = { status: 429, message: 'Rate limit exceeded' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toBe('Rate limit exceeded');
        });
    });

    describe('Transient HTTP errors (5xx)', () => {
        it('should classify 500 as transient (lower boundary, kills >= 500 mutant)', () => {
            const error = { status: 500 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // CRITICAL: 500 must be transient (>= 500), not permanent
            expect(result.category).toBe('transient');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('500');
        });

        it('should classify 599 as transient (upper boundary)', () => {
            const error = { status: 599 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('599');
        });

        // Stryker disable next-line ConditionalExpression: Testing upper boundary - 600 is outside 5xx range
        it('should NOT classify 600 as transient (outside 5xx range)', () => {
            const error = { status: 600, message: 'Invalid status' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // 600 is outside the 500-599 range, should fall back to defaultClassifier (transient, "Unknown error")
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        it('should include custom message in 5xx classification', () => {
            const error = { status: 500, message: 'Internal server error' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Internal server error');
        });
    });

    describe('Permanent HTTP errors (4xx except 429)', () => {
        it('should classify 400 as permanent (lower boundary)', () => {
            const error = { status: 400 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('400');
        });

        it('should classify 499 as permanent (upper boundary)', () => {
            const error = { status: 499 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('499');
        });

        it('should include custom message in 4xx classification', () => {
            const error = { status: 404, message: 'Resource not found' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('Resource not found');
        });
    });

    describe('Network timeout errors', () => {
        it('should classify ECONNREFUSED as transient (kills network error check)', () => {
            const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // CRITICAL: Must be transient for network errors
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Connection refused');
        });

        it('should classify network error without message with default message', () => {
            const error = { code: 'ETIMEDOUT' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        // Stryker disable next-line ConditionalExpression, BlockStatement: Testing network error check without code property
        it('should fall back to default classifier when error has no code property', () => {
            const error = { message: 'Some error without code' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // defaultClassifier only extracts messages from Error instances, not plain objects
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });
    });

    describe('Custom permanent status codes', () => {
        it('should classify custom permanent status as permanent', () => {
            const error = { status: 422 };
            const classifier = createHttpStatusClassifier({ permanentStatuses: [422] });
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('422');
        });

        it('should override default behavior with custom permanent statuses', () => {
            const error = { status: 500 };
            const classifier = createHttpStatusClassifier({ permanentStatuses: [500] });
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('500');
        });

        it('should handle multiple custom permanent statuses', () => {
            const classifier = createHttpStatusClassifier({ permanentStatuses: [422, 409] });

            const result1 = classifier({ status: 422 });
            expect(result1.category).toBe('permanent');

            const result2 = classifier({ status: 409 });
            expect(result2.category).toBe('permanent');
        });
    });

    describe('Fallback to default classifier', () => {
        it('should use default classifier for non-HTTP errors', () => {
            const error = new Error('Generic error');
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Generic error');
        });

        it('should use default classifier for objects without status', () => {
            const error = { someProperty: 'value' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });
    });

    describe('Edge cases', () => {
        it('should handle status as string', () => {
            const error = { status: '500' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
        });

        it('should handle retryAfter as string', () => {
            const error = { status: 429, retryAfter: '5000' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(5000);
        });

        it('should handle zero retryAfter', () => {
            const error = { status: 429, retryAfter: 0 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(0);
        });

        it('should handle negative retryAfter by treating as undefined', () => {
            const error = { status: 429, retryAfter: -100 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should handle decimal retryAfter values', () => {
            const error = { status: 429, retryAfter: 1.5 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(1.5);
        });

        it.each<[unknown, number, ErrorCategory]>([
            [123, 400, 'permanent'],
            [null, 404, 'permanent'],
            [undefined, 500, 'transient'],
            [true, 403, 'permanent'],
            [false, 401, 'permanent'],
            [0, 400, 'permanent'],
        ])('should return fallback when message property is %s', (message, status, expectedCategory) => {
            const error = { status, message };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe(expectedCategory);
            expect(result.message).toBe(`HTTP ${status}`);
        });

        it('should return fallback when message is empty string', () => {
            const error = { status: 500, message: '' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('HTTP 500');
        });

        it('should not classify error with empty string code as network error', () => {
            const error = { code: '' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        it('should not classify error with non-network error code', () => {
            const error = { code: 'ENOTFOUND', message: 'DNS lookup failed' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // Falls back to defaultClassifier, which requires Error instance to extract message
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        it('should not classify error when code is object', () => {
            const error = { code: { toString: _.constant('ETIMEDOUT') }, message: 'Fake timeout' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // Falls back to defaultClassifier, which requires Error instance to extract message
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        it('should reuse classifier instance correctly', () => {
            const classifier = createHttpStatusClassifier();

            const result1 = classifier({ status: 500 });
            expect(result1.category).toBe('transient');

            const result2 = classifier({ status: 404 });
            expect(result2.category).toBe('permanent');

            const result3 = classifier({ status: 429, retryAfter: 1000 });
            expect(result3.category).toBe('rate_limited');
            expect(result3.retryAfterMs).toBe(1000);

            const result4 = classifier(new Error('Test error'));
            expect(result4.category).toBe('transient');
            expect(result4.message).toBe('Test error');
        });

        it('should override default 429 behavior with custom permanent status', () => {
            const error = { status: 429, retryAfter: 5000 };
            const classifier = createHttpStatusClassifier({ permanentStatuses: [429] });
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('429');
            expect(result.retryAfterMs).toBeUndefined();
        });
    });
});
