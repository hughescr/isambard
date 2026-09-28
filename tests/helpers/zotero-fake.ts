/**
 * Test doubles for the Zotero client (#157): a recording fetch, response builders and a fake
 * clock whose sleep advances time instantly. No network, no real timers.
 */
import { createHash } from 'node:crypto';
import { ZoteroClient } from '@/integrations/zotero/client';
import type { FetchLike } from '@/integrations/zotero/types';

export const TEST_API_KEY = 'test-zotero-api-key-0123456789abcdef';
export const API = 'https://api.zotero.org';
export const LIBRARY = `${API}/groups/6692257`;
/** The fake storage host the fake library uploads to and downloads from. */
export const STORAGE = 'https://storage.test';

/** A real client talking to `server` with the fake clock. */
export function clientFor(server: FakeZoteroServer): ZoteroClient {
    return new ZoteroClient({
        apiKey:        TEST_API_KEY,
        groupId:       6_692_257,
        fetch:         server.fetch,
        sleep:         server.clock.sleep,
        now:           server.clock.now,
        timeoutSignal: () => new AbortController().signal,
    });
}

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

// What Zotero accepts for accessDate: a plain date, a UTC "date time", ISO 8601 with no fractional seconds
// (Zotero rejects `Date.toISOString()`'s milliseconds), or CURRENT_TIMESTAMP; an empty string clears the field.
const ACCEPTED_ACCESS_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}Z?)?$/;

function acceptedAccessDate(accessDate: unknown): boolean {
    return typeof accessDate === 'string' && (accessDate === '' || accessDate === 'CURRENT_TIMESTAMP' || ACCEPTED_ACCESS_DATE.test(accessDate));
}

/** The failure Zotero reports for a badly formatted accessDate, or `undefined` when it is acceptable or absent. */
function accessDateFailure(object: Record<string, unknown>): FakeWriteResult | undefined {
    const { accessDate } = object;
    if(accessDate === undefined || acceptedAccessDate(accessDate)) {
        return undefined;
    }
    const key = typeof object.key === 'string' ? object.key : undefined;
    const shown = typeof accessDate === 'string' ? accessDate : JSON.stringify(accessDate);
    const message = `'accessDate' must be in ISO 8601 or UTC 'YYYY-MM-DD[ hh:mm:ss]' format or 'CURRENT_TIMESTAMP' (${shown})`;
    return { kind: 'failed', key: key ?? '', value: { ...key === undefined ? {} : { key }, code: 400, message } };
}

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
    /** Stored attachment files by attachment key. */
    files = new Map<string, Uint8Array>();
    #uploads = new Map<string, { md5: string, bytes?: Uint8Array }>();
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
        return this.respond(call);
    }

    /** Answers `call` as the library would, bypassing `override` (so an override can delegate and then fault). */
    respond(call: RecordedCall): Response {
        if(call.url.startsWith(`${STORAGE}/`)) {
            return this.#storage(call);
        }
        const url = new URL(call.url);
        if(url.pathname === '/items/new') {
            const template = this.templates.get(url.searchParams.get('itemType') ?? '');
            return template ? json(template) : status(400, 'Invalid item type');
        }
        const path = url.pathname.replace('/groups/6692257', '');
        const file = /^\/items\/([^/]+)\/file$/.exec(path);
        if(file) {
            return this.#file(call, file[1]);
        }
        if(call.method === 'POST' && (path === '/items' || path === '/collections')) {
            return this.#write(call, path === '/items' ? this.items : this.collections, path === '/items');
        }
        if(call.method !== 'GET') {
            return status(405);
        }
        return this.#read(path, url.searchParams);
    }

    /** Stores a file for an existing attachment item, as if it had been uploaded, and sets its md5. */
    storeFile(key: string, bytes: Uint8Array): void {
        const item = this.items.get(key)!;
        this.files.set(key, bytes);
        // eslint-disable-next-line sonarjs/hashing -- the md5 Zotero's file protocol uses as a content identity
        item.data.md5 = createHash('md5').update(bytes).digest('hex');
    }

    /** `/items/<key>/file`: GET redirects to storage; POST authorises (If-None-Match: *) or registers an upload. */
    #file(call: RecordedCall, key: string): Response {
        const item = this.items.get(key);
        if(!item) {
            return status(404, 'Item not found');
        }
        if(call.method === 'GET') {
            return this.files.has(key) ? status(302, '', { Location: `${STORAGE}/download/${key}` }) : status(404, 'File not found');
        }
        const form = new URLSearchParams(call.bodyText);
        const uploadKey = form.get('upload');
        if(uploadKey !== null) {
            const pending = this.#uploads.get(uploadKey);
            if(pending?.bytes === undefined) {
                return status(400, 'Upload not found');
            }
            this.libraryVersion++;
            this.files.set(key, pending.bytes);
            item.version = this.libraryVersion;
            item.data = { ...item.data, md5: pending.md5, version: this.libraryVersion };
            return status(204);
        }
        if(typeof item.data.md5 === 'string') {
            return status(412, 'If-None-Match: * set but file exists');
        }
        const newUploadKey = `UP${key}`;
        this.#uploads.set(newUploadKey, { md5: form.get('md5') ?? '' });
        return json({ url: `${STORAGE}/upload/${newUploadKey}`, contentType: 'application/pdf', prefix: '', suffix: '', uploadKey: newUploadKey });
    }

    #storage(call: RecordedCall): Response {
        const [, kind, id] = new URL(call.url).pathname.split('/');
        if(kind === 'upload' && call.method === 'POST') {
            const pending = this.#uploads.get(id);
            if(pending === undefined) {
                return status(404);
            }
            pending.bytes = call.bodyBytes;
            return status(201);
        }
        const bytes = this.files.get(id);
        if(kind !== 'download' || bytes === undefined) {
            return status(404);
        }
        const contentType = this.items.get(id)?.data.contentType;
        return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: { 'Content-Type': typeof contentType === 'string' ? contentType : 'application/octet-stream' } });
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
            // Like Zotero, an update without dateModified is stamped with the server's time. The stamp is
            // only added to fixtures that carry a dateModified, so minimal fixtures stay minimal.
            const stampsDate = object.dateModified === undefined && existing.data.dateModified !== undefined;
            const { version: _v, ...rest } = object;
            const { version: _ev, ...existingRest } = existing.data;
            if(stampsDate) {
                delete existingRest.dateModified;
            }
            if(sortedJson(rest) === sortedJson(existingRest)) {
                return { kind: 'unchanged', key: existing.key, value: {} };
            }
            existing.version = newVersion;
            existing.data = { ...object, key: existing.key, version: newVersion, ...stampsDate ? { dateModified: new Date(this.clock.now()).toISOString() } : {} };
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
            const result = (isItems ? accessDateFailure(object) : undefined) ?? this.#writeOne(object, store, isItems, newVersion);
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
