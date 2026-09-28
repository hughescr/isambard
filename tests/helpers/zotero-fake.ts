/**
 * Test doubles for the Zotero client (#157): a recording fetch, response builders and a fake
 * clock whose sleep advances time instantly. No network, no real timers.
 */
import type { FetchLike } from '@/integrations/zotero/types';

export const TEST_API_KEY = 'test-zotero-api-key-0123456789abcdef';
export const API = 'https://api.zotero.org';
export const LIBRARY = `${API}/groups/6692257`;

/** One request the fake fetch saw. */
export interface RecordedCall {
    url:       string
    method:    string
    headers:   Headers
    /** A string body as sent, or the decoded text of a binary body. */
    bodyText:  string | undefined
    bodyBytes: Uint8Array | undefined
    init:      RequestInit
    /** The fake clock's time when the request was sent. */
    at:        number
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeClock {
    now:     () => number
    sleep:   (ms: number) => Promise<void>
    sleeps:  number[]
    advance: (ms: number) => void
}

/** A clock that starts at 0; `sleep(ms)` records `ms`, advances time and resolves at once. */
export function fakeClock(onSleep?: (ms: number) => Promise<void> | void): FakeClock {
    let time = 0;
    const sleeps: number[] = [];
    return {
        now:   () => time,
        sleep: async (ms: number) => {
            sleeps.push(ms);
            time += ms;
            await onSleep?.(ms);
        },
        sleeps,
        advance: (ms: number) => {
            time += ms;
        },
    };
}

/** A fetch that records every call and answers with `handler`. */
export function recordingFetch(handler: FakeHandler, clock?: FakeClock): { fetch: FetchLike, calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (input, init) => {
        let bodyText: string | undefined;
        let bodyBytes: Uint8Array | undefined;
        if(typeof init.body === 'string') {
            bodyText = init.body;
        } else if(init.body instanceof Uint8Array) {
            bodyBytes = init.body;
            bodyText = new TextDecoder().decode(init.body);
        }
        const call: RecordedCall = {
            url:     input,
            method:  init.method ?? 'GET',
            headers: new Headers(init.headers),
            bodyText,
            bodyBytes,
            init,
            at:      clock?.now() ?? 0,
        };
        calls.push(call);
        return handler(call);
    };
    return { fetch, calls };
}

/** A JSON response with optional status and headers. */
export function json(body: unknown, init: { status?: number, headers?: Record<string, string> } = {}): Response {
    return Response.json(body, {
        status:  init.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...init.headers },
    });
}

/** A plain-text (or empty) response with a status and optional headers. */
export function status(code: number, body = '', headers: Record<string, string> = {}): Response {
    return new Response(code === 204 || code === 304 ? null : body, { status: code, headers });
}

/** A promise with its resolve function exposed. */
export function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    const { promise, resolve } = Promise.withResolvers<T>();
    return { promise, resolve };
}

/** A stored object in the fake library (item or collection). */
export interface FakeObject {
    key:     string
    version: number
    meta:    Record<string, unknown>
    data:    Record<string, unknown>
}

const KEY_ALPHABET = '23456789ABCDEFGHIJKLMNPQRSTUVWXYZ';

/** A valid-looking Zotero key for index `n` (8 characters from Zotero's alphabet). */
export function fakeKey(n: number): string {
    let value = n;
    let key = '';
    for(let i = 0; i < 8; i++) {
        key = KEY_ALPHABET[value % KEY_ALPHABET.length] + key;
        value = Math.floor(value / KEY_ALPHABET.length);
    }
    return key;
}

interface FakeWriteResult {
    kind:  'successful' | 'unchanged' | 'failed'
    key:   string
    value: Record<string, unknown>
}

/** Answers a call before the fake library does; `undefined` falls through to the library. */
export type FakeOverride = (call: RecordedCall) => Response | Promise<Response | undefined> | undefined;

function dateAddedOf(object: FakeObject): string {
    return typeof object.data.dateAdded === 'string' ? object.data.dateAdded : '';
}

/** JSON with top-level keys sorted, so field order does not affect equality. */
function sortedJson(object: Record<string, unknown>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(object).toSorted(([a], [b]) => a.localeCompare(b))));
}

function isDeleted(data: Record<string, unknown>): boolean {
    return data.deleted === true || data.deleted === 1;
}

/**
 * An in-memory group library that answers the Web API calls the client makes, including Zotero's
 * default `limit` of 25 when none is sent. `override` can answer any call first (to inject faults).
 */
export class FakeZoteroServer {
    items = new Map<string, FakeObject>();
    collections = new Map<string, FakeObject>();
    templates = new Map<string, Record<string, unknown>>();
    libraryVersion = 1;
    writeTokens: string[] = [];
    override:    FakeOverride | undefined;
    #created = 0;

    readonly clock = fakeClock();
    readonly recorder = recordingFetch(async call => this.handle(call), this.clock);

    get fetch(): FetchLike {
        return this.recorder.fetch;
    }

    get calls(): RecordedCall[] {
        return this.recorder.calls;
    }

    /** Adds an item; `data` gets `key`/`version` filled in. */
    addItem(data: Record<string, unknown>, meta: Record<string, unknown> = {}): FakeObject {
        const key = typeof data.key === 'string' ? data.key : fakeKey(1000 + this.items.size);
        const version = typeof data.version === 'number' ? data.version : this.libraryVersion;
        const item = { key, version, meta, data: { itemType: 'journalArticle', ...data, key, version } };
        this.items.set(key, item);
        return item;
    }

    addCollection(data: Record<string, unknown>, meta: Record<string, unknown> = {}): FakeObject {
        const key = typeof data.key === 'string' ? data.key : fakeKey(5000 + this.collections.size);
        const version = typeof data.version === 'number' ? data.version : this.libraryVersion;
        const collection = { key, version, meta, data: { name: 'C', parentCollection: false, ...data, key, version } };
        this.collections.set(key, collection);
        return collection;
    }

    async handle(call: RecordedCall): Promise<Response> {
        const overridden = await this.override?.(call);
        if(overridden) {
            return overridden;
        }
        const url = new URL(call.url);
        if(url.pathname === '/items/new') {
            const template = this.templates.get(url.searchParams.get('itemType') ?? '');
            return template ? json(template) : status(400, 'Invalid item type');
        }
        const path = url.pathname.replace('/groups/6692257', '');
        if(call.method === 'POST' && (path === '/items' || path === '/collections')) {
            return this.#write(call, path === '/items' ? this.items : this.collections, path === '/items');
        }
        if(call.method !== 'GET') {
            return status(405);
        }
        return this.#read(path, url.searchParams);
    }

    #page(objects: FakeObject[], params: URLSearchParams): Response {
        const limit = Math.min(Number(params.get('limit') ?? '25'), 100);
        const start = Number(params.get('start') ?? '0');
        return json(objects.slice(start, start + limit), {
            headers: { 'Total-Results': String(objects.length), 'Last-Modified-Version': String(this.libraryVersion) },
        });
    }

    #read(path: string, params: URLSearchParams): Response {
        const withTrash = params.get('includeTrashed') === '1';
        const visible = (objects: Iterable<FakeObject>) => [...objects].filter(o => withTrash || !isDeleted(o.data));
        if(path === '/items') {
            const keys = params.get('itemKey')?.split(',');
            return this.#page(visible(this.items.values()).filter(o => !keys || keys.includes(o.key)), params);
        }
        if(path === '/items/top') {
            const top = visible(this.items.values()).filter(o => o.data.parentItem === undefined);
            if(params.get('sort') === 'dateAdded') {
                top.sort((a, b) => dateAddedOf(a).localeCompare(dateAddedOf(b)));
            }
            return this.#page(top, params);
        }
        if(path === '/items/trash') {
            return this.#page([...this.items.values()].filter(o => isDeleted(o.data)), params);
        }
        const inCollection = /^\/collections\/([^/]+)\/items\/top$/.exec(path);
        if(inCollection) {
            const collectionKey = inCollection[1];
            return this.#page(visible(this.items.values()).filter(o => o.data.parentItem === undefined && (o.data.collections as string[] | undefined)?.includes(collectionKey)), params);
        }
        const children = /^\/items\/([^/]+)\/children$/.exec(path);
        if(children) {
            const parentKey = children[1];
            return this.#page(visible(this.items.values()).filter(o => o.data.parentItem === parentKey), params);
        }
        if(path === '/collections') {
            const keys = params.get('collectionKey')?.split(',');
            return this.#page(visible(this.collections.values()).filter(o => !keys || keys.includes(o.key)), params);
        }
        return status(404, 'Not found');
    }

    #writeOne(object: Record<string, unknown>, store: Map<string, FakeObject>, isItems: boolean, newVersion: number): FakeWriteResult {
        const key = typeof object.key === 'string' ? object.key : undefined;
        const existing = key === undefined ? undefined : store.get(key);
        if(key !== undefined && !existing) {
            return { kind: 'failed', key, value: { key, code: 404, message: 'Not found' } };
        }
        if(existing) {
            if(object.version !== existing.version) {
                return { kind: 'failed', key: existing.key, value: { key: existing.key, code: 412, message: `Object has been modified since version ${String(object.version)}` } };
            }
            const { version: _v, ...rest } = object;
            const { version: _ev, ...existingRest } = existing.data;
            if(sortedJson(rest) === sortedJson(existingRest)) {
                return { kind: 'unchanged', key: existing.key, value: {} };
            }
            existing.version = newVersion;
            existing.data = { ...object, key: existing.key, version: newVersion };
            return { kind: 'successful', key: existing.key, value: { key: existing.key, version: newVersion, data: existing.data } };
        }
        this.#created++;
        const newKey = fakeKey(isItems ? 20_000 + this.#created : 30_000 + this.#created);
        const created = { key: newKey, version: newVersion, meta: {}, data: { ...object, key: newKey, version: newVersion } };
        store.set(newKey, created);
        return { kind: 'successful', key: newKey, value: { key: newKey, version: newVersion, data: created.data } };
    }

    #write(call: RecordedCall, store: Map<string, FakeObject>, isItems: boolean): Response {
        this.writeTokens.push(call.headers.get('Zotero-Write-Token') ?? '');
        const objects = JSON.parse(call.bodyText ?? '[]') as Record<string, unknown>[];
        const newVersion = this.libraryVersion + 1;
        const successful: Record<string, unknown> = {};
        const unchanged: Record<string, string> = {};
        const failed: Record<string, unknown> = {};
        for(const [index, object] of objects.entries()) {
            const result = this.#writeOne(object, store, isItems, newVersion);
            if(result.kind === 'failed') {
                failed[index] = result.value;
            } else if(result.kind === 'unchanged') {
                unchanged[index] = result.key;
            } else {
                successful[index] = result.value;
            }
        }
        if(Object.keys(successful).length > 0) {
            this.libraryVersion = newVersion;
        }
        return json({ successful, unchanged, failed }, { headers: { 'Last-Modified-Version': String(this.libraryVersion) } });
    }
}
