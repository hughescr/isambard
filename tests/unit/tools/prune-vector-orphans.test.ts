import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';
import {
    DEFAULT_PREFIX,
    MAX_BATCH_SIZE,
    MAX_RATE_LIMIT_RCU_PER_SEC,
    MAX_STALLED_ROUNDS,
    STALL_BACKOFF_MS,
    canonicalPathUnderPrefix,
    checkExistence,
    main,
    parseArgs,
    runPruneCli,
    type BatchGetKeysResult,
    type ItemKey,
    type PruneDependencies
} from '../../../tools/prune-vector-orphans';
import { mockPruneRuntime } from '../../setup';
import { MemoryToolKeyGenerator, createIndexLayer, createMemoryPath } from '@/storage/memory-tool';
import { VectorIndex } from '@/storage/memory-vec-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

const indexes: VectorIndex[] = [];

afterEach(() => {
    for(const index of indexes.splice(0)) {
        index.close();
    }
});

function keysOf(memoryPath: string): ItemKey {
    const keys = MemoryToolKeyGenerator.createKeys(createMemoryPath(memoryPath));
    return { PK: keys.PK, SK: keys.SK };
}

function openIndex(): VectorIndex {
    const index = VectorIndex.openWithDb(new Database(':memory:'));
    indexes.push(index);
    return index;
}

function seed(index: VectorIndex, memoryPath: string, updatedAt = 1): void {
    const keys = keysOf(memoryPath);
    index.upsert({ pk: keys.PK, sk: keys.SK, layer: createIndexLayer('events'), contentHash: `h:${memoryPath}`, vector: new Uint8Array(128), updatedAt, ttl: null });
}

function seedRaw(index: VectorIndex, pk: string, sk: string): void {
    index.upsert({ pk, sk, layer: createIndexLayer('events'), contentHash: 'raw', vector: new Uint8Array(128), updatedAt: 1, ttl: null });
}

function remainingPaths(index: VectorIndex): string[] {
    return index.listRowsByPathPrefix('/events/').map(row => MemoryToolKeyGenerator.parsePath(row.pk, row.sk));
}

const id = (key: ItemKey) => `${key.PK}|${key.SK}`;

/** A fake table: `present` keys exist; each request costs one RCU per key unless overridden. */
function fakeTable(present: string[]) {
    const existing = new Set(present.map(memoryPath => id(keysOf(memoryPath))));
    const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => ({
        found:             keys.filter(key => existing.has(id(key))),
        unprocessed:       [],
        consumedReadUnits: keys.length,
    }));
    return { existing, batchGetKeys };
}

function makeRuntime(index: VectorIndex, table: ReturnType<typeof fakeTable>) {
    const writes: string[] = [];
    const destroy = mock(() => undefined);
    // The real index stays open for post-run assertions; afterEach closes it.
    const close = mock((): void => undefined);
    const deps = {
        openStorage:     mock(() => ({ tableName: 'isambard-test', batchGetKeys: table.batchGetKeys, destroy })),
        openVectorIndex: mock(async (_dbPath: string) => ({
            listRowsByPathPrefix: (prefix: string) => index.listRowsByPathPrefix(prefix),
            'delete':             mock((pk: string, sk: string, expected?: Parameters<VectorIndex['delete']>[2]) => index.delete(pk, sk, expected)),
            close,
        })),
        now:   mock(() => 0),
        sleep: mock(async (_ms: number) => undefined),
        write: mock((message: string) => { writes.push(message); }),
    } satisfies PruneDependencies;
    return { deps, writes, destroy, close, output: () => writes.join('') };
}

const A = '/events/activity/chat/2026-08-01T00-00-00-000Z';
const B = '/events/activity/chat/2026-08-02T00-00-00-000Z';
const C = '/events/activity/tool/2026-08-03T00-00-00-000Z';
const LIVE = '/events/activity/chat/2026-09-20T00-00-00-000Z';

// ── Options ───────────────────────────────────────────────────────────────────

describe('prune-vector-orphans options', () => {
    test('defaults to a paced dry run over /events/activity/', () => {
        expect(parseArgs(['bun', 'script'])).toEqual({
            prefix:             '/events/activity/',
            dbPath:             path.resolve(import.meta.dir, '..', '..', '..', 'tools', '..', 'scratch', 'memory-vec.sqlite'),
            rateLimitRcuPerSec: 2,
            batchSize:          4,
            execute:            false,
            allowAllAbsent:     false,
            showHelp:           false,
        });
        expect(DEFAULT_PREFIX).toBe('/events/activity/');
        expect(MAX_RATE_LIMIT_RCU_PER_SEC).toBe(5);
        expect(MAX_BATCH_SIZE).toBe(100);
    });

    test('parses every flag, in both spaced and --flag=value forms', () => {
        expect(parseArgs(['bun', 'script', '--prefix=/events/activity/chat/', '--db-path', './x.sqlite', '--rate-limit-rcu-per-sec=5', '--batch-size', '100', '--execute', '--allow-all-absent', '-h'])).toEqual({
            prefix:             '/events/activity/chat/',
            dbPath:             path.resolve('./x.sqlite'),
            rateLimitRcuPerSec: 5,
            batchSize:          100,
            execute:            true,
            allowAllAbsent:     true,
            showHelp:           true,
        });
        expect(parseArgs(['bun', 'script', '--help', '--batch-size=1']).batchSize).toBe(1);
    });

    test('does not split a positional value that merely contains -- and =', () => {
        expect(parseArgs(['bun', 'script', '--db-path', 'a--b=c']).dbPath).toBe(path.resolve('a--b=c'));
    });

    test('does not split a positional value that contains = without starting with --', () => {
        expect(parseArgs(['bun', 'script', '--db-path', 'x=y']).dbPath).toBe(path.resolve('x=y'));
    });

    test.each([
        ['/events/'],
        ['/events/activityx/'],
        ['/events/activity/chat'],
        ['/events/activity//'],
        ['/'],
        ['x/events/activity/'],
        ['/events/activity/a//b/'],
    ])('rejects the prefix %p', (prefix) => {
        expect(() => parseArgs(['bun', 'script', '--prefix', prefix])).toThrow(
            new Error(`Invalid --prefix value: ${prefix}. Must be /events/activity/ or a directory below it, ending in '/'.`)
        );
    });

    test.each([
        ['--prefix', 'Invalid --prefix value: (missing).'],
        ['--db-path', '--db-path requires a value'],
        ['--rate-limit-rcu-per-sec', 'Invalid --rate-limit-rcu-per-sec value: (missing)'],
        ['--batch-size', 'Invalid --batch-size value: (missing)'],
    ])('%s requires a value', (flag, message) => {
        expect(() => parseArgs(['bun', 'script', flag])).toThrow(message);
    });

    test('rejects a rate above the base table\'s 5 RCU', () => {
        expect(() => parseArgs(['bun', 'script', '--rate-limit-rcu-per-sec', '6'])).toThrow('Must be a positive number no greater than 5.');
    });

    test.each(['0', '101', '1.5', 'x'])('rejects --batch-size %p', (value) => {
        expect(() => parseArgs(['bun', 'script', `--batch-size=${value}`])).toThrow(
            new Error(`Invalid --batch-size value: ${value}. Must be an integer from 1 to 100.`)
        );
    });

    test.each(['--force', 'stray'])('rejects the unknown argument %p', (arg) => {
        expect(() => parseArgs(['bun', 'script', arg])).toThrow(new Error(`Unknown option: ${arg}`));
    });
});

// ── Row validation ────────────────────────────────────────────────────────────

describe('canonicalPathUnderPrefix', () => {
    test('accepts canonical keys of valid paths under the prefix, direct or nested', () => {
        expect(canonicalPathUnderPrefix({ pk: 'DIR#/events/activity', sk: 'FILE#x' }, DEFAULT_PREFIX)).toBe('/events/activity/x');
        expect(canonicalPathUnderPrefix({ pk: 'DIR#/events/activity/chat', sk: 'FILE#x' }, DEFAULT_PREFIX)).toBe('/events/activity/chat/x');
    });

    test.each([
        ['not DIR#/FILE# keys', 'events/activity/chat', 'FILE#x'],
        ['an empty filename', 'DIR#/events/activity/chat', 'FILE#'],
        ['a double slash', 'DIR#/events/activity/', 'FILE#x'],
        ['a non-canonical key split', 'DIR#/events', 'FILE#activity/chat/x'],
        ['a path outside the prefix', 'DIR#/events/other', 'FILE#x'],
        ['a sibling of the prefix', 'DIR#/events/activityx', 'FILE#x'],
        ['a path containing the prefix but not starting with it', 'DIR#/other/events/activity', 'FILE#x'],
    ])('rejects %s', (_label, pk, sk) => {
        expect(canonicalPathUnderPrefix({ pk, sk }, DEFAULT_PREFIX)).toBeUndefined();
    });
});

// ── Existence checks ──────────────────────────────────────────────────────────

describe('checkExistence', () => {
    function context(batchGetKeys: (keys: ItemKey[]) => Promise<BatchGetKeysResult>, overrides: { batchSize?: number, now?: () => number } = {}) {
        return {
            batchGetKeys,
            batchSize:          overrides.batchSize ?? 2,
            rateLimitRcuPerSec: 2,
            now:                overrides.now ?? (() => 0),
            sleep:              mock(async (_ms: number) => undefined),
        };
    }

    test('classifies requested keys as present or absent, in batches, summing consumed RCU', async () => {
        const table = fakeTable([A, C]);
        const ctx = context(table.batchGetKeys);
        const result = await checkExistence([keysOf(A), keysOf(B), keysOf(C)], ctx);
        expect(result).toEqual({ present: [keysOf(A), keysOf(C)], absent: [keysOf(B)], consumedReadUnits: 3 });
        expect(table.batchGetKeys.mock.calls).toEqual([[[keysOf(A), keysOf(B)]], [[keysOf(C)]]]);
    });

    test('paces every request by its consumed RCU less elapsed time', async () => {
        const table = fakeTable([]);
        let clock = 0;
        const ctx = context(table.batchGetKeys, { now: () => clock });
        table.batchGetKeys.mockImplementation(async (keys: ItemKey[]) => {
            clock += 100;
            return { found: [], unprocessed: [], consumedReadUnits: keys.length };
        });
        await checkExistence([keysOf(A), keysOf(B), keysOf(C)], ctx);
        // 2 RCU at 2/s = 1000 ms less 100 ms; then 1 RCU = 500 ms less 100 ms
        expect(ctx.sleep.mock.calls).toEqual([[900], [400]]);
    });

    test('retries unprocessed keys first and never classifies them as absent', async () => {
        let round = 0;
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => {
            round++;
            return round === 1
                ? { found: [], unprocessed: keys, consumedReadUnits: 0 }
                : { found: keys.filter(key => id(key) === id(keysOf(A))), unprocessed: [], consumedReadUnits: keys.length };
        });
        const ctx = context(batchGetKeys, { batchSize: 1 });
        const result = await checkExistence([keysOf(A), keysOf(B)], ctx);
        expect(result).toEqual({ present: [keysOf(A)], absent: [keysOf(B)], consumedReadUnits: 2 });
        expect(batchGetKeys.mock.calls).toEqual([[[keysOf(A)]], [[keysOf(A)]], [[keysOf(B)]]]);
        // One stalled round backs off 1 s; the paced sleeps follow the RCU actually consumed.
        expect(ctx.sleep.mock.calls).toEqual([[STALL_BACKOFF_MS], [500], [500]]);
    });

    test('aborts after 8 consecutive all-unprocessed rounds, backing off linearly', async () => {
        expect(MAX_STALLED_ROUNDS).toBe(8);
        expect(STALL_BACKOFF_MS).toBe(1000);
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => ({ found: [], unprocessed: keys, consumedReadUnits: 0 }));
        const ctx = context(batchGetKeys);
        await expect(checkExistence([keysOf(A)], ctx)).rejects.toThrow(
            new Error('BatchGetItem returned every key unprocessed 8 times in a row; aborting (DynamoDB is throttling: retry later or lower --rate-limit-rcu-per-sec)')
        );
        expect(batchGetKeys).toHaveBeenCalledTimes(8);
        expect(ctx.sleep.mock.calls).toEqual([[1000], [2000], [3000], [4000], [5000], [6000], [7000]]);
    });

    test('partial progress resets the stall count', async () => {
        const script = [
            ...Array.from({ length: 7 }, () => 'stall'),
            'partial',
            ...Array.from({ length: 7 }, () => 'stall'),
            'done',
        ];
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => {
            const step = script.shift();
            if(step === 'stall') {
                return { found: [], unprocessed: keys, consumedReadUnits: 0 };
            }
            if(step === 'partial') {
                return { found: [keys[0]], unprocessed: keys.slice(1), consumedReadUnits: 1 };
            }
            return { found: keys, unprocessed: [], consumedReadUnits: keys.length };
        });
        const result = await checkExistence([keysOf(A), keysOf(B)], context(batchGetKeys));
        expect(result.present).toEqual([keysOf(A), keysOf(B)]);
        expect(batchGetKeys).toHaveBeenCalledTimes(16);
    });

    test('fails closed when DynamoDB omits ConsumedCapacity', async () => {
        const batchGetKeys = mock(async (): Promise<BatchGetKeysResult> => ({ found: [], unprocessed: [], consumedReadUnits: undefined }));
        await expect(checkExistence([keysOf(A)], context(batchGetKeys))).rejects.toThrow(
            new Error('BatchGetItem reported no ConsumedCapacity; refusing to continue without RCU pacing')
        );
    });

    test('reports each request\'s present and absent keys before pausing for it, never unprocessed ones', async () => {
        let round = 0;
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => {
            round++;
            return round === 1
                ? { found: [keysOf(A)], unprocessed: [keysOf(C)], consumedReadUnits: 2 }
                : { found: [], unprocessed: [], consumedReadUnits: keys.length };
        });
        const ctx = context(batchGetKeys, { batchSize: 3 });
        const events: unknown[] = [];
        ctx.sleep.mockImplementation(async (ms: number) => {
            events.push(['sleep', ms]);
        });
        const result = await checkExistence([keysOf(A), keysOf(B), keysOf(C)], ctx, (checked) => {
            events.push(['checked', checked]);
        });
        expect(events).toEqual([
            ['checked', { present: [keysOf(A)], absent: [keysOf(B)] }],
            ['sleep', 1000],
            ['checked', { present: [], absent: [keysOf(C)] }],
            ['sleep', 500],
        ]);
        expect(result).toEqual({ present: [keysOf(A)], absent: [keysOf(B), keysOf(C)], consumedReadUnits: 3 });
    });

    test('makes no request for no keys', async () => {
        const table = fakeTable([]);
        expect(await checkExistence([], context(table.batchGetKeys))).toEqual({ present: [], absent: [], consumedReadUnits: 0 });
        expect(table.batchGetKeys).not.toHaveBeenCalled();
    });

    test('keeps each batch\'s present and absent keys in request order, not reversed', async () => {
        const D = '/events/activity/chat/2026-08-04T00-00-00-000Z';
        const table = fakeTable([A, C]);
        const ctx = context(table.batchGetKeys, { batchSize: 4 });
        const result = await checkExistence([keysOf(A), keysOf(B), keysOf(C), keysOf(D)], ctx);
        expect(result.present).toEqual([keysOf(A), keysOf(C)]);
        expect(result.absent).toEqual([keysOf(B), keysOf(D)]);
    });

    test('a non-stalled round resets the streak so it takes a fresh 8 stalls to abort', async () => {
        let round = 0;
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => {
            round++;
            return round === 1
                ? { found: keys, unprocessed: [], consumedReadUnits: keys.length }
                : { found: [], unprocessed: keys, consumedReadUnits: 0 };
        });
        const ctx = context(batchGetKeys, { batchSize: 1 });
        await expect(checkExistence([keysOf(A), keysOf(B)], ctx)).rejects.toThrow(
            'BatchGetItem returned every key unprocessed 8 times in a row'
        );
        expect(batchGetKeys).toHaveBeenCalledTimes(9);
    });

    test('awaits the pacing sleep before starting the next request', async () => {
        let resolveFirstSleep: (() => void) | undefined;
        let sleepCalls = 0;
        const sleep = mock(() => {
            sleepCalls++;
            if(sleepCalls === 1) {
                return new Promise<void>((resolve) => {
                    resolveFirstSleep = resolve;
                });
            }
            return Promise.resolve(); // pacing after the last batch is not under test here
        });
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => ({ found: keys, unprocessed: [], consumedReadUnits: 1 }));
        const ctx = { batchGetKeys, batchSize: 1, rateLimitRcuPerSec: 1, now: () => 0, sleep };
        const promise = checkExistence([keysOf(A), keysOf(B)], ctx);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(batchGetKeys).toHaveBeenCalledTimes(1);
        resolveFirstSleep?.();
        const result = await promise;
        expect(batchGetKeys).toHaveBeenCalledTimes(2);
        expect(result.present).toEqual([keysOf(A), keysOf(B)]);
    });

    test('awaits the stall backoff sleep before the retried request', async () => {
        let resolveSleep: (() => void) | undefined;
        const sleep = mock(() => new Promise<void>((resolve) => {
            resolveSleep = resolve;
        }));
        let round = 0;
        const batchGetKeys = mock(async (keys: ItemKey[]): Promise<BatchGetKeysResult> => {
            round++;
            return round === 1
                ? { found: [], unprocessed: keys, consumedReadUnits: 0 }
                : { found: keys, unprocessed: [], consumedReadUnits: 0 };
        });
        const ctx = { batchGetKeys, batchSize: 1, rateLimitRcuPerSec: 1, now: () => 0, sleep };
        const promise = checkExistence([keysOf(A)], ctx);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(batchGetKeys).toHaveBeenCalledTimes(1);
        resolveSleep?.();
        const result = await promise;
        expect(batchGetKeys).toHaveBeenCalledTimes(2);
        expect(result.present).toEqual([keysOf(A)]);
    });
});

// ── The run ───────────────────────────────────────────────────────────────────

describe('prune-vector-orphans run', () => {
    test('--help prints usage and opens nothing', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        await main(['bun', 'script', '--help'], runtime.deps);
        expect(runtime.output()).toContain('Usage: bun tools/prune-vector-orphans.ts [options]');
        expect(runtime.deps.openStorage).not.toHaveBeenCalled();
    });

    test('a dry run lists exactly the orphans under the prefix and deletes nothing', async () => {
        const index = openIndex();
        for(const memoryPath of [A, B, LIVE, C, '/events/activityx/chat/x', '/events/other/x']) {
            seed(index, memoryPath);
        }
        const table = fakeTable([LIVE]);
        const runtime = makeRuntime(index, table);

        await main(['bun', 'script', '--db-path=/live/memory-vec.sqlite'], runtime.deps);

        expect(runtime.output()).toBe(`Vector orphan prune (dry run)
  Table: isambard-test
  Database: /live/memory-vec.sqlite
  Prefix: /events/activity/
  Rate limit: 2 RCU/sec, strongly consistent BatchGetItem batches of 4
[dry-run] orphan: ${A}
[dry-run] orphan: ${B}
[dry-run] orphan: ${C}

Existence check complete:
  Rows under prefix: 4
  Malformed (untouched): 0
  Present in DynamoDB: 1
  Absent (orphans): 3
  RCU consumed: 4
  Elapsed: 0.0s
Dry run: nothing deleted. Re-run with --execute to delete the 3 orphan(s).
`);
        expect(remainingPaths(index)).toHaveLength(6);
        expect(runtime.deps.openVectorIndex).toHaveBeenCalledWith('/live/memory-vec.sqlite');
        expect(runtime.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('--execute re-checks and deletes only the absent rows under the prefix', async () => {
        const index = openIndex();
        for(const memoryPath of [A, B, LIVE, '/events/activityx/chat/x', '/events/other/x']) {
            seed(index, memoryPath);
        }
        const table = fakeTable([LIVE]);
        const runtime = makeRuntime(index, table);

        await main(['bun', 'script', '--execute'], runtime.deps);

        expect(remainingPaths(index).toSorted((a, b) => a.localeCompare(b))).toEqual([LIVE, '/events/activityx/chat/x', '/events/other/x']);
        // Phase 1 checks all three keys (one batch of 4); phase 2 re-checks the two orphans.
        expect(table.batchGetKeys.mock.calls).toEqual([[[keysOf(A), keysOf(B), keysOf(LIVE)]], [[keysOf(A), keysOf(B)]]]);
        expect(runtime.output()).toContain('Vector orphan prune (EXECUTE)\n');
        expect(runtime.output()).toContain(`orphan: ${A}\norphan: ${B}\n`);
        expect(runtime.output()).not.toContain('[dry-run]');
        expect(runtime.output()).toContain(`
Prune complete:
  Deleted: 2
  Kept, reappeared in DynamoDB: 0
  Kept, re-indexed since the snapshot: 0
  Delete errors: 0
  RCU consumed (total): 5
  Elapsed: 0.0s
`);
    });

    test('re-checks in batch-size chunks and keeps a key that reappeared in DynamoDB', async () => {
        const index = openIndex();
        for(const memoryPath of [A, B, C, LIVE]) {
            seed(index, memoryPath);
        }
        const table = fakeTable([LIVE]);
        let calls = 0;
        const check = table.batchGetKeys.getMockImplementation()!;
        table.batchGetKeys.mockImplementation(async (keys: ItemKey[]) => {
            calls++;
            if(calls === 3) {
                table.existing.add(id(keysOf(B))); // B is re-created before its re-check
            }
            return check(keys);
        });
        const runtime = makeRuntime(index, table);

        await main(['bun', 'script', '--execute', '--batch-size=2'], runtime.deps);

        expect(table.batchGetKeys.mock.calls.slice(2)).toEqual([[[keysOf(A), keysOf(B)]], [[keysOf(C)]]]);
        expect(remainingPaths(index).toSorted((a, b) => a.localeCompare(b))).toEqual([B, LIVE]);
        expect(runtime.output()).toContain(`kept (reappeared in DynamoDB): ${B}\n`);
        expect(runtime.output()).toContain('  Deleted: 2\n  Kept, reappeared in DynamoDB: 1\n');
    });

    test('deletes each re-checked orphan before pausing for the next read, never between its re-check and its delete', async () => {
        const index = openIndex();
        for(const memoryPath of [A, B, C, LIVE]) {
            seed(index, memoryPath);
        }
        const table = fakeTable([LIVE]);
        const events: string[] = [];
        const check = table.batchGetKeys.getMockImplementation()!;
        table.batchGetKeys.mockImplementation(async (keys: ItemKey[]) => {
            events.push(`read ${keys.length}`);
            return check(keys);
        });
        const runtime = makeRuntime(index, table);
        runtime.deps.sleep.mockImplementation(async (ms: number) => {
            events.push(`sleep ${ms}, rows ${remainingPaths(index).length}`);
        });

        await main(['bun', 'script', '--execute', '--batch-size=2'], runtime.deps);

        // 1 RCU per key at 2 RCU/s is 500 ms per key; the clock never advances.
        expect(events).toEqual([
            'read 2', 'sleep 1000, rows 4', // existence check: A, B
            'read 2', 'sleep 1000, rows 4', // existence check: C, LIVE
            'read 2', 'sleep 1000, rows 2', // re-check A, B: both already deleted when the pause starts
            'read 1', 'sleep 500, rows 1', // re-check C: already deleted
        ]);
        expect(remainingPaths(index)).toEqual([LIVE]);
    });

    test('keeps a row re-indexed after the snapshot (generation changed), even if still absent', async () => {
        const index = openIndex();
        seed(index, A);
        seed(index, LIVE);
        const table = fakeTable([LIVE]);
        let calls = 0;
        const check = table.batchGetKeys.getMockImplementation()!;
        table.batchGetKeys.mockImplementation(async (keys: ItemKey[]) => {
            calls++;
            if(calls === 2) {
                seed(index, A, 2); // the indexer rewrote A between the scan and the delete
            }
            return check(keys);
        });
        const runtime = makeRuntime(index, table);

        await main(['bun', 'script', '--execute'], runtime.deps);

        expect(remainingPaths(index).toSorted((a, b) => a.localeCompare(b))).toEqual([A, LIVE]);
        expect(runtime.output()).toContain(`kept (re-indexed since the snapshot): ${A}\n`);
        expect(runtime.output()).toContain('  Deleted: 0\n  Kept, reappeared in DynamoDB: 0\n  Kept, re-indexed since the snapshot: 1\n');
    });

    test('reports malformed rows and never checks or deletes them', async () => {
        const index = openIndex();
        seed(index, LIVE);
        seedRaw(index, 'DIR#/events/activity/chat', 'FILE#');
        seedRaw(index, 'DIR#/events/activity/', 'FILE#x');
        const table = fakeTable([LIVE]);
        const runtime = makeRuntime(index, table);

        await main(['bun', 'script', '--execute'], runtime.deps);

        expect(runtime.output()).toContain('malformed (left untouched): pk=DIR#/events/activity/chat sk=FILE#\n');
        expect(runtime.output()).toContain('malformed (left untouched): pk=DIR#/events/activity/ sk=FILE#x\n');
        expect(runtime.output()).toContain('  Rows under prefix: 3\n  Malformed (untouched): 2\n  Present in DynamoDB: 1\n  Absent (orphans): 0\n');
        expect(table.batchGetKeys.mock.calls).toEqual([[[keysOf(LIVE)]]]);
        expect(index.listRowsByPathPrefix('/events/activity/')).toHaveLength(3);
    });

    test('refuses to delete when every key is absent, unless --allow-all-absent', async () => {
        const index = openIndex();
        seed(index, A);
        const runtime = makeRuntime(index, fakeTable([]));
        await expect(main(['bun', 'script', '--execute'], runtime.deps)).rejects.toThrow(new Error(
            'Refusing to delete: every one of the 1 key(s) under /events/activity/ is absent from isambard-test. '
            + 'Check the stage, table and credentials; pass --allow-all-absent only if this is really intended.'
        ));
        expect(remainingPaths(index)).toEqual([A]);
        expect(runtime.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);

        const allowed = makeRuntime(openIndex(), fakeTable([]));
        seed(indexes.at(-1)!, A);
        await main(['bun', 'script', '--execute', '--allow-all-absent'], allowed.deps);
        expect(remainingPaths(indexes.at(-1)!)).toEqual([]);
    });

    test('an --execute run with no orphans deletes nothing and succeeds', async () => {
        const index = openIndex();
        seed(index, LIVE);
        const table = fakeTable([LIVE]);
        const runtime = makeRuntime(index, table);
        await main(['bun', 'script', '--execute'], runtime.deps);
        expect(table.batchGetKeys).toHaveBeenCalledTimes(1);
        expect(runtime.output()).toContain('  Deleted: 0\n');
        // An empty index is not "all absent": nothing is refused
        await main(['bun', 'script', '--execute'], makeRuntime(openIndex(), fakeTable([])).deps);
    });

    test('warns when the prefix is narrower than the default and checks only below it', async () => {
        const index = openIndex();
        seed(index, A);
        seed(index, C);
        const table = fakeTable([A]);
        const runtime = makeRuntime(index, table);
        await main(['bun', 'script', '--prefix=/events/activity/chat/'], runtime.deps);
        expect(runtime.output()).toContain('Warning: checking only /events/activity/chat/, not all of /events/activity/\n');
        expect(table.batchGetKeys.mock.calls).toEqual([[[keysOf(A)]]]);
    });

    test('does not warn for the default prefix', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.output()).not.toContain('Warning');
    });

    test('a missing ConsumedCapacity aborts before any delete, after cleanup', async () => {
        const index = openIndex();
        seed(index, A);
        seed(index, LIVE);
        const table = fakeTable([LIVE]);
        table.batchGetKeys.mockImplementation(async () => ({ found: [], unprocessed: [], consumedReadUnits: undefined }));
        const runtime = makeRuntime(index, table);
        await expect(main(['bun', 'script', '--execute'], runtime.deps)).rejects.toThrow('BatchGetItem reported no ConsumedCapacity');
        expect(remainingPaths(index)).toHaveLength(2);
        expect(runtime.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('a delete failure is reported per row and fails the run after finishing and cleaning up', async () => {
        const index = openIndex();
        for(const memoryPath of [A, B, LIVE]) {
            seed(index, memoryPath);
        }
        const runtime = makeRuntime(index, fakeTable([LIVE]));
        const opened = runtime.deps.openVectorIndex.getMockImplementation()!;
        runtime.deps.openVectorIndex.mockImplementation(async (dbPath: string) => {
            const real = await opened(dbPath);
            return {
                ...real,
                'delete': mock((pk: string, sk: string, expected?: Parameters<VectorIndex['delete']>[2]) => {
                    if(sk === keysOf(A).SK) {
                        throw new Error('database is locked');
                    }
                    return real.delete(pk, sk, expected);
                }),
            };
        });
        await expect(main(['bun', 'script', '--execute'], runtime.deps)).rejects.toThrow(new Error('Prune completed with 1 delete error(s)'));
        expect(runtime.output()).toContain(`delete failed: ${A}: database is locked\n`);
        expect(runtime.output()).toContain('  Deleted: 1\n  Kept, reappeared in DynamoDB: 0\n  Kept, re-indexed since the snapshot: 0\n  Delete errors: 1\n');
        expect(remainingPaths(index).toSorted((a, b) => a.localeCompare(b))).toEqual([A, LIVE]);
        expect(runtime.close).toHaveBeenCalledTimes(1);
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('a non-Error delete failure is stringified', async () => {
        const index = openIndex();
        seed(index, A);
        seed(index, LIVE);
        const runtime = makeRuntime(index, fakeTable([LIVE]));
        const opened = runtime.deps.openVectorIndex.getMockImplementation()!;
        runtime.deps.openVectorIndex.mockImplementation(async (dbPath: string) => ({
            ...(await opened(dbPath)),
            'delete': mock(() => {
                throw 'busy';
            }),
        }));
        await expect(main(['bun', 'script', '--execute'], runtime.deps)).rejects.toThrow('Prune completed with 1 delete error(s)');
        expect(runtime.output()).toContain(`delete failed: ${A}: busy\n`);
    });

    test('releases the storage client if opening the vector index fails', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        runtime.deps.openVectorIndex.mockRejectedValueOnce(new Error('cannot open'));
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('cannot open');
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
        expect(runtime.close).not.toHaveBeenCalled();
    });

    test('releases the storage client even if closing the index throws', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        runtime.close.mockImplementationOnce(() => {
            throw new Error('close failed');
        });
        await expect(main(['bun', 'script'], runtime.deps)).rejects.toThrow('close failed');
        expect(runtime.destroy).toHaveBeenCalledTimes(1);
    });

    test('reports elapsed seconds from the injected clock', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        runtime.deps.now.mockReturnValueOnce(1000).mockReturnValue(3500);
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.output()).toContain('  Elapsed: 2.5s\n');
    });

    test('computes elapsed seconds by dividing milliseconds by exactly 1000', async () => {
        const runtime = makeRuntime(openIndex(), fakeTable([]));
        runtime.deps.now.mockReturnValueOnce(0).mockReturnValue(52_101);
        await main(['bun', 'script'], runtime.deps);
        expect(runtime.output()).toContain('  Elapsed: 52.1s\n');
    });

    test('the default runtime uses the preloaded in-memory owners', async () => {
        const before = mockPruneRuntime.writes.length;
        const opens = mockPruneRuntime.opens;
        await main(['bun', 'script']);
        expect(mockPruneRuntime.writes.slice(before).join('')).toContain('Table: mock-table');
        expect(mockPruneRuntime.opens).toBe(opens + 1);
        expect(mockPruneRuntime.closes).toBe(opens + 1);
    });
});

describe('runPruneCli', () => {
    test('runs only as the main module', async () => {
        const run = mock(async () => undefined);
        await runPruneCli(false, run);
        expect(run).not.toHaveBeenCalled();
        await runPruneCli(true, run);
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('propagates the run\'s failure', async () => {
        const failure = new Error('failed');
        await expect(runPruneCli(true, async () => {
            throw failure;
        })).rejects.toBe(failure);
    });
});
