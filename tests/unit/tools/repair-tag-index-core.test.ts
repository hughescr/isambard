import { describe, test, expect, afterEach, jest } from 'bun:test';
import { BatchWriteCommand, DeleteCommand, QueryCommand, UpdateCommand, type BatchWriteCommandInput, type DeleteCommandInput, type DynamoDBDocumentClient, type QueryCommandInput, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { MemoryToolBackendTagIndex } from '../../../src/storage/memory-tool/backend-tag-index';
import { createIndexLayer, type MemoryPath } from '../../../src/storage/memory-tool/types';
import {
    countAction,
    createPacing,
    desiredRow,
    estimateExecute,
    executeRepair,
    isAbortError,
    isLive,
    planRepair,
    readCount,
    recount,
    repairMemory,
    rowDiff,
    sameMemoryState,
    scan,
    type Cursor,
    type Memory,
    type Meta,
    type Page,
    type PartitionPage,
    type Plan,
    type RepairContext,
    type RepairStore,
    type Snapshot,
    type TagRow,
    type Units,
    type WriteResult
} from '../../../tools/repair-tag-index-core';

const NOW_MS = 2_000_000_000_000;
const NOW_S = NOW_MS / 1000;
const FUTURE = NOW_S + 1000;
const PAST = NOW_S - 1000;
const UPDATED = '2026-01-01T00:00:00.000Z';
const PAGE_SIZE = 2;

afterEach(() => {
    jest.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// In-memory table shared by the fake RepairStore and the fake document client the real
// MemoryToolBackendTagIndex runs against.
// ---------------------------------------------------------------------------------------------

interface Table {
    memories: Map<string, Memory>
    rows:     Map<string, TagRow>
    metas:    Map<string, Meta>
}

function newTable(): Table {
    return { memories: new Map(), rows: new Map(), metas: new Map() };
}

function rowKey(tag: string, path: string): string {
    return `${tag}|${path}`;
}

function memory(path: string, tags: string[], extra: Partial<Memory> = {}): Memory {
    return { path, tags: new Set(tags), updatedAt: UPDATED, content: `content of ${path}`, ...extra };
}

function putMemory(table: Table, item: Memory): void {
    table.memories.set(item.path, item);
}

function putRow(table: Table, row: TagRow): void {
    table.rows.set(rowKey(row.PK.slice(4), row.SK.slice(5)), structuredClone(row));
}

/** Stores the rows the live writer would store for `item`, TTL included. */
function putDesiredRows(table: Table, item: Memory): void {
    for(const tag of item.tags ?? []) {
        putRow(table, desiredRow(item, tag));
    }
}

function meta(tag: string, count: number | undefined, keys = true): Meta {
    return { PK: `TAG#${tag}`, SK: 'META_COUNT', ...(count === undefined ? {} : { count }), ...(keys ? { GSI2PK: 'TAG_COUNTS', GSI2SK: `TAG#${tag}` } : {}) };
}

function putMeta(table: Table, item: Meta): void {
    table.metas.set(item.PK.slice(4), item);
}

function rowsOf(table: Table, tag: string): TagRow[] {
    return [...table.rows.values()].filter(row => row.PK === `TAG#${tag}`).toSorted((a, b) => a.SK.localeCompare(b.SK));
}

function sameRow(a: TagRow, b: TagRow): boolean {
    const tagsEqual = a.tags === undefined || b.tags === undefined ? a.tags === b.tags : a.tags.size === b.tags.size && [...a.tags].every(tag => b.tags?.has(tag));
    return tagsEqual && a.updatedAt === b.updatedAt && a.layer === b.layer && a.contentPreview === b.contentPreview && a.memoryPath === b.memoryPath && a.TTL === b.TTL;
}

function paged<T>(items: T[], start: Cursor): { slice: T[], next: Cursor } {
    const offset = (start?.offset as number | undefined) ?? 0;
    const end = offset + PAGE_SIZE;
    return { slice: items.slice(offset, end), next: end < items.length ? { offset: end } : undefined };
}

type Hook = (store: FakeStore) => void;

/** Lets `count` microtask turns pass, so a fake's effect lands after its caller could have moved on. */
async function ticks(count: number): Promise<void> {
    for(let turn = 0; turn < count; turn++) {
        // eslint-disable-next-line no-await-in-loop -- sequential: each turn is one microtask
        await Promise.resolve();
    }
}

/** Semantic fake of the adapter: paged reads, conditional writes, a call log and hooks. */
class FakeStore implements RepairStore {
    readonly calls: string[] = [];
    readonly writeHooks = new Map<string, Hook>();
    readonly readHooks = new Map<string, Hook>();
    readonly forceConditionFailed = new Set<string>();
    readonly alwaysConditionFailed = new Set<string>();
    /** The tags each successive getRows leaves unprocessed, as DynamoDB's UnprocessedKeys. */
    readonly unprocessed = new Array<string[]>();
    readCost = 0;
    onEveryRead:    ((call: string) => void) | undefined;
    /** True while a charge or sleep is still settling: the core must await them before its next request. */
    busy:           () => boolean = () => false;

    constructor(readonly table: Table, readonly clock: { now: number } = { now: NOW_MS }) {}

    private guard(call: string): void {
        if(this.busy()) {
            throw new Error(`${call} was sent before the previous charge or sleep settled`);
        }
    }

    private record(call: string): void {
        this.guard(call);
        this.calls.push(call);
        this.readHooks.get(call)?.(this);
        this.readHooks.delete(call);
        this.onEveryRead?.(call);
    }

    private beforeWrite(call: string): boolean {
        this.guard(call);
        this.calls.push(call);
        this.writeHooks.get(call)?.(this);
        this.writeHooks.delete(call);
        return this.forceConditionFailed.delete(call) || this.alwaysConditionFailed.has(call);
    }

    async listMetaCounts(start: Cursor): Promise<Page<Meta>> {
        this.record(`list ${JSON.stringify(start)}`);
        const listed = [...this.table.metas.values()].filter(item => item.GSI2PK === 'TAG_COUNTS' && item.GSI2SK !== undefined);
        const { slice, next } = paged(listed, start);
        return { items: structuredClone(slice), next, units: { gsi2Rcu: 0.5 } };
    }

    async readTagPartition(tag: string, start: Cursor, strong: boolean): Promise<PartitionPage> {
        this.clock.now += this.readCost;
        this.record(`partition ${tag} ${strong ? 'strong' : 'eventual'} ${JSON.stringify(start)}`);
        const found = this.table.metas.get(tag);
        const items: (TagRow | Meta)[] = [...found === undefined ? [] : [found], ...rowsOf(this.table, tag)];
        const { slice, next } = paged(items, start);
        const metaItem = slice.find(item => item.SK === 'META_COUNT');
        return { rows: structuredClone(slice.filter(item => item.SK !== 'META_COUNT')), meta: structuredClone(metaItem), next, units: { baseRcu: 1 } };
    }

    async walkNamespace(namespace: string, start: Cursor): Promise<Page<Memory>> {
        this.record(`walk ${namespace} ${JSON.stringify(start)}`);
        const found = [...this.table.memories.values()].filter(item => item.path.split('/')[1] === namespace);
        const { slice, next } = paged(found, start);
        return { items: structuredClone(slice), next, units: { gsi1Rcu: 1 } };
    }

    async getMemory(path: string): Promise<{ item: Memory | undefined, units: Units }> {
        this.record(`getMemory ${path}`);
        return { item: structuredClone(this.table.memories.get(path)), units: { baseRcu: 1 } };
    }

    async getRows(path: string, tags: string[]): Promise<{ items: TagRow[], unprocessed: string[], units: Units }> {
        this.record(`getRows ${path} ${tags.join(',')}`);
        const skipped = this.unprocessed.shift() ?? [];
        const read = tags.filter(tag => !skipped.includes(tag));
        const items = read.map(tag => this.table.rows.get(rowKey(tag, path))).filter(row => row !== undefined);
        return { items: structuredClone(items), unprocessed: skipped, units: { baseRcu: read.length } };
    }

    async putRow(row: TagRow, observed: TagRow | 'absent'): Promise<WriteResult> {
        const tag = row.PK.slice(4);
        const path = row.SK.slice(5);
        const forced = this.beforeWrite(`putRow ${tag} ${path} ${observed === 'absent' ? 'absent' : 'observed'}`);
        const current = this.table.rows.get(rowKey(tag, path));
        const holds = observed === 'absent' ? current === undefined : current !== undefined && sameRow(current, observed);
        if(forced || !holds) {
            return { status: 'conditionFailed', units: { baseWcu: 1 } };
        }
        putRow(this.table, row);
        return { status: 'ok', units: { baseWcu: 1 } };
    }

    async deleteRow(observed: TagRow): Promise<WriteResult> {
        const tag = observed.PK.slice(4);
        const path = observed.SK.slice(5);
        const forced = this.beforeWrite(`deleteRow ${tag} ${path}`);
        const current = this.table.rows.get(rowKey(tag, path));
        if(forced || current === undefined || !sameRow(current, observed)) {
            return { status: 'conditionFailed', units: { baseWcu: 1 } };
        }
        this.table.rows.delete(rowKey(tag, path));
        return { status: 'ok', units: { baseWcu: 1 } };
    }

    async setMeta(tag: string, count: number, expected: number | undefined): Promise<WriteResult> {
        const forced = this.beforeWrite(`setMeta ${tag} ${count} ${String(expected)}`);
        if(forced || this.table.metas.get(tag)?.count !== expected) {
            return { status: 'conditionFailed', units: { baseWcu: 1 } };
        }
        putMeta(this.table, meta(tag, count));
        return { status: 'ok', units: { baseWcu: 1, gsi2Wcu: 1 } };
    }

    async deleteMeta(tag: string, expected: number | undefined): Promise<WriteResult> {
        const forced = this.beforeWrite(`deleteMeta ${tag} ${String(expected)}`);
        if(forced || this.table.metas.get(tag)?.count !== expected) {
            return { status: 'conditionFailed', units: { baseWcu: 1 } };
        }
        this.table.metas.delete(tag);
        return { status: 'ok', units: { baseWcu: 1, gsi2Wcu: 1 } };
    }
}

interface Harness {
    ctx:     RepairContext
    store:   FakeStore
    table:   Table
    clock:   { now: number }
    logs:    string[]
    sleeps:  number[]
    charges: Units[]
    abort:   AbortController
}

function harness(table: Table = newTable(), onSleep: (ms: number) => void = () => undefined): Harness {
    const clock = { now: NOW_MS };
    const store = new FakeStore(table, clock);
    const logs: string[] = [];
    const sleeps: number[] = [];
    const charges: Units[] = [];
    const abort = new AbortController();
    let settling = 0;
    store.busy = () => settling > 0;
    const ctx: RepairContext = {
        store,
        charge: async (units) => {
            settling++;
            await ticks(3);
            settling--;
            charges.push(units);
        },
        sleep: async (ms) => {
            sleeps.push(ms);
            settling++;
            await ticks(3);
            settling--;
            clock.now += ms;
            onSleep(ms);
        },
        now:    () => clock.now,
        log:    (text) => { logs.push(text); },
        signal: abort.signal,
    };
    return { ctx, store, table, clock, logs, sleeps, charges, abort };
}

function applyBatchWrite(table: Table, input: BatchWriteCommandInput): object {
    for(const request of Object.values(input.RequestItems ?? {}).flat()) {
        if(request.PutRequest) {
            putRow(table, request.PutRequest.Item as TagRow);
        } else {
            const key = request.DeleteRequest?.Key as { PK: string, SK: string };
            table.rows.delete(rowKey(key.PK.slice(4), key.SK.slice(5)));
        }
    }
    return {};
}

function applyCounterUpdate(table: Table, input: UpdateCommandInput): object {
    const tag = (input.Key as { PK: string }).PK.slice(4);
    const current = table.metas.get(tag)?.count ?? 0;
    const count = input.UpdateExpression?.includes('if_not_exists') ? current + 1 : current - 1;
    putMeta(table, meta(tag, count));
    return { Attributes: { count } };
}

function applyMetaDelete(table: Table, input: DeleteCommandInput): object {
    const tag = (input.Key as { PK: string }).PK.slice(4);
    if((table.metas.get(tag)?.count ?? 0) <= 0) {
        table.metas.delete(tag);
    }
    return {};
}

function answerQuery(table: Table, input: QueryCommandInput): object {
    if(input.IndexName === 'GSI2') {
        return { Items: [...table.metas.values()].filter(item => item.GSI2PK === 'TAG_COUNTS') };
    }
    const pk = input.ExpressionAttributeValues?.[':pk'] as string;
    return { Items: rowsOf(table, pk.slice(4)) };
}

/** A fake DocumentClient over the same table for the commands the live tag-index writer sends. */
function fakeDocClient(table: Table, gate?: { reached: () => void, release: Promise<void> }): DynamoDBDocumentClient {
    const send = async (command: unknown): Promise<unknown> => {
        if(command instanceof UpdateCommand) {
            gate?.reached();
            await gate?.release;
            return applyCounterUpdate(table, command.input);
        }
        if(command instanceof BatchWriteCommand) {
            return applyBatchWrite(table, command.input);
        }
        if(command instanceof DeleteCommand) {
            return applyMetaDelete(table, command.input);
        }
        if(command instanceof QueryCommand) {
            return answerQuery(table, command.input);
        }
        throw new Error('unexpected command');
    };
    return { send } as unknown as DynamoDBDocumentClient;
}

// ---------------------------------------------------------------------------------------------

describe('repair-tag-index core predicates', () => {
    test('isLive is false for a missing memory', () => {
        expect(isLive(undefined, NOW_S)).toBe(false);
    });

    test('isLive is true for a memory without TTL', () => {
        expect(isLive(memory('/identity/a', []), NOW_S)).toBe(true);
    });

    test('isLive is true only while the TTL is in the future', () => {
        expect(isLive(memory('/events/a', [], { TTL: NOW_S + 1 }), NOW_S)).toBe(true);
        expect(isLive(memory('/events/a', [], { TTL: NOW_S }), NOW_S)).toBe(false);
        expect(isLive(memory('/events/a', [], { TTL: NOW_S - 1 }), NOW_S)).toBe(false);
    });

    test('isAbortError accepts only an AbortError DOMException', () => {
        expect(isAbortError(new DOMException('stop', 'AbortError'))).toBe(true);
        expect(isAbortError(new DOMException('stop', 'TimeoutError'))).toBe(false);
        expect(isAbortError(Object.assign(new Error('stop'), { name: 'AbortError' }))).toBe(false);
    });

    test('desiredRow matches the live writer row shape with the memory TTL', () => {
        const item = memory('/users/u1/notes.md', ['Alpha', 'beta'], { TTL: FUTURE, content: 'x'.repeat(150) });
        expect(desiredRow(item, 'alpha')).toStrictEqual({
            PK:             'TAG#alpha',
            SK:             'PATH#/users/u1/notes.md',
            memoryPath:     '/users/u1/notes.md',
            layer:          createIndexLayer('users'),
            updatedAt:      UPDATED,
            tags:           new Set(['alpha', 'beta']),
            contentPreview: 'x'.repeat(100),
            TTL:            FUTURE,
        });
    });

    test('desiredRow omits TTL for a permanent memory', () => {
        expect(desiredRow(memory('/identity/core.md', ['a'], { content: 'hello' }), 'a')).toStrictEqual({
            PK:             'TAG#a',
            SK:             'PATH#/identity/core.md',
            memoryPath:     '/identity/core.md',
            layer:          createIndexLayer('identity'),
            updatedAt:      UPDATED,
            tags:           new Set(['a']),
            contentPreview: 'hello',
        });
    });

    test('rowDiff reports the first difference in priority order', () => {
        const desired = desiredRow(memory('/identity/a', ['x', 'y'], { TTL: FUTURE }), 'x');
        expect(rowDiff({ ...desired }, desired)).toBeUndefined();
        expect(rowDiff({ ...desired, TTL: undefined, layer: 'unknown' }, desired)).toBe('ttlStamp');
        expect(rowDiff({ ...desired, tags: new Set(['x']), layer: 'unknown' }, desired)).toBe('staleTags');
        expect(rowDiff({ ...desired, tags: new Set(['x', 'z']) }, desired)).toBe('staleTags');
        expect(rowDiff({ ...desired, tags: undefined }, desired)).toBe('staleTags');
        expect(rowDiff({ ...desired, tags: new Set(['x', 'y', 'z']) }, desired)).toBe('staleTags');
        expect(rowDiff({ ...desired, layer: 'unknown', contentPreview: 'old' }, desired)).toBe('layer');
        expect(rowDiff({ ...desired, contentPreview: 'old', memoryPath: undefined }, desired)).toBe('preview');
        expect(rowDiff({ ...desired, memoryPath: undefined, updatedAt: 'old' }, desired)).toBe('memoryPath');
        expect(rowDiff({ ...desired, updatedAt: 'old' }, desired)).toBe('updatedAtOnly');
    });

    test('sameMemoryState treats two missing or expired reads as the same state', () => {
        expect(sameMemoryState(undefined, undefined, NOW_S)).toBe(true);
        expect(sameMemoryState(undefined, memory('/events/a', [], { TTL: PAST }), NOW_S)).toBe(true);
    });

    test('sameMemoryState detects a memory appearing, disappearing or expiring', () => {
        const live = memory('/events/a', ['x'], { TTL: FUTURE });
        expect(sameMemoryState(undefined, live, NOW_S)).toBe(false);
        expect(sameMemoryState(live, undefined, NOW_S)).toBe(false);
        expect(sameMemoryState(live, { ...live, TTL: PAST }, NOW_S)).toBe(false);
    });

    test('sameMemoryState compares updatedAt, TTL, normalized tags and preview', () => {
        const live = memory('/identity/a', ['x'], { content: 'y'.repeat(100) });
        expect(sameMemoryState(live, { ...live, tags: new Set(['X']), content: `${'y'.repeat(100)}more` }, NOW_S)).toBe(true);
        expect(sameMemoryState(live, { ...live, updatedAt: 'later' }, NOW_S)).toBe(false);
        expect(sameMemoryState(live, { ...live, TTL: FUTURE }, NOW_S)).toBe(false);
        expect(sameMemoryState(live, { ...live, tags: new Set(['x', 'z']) }, NOW_S)).toBe(false);
        expect(sameMemoryState(live, { ...live, tags: new Set(['z']) }, NOW_S)).toBe(false);
        expect(sameMemoryState(live, { ...live, content: 'changed' }, NOW_S)).toBe(false);
    });

    test('countAction leaves an absent META alone when no permanent row exists', () => {
        expect(countAction({ n: 0, meta: undefined })).toBeUndefined();
    });

    test('countAction creates META for permanent rows without one', () => {
        expect(countAction({ n: 2, meta: undefined })).toStrictEqual({ kind: 'set', count: 2, expected: undefined });
    });

    test('countAction deletes META when no permanent row exists', () => {
        expect(countAction({ n: 0, meta: { count: 3, keys: true } })).toStrictEqual({ kind: 'delete', expected: 3 });
    });

    test('countAction accepts a correct count with correct GSI2 keys', () => {
        expect(countAction({ n: 2, meta: { count: 2, keys: true } })).toBeUndefined();
    });

    test('countAction rewrites a correct count whose GSI2 keys are wrong', () => {
        expect(countAction({ n: 2, meta: { count: 2, keys: false } })).toStrictEqual({ kind: 'set', count: 2, expected: 2 });
    });

    test('countAction rewrites a wrong count conditioned on the count read', () => {
        expect(countAction({ n: 2, meta: { count: 5, keys: true } })).toStrictEqual({ kind: 'set', count: 2, expected: 5 });
        expect(countAction({ n: 2, meta: { count: undefined, keys: true } })).toStrictEqual({ kind: 'set', count: 2, expected: undefined });
    });
});

describe('repair-tag-index scan', () => {
    test('scan reads GSI2, partitions, namespaces and unlisted memory tags in order', async () => {
        const table = newTable();
        const a = memory('/identity/a', ['a', 'B']);
        putMemory(table, a);
        putMemory(table, memory('/custom/c', ['c']));
        putDesiredRows(table, a);
        putRow(table, { PK: 'TAG#a', SK: 'PATH#weird' });
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/custom/c' });
        putMeta(table, meta('a', 3));
        putMeta(table, meta('b', 1));
        putMeta(table, meta('z', 0));
        putMeta(table, meta('c', 1, false));
        const h = harness(table);

        const snapshot = await scan(h.ctx);

        expect(h.store.calls).toStrictEqual([
            'list undefined',
            'list {"offset":2}',
            'partition a eventual undefined',
            'partition a eventual {"offset":2}',
            'partition b eventual undefined',
            'partition z eventual undefined',
            'walk identity undefined',
            'walk state undefined',
            'walk events undefined',
            'walk users undefined',
            'walk custom undefined',
            'partition c eventual undefined',
        ]);
        expect([...snapshot.rows.keys()]).toStrictEqual(['a', 'b', 'z', 'c']);
        expect(snapshot.rows.get('a')?.map(row => row.SK)).toStrictEqual(['PATH#/custom/c', 'PATH#/identity/a', 'PATH#weird']);
        expect(snapshot.rows.get('z')).toStrictEqual([]);
        expect(snapshot.metas.get('c')).toStrictEqual(meta('c', 1, false));
        expect([...snapshot.memories.keys()]).toStrictEqual(['/identity/a', '/custom/c']);
        expect(h.charges).toStrictEqual([
            { gsi2Rcu: 0.5 }, { gsi2Rcu: 0.5 }, { baseRcu: 1 }, { baseRcu: 1 }, { baseRcu: 1 }, { baseRcu: 1 },
            { gsi1Rcu: 1 }, { gsi1Rcu: 1 }, { gsi1Rcu: 1 }, { gsi1Rcu: 1 }, { gsi1Rcu: 1 }, { baseRcu: 1 },
        ]);
        expect(h.logs).toStrictEqual(['Scanned 3 tag partitions', 'Walked 2 memories in 5 namespaces', 'Scanned 4 tag partitions in total']);
    });

    test('scan keeps the listed META when an eventual partition read misses it', async () => {
        const table = newTable();
        putMeta(table, meta('a', 1));
        const h = harness(table);
        h.store.readHooks.set('partition a eventual undefined', (store) => {
            store.table.metas.delete('a');
        });

        const snapshot = await scan(h.ctx);

        expect(snapshot.metas.get('a')).toStrictEqual(meta('a', 1));
    });

    test('scan replaces the listed META with the partition copy', async () => {
        const table = newTable();
        putMeta(table, meta('a', 1));
        const h = harness(table);
        h.store.readHooks.set('partition a eventual undefined', (store) => {
            putMeta(store.table, meta('a', 4));
        });

        const snapshot = await scan(h.ctx);

        expect(snapshot.metas.get('a')).toStrictEqual(meta('a', 4));
    });

    test('scan pages GSI1 namespaces', async () => {
        const table = newTable();
        for(const name of ['a', 'b', 'c']) {
            putMemory(table, memory(`/state/${name}`, []));
        }
        const h = harness(table);

        const snapshot = await scan(h.ctx);

        expect(h.store.calls).toContain('walk state {"offset":2}');
        expect(snapshot.memories.size).toBe(3);
    });

    test('scan finds META whose GSI2 keys are missing through the memory walk', async () => {
        const table = newTable();
        const item = memory('/identity/a', ['x']);
        putMemory(table, item);
        putDesiredRows(table, item);
        putMeta(table, meta('x', 1, false));
        const h = harness(table);

        const snapshot = await scan(h.ctx);
        const plan = planRepair(snapshot, NOW_S);

        expect(snapshot.metas.get('x')).toStrictEqual(meta('x', 1, false));
        expect(plan.buckets.metaDrift).toStrictEqual({ count: 1, examples: ['x'] });
        expect([...plan.recount]).toStrictEqual(['x']);
    });

    test('scan stops before any request once aborted', async () => {
        const h = harness();
        h.abort.abort();

        const outcome = scan(h.ctx);

        await expect(outcome).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual([]);
    });
});

function snapshotOf(table: Table): Snapshot {
    const rows = new Map<string, TagRow[]>();
    for(const row of table.rows.values()) {
        const tag = row.PK.slice(4);
        rows.set(tag, [...rows.get(tag) ?? [], structuredClone(row)]);
    }
    return { memories: new Map(table.memories), rows, metas: new Map(table.metas) };
}

describe('repair-tag-index plan', () => {
    test('planRepair buckets every kind of drift and lists the paths to repair', () => {
        const table = newTable();
        const live = memory('/identity/live', ['keep', 'stamp']);
        const expiring = memory('/events/exp', ['stamp'], { TTL: FUTURE });
        const expired = memory('/events/old', ['gone'], { TTL: PAST });
        putMemory(table, live);
        putMemory(table, expiring);
        putMemory(table, expired);
        putRow(table, desiredRow(live, 'keep'));
        putRow(table, { ...desiredRow(live, 'stamp'), tags: new Set(['stamp']) });
        putRow(table, { ...desiredRow(expiring, 'stamp'), TTL: undefined });
        putRow(table, { ...desiredRow(live, 'dropped') });
        putRow(table, desiredRow(expired, 'gone'));
        putRow(table, { ...desiredRow(expired, 'gone'), SK: 'PATH#/events/older', TTL: undefined });
        putRow(table, { ...desiredRow(expired, 'gone'), SK: 'PATH#/events/edge', TTL: NOW_S });
        putMeta(table, meta('keep', 1));
        putMeta(table, meta('stamp', 2));
        putMeta(table, meta('empty', 0));

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan).toStrictEqual({
            paths: new Map([
                ['/identity/live', ['keep', 'stamp', 'dropped']],
                ['/events/exp', ['stamp']],
                ['/events/older', ['gone']],
            ]),
            recount: new Set(['stamp', 'dropped', 'gone', 'empty']),
            buckets: {
                orphan:         { count: 1, examples: ['gone :: /events/older'] },
                removedTag:     { count: 1, examples: ['dropped :: /identity/live'] },
                ttlStamp:       { count: 1, examples: ['stamp :: /events/exp'] },
                staleTags:      { count: 1, examples: ['stamp :: /identity/live'] },
                layer:          { count: 0, examples: [] },
                preview:        { count: 0, examples: [] },
                memoryPath:     { count: 0, examples: [] },
                updatedAtOnly:  { count: 0, examples: [] },
                missing:        { count: 0, examples: [] },
                metaDrift:      { count: 3, examples: ['dropped', 'gone', 'empty'] },
                expiredRowLeft: { count: 2, examples: ['gone :: /events/old', 'gone :: /events/edge'] },
            },
            rowWrites: 4,
        } satisfies Plan);
    });

    test('planRepair puts missing rows of live memories only', () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['X', 'y']));
        putRow(table, desiredRow(memory('/identity/a', ['x', 'y']), 'y'));
        putMemory(table, memory('/events/old', ['x'], { TTL: PAST }));
        putMeta(table, meta('y', 1));

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan.buckets.missing).toStrictEqual({ count: 1, examples: ['x :: /identity/a'] });
        expect(plan.paths).toStrictEqual(new Map([['/identity/a', ['y']]]));
        expect(plan.recount).toStrictEqual(new Set(['x']));
        expect(plan.rowWrites).toBe(1);
    });

    test('planRepair buckets layer, preview, memoryPath and updatedAt drift', () => {
        const table = newTable();
        const item = memory('/users/u1/a', ['p', 'q', 'r', 's']);
        putMemory(table, item);
        putRow(table, { ...desiredRow(item, 'p'), layer: 'unknown' });
        putRow(table, { ...desiredRow(item, 'q'), contentPreview: 'old' });
        putRow(table, { ...desiredRow(item, 'r'), memoryPath: undefined });
        putRow(table, { ...desiredRow(item, 's'), updatedAt: 'old' });
        for(const tag of ['p', 'q', 'r', 's']) {
            putMeta(table, meta(tag, 1));
        }

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan.buckets.layer).toStrictEqual({ count: 1, examples: ['p :: /users/u1/a'] });
        expect(plan.buckets.preview).toStrictEqual({ count: 1, examples: ['q :: /users/u1/a'] });
        expect(plan.buckets.memoryPath).toStrictEqual({ count: 1, examples: ['r :: /users/u1/a'] });
        expect(plan.buckets.updatedAtOnly).toStrictEqual({ count: 1, examples: ['s :: /users/u1/a'] });
        expect(plan.buckets.metaDrift.count).toBe(0);
    });

    test('planRepair flags permanent rows without META and a count ignoring TTL rows', () => {
        const table = newTable();
        const permanent = memory('/identity/p', ['shared', 'lonely']);
        const expiring = memory('/events/e', ['shared'], { TTL: FUTURE });
        putMemory(table, permanent);
        putMemory(table, expiring);
        putDesiredRows(table, permanent);
        putDesiredRows(table, expiring);
        putMeta(table, meta('shared', 1));

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan.buckets.metaDrift).toStrictEqual({ count: 1, examples: ['lonely'] });
        expect(plan.rowWrites).toBe(0);
    });

    test('planRepair deletes an orphan whose own TTL is still in the future', () => {
        const table = newTable();
        putRow(table, { PK: 'TAG#t', SK: 'PATH#/events/1', TTL: NOW_S + 1 });

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan.buckets.orphan).toStrictEqual({ count: 1, examples: ['t :: /events/1'] });
        expect(plan.buckets.expiredRowLeft.count).toBe(0);
    });

    test('planRepair caps examples at 25 but counts every row', () => {
        const table = newTable();
        for(let index = 0; index < 26; index++) {
            putRow(table, { PK: 'TAG#t', SK: `PATH#/events/${index}` });
        }

        const plan = planRepair(snapshotOf(table), NOW_S);

        expect(plan.buckets.orphan.count).toBe(26);
        expect(plan.buckets.orphan.examples).toHaveLength(25);
        expect(plan.buckets.orphan.examples.at(-1)).toBe('t :: /events/24');
    });
});

describe('repair-tag-index estimates', () => {
    test('estimateExecute sizes memory reads, row reads, recount reads and writes', () => {
        const snapshot: Snapshot = {
            memories: new Map([['/identity/big', memory('/identity/big', [], { content: 'x'.repeat(4097) })], ['/identity/page', memory('/identity/page', [], { content: 'x'.repeat(4096) })]]),
            rows:     new Map([['nine', Array.from({ length: 9 }, (_, index) => ({ PK: 'TAG#nine', SK: `PATH#/p${index}` }))], ['eight', Array.from({ length: 8 }, (_, index) => ({ PK: 'TAG#eight', SK: `PATH#/p${index}` }))]]),
            metas:    new Map(),
        };
        const plan: Plan = {
            paths:     new Map([['/identity/big', ['a', 'b']], ['/identity/page', []], ['/identity/gone', ['c']]]),
            recount:   new Set(['nine', 'eight', 'none']),
            buckets:   planRepair({ memories: new Map(), rows: new Map(), metas: new Map() }, NOW_S).buckets,
            rowWrites: 7,
        };

        expect(estimateExecute(snapshot, plan)).toStrictEqual({ baseRcu: 7 + 3 + 4 + 8 + 4 + 4, baseWcu: 10, gsi1Rcu: 0, gsi2Rcu: 0, gsi2Wcu: 3 });
    });
});

describe('repair-tag-index repairMemory', () => {
    test('repairMemory deletes, rewrites and puts rows from fresh reads, then settles', async () => {
        const table = newTable();
        const item = memory('/identity/a', ['keep', 'stale', 'new']);
        putMemory(table, item);
        putRow(table, desiredRow(item, 'keep'));
        putRow(table, { ...desiredRow(item, 'stale'), layer: 'unknown' });
        putRow(table, desiredRow(item, 'removed'));
        const h = harness(table);

        const outcome = await repairMemory(h.ctx, '/identity/a', ['removed', 'keep']);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['removed', 'stale', 'new']), writes: 3 });
        expect(h.store.calls).toStrictEqual([
            'getMemory /identity/a',
            'getRows /identity/a removed,keep,stale,new',
            'deleteRow removed /identity/a',
            'putRow stale /identity/a observed',
            'putRow new /identity/a absent',
            'getMemory /identity/a',
        ]);
        expect(rowsOf(table, 'stale')).toStrictEqual([desiredRow(item, 'stale')]);
        expect(rowsOf(table, 'new')).toStrictEqual([desiredRow(item, 'new')]);
        expect(rowsOf(table, 'removed')).toStrictEqual([]);
        expect(h.charges).toStrictEqual([{ baseRcu: 1 }, { baseRcu: 4 }, { baseWcu: 1 }, { baseWcu: 1 }, { baseWcu: 1 }, { baseRcu: 1 }]);
    });

    test('repairMemory deletes every row of a memory that is gone', async () => {
        const table = newTable();
        putRow(table, desiredRow(memory('/identity/a', ['x']), 'x'));
        const h = harness(table);

        const outcome = await repairMemory(h.ctx, '/identity/a', ['x', 'y']);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['x']), writes: 1 });
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', 'getRows /identity/a x,y', 'deleteRow x /identity/a', 'getMemory /identity/a']);
    });

    test('repairMemory deletes rows of an expired memory including tags the scan missed', async () => {
        const table = newTable();
        const item = memory('/events/a', ['x', 'late'], { TTL: PAST });
        putMemory(table, item);
        putDesiredRows(table, item);
        const h = harness(table);

        const outcome = await repairMemory(h.ctx, '/events/a', ['x']);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['x', 'late']), writes: 2 });
        expect(table.rows.size).toBe(0);
    });

    test('repairMemory redoes from fresh rows when a tag is re-added during its delete', async () => {
        const table = newTable();
        const before = memory('/identity/a', ['y']);
        putMemory(table, before);
        putRow(table, desiredRow(before, 'y'));
        const staleX = { ...desiredRow(before, 'x'), tags: new Set(['x', 'y']) };
        putRow(table, staleX);
        const h = harness(table);
        const retagged = memory('/identity/a', ['x', 'y']);
        h.store.writeHooks.set('deleteRow x /identity/a', (store) => {
            putMemory(store.table, retagged);
            putRow(store.table, staleX);
        });

        const outcome = await repairMemory(h.ctx, '/identity/a', ['x', 'y']);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['x', 'y']), writes: 3 });
        expect(h.store.calls.filter(call => call.startsWith('getRows'))).toStrictEqual(['getRows /identity/a x,y', 'getRows /identity/a x,y']);
        expect(rowsOf(table, 'x')).toStrictEqual([desiredRow(retagged, 'x')]);
        expect(rowsOf(table, 'y')).toStrictEqual([desiredRow(retagged, 'y')]);
    });

    test('repairMemory restores every row after a TTL extension lands during the deletes', async () => {
        const table = newTable();
        const expired = memory('/events/a', ['x', 'y'], { TTL: PAST });
        putMemory(table, expired);
        putDesiredRows(table, expired);
        const h = harness(table);
        const extended = { ...expired, TTL: FUTURE };
        h.store.writeHooks.set('deleteRow x /events/a', (store) => {
            putMemory(store.table, extended);
        });

        const outcome = await repairMemory(h.ctx, '/events/a', ['x', 'y']);

        expect(outcome.settled).toBe(true);
        expect(rowsOf(table, 'x')).toStrictEqual([desiredRow(extended, 'x')]);
        expect(rowsOf(table, 'y')).toStrictEqual([desiredRow(extended, 'y')]);
    });

    test('repairMemory writes the rows of a memory recreated at an absent path', async () => {
        const table = newTable();
        putRow(table, desiredRow(memory('/identity/a', ['x']), 'x'));
        const h = harness(table);
        const recreated = memory('/identity/a', ['z'], { updatedAt: '2026-02-02T00:00:00.000Z' });
        h.store.writeHooks.set('deleteRow x /identity/a', (store) => {
            putMemory(store.table, recreated);
        });

        const outcome = await repairMemory(h.ctx, '/identity/a', ['x']);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['x', 'z']), writes: 2 });
        expect([...table.rows.values()]).toStrictEqual([desiredRow(recreated, 'z')]);
    });

    test('repairMemory redoes after a condition failure', async () => {
        const table = newTable();
        const item = memory('/identity/a', ['x']);
        putMemory(table, item);
        const h = harness(table);
        h.store.forceConditionFailed.add('putRow x /identity/a absent');

        const outcome = await repairMemory(h.ctx, '/identity/a', []);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['x']), writes: 2 });
        expect(h.store.calls.filter(call => call.startsWith('putRow'))).toStrictEqual(['putRow x /identity/a absent', 'putRow x /identity/a absent']);
    });

    test('repairMemory reports a memory that keeps changing as unsettled after 3 attempts', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x']));
        const h = harness(table);
        let reads = 0;
        h.store.onEveryRead = (call) => {
            if(call.startsWith('getMemory') && ++reads % 2 === 0) {
                putMemory(table, memory('/identity/a', ['x'], { updatedAt: `2026-03-0${reads}T00:00:00.000Z` }));
            }
        };

        const outcome = await repairMemory(h.ctx, '/identity/a', []);

        expect(outcome).toStrictEqual({ settled: false, touched: new Set(['x']), writes: 3 });
        expect(h.store.calls.filter(call => call.startsWith('getMemory'))).toHaveLength(6);
    });

    test('repairMemory reads no rows once aborted during the memory read', async () => {
        const h = harness();
        h.store.readHooks.set('getMemory /identity/a', () => {
            h.abort.abort();
        });

        await expect(repairMemory(h.ctx, '/identity/a', ['x'])).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a']);
    });

    test('repairMemory stops with an AbortError once aborted', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x', 'y']));
        const h = harness(table);
        h.store.readHooks.set('getRows /identity/a x,y', () => {
            h.abort.abort();
        });

        const outcome = repairMemory(h.ctx, '/identity/a', []);

        await expect(outcome).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', 'getRows /identity/a x,y']);
    });

    test('repairMemory reads rows 100 tags per request and charges each request before the next', async () => {
        const table = newTable();
        const tags = Array.from({ length: 101 }, (_, index) => `t${index}`);
        const item = memory('/identity/a', tags);
        putMemory(table, item);
        putDesiredRows(table, item);
        const h = harness(table);

        const outcome = await repairMemory(h.ctx, '/identity/a', []);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(), writes: 0 });
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', `getRows /identity/a ${tags.slice(0, 100).join(',')}`, 'getRows /identity/a t100', 'getMemory /identity/a']);
        expect(h.charges).toStrictEqual([{ baseRcu: 1 }, { baseRcu: 100 }, { baseRcu: 1 }, { baseRcu: 1 }]);
        expect(h.sleeps).toStrictEqual([]);
    });

    test('repairMemory re-reads unprocessed rows after a backoff and repairs from the later read', async () => {
        const table = newTable();
        const item = memory('/identity/a', ['x', 'y']);
        putMemory(table, item);
        putRow(table, desiredRow(item, 'x'));
        putRow(table, { ...desiredRow(item, 'y'), layer: 'unknown' });
        const h = harness(table);
        h.store.unprocessed.push(['y'], ['y']);

        const outcome = await repairMemory(h.ctx, '/identity/a', []);

        expect(outcome).toStrictEqual({ settled: true, touched: new Set(['y']), writes: 1 });
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', 'getRows /identity/a x,y', 'getRows /identity/a y', 'getRows /identity/a y', 'putRow y /identity/a observed', 'getMemory /identity/a']);
        expect(h.charges).toStrictEqual([{ baseRcu: 1 }, { baseRcu: 1 }, { baseRcu: 0 }, { baseRcu: 1 }, { baseWcu: 1 }, { baseRcu: 1 }]);
        expect(h.sleeps).toStrictEqual([1000, 2000]);
    });

    test('repairMemory caps the unprocessed-row backoff at 30 s', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x']));
        const h = harness(table);
        h.store.unprocessed.push(...Array.from({ length: 7 }, () => ['x']));

        await repairMemory(h.ctx, '/identity/a', []);

        expect(h.sleeps).toStrictEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    });

    test('repairMemory stops before re-reading unprocessed rows once aborted', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x', 'y']));
        const h = harness(table);
        h.store.unprocessed.push(['y']);
        h.store.readHooks.set('getRows /identity/a x,y', () => {
            h.abort.abort();
        });

        const outcome = repairMemory(h.ctx, '/identity/a', []);

        await expect(outcome).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', 'getRows /identity/a x,y']);
        expect(h.charges).toStrictEqual([{ baseRcu: 1 }, { baseRcu: 1 }]);
    });

    test('repairMemory stops before the next 100 rows once aborted', async () => {
        const table = newTable();
        const tags = Array.from({ length: 101 }, (_, index) => `t${index}`);
        putMemory(table, memory('/identity/a', tags));
        const h = harness(table);
        h.store.readHooks.set(`getRows /identity/a ${tags.slice(0, 100).join(',')}`, () => {
            h.abort.abort();
        });

        const outcome = repairMemory(h.ctx, '/identity/a', []);

        await expect(outcome).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual(['getMemory /identity/a', `getRows /identity/a ${tags.slice(0, 100).join(',')}`]);
        expect(h.sleeps).toStrictEqual([]);
    });
});

describe('repair-tag-index recount', () => {
    test('readCount pages a strong partition read and counts only rows without TTL', async () => {
        const table = newTable();
        putMeta(table, meta('x', 7));
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/a' });
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/b', TTL: FUTURE });
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/c' });
        const h = harness(table);

        const state = await readCount(h.ctx, 'x');

        expect(state).toStrictEqual({ n: 2, meta: { count: 7, keys: true } });
        expect(h.store.calls).toStrictEqual(['partition x strong undefined', 'partition x strong {"offset":2}']);
    });

    test('readCount reports wrong GSI2 keys and an absent META', async () => {
        const table = newTable();
        putMeta(table, { PK: 'TAG#x', SK: 'META_COUNT', count: 1, GSI2PK: 'TAG_COUNTS', GSI2SK: 'TAG#other' });
        putMeta(table, { PK: 'TAG#y', SK: 'META_COUNT', count: 1, GSI2PK: 'WRONG', GSI2SK: 'TAG#y' });
        const h = harness(table);

        expect(await readCount(h.ctx, 'x')).toStrictEqual({ n: 0, meta: { count: 1, keys: false } });
        expect(await readCount(h.ctx, 'y')).toStrictEqual({ n: 0, meta: { count: 1, keys: false } });
        expect(await readCount(h.ctx, 'z')).toStrictEqual({ n: 0, meta: undefined });
    });

    test('recount issues read2 no earlier than the settle interval after read1', async () => {
        const table = newTable();
        putMeta(table, meta('a', 0));
        putMeta(table, meta('b', 0));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        putRow(table, { PK: 'TAG#b', SK: 'PATH#/1' });
        const h = harness(table);
        h.store.readCost = 999;

        await recount(h.ctx, new Set(['a', 'b']), 1000);

        expect(h.sleeps.slice(0, 1)).toStrictEqual([1]);
        expect(h.store.calls.slice(0, 5)).toStrictEqual([
            'partition a strong undefined',
            'partition b strong undefined',
            'partition a strong undefined',
            'setMeta a 1 0',
            'partition b strong undefined',
        ]);
    });

    function settledPair(): Table {
        const table = newTable();
        for(const tag of ['a', 'b']) {
            putMeta(table, meta(tag, 1));
            putRow(table, { PK: `TAG#${tag}`, SK: 'PATH#/1' });
        }
        return table;
    }

    test('recount does not sleep when the settle interval has already passed', async () => {
        const h = harness(settledPair());
        h.store.readCost = 500;

        const outcome = await recount(h.ctx, new Set(['a', 'b']), 500);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 0 });
        expect(h.sleeps).toStrictEqual([]);
        expect(h.logs).toStrictEqual(['Recount cycle 1: 2 tags']);
    });

    test('recount sleeps out only the remaining settle interval', async () => {
        const h = harness(settledPair());
        h.store.readCost = 500;

        await recount(h.ctx, new Set(['a', 'b']), 501);

        expect(h.sleeps).toStrictEqual([1]);
    });

    test('recount fixes a stable wrong count conditioned on the count read and verifies it', async () => {
        const table = newTable();
        putMeta(table, meta('a', 5));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/2', TTL: FUTURE });
        const h = harness(table);

        const outcome = await recount(h.ctx, new Set(['a']), 600_000);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 1 });
        expect(table.metas.get('a')).toStrictEqual(meta('a', 1));
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toStrictEqual(['setMeta a 1 5']);
        expect(h.sleeps).toStrictEqual([600_000, 600_000]);
        expect(h.logs).toStrictEqual(['Recount cycle 1: 1 tags', 'Recount cycle 2: 1 tags']);
        expect(h.charges.filter(units => units.baseRcu === undefined)).toStrictEqual([{ baseWcu: 1, gsi2Wcu: 1 }]);
    });

    test('recount writes missing GSI2 keys for a correct count', async () => {
        const table = newTable();
        putMeta(table, { PK: 'TAG#a', SK: 'META_COUNT', count: 1 });
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        const h = harness(table);

        await recount(h.ctx, new Set(['a']), 1);

        expect(table.metas.get('a')).toStrictEqual(meta('a', 1));
    });

    test('recount creates META for permanent rows without one', async () => {
        const table = newTable();
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        const h = harness(table);

        await recount(h.ctx, new Set(['a']), 1);

        expect(h.store.calls).toContain('setMeta a 1 undefined');
        expect(table.metas.get('a')).toStrictEqual(meta('a', 1));
    });

    test('recount deletes META when only expiring rows remain', async () => {
        const table = newTable();
        putMeta(table, meta('a', 2));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1', TTL: FUTURE });
        const h = harness(table);

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 1 });
        expect(h.store.calls).toContain('deleteMeta a 2');
        expect(table.metas.has('a')).toBe(false);
    });

    test('recount skips the write when a live writer changes the partition between reads', async () => {
        const table = newTable();
        putMeta(table, meta('a', 3));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        let once = true;
        const h = harness(table, () => {
            if(once) {
                once = false;
                putRow(table, { PK: 'TAG#a', SK: 'PATH#/2' });
            }
        });

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 1 });
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toStrictEqual(['setMeta a 2 3']);
        expect(h.logs).toStrictEqual(['Recount cycle 1: 1 tags', 'Recount cycle 2: 1 tags', 'Recount cycle 3: 1 tags']);
    });

    test('recount skips the write when only the META count changes between reads', async () => {
        const table = newTable();
        putMeta(table, meta('a', 1));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/2' });
        let once = true;
        const h = harness(table, () => {
            if(once) {
                once = false;
                putMeta(table, meta('a', 3));
            }
        });

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 1 });
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toStrictEqual(['setMeta a 2 3']);
        expect(h.logs).toHaveLength(3);
    });

    test('recount rereads when only the GSI2 keys change between reads', async () => {
        const table = newTable();
        putMeta(table, meta('a', 1, false));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        let once = true;
        const h = harness(table, () => {
            if(once) {
                once = false;
                putMeta(table, meta('a', 1));
            }
        });

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 0 });
        expect(h.logs).toHaveLength(2);
    });

    test('recount keeps a tag whose META write failed its condition', async () => {
        const table = newTable();
        putMeta(table, meta('a', 3));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        const h = harness(table);
        h.store.forceConditionFailed.add('setMeta a 1 3');

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: [], writes: 2 });
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toStrictEqual(['setMeta a 1 3', 'setMeta a 1 3']);
    });

    test('recount reports tags still wrong after three write cycles and a verify cycle', async () => {
        const table = newTable();
        putMeta(table, meta('a', 3));
        putRow(table, { PK: 'TAG#a', SK: 'PATH#/1' });
        const h = harness(table);
        h.store.alwaysConditionFailed.add('setMeta a 1 3');

        const outcome = await recount(h.ctx, new Set(['a']), 1);

        expect(outcome).toStrictEqual({ unsettled: ['a'], writes: 3 });
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toHaveLength(3);
        expect(h.store.calls.filter(call => call.startsWith('partition'))).toHaveLength(8);
        expect(h.logs).toStrictEqual(['Recount cycle 1: 1 tags', 'Recount cycle 2: 1 tags', 'Recount cycle 3: 1 tags', 'Recount cycle 4 (verify only): 1 tags']);
    });

    test('recount keeps pending tags in their original order across cycles', async () => {
        const table = newTable();
        for(const tag of ['a', 'b']) {
            putMeta(table, meta(tag, 3));
            putRow(table, { PK: `TAG#${tag}`, SK: 'PATH#/1' });
        }
        const h = harness(table);

        await recount(h.ctx, new Set(['a', 'b']), 1);

        expect(h.store.calls).toStrictEqual([
            'partition a strong undefined', 'partition b strong undefined',
            'partition a strong undefined', 'setMeta a 1 3', 'partition b strong undefined', 'setMeta b 1 3',
            'partition a strong undefined', 'partition b strong undefined', 'partition a strong undefined', 'partition b strong undefined',
        ]);
    });

    test('recount with no tags reads nothing', async () => {
        const h = harness();

        expect(await recount(h.ctx, new Set(), 1)).toStrictEqual({ unsettled: [], writes: 0 });
        expect(h.store.calls).toStrictEqual([]);
        expect(h.logs).toStrictEqual([]);
    });

    test('recount stops with an AbortError when aborted during the settle sleep', async () => {
        const table = newTable();
        putMeta(table, meta('a', 3));
        let abortRun = (): void => undefined;
        const h = harness(table, () => {
            abortRun();
        });
        abortRun = () => {
            h.abort.abort();
        };

        await expect(recount(h.ctx, new Set(['a']), 1)).rejects.toThrow('The operation was aborted.');
        expect(h.store.calls).toStrictEqual(['partition a strong undefined']);
    });
});

describe('repair-tag-index recount against the live writer', () => {
    function heldGate(): { gate: { reached: () => void, release: Promise<void> }, reached: Promise<void>, release: () => void } {
        const reached = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        return { gate: { reached: reached.resolve, release: release.promise }, reached: reached.promise, release: release.resolve };
    }

    test('recount never overcounts when a row lands before read1 and its increment after', async () => {
        const table = newTable();
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/identity/a' });
        putMeta(table, meta('x', 1));
        const held = heldGate();
        const writer = new MemoryToolBackendTagIndex(fakeDocClient(table, held.gate), 'table');
        const pairs: string[] = [];
        const h = harness(table, () => {
            held.release();
        });
        const observe = (): void => {
            pairs.push(`${rowsOf(table, 'x').length}/${String(table.metas.get('x')?.count)}`);
        };
        h.store.readHooks.set('partition x strong undefined', observe);

        const write = writer.createTagIndexItems('/identity/b' as MemoryPath, new Set(['x']), UPDATED, 'b', createIndexLayer('identity'));
        await held.reached;
        const outcome = await recount(h.ctx, new Set(['x']), 1000);
        await write;
        observe();

        expect(outcome).toStrictEqual({ unsettled: [], writes: 0 });
        expect(h.store.calls.filter(call => call.startsWith('setMeta'))).toStrictEqual([]);
        expect(table.metas.get('x')?.count).toBe(2);
        expect(pairs).not.toContain('2/3');
        expect(h.logs).toStrictEqual(['Recount cycle 1: 1 tags', 'Recount cycle 2: 1 tags']);
    });

    test('recount never undercounts when a row is deleted before read1 and its decrement after', async () => {
        const table = newTable();
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/identity/a' });
        putRow(table, { PK: 'TAG#x', SK: 'PATH#/identity/b' });
        putMeta(table, meta('x', 2));
        const held = heldGate();
        const writer = new MemoryToolBackendTagIndex(fakeDocClient(table, held.gate), 'table');
        const h = harness(table, () => {
            held.release();
        });

        const write = writer.deleteTagIndexItems('/identity/b' as MemoryPath, new Set(['x']));
        await held.reached;
        const outcome = await recount(h.ctx, new Set(['x']), 1000);
        await write;

        expect(outcome).toStrictEqual({ unsettled: [], writes: 0 });
        expect(table.metas.get('x')?.count).toBe(1);
        expect(rowsOf(table, 'x')).toHaveLength(1);
    });
});

describe('repair-tag-index executeRepair', () => {
    test('executeRepair repairs planned paths then recounts planned and touched tags', async () => {
        const table = newTable();
        const item = memory('/identity/a', ['x']);
        putMemory(table, item);
        putRow(table, { PK: 'TAG#y', SK: 'PATH#/identity/gone' });
        putMeta(table, meta('y', 1));
        const h = harness(table);
        const plan = planRepair(snapshotOf(table), NOW_S);

        const result = await executeRepair(h.ctx, plan, 1);

        expect(result).toStrictEqual({ repaired: 2, unsettledPaths: [], unsettledTags: [], rowWrites: 2, metaWrites: 2, aborted: false });
        expect(table.metas).toStrictEqual(new Map([['x', meta('x', 1)]]));
        expect([...table.rows.values()]).toStrictEqual([desiredRow(item, 'x')]);
    });

    test('executeRepair recounts a tag first touched during the repair', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x', 'late']));
        putRow(table, desiredRow(memory('/identity/a', ['x', 'late']), 'x'));
        putMeta(table, meta('x', 1));
        const h = harness(table);
        const plan: Plan = { ...planRepair(snapshotOf(table), NOW_S), recount: new Set() };

        const result = await executeRepair(h.ctx, plan, 1);

        expect(result.metaWrites).toBe(1);
        expect(table.metas.get('late')).toStrictEqual(meta('late', 1));
    });

    test('executeRepair reports unsettled paths and tags', async () => {
        const table = newTable();
        putMemory(table, memory('/identity/a', ['x']));
        putMeta(table, meta('y', 3));
        putRow(table, { PK: 'TAG#y', SK: 'PATH#/identity/y' });
        putMemory(table, memory('/identity/y', ['y']));
        const h = harness(table);
        h.store.alwaysConditionFailed.add('putRow x /identity/a absent');
        h.store.alwaysConditionFailed.add('setMeta y 1 3');
        const plan = planRepair(snapshotOf(table), NOW_S);

        const result = await executeRepair(h.ctx, plan, 1);

        expect(result).toStrictEqual({ repaired: 2, unsettledPaths: ['/identity/a'], unsettledTags: ['y'], rowWrites: 4, metaWrites: 3, aborted: false });
    });

    test('executeRepair logs progress every 100 memories', async () => {
        const table = newTable();
        for(let index = 0; index < 101; index++) {
            putRow(table, { PK: 'TAG#t', SK: `PATH#/events/${index}`, TTL: FUTURE });
        }
        const h = harness(table);
        const plan = planRepair(snapshotOf(table), NOW_S);

        const result = await executeRepair(h.ctx, plan, 1);

        expect(result.repaired).toBe(101);
        expect(h.logs.filter(line => line.startsWith('Repaired'))).toStrictEqual(['Repaired 100/101 memories']);
    });

    test('executeRepair returns a partial result when aborted', async () => {
        const table = newTable();
        putRow(table, { PK: 'TAG#t', SK: 'PATH#/events/1' });
        putRow(table, { PK: 'TAG#t', SK: 'PATH#/events/2' });
        const h = harness(table);
        const plan = planRepair(snapshotOf(table), NOW_S);
        h.store.writeHooks.set('deleteRow t /events/1', () => {
            h.abort.abort();
        });

        const result = await executeRepair(h.ctx, plan, 1);

        expect(result).toStrictEqual({ repaired: 0, unsettledPaths: [], unsettledTags: [], rowWrites: 0, metaWrites: 0, aborted: true });
        expect(table.rows.size).toBe(1);
    });

    test('executeRepair rethrows errors other than abort', async () => {
        const h = harness();
        const plan: Plan = { ...planRepair(snapshotOf(newTable()), NOW_S), paths: new Map([['/identity/a', []]]) };
        h.store.readHooks.set('getMemory /identity/a', () => {
            throw new Error('boom');
        });

        await expect(executeRepair(h.ctx, plan, 1)).rejects.toThrow('boom');
    });
});

describe('repair-tag-index shared tag between an expiring and a permanent memory', () => {
    test('only the expiring row disappears and the tag keeps a correct count and search result', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(NOW_MS));
        const table = newTable();
        const permanent = memory('/identity/p', ['x']);
        const expiring = memory('/events/e', ['x'], { TTL: FUTURE });
        putMemory(table, permanent);
        putMemory(table, expiring);
        putDesiredRows(table, permanent);
        putRow(table, { ...desiredRow(expiring, 'x'), TTL: undefined });
        putMeta(table, meta('x', 2));
        const h = harness(table);
        const reader = new MemoryToolBackendTagIndex(fakeDocClient(table), 'table');
        const searchPaths = async (): Promise<string[]> => {
            const found = await reader.queryByTag('x');
            return found.items.map(row => row.memoryPath);
        };

        const plan = planRepair(await scan(h.ctx), NOW_S);
        const result = await executeRepair(h.ctx, plan, 1);

        expect(plan.buckets.ttlStamp).toStrictEqual({ count: 1, examples: ['x :: /events/e'] });
        expect(result).toStrictEqual({ repaired: 1, unsettledPaths: [], unsettledTags: [], rowWrites: 1, metaWrites: 1, aborted: false });
        expect(rowsOf(table, 'x')).toStrictEqual([desiredRow(expiring, 'x'), desiredRow(permanent, 'x')]);
        expect(await reader.listTagCounts()).toStrictEqual([{ tag: 'x', count: 1 }]);
        expect(await searchPaths()).toStrictEqual(['/events/e', '/identity/p']);

        jest.setSystemTime(new Date((FUTURE + 1) * 1000));
        table.memories.delete('/events/e');

        expect(await reader.listTagCounts()).toStrictEqual([{ tag: 'x', count: 1 }]);
        expect(await searchPaths()).toStrictEqual(['/identity/p']);
        const lagging = planRepair(snapshotOf(table), FUTURE + 1);
        expect(lagging.rowWrites).toBe(0);
        expect(lagging.recount.size).toBe(0);
        expect(lagging.buckets.expiredRowLeft).toStrictEqual({ count: 1, examples: ['x :: /events/e'] });

        table.rows.delete(rowKey('x', '/events/e'));

        expect(await reader.listTagCounts()).toStrictEqual([{ tag: 'x', count: 1 }]);
        expect(await searchPaths()).toStrictEqual(['/identity/p']);
        expect(planRepair(snapshotOf(table), FUTURE + 1).recount.size).toBe(0);
    });
});

describe('repair-tag-index pacing', () => {
    test('createPacing sleeps units divided by rate and records consumption', async () => {
        const sleeps: number[] = [];
        let now = 0;
        const pacing = createPacing({ baseRcu: 1, baseWcu: 0.5, gsi1Rcu: 1, gsi2Rcu: 0.5, gsi2Wcu: 0.5 }, async (ms) => {
            sleeps.push(ms);
            await ticks(2);
            now += ms;
        }, () => now);

        await pacing.charge({ baseRcu: 2 });
        await pacing.charge({ baseWcu: 1, gsi2Wcu: 1 });
        await pacing.charge({});
        await pacing.charge({ gsi1Rcu: 3, gsi2Rcu: 1 });

        expect(sleeps).toStrictEqual([2000, 2000, 3000]);
        expect(pacing.consumed).toStrictEqual({ baseRcu: 2, baseWcu: 1, gsi1Rcu: 3, gsi2Rcu: 1, gsi2Wcu: 1 });
    });

    test('createPacing charges from the current time once earlier debt is paid', async () => {
        const sleeps: number[] = [];
        let now = 0;
        const pacing = createPacing({ baseRcu: 1, baseWcu: 1, gsi1Rcu: 1, gsi2Rcu: 1, gsi2Wcu: 1 }, async (ms) => {
            sleeps.push(ms);
            now += ms;
        }, () => now);

        await pacing.charge({ baseRcu: 1 });
        now = 5000;
        await pacing.charge({ baseRcu: 1.5 });

        expect(sleeps).toStrictEqual([1000, 1500]);
    });

    test('createPacing carries debt across charges of the same resource', async () => {
        const sleeps: number[] = [];
        const pacing = createPacing({ baseRcu: 1, baseWcu: 1, gsi1Rcu: 1, gsi2Rcu: 1, gsi2Wcu: 1 }, async (ms) => {
            sleeps.push(ms);
        }, () => 0);

        await pacing.charge({ baseRcu: 1 });
        await pacing.charge({ baseRcu: 1 });

        expect(sleeps).toStrictEqual([1000, 2000]);
    });
});
