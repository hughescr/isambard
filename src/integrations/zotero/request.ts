/**
 * HTTP core for the Zotero Web API v3 (#157, design §4.1).
 *
 * - **Library pinning.** Every API URL is `<baseUrl>/groups/<groupId><path>`, with the prefix
 *   computed once from a validated positive integer, or the one global schema endpoint
 *   `/items/new`. There is no code path that builds `/users/...`, and there is no DELETE or PUT verb:
 *   the method type excludes them and a runtime guard rejects them through a cast.
 * - **Headers.** `Zotero-API-Key`, `Zotero-API-Version: 3` and a `User-Agent` on every API call. The
 *   key never appears in a log, an error message or an error context: errors are built from the
 *   status, the library-relative path and the response body only. Requests to a storage host
 *   (`external`) carry no Zotero header at all.
 * - **One shared deadline.** `Backoff` (any response) and `Retry-After` (429/503) extend a single
 *   not-before time and never shorten it. A gate runs immediately before every send, retries and
 *   concurrent requests included; if the remaining wait exceeds `maxWaitMs` the call fails fast with
 *   `ZoteroRateLimitError({ overBudget: true })` instead of sleeping.
 * - **Retry.** `retryAsync` with its default policy (3 attempts, 1 s base, 30 s cap). Within-budget
 *   rate limits are retried for every method (the server did not process the request) with no
 *   `retryAfterMs` hint, so the gate does the waiting. Server errors, timeouts and network failures
 *   are retried only for idempotent requests: a retried write after an unseen success would fail or
 *   show a false conflict.
 */

import type { z } from 'zod';
import type { FetchLike } from './types';
import {
    InvariantViolationError,
    ZoteroAuthError,
    ZoteroError,
    ZoteroNotFoundError,
    ZoteroQuotaError,
    ZoteroRateLimitError,
    ZoteroServerError,
    ZoteroVersionConflictError
} from '@/errors';
import { retryAsync, type ErrorClassification } from '@/utils';

export interface ZoteroRequestDeps {
    apiKey:            string
    groupId:           number
    /** Default `https://api.zotero.org`. */
    baseUrl?:          string
    fetch?:            FetchLike
    sleep?:            (ms: number) => Promise<void>
    now?:              () => number
    /** Default 30 s. */
    requestTimeoutMs?: number
    /** Default 120 s, for file transfers. */
    fileTimeoutMs?:    number
    /** Default 60 s: a longer Backoff/Retry-After fails fast instead of waiting. */
    maxWaitMs?:        number
    /** Test seam for the abort signal; default `AbortSignal.timeout`. */
    timeoutSignal?:    (ms: number) => AbortSignal
}

/** The only verbs the client has. There is deliberately no PUT and no DELETE. */
export type ZoteroMethod = 'GET' | 'POST' | 'PATCH';

/** A library-relative path (appended to `/groups/<id>`), or the one global schema endpoint. */
export type ZoteroTarget = { scope: 'library', path: string } | { scope: 'schema', path: '/items/new' };

export interface ZoteroRequestOptions<T = unknown> {
    query?:     Record<string, string | number | string[]>
    json?:      unknown
    form?:      Record<string, string>
    headers?:   Record<string, string>
    /** Safe to repeat after an ambiguous failure (reads, and nothing else). */
    idempotent: boolean
    /** A file transfer: uses the longer file timeout. */
    file?:      boolean
    schema?:    z.ZodType<T>
}

export interface ZoteroResponse<T = unknown> {
    status:          number
    headers:         Headers
    libraryVersion?: number
    totalResults?:   number
    body:            T
}

const ALLOWED_METHODS = new Set<string>(['GET', 'POST', 'PATCH']);
const USER_AGENT = 'Isambard (+https://github.com/hughescr/isambard)';
const DEFAULT_RATE_LIMIT_WAIT_MS = 1000;
const MAX_ERROR_BODY_CHARS = 500;
const AMBIGUOUS_WRITE = '; the write may or may not have been applied, so re-read before retrying';

interface SendMeta {
    /** Library-relative path, or the storage host for external requests. Never contains the key. */
    label:           string
    idempotent:      boolean
    file:            boolean
    /** Map 4xx statuses to typed errors (API calls); external calls return them to the caller. */
    mapClientErrors: boolean
}

// Stryker disable all: production defaults only; tests always inject a fake fetch and a fake clock (no network and no real timers in tests)
async function realFetch(input: string, init: RequestInit): Promise<Response> {
    return fetch(input, init);
}

async function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
// Stryker restore all

/** A non-negative integer header value, or undefined. */
export function intHeader(headers: Headers, name: string): number | undefined {
    const value = headers.get(name);
    return value !== null && /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined;
}

async function bodyText(response: Response): Promise<string> {
    try {
        const text = await response.text();
        return text.slice(0, MAX_ERROR_BODY_CHARS);
    } catch{
        return '';
    }
}

export class ZoteroRequester {
    readonly #apiKey:           string;
    readonly #groupId:          number;
    readonly #libraryPrefix:    string;
    readonly #baseUrl:          string;
    readonly #fetch:            FetchLike;
    readonly #sleep:            (ms: number) => Promise<void>;
    readonly #now:              () => number;
    readonly #requestTimeoutMs: number;
    readonly #fileTimeoutMs:    number;
    readonly #maxWaitMs:        number;
    readonly #timeoutSignal:    (ms: number) => AbortSignal;
    /** Epoch ms before which no request may be sent (shared Backoff/Retry-After deadline). */
    #notBefore = 0;

    constructor(deps: ZoteroRequestDeps) {
        if(!Number.isSafeInteger(deps.groupId) || deps.groupId <= 0) {
            throw new InvariantViolationError('ZoteroRequester', `groupId must be a positive integer, got ${deps.groupId}`);
        }
        this.#apiKey = deps.apiKey;
        this.#groupId = deps.groupId;
        this.#libraryPrefix = `/groups/${deps.groupId}`;
        this.#baseUrl = deps.baseUrl ?? 'https://api.zotero.org';
        this.#fetch = deps.fetch ?? realFetch;
        this.#sleep = deps.sleep ?? realSleep;
        this.#now = deps.now ?? (() => Date.now());
        this.#requestTimeoutMs = deps.requestTimeoutMs ?? 30_000;
        this.#fileTimeoutMs = deps.fileTimeoutMs ?? 120_000;
        this.#maxWaitMs = deps.maxWaitMs ?? 60_000;
        this.#timeoutSignal = deps.timeoutSignal ?? (ms => AbortSignal.timeout(ms));
    }

    /** The one group library this requester can reach. */
    get groupId(): number {
        return this.#groupId;
    }

    /** An API request whose JSON body is parsed (and checked against `schema` when given). */
    async request<T = unknown>(method: ZoteroMethod, target: ZoteroTarget, options: ZoteroRequestOptions<T>): Promise<ZoteroResponse<T>> {
        const response = await this.requestRaw(method, target, options);
        const body = await this.#parse(response, target.path, options.schema);
        const libraryVersion = intHeader(response.headers, 'Last-Modified-Version');
        const totalResults = intHeader(response.headers, 'Total-Results');
        return {
            status:  response.status,
            headers: response.headers,
            ...libraryVersion === undefined ? {} : { libraryVersion },
            ...totalResults === undefined ? {} : { totalResults },
            body,
        };
    }

    /** An API request whose response is returned unread (for file downloads). Error statuses are still mapped. */
    async requestRaw(
        method: ZoteroMethod,
        target: ZoteroTarget,
        options: Omit<ZoteroRequestOptions, 'schema'> & { redirect?: RequestRedirect }
    ): Promise<Response> {
        if(!ALLOWED_METHODS.has(method)) {
            throw new InvariantViolationError('ZoteroRequester', `method ${method} is not allowed`);
        }
        const url = this.#url(target, options.query);
        const headers: Record<string, string> = {
            ...options.headers,
            'Zotero-API-Key':     this.#apiKey,
            'Zotero-API-Version': '3',
            'User-Agent':         USER_AGENT,
        };
        let body: string | undefined;
        if(options.json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(options.json);
        } else if(options.form !== undefined) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            body = new URLSearchParams(options.form).toString();
        }
        return this.#send(url, { method, headers, body, redirect: options.redirect ?? 'follow' }, {
            label:           target.path,
            idempotent:      options.idempotent,
            file:            options.file ?? false,
            mapClientErrors: true,
        });
    }

    /**
     * A request to a storage host (upload target or download redirect), sent with no Zotero header so
     * the key never leaves api.zotero.org. Only https is allowed. Rate limits and server errors are
     * handled as for API calls; other statuses are returned for the caller to judge.
     */
    async external(
        method: 'GET' | 'POST',
        url: string,
        options: { idempotent: boolean, headers?: Record<string, string>, body?: Uint8Array<ArrayBuffer> }
    ): Promise<Response> {
        const parsed = URL.canParse(url) ? new URL(url) : undefined;
        if(parsed?.protocol !== 'https:') {
            throw new InvariantViolationError('ZoteroRequester.external', 'storage URLs must be absolute https URLs');
        }
        return this.#send(url, { method, headers: options.headers, body: options.body, redirect: 'follow' }, {
            label:           parsed.host,
            idempotent:      options.idempotent,
            file:            true,
            mapClientErrors: false,
        });
    }

    #url(target: ZoteroTarget, query: ZoteroRequestOptions['query']): string {
        let prefix: string;
        if(target.scope === 'library') {
            prefix = this.#libraryPrefix;
            if(!target.path.startsWith('/') || target.path.includes('..') || target.path.includes('://')) {
                throw new InvariantViolationError('ZoteroRequester', `invalid library path ${JSON.stringify(target.path)}`);
            }
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime guard: a cast can smuggle in any scope or path, and only /items/new is global
        } else if(target.scope === 'schema' && target.path === '/items/new') {
            prefix = '';
        } else {
            throw new InvariantViolationError('ZoteroRequester', 'only the group library and /items/new may be requested');
        }
        const url = new URL(`${this.#baseUrl}${prefix}${target.path}`);
        for(const [name, value] of Object.entries(query ?? {})) {
            for(const item of Array.isArray(value) ? value : [value]) {
                url.searchParams.append(name, String(item));
            }
        }
        return url.href;
    }

    async #send(url: string, init: RequestInit, meta: SendMeta): Promise<Response> {
        return retryAsync(() => this.#attempt(url, init, meta), {
            classifier: error => this.#classify(error, meta.idempotent),
            deps:       { sleep: this.#sleep, now: this.#now },
        });
    }

    #classify(error: unknown, idempotent: boolean): ErrorClassification {
        // retryAsync only logs the message, and the no-op default logger drops it.
        const message = String(error);
        if(error instanceof ZoteroRateLimitError) {
            return { category: error.overBudget ? 'permanent' : 'rate_limited', message };
        }
        if(error instanceof ZoteroServerError && idempotent) {
            return { category: 'transient', message };
        }
        return { category: 'permanent', message };
    }

    /** Extends the shared deadline to at least `now + ms`; never shortens it. */
    #extend(ms: number): void {
        this.#notBefore = Math.max(this.#notBefore, this.#now() + ms);
    }

    async #gate(label: string): Promise<void> {
        for(;;) {
            const gap = this.#notBefore - this.#now();
            if(gap <= 0) {
                return;
            }
            if(gap > this.#maxWaitMs) {
                throw new ZoteroRateLimitError(
                    `Zotero asked us to wait ~${Math.ceil(gap / 1000)}s before the next request to ${label}; try again later`,
                    { retryAfterMs: gap, overBudget: true }
                );
            }
            // eslint-disable-next-line no-await-in-loop -- sequential: the deadline may move while we sleep, so re-check after each wait
            await this.#sleep(gap);
        }
    }

    async #attempt(url: string, init: RequestInit, meta: SendMeta): Promise<Response> {
        await this.#gate(meta.label);
        const timeoutMs = meta.file ? this.#fileTimeoutMs : this.#requestTimeoutMs;
        let response: Response;
        try {
            response = await this.#fetch(url, { ...init, signal: this.#timeoutSignal(timeoutMs) });
        } catch (error) {
            throw this.#transportError(error, meta, timeoutMs);
        }

        const backoffSeconds = intHeader(response.headers, 'Backoff');
        if(backoffSeconds !== undefined) {
            this.#extend(backoffSeconds * 1000);
        }
        if(response.status === 429 || response.status === 503) {
            const retryAfterSeconds = intHeader(response.headers, 'Retry-After');
            const waitMs = retryAfterSeconds === undefined ? DEFAULT_RATE_LIMIT_WAIT_MS : retryAfterSeconds * 1000;
            this.#extend(waitMs);
            await response.body?.cancel();
            throw new ZoteroRateLimitError(
                `Zotero rate-limited ${meta.label} (HTTP ${response.status}); retry after ~${Math.ceil(waitMs / 1000)}s`,
                { retryAfterMs: waitMs, overBudget: waitMs > this.#maxWaitMs }
            );
        }
        if(response.status >= 500 || (meta.mapClientErrors && response.status >= 400)) {
            throw await this.#statusError(response, meta);
        }
        return response;
    }

    #transportError(error: unknown, meta: SendMeta, timeoutMs: number): ZoteroServerError {
        const suffix = meta.idempotent ? '' : AMBIGUOUS_WRITE;
        if(error instanceof Error && error.name === 'TimeoutError') {
            return new ZoteroServerError(
                `Zotero request to ${meta.label} timed out after ${timeoutMs} ms${suffix}`,
                { timeout: true, idempotent: meta.idempotent, path: meta.label }
            );
        }
        const detail = error instanceof Error ? error.message : String(error);
        return new ZoteroServerError(`Zotero request to ${meta.label} failed: ${detail}${suffix}`, { idempotent: meta.idempotent, path: meta.label });
    }

    async #statusError(response: Response, meta: SendMeta): Promise<ZoteroError> {
        const { status } = response;
        const path = meta.label;
        const text = await bodyText(response);
        if(status === 401 || status === 403) {
            return new ZoteroAuthError(
                `Zotero refused access to ${path} (HTTP ${status}): the API key is invalid or cannot reach group ${this.#groupId}. ${text}`,
                { status, path }
            );
        }
        if(status === 404) {
            return new ZoteroNotFoundError(`Zotero has no such object: ${path}`, { path });
        }
        if(status === 412) {
            const currentVersion = intHeader(response.headers, 'Last-Modified-Version');
            return new ZoteroVersionConflictError(
                `Zotero rejected a version precondition on ${path} (HTTP 412): ${text}`,
                currentVersion === undefined ? { path } : { currentVersion, path }
            );
        }
        if(status === 413) {
            return new ZoteroQuotaError('Zotero storage is full or the file exceeds the plan limit; Craig owns the storage plan (HTTP 413)', { status, path });
        }
        if(status >= 500 || status === 409) {
            return new ZoteroServerError(
                `Zotero server error on ${path} (HTTP ${status}): ${text}${meta.idempotent ? '' : AMBIGUOUS_WRITE}`,
                { status, idempotent: meta.idempotent, path }
            );
        }
        return new ZoteroError(`Zotero rejected the request to ${path} (HTTP ${status}): ${text}`, undefined, { status, path });
    }

    async #parse<T>(response: Response, path: string, schema: z.ZodType<T> | undefined): Promise<T> {
        const text = await response.text();
        let parsed: unknown;
        if(text !== '') {
            try {
                parsed = JSON.parse(text);
            } catch{
                throw new ZoteroError(`unexpected Zotero response shape from ${path} (not JSON)`, undefined, { path });
            }
        }
        if(schema === undefined) {
            return parsed as T;
        }
        const result = schema.safeParse(parsed);
        if(!result.success) {
            throw new ZoteroError(`unexpected Zotero response shape from ${path}`, undefined, { path });
        }
        return result.data;
    }
}
