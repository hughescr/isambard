/* eslint-disable sonarjs/no-hardcoded-ip -- the fetcher's DNS answers and pinned addresses are literal IP addresses by definition */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import type https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { fetchUnderHostPolicy, type UrlFetchOptions } from '../../../../src/agent/zotero/url-fetch';
import { ZoteroFileError, ZoteroUrlFetchError } from '../../../../src/errors';

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

function makeResponse(reply: FakeReply): http.IncomingMessage {
    const chunks = (reply.chunks ?? []).map(chunk => Buffer.from(chunk));
    function* body(): Generator<Buffer> {
        yield* chunks;
        if(reply.bodyError) {
            throw reply.bodyError;
        }
    }
    const stream = Readable.from(body());
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    return Object.assign(stream, { statusCode: reply.status, headers }) as unknown as http.IncomingMessage;
}

/** A transport whose request answers (or errors) when `end()` is called; the fetcher registers its error listener first. */
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

const PDF = '%PDF-1.7 body';

function resolver(answers: Record<string, string[]>): { resolve: NonNullable<UrlFetchOptions['resolve']>, calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        resolve: async (host) => {
            calls.push(host);
            return (answers[host] ?? []).map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
        },
    };
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

describe('fetchUnderHostPolicy', () => {
    describe('host policy', () => {
        test('rejects a URL the browser policy rejects, before resolving or connecting', async () => {
            const { resolve, calls: resolved } = resolver({});
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('http://localhost/x', baseOptions({ resolve, request }));

            expect(error).toBeInstanceOf(ZoteroUrlFetchError);
            expect((error as ZoteroUrlFetchError).message).toBe('Fetching http://localhost/x was refused: host \'localhost\' is loopback');
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'http://localhost/x', reason: 'host \'localhost\' is loopback' });
            expect(resolved).toEqual([]);
            expect(calls).toEqual([]);
        });

        test('applies the browser allowlist', async () => {
            const { resolve } = resolver({ 'other.com': ['8.8.8.8'] });
            const { request } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://other.com/', baseOptions({ policy: { allowlist: ['example.org'] }, resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://other.com/', reason: 'host \'other.com\' is not in the allowlist' });
        });
    });

    describe('resolution and pinning', () => {
        test.each(['127.0.0.1', '::1', '10.1.2.3', '169.254.169.254', '::ffff:7f00:1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1'])('refuses a host resolving to %s without connecting', async (address) => {
            const { resolve } = resolver({ 'evil.test': [address] });
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://evil.test/', baseOptions({ resolve, request }));

            expect(error).toBeInstanceOf(ZoteroUrlFetchError);
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://evil.test/', reason: 'resolves to a blocked address' });
            expect((error as ZoteroUrlFetchError).message).toStartWith('Fetching https://evil.test/ was refused: resolves to a blocked address (IP address ');
            expect(calls).toEqual([]);
        });

        test('refuses a mixed public and private answer', async () => {
            const { resolve } = resolver({ 'mixed.test': ['8.8.8.8', '127.0.0.1'] });
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://mixed.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://mixed.test/', reason: 'resolves to a blocked address' });
            expect(calls).toEqual([]);
        });

        test.each(['example.com', 'fe80::1%lo0'])('refuses the malformed answer %s', async (address) => {
            const { resolve } = resolver({ 'odd.test': [address] });
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://odd.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://odd.test/', reason: 'resolver returned a malformed address' });
            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://odd.test/ was refused: resolver returned a malformed address');
            expect(calls).toEqual([]);
        });

        test('refuses an empty answer', async () => {
            const { resolve } = resolver({});
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://nowhere.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://nowhere.test/', reason: 'host has no addresses' });
            expect(calls).toEqual([]);
        });

        test('reports a failed lookup', async () => {
            const { request } = fakeTransport(() => ({ status: 200 }));
            const resolve = async () => {
                throw new Error('ENOTFOUND');
            };

            const error = await fetchError('https://gone.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://gone.test/', reason: 'could not resolve the host' });
            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://gone.test/ failed: could not resolve the host (ENOTFOUND)');
        });

        test('pins the canonical validated address and never resolves twice in a hop', async () => {
            let lookups = 0;
            const resolve = async () => {
                lookups++;
                return lookups === 1 ? [{ address: '::ffff:8.8.8.8', family: 6 }] : [{ address: '127.0.0.1', family: 4 }];
            };
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            await fetchUnderHostPolicy('https://paper.test/a.pdf', baseOptions({ resolve, request }));

            expect(lookups).toBe(1);
            const lookup = calls[0].options.lookup!;
            const single: unknown[] = [];
            const all: unknown[] = [];
            lookup('paper.test', {}, (error: unknown, address: unknown, family: unknown) => single.push(error, address, family));
            lookup('paper.test', { all: true }, (error: unknown, address: unknown) => all.push(error, address));
            lookup('paper.test', { all: false }, (error: unknown, address: unknown, family: unknown) => single.push(error, address, family));

            expect(single).toEqual([null, '::ffff:808:808', 6, null, '::ffff:808:808', 6]);
            expect(all).toEqual([null, [{ address: '::ffff:808:808', family: 6 }]]);
            expect(lookups).toBe(1);
        });

        test('sends a plain GET with no pooled socket, identity encoding, and the original host for TLS', async () => {
            const { resolve } = resolver({ 'paper.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            await fetchUnderHostPolicy('https://paper.test/a.pdf', baseOptions({ accept: 'pdf', resolve, request }));

            const { url, options } = calls[0];
            expect(url.href).toBe('https://paper.test/a.pdf');
            expect(options.method).toBe('GET');
            expect(options.agent).toBe(false);
            expect(options.servername).toBe('paper.test');
            expect(options.signal).toBeInstanceOf(AbortSignal);
            expect(options.headers).toEqual({
                Accept:            'application/pdf',
                'Accept-Encoding': 'identity',
                'User-Agent':      'Isambard (+https://github.com/hughescr/isambard)',
            });
        });

        test('asks for HTML or PDF when either is acceptable', async () => {
            const { resolve } = resolver({ 'paper.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['<html></html>'] }));

            await fetchUnderHostPolicy('http://paper.test/', baseOptions({ resolve, request }));

            expect((calls[0].options.headers as Record<string, string>).Accept).toBe('text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1');
            expect(calls[0].options.servername).toBeUndefined();
        });

        test('connects to an IP-literal host without resolving it', async () => {
            const { resolve, calls: resolved } = resolver({});
            const { request, calls } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            await fetchUnderHostPolicy('https://[2606:4700:4700::1111]/a.pdf', baseOptions({ resolve, request }));

            expect(resolved).toEqual([]);
            const seen: unknown[] = [];
            calls[0].options.lookup!('x', {}, (error: unknown, address: unknown, family: unknown) => seen.push(error, address, family));
            expect(seen).toEqual([null, '2606:4700:4700::1111', 6]);
            expect(calls[0].options.servername).toBeUndefined();
        });

        test('uses the injected address check', async () => {
            const { resolve } = resolver({ 'paper.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport(() => ({ status: 200 }));

            const error = await fetchError('https://paper.test/', baseOptions({ resolve, request, checkAddress: () => ({ ok: false, reason: 'nope' }) }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://paper.test/ was refused: resolves to a blocked address (nope)');
            expect(calls).toEqual([]);
        });
    });

    describe('redirects', () => {
        test('re-validates and re-resolves every hop', async () => {
            const { resolve, calls: resolved } = resolver({ 'a.test': ['8.8.8.8'], 'b.test': ['8.8.4.4'] });
            const { request, calls } = fakeTransport((url): FakeReply => (url.hostname === 'a.test'
                ? { status: 302, headers: { Location: 'https://b.test/final.pdf' } }
                : { status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            const result = await fetchUnderHostPolicy('https://a.test/start', baseOptions({ resolve, request }));

            expect(result.finalUrl).toBe('https://b.test/final.pdf');
            expect(resolved).toEqual(['a.test', 'b.test']);
            expect(calls.map(call => call.url.href)).toEqual(['https://a.test/start', 'https://b.test/final.pdf']);
        });

        test('resolves a relative Location against the current URL', async () => {
            const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport((url): FakeReply => (url.pathname === '/start'
                ? { status: 301, headers: { Location: '/next.pdf' } }
                : { status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }));

            const result = await fetchUnderHostPolicy('https://a.test/start', baseOptions({ resolve, request }));

            expect(result.finalUrl).toBe('https://a.test/next.pdf');
            expect(calls).toHaveLength(2);
        });

        test('refuses a redirect to a blocked address', async () => {
            const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport(() => ({ status: 307, headers: { Location: 'http://169.254.169.254/latest' } }));

            const error = await fetchError('https://a.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'http://169.254.169.254/latest', reason: 'IP address 169.254.169.254 is in a blocked range (loopback/private/link-local)' });
            expect(calls).toHaveLength(1);
        });

        test('follows at most five redirects', async () => {
            const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });
            const { request, calls } = fakeTransport(url => ({ status: 308, headers: { Location: `/r${Number(url.pathname.slice(2) || '0') + 1}` } }));

            const error = await fetchError('https://a.test/r0', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/r0', reason: 'too many redirects' });
            expect(calls).toHaveLength(6);
        });

        test('succeeds on the fifth redirect', async () => {
            const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });
            const { request } = fakeTransport((url): FakeReply => {
                const hop = Number(url.pathname.slice(2) || '0');
                return hop === 5
                    ? { status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: [PDF] }
                    : { status: 303, headers: { Location: `/r${hop + 1}` } };
            });

            const result = await fetchUnderHostPolicy('https://a.test/r0', baseOptions({ resolve, request }));

            expect(result.finalUrl).toBe('https://a.test/r5');
        });

        test('reports a redirect without a Location', async () => {
            const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });
            const { request } = fakeTransport(() => ({ status: 302 }));

            const error = await fetchError('https://a.test/', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/', reason: 'redirect without a Location', status: 302 });
        });
    });

    describe('responses', () => {
        const { resolve } = resolver({ 'a.test': ['8.8.8.8'] });

        test('reports a non-2xx status', async () => {
            const { request } = fakeTransport(() => ({ status: 404 }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://a.test/x failed: HTTP 404');
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'HTTP 404', status: 404 });
        });

        test('treats %PDF- bytes as a PDF whatever the content type says', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['%P', 'DF', '-1.4 rest'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(result).toEqual({ finalUrl: 'https://a.test/x', kind: 'pdf', bytes: expect.any(Uint8Array), truncated: false });
            expect(new TextDecoder().decode(result.bytes)).toBe('%PDF-1.4 rest');
        });

        test('reads HTML (with a charset parameter) and marks it untruncated when it fits exactly', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'Text/HTML; charset=utf-8' }, chunks: ['<html>', '1234'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 10, resolve, request }));

            expect(result.kind).toBe('html');
            expect(result.truncated).toBe(false);
            expect(new TextDecoder().decode(result.bytes)).toBe('<html>1234');
        });

        test('accepts application/xhtml+xml as HTML', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/xhtml+xml' }, chunks: ['<html/>'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(result.kind).toBe('html');
        });

        test('truncates HTML at the cap', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['<html>1234', '5', 'never read'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxHtmlBytes: 10, resolve, request }));

            expect(result.truncated).toBe(true);
            expect(new TextDecoder().decode(result.bytes)).toBe('<html>1234');
        });

        test('refuses a PDF whose Content-Length is over the cap without reading it', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': '11' }, chunks: [PDF] }));

            const error = await fetchError('https://a.test/x', baseOptions({ maxPdfBytes: 10, resolve, request }));

            expect(error).toBeInstanceOf(ZoteroFileError);
            expect((error as ZoteroFileError).message).toBe('The PDF at https://a.test/x is larger than the 10-byte limit (the browser download cap)');
            expect((error as ZoteroFileError).context).toEqual({ reason: 'too_large', limit: 10 });
        });

        test('accepts a PDF exactly at the cap', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': '13' }, chunks: [PDF] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ maxPdfBytes: 13, resolve, request }));

            expect(result.bytes).toHaveLength(13);
        });

        test('refuses a PDF whose stream passes the cap', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/octet-stream' }, chunks: [PDF, 'x'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ maxPdfBytes: 13, resolve, request }));

            expect((error as ZoteroFileError).context).toEqual({ reason: 'too_large', limit: 13 });
        });

        test('refuses an unsupported content type', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/json' }, chunks: ['{"a":1}'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect(error).toBeInstanceOf(ZoteroUrlFetchError);
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'unsupported content-type application/json' });
        });

        test('refuses a response with no content type that is not a PDF', async () => {
            const { request } = fakeTransport(() => ({ status: 200, chunks: ['hi'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'unsupported content-type (none)' });
        });

        test('refuses HTML when only a PDF is acceptable', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['<html>paywall</html>'] }));

            const error = await fetchError('https://a.test/x', baseOptions({ accept: 'pdf', resolve, request }));

            expect(error).toBeInstanceOf(ZoteroFileError);
            expect((error as ZoteroFileError).message).toBe('https://a.test/x is not a PDF (text/html)');
            expect((error as ZoteroFileError).context).toEqual({ reason: 'not_pdf' });
        });

        test('reports a connection error', async () => {
            const { request } = fakeTransport(() => ({ status: 0, error: new Error('ECONNRESET') }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).message).toBe('Fetching https://a.test/x failed: ECONNRESET');
            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'ECONNRESET' });
        });

        test.each(['AbortError', 'TimeoutError'])('reports a %s as a timeout', async (name) => {
            const abort = Object.assign(new Error('aborted'), { name });
            const { request } = fakeTransport(() => ({ status: 0, error: abort }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'timed out' });
        });

        test('reports a body that fails mid-stream', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, chunks: ['%PDF-'], bodyError: new Error('socket hang up') }));

            const error = await fetchError('https://a.test/x', baseOptions({ resolve, request }));

            expect((error as ZoteroUrlFetchError).context).toEqual({ url: 'https://a.test/x', reason: 'socket hang up' });
        });

        test('reads a body shorter than the PDF magic', async () => {
            const { request } = fakeTransport(() => ({ status: 200, headers: { 'Content-Type': 'text/html' }, chunks: ['<a>'] }));

            const result = await fetchUnderHostPolicy('https://a.test/x', baseOptions({ resolve, request }));

            expect(result.kind).toBe('html');
            expect(result.bytes).toHaveLength(3);
        });
    });

    describe('with a real socket', () => {
        let server: http.Server;
        let port: number;
        const hosts: (string | undefined)[] = [];

        beforeAll(async () => {
            server = http.createServer((request, response) => {
                hosts.push(request.headers.host);
                response.writeHead(200, { 'Content-Type': 'application/pdf' });
                response.end(PDF);
            });
            await new Promise<void>((resolve) => {
                server.listen(0, '127.0.0.1', resolve);
            });
            port = (server.address() as AddressInfo).port;
        });

        afterAll(async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        });

        test('connects to the pinned address, not a fresh resolution', async () => {
            const result = await fetchUnderHostPolicy(`http://pinned.invalid:${port}/a.pdf`, baseOptions({
                resolve:      async () => [{ address: '127.0.0.1', family: 4 }],
                checkAddress: raw => (raw === '127.0.0.1' ? { ok: true, address: raw, family: 4 } : { ok: false, reason: 'only loopback in this test' }),
            }));

            expect(result.kind).toBe('pdf');
            expect(hosts).toEqual([`pinned.invalid:${port}`]);
        });
    });
});
