/**
 * Zotero Web API v3 client for the shared group library (#157, design §4.2–§4.5).
 *
 * Every request goes through `ZoteroRequester`, which pins it to `/groups/<id>` and owns the shared
 * Backoff/Retry-After deadline, so one client is shared by both sessions.
 *
 * - **Reads never silently truncate.** Keyed reads send an explicit `limit=50` (Zotero's default is
 *   25) and check `Total-Results`; child and collection lists page to `Total-Results`; past a bound
 *   they throw rather than return part of the list.
 * - **Writes are batched.** Creates and updates are one `POST` per 50 objects, sequential (each write
 *   bumps the library version), each with a fresh `Zotero-Write-Token`. Per-object failures are
 *   returned, not thrown.
 * - **Updates are read-modify-write with per-object versions.** A caller-supplied expected version
 *   that no longer matches is a conflict with nothing written, and a 412 from Zotero is re-read and
 *   reported, never re-applied: Craig's edits are never overwritten blind. The written object omits
 *   `dateModified`, so Zotero stamps the edit time.
 * - **Deletion is the trash flag only.** There is no DELETE verb anywhere in the client.
 * - **Files.** Uploads use Zotero's authorise/upload/register flow with `If-None-Match: *`;
 *   downloads follow the storage redirect by hand so the API key never reaches the storage host.
 */

import { createHash, randomBytes } from 'node:crypto';
import pLimit from 'p-limit';
import type { z } from 'zod';
import type { NewItemData } from './item-fields';
import { ZoteroRequester, intHeader, type ZoteroRequestDeps, type ZoteroResponse } from './request';
import {
    zoteroCollectionListSchema,
    zoteroItemListSchema,
    zoteroTemplateSchema,
    zoteroUploadAuthorizationSchema,
    zoteroWriteResponseSchema,
    type ZoteroCollection,
    type ZoteroCollectionData,
    type ZoteroItem,
    type ZoteroItemData,
    type ZoteroWriteResponse
} from './types';
import {
    InvariantViolationError,
    ZoteroError,
    ZoteroFileError,
    ZoteroNotFoundError,
    ZoteroVersionConflictError
} from '@/errors';

/** Zotero object keys: 8 characters from Zotero's alphabet (no 0, 1 or O). */
export const ZOTERO_KEY_PATTERN = /^[2-9A-NP-Z]{8}$/;

const KEYED_CHUNK = 50;
const WRITE_CHUNK = 50;
const PAGE_SIZE = 100;
const MAX_CHILD_PAGES = 50;
const MAX_COLLECTION_PAGES = 50;
const MAX_SCAN_PAGES = 200;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface ZoteroClientDeps extends ZoteroRequestDeps {
    /** Parallel read requests per call (default 4). */
    readConcurrency?: number
}

export interface SearchItemsParams {
    q?:             string
    qmode?:         'titleCreatorYear' | 'everything'
    /** Repeated `tag` parameters: every tag must match. */
    tags?:          string[]
    itemType?:      string
    collectionKey?: string
    inTrash?:       boolean
    limit:          number
    start:          number
    sort:           'dateAdded' | 'dateModified' | 'title' | 'creator' | 'date'
    direction:      'asc' | 'desc'
}

export interface ZoteroWriteResult<T> {
    successful: { index: number, key: string, version: number, data: T }[]
    unchanged:  { index: number, key: string }[]
    failed:     { index: number, key?: string, code: number, message: string }[]
}

/** The result of one update: written, unchanged, refused on a stale version, gone, or rejected by Zotero. */
export type ModifyOutcome<T> = ModifyUpdated<T> | ModifyUnchanged | ModifyConflict | ModifyNotFound | ModifyFailed;

export interface ModifyUpdated<T> {
    key:     string
    status:  'updated'
    version: number
    data:    T
}

export interface ModifyUnchanged {
    key:    string
    status: 'unchanged'
}

export interface ModifyConflict {
    key:             string
    status:          'conflict'
    expectedVersion: number
    currentVersion:  number
    /** Who last changed it (`meta.lastModifiedByUser`, else the creator), so Izzy can say "Craig changed this". */
    lastModifiedBy?: string
    dateModified?:   string
}

export interface ModifyNotFound {
    key:    string
    status: 'not_found'
}

export interface ModifyFailed {
    key:     string
    status:  'failed'
    code:    number
    message: string
}

export interface ModifyEdit<T> {
    key:              string
    /** The version the caller last saw; a different fresh version is a conflict and nothing is written. */
    expectedVersion?: number
    /** Returns the full modified data (it receives a copy), or 'unchanged'. */
    apply:            (current: T) => T | 'unchanged'
}

export interface UploadFile {
    bytes:       Uint8Array
    filename:    string
    contentType: 'application/pdf'
    mtimeMs:     number
}

/** An attachment placeholder whose upload threw, with the version it was created at and the md5 we sent. */
export interface PlaceholderCheck {
    key:            string
    createdVersion: number
    md5:            string
}

export interface PlaceholderOutcome {
    key:     string
    outcome: 'completed' | 'changed' | 'indeterminate' | 'trashed'
    detail?: string
}

interface Versioned {
    key:     string
    version: number
    meta?:   Record<string, unknown>
    data:    Record<string, unknown>
}

/** `meta.<field>.username` when it is a string. */
function usernameOf(meta: Record<string, unknown> | undefined, field: string): string | undefined {
    const user = meta?.[field];
    const username = typeof user === 'object' && user !== null ? (user as { username?: unknown }).username : undefined;
    return typeof username === 'string' ? username : undefined;
}

interface PendingWrite {
    index:           number
    key:             string
    expectedVersion: number
    object:          Record<string, unknown>
}

const CHANGED = 'attachment changed concurrently; left as is';

function assertKey(key: string): void {
    if(!ZOTERO_KEY_PATTERN.test(key)) {
        throw new InvariantViolationError('ZoteroClient', `invalid Zotero key ${JSON.stringify(key)}`);
    }
}

function chunk<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for(let offset = 0; offset < values.length; offset += size) {
        chunks.push(values.slice(offset, offset + size));
    }
    return chunks;
}

function isDeleted(data: Record<string, unknown>): boolean {
    return data.deleted === true || data.deleted === 1;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * `Total-Results`, which Zotero sends on every multi-object read. Without it a read could not tell
 * a complete list from a truncated one, so its absence is an error rather than a guess.
 */
function totalResultsOf(response: ZoteroResponse<unknown[]>, path: string): number {
    if(response.totalResults === undefined) {
        throw new ZoteroError(`Zotero did not report Total-Results for ${path}`, undefined, { path });
    }
    return response.totalResults;
}

function writeToken(): string {
    return randomBytes(16).toString('hex');
}

function conflictOutcome<T>(key: string, expectedVersion: number, current: Versioned): ModifyOutcome<T> {
    const lastModifiedBy = usernameOf(current.meta, 'lastModifiedByUser') ?? usernameOf(current.meta, 'createdByUser');
    const dateModified = current.data.dateModified;
    return {
        key,
        status:         'conflict',
        expectedVersion,
        currentVersion: current.version,
        ...lastModifiedBy === undefined ? {} : { lastModifiedBy },
        ...typeof dateModified === 'string' ? { dateModified } : {},
    };
}

/**
 * Steps 2–3 of read-modify-write: a missing key is `not_found`, a stale expected version is a
 * `conflict` (nothing written), `apply` may decline; everything else becomes a full-object write
 * carrying the fresh version, which Zotero checks per object.
 */
function planWrites<T extends Record<string, unknown>>(
    edits: ModifyEdit<T>[],
    current: Map<string, Versioned>
): { outcomes: (ModifyOutcome<T> | undefined)[], writes: PendingWrite[] } {
    const outcomes: (ModifyOutcome<T> | undefined)[] = edits.map(() => undefined);
    const writes: PendingWrite[] = [];
    for(const [index, edit] of edits.entries()) {
        const fresh = current.get(edit.key);
        if(fresh === undefined) {
            outcomes[index] = { key: edit.key, status: 'not_found' };
            continue;
        }
        if(edit.expectedVersion !== undefined && edit.expectedVersion !== fresh.version) {
            outcomes[index] = conflictOutcome(edit.key, edit.expectedVersion, fresh);
            continue;
        }
        const next = edit.apply(structuredClone(fresh.data) as T);
        if(next === 'unchanged') {
            outcomes[index] = { key: edit.key, status: 'unchanged' };
        } else {
            // Zotero stamps dateModified with the current time only when the write omits it; sending
            // back the value we read would leave the edited item with its old modification time.
            const object: Record<string, unknown> = { ...next, key: edit.key, version: fresh.version };
            delete object.dateModified;
            writes.push({ index, key: edit.key, expectedVersion: fresh.version, object });
        }
    }
    return { outcomes, writes };
}

/** What Zotero said about object `i` of a write chunk; undefined for a per-object 412, which the caller re-reads. */
function writeOutcome<T>(response: ZoteroWriteResponse, i: number, key: string): ModifyOutcome<T> | undefined {
    const success = response.successful?.[i];
    const failure = response.failed?.[i];
    if(success !== undefined) {
        return { key, status: 'updated', version: success.version, data: success.data as T };
    }
    if(response.unchanged?.[i] !== undefined) {
        return { key, status: 'unchanged' };
    }
    if(failure === undefined) {
        return { key, status: 'failed', code: 0, message: 'Zotero returned no result for this object' };
    }
    return failure.code === 412 ? undefined : { key, status: 'failed', code: failure.code, message: failure.message };
}

/** A placeholder's fate from its fresh read, or undefined when it is unchanged since creation and has no file (so it may be trashed). */
function classifyPlaceholder(entry: PlaceholderCheck, item: ZoteroItem | undefined): PlaceholderOutcome | undefined {
    if(item === undefined) {
        return { key: entry.key, outcome: 'indeterminate', detail: 'attachment not found on re-read' };
    }
    const md5 = item.data.md5;
    if(md5 === entry.md5) {
        return { key: entry.key, outcome: 'completed' };
    }
    if(item.version !== entry.createdVersion || (md5 !== null && md5 !== undefined)) {
        return { key: entry.key, outcome: 'changed', detail: CHANGED };
    }
    return undefined;
}

export class ZoteroClient {
    readonly #requester:       ZoteroRequester;
    readonly #readConcurrency: number;
    readonly #templates = new Map<string, Promise<Record<string, unknown>>>();

    constructor(deps: ZoteroClientDeps) {
        this.#requester = new ZoteroRequester(deps);
        this.#readConcurrency = deps.readConcurrency ?? 4;
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /** One page of top-level items: in the library, a collection, or the trash. */
    async searchItems(params: SearchItemsParams): Promise<{ items: ZoteroItem[], totalResults: number }> {
        let path = '/items/top';
        if(params.inTrash === true) {
            path = '/items/trash';
        } else if(params.collectionKey !== undefined) {
            assertKey(params.collectionKey);
            path = `/collections/${params.collectionKey}/items/top`;
        }
        const query: Record<string, string | number | string[]> = {
            limit:     params.limit,
            start:     params.start,
            sort:      params.sort,
            direction: params.direction,
        };
        if(params.q !== undefined) {
            query.q = params.q;
        }
        if(params.qmode !== undefined) {
            query.qmode = params.qmode;
        }
        if(params.tags !== undefined) {
            query.tag = params.tags;
        }
        if(params.itemType !== undefined) {
            query.itemType = params.itemType;
        }
        const response = await this.#get(path, query, zoteroItemListSchema);
        return { items: response.body, totalResults: totalResultsOf(response, path) };
    }

    /** Items by key, trashed ones included (callers read `data.deleted`). Unknown keys are `missing`. */
    async getItems(keys: string[]): Promise<{ items: ZoteroItem[], missing: string[] }> {
        const { found, missing } = await this.#getByKeys(keys, '/items', 'itemKey', zoteroItemListSchema);
        return { items: found, missing };
    }

    /** Collections by key, trashed ones included. */
    async getCollections(keys: string[]): Promise<{ collections: ZoteroCollection[], missing: string[] }> {
        const { found, missing } = await this.#getByKeys(keys, '/collections', 'collectionKey', zoteroCollectionListSchema);
        return { collections: found, missing };
    }

    /** Every child (notes, attachments, annotations) of each parent, paged to completion. */
    async getChildren(parentKeys: string[]): Promise<Map<string, ZoteroItem[]>> {
        for(const key of parentKeys) {
            assertKey(key);
        }
        const limit = pLimit(this.#readConcurrency);
        const unique = [...new Set(parentKeys)];
        const lists = await Promise.all(unique.map(async parentKey => limit(async () => this.#pageAll(
            `/items/${parentKey}/children`,
            {},
            zoteroItemListSchema,
            MAX_CHILD_PAGES,
            total => new ZoteroError(
                `${parentKey} has ${total} children, more than the ${MAX_CHILD_PAGES * PAGE_SIZE} this client reads; nothing was returned`,
                undefined,
                { parentKey, totalResults: total }
            )
        ))));
        return new Map(unique.map((key, i) => [key, lists[i]!]));
    }

    /** Every collection in the group, flat. */
    async listCollections(options: { includeTrashed: boolean }): Promise<ZoteroCollection[]> {
        return this.#pageAll(
            '/collections',
            options.includeTrashed ? { includeTrashed: 1 } : {},
            zoteroCollectionListSchema,
            MAX_COLLECTION_PAGES,
            total => new ZoteroError(`the group has ${total} collections, more than the ${MAX_COLLECTION_PAGES * PAGE_SIZE} this client reads`, undefined, { totalResults: total })
        );
    }

    /**
     * A transient, complete read of every top-level item (trash included) for duplicate checks. If
     * the library version moves during the scan it is repeated once; a second move throws. Nothing is
     * retained after the call.
     */
    async scanTopItems(): Promise<{ items: ZoteroItem[], libraryVersion: number }> {
        for(let attempt = 0; attempt < 2; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- sequential: the rescan only happens when the first scan saw the library change
            const scan = await this.#scanOnce();
            if(scan !== undefined) {
                return scan;
            }
        }
        throw new ZoteroError('library changed during duplicate check; retry');
    }

    /** The empty item for an item type (`GET /items/new`), memoised for the process lifetime; each caller gets a copy. */
    async getItemTemplate(itemType: string): Promise<Record<string, unknown>> {
        let template = this.#templates.get(itemType);
        if(template === undefined) {
            template = this.#requester
                .request('GET', { scope: 'schema', path: '/items/new' }, { idempotent: true, query: { itemType }, schema: zoteroTemplateSchema })
                .then(response => response.body);
            this.#templates.set(itemType, template);
            template.catch(() => this.#templates.delete(itemType));
        }
        return structuredClone(await template);
    }

    // ------------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------------

    /** Creates items, one POST per 50. Per-object failures come back in `failed`. */
    async createItems(items: NewItemData[]): Promise<ZoteroWriteResult<ZoteroItemData>> {
        return this.#create('/items', items);
    }

    /** Creates collections, one POST per 50. */
    async createCollections(collections: { name: string, parentCollection: string | false }[]): Promise<ZoteroWriteResult<ZoteroCollectionData>> {
        return this.#create('/collections', collections);
    }

    /** The single update path for items: fresh batched read, version check, apply, one batched write. */
    async modifyItems(edits: ModifyEdit<ZoteroItemData>[]): Promise<ModifyOutcome<ZoteroItemData>[]> {
        return this.#modify('/items', edits, async (keys) => {
            const { items } = await this.getItems(keys);
            return items;
        });
    }

    /** The single update path for collections. */
    async modifyCollections(edits: ModifyEdit<ZoteroCollectionData>[]): Promise<ModifyOutcome<ZoteroCollectionData>[]> {
        return this.#modify('/collections', edits, async (keys) => {
            const { collections } = await this.getCollections(keys);
            return collections;
        });
    }

    /** Moves items to the group Trash (`deleted: true`) or restores them. The only deletion the client has. */
    async setItemsDeleted(entries: { key: string, expectedVersion?: number }[], deleted: boolean): Promise<ModifyOutcome<ZoteroItemData>[]> {
        return this.modifyItems(entries.map(entry => ({ ...entry, apply: data => (isDeleted(data) === deleted ? 'unchanged' : { ...data, deleted }) })));
    }

    /** Moves collections to the group Trash or restores them. */
    async setCollectionsDeleted(entries: { key: string, expectedVersion?: number }[], deleted: boolean): Promise<ModifyOutcome<ZoteroCollectionData>[]> {
        return this.modifyCollections(entries.map(entry => ({ ...entry, apply: data => (isDeleted(data) === deleted ? 'unchanged' : { ...data, deleted }) })));
    }

    // ------------------------------------------------------------------
    // Files
    // ------------------------------------------------------------------

    /**
     * Stores a PDF on an existing `imported_file` attachment: authorise (md5, size, mtime, with
     * `If-None-Match: *`), upload to the storage host with no Zotero header, then register.
     * Returns 'exists' when Zotero already had these bytes and linked them.
     */
    async uploadAttachmentFile(attachmentKey: string, file: UploadFile): Promise<'uploaded' | 'exists'> {
        assertKey(attachmentKey);
        const target = { scope: 'library' as const, path: `/items/${attachmentKey}/file` };
        // eslint-disable-next-line sonarjs/hashing -- Zotero's file protocol requires md5 as a content identity; it is not used for security
        const md5 = createHash('md5').update(file.bytes).digest('hex');
        const authorization = await this.#fileStep(attachmentKey, async () => this.#requester.request('POST', target, {
            idempotent: false,
            headers:    { 'If-None-Match': '*' },
            form:       { md5, filename: file.filename, filesize: String(file.bytes.length), mtime: String(Math.trunc(file.mtimeMs)) },
            schema:     zoteroUploadAuthorizationSchema,
        }));
        if('exists' in authorization.body) {
            return 'exists';
        }
        const { url, contentType, prefix, suffix, uploadKey } = authorization.body;
        if(!url.startsWith('https://')) {
            throw new ZoteroFileError(`Zotero returned a non-https upload URL for ${attachmentKey}; refusing to upload`, { reason: 'upload_failed', key: attachmentKey });
        }

        const head = new TextEncoder().encode(prefix);
        const tail = new TextEncoder().encode(suffix);
        const body = new Uint8Array(head.length + file.bytes.length + tail.length);
        body.set(head, 0);
        body.set(file.bytes, head.length);
        body.set(tail, head.length + file.bytes.length);
        const upload = await this.#requester.external('POST', url, { idempotent: true, headers: { 'Content-Type': contentType }, body });
        await upload.body?.cancel();
        if(upload.status !== 201) {
            throw new ZoteroFileError(`Uploading the file for ${attachmentKey} to Zotero storage failed (HTTP ${upload.status})`, { reason: 'upload_failed', status: upload.status, key: attachmentKey });
        }

        const registration = await this.#fileStep(attachmentKey, async () => this.#requester.request('POST', target, {
            idempotent: false,
            headers:    { 'If-None-Match': '*' },
            form:       { upload: uploadKey },
        }));
        if(registration.status !== 204) {
            throw new ZoteroFileError(`Registering the upload for ${attachmentKey} returned HTTP ${registration.status}`, { reason: 'upload_failed', status: registration.status, key: attachmentKey });
        }
        return 'uploaded';
    }

    /**
     * After failed uploads, decides each placeholder's fate from one fresh batched read: our md5 is
     * there → `completed`; version or md5 moved → `changed` (left alone); read failed or key gone →
     * `indeterminate` (left alone); unchanged and empty → trashed in one batch at its creation
     * version, so a change racing the trash is a 412 → `changed`. Nothing is ever deleted.
     */
    async cleanupPlaceholders(entries: PlaceholderCheck[]): Promise<PlaceholderOutcome[]> {
        if(entries.length === 0) {
            return [];
        }
        let fresh: Map<string, ZoteroItem>;
        try {
            const { items } = await this.getItems(entries.map(entry => entry.key));
            fresh = new Map(items.map(item => [item.key, item]));
        } catch (error) {
            return entries.map(entry => ({ key: entry.key, outcome: 'indeterminate', detail: `could not re-read the attachment: ${errorMessage(error)}` }));
        }

        const outcomes = new Map<string, PlaceholderOutcome>();
        const empty: PlaceholderCheck[] = [];
        for(const entry of entries) {
            const outcome = classifyPlaceholder(entry, fresh.get(entry.key));
            if(outcome === undefined) {
                empty.push(entry);
            } else {
                outcomes.set(entry.key, outcome);
            }
        }

        if(empty.length > 0) {
            try {
                const results = await this.setItemsDeleted(empty.map(entry => ({ key: entry.key, expectedVersion: entry.createdVersion })), true);
                for(const result of results) {
                    outcomes.set(result.key, this.#trashOutcome(result));
                }
            } catch (error) {
                for(const entry of empty) {
                    outcomes.set(entry.key, { key: entry.key, outcome: 'indeterminate', detail: `trashing the empty placeholder failed: ${errorMessage(error)}` });
                }
            }
        }
        return entries.map(entry => outcomes.get(entry.key)!);
    }

    /**
     * Downloads an attachment's stored file, capped at `maxBytes`. The `/file` redirect is followed by
     * hand to an https storage URL with no Zotero header, so the API key never leaves api.zotero.org.
     */
    async downloadAttachmentFile(attachmentKey: string, maxBytes: number): Promise<{ bytes: Uint8Array, contentType: string }> {
        assertKey(attachmentKey);
        let response: Response;
        try {
            response = await this.#requester.requestRaw('GET', { scope: 'library', path: `/items/${attachmentKey}/file` }, { idempotent: true, file: true, redirect: 'manual' });
        } catch (error) {
            if(error instanceof ZoteroNotFoundError) {
                throw new ZoteroFileError(`Attachment ${attachmentKey} has no stored file`, { reason: 'no_file', key: attachmentKey });
            }
            throw error;
        }

        if(REDIRECTS.has(response.status)) {
            const location = response.headers.get('Location');
            await response.body?.cancel();
            if(location?.startsWith('https://') !== true) {
                throw new ZoteroFileError(`Zotero redirected the download of ${attachmentKey} to a non-https location`, { reason: 'download_failed', key: attachmentKey });
            }
            response = await this.#requester.external('GET', location, { idempotent: true });
        }
        if(response.status !== 200) {
            await response.body?.cancel();
            throw new ZoteroFileError(`Downloading the stored file for ${attachmentKey} failed (HTTP ${response.status})`, { reason: 'download_failed', status: response.status, key: attachmentKey });
        }

        const contentType = (response.headers.get('Content-Type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
        return { bytes: await this.#readCapped(response, maxBytes, attachmentKey), contentType };
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    async #get<T>(path: string, query: Record<string, string | number | string[]>, schema: z.ZodType<T>): Promise<ZoteroResponse<T>> {
        return this.#requester.request('GET', { scope: 'library', path }, { idempotent: true, query, schema });
    }

    async #getByKeys<T extends { key: string }>(
        keys: string[],
        path: string,
        param: 'itemKey' | 'collectionKey',
        schema: z.ZodType<T[]>
    ): Promise<{ found: T[], missing: string[] }> {
        for(const key of keys) {
            assertKey(key);
        }
        const unique = [...new Set(keys)];
        const limit = pLimit(this.#readConcurrency);
        const pages = await Promise.all(chunk(unique, KEYED_CHUNK).map(async keyChunk => limit(async () => {
            const response = await this.#get(path, { [param]: keyChunk.join(','), includeTrashed: 1, limit: KEYED_CHUNK }, schema);
            const total = totalResultsOf(response, path);
            if(total > response.body.length) {
                throw new ZoteroError(`incomplete keyed read from ${path}: Zotero reported ${total} results but returned ${response.body.length}`, undefined, { path });
            }
            return response.body;
        })));
        const found = pages.flat();
        const foundKeys = new Set(found.map(object => object.key));
        return { found, missing: unique.filter(key => !foundKeys.has(key)) };
    }

    async #pageAll<T>(
        path: string,
        query: Record<string, string | number>,
        schema: z.ZodType<T[]>,
        maxPages: number,
        tooMany: (total: number) => ZoteroError
    ): Promise<T[]> {
        const collected: T[] = [];
        for(;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each page starts where the previous one ended
            const response = await this.#get(path, { ...query, limit: PAGE_SIZE, start: collected.length }, schema);
            const total = totalResultsOf(response, path);
            if(total > maxPages * PAGE_SIZE) {
                throw tooMany(total);
            }
            collected.push(...response.body);
            if(collected.length >= total) {
                return collected;
            }
            if(response.body.length === 0) {
                throw new ZoteroError(`incomplete paged read from ${path}: got ${collected.length} of ${total}`, undefined, { path });
            }
        }
    }

    /** One pass of the top-level scan; undefined when the library version moved during it. */
    async #scanOnce(): Promise<{ items: ZoteroItem[], libraryVersion: number } | undefined> {
        const path = '/items/top';
        const page = async (start: number) => this.#get(path, { includeTrashed: 1, sort: 'dateAdded', direction: 'asc', limit: PAGE_SIZE, start }, zoteroItemListSchema);
        const first = await page(0);
        const libraryVersion = first.libraryVersion;
        if(libraryVersion === undefined) {
            throw new ZoteroError(`Zotero did not report a library version for ${path}`, undefined, { path });
        }
        const total = totalResultsOf(first, path);
        if(total > MAX_SCAN_PAGES * PAGE_SIZE) {
            throw new ZoteroError(`the library has ${total} top-level items, more than the ${MAX_SCAN_PAGES * PAGE_SIZE} a duplicate check reads`, undefined, { totalResults: total });
        }
        const limit = pLimit(this.#readConcurrency);
        const starts: number[] = [];
        for(let start = PAGE_SIZE; start < total; start += PAGE_SIZE) {
            starts.push(start);
        }
        const rest = await Promise.all(starts.map(async start => limit(async () => page(start))));
        if(rest.some(response => response.libraryVersion !== libraryVersion)) {
            return undefined;
        }
        return { items: [first, ...rest].flatMap(response => response.body), libraryVersion };
    }

    async #create<T>(path: string, objects: unknown[]): Promise<ZoteroWriteResult<T>> {
        const result: ZoteroWriteResult<T> = { successful: [], unchanged: [], failed: [] };
        for(const [chunkIndex, objectChunk] of chunk(objects, WRITE_CHUNK).entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each write bumps the library version
            const response = await this.#postWrite(path, objectChunk);
            const offset = chunkIndex * WRITE_CHUNK;
            for(const [index, success] of Object.entries(response.successful ?? {})) {
                result.successful.push({ index: offset + Number(index), key: success.key, version: success.version, data: success.data as T });
            }
            for(const [index, key] of Object.entries(response.unchanged ?? {})) {
                result.unchanged.push({ index: offset + Number(index), key });
            }
            for(const [index, failure] of Object.entries(response.failed ?? {})) {
                result.failed.push({ index: offset + Number(index), ...failure.key === undefined ? {} : { key: failure.key }, code: failure.code, message: failure.message });
            }
        }
        return result;
    }

    async #postWrite(path: string, objects: unknown[]): Promise<ZoteroWriteResponse> {
        const response = await this.#requester.request('POST', { scope: 'library', path }, {
            idempotent: false,
            json:       objects,
            headers:    { 'Zotero-Write-Token': writeToken() },
            schema:     zoteroWriteResponseSchema,
        });
        return response.body;
    }

    async #modify<T extends Record<string, unknown>>(
        path: string,
        edits: ModifyEdit<T>[],
        read: (keys: string[]) => Promise<Versioned[]>
    ): Promise<ModifyOutcome<T>[]> {
        const seen = new Set<string>();
        for(const edit of edits) {
            if(seen.has(edit.key)) {
                throw new ZoteroError(`${edit.key} appears more than once in one batch; combine the edits`, undefined, { key: edit.key });
            }
            seen.add(edit.key);
        }

        const currentObjects = await read(edits.map(edit => edit.key));
        const { outcomes, writes } = planWrites(edits, new Map(currentObjects.map(object => [object.key, object])));
        const conflicted = await this.#writeChunks(path, writes, outcomes);
        if(conflicted.length > 0) {
            await this.#reportConflicts(conflicted, outcomes, read);
        }
        return outcomes as ModifyOutcome<T>[];
    }

    /** Writes the planned objects 50 per POST, filling `outcomes`; returns the writes that hit a 412. */
    async #writeChunks<T>(path: string, writes: PendingWrite[], outcomes: (ModifyOutcome<T> | undefined)[]): Promise<PendingWrite[]> {
        const conflicted: PendingWrite[] = [];
        for(const writeChunk of chunk(writes, WRITE_CHUNK)) {
            let response: ZoteroWriteResponse;
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential: each write bumps the library version
                response = await this.#postWrite(path, writeChunk.map(write => write.object));
            } catch (error) {
                if(!(error instanceof ZoteroVersionConflictError)) {
                    throw error;
                }
                conflicted.push(...writeChunk);
                continue;
            }
            for(const [i, write] of writeChunk.entries()) {
                const outcome = writeOutcome<T>(response, i, write.key);
                if(outcome === undefined) {
                    conflicted.push(write);
                } else {
                    outcomes[write.index] = outcome;
                }
            }
        }
        return conflicted;
    }

    /** A 412 is re-read and reported, never re-applied. */
    async #reportConflicts<T>(
        conflicted: PendingWrite[],
        outcomes: (ModifyOutcome<T> | undefined)[],
        read: (keys: string[]) => Promise<Versioned[]>
    ): Promise<void> {
        let fresh: Map<string, Versioned>;
        try {
            const objects = await read(conflicted.map(write => write.key));
            fresh = new Map(objects.map(object => [object.key, object]));
        } catch (error) {
            for(const write of conflicted) {
                outcomes[write.index] = { key: write.key, status: 'failed', code: 412, message: `${write.key} changed since it was read; re-reading it failed: ${errorMessage(error)}` };
            }
            return;
        }
        for(const write of conflicted) {
            const now = fresh.get(write.key);
            outcomes[write.index] = now === undefined ? { key: write.key, status: 'not_found' } : conflictOutcome(write.key, write.expectedVersion, now);
        }
    }

    #trashOutcome(result: ModifyOutcome<ZoteroItemData>): PlaceholderOutcome {
        switch(result.status) {
            case 'updated':
            case 'unchanged': {
                return { key: result.key, outcome: 'trashed' };
            }
            case 'conflict': {
                return { key: result.key, outcome: 'changed', detail: CHANGED };
            }
            case 'not_found': {
                return { key: result.key, outcome: 'indeterminate', detail: 'attachment not found when trashing it' };
            }
            case 'failed': {
                return { key: result.key, outcome: 'indeterminate', detail: `trashing the empty placeholder failed: ${result.message}` };
            }
        }
    }

    /** Runs one file-endpoint step, turning a 412 (`If-None-Match: *` failed) into `already_has_file`. */
    async #fileStep<T>(attachmentKey: string, step: () => Promise<T>): Promise<T> {
        try {
            return await step();
        } catch (error) {
            if(error instanceof ZoteroVersionConflictError) {
                throw new ZoteroFileError(`Attachment ${attachmentKey} already has a file`, { reason: 'already_has_file', key: attachmentKey });
            }
            throw error;
        }
    }

    async #readCapped(response: Response, maxBytes: number, attachmentKey: string): Promise<Uint8Array> {
        const tooLarge = () => new ZoteroFileError(`The stored file for ${attachmentKey} is larger than the ${maxBytes}-byte limit`, { reason: 'too_large', limit: maxBytes, key: attachmentKey });
        const declared = intHeader(response.headers, 'Content-Length');
        if(declared !== undefined && declared > maxBytes) {
            await response.body?.cancel();
            throw tooLarge();
        }
        if(response.body === null) {
            return new Uint8Array();
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for(;;) {
            // eslint-disable-next-line no-await-in-loop -- sequential: a stream is read one chunk at a time
            const { done, value } = await reader.read();
            if(done) {
                break;
            }
            total += value.length;
            if(total > maxBytes) {
                break;
            }
            chunks.push(value);
        }
        if(total > maxBytes) {
            await reader.cancel();
            throw tooLarge();
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for(const part of chunks) {
            bytes.set(part, offset);
            offset += part.length;
        }
        return bytes;
    }
}
