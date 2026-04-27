import { describe, expect, it } from 'bun:test';
import { defaultClassifier, createHttpStatusClassifier, classifyNetworkError } from '../../../../src/utils/retry/classifier';
import type { ErrorCategory } from '../../../../src/utils/retry/types';

describe.concurrent('defaultClassifier', () => {
    describe.concurrent('Error instances', () => {
        it('should classify Error with message as transient', () => {
            const error = new Error('Network timeout');
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Network timeout');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify Error without message as transient with default message', () => {
            // eslint-disable-next-line unicorn/error-message -- intentionally testing no-message Error behavior
            const error = new Error();
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });

        it('should classify Error with empty message as transient with default message', () => {
            // eslint-disable-next-line unicorn/error-message -- intentionally testing empty-message Error behavior
            const error = new Error('');
            const result = defaultClassifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
            expect(result.retryAfterMs).toBeUndefined();
        });
    });

    describe.concurrent('Non-Error values', () => {
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

describe.concurrent('classifyNetworkError', () => {
    describe.concurrent('POSIX network error codes', () => {
        it('should classify ETIMEDOUT as transient', () => {
            const result = classifyNetworkError({ code: 'ETIMEDOUT', message: 'Connection timed out' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Connection timed out');
        });

        it('should classify ECONNRESET as transient', () => {
            const result = classifyNetworkError({ code: 'ECONNRESET', message: 'Connection reset' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Connection reset');
        });

        it('should classify ECONNREFUSED as transient', () => {
            const result = classifyNetworkError({ code: 'ECONNREFUSED', message: 'Connection refused' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Connection refused');
        });
    });

    describe.concurrent('Smithy/AWS-SDK error codes', () => {
        it('should classify FailedToOpenSocket as transient (Smithy transient socket error from production incident)', () => {
            const result = classifyNetworkError({ code: 'FailedToOpenSocket', message: 'Failed to open socket' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Failed to open socket');
        });

        it('should classify FailedToOpenSocket without message using fallback', () => {
            const result = classifyNetworkError({ code: 'FailedToOpenSocket' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Unknown error');
        });

        it('should classify TimeoutError as transient (Smithy emits when throwOnRequestTimeout is true)', () => {
            const result = classifyNetworkError({ code: 'TimeoutError', message: 'Request timed out' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Request timed out');
        });

        it('should classify NetworkingError as transient (general Smithy networking failure)', () => {
            const result = classifyNetworkError({ code: 'NetworkingError', message: 'Networking error' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Networking error');
        });

        it('should classify NetworkingError with custom fallback message when no message property', () => {
            const result = classifyNetworkError({ code: 'NetworkingError' }, 'custom fallback');

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('custom fallback');
        });
    });

    describe.concurrent('Real Smithy error instances (Object.assign shapes from @smithy/node-http-handler)', () => {
        // These use the actual construction pattern from @smithy/node-http-handler source:
        //   Object.assign(new Error(msg), { name: 'TimeoutError' })
        // This is the "real" shape that future Smithy upgrades may alter — if they change
        // the shape, these tests will break loudly rather than silently passing with plain objects.
        it('should classify real TimeoutError (setConnectionTimeout shape) as transient', () => {
            // Real shape from set-connection-timeout.js:
            //   Object.assign(new Error('did not establish a connection...'), { name: 'TimeoutError' })
            const err = Object.assign(
                new Error('@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 3000 ms.'),
                { name: 'TimeoutError' }
            );
            const result = classifyNetworkError(err);
            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toContain('did not establish a connection');
        });

        it('should classify real TimeoutError (setSocketTimeout shape) as transient', () => {
            // Real shape from set-socket-timeout.js:
            //   Object.assign(new Error('...timed out after N ms...'), { name: 'TimeoutError' })
            const err = Object.assign(
                new Error('@smithy/node-http-handler - the request socket timed out after 5000 ms of inactivity (configured by client requestHandler).'),
                { name: 'TimeoutError' }
            );
            const result = classifyNetworkError(err);
            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toContain('timed out after 5000 ms');
        });

        it('should classify real TimeoutError (setRequestTimeout + throwOnRequestTimeout shape) as transient', () => {
            // Real shape from set-request-timeout.js when throwOnRequestTimeout=true:
            //   Object.assign(new Error(msg), { name: 'TimeoutError', code: 'ETIMEDOUT' })
            const err = Object.assign(
                new Error('@smithy/node-http-handler - [ERROR] a request has exceeded the configured 10000 ms requestTimeout.'),
                { name: 'TimeoutError', code: 'ETIMEDOUT' }
            );
            const result = classifyNetworkError(err);
            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toContain('exceeded the configured 10000 ms requestTimeout');
        });

        it('should classify real node-http-handler socket timeout (name via Object.assign) as transient', () => {
            // Real shape from node-http-handler.js error timeout branch:
            //   reject(Object.assign(err, { name: 'TimeoutError' })) where err is a Node.js socket error
            const socketErr = new Error('socket hang up');
            Object.assign(socketErr, { name: 'TimeoutError', code: 'ECONNRESET' });
            const result = classifyNetworkError(socketErr);
            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('socket hang up');
        });

        // Synthetic safety net — keep at least one plain-object test so if a future code change
        // removes the plain-object code path, this test catches the regression.
        it('synthetic safety net: plain-object { name: TimeoutError } still classified as transient', () => {
            const result = classifyNetworkError({ name: 'TimeoutError', message: 'Timed out' });
            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
        });
    });

    describe.concurrent('Name-only Smithy errors (no code property)', () => {
        it('should classify TimeoutError by name when no code property', () => {
            // @smithy/fetch-http-handler sets only name="TimeoutError", no code
            const error = new Error('Request did not complete within 15000 ms');
            (error as Error & { name: string }).name = 'TimeoutError';
            const result = classifyNetworkError(error);

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Request did not complete within 15000 ms');
        });

        it('should classify TimeoutError by name from plain object (no code)', () => {
            const result = classifyNetworkError({ name: 'TimeoutError', message: 'Timed out' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Timed out');
        });

        it('should classify NetworkingError by name when no code property', () => {
            const result = classifyNetworkError({ name: 'NetworkingError', message: 'Network error' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Network error');
        });

        it('should classify FailedToOpenSocket by name when no code property', () => {
            const result = classifyNetworkError({ name: 'FailedToOpenSocket', message: 'Failed to open socket' });

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('Failed to open socket');
        });

        it('should use fallback message when name-only error has no message', () => {
            const result = classifyNetworkError({ name: 'TimeoutError' }, 'custom fallback');

            expect(result).toBeDefined();
            expect(result?.category).toBe('transient');
            expect(result?.message).toBe('custom fallback');
        });
    });

    describe.concurrent('Non-network error codes', () => {
        it('should return undefined for unknown code', () => {
            const result = classifyNetworkError({ code: 'ENOTFOUND' });

            expect(result).toBeUndefined();
        });

        it('should return undefined when no code or name matches', () => {
            const result = classifyNetworkError({ message: 'Some error' });

            expect(result).toBeUndefined();
        });

        it('should return undefined for non-object error', () => {
            const result = classifyNetworkError('string error');

            expect(result).toBeUndefined();
        });

        it('should return undefined when name is non-network string', () => {
            const result = classifyNetworkError({ name: 'SomeOtherError', message: 'Some error' });

            expect(result).toBeUndefined();
        });
    });
});

describe.concurrent('createHttpStatusClassifier', () => {
    describe.concurrent('Rate limited responses (429)', () => {
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

    describe.concurrent('Transient HTTP errors (5xx)', () => {
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

    describe.concurrent('Permanent HTTP errors (4xx except 429)', () => {
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

    describe.concurrent('Network timeout errors', () => {
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

        it('should classify Smithy FailedToOpenSocket as transient (incident: DynamoDB transient socket failure)', () => {
            const error = { code: 'FailedToOpenSocket', message: 'Failed to open socket' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Failed to open socket');
        });

        it('should classify Smithy TimeoutError as transient (emitted when throwOnRequestTimeout is true)', () => {
            const error = { code: 'TimeoutError', message: 'Request timed out' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Request timed out');
        });

        it('should classify Smithy NetworkingError as transient (general Smithy networking failure)', () => {
            const error = { code: 'NetworkingError', message: 'Networking error occurred' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            expect(result.category).toBe('transient');
            expect(result.message).toBe('Networking error occurred');
        });

        // Stryker disable next-line ConditionalExpression, BlockStatement: Testing network error check without matching code or name
        it('should fall back to default classifier when error has no matching code or name', () => {
            const error = { message: 'Some error without code' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // defaultClassifier only extracts messages from Error instances, not plain objects
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });
    });

    describe.concurrent('Custom permanent status codes', () => {
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

    describe.concurrent('Fallback to default classifier', () => {
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

        it('should fall through to default classifier for 2xx status codes (kills ConditionalExpression→true on 4xx check)', () => {
            // Status 200 is not 429, not 5xx, and not 4xx — so classifyHttpStatus returns undefined
            // and we fall back to defaultClassifier which returns transient/"Unknown error" for plain objects
            const error = { status: 200, message: 'OK' };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // If the 4xx check were mutated to `true`, 200 would be permanent — killing the mutant
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });

        it('should fall through to default classifier for 3xx status codes (kills ConditionalExpression→true on 4xx check)', () => {
            // Status 301 is not 429, not 5xx, and not 4xx — so classifyHttpStatus returns undefined
            const error = { status: 301 };
            const classifier = createHttpStatusClassifier();
            const result = classifier(error);

            // If the 4xx check were mutated to `true`, 301 would be permanent — killing the mutant
            expect(result.category).toBe('transient');
            expect(result.message).toBe('Unknown error');
        });
    });

    describe.concurrent('Edge cases', () => {
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
            const error = { code: { toString: () => 'ETIMEDOUT' }, message: 'Fake timeout' };
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
