/**
 * Pure core of the one-off tag-index repair (tools/repair-tag-index.ts): the scan, the plan,
 * the per-memory repair from fresh observations and the settle-checked META_COUNT recount.
 * Every DynamoDB access goes through the {@link RepairStore} port, so tests need no AWS.
 */
import { generateContentPreview, normalizeTags } from '@/storage/memory-tool/key-generator';
import { classifyMemoryPath, SEARCHABLE_NAMESPACE_VALUES, type MemoryPath } from '@/storage/memory-tool/types';

/** The paced resources: base table reads and writes, GSI1 reads, GSI2 reads and writes. */
export const RATE_KEYS = ['baseRcu', 'baseWcu', 'gsi1Rcu', 'gsi2Rcu', 'gsi2Wcu'] as const;
export type RateKey = typeof RATE_KEYS[number];
/** BatchGetItem's key limit. */
export const BATCH_GET_KEYS = 100;
/** Retries (throttling, unprocessed BatchGetItem keys) back off from 1 s doubling to 30 s. */
export const FIRST_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 30_000;
export type Rates = Record<RateKey, number>;
/** Capacity units DynamoDB reported for one request, per resource. */
export type Units = Partial<Rates>;
export type Cursor = Record<string, unknown> | undefined;

/** A memory row as the repair needs it; a memory without tags has no `tags` attribute. */
export interface Memory {
    path:      string
    tags?:     Set<string>
    updatedAt: string
    content:   string
    TTL?:      number
}

/** A tag index row (PK TAG#tag, SK PATH#path) as read, so every attribute may be missing. */
export interface TagRow {
    PK:              string
    SK:              string
    memoryPath?:     string
    layer?:          string
    updatedAt?:      string
    tags?:           Set<string>
    contentPreview?: string
    TTL?:            number
}

/** A META_COUNT row (PK TAG#tag). */
export interface Meta {
    PK:      string
    SK:      string
    count?:  number
    GSI2PK?: string
    GSI2SK?: string
}

export interface Page<T> {
    items: T[]
    next:  Cursor
    units: Units
}

export interface PartitionPage {
    rows:  TagRow[]
    meta:  Meta | undefined
    next:  Cursor
    units: Units
}

export type WriteStatus = 'ok' | 'conditionFailed';

export interface WriteResult {
    status: WriteStatus
    units:  Units
}

/**
 * The DynamoDB port. Reads report their consumed units; writes are conditional and report
 * `conditionFailed` instead of throwing when their condition does not hold.
 */
export interface RepairStore {
    /** One page of the GSI2 TAG_COUNTS partition. */
    listMetaCounts(start: Cursor): Promise<Page<Meta>>
    /** One page of the base-table partition TAG#tag: its PATH rows and its META row. */
    readTagPartition(tag: string, start: Cursor, strong: boolean): Promise<PartitionPage>
    /** One page of the GSI1 partition LAYER#namespace. */
    walkNamespace(namespace: string, start: Cursor): Promise<Page<Memory>>
    /** Strongly consistent read of one memory. */
    getMemory(path: string): Promise<{ item: Memory | undefined, units: Units }>
    /**
     * One strongly consistent BatchGetItem of the rows (tag, path) for at most
     * {@link BATCH_GET_KEYS} tags; `unprocessed` lists the tags DynamoDB left unread.
     */
    getRows(path: string, tags: string[]): Promise<{ items: TagRow[], unprocessed: string[], units: Units }>
    /** Puts `row`, conditioned on the full observed row, or on no row at all for 'absent'. */
    putRow(row: TagRow, observed: TagRow | 'absent'): Promise<WriteResult>
    /** Deletes the observed row, conditioned on it being unchanged. */
    deleteRow(observed: TagRow): Promise<WriteResult>
    /** Sets META count and both GSI2 keys, conditioned on the count read (or its absence). */
    setMeta(tag: string, count: number, expected: number | undefined): Promise<WriteResult>
    /** Deletes META, conditioned on the count read (or its absence). */
    deleteMeta(tag: string, expected: number | undefined): Promise<WriteResult>
}

/**
 * Per-resource pacing shared by every worker. A request queues for its turn, is charged its
 * estimated units when let through, so concurrent requests cannot all pass on the same free
 * budget, and is trued up to the units DynamoDB reported once it returns.
 */
export interface Pacing {
    /** Waits for the turn of `estimate` on every resource it names and charges it; throws once aborted or cancelled. */
    reserve:           (estimate: Units) => Promise<void>
    /** Adjusts the charge of `estimate` to the `actual` units reported, and records them. */
    trueUp:            (estimate: Units, actual: Units) => void
    /**
     * After throttling: holds `keys` for `ms` for every request, queued or future, then waits (in
     * the same queue, charged nothing more) for the throttled request's turn to retry.
     */
    backoff:           (keys: readonly RateKey[], ms: number) => Promise<void>
    /** Refuses every queued and later request and retry with `reason` (a pool's first fatal error). */
    cancel:            (reason: unknown) => void
    readonly consumed: Rates
}

/** Progress of the current phase, logged at most every {@link PROGRESS_MS}. */
export interface Progress {
    /** Starts a phase of `total` items; its rates count from here. */
    phase: (label: string, total: number) => void
    /** One item of the phase finished. */
    done:  () => void
    /** Logs the phase's progress once {@link PROGRESS_MS} passed since the last progress log. */
    poke:  () => void
}

/** Everything the repair needs besides its inputs. `now` is epoch milliseconds. */
export interface RepairContext {
    store:       RepairStore
    pacing:      Pacing
    progress:    Progress
    /** How many independent items (tag partitions, memories, recount tags) run at once. */
    concurrency: number
    sleep:       (ms: number) => Promise<void>
    now:         () => number
    log:         (text: string) => void
    signal:      AbortSignal
}

/** A row as the repair writes it: every attribute present except an optional TTL. */
export type DesiredRow = Required<Omit<TagRow, 'TTL'>> & Pick<TagRow, 'TTL'>;

export interface Snapshot {
    memories: Map<string, Memory>
    rows:     Map<string, TagRow[]>
    metas:    Map<string, Meta>
}

export const BUCKET_NAMES = [
    'orphan', 'removedTag', 'ttlStamp', 'staleTags', 'layer', 'preview', 'memoryPath', 'updatedAtOnly', 'missing', 'metaDrift', 'expiredRowLeft',
] as const;
export type BucketName = typeof BUCKET_NAMES[number];

export interface Bucket {
    count:    number
    examples: string[]
}

export interface Plan {
    /** Memory paths to repair, each with the tags of every row the scan found for it. */
    paths:     Map<string, string[]>
    /** Tags whose META must be recounted. */
    recount:   Set<string>
    buckets:   Record<BucketName, Bucket>
    rowWrites: number
}

export interface CountState {
    n:    number
    meta: { count: number | undefined, keys: boolean } | undefined
}

export interface RepairResult {
    repaired:       number
    unsettledPaths: string[]
    unsettledTags:  string[]
    rowWrites:      number
    metaWrites:     number
    aborted:        boolean
}

export const MAX_EXAMPLES = 25;
export const MAX_ATTEMPTS = 3;
export const WRITE_CYCLES = 3;
export const PROGRESS_MS = 10_000;
/** Assumed stored size of one tag row, for estimates only. */
export const ROW_BYTES = 512;
/** A little above the ~0.25 s round trip measured on 2026-09-27, so workers are never the bottleneck. */
export const ASSUMED_LATENCY_MS = 300;
/** The default concurrency never exceeds this; --concurrency may go up to {@link MAX_CONCURRENCY}. */
export const DEFAULT_CONCURRENCY_CAP = 32;
export const MAX_CONCURRENCY = 64;
const READ_UNIT_BYTES = 4096;
const TAG_COUNTS = 'TAG_COUNTS';
/** Units booked before a request; the true-up corrects them to what DynamoDB reports. */
const EVENTUAL_PARTITION: Units = { baseRcu: 0.5 };
const STRONG_PARTITION: Units = { baseRcu: 1 };
const MEMORY_READ: Units = { baseRcu: 1 };
const ROW_WRITE: Units = { baseWcu: 1 };
const META_WRITE: Units = { baseWcu: 1, gsi2Wcu: 1 };

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

/** A memory is live while it exists and its TTL, if any, is still in the future. */
export function isLive(memory: Memory | undefined, nowSeconds: number): memory is Memory {
    return memory !== undefined && (memory.TTL === undefined || memory.TTL > nowSeconds);
}

/**
 * The second '/'-segment: the namespace of a memory path, and equally of a row SK, since the
 * `PATH#` prefix holds no '/'.
 */
function namespaceOf(path: string): string {
    return path.split('/')[1] ?? '';
}

function sameTags(a: Set<string> | undefined, b: Set<string>): boolean {
    return a?.size === b.size && [...b].every(tag => a.has(tag));
}

/** The row the live writer would write for (memory, tag): buildPutRequests plus the memory's TTL. */
export function desiredRow(memory: Memory, tag: string): DesiredRow {
    return {
        PK:             `TAG#${tag}`,
        SK:             `PATH#${memory.path}`,
        memoryPath:     memory.path,
        layer:          classifyMemoryPath(memory.path as MemoryPath).namespace,
        updatedAt:      memory.updatedAt,
        tags:           normalizeTags(memory.tags),
        contentPreview: generateContentPreview(memory.content),
        ...(memory.TTL === undefined ? {} : { TTL: memory.TTL }),
    };
}

const ROW_CHECKS: [BucketName, (row: TagRow, desired: DesiredRow) => boolean][] = [
    ['ttlStamp', (row, desired) => row.TTL !== desired.TTL],
    ['staleTags', (row, desired) => !sameTags(row.tags, desired.tags)],
    ['layer', (row, desired) => row.layer !== desired.layer],
    ['preview', (row, desired) => row.contentPreview !== desired.contentPreview],
    ['memoryPath', (row, desired) => row.memoryPath !== desired.memoryPath],
    ['updatedAtOnly', (row, desired) => row.updatedAt !== desired.updatedAt],
];

/** The first way `row` differs from `desired`, or undefined when it needs no rewrite. */
export function rowDiff(row: TagRow, desired: DesiredRow): BucketName | undefined {
    return ROW_CHECKS.find(([, differs]) => differs(row, desired))?.[0];
}

/** Whether two reads of a memory agree on everything its rows are derived from. */
export function sameMemoryState(a: Memory | undefined, b: Memory | undefined, nowSeconds: number): boolean {
    if(!isLive(a, nowSeconds) || !isLive(b, nowSeconds)) {
        return isLive(a, nowSeconds) === isLive(b, nowSeconds);
    }
    const samePreview = generateContentPreview(a.content) === generateContentPreview(b.content);
    return a.updatedAt === b.updatedAt && a.TTL === b.TTL && sameTags(normalizeTags(a.tags), normalizeTags(b.tags)) && samePreview;
}

export type CountAction = { kind: 'set', count: number, expected: number | undefined } | { kind: 'delete', expected: number | undefined };

/** The META write that makes the count equal the rows without a TTL, or undefined when META is right. */
export function countAction(state: CountState): CountAction | undefined {
    if(state.meta === undefined) {
        return state.n === 0 ? undefined : { kind: 'set', count: state.n, expected: undefined };
    }
    if(state.n === 0) {
        return { kind: 'delete', expected: state.meta.count };
    }
    return state.meta.count === state.n && state.meta.keys ? undefined : { kind: 'set', count: state.n, expected: state.meta.count };
}

function metaState(tag: string, meta: Meta | undefined): CountState['meta'] {
    return meta === undefined ? undefined : { count: meta.count, keys: meta.GSI2PK === TAG_COUNTS && meta.GSI2SK === `TAG#${tag}` };
}

function permanentRows(rows: TagRow[]): number {
    return rows.filter(row => row.TTL === undefined).length;
}

/**
 * Sends one request under pacing: books `estimate` (waiting for its slot, and throwing once
 * aborted, so nothing is sent after an abort), sends, then trues the booking up to the reported units.
 */
async function paced<R extends { units: Units }>(ctx: RepairContext, estimate: Units, send: () => Promise<R>): Promise<R> {
    await ctx.pacing.reserve(estimate);
    const result = await send();
    ctx.pacing.trueUp(estimate, result.units);
    ctx.progress.poke();
    return result;
}

/**
 * Reads every page of `fetch` in order. The first page books `first`; each later page books the
 * units its predecessor reported, since only the last page of a query is short.
 */
async function drain<P extends { next: Cursor, units: Units }>(ctx: RepairContext, first: Units, fetch: (start: Cursor) => Promise<P>, visit: (page: P) => void): Promise<void> {
    let start: Cursor;
    let estimate = first;
    do {
        const from = start;
        // eslint-disable-next-line no-await-in-loop -- sequential: each page starts from the previous page's cursor
        const page = await paced(ctx, estimate, async () => fetch(from));
        visit(page);
        estimate = page.units;
        start = page.next;
    } while(start !== undefined);
}

/**
 * Runs `work` over `items` with at most `ctx.concurrency` items in flight, dispatching in order.
 * The first failure or an abort stops dispatching, and a failure also cancels the pacing, so no
 * sibling sends another request or throttled retry; the items already in flight are left to
 * settle (each waits on at most one request already sent, bounded by the SDK's timeouts, since
 * every pacing wait and backoff ends at the abort or cancel), and only then does the pool rethrow
 * the first failure, or the abort.
 */
export async function runPool<T>(ctx: RepairContext, label: string, items: readonly T[], work: (item: T, index: number) => Promise<void>): Promise<void> {
    ctx.progress.phase(label, items.length);
    let next = 0;
    let failure: { error: unknown } | undefined;
    const worker = async (): Promise<void> => {
        while(failure === undefined && !ctx.signal.aborted && next < items.length) {
            const index = next++;
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential within one worker: the pool is the concurrency
                await work(items[index], index);
                ctx.progress.done();
            } catch (error) {
                failure ??= { error };
                ctx.pacing.cancel(error);
            }
        }
    };
    await Promise.all(Array.from({ length: ctx.concurrency }, worker));
    if(failure !== undefined) {
        throw failure.error as Error;
    }
    ctx.signal.throwIfAborted();
}

/** {@link runPool} collecting each item's result in item order. */
export async function mapPool<T, R>(ctx: RepairContext, label: string, items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    await runPool(ctx, label, items, async (item, index) => {
        results[index] = await work(item);
    });
    return results;
}

/** Reads the partitions of `tags` eventually-consistently, in a pool, into the snapshot in tag order. */
async function readPartitions(ctx: RepairContext, snapshot: Snapshot, label: string, tags: string[]): Promise<void> {
    const read = await mapPool(ctx, label, tags, async (tag) => {
        const rows: TagRow[] = [];
        let meta: Meta | undefined;
        await drain(ctx, EVENTUAL_PARTITION, async start => ctx.store.readTagPartition(tag, start, false), (page) => {
            rows.push(...page.rows);
            meta = page.meta ?? meta;
        });
        return { tag, rows, meta };
    });
    for(const { tag, rows, meta } of read) {
        snapshot.rows.set(tag, rows);
        if(meta !== undefined) {
            snapshot.metas.set(tag, meta);
        }
    }
}

/**
 * Enumerates the tag index eventually-consistently: GSI2 META rows, their partitions, every
 * searchable namespace plus the namespaces seen in rows on GSI1, then the partitions of tags that
 * memories carry but GSI2 did not list (tags without META, or META whose GSI2 keys are wrong).
 * Tag partitions are read in pools; the snapshot keeps the sequential order.
 */
export async function scan(ctx: RepairContext): Promise<Snapshot> {
    const snapshot: Snapshot = { memories: new Map(), rows: new Map(), metas: new Map() };
    ctx.progress.phase('List TAG_COUNTS', 0);
    await drain(ctx, { gsi2Rcu: 0.5 }, async start => ctx.store.listMetaCounts(start), (page) => {
        for(const meta of page.items) {
            snapshot.metas.set(meta.PK.slice(4), meta);
        }
    });
    await readPartitions(ctx, snapshot, 'Scan listed tags', [...snapshot.metas.keys()]);
    ctx.log(`Scanned ${snapshot.rows.size} tag partitions`);
    const rowNamespaces = [...snapshot.rows.values()].flat().map(row => namespaceOf(row.SK));
    const namespaces = new Set([...SEARCHABLE_NAMESPACE_VALUES, ...rowNamespaces].filter(namespace => namespace !== ''));
    ctx.progress.phase('Walk namespaces', namespaces.size);
    for(const namespace of namespaces) {
        // eslint-disable-next-line no-await-in-loop -- sequential: a walk is a chain of full 1 MB GSI1 pages whose cost is unknown until each returns, so walks in parallel could only burst GSI1 (Izzy's headroom), not speed up a rate-bound phase
        await drain(ctx, { gsi1Rcu: 0.5 }, async start => ctx.store.walkNamespace(namespace, start), (page) => {
            for(const memory of page.items) {
                snapshot.memories.set(memory.path, memory);
            }
        });
        ctx.progress.done();
    }
    ctx.log(`Walked ${snapshot.memories.size} memories in ${namespaces.size} namespaces`);
    const carried = new Set([...snapshot.memories.values()].flatMap(memory => [...normalizeTags(memory.tags)]));
    await readPartitions(ctx, snapshot, 'Scan unlisted tags', [...carried].filter(tag => !snapshot.rows.has(tag)));
    ctx.log(`Scanned ${snapshot.rows.size} tag partitions in total`);
    return snapshot;
}

function emptyBuckets(): Record<BucketName, Bucket> {
    return Object.fromEntries(BUCKET_NAMES.map(name => [name, { count: 0, examples: [] }])) as unknown as Record<BucketName, Bucket>;
}

function addToBucket(bucket: Bucket, example: string): void {
    bucket.count++;
    if(bucket.examples.length < MAX_EXAMPLES) {
        bucket.examples.push(example);
    }
}

/** Classifies one scanned row: the bucket it needs a write for, 'expiredRowLeft', or undefined. */
function classifyRow(snapshot: Snapshot, tag: string, row: TagRow, nowSeconds: number): BucketName | undefined {
    const memory = snapshot.memories.get(row.SK.slice(5));
    if(!isLive(memory, nowSeconds)) {
        return (row.TTL ?? Number.POSITIVE_INFINITY) <= nowSeconds ? 'expiredRowLeft' : 'orphan';
    }
    if(!normalizeTags(memory.tags).has(tag)) {
        return 'removedTag';
    }
    return rowDiff(row, desiredRow(memory, tag));
}

/** The tags of every scanned row, per memory path. */
function tagsByPath(snapshot: Snapshot): Map<string, Set<string>> {
    const byPath = new Map<string, Set<string>>();
    for(const [tag, rows] of snapshot.rows) {
        for(const row of rows) {
            const path = row.SK.slice(5);
            byPath.set(path, (byPath.get(path) ?? new Set()).add(tag));
        }
    }
    return byPath;
}

/** Every [bucket, tag, path] finding: scanned rows in scan order, then the missing rows of live memories. */
function rowFindings(snapshot: Snapshot, rowTags: Map<string, Set<string>>, nowSeconds: number): [BucketName, string, string][] {
    const found: [BucketName, string, string][] = [];
    for(const [tag, rows] of snapshot.rows) {
        for(const row of rows) {
            const bucket = classifyRow(snapshot, tag, row, nowSeconds);
            if(bucket !== undefined) {
                found.push([bucket, tag, row.SK.slice(5)]);
            }
        }
    }
    for(const memory of snapshot.memories.values()) {
        const tags = isLive(memory, nowSeconds) ? [...normalizeTags(memory.tags)] : [];
        for(const tag of tags.filter(candidate => !rowTags.get(memory.path)?.has(candidate))) {
            found.push(['missing', tag, memory.path]);
        }
    }
    return found;
}

/** Tags whose META is wrong: count ≠ rows without a TTL, wrong GSI2 keys, META with no rows or rows with no META. */
function metaDriftTags(snapshot: Snapshot): string[] {
    return [...new Set([...snapshot.rows.keys(), ...snapshot.metas.keys()])]
        .filter(tag => countAction({ n: permanentRows(snapshot.rows.get(tag) ?? []), meta: metaState(tag, snapshot.metas.get(tag)) }) !== undefined);
}

/** Pure: what the repair would change, from an eventually-consistent snapshot. */
export function planRepair(snapshot: Snapshot, nowSeconds: number): Plan {
    const buckets = emptyBuckets();
    const recountTags = new Set<string>();
    const targets = new Set<string>();
    const rowTags = tagsByPath(snapshot);
    let rowWrites = 0;
    for(const [bucket, tag, path] of rowFindings(snapshot, rowTags, nowSeconds)) {
        addToBucket(buckets[bucket], `${tag} :: ${path}`);
        if(bucket !== 'expiredRowLeft') {
            targets.add(path);
            recountTags.add(tag);
            rowWrites++;
        }
    }
    for(const tag of metaDriftTags(snapshot)) {
        addToBucket(buckets.metaDrift, tag);
        recountTags.add(tag);
    }
    const paths = new Map([...targets].map(path => [path, [...rowTags.get(path) ?? []]]));
    return { paths, recount: recountTags, buckets, rowWrites };
}

function readUnits(bytes: number): number {
    return Math.max(1, Math.ceil(bytes / READ_UNIT_BYTES));
}

/**
 * Estimated units for --execute: per path two strong memory reads and one strong row read per
 * tag; per recount tag four strong partition reads (two cycles) and one META write.
 */
export function estimateExecute(snapshot: Snapshot, plan: Plan): Rates {
    let baseRcu = 0;
    // A memory or partition the snapshot lacks still costs a read's one-unit minimum.
    for(const [path, tags] of plan.paths) {
        const memory = snapshot.memories.get(path);
        baseRcu += 2 * (memory === undefined ? 1 : readUnits(Buffer.byteLength(memory.content))) + tags.length + 1;
    }
    for(const tag of plan.recount) {
        const rows = snapshot.rows.get(tag);
        baseRcu += 4 * (rows === undefined ? 1 : readUnits(rows.length * ROW_BYTES));
    }
    return { baseRcu, baseWcu: plan.rowWrites + plan.recount.size, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: plan.recount.size };
}

async function write(ctx: RepairContext, estimate: Units, operation: () => Promise<WriteResult>): Promise<WriteStatus> {
    const result = await paced(ctx, estimate, operation);
    return result.status;
}

async function readMemory(ctx: RepairContext, path: string): Promise<Memory | undefined> {
    const read = await paced(ctx, MEMORY_READ, async () => ctx.store.getMemory(path));
    return read.item;
}

/**
 * Reads the rows {@link BATCH_GET_KEYS} tags per request, each paced and booked at one strong
 * read unit per key, and re-reads unprocessed tags after a 1 s doubling to 30 s backoff.
 */
async function readRows(ctx: RepairContext, path: string, tags: string[]): Promise<Map<string, TagRow>> {
    const rows = new Map<string, TagRow>();
    let pending = tags;
    let delay = FIRST_BACKOFF_MS;
    while(pending.length > 0) {
        const batch = pending.slice(0, BATCH_GET_KEYS);
        // eslint-disable-next-line no-await-in-loop -- sequential: unprocessed tags are re-read after a backoff
        const read = await paced(ctx, { baseRcu: batch.length }, async () => ctx.store.getRows(path, batch));
        for(const row of read.items) {
            rows.set(row.PK.slice(4), row);
        }
        pending = [...read.unprocessed, ...pending.slice(BATCH_GET_KEYS)];
        if(read.unprocessed.length > 0) {
            // eslint-disable-next-line no-await-in-loop -- sequential: backoff before re-reading unprocessed tags
            await ctx.sleep(delay);
            delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        }
    }
    return rows;
}

/** Makes row (tag, path) match `memory` (undefined = gone or expired): delete, put or leave. */
async function repairRow(ctx: RepairContext, memory: Memory | undefined, path: string, tag: string, observed: TagRow | undefined): Promise<WriteStatus | undefined> {
    if(memory === undefined || !normalizeTags(memory.tags).has(tag)) {
        return observed === undefined ? undefined : write(ctx, ROW_WRITE, async () => ctx.store.deleteRow(observed));
    }
    const desired = desiredRow(memory, tag);
    if(observed !== undefined && rowDiff(observed, desired) === undefined) {
        return undefined;
    }
    return write(ctx, ROW_WRITE, async () => ctx.store.putRow(desired, observed ?? 'absent'));
}

/**
 * Repairs every row of one memory from fresh strong reads, then re-reads the memory. Any
 * condition failure or change to the memory redoes the whole attempt from new observations.
 * Returns the tags written or refused, which must be recounted.
 */
export async function repairMemory(ctx: RepairContext, path: string, scannedTags: string[]): Promise<{ settled: boolean, touched: Set<string>, writes: number }> {
    const known = new Set(scannedTags);
    const touched = new Set<string>();
    let writes = 0;
    for(let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const nowSeconds = toEpochSeconds(ctx.now());
        // eslint-disable-next-line no-await-in-loop -- sequential: each attempt starts from fresh observations
        const before = await readMemory(ctx, path);
        for(const tag of normalizeTags(before?.tags)) {
            known.add(tag);
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: each attempt starts from fresh observations
        const rows = await readRows(ctx, path, [...known]);
        const memory = isLive(before, nowSeconds) ? before : undefined;
        let clean = true;
        for(const tag of known) {
            // eslint-disable-next-line no-await-in-loop -- sequential: paced conditional writes
            const status = await repairRow(ctx, memory, path, tag, rows.get(tag));
            if(status !== undefined) {
                touched.add(tag);
                writes++;
                clean &&= status === 'ok';
            }
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: verifies this attempt
        const after = await readMemory(ctx, path);
        if(clean && sameMemoryState(before, after, nowSeconds)) {
            return { settled: true, touched, writes };
        }
    }
    return { settled: false, touched, writes };
}

/** One strong read of a tag partition: its rows without a TTL and its META. */
export async function readCount(ctx: RepairContext, tag: string): Promise<CountState> {
    let n = 0;
    let meta: Meta | undefined;
    await drain(ctx, STRONG_PARTITION, async start => ctx.store.readTagPartition(tag, start, true), (page) => {
        n += permanentRows(page.rows);
        meta = page.meta ?? meta;
    });
    return { n, meta: metaState(tag, meta) };
}

function sameCount(a: CountState, b: CountState): boolean {
    return a.n === b.n && a.meta?.count === b.meta?.count && a.meta?.keys === b.meta?.keys;
}

async function applyCount(ctx: RepairContext, tag: string, action: CountAction): Promise<WriteStatus> {
    return write(ctx, META_WRITE, async () => (action.kind === 'set'
        ? ctx.store.setMeta(tag, action.count, action.expected)
        : ctx.store.deleteMeta(tag, action.expected)));
}

interface FirstRead {
    tag:   string
    state: CountState
}

/**
 * Takes read2 of one tag, after the cycle's settle wait. Returns 'done' for a stable, correct
 * tag, 'wrote' after a META write for a stable, wrong one, and 'pending' otherwise.
 */
async function settleTag(ctx: RepairContext, read1: FirstRead, verifyOnly: boolean): Promise<'done' | 'wrote' | 'pending'> {
    const read2 = await readCount(ctx, read1.tag);
    const action = countAction(read2);
    if(!sameCount(read1.state, read2)) {
        return 'pending';
    }
    if(action === undefined) {
        return 'done';
    }
    if(verifyOnly) {
        return 'pending';
    }
    await applyCount(ctx, read1.tag, action);
    return 'wrote';
}

/**
 * Settle-checked recount. Each cycle reads every pending tag (read1) in a pool, waits `settleMs`
 * ONCE after the last read1 finished, then reads each tag again (read2) in a pool, so every read2
 * follows its own read1 by at least `settleMs`. A tag whose reads differ has a live writer and is
 * left for the next cycle; a stable, correct tag is done; a stable, wrong tag gets a META write
 * conditioned on the count it read and is checked again next cycle. {@link WRITE_CYCLES} write
 * cycles are followed by one read-only verify cycle; the tags still pending are unsettled.
 */
export async function recount(ctx: RepairContext, tags: Set<string>, settleMs: number): Promise<{ unsettled: string[], writes: number }> {
    let pending = [...tags];
    let writes = 0;
    for(let cycle = 1; cycle <= WRITE_CYCLES + 1 && pending.length > 0; cycle++) {
        const verifyOnly = cycle > WRITE_CYCLES;
        ctx.log(`Recount cycle ${cycle}${verifyOnly ? ' (verify only)' : ''}: ${pending.length} tags`);
        // eslint-disable-next-line no-await-in-loop -- sequential: each cycle starts from the previous cycle's outcome
        const first = await mapPool(ctx, `Recount cycle ${cycle} first reads`, pending, async tag => ({ tag, state: await readCount(ctx, tag) }));
        // eslint-disable-next-line no-await-in-loop -- sequential: one settle wait per cycle, after the last read1
        await ctx.sleep(settleMs);
        // eslint-disable-next-line no-await-in-loop -- sequential: read2 follows the settle wait
        const outcomes = await mapPool(ctx, `Recount cycle ${cycle} second reads`, first, async read1 => settleTag(ctx, read1, verifyOnly));
        pending = first.filter((_, index) => outcomes[index] !== 'done').map(read1 => read1.tag);
        writes += outcomes.filter(outcome => outcome === 'wrote').length;
    }
    return { unsettled: pending, writes };
}

/**
 * Repairs the planned memories in a pool (each memory touches only its own rows; META is written
 * only by the recount), then recounts every planned or touched tag. Abort gives a partial result.
 */
export async function executeRepair(ctx: RepairContext, plan: Plan, settleMs: number): Promise<RepairResult> {
    const result: RepairResult = { repaired: 0, unsettledPaths: [], unsettledTags: [], rowWrites: 0, metaWrites: 0, aborted: false };
    const recountTags = new Set(plan.recount);
    try {
        await runPool(ctx, 'Repair memories', [...plan.paths], async ([path, tags]) => {
            const outcome = await repairMemory(ctx, path, tags);
            for(const tag of outcome.touched) {
                recountTags.add(tag);
            }
            if(!outcome.settled) {
                result.unsettledPaths.push(path);
            }
            result.rowWrites += outcome.writes;
            result.repaired++;
        });
        const counted = await recount(ctx, recountTags, settleMs);
        result.unsettledTags = counted.unsettled;
        result.metaWrites = counted.writes;
    } catch (error) {
        if(!isAbortError(error)) {
            throw error;
        }
        result.aborted = true;
    }
    return result;
}

/** A request waiting in the pacing queue: the milliseconds it occupies each resource it names. */
interface Waiter {
    costs: [RateKey, number][]
    turn:  PromiseWithResolvers<void>
}

/**
 * Per-resource pacing by a shared queue. Each resource has a free time: when the units already
 * let through on it have been paid for at its rate. A request waits in FIFO order until every
 * resource it names is free and no longer held, and only then is charged, moving each free time
 * on by units / rate. Its turn is decided when it goes, not when it queued, so everything that
 * happens meanwhile applies to the requests already waiting: `trueUp` moves the free time by
 * (actual - estimate) / rate after a response (an underestimate delays them, an overestimate is
 * refunded to them), and `backoff` holds a throttled resource for them all, the retry of the
 * throttled request included. A request never overtakes an earlier one on a resource they share,
 * but is not held back by requests waiting on other resources. Each resource therefore sends at
 * most its rate plus the units of the requests in flight whose true-up has yet to come. The abort
 * or `cancel` refuses every queued and later request at once.
 */
export function createPacing(rates: Rates, sleep: (ms: number) => Promise<void>, now: () => number, signal: AbortSignal): Pacing {
    const consumed: Rates = { baseRcu: 0, baseWcu: 0, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: 0 };
    // No resource starts booked or held, whatever the clock reads: the first request goes at once.
    const free = Number.NEGATIVE_INFINITY;
    const freeAt: Rates = { baseRcu: free, baseWcu: free, gsi1Rcu: free, gsi2Rcu: free, gsi2Wcu: free };
    const heldUntil: Rates = { ...freeAt };
    const queue: Waiter[] = [];
    /** The times of the wake-ups already scheduled. */
    const wakes = new Set<number>();
    const halt = new AbortController();
    const stopped = AbortSignal.any([signal, halt.signal]);
    stopped.addEventListener('abort', () => {
        for(const waiter of queue.splice(0)) {
            waiter.turn.reject(stopped.reason);
        }
    });

    const wakeAt = (at: number): void => {
        if([...wakes].some(wake => wake <= at)) {
            return;
        }
        wakes.add(at);
        void (async () => {
            await sleep(at - now());
            wakes.delete(at);
            pump();
        })();
    };

    /** Lets through every waiter whose turn has come, and wakes up for the next one. */
    function pump(): void {
        const at = now();
        const blocked = new Set<RateKey>();
        let next = Number.POSITIVE_INFINITY;
        const due: Waiter[] = [];
        for(const waiter of queue) {
            const keys = waiter.costs.map(([key]) => key);
            const first = !keys.some(key => blocked.has(key));
            const start = Math.max(...keys.flatMap(key => [freeAt[key], heldUntil[key]]));
            if(first && start <= at) {
                due.push(waiter);
                for(const [key, ms] of waiter.costs) {
                    freeAt[key] = at + ms;
                }
            } else {
                if(first) {
                    next = Math.min(next, start);
                }
                for(const key of keys) {
                    blocked.add(key);
                }
            }
        }
        letThrough(due);
        if(next < Number.POSITIVE_INFINITY) {
            wakeAt(next);
        }
    }

    function letThrough(due: Waiter[]): void {
        for(const waiter of due) {
            queue.splice(queue.indexOf(waiter), 1);
            waiter.turn.resolve();
        }
    }

    const enqueue = async (costs: Waiter['costs']): Promise<void> => {
        const turn = Promise.withResolvers<void>();
        if(stopped.aborted) {
            turn.reject(stopped.reason);
        } else {
            queue.push({ costs, turn });
            pump();
        }
        return turn.promise;
    };

    return {
        consumed,
        async reserve(estimate) {
            const keys = RATE_KEYS.filter(key => (estimate[key] ?? 0) > 0);
            return enqueue(keys.map(key => [key, (estimate[key] ?? 0) * 1000 / rates[key]]));
        },
        trueUp(estimate, actual) {
            for(const key of RATE_KEYS) {
                const amount = actual[key] ?? 0;
                freeAt[key] = Math.max(now(), freeAt[key]) + ((amount - (estimate[key] ?? 0)) * 1000 / rates[key]);
                consumed[key] += amount;
            }
            pump();
        },
        async backoff(keys, ms) {
            for(const key of keys) {
                heldUntil[key] = Math.max(heldUntil[key], now() + ms);
            }
            return enqueue(keys.map(key => [key, 0]));
        },
        cancel(reason) {
            halt.abort(reason);
        },
    };
}

/**
 * Enough workers to keep the fastest resource busy: the cheapest request is an eventually
 * consistent read of 0.5 units, so R units/s admit up to 2R requests/s, and covering each one's
 * round trip takes 2R x {@link ASSUMED_LATENCY_MS} workers. At the free-tier defaults that is 1;
 * at --boost 50 (fastest rate 49/s) it is 30. Extra workers only wait on pacing.
 */
export function defaultConcurrency(rates: Rates): number {
    const fastest = Math.max(...RATE_KEYS.map(key => rates[key]));
    return Math.min(DEFAULT_CONCURRENCY_CAP, Math.ceil(fastest * 2 * ASSUMED_LATENCY_MS / 1000));
}

function describeRate(key: RateKey, used: number, seconds: number): string {
    return `, ${key} ${used.toFixed(1)} (${(used / seconds).toFixed(1)}/s)`;
}

/**
 * Phase progress: at most every {@link PROGRESS_MS}, logs the items done of the phase's total,
 * the units each resource consumed in the phase and at what rate, and the ETA from the pace so far.
 */
export function createProgress(now: () => number, log: (text: string) => void, consumed: Rates): Progress {
    const start = (label: string, total: number): { label: string, total: number, finished: number, startedAt: number, loggedAt: number, base: Rates } => {
        const at = now();
        return { label, total, finished: 0, startedAt: at, loggedAt: at, base: { ...consumed } };
    };
    let current = start('Starting', 0);
    return {
        phase(label, total) {
            current = start(label, total);
        },
        done() {
            current.finished++;
        },
        poke() {
            const at = now();
            if(at - current.loggedAt < PROGRESS_MS) {
                return;
            }
            current.loggedAt = at;
            const { label, total, finished, base } = current;
            const seconds = (at - current.startedAt) / 1000;
            const units = RATE_KEYS.filter(key => consumed[key] > base[key]).map(key => describeRate(key, consumed[key] - base[key], seconds)).join('');
            const eta = finished > 0 ? `, ETA ${Math.round(seconds * (total - finished) / finished)} s` : '';
            log(`${label}: ${finished}/${total} in ${Math.round(seconds)} s${units}${eta}`);
        },
    };
}

/** Epoch seconds, the unit of DynamoDB TTL, for an epoch-milliseconds clock reading. */
export function toEpochSeconds(ms: number): number {
    return ms / 1000;
}
