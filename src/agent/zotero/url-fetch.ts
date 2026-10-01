/**
 * Fetching arbitrary URLs for the Zotero tools under the browser tool's own host policy (#157,
 * design §6.1). There is no second policy: every hop goes through `validateUrl`, and every DNS
 * answer through `checkResolvedAddress`, which applies the same range logic to the canonical form
 * of the address.
 *
 * DNS rebinding is closed by resolving each hop exactly once and pinning the connection, through
 * `node:http(s)`'s `lookup` option (Bun's `fetch` cannot pin), to the validated canonical answers;
 * the transport's connect fallback chooses among them, so an unusable IPv6 answer can fall back to
 * IPv4 while connecting. Nothing is re-sent once a connection is established. TLS still verifies the
 * original hostname. Only the host policy is shared with the browser: Zotero owns the byte caps,
 * truncating HTML at its page cap and refusing PDFs over its configured file-size cap.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, isIPv6 } from 'node:net';
import { checkResolvedAddress, validateUrl, type BrowserHostPolicy } from '../browser';
import { ZoteroError, ZoteroFileError, ZoteroUrlFetchError } from '@/errors';

/** Zotero's fixed HTML read cap; PDF fetches instead use `maxStoredFileBytes`. */
export const ZOTERO_MAX_PAGE_BYTES = 1_048_576;

export interface UrlFetchOptions {
    /** Host policy shared with the browser; the byte caps below belong to Zotero. */
    policy:        BrowserHostPolicy
    /** `pdf`: anything else is `not_pdf`. `html-or-pdf`: a page or a PDF. */
    accept:        'pdf' | 'html-or-pdf'
    /** HTML is read up to this many bytes and then truncated (Zotero's page cap). */
    maxHtmlBytes:  number
    /** A PDF over this many bytes is an error (Zotero's configured file-size cap). */
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

/** A hop's checked canonical answers, in resolver order; never empty. */
type PinnedAnswers = [Pinned, ...Pinned[]];

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

/**
 * Why a transport `Error` failed: its message, else its string `code` (Bun reports a connect that
 * failed on every pinned answer as `ECONNREFUSED` with an empty message), else a generic reason.
 */
function connectReason(error: Error): string {
    if(error.message !== '') {
        return error.message;
    }
    const { code } = error as { code?: unknown };
    return typeof code === 'string' && code !== '' ? code : 'connection failed';
}

/** A socket, timeout or stream failure as a fetch error; our own typed errors pass through. */
function transportFailure(url: string, error: unknown): ZoteroError {
    if(error instanceof ZoteroError) {
        return error;
    }
    if(!(error instanceof Error)) {
        return failed(url, String(error));
    }
    const timedOut = error.name === 'AbortError' || error.name === 'TimeoutError';
    return failed(url, timedOut ? 'timed out' : connectReason(error));
}

/**
 * The URL's host without an IPv6 literal's brackets (`new URL()` keeps them in `hostname`). A
 * hostname is a bracketed literal exactly when what lies between its first and last characters is
 * an IPv6 address; any other hostname cannot contain ':' and is returned as written.
 */
function bareHost(url: URL): string {
    const inner = url.hostname.slice(1, -1);
    return isIPv6(inner) ? inner : url.hostname;
}

/**
 * The hop's single resolution with every answer checked. All the checked canonical answers are
 * pinned, in resolver order (duplicates kept); any blocked or malformed answer refuses the whole
 * hop. The result is never empty: a resolver with no answers is refused here.
 */
async function pinHost(url: URL, options: UrlFetchOptions): Promise<PinnedAnswers> {
    const host = bareHost(url);
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

    const check = options.checkAddress ?? checkResolvedAddress;
    const pin = (answer: { address: string }): Pinned => {
        const result = check(answer.address);
        if(!result.ok) {
            throw result.reason === 'resolver returned a malformed address'
                ? refused(url.href, result.reason)
                : refused(url.href, 'resolves to a blocked address', result.reason);
        }
        return { address: result.address, family: result.family };
    };
    const [first, ...rest] = answers;
    if(first === undefined) {
        throw refused(url.href, 'host has no addresses');
    }
    return [pin(first), ...rest.map(answer => pin(answer))];
}

async function send(url: URL, pinned: PinnedAnswers, options: UrlFetchOptions): Promise<http.IncomingMessage> {
    const transports = options.request ?? realRequest;
    const transport = url.protocol === 'https:' ? transports.https : transports.http;
    // Every lookup the transport makes gets only the validated answers; nothing resolves the host
    // again. An all-addresses lookup gets all of them, so the runtime's connect-phase fallback (for
    // example from an unusable IPv6 answer to IPv4) chooses among them; a single lookup gets the first.
    const [first] = pinned;
    const lookup = (_host: string, lookupOptions: { all?: boolean } | undefined, callback: LookupCallback): void => {
        const answer: Parameters<LookupCallback> = lookupOptions?.all === true ? [null, pinned] : [null, first.address, first.family];
        callback(...answer);
    };
    const host = bareHost(url);
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
    if(header === undefined) {
        return undefined;
    }
    // Stryker disable next-line StringLiteral: String.split(';') on a defined string always returns a non-empty array, so index 0 is never undefined; the ?? '' only satisfies noUncheckedIndexedAccess and can never itself execute
    const value = (header.split(';')[0] ?? '').trim().toLowerCase();
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
    return new ZoteroFileError(`The PDF at ${url} is larger than the ${limit}-byte limit (ZOTERO_MAX_STORED_FILE_BYTES)`, { reason: 'too_large', limit });
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
        if(total >= PDF_MAGIC.length) {
            // decideKind only ever looks at the fixed-size magic prefix plus contentType/accept, all of
            // which are invariant once total reaches PDF_MAGIC.length, so recomputing on every later chunk
            // would always reassign the same kind; ??= keeps the one call the original explicit
            // `kind === undefined` guard made, without a redundant second boolean condition.
            kind ??= decideKind(Buffer.concat(chunks), contentType, url, options.accept);
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
