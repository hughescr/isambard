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

/** Everything the repair needs besides its inputs. `now` is epoch milliseconds. */
export interface RepairContext {
    store:  RepairStore
    charge: (units: Units) => Promise<void>
    sleep:  (ms: number) => Promise<void>
    now:    () => number
    log:    (text: string) => void
    signal: AbortSignal
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
export const PROGRESS_EVERY = 100;
/** Assumed stored size of one tag row, for estimates only. */
export const ROW_BYTES = 512;
const READ_UNIT_BYTES = 4096;
const TAG_COUNTS = 'TAG_COUNTS';

export function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

/** A memory is live while it exists and its TTL, if any, is still in the future. */
export function isLive(memory: Memory | undefined, nowSeconds: number): memory is Memory {
    return memory !== undefined && (memory.TTL === undefined || memory.TTL > nowSeconds);
}

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

/** Reads every page of `fetch`, charging each page's units before the next request. */
async function drain<P extends { next: Cursor, units: Units }>(ctx: RepairContext, fetch: (start: Cursor) => Promise<P>, visit: (page: P) => void): Promise<void> {
    let start: Cursor;
    do {
        ctx.signal.throwIfAborted();
        // eslint-disable-next-line no-await-in-loop -- sequential: each page starts from the previous page's cursor
        const page = await fetch(start);
        // eslint-disable-next-line no-await-in-loop -- sequential: pacing must follow each request
        await ctx.charge(page.units);
        visit(page);
        start = page.next;
    } while(start !== undefined);
}

/**
 * Enumerates the tag index eventually-consistently: GSI2 META rows, their partitions, every
 * searchable namespace plus the namespaces seen in rows on GSI1, then the partitions of tags that
 * memories carry but GSI2 did not list (tags without META, or META whose GSI2 keys are wrong).
 */
export async function scan(ctx: RepairContext): Promise<Snapshot> {
    const snapshot: Snapshot = { memories: new Map(), rows: new Map(), metas: new Map() };
    await drain(ctx, async start => ctx.store.listMetaCounts(start), (page) => {
        for(const meta of page.items) {
            snapshot.metas.set(meta.PK.slice(4), meta);
        }
    });
    const readPartition = async (tag: string): Promise<void> => {
        const rows: TagRow[] = [];
        await drain(ctx, async start => ctx.store.readTagPartition(tag, start, false), (page) => {
            rows.push(...page.rows);
            if(page.meta !== undefined) {
                snapshot.metas.set(tag, page.meta);
            }
        });
        snapshot.rows.set(tag, rows);
    };
    for(const tag of snapshot.metas.keys()) {
        // eslint-disable-next-line no-await-in-loop -- sequential: paced reads
        await readPartition(tag);
    }
    ctx.log(`Scanned ${snapshot.rows.size} tag partitions`);
    const rowNamespaces = [...snapshot.rows.values()].flat().map(row => namespaceOf(row.SK.slice(5)));
    const namespaces = new Set([...SEARCHABLE_NAMESPACE_VALUES, ...rowNamespaces].filter(namespace => namespace !== ''));
    for(const namespace of namespaces) {
        // eslint-disable-next-line no-await-in-loop -- sequential: paced reads
        await drain(ctx, async start => ctx.store.walkNamespace(namespace, start), (page) => {
            for(const memory of page.items) {
                snapshot.memories.set(memory.path, memory);
            }
        });
    }
    ctx.log(`Walked ${snapshot.memories.size} memories in ${namespaces.size} namespaces`);
    for(const memory of snapshot.memories.values()) {
        for(const tag of normalizeTags(memory.tags)) {
            if(!snapshot.rows.has(tag)) {
                // eslint-disable-next-line no-await-in-loop -- sequential: paced reads
                await readPartition(tag);
            }
        }
    }
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
    for(const [path, tags] of plan.paths) {
        const content = snapshot.memories.get(path)?.content ?? '';
        baseRcu += 2 * readUnits(Buffer.byteLength(content)) + tags.length + 1;
    }
    for(const tag of plan.recount) {
        baseRcu += 4 * readUnits((snapshot.rows.get(tag)?.length ?? 0) * ROW_BYTES);
    }
    return { baseRcu, baseWcu: plan.rowWrites + plan.recount.size, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: plan.recount.size };
}

async function write(ctx: RepairContext, operation: () => Promise<WriteResult>): Promise<WriteStatus> {
    ctx.signal.throwIfAborted();
    const result = await operation();
    await ctx.charge(result.units);
    return result.status;
}

async function readMemory(ctx: RepairContext, path: string): Promise<Memory | undefined> {
    ctx.signal.throwIfAborted();
    const read = await ctx.store.getMemory(path);
    await ctx.charge(read.units);
    return read.item;
}

/**
 * Reads the rows {@link BATCH_GET_KEYS} tags per request, charging and checking for abort around
 * every request, and re-reads unprocessed tags after a 1 s doubling to 30 s backoff.
 */
async function readRows(ctx: RepairContext, path: string, tags: string[]): Promise<Map<string, TagRow>> {
    const rows = new Map<string, TagRow>();
    let pending = tags;
    let delay = FIRST_BACKOFF_MS;
    while(pending.length > 0) {
        ctx.signal.throwIfAborted();
        // eslint-disable-next-line no-await-in-loop -- sequential: each request is charged before the next
        const read = await ctx.store.getRows(path, pending.slice(0, BATCH_GET_KEYS));
        // eslint-disable-next-line no-await-in-loop -- sequential: each request is charged before the next
        await ctx.charge(read.units);
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
        return observed === undefined ? undefined : write(ctx, async () => ctx.store.deleteRow(observed));
    }
    const desired = desiredRow(memory, tag);
    if(observed !== undefined && rowDiff(observed, desired) === undefined) {
        return undefined;
    }
    return write(ctx, async () => ctx.store.putRow(desired, observed ?? 'absent'));
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
    await drain(ctx, async start => ctx.store.readTagPartition(tag, start, true), (page) => {
        n += permanentRows(page.rows);
        meta = page.meta ?? meta;
    });
    return { n, meta: metaState(tag, meta) };
}

function sameCount(a: CountState, b: CountState): boolean {
    return a.n === b.n && a.meta?.count === b.meta?.count && a.meta?.keys === b.meta?.keys;
}

async function applyCount(ctx: RepairContext, tag: string, action: CountAction): Promise<WriteStatus> {
    return write(ctx, async () => (action.kind === 'set'
        ? ctx.store.setMeta(tag, action.count, action.expected)
        : ctx.store.deleteMeta(tag, action.expected)));
}

interface FirstRead {
    tag:   string
    state: CountState
    at:    number
}

/**
 * Takes read2 of one tag no earlier than `settleMs` after its read1. Returns 'done' for a stable,
 * correct tag, 'wrote' after a META write for a stable, wrong one, and 'pending' otherwise.
 */
async function settleTag(ctx: RepairContext, read1: FirstRead, settleMs: number, verifyOnly: boolean): Promise<'done' | 'wrote' | 'pending'> {
    const wait = read1.at + settleMs - ctx.now();
    if(wait > 0) {
        await ctx.sleep(wait);
    }
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
 * Settle-checked recount. Each cycle reads every pending tag (read1), then reads each again no
 * earlier than `settleMs` after its read1 (read2). A tag whose reads differ has a live writer and
 * is left for the next cycle; a stable, correct tag is done; a stable, wrong tag gets a META write
 * conditioned on the count it read and is checked again next cycle. {@link WRITE_CYCLES} write
 * cycles are followed by one read-only verify cycle; the tags still pending are unsettled.
 */
export async function recount(ctx: RepairContext, tags: Set<string>, settleMs: number): Promise<{ unsettled: string[], writes: number }> {
    let pending = [...tags];
    let writes = 0;
    for(let cycle = 1; cycle <= WRITE_CYCLES + 1 && pending.length > 0; cycle++) {
        const verifyOnly = cycle > WRITE_CYCLES;
        ctx.log(`Recount cycle ${cycle}${verifyOnly ? ' (verify only)' : ''}: ${pending.length} tags`);
        const first: FirstRead[] = [];
        for(const tag of pending) {
            // eslint-disable-next-line no-await-in-loop -- sequential: paced reads
            const state = await readCount(ctx, tag);
            first.push({ tag, state, at: ctx.now() });
        }
        const next: string[] = [];
        for(const read1 of first) {
            // eslint-disable-next-line no-await-in-loop -- sequential: each read2 follows its read1 by the settle interval
            const outcome = await settleTag(ctx, read1, settleMs, verifyOnly);
            if(outcome !== 'done') {
                next.push(read1.tag);
            }
            writes += outcome === 'wrote' ? 1 : 0;
        }
        pending = next;
    }
    return { unsettled: pending, writes };
}

/** Repairs every planned memory, then recounts every planned or touched tag. Abort gives a partial result. */
export async function executeRepair(ctx: RepairContext, plan: Plan, settleMs: number): Promise<RepairResult> {
    const result: RepairResult = { repaired: 0, unsettledPaths: [], unsettledTags: [], rowWrites: 0, metaWrites: 0, aborted: false };
    const recountTags = new Set(plan.recount);
    try {
        for(const [path, tags] of plan.paths) {
            // eslint-disable-next-line no-await-in-loop -- sequential: paced repair, one memory at a time
            const outcome = await repairMemory(ctx, path, tags);
            for(const tag of outcome.touched) {
                recountTags.add(tag);
            }
            if(!outcome.settled) {
                result.unsettledPaths.push(path);
            }
            result.rowWrites += outcome.writes;
            result.repaired++;
            if(result.repaired % PROGRESS_EVERY === 0) {
                ctx.log(`Repaired ${result.repaired}/${plan.paths.size} memories`);
            }
        }
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

/**
 * Per-resource pacing, the same debt model as src/storage/utils/rcu-pacing.ts: each request's
 * reported units push that resource's next allowed time out by units / rate seconds, and after
 * each request the caller waits until every resource is back within its rate.
 */
export function createPacing(rates: Rates, sleep: (ms: number) => Promise<void>, now: () => number): { charge: (units: Units) => Promise<void>, consumed: Rates } {
    const consumed: Rates = { baseRcu: 0, baseWcu: 0, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: 0 };
    const nextAllowedAt: Rates = { baseRcu: 0, baseWcu: 0, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: 0 };
    const charge = async (units: Units): Promise<void> => {
        for(const key of RATE_KEYS) {
            const amount = units[key] ?? 0;
            nextAllowedAt[key] = Math.max(now(), nextAllowedAt[key]) + (amount * 1000 / rates[key]);
            consumed[key] += amount;
        }
        for(const key of RATE_KEYS) {
            const wait = nextAllowedAt[key] - now();
            if(wait > 0) {
                // eslint-disable-next-line no-await-in-loop -- sequential: waits out each resource's debt in turn
                await sleep(wait);
            }
        }
    };
    return { charge, consumed };
}

/** Epoch seconds, the unit of DynamoDB TTL, for an epoch-milliseconds clock reading. */
export function toEpochSeconds(ms: number): number {
    return ms / 1000;
}
