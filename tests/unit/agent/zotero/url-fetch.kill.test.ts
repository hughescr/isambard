/* eslint-disable sonarjs/no-hardcoded-ip -- the fetcher's DNS answers and pinned addresses are literal IP addresses by definition */
/**
 * Targeted kills for mutants that survived src/agent/zotero/url-fetch.ts (#157). Each test names,
 * in its own description or a comment, the exact boundary/branch it pins down so the mutant it
 * targets is traceable. Helpers are duplicated (not imported) from url-fetch.test.ts on purpose:
 * this file must stand alone per the mutant-killing workflow's own rules.
 */
import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import type http from 'node:http';
import type https from 'node:https';
import { fetchUnderHostPolicy, type UrlFetchOptions } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroFileError, type ZoteroUrlFetchError } from '../../../../src/errors';

interface FakeReply {
    status:     number
    headers?:   Record<string, string>
    chunks?:    (string | Uint8Array)[]
    error?:     Error
    bodyError?: Error
}

interface CapturedRequest {
    url:     URL
    options: Omit<https.RequestOptions, 'lookup'> & { lookup?: (...args: unknown[]) => void }
}

/**
 * A plain async-iterable response, deliberately NOT a real node:stream Readable: Readable's own
 * `Symbol.asyncIterator` calls `.destroy()` itself once iteration completes (even on a clean end),
 * which would mask whether url-fetch.ts's own `response.destroy()` calls actually ran. This object
 * only ever gets destroyed when the production code under test calls `.destroy()` explicitly.
 */
function makeResponse(reply: FakeReply): http.IncomingMessage {
    const chunks = (reply.chunks ?? []).map(chunk => Buffer.from(chunk));
    async function* body(): AsyncGenerator<Buffer> {
        for(const chunk of chunks) {
            yield chunk;
        }
        if(reply.bodyError) {
            throw reply.bodyError;
        }
    }
    const iterator = body();
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    return {
        statusCode:             reply.status,
        headers,
        destroy:                () => undefined,
        [Symbol.asyncIterator]: () => iterator,
    } as unknown as http.IncomingMessage;
}

/** A transport whose request answers (or errors) when `end()` is called. */
function fakeTransport(reply: (url: URL) => FakeReply): { request: NonNullable<UrlFetchOptions['request']>, calls: CapturedRequest[] } {
    const calls: CapturedRequest[] = [];
    const request = ((url: URL, options: CapturedRequest['options'], onResponse: (response: http.IncomingMessage) => void) => {
        calls.push({ url, options });
        let onError: ((error: Error) => void) | undefined;
        return {
            on: (event: string, listener: (error: Error) => void) => {
                if(event === 'error') {
                    onError = listener;
                }
            },
            end: () => {
                const answer = reply(url);
                if(answer.error) {
                    onError?.(answer.error);
                } else {
                    onResponse(makeResponse(answer));
                }
            },
            destroy: () => undefined,
        };
    }) as unknown as typeof http.request;
    return { request: { http: request, https: request }, calls };
}

/** A transport that always hands back one pre-built response object, so the caller can spy on it. */
function transportReturning(response: http.IncomingMessage): NonNullable<UrlFetchOptions['request']> {
    const request = ((_url: URL, _options: unknown, onResponse: (response: http.IncomingMessage) => void) => ({
        on:      () => undefined,
        end:     () => onResponse(response),
        destroy: () => undefined,
    })) as unknown as typeof http.request;
    return { http: request, https: request };
}

/** A transport that hands back a different pre-built response object on each successive call. */
function transportSequence(responses: http.IncomingMessage[]): NonNullable<UrlFetchOptions['request']> {
    let call = 0;
    const request = ((_url: URL, _options: unknown, onResponse: (response: http.IncomingMessage) => void) => ({
        on:  () => undefined,
        end: () => {
            const response = responses[call] ?? responses[responses.length - 1];
            call += 1;
            onResponse(response);
        },
        destroy: () => undefined,
    })) as unknown as typeof http.request;
    return { http: request, https: request };
}

const PDF = '%PDF-1.7 body';
const PDF_MAGIC = '%PDF-';

function resolver(answers: Record<string, string[]>): NonNullable<UrlFetchOptions['resolve']> {
    return async host => (answers[host] ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
}

function baseOptions(overrides: Partial<UrlFetchOptions> = {}): UrlFetchOptions {
    return {
        policy:       {},
        accept:       'html-or-pdf',
        maxHtmlBytes: 100,
        maxPdfBytes:  1000,
        ...overrides,
    };
}

async function fetchError(url: string, options: UrlFetchOptions): Promise<unknown> {
    try {
        await fetchUnderHostPolicy(url, options);
    } catch (error) {
        return error;
    }
    throw new Error('expected the fetch to fail');
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('fetchUnderHostPolicy (mutant kills)', () => {
    const resolve = resolver({ 'a.test': ['8.8.8.8'] });

    describe('error context shape', () => {
        test('omits the status field entirely from the context when none is given (not just as undefined)', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, chunks: ['{}'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            // toStrictEqual (unlike toEqual) fails if `status` is present as an explicit `undefined` key.
            expect((error as ZoteroUrlFetchError).context).toStrictEqual({ url: 'https://a.test/x', reason: 'unsupported content-type application/json' });
        });
    });

    describe('DNS answer pinning order', () => {
        test('pins the first resolver answer, not the last, when several are returned', async () => {
            const multiResolve = async (): Promise<{ address: string, family: number }[]> => [
                { address: '8.8.8.8', family: 4 },
                { address: '8.8.4.4', family: 4 },
            ];
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            await fetchUnderHostPolicy('https://multi.test/a.pdf', baseOptions({ resolve: multiResolve, request }));

            const seen: unknown[] = [];
            calls[0].options.lookup!('multi.test', {}, (error: unknown, address: unknown, family: unknown) => seen.push(error, address, family));
            expect(seen).toEqual([null, '8.8.8.8', 4]);
        });
    });

    describe('transport selection', () => {
        test('sends a plain http:// request over the http transport, not https', async () => {
            const httpCalls: URL[] = [];
            const httpsCalls: URL[] = [];
            const reply = (): FakeReply => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] });
            const httpRequest = ((url: URL, _options: unknown, onResponse: (response: http.IncomingMessage) => void) => {
                httpCalls.push(url);
                return { on: () => undefined, end: () => onResponse(makeResponse(reply())), destroy: () => undefined };
            }) as unknown as typeof http.request;
            const httpsRequest = ((url: URL, _options: unknown, onResponse: (response: http.IncomingMessage) => void) => {
                httpsCalls.push(url);
                return { on: () => undefined, end: () => onResponse(makeResponse(reply())), destroy: () => undefined };
            }) as unknown as typeof http.request;

            await fetchUnderHostPolicy('http://a.test/x', baseOptions({ resolve, request: { http: httpRequest, https: httpsRequest } }));

            expect(httpCalls).toHaveLength(1);
            expect(httpsCalls).toHaveLength(0);

            await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request: { http: httpRequest, https: httpsRequest } }));

            expect(httpsCalls).toHaveLength(1);
            expect(httpCalls).toHaveLength(1);
        });
    });

    describe('IPv6-literal host stripping in send()', () => {
        test('never resolves and never sets servername for [::2] (front-of-bracket boundary)', async () => {
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));
            const neverResolve = async (): Promise<never> => {
                throw new Error('must not resolve an IP literal');
            };

            await fetchUnderHostPolicy('https://[::2]/a.pdf', baseOptions({ resolve: neverResolve, request }));

            expect(calls[0].options.servername).toBeUndefined();
        });

        test('never resolves and never sets servername for [1::] (back-of-bracket boundary)', async () => {
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));
            const neverResolve = async (): Promise<never> => {
                throw new Error('must not resolve an IP literal');
            };

            await fetchUnderHostPolicy('https://[1::]/a.pdf', baseOptions({ resolve: neverResolve, request }));

            expect(calls[0].options.servername).toBeUndefined();
        });

        // Kill-review follow-up: the bracket-stripping must yield exactly the address inside the
        // brackets (a trimmed or bracketed host would check and pin a different address, or none).
        test('checks and pins exactly the address inside the brackets', async () => {
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));
            const checked: string[] = [];
            const checkAddress: NonNullable<UrlFetchOptions['checkAddress']> = (address) => {
                checked.push(address);
                return { ok: true, address, family: 6 };
            };
            const neverResolve = async (): Promise<never> => {
                throw new Error('must not resolve an IP literal');
            };

            await fetchUnderHostPolicy('https://[2001:db8::12]/a.pdf', baseOptions({ resolve: neverResolve, request, checkAddress }));

            expect(checked).toEqual(['2001:db8::12']);
            const answers: unknown[][] = [];
            calls[0].options.lookup?.('2001:db8::12', { all: false }, (...answer: unknown[]) => answers.push(answer));
            expect(answers).toEqual([[null, '2001:db8::12', 6]]);
            expect(calls[0].options.servername).toBeUndefined();
        });

        // Kill-review follow-up: an ordinary name is resolved and used for SNI as written, not trimmed
        // as if it were a bracketed literal.
        test('resolves an ordinary hostname untouched and uses it as the servername', async () => {
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));
            const resolved: string[] = [];
            const resolveHost: NonNullable<UrlFetchOptions['resolve']> = async (host) => {
                resolved.push(host);
                return [{ address: '93.184.216.34', family: 4 }];
            };

            await fetchUnderHostPolicy('https://papers.test/a.pdf', baseOptions({ resolve: resolveHost, request }));

            expect(resolved).toEqual(['papers.test']);
            expect(calls[0].options.servername).toBe('papers.test');
        });
    });

    describe('default timeout', () => {
        test('arms exactly a 30-second AbortSignal.timeout when timeoutMs is not given', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));
            const timeoutSpy = spyOn(AbortSignal, 'timeout');

            await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(timeoutSpy).toHaveBeenCalledWith(30_000);
        });
    });

    describe('media type parsing', () => {
        test('trims leading and trailing whitespace around the type before matching it', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': '  text/html  ; charset=utf-8' }, chunks: ['<html></html>'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(result.kind).toBe('html');
        });

        test('reports "no content type" (not "undefined") when a PDF is required and the response has none', async () => {
            const { request } = fakeTransport(() => ({ status: 200, chunks: ['plain text body'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ accept: 'pdf', resolve, request }));

            expect(error).toBeInstanceOf(ZoteroFileError);
            expect((error as ZoteroFileError).message).toBe('https://a.test/x is not a PDF (no content type)');
        });
    });

    describe('declared Content-Length cap on a PDF', () => {
        test('destroys the response and refuses immediately, without reading the body, when Content-Length declares an over-cap PDF', async () => {
            const response = makeResponse({ status: 200, headers: { 'content-type': 'application/pdf', 'content-length': '999' }, chunks: ['not-pdf-bytes'] });
            const destroySpy = spyOn(response, 'destroy');

            const error = await fetchError('https://a.test/x', baseOptions({ maxPdfBytes: 10, resolve, request: transportReturning(response) }));

            expect(error).toBeInstanceOf(ZoteroFileError);
            expect((error as ZoteroFileError).message).toBe('The PDF at https://a.test/x is larger than the 10-byte limit (the browser download cap)');
            expect(destroySpy).toHaveBeenCalledTimes(1);
        });

        test('never applies the declared-Content-Length PDF cap to a non-PDF content type', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html', 'Content-Length': '999' }, chunks: ['<html></html>'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxPdfBytes: 10, resolve, request }));

            expect(result.kind).toBe('html');
        });
    });

    describe('response cleanup', () => {
        test('destroys the response exactly once after a successful read', async () => {
            const response = makeResponse({ status: 200, headers: { 'content-type': 'application/pdf' }, chunks: [PDF] });
            const destroySpy = spyOn(response, 'destroy');

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request: transportReturning(response) }));

            expect(result.kind).toBe('pdf');
            expect(destroySpy).toHaveBeenCalledTimes(1);
        });

        test('destroys the redirecting response before following the next hop', async () => {
            const first = makeResponse({ status: 302, headers: { location: 'https://b.test/next' } });
            const second = makeResponse({ status: 200, headers: { 'content-type': 'application/pdf' }, chunks: [PDF] });
            const destroyFirst = spyOn(first, 'destroy');
            const redirectResolve = resolver({ 'a.test': ['8.8.8.8'], 'b.test': ['8.8.4.4'] });

            await fetchUnderHostPolicy('https://a.test/start', baseOptions({ resolve: redirectResolve, request: transportSequence([first, second]) }));

            expect(destroyFirst).toHaveBeenCalledTimes(1);
        });
    });

    describe('HTML byte cap vs. kind', () => {
        test('never truncates a PDF at the (smaller) HTML byte cap', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 5, maxPdfBytes: 1000, resolve, request }));

            expect(result.kind).toBe('pdf');
            expect(result.truncated).toBe(false);
            expect(result.bytes).toHaveLength(PDF.length);
        });

        test('keeps reading PDF bytes past the HTML byte cap instead of stopping the stream', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF, 'MOREDATA'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 5, maxPdfBytes: 1000, resolve, request }));

            expect(result.kind).toBe('pdf');
            expect(result.truncated).toBe(false);
            expect(result.bytes).toHaveLength(PDF.length + 'MOREDATA'.length);
        });

        test('stops reading HTML the moment the cap is passed, never asking the stream for a later chunk', async () => {
            const bodyError = new Error('a later chunk was read even though the cap was already passed');
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['<html>1234', '5'], bodyError }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 10, resolve, request }));

            expect(result.truncated).toBe(true);
            expect(new TextDecoder().decode(result.bytes)).toBe('<html>1234');
        });
    });

    describe('PDF byte cap vs. kind', () => {
        test('never applies the PDF byte cap while streaming an HTML response', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: [`<html>${'x'.repeat(20)}`] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 1000, maxPdfBytes: 5, resolve, request }));

            expect(result.kind).toBe('html');
            expect(result.truncated).toBe(false);
        });

        test('applies the PDF byte cap exactly at the PDF-magic-length boundary, not one byte later', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF_MAGIC] }));

            const error = await fetchError('https://a.test/x', baseOptions({ maxPdfBytes: 3, resolve, request }));

            expect(error).toBeInstanceOf(ZoteroFileError);
            expect((error as ZoteroFileError).context).toEqual({ reason: 'too_large', limit: 3 });
        });
    });

    describe('response status boundaries', () => {
        test('treats status 199 as a failure', async () => {
            const { request } = fakeTransport(() => ({ status: 199 }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://a.test/x failed: HTTP 199');
        });

        test('treats status 299 as success', async () => {
            const { request } = fakeTransport(() => ({ status: 299, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(result.kind).toBe('pdf');
        });

        test('treats status 300 as a failure and destroys the response', async () => {
            const response = makeResponse({ status: 300 });
            const destroySpy = spyOn(response, 'destroy');

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request: transportReturning(response) }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://a.test/x failed: HTTP 300');
            expect(destroySpy).toHaveBeenCalledTimes(1);
        });

        test('treats a response with no status code at all as HTTP 0, not -1 or 1', async () => {
            const response = { statusCode: undefined, headers: {}, destroy: () => undefined } as unknown as http.IncomingMessage;

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request: transportReturning(response) }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://a.test/x failed: HTTP 0');
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'HTTP 0', status: 0 });
        });
    });
});
