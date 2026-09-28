/**
 * Fetching arbitrary URLs for the Zotero tools under the browser tool's own host policy (#157,
 * design §6.1). There is no second policy: every hop goes through `validateUrl`, and every DNS
 * answer through `checkResolvedAddress`, which applies the same range logic to the canonical form
 * of the address.
 *
 * DNS rebinding is closed by resolving each hop exactly once and pinning the connection to the
 * validated canonical address through `node:http(s)`'s `lookup` option (Bun's `fetch` cannot pin).
 * TLS still verifies the original hostname. Byte caps are the browser's: HTML is truncated at the
 * text cap, and a PDF over the download cap is an error.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { checkResolvedAddress, validateUrl, type BrowserHostPolicy } from '../browser';
import { ZoteroError, ZoteroFileError, ZoteroUrlFetchError } from '@/errors';

export interface UrlFetchOptions {
    policy:        BrowserHostPolicy
    /** `pdf`: anything else is `not_pdf`. `html-or-pdf`: a page or a PDF. */
    accept:        'pdf' | 'html-or-pdf'
    /** HTML is read up to this many bytes and then truncated (the browser's text cap). */
    maxHtmlBytes:  number
    /** A PDF over this many bytes is an error (the browser's download cap). */
    maxPdfBytes:   number
    /** Test seam: DNS resolution, called once per hop. */
    resolve?:      (host: string) => Promise<{ address: string, family: number }[]>
    /** Test seam: the transports. */
    request?:      { http: typeof http.request, https: typeof https.request }
    /** Test seam: the per-answer address check. */
    checkAddress?: typeof checkResolvedAddress
    timeoutMs?:    number
}

export type FetchedKind = 'pdf' | 'html';

interface Streamed {
    bytes: Buffer
    /** Undefined when the body ended before the PDF magic could be checked. */
    kind:  FetchedKind | undefined
}

export interface UrlFetchResult {
    finalUrl:  string
    kind:      FetchedKind
    bytes:     Uint8Array
    /** True when HTML was cut off at `maxHtmlBytes`. */
    truncated: boolean
}

const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PDF_MAGIC = '%PDF-';
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const USER_AGENT = 'Isambard (+https://github.com/hughescr/isambard)';
const ACCEPT = {
    pdf:           'application/pdf',
    'html-or-pdf': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1',
} as const;

interface Pinned {
    address: string
    family:  4 | 6
}

type LookupCallback = (error: Error | null, address: string | Pinned[], family?: number) => void;

// Stryker disable all: production defaults (real DNS and sockets); tests inject all three.
const realResolve = async (host: string) => dnsLookup(host, { all: true });
const realRequest = { http: http.request, https: https.request };
// Stryker restore all

function refused(url: string, reason: string, detail?: string): ZoteroUrlFetchError {
    const suffix = detail === undefined ? '' : ` (${detail})`;
    return new ZoteroUrlFetchError(`Fetching ${url} was refused: ${reason}${suffix}`, { url, reason });
}

function failed(url: string, reason: string, status?: number): ZoteroUrlFetchError {
    return new ZoteroUrlFetchError(`Fetching ${url} failed: ${reason}`, { url, reason, ...status === undefined ? {} : { status } });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A socket, timeout or stream failure as a fetch error; our own typed errors pass through. */
function transportFailure(url: string, error: unknown): ZoteroError {
    if(error instanceof ZoteroError) {
        return error;
    }
    const timedOut = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return failed(url, timedOut ? 'timed out' : errorMessage(error));
}

/** The hop's single resolution, every answer checked; the first answer (canonical) is pinned. */
async function pinHost(url: URL, options: UrlFetchOptions): Promise<Pinned> {
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    let answers: { address: string }[];
    if(isIP(host) === 0) {
        try {
            answers = await (options.resolve ?? realResolve)(host);
        } catch (error) {
            throw new ZoteroUrlFetchError(`Fetching ${url.href} failed: could not resolve the host (${errorMessage(error)})`, { url: url.href, reason: 'could not resolve the host' });
        }
    } else {
        answers = [{ address: host }];
    }
    if(answers.length === 0) {
        throw refused(url.href, 'host has no addresses');
    }

    const check = options.checkAddress ?? checkResolvedAddress;
    const pinned: Pinned[] = [];
    for(const answer of answers) {
        const result = check(answer.address);
        if(!result.ok) {
            throw result.reason === 'resolver returned a malformed address'
                ? refused(url.href, result.reason)
                : refused(url.href, 'resolves to a blocked address', result.reason);
        }
        pinned.push({ address: result.address, family: result.family });
    }
    return pinned[0]!;
}

async function send(url: URL, pinned: Pinned, options: UrlFetchOptions): Promise<http.IncomingMessage> {
    const transports = options.request ?? realRequest;
    const transport = url.protocol === 'https:' ? transports.https : transports.http;
    // Every lookup the transport makes gets the one validated answer; nothing resolves the host again.
    const lookup = (_host: string, lookupOptions: { all?: boolean } | undefined, callback: LookupCallback): void => {
        const answer: Parameters<LookupCallback> = lookupOptions?.all === true ? [null, [pinned]] : [null, pinned.address, pinned.family];
        callback(...answer);
    };
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const requestOptions: https.RequestOptions = {
        method:  'GET',
        agent:   false,
        lookup,
        signal:  AbortSignal.timeout(options.timeoutMs ?? 30_000),
        headers: { Accept: ACCEPT[options.accept], 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
        ...url.protocol === 'https:' && isIP(host) === 0 ? { servername: host } : {},
    };
    return new Promise((resolve, reject) => {
        const request = transport(url, requestOptions, resolve);
        request.on('error', reject);
        request.end();
    });
}

function mediaType(header: string | undefined): string | undefined {
    const value = header?.split(';')[0]!.trim().toLowerCase();
    return value === '' ? undefined : value;
}

/** Magic first, then the content type. */
function decideKind(head: Uint8Array, contentType: string | undefined, url: string, accept: UrlFetchOptions['accept']): FetchedKind {
    if(new TextDecoder().decode(head.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC) {
        return 'pdf';
    }
    if(accept === 'pdf') {
        throw new ZoteroFileError(`${url} is not a PDF (${contentType ?? 'no content type'})`, { reason: 'not_pdf' });
    }
    if(contentType !== undefined && HTML_TYPES.has(contentType)) {
        return 'html';
    }
    throw failed(url, `unsupported content-type ${contentType ?? '(none)'}`);
}

function tooLarge(url: string, limit: number): ZoteroFileError {
    return new ZoteroFileError(`The PDF at ${url} is larger than the ${limit}-byte limit (the browser download cap)`, { reason: 'too_large', limit });
}

async function readBody(response: http.IncomingMessage, url: string, options: UrlFetchOptions): Promise<UrlFetchResult> {
    const contentType = mediaType(response.headers['content-type']);
    const declared = Number(response.headers['content-length']);
    if(contentType === 'application/pdf' && declared > options.maxPdfBytes) {
        response.destroy();
        throw tooLarge(url, options.maxPdfBytes);
    }

    let streamed: Streamed;
    try {
        streamed = await streamCapped(response, url, contentType, options);
    } catch (error) {
        throw transportFailure(url, error);
    } finally {
        response.destroy();
    }

    const { bytes } = streamed;
    const kind = streamed.kind ?? decideKind(bytes, contentType, url, options.accept);
    if(kind === 'html' && bytes.length > options.maxHtmlBytes) {
        return { finalUrl: url, kind, bytes: bytes.subarray(0, options.maxHtmlBytes), truncated: true };
    }
    return { finalUrl: url, kind, bytes, truncated: false };
}

/**
 * Reads the body, deciding its kind as soon as the magic bytes are in: HTML stops one byte past
 * its cap (so truncation is known), and a PDF past its cap is an error.
 */
async function streamCapped(response: http.IncomingMessage, url: string, contentType: string | undefined, options: UrlFetchOptions): Promise<Streamed> {
    const chunks: Buffer[] = [];
    let total = 0;
    let kind: FetchedKind | undefined;
    for await (const chunk of response as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        total += chunk.length;
        if(kind === undefined && total >= PDF_MAGIC.length) {
            kind = decideKind(Buffer.concat(chunks), contentType, url, options.accept);
        }
        if(kind === 'html' && total > options.maxHtmlBytes) {
            break;
        }
        if(kind === 'pdf' && total > options.maxPdfBytes) {
            throw tooLarge(url, options.maxPdfBytes);
        }
    }
    return { bytes: Buffer.concat(chunks), kind };
}

/**
 * Fetches `url` under the browser host policy, following at most five redirects, each validated,
 * resolved once and pinned. Throws `ZoteroUrlFetchError` (refused or failed) or `ZoteroFileError`
 * (`too_large`, `not_pdf`).
 */
export async function fetchUnderHostPolicy(url: string, options: UrlFetchOptions): Promise<UrlFetchResult> {
    let current = url;
    for(let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const validated = validateUrl(current, options.policy);
        if(!validated.ok) {
            throw refused(current, validated.reason);
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: each hop depends on the previous redirect
        const pinned = await pinHost(validated.url, options);
        let response: http.IncomingMessage;
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential: each hop depends on the previous redirect
            response = await send(validated.url, pinned, options);
        } catch (error) {
            throw transportFailure(current, error);
        }

        const status = response.statusCode ?? 0;
        if(REDIRECTS.has(status)) {
            const location = response.headers.location;
            response.destroy();
            if(location === undefined) {
                throw failed(current, 'redirect without a Location', status);
            }
            current = new URL(location, current).href;
            continue;
        }
        if(status < 200 || status > 299) {
            response.destroy();
            throw failed(current, `HTTP ${status}`, status);
        }
        return readBody(response, current, options);
    }
    throw failed(url, 'too many redirects');
}
