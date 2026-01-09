import { describe, expect, it } from 'bun:test';
import _ from 'lodash';
import { defaultClassifier, createHttpStatusClassifier } from '../../../../src/utils/retry/classifier';

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
        it('should classify 429 as rate_limited with retryAfter', () => {
            const error = { status: 429, retryAfter: 5000 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(5000);
            expect(result.message).toContain('429');
        });

        it('should classify 429 without retryAfter as rate_limited without retryAfterMs', () => {
            const error = { status: 429 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('429');
        });

        it('should include custom message in 429 classification', () => {
            const error = { status: 429, message: 'Too many requests', retryAfter: 1000 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(1000);
            expect(result.message).toBe('Too many requests');
        });
    });

    describe('Transient HTTP errors (5xx)', () => {
        it('should classify 500 as transient', () => {
            const error = { status: 500 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('500');
        });

        it('should classify 502 as transient', () => {
            const error = { status: 502 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toContain('502');
        });

        it('should classify 503 as transient', () => {
            const error = { status: 503 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toContain('503');
        });

        it('should classify 504 as transient', () => {
            const error = { status: 504 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toContain('504');
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
        it('should classify 400 as permanent', () => {
            const error = { status: 400 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.retryAfterMs).toBeUndefined();
            expect(result.message).toContain('400');
        });

        it('should classify 401 as permanent', () => {
            const error = { status: 401 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('401');
        });

        it('should classify 403 as permanent', () => {
            const error = { status: 403 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('403');
        });

        it('should classify 404 as permanent', () => {
            const error = { status: 404 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toContain('404');
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
        it('should classify ETIMEDOUT as transient', () => {
            const error = { code: 'ETIMEDOUT', message: 'Connection timeout' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Connection timeout');
        });

        it('should classify ECONNRESET as transient', () => {
            const error = { code: 'ECONNRESET', message: 'Connection reset' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Connection reset');
        });

        it('should classify ECONNREFUSED as transient', () => {
            const error = { code: 'ECONNREFUSED', message: 'Connection refused' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

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

        it('should handle very small decimal retryAfter values', () => {
            const error = { status: 429, retryAfter: 0.001 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(0.001);
        });

        it('should handle small retryAfter values', () => {
            const error = { status: 429, retryAfter: 0.1 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('rate_limited');
            expect(result.retryAfterMs).toBe(0.1);
        });

        it('should return fallback when message property is non-string truthy value', () => {
            const error = { status: 400, message: 123 };  // message is number
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('HTTP 400');  // Uses fallback, not the number
        });

        it('should return fallback when message property is null', () => {
            const error = { status: 404, message: null };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('HTTP 404');
        });

        it('should return fallback when message property is undefined', () => {
            const error = { status: 500, message: undefined };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('HTTP 500');
        });

        it('should return fallback when message property is boolean true', () => {
            const error = { status: 403, message: true };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('HTTP 403');
        });

        it('should return fallback when message property is boolean false', () => {
            const error = { status: 401, message: false };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('HTTP 401');
        });

        it('should return fallback when message property is zero', () => {
            const error = { status: 400, message: 0 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('permanent');
            expect(result.message).toBe('HTTP 400');
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
