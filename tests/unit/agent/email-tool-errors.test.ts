import { describe, test, expect, beforeEach } from 'bun:test';
import {
    EMAIL_ERROR_LOG_DETAIL_MAX_CHARS,
    EMAIL_TOOL_ERROR_SENTENCES,
    classifyEmailToolError,
    emailToolErrorText,
    newErrorReference,
    recordEmailToolFailure,
    withEmailToolErrorHandling,
    type EmailToolErrorCode
} from '../../../src/agent/email-tool-errors';
import { BskyError, EmailProcessingError, WildDuckAuthError, WildDuckError } from '../../../src/errors';
import { mockLogger } from '../../setup';

const httpError = (status: number): WildDuckError => new WildDuckError(`WildDuck API error: ${status} Error: upstream body`, undefined, { status, kind: 'http' });

describe('classifyEmailToolError', () => {
    test.each([
        [399, 'unavailable'],
        [400, 'refused'],
        [403, 'refused'],
        [404, 'not_found'],
        [405, 'refused'],
        [407, 'refused'],
        [408, 'timeout'],
        [409, 'refused'],
        [429, 'refused'],
        [499, 'refused'],
        [500, 'unavailable'],
        [503, 'unavailable'],
    ] as [number, EmailToolErrorCode][])('a WildDuck answer of HTTP %i is %s', (status, code) => {
        expect(classifyEmailToolError(httpError(status))).toBe(code);
    });

    test('reads the status from the error\'s context, never its message', () => {
        expect(classifyEmailToolError(new WildDuckError('WildDuck API error: 404 Not Found', undefined, { status: 500, kind: 'http' }))).toBe('unavailable');
        expect(classifyEmailToolError(new WildDuckError('WildDuck API error: 404 Not Found'))).toBe('unavailable');
    });

    test('a refused login is auth, whatever its context', () => {
        expect(classifyEmailToolError(new WildDuckAuthError('WildDuck authentication failed (401)', { kind: 'auth' }))).toBe('auth');
        expect(classifyEmailToolError(new WildDuckAuthError('Authentication failed: no token returned'))).toBe('auth');
    });

    test.each([
        ['invalid_request', 'invalid_request'],
        ['timeout', 'timeout'],
        ['bad_response', 'unavailable'],
        ['auth', 'unavailable'],
        ['http', 'unavailable'],
    ] as const)('a status-less WildDuckError of kind %s is %s', (kind, code) => {
        expect(classifyEmailToolError(new WildDuckError('detail', undefined, { kind }))).toBe(code);
    });

    test('a WildDuckError with no context is unavailable', () => {
        expect(classifyEmailToolError(new WildDuckError('detail'))).toBe('unavailable');
    });

    test('a status on another service\'s error is not read as WildDuck\'s', () => {
        expect(classifyEmailToolError(new BskyError('not found', undefined, { status: 404 }))).toBe('unavailable');
    });

    test('a request deadline (a TimeoutError) is timeout; any other abort, network failure or throwable is unavailable', () => {
        expect(classifyEmailToolError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe('timeout');
        expect(classifyEmailToolError(new DOMException('This operation was aborted', 'AbortError'))).toBe('unavailable');
        expect(classifyEmailToolError(new TypeError('fetch failed'))).toBe('unavailable');
        expect(classifyEmailToolError(new Error('boom'))).toBe('unavailable');
        expect(classifyEmailToolError('a string')).toBe('unavailable');
        expect(classifyEmailToolError(undefined)).toBe('unavailable');
    });
});

describe('EMAIL_TOOL_ERROR_SENTENCES', () => {
    test('says, for each code, what happened and what to do next', () => {
        expect(EMAIL_TOOL_ERROR_SENTENCES).toEqual({
            timeout:         'The mail server did not answer in time, so it is not known whether this took effect. Check the current state (search or list again) before trying again.',
            not_found:       'The mailbox, message or attachment was not found; it may have been moved or deleted. Search or list again for its current reference.',
            refused:         'The mail server refused this request, so it did not take effect. Do not repeat it unchanged; if it should have worked, tell the admin.',
            unavailable:     'The mail service is unavailable or failed while handling this, so it is not known whether a change took effect. Check the current state before trying again later; if it keeps failing, tell the admin.',
            auth:            'The mail server refused the mail account\'s login. Do not retry; tell the admin, who has to fix the account\'s credentials.',
            invalid_request: 'The request was refused before it reached the mail server: a mailbox or attachment reference in it is not one the mail server can have. Check the reference and try again.',
        });
    });
});

describe('emailToolErrorText', () => {
    test('names the tool and the code, gives the fixed sentence and the reference', () => {
        expect(emailToolErrorText('archiveEmail', { code: 'not_found', reference: 'a1b2c3d4' }))
            .toBe('archiveEmail failed (not_found): The mailbox, message or attachment was not found; it may have been moved or deleted. Search or list again for its current reference. Reference: a1b2c3d4.');
    });
});

describe('newErrorReference', () => {
    test('is eight lowercase hex digits, different each time', () => {
        const references = Array.from({ length: 4 }, () => newErrorReference());
        for(const reference of references) {
            expect(reference).toMatch(/^[0-9a-f]{8}$/u);
        }
        expect(new Set(references).size).toBe(4);
    });
});

describe('recordEmailToolFailure', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

    test('logs the tool, code, reference, status, kind, error name and message, and returns the code and reference', () => {
        const failure = recordEmailToolFailure('getEmailContent', httpError(502), () => 'feedf00d');

        expect(failure).toEqual({ code: 'unavailable', reference: 'feedf00d' });
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith({
            tool:      'getEmailContent',
            code:      'unavailable',
            reference: 'feedf00d',
            status:    502,
            kind:      'http',
            error:     'WildDuckError',
            detail:    'WildDuck API error: 502 Error: upstream body',
            msg:       'Email tool failed',
        });
    });

    test('logs no status or kind for an error that has none, and a non-Error by its type and text', () => {
        recordEmailToolFailure('searchEmail', new TypeError('fetch failed'), () => 'r1');
        recordEmailToolFailure('searchEmail', 'thrown text', () => 'r2');

        expect(mockLogger.warn.mock.calls).toEqual([
            [{ tool: 'searchEmail', code: 'unavailable', reference: 'r1', error: 'TypeError', detail: 'fetch failed', msg: 'Email tool failed' }],
            [{ tool: 'searchEmail', code: 'unavailable', reference: 'r2', error: 'string', detail: 'thrown text', msg: 'Email tool failed' }],
        ]);
    });

    test('logs no status or kind from another service\'s error context', () => {
        recordEmailToolFailure('searchEmail', new BskyError('not found', undefined, { status: 404, kind: 'http' }), () => 'r3');

        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'searchEmail', code: 'unavailable', reference: 'r3', error: 'BskyError', detail: 'not found', msg: 'Email tool failed' });
    });

    test(`logs at most ${EMAIL_ERROR_LOG_DETAIL_MAX_CHARS} characters of the detail, marking a cut one`, () => {
        recordEmailToolFailure('t', new Error('x'.repeat(EMAIL_ERROR_LOG_DETAIL_MAX_CHARS)), () => 'r');
        recordEmailToolFailure('t', new Error('y'.repeat(EMAIL_ERROR_LOG_DETAIL_MAX_CHARS + 1)), () => 'r');

        const details = mockLogger.warn.mock.calls.map(([entry]) => (entry as { detail: string }).detail);
        expect(details).toEqual(['x'.repeat(EMAIL_ERROR_LOG_DETAIL_MAX_CHARS), `${'y'.repeat(EMAIL_ERROR_LOG_DETAIL_MAX_CHARS)}…`]);
        expect(EMAIL_ERROR_LOG_DETAIL_MAX_CHARS).toBe(500);
    });

    test('uses a fresh random reference by default', () => {
        expect(recordEmailToolFailure('t', new Error('x')).reference).toMatch(/^[0-9a-f]{8}$/u);
    });
});

describe('withEmailToolErrorHandling', () => {
    beforeEach(() => {
        mockLogger.warn.mockClear();
    });

    test('passes a result through unchanged', async () => {
        const result = { content: [{ type: 'text' as const, text: 'ok' }] };
        expect(await withEmailToolErrorHandling('t', async () => result)({})).toBe(result);
        expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('turns a WildDuck failure into the classified tool text, never the upstream text', async () => {
        const handler = withEmailToolErrorHandling('deleteDraft', async () => {
            throw httpError(500);
        }, () => '0badc0de');

        expect(await handler({})).toEqual({
            content: [{ type: 'text', text: 'deleteDraft failed (unavailable): The mail service is unavailable or failed while handling this, so it is not known whether a change took effect. Check the current state before trying again later; if it keeps failing, tell the admin. Reference: 0badc0de.' }],
            isError: true,
        });
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tool: 'deleteDraft', reference: '0badc0de', detail: 'WildDuck API error: 500 Error: upstream body' }));
    });

    test('shows an Isambard-authored EmailProcessingError as it is, logged by its message', async () => {
        const handler = withEmailToolErrorHandling('sendEmail', async () => {
            throw new EmailProcessingError('Attachment file not found: /tmp/missing.pdf');
        });

        expect(await handler({})).toEqual({ content: [{ type: 'text', text: 'Error: Attachment file not found: /tmp/missing.pdf' }], isError: true });
        expect(mockLogger.warn).toHaveBeenCalledWith({ tool: 'sendEmail', error: 'Attachment file not found: /tmp/missing.pdf', msg: 'Email tool failed' });
    });

    test('passes the tool arguments to the handler', async () => {
        const handler = withEmailToolErrorHandling('t', async (args: { n: number }) => ({ content: [{ type: 'text' as const, text: String(args.n) }] }));
        expect(await handler({ n: 7 })).toEqual({ content: [{ type: 'text', text: '7' }] });
    });
});
