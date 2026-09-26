import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { MemoryToolKeyGenerator } from '@/storage/memory-tool/key-generator';
import { createIndexLayer } from '@/storage/memory-tool/types';
import { VectorIndex } from '@/storage/memory-vec-store/backend';
import { createVectorCrossCheckScheduler, VECTOR_CROSS_CHECK_INTERVAL_MS, type VectorCrossCheckDeps } from '@/storage/memory-vec-store/cross-check';
import { sha256Hex } from '@/storage/memory-vec-store/hash';
import type { IndexerJob, IndexerUpsertJob, VectorIndexEntry } from '@/storage/memory-vec-store/types';

const key = (n: number): { PK: string, SK: string } => ({ PK: 'DIR#/identity', SK: `FILE#${n}.md` });
const memoryItem = (n: number, content = 'unchanged'): Record<string, unknown> => ({
    ...key(n),
    GSI1PK:      'LAYER#identity',
    GSI1SK:      'UPDATED#2026-09-25T01:00:00.000Z',
    path:        `/identity/${n}.md`,
    content,
    contentType: 'text/plain',
    metadata:    {},
    createdAt:   '2026-09-25T00:00:00.000Z',
    updatedAt:   '2026-09-25T01:00:00.000Z',
});

type Item = Record<string, unknown>;
interface Key { PK: string, SK: string }
interface Read { consistent: boolean, keys: string[] }
const NOW = 5000;
const VERSION = Date.parse('2026-09-25T01:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const RUN_FAILED = 'Vector cross-check failed; retry scheduled';
const NOT_CONVERGED = new Error('Vector cross-check requeue did not converge');
const identityHash = async (n: number, content = 'unchanged'): Promise<string> => sha256Hex(`/identity/${n}.md\n${content}`);
const sks = (...ns: number[]): string[] => ns.map(n => key(n).SK);
const numberOf = (sk: string): number => Number(sk.slice('FILE#'.length, -'.md'.length));
const makeLogger = (): { info: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn> } => ({ info: jest.fn(), error: jest.fn() });
type TestLogger = ReturnType<typeof makeLogger>;
const summaryOf = (logger: TestLogger): Record<string, unknown> => logger.info.mock.calls[0]?.[0] as Record<string, unknown>;
const recordingSleep = (sleeps: number[]) => async (ms: number): Promise<void> => {
    sleeps.push(ms);
};
const flush = async (ticks = 10): Promise<void> => {
    if(ticks > 0) {
        await Promise.resolve();
        await flush(ticks - 1);
    }
};

/** A BatchGet fake answering each key from `read`, recording every request's consistency and SKs in order. */
function fakeTable(read: (key: Key, consistent: boolean, call: number) => Item | undefined, capacity: (call: number) => number = () => 1): { send: ReturnType<typeof jest.fn<(command: BatchGetCommand) => Promise<{ Responses: { test: Item[] }, ConsumedCapacity: { CapacityUnits: number }[] }>>>, reads: Read[] } {
    const reads: Read[] = [];
    const send = jest.fn(async (command: BatchGetCommand) => {
        const request = command.input.RequestItems?.test;
        const keys = (request?.Keys ?? []) as Key[];
        const consistent = request?.ConsistentRead ?? false;
        reads.push({ consistent, keys: keys.map(k => k.SK) });
        const call = reads.length;
        const items = keys.map(k => read(k, consistent, call)).filter((item): item is Item => item !== undefined);
        return { Responses: { test: items }, ConsumedCapacity: [{ CapacityUnits: capacity(call) }] };
    });
    return { send, reads };
}

/** The run's summary error is the AbortError thrown by its own abort checks, not a logged failure. */
function expectAborted(logger: TestLogger): void {
    const error = summaryOf(logger).error as DOMException;
    expect(error).toBeInstanceOf(DOMException);
    expect([error.name, error.message]).toEqual(['AbortError', 'Aborted']);
    expect(logger.error).not.toHaveBeenCalled();
}

describe('weekly vector cross-check', () => {
    let db: Database;
    let index: VectorIndex;
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        index.close();
    });

    const openIndex = (): void => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
    };
    const seed = (n: number, contentHash: string, extra: Partial<VectorIndexEntry> = {}): void => {
        index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash, vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1, ...extra });
    };
    const rowOf = (n: number): ReturnType<VectorIndex['listRowSnapshotsAfter']>[number] | undefined => index.listRowSnapshotsAfter(0, 1000).find(row => row.pk === key(n).PK && row.sk === key(n).SK);
    const makeScheduler = (overrides: Partial<VectorCrossCheckDeps>): { scheduler: ReturnType<typeof createVectorCrossCheckScheduler>, logger: TestLogger } => {
        const logger = makeLogger();
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send: jest.fn() }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, now: () => NOW, sleep: async () => {}, ...overrides });
        return { scheduler, logger };
    };
    /** An indexer that ignores queued jobs and runs `onDrain` (which may throw) as its drain. */
    const withDrain = (onDrain: () => void): VectorCrossCheckDeps['indexer'] => ({
        enqueue: jest.fn(),
        drain:   async () => {
            onDrain();
        },
    });
    const removeRow1 = (): void => {
        index.delete(key(1).PK, key(1).SK);
    };
    /** Deletes row 1 and writes it back, which gives it a fresh rowid after every existing row. */
    const recreateRow1 = (contentHash: string): void => {
        removeRow1();
        seed(1, contentHash, { sourceUpdatedAt: VERSION });
    };
    /** An indexer whose drain applies each queued upsert to the index, as a healthy AsyncIndexer would. */
    const applyingIndexer = (): { enqueue: ReturnType<typeof jest.fn<(job: IndexerJob) => void>>, drain: ReturnType<typeof jest.fn<() => Promise<void>>> } => {
        const jobs: IndexerJob[] = [];
        const enqueue = jest.fn((job: IndexerJob) => {
            jobs.push(job);
        });
        const drain = jest.fn(async () => {
            const upserts = jobs.splice(0).filter((job): job is IndexerUpsertJob => job.kind === 'upsert');
            const hashes = await Promise.all(upserts.map(async job => sha256Hex(`${job.path}\n${job.content}`)));
            for(const [i, job] of upserts.entries()) {
                const keys = MemoryToolKeyGenerator.createKeys(job.path);
                index.upsert({ pk: keys.PK, sk: keys.SK, layer: job.layer, contentHash: hashes[i], vector: new Uint8Array(128) as never, updatedAt: 2, ttl: job.ttl ?? null, sourceUpdatedAt: job.sourceUpdatedAt });
            }
        });
        return { enqueue, drain };
    };

    it('pages by rowid and retains the cursor and schedule in SQLite', () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        for(let n = 1; n <= 3; n++) {
            index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash: `${n}`, vector: new Uint8Array(128) as never, updatedAt: n, ttl: null, sourceUpdatedAt: n });
        }
        const first = index.listRowSnapshotsAfter(0, 2);
        expect(first.map(row => row.sk)).toEqual(['FILE#1.md', 'FILE#2.md']);
        expect(first[0]).toStrictEqual({ rowid: first[0].rowid, pk: key(1).PK, sk: key(1).SK, contentHash: '1', updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        index.delete(key(1).PK, key(1).SK);
        expect(index.listRowSnapshotsAfter(first[1].rowid, 2).map(row => row.sk)).toEqual(['FILE#3.md']);
        expect(index.enrollCrossCheck(100, VECTOR_CROSS_CHECK_INTERVAL_MS)).toStrictEqual({ nextDueAt: 100 + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: null, lastCompletedRowid: 0 });
        index.saveCrossCheckState({ nextDueAt: 200, lastRunAt: 100, lastCompletedRowid: first[1].rowid });
        expect(index.enrollCrossCheck(999, VECTOR_CROSS_CHECK_INTERVAL_MS)).toStrictEqual({ nextDueAt: 200, lastRunAt: 100, lastCompletedRowid: first[1].rowid });
    });

    it('enrolls without a boot scan and schedules at the seven-day boundary', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const send = jest.fn(async () => ({ Responses: {}, ConsumedCapacity: [{ CapacityUnits: 0 }] }));
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger: { info: jest.fn(), error: jest.fn() } });
        scheduler.start();
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);
        expect(send).not.toHaveBeenCalled();
        expect(index.getCrossCheckState()?.nextDueAt).toBe(1000 + VECTOR_CROSS_CHECK_INTERVAL_MS);
        jest.advanceTimersByTime(VECTOR_CROSS_CHECK_INTERVAL_MS - 1);
        expect(send).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        await scheduler.stop();
        expect(index.getCrossCheckState()?.lastRunAt).toBe(1000 + VECTOR_CROSS_CHECK_INTERVAL_MS);
    });

    it('does not tombstone a fully absent table and retries without checkpointing', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'x', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        const send = jest.fn(async () => ({ Responses: {}, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const getDocClient = jest.fn(() => ({ send }));
        const logger = makeLogger();
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { getDocClient }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('Vector cross-check refused mass absence: 1/1 keys missing (wrong table or stage?)'), msg: RUN_FAILED }]]);
        expect(getDocClient).toHaveBeenCalledTimes(1);
        expect(index.getHash(key(1).PK, key(1).SK)).toBe('x');
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('fails closed when consumed capacity is omitted and persists a retry deadline', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'x', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const logger = { info: jest.fn(), error: jest.fn() };
        const send = jest.fn(async () => ({ Responses: {}, ConsumedCapacity: [] }));
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, now: () => 10_000, sleep: async () => {} });
        await scheduler.runOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('Vector cross-check BatchGetItem reported no ConsumedCapacity; refusing to continue without RCU pacing'), msg: RUN_FAILED }]]);
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: 3_610_000, lastRunAt: null, lastCompletedRowid: 0 });
        expect(index.getHash(key(1).PK, key(1).SK)).toBe('x');
    });

    it('fails closed when the consumed capacity list itself is missing', async () => {
        openIndex();
        seed(1, 'x');
        const send = jest.fn(async () => ({ Responses: {} }));
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('Vector cross-check BatchGetItem reported no ConsumedCapacity; refusing to continue without RCU pacing'), msg: RUN_FAILED }]]);
    });

    it('retries unprocessed keys with shared RCU pacing and keeps a strongly present row', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const hashes = await Promise.all([1, 2, 3].map(n => sha256Hex(`/identity/${n}.md\nunchanged`)));
        for(let n = 1; n <= 3; n++) {
            index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash: hashes[n - 1], vector: new Uint8Array(128) as never, updatedAt: n, ttl: null });
        }
        const sent: boolean[] = [];
        const sleeps: number[] = [];
        const send = jest.fn(async (command: BatchGetCommand) => {
            const strong = command.input.RequestItems?.test.ConsistentRead ?? false;
            sent.push(strong);
            if(strong) {
                return { Responses: { test: [memoryItem(3)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
            }
            if(sent.length === 1) {
                return { Responses: { test: [memoryItem(1)] }, UnprocessedKeys: { test: { Keys: [key(2), key(3)] } }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
            }
            return { Responses: { test: [memoryItem(2)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
        });
        const logger = { info: jest.fn(), error: jest.fn() };
        const scheduler = createVectorCrossCheckScheduler({
            vectorIndex: index,
            docClient:   { send },
            tableName:   'test',
            indexer:     { enqueue: jest.fn(), drain: async () => {} },
            logger,
            now:         () => 1000,
            sleep:       async (ms) => {
                sleeps.push(ms);
            },
        });
        await scheduler.runOnce();
        expect(sent).toEqual([false, false, true]);
        expect(sleeps).toEqual([1000, 2000]);
        expect(logger.error).not.toHaveBeenCalled();
        expect(index.getHash(key(3).PK, key(3).SK)).toBe(hashes[2]);
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 3, deleted: 0, requeued: 0, rcu: 3, completed: true });
    });

    it('leaves failed indexer requeues uncheckpointed after drain', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        const raw = { ...key(1), GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2026-09-25T01:00:00.000Z', path: '/identity/1.md', content: 'new', contentType: 'text/plain', metadata: {}, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T01:00:00.000Z' };
        const send = jest.fn(async () => ({ Responses: { test: [raw] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const enqueue = jest.fn();
        const drain = jest.fn(async () => {});
        const logger = { info: jest.fn(), error: jest.fn() };
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue, drain }, logger, sleep: async () => {} });
        await scheduler.runOnce();
        expect(enqueue).toHaveBeenCalledWith({ kind: 'upsert', path: '/identity/1.md', layer: 'identity', content: 'new', ttl: undefined, sourceUpdatedAt: Date.parse(raw.updatedAt) });
        expect(drain).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(3);
        expect(logger.error.mock.calls[0]?.[0].error).toEqual(new Error('Vector cross-check requeue did not converge'));
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
    });

    it('checks content rather than read-only updatedAt changes, confirms absence and preserves a mixed page', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const content = 'unchanged';
        const hashes = await Promise.all([1, 2, 3].map(n => sha256Hex(`/identity/${n}.md\n${content}`)));
        for(let n = 1; n <= 3; n++) {
            index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash: hashes[n - 1], vector: new Uint8Array(128) as never, updatedAt: n, ttl: null, sourceUpdatedAt: n });
        }
        const item = (n: number): Record<string, unknown> => ({ ...key(n), GSI1PK: 'LAYER#identity', GSI1SK: 'UPDATED#2026-09-25T01:00:00.000Z', path: `/identity/${n}.md`, content, contentType: 'text/plain', metadata: {}, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T01:00:00.000Z' });
        const calls: { consistent: boolean, capacity: string }[] = [];
        const send = jest.fn(async (command: BatchGetCommand) => {
            const consistent = command.input.RequestItems?.test.ConsistentRead ?? false;
            calls.push({ consistent, capacity: command.input.ReturnConsumedCapacity ?? '' });
            return { Responses: { test: consistent ? [] : [item(1), item(2)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
        });
        const enqueue = jest.fn();
        const logger = { info: jest.fn(), error: jest.fn() };
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue, drain: async () => {} }, logger, sleep: async () => {} });
        await scheduler.runOnce();
        expect(calls).toEqual([{ consistent: false, capacity: 'TOTAL' }, { consistent: true, capacity: 'TOTAL' }]);
        expect(index.getHash(key(3).PK, key(3).SK)).toBeUndefined();
        expect(enqueue).not.toHaveBeenCalled();
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips a stale item that disappears during strong confirmation', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        let calls = 0;
        const send = jest.fn(async () => ({ Responses: { test: ++calls === 1 ? [memoryItem(1, 'new')] : [] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const enqueue = jest.fn();
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue, drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(send).toHaveBeenCalledTimes(2);
        expect(enqueue).not.toHaveBeenCalled();
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 1, deleted: 1, completed: true });
        expect(index.getHash(key(1).PK, key(1).SK)).toBeUndefined();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('removes a stale requeue that disappears before post-drain verification', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        let calls = 0;
        const send = jest.fn(async () => ({ Responses: { test: ++calls === 3 ? [] : [memoryItem(1, 'new')] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(index.getHash(key(1).PK, key(1).SK)).toBeUndefined();
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ deleted: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips a DynamoDB row that becomes malformed after requeue', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        let calls = 0;
        const send = jest.fn(async () => ({ Responses: { test: [++calls === 3 ? { ...memoryItem(1, 'new'), contentType: 'invalid' } : memoryItem(1, 'new')] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ malformed: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('converges content requeues and TTL-only updates before checkpointing', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const first = { ...memoryItem(1, 'new'), TTL: 1_800_000_000 };
        const second = { ...memoryItem(2), TTL: 1_800_000_001 };
        const version = Date.parse('2026-09-25T01:00:00.000Z');
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        index.upsert({ pk: key(2).PK, sk: key(2).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/2.md\nunchanged'), vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        const send = jest.fn(async () => ({ Responses: { test: [first, second] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const enqueue = jest.fn();
        const drain = jest.fn(async () => {
            index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/1.md\nnew'), vector: new Uint8Array(128) as never, updatedAt: 2, ttl: first.TTL as never, sourceUpdatedAt: version });
        });
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue, drain }, logger, sleep: async () => {} }).runOnce();
        expect(enqueue).toHaveBeenCalledWith({ kind: 'upsert', path: '/identity/1.md', layer: 'identity', content: 'new', ttl: first.TTL, sourceUpdatedAt: version });
        expect(index.listRowSnapshotsAfter(0, 2).map(row => [row.ttl, row.sourceUpdatedAt])).toStrictEqual([[first.TTL, version], [second.TTL, version]]);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 2, requeued: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips malformed legacy keys and continues past them', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: 'INVALID', sk: 'FILE#bad.md', layer: createIndexLayer('identity'), contentHash: 'bad', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/1.md\nunchanged'), vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const send = jest.fn(async () => ({ Responses: { test: [memoryItem(1)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 1, malformed: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips malformed DynamoDB items and continues checking the rest of the page', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const hashes = await Promise.all([1, 2].map(async n => sha256Hex(`/identity/${n}.md\nunchanged`)));
        for(let n = 1; n <= 2; n++) {
            index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash: hashes[n - 1], vector: new Uint8Array(128) as never, updatedAt: n, ttl: null });
        }
        const send = jest.fn(async () => ({ Responses: { test: [memoryItem(1), { ...memoryItem(2), contentType: 'invalid' }] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 2, malformed: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not retry forever when DynamoDB has an older source version', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'newer', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: Date.parse('2026-09-25T02:00:00.000Z') });
        const send = jest.fn(async () => ({ Responses: { test: [memoryItem(1, 'older')] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        const enqueue = jest.fn();
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue, drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(enqueue).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(2);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 1, requeued: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('coalesces concurrent runs and aborts the in-flight DynamoDB request on stop', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'x', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        let signal: AbortSignal | undefined;
        const send = jest.fn((_command: BatchGetCommand, options?: { abortSignal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
            signal = options?.abortSignal;
            signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            });
        }));
        const logger = { info: jest.fn(), error: jest.fn() };
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger });
        const first = scheduler.runOnce();
        expect(scheduler.runOnce()).toBe(first);
        await Promise.resolve();
        await Promise.resolve();
        expect(send).toHaveBeenCalledTimes(1);
        await scheduler.stop();
        await first;
        expect(signal?.aborted).toBe(true);
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('retries a transient SQLite enrollment failure rather than losing the timer', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const logger = { info: jest.fn(), error: jest.fn() };
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send: jest.fn(async () => ({ Responses: {}, ConsumedCapacity: [{ CapacityUnits: 0 }] })) }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger });
        scheduler.start();
        const enroll = index.enrollCrossCheck.bind(index);
        let fails = 1;
        jest.spyOn(index, 'enrollCrossCheck').mockImplementation((...args) => {
            if(fails-- > 0) {
                throw new Error('SQLITE_BUSY');
            }
            return enroll(...args);
        });
        jest.advanceTimersByTime(VECTOR_CROSS_CHECK_INTERVAL_MS);
        await flush();
        expect(logger.error.mock.calls).toEqual([
            [{ error: new Error('SQLITE_BUSY'), msg: 'Vector cross-check could not enroll' }],
            [{ error: new Error('SQLITE_BUSY'), msg: 'Vector cross-check could not start; retry scheduled' }],
        ]);
        jest.advanceTimersByTime(60 * 60 * 1000);
        await Promise.resolve();
        await scheduler.stop();
        expect(index.getCrossCheckState()?.lastRunAt).toBe(1000 + VECTOR_CROSS_CHECK_INTERVAL_MS + 60 * 60 * 1000);
    });

    it('stops after the bounded RCU budget and persists the completed page cursor', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/1.md\nunchanged'), vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const send = jest.fn(async () => ({ Responses: { test: [memoryItem(1)] }, ConsumedCapacity: [{ CapacityUnits: 2000 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBeGreaterThan(0);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 1, rcu: 2000, completed: false });
    });

    it('backs off exponentially on repeated unprocessed-key responses', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/1.md\nunchanged'), vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const sleeps: number[] = [];
        let attempts = 0;
        const send = jest.fn(async () => {
            attempts++;
            return { Responses: { test: attempts === 4 ? [memoryItem(1)] : [] }, UnprocessedKeys: attempts === 4 ? undefined : { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 0.5 }] };
        });
        await createVectorCrossCheckScheduler({
            vectorIndex: index,
            docClient:   { send },
            tableName:   'test',
            indexer:     { enqueue: jest.fn(), drain: async () => {} },
            logger:      { info: jest.fn(), error: jest.fn() },
            now:         () => 1000,
            sleep:       async (ms) => {
                sleeps.push(ms);
            },
        }).runOnce();
        expect(send).toHaveBeenCalledTimes(4);
        expect(sleeps).toEqual([1000, 2000, 4000]);
    });

    it('stops retrying unprocessed keys after ten paced attempts', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const send = jest.fn(async () => ({ Responses: {}, UnprocessedKeys: { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 0.5 }] }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, now: () => 1000, sleep: async () => {} }).runOnce();
        expect(send).toHaveBeenCalledTimes(11);
        expect(logger.error.mock.calls[0]?.[0].error).toEqual(new Error('Vector cross-check exhausted UnprocessedKeys retries'));
        expect(index.getCrossCheckState()?.lastCompletedRowid).toBe(0);
    });

    it('does not suppress an in-flight recreation stamped before orphan confirmation', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'old', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        index.upsert({ pk: key(2).PK, sk: key(2).SK, layer: createIndexLayer('identity'), contentHash: await sha256Hex('/identity/2.md\nunchanged'), vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const send = jest.fn(async (command: BatchGetCommand) => ({ Responses: { test: command.input.RequestItems?.test.ConsistentRead ? [] : [memoryItem(2)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger: { info: jest.fn(), error: jest.fn() }, now: () => 100, sleep: async () => {} }).runOnce();
        expect(index.getHash(key(1).PK, key(1).SK)).toBeUndefined();
        expect(index.upsert({ pk: key(1).PK, sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'recreated', vector: new Uint8Array(128) as never, updatedAt: 2, ttl: null, sourceUpdatedAt: 2 })).toBe(true);
        expect(index.getHash(key(1).PK, key(1).SK)).toBe('recreated');
    });

    it('deletes a majority of confirmed orphans without blocking later pages', async () => {
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db);
        const hashes = await Promise.all([1, 2, 3, 4, 5].map(async n => sha256Hex(`/identity/${n}.md\nunchanged`)));
        for(let n = 1; n <= 5; n++) {
            index.upsert({ pk: key(n).PK, sk: key(n).SK, layer: createIndexLayer('identity'), contentHash: hashes[n - 1], vector: new Uint8Array(128) as never, updatedAt: n, ttl: null });
        }
        const send = jest.fn(async (command: BatchGetCommand) => ({
            Responses:        { test: command.input.RequestItems?.test.ConsistentRead ? [] : [memoryItem(4), memoryItem(5)] },
            ConsumedCapacity: [{ CapacityUnits: 1 }],
        }));
        const logger = { info: jest.fn(), error: jest.fn() };
        await createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { send }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger, sleep: async () => {} }).runOnce();
        expect([1, 2, 3].map(n => index.getHash(key(n).PK, key(n).SK))).toEqual([undefined, undefined, undefined]);
        expect(logger.info.mock.calls[0]?.[0]).toMatchObject({ checked: 5, deleted: 3, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('sets the cross-check interval to exactly seven days', () => {
        openIndex();
        expect(VECTOR_CROSS_CHECK_INTERVAL_MS).toBe(604_800_000);
    });

    it('waits the one-second startup grace for an overdue check and then reschedules a week out', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(10_000);
        openIndex();
        index.enrollCrossCheck(0, 0);
        const { scheduler } = makeScheduler({ now: () => Date.now() });
        scheduler.start();
        jest.advanceTimersByTime(999);
        expect(index.getCrossCheckState()?.lastRunAt).toBeNull();
        jest.advanceTimersByTime(1);
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: 11_000 + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: 11_000, lastCompletedRowid: 0 });
        await flush();
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(VECTOR_CROSS_CHECK_INTERVAL_MS - 1);
        expect(index.getCrossCheckState()?.lastRunAt).toBe(11_000);
        jest.advanceTimersByTime(1);
        expect(index.getCrossCheckState()?.lastRunAt).toBe(11_000 + VECTOR_CROSS_CHECK_INTERVAL_MS);
        await scheduler.stop();
    });

    it('retries a failed timer enrollment after an hour', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(10_000);
        openIndex();
        const enroll = index.enrollCrossCheck.bind(index);
        let fails = 1;
        jest.spyOn(index, 'enrollCrossCheck').mockImplementation((...args) => {
            if(fails-- > 0) {
                throw new Error('SQLITE_BUSY');
            }
            return enroll(...args);
        });
        const { scheduler, logger } = makeScheduler({ now: () => Date.now() });
        scheduler.start();
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('SQLITE_BUSY'), msg: 'Vector cross-check enrollment failed; retry scheduled' }]]);
        jest.advanceTimersByTime(HOUR_MS - 1);
        expect(index.getCrossCheckState()).toBeUndefined();
        jest.advanceTimersByTime(1);
        expect(index.getCrossCheckState()?.lastRunAt).toBe(10_000 + HOUR_MS);
        await scheduler.stop();
    });

    it('clears the pending timer on stop and can be started again', async () => {
        jest.useFakeTimers();
        openIndex();
        const { scheduler } = makeScheduler({ now: () => Date.now() });
        scheduler.start();
        await scheduler.stop();
        expect(jest.getTimerCount()).toBe(0);
        scheduler.start();
        expect(jest.getTimerCount()).toBe(1);
        await scheduler.stop();
    });

    it('waits for an in-flight timed run on stop and schedules nothing after it', async () => {
        jest.useFakeTimers();
        jest.setSystemTime(10_000);
        openIndex();
        seed(1, await identityHash(1));
        index.enrollCrossCheck(0, 0);
        const gate = { respond: (): void => {} };
        const send = jest.fn(async () => {
            await new Promise<void>((resolve) => {
                gate.respond = resolve;
            });
            return { Responses: { test: [memoryItem(1)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, now: () => Date.now() });
        scheduler.start();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(send).toHaveBeenCalledTimes(1);
        let stopped = false;
        const stopping = scheduler.stop().finally(() => {
            stopped = true;
        });
        await flush();
        expect(stopped).toBe(false);
        gate.respond();
        await stopping;
        expectAborted(logger);
        await flush();
        expect(jest.getTimerCount()).toBe(0);
    });

    it('checks for abort before pacing an unprocessed-key retry', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const sleeps: number[] = [];
        const stopper = { stop: (): void => {} };
        const send = jest.fn(async () => {
            stopper.stop();
            return { Responses: { test: [] }, UnprocessedKeys: { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 1 }] };
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, sleep: recordingSleep(sleeps) });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expect(sleeps).toEqual([]);
        expectAborted(logger);
    });

    it('holds an unprocessed-key retry until its pacing sleep resolves', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const gate = { wake: (): void => {} };
        let calls = 0;
        const send = jest.fn(async () => (++calls === 1
            ? { Responses: { test: [] }, UnprocessedKeys: { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 1 }] }
            : { Responses: { test: [memoryItem(1)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const sleeps: number[] = [];
        const sleep = async (ms: number): Promise<void> => new Promise<void>((resolve) => {
            sleeps.push(ms);
            gate.wake = resolve;
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, sleep });
        const running = scheduler.runOnce();
        await flush();
        expect(sleeps).toEqual([1000]);
        expect(send).toHaveBeenCalledTimes(1);
        gate.wake();
        await running;
        expect(send).toHaveBeenCalledTimes(2);
        expect(summaryOf(logger)).toMatchObject({ checked: 1, completed: true });
    });

    it('rechecks abort after a pacing sleep before sending the retry', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const stopper = { stop: (): void => {} };
        let calls = 0;
        const send = jest.fn(async () => (++calls === 1
            ? { Responses: { test: [] }, UnprocessedKeys: { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 1 }] }
            : { Responses: { test: [memoryItem(1)] }, ConsumedCapacity: [{ CapacityUnits: 1 }] }));
        const sleep = async (): Promise<void> => {
            stopper.stop();
        };
        const { scheduler, logger } = makeScheduler({ docClient: { send }, sleep });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(send).toHaveBeenCalledTimes(1);
        expectAborted(logger);
    });

    it('keeps a missing row when the run is stopped during its strong confirmation', async () => {
        openIndex();
        const hash2 = await identityHash(2);
        seed(1, await identityHash(1));
        seed(2, hash2);
        const stopper = { stop: (): void => {} };
        const { send } = fakeTable((k, consistent) => {
            if(consistent) {
                stopper.stop();
                return undefined;
            }
            return k.SK === key(1).SK ? memoryItem(1) : undefined;
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(index.getHash(key(2).PK, key(2).SK)).toBe(hash2);
        expectAborted(logger);
    });

    it('keeps a stale row that vanishes when the run is stopped during its strong read', async () => {
        openIndex();
        seed(1, await identityHash(1));
        seed(2, 'old');
        const stopper = { stop: (): void => {} };
        const { send } = fakeTable((k, consistent) => {
            if(consistent) {
                stopper.stop();
                return undefined;
            }
            return k.SK === key(1).SK ? memoryItem(1) : memoryItem(2, 'new');
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(index.getHash(key(2).PK, key(2).SK)).toBe('old');
        expectAborted(logger);
    });

    it('does not requeue a stale row when the run is stopped during its strong read', async () => {
        openIndex();
        seed(1, 'old');
        const stopper = { stop: (): void => {} };
        const { send } = fakeTable((_k, consistent) => {
            if(consistent) {
                stopper.stop();
            }
            return memoryItem(1, 'new');
        });
        const enqueue = jest.fn();
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: { enqueue, drain: async () => {} } });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(enqueue).not.toHaveBeenCalled();
        expectAborted(logger);
    });

    it('skips post-drain verification when the run is stopped during the drain', async () => {
        openIndex();
        seed(1, 'old');
        const stopper = { stop: (): void => {} };
        const { send, reads } = fakeTable(() => memoryItem(1, 'new'));
        const drain = async (): Promise<void> => {
            stopper.stop();
        };
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: { enqueue: jest.fn(), drain } });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(reads).toHaveLength(2);
        expectAborted(logger);
    });

    it('keeps a converged requeue that vanishes when the run is stopped during verification', async () => {
        openIndex();
        seed(1, 'old');
        const stopper = { stop: (): void => {} };
        const { send } = fakeTable((_k, _consistent, call) => {
            if(call === 3) {
                stopper.stop();
                return undefined;
            }
            return memoryItem(1, 'new');
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(index.getHash(key(1).PK, key(1).SK)).toBe(await identityHash(1, 'new'));
        expectAborted(logger);
    });

    it('does not checkpoint a page when the run is stopped during its final verification read', async () => {
        openIndex();
        seed(1, 'old');
        const stopper = { stop: (): void => {} };
        const { send } = fakeTable((_k, _consistent, call) => {
            if(call === 3) {
                stopper.stop();
            }
            return memoryItem(1, 'new');
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: NOW + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: null, lastCompletedRowid: 0 });
        expectAborted(logger);
    });

    it('does not mark an empty index complete when the run is stopped before its first page', async () => {
        openIndex();
        const stopper = { stop: (): void => {} };
        const enroll = index.enrollCrossCheck.bind(index);
        jest.spyOn(index, 'enrollCrossCheck').mockImplementation((...args) => {
            stopper.stop();
            return enroll(...args);
        });
        const { scheduler, logger } = makeScheduler({});
        stopper.stop = () => {
            void scheduler.stop();
        };
        await scheduler.runOnce();
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: NOW + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: null, lastCompletedRowid: 0 });
        expect(summaryOf(logger)).toMatchObject({ completed: false });
        expectAborted(logger);
    });

    it('reads a page in rowid-ordered batches of four without backoff after complete responses', async () => {
        openIndex();
        const hashes = await Promise.all([1, 2, 3, 4, 5].map(async n => identityHash(n)));
        for(const [i, hash] of hashes.entries()) {
            seed(i + 1, hash);
        }
        const sleeps: number[] = [];
        const { send, reads } = fakeTable(k => memoryItem(numberOf(k.SK)), () => 0);
        const { scheduler, logger } = makeScheduler({ docClient: { send }, sleep: recordingSleep(sleeps) });
        await scheduler.runOnce();
        expect(reads).toEqual([{ consistent: false, keys: sks(1, 2, 3, 4) }, { consistent: false, keys: sks(5) }]);
        expect(sleeps).toEqual([]);
        expect(summaryOf(logger)).toMatchObject({ msg: 'Vector cross-check summary', checked: 5, completed: true });
    });

    it('caps unprocessed-key backoff at thirty seconds', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const sleeps: number[] = [];
        const send = jest.fn(async () => ({ UnprocessedKeys: { test: { Keys: [key(1)] } }, ConsumedCapacity: [{ CapacityUnits: 0 }] }));
        const { scheduler, logger } = makeScheduler({ docClient: { send }, sleep: recordingSleep(sleeps) });
        await scheduler.runOnce();
        expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('Vector cross-check exhausted UnprocessedKeys retries'), msg: RUN_FAILED }]]);
    });

    it('keeps going past a page just under both the RCU and requeue budgets', async () => {
        openIndex();
        const fresh = await Promise.all([100, 101].map(async n => identityHash(n)));
        for(let n = 1; n <= 101; n++) {
            seed(n, n <= 99 ? 'old' : fresh[n - 100]);
        }
        const { send } = fakeTable(k => memoryItem(numberOf(k.SK)), call => (call === 1 ? 1999 : 0));
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        await scheduler.runOnce();
        expect(summaryOf(logger)).toMatchObject({ checked: 101, requeued: 99, rcu: 1999, completed: true });
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: NOW + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: NOW, lastCompletedRowid: 0 });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('stops after a hundred-row page that reaches the requeue budget and checkpoints its last row', async () => {
        openIndex();
        for(let n = 1; n <= 100; n++) {
            seed(n, 'old');
        }
        seed(101, await identityHash(101));
        const lastRowid = index.listRowSnapshotsAfter(0, 100)[99].rowid;
        const { send } = fakeTable(k => memoryItem(numberOf(k.SK)), () => 0);
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        await scheduler.runOnce();
        expect(summaryOf(logger)).toMatchObject({ checked: 100, requeued: 100, completed: false });
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: NOW + VECTOR_CROSS_CHECK_INTERVAL_MS, lastRunAt: NOW, lastCompletedRowid: lastRowid });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('counts a key whose directory does not round-trip as malformed', async () => {
        openIndex();
        index.upsert({ pk: 'DIR#', sk: key(1).SK, layer: createIndexLayer('identity'), contentHash: 'bad', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        seed(1, await identityHash(1));
        const { send, reads } = fakeTable(() => memoryItem(1));
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        await scheduler.runOnce();
        expect(reads).toEqual([{ consistent: false, keys: sks(1) }]);
        expect(summaryOf(logger)).toMatchObject({ checked: 1, malformed: 1, completed: true });
    });

    it('skips a page of only malformed keys without reading DynamoDB', async () => {
        openIndex();
        index.upsert({ pk: 'INVALID', sk: 'FILE#bad.md', layer: createIndexLayer('identity'), contentHash: 'bad', vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null });
        const { send } = fakeTable(() => undefined);
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        await scheduler.runOnce();
        expect(send).not.toHaveBeenCalled();
        expect(summaryOf(logger)).toMatchObject({ checked: 0, malformed: 1, completed: true, error: undefined });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('reads every phase in rowid order with the right consistency', async () => {
        openIndex();
        const hashes = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async n => identityHash(n)));
        for(const [i, hash] of hashes.entries()) {
            seed(i + 1, i === 4 || i === 5 ? 'old' : hash);
        }
        const ttl = 1_800_000_000;
        const { send, reads } = fakeTable((k) => {
            const n = numberOf(k.SK);
            if(n === 3 || n === 4) {
                return undefined;
            }
            return n === 7 ? { ...memoryItem(7), TTL: ttl } : memoryItem(n);
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        await scheduler.runOnce();
        expect(reads).toEqual([
            { consistent: false, keys: sks(1, 2, 3, 4) },
            { consistent: false, keys: sks(5, 6, 7) },
            { consistent: true, keys: sks(3, 4) },
            { consistent: true, keys: sks(5, 6, 7) },
            { consistent: true, keys: sks(5, 6, 7) },
        ]);
        expect(index.listRowSnapshotsAfter(0, 10).map(row => [row.sk, row.ttl, row.sourceUpdatedAt])).toStrictEqual([
            [key(1).SK, null, VERSION],
            [key(2).SK, null, VERSION],
            [key(5).SK, null, VERSION],
            [key(6).SK, null, VERSION],
            [key(7).SK, ttl, VERSION],
        ]);
        expect(summaryOf(logger)).toMatchObject({ checked: 7, deleted: 2, requeued: 2, malformed: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('requeues stale content whose DynamoDB version equals the indexed version', async () => {
        openIndex();
        seed(1, 'old', { sourceUpdatedAt: VERSION });
        const { send } = fakeTable(() => memoryItem(1, 'new'));
        const indexer = applyingIndexer();
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer });
        await scheduler.runOnce();
        expect(indexer.enqueue).toHaveBeenCalledTimes(1);
        expect(summaryOf(logger)).toMatchObject({ requeued: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('counts a stale row that turns malformed on strong confirmation', async () => {
        openIndex();
        seed(1, 'old');
        const { send, reads } = fakeTable((_k, consistent) => (consistent ? { ...memoryItem(1, 'new'), contentType: 'invalid' } : memoryItem(1, 'new')));
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        await scheduler.runOnce();
        expect(reads).toHaveLength(2);
        expect(summaryOf(logger)).toMatchObject({ checked: 1, malformed: 1, requeued: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('counts an item stored under another path as malformed', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const { send } = fakeTable(() => ({ ...memoryItem(1), path: '/identity/2.md' }));
        const { scheduler, logger } = makeScheduler({ docClient: { send } });
        await scheduler.runOnce();
        expect(summaryOf(logger)).toMatchObject({ checked: 1, malformed: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('leaves the source version alone when a stale read is already current on strong confirmation', async () => {
        openIndex();
        seed(1, await identityHash(1));
        const { send } = fakeTable((_k, consistent) => (consistent ? memoryItem(1) : memoryItem(1, 'new')));
        const enqueue = jest.fn();
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: { enqueue, drain: async () => {} } });
        await scheduler.runOnce();
        expect(rowOf(1)?.sourceUpdatedAt).toBe(1);
        expect(enqueue).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('fails the run when the indexer drain rejects', async () => {
        openIndex();
        seed(1, 'old');
        const { send } = fakeTable(() => memoryItem(1, 'new'));
        const indexer = withDrain(() => {
            throw new Error('drain failed');
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: new Error('drain failed'), msg: RUN_FAILED }]]);
    });

    it('skips a vanished requeue whose index row the drain already removed', async () => {
        openIndex();
        seed(1, 'old');
        const { send } = fakeTable((_k, _consistent, call) => (call <= 2 ? memoryItem(1, 'new') : undefined));
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: withDrain(removeRow1) });
        await scheduler.runOnce();
        expect(summaryOf(logger)).toMatchObject({ deleted: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not delete the next file in the directory when a vanished requeue lost its index row', async () => {
        openIndex();
        const hash2 = await identityHash(2);
        seed(1, 'old');
        seed(2, hash2);
        const { send } = fakeTable((k, _consistent, call) => {
            if(k.SK === key(2).SK) {
                return memoryItem(2);
            }
            return call <= 2 ? memoryItem(1, 'new') : undefined;
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: withDrain(removeRow1) });
        await scheduler.runOnce();
        expect(index.getHash(key(2).PK, key(2).SK)).toBe(hash2);
        expect(summaryOf(logger)).toMatchObject({ deleted: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not delete a same-named file in another directory when a vanished requeue lost its index row', async () => {
        openIndex();
        const other = { PK: 'DIR#/state', SK: key(1).SK };
        const otherHash = await sha256Hex('/state/1.md\nunchanged');
        seed(1, 'old');
        index.upsert({ pk: other.PK, sk: other.SK, layer: createIndexLayer('state'), contentHash: otherHash, vector: new Uint8Array(128) as never, updatedAt: 1, ttl: null, sourceUpdatedAt: 1 });
        const otherItem = { ...memoryItem(1), ...other, GSI1PK: 'LAYER#state', path: '/state/1.md' };
        const { send } = fakeTable((k, _consistent, call) => {
            if(k.PK === other.PK) {
                return otherItem;
            }
            return call <= 2 ? memoryItem(1, 'new') : undefined;
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: withDrain(removeRow1) });
        await scheduler.runOnce();
        expect(index.getHash(other.PK, other.SK)).toBe(otherHash);
        expect(summaryOf(logger)).toMatchObject({ deleted: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('deletes a vanished requeue that follows a kept row', async () => {
        openIndex();
        seed(1, await identityHash(1));
        seed(2, 'old');
        const { send } = fakeTable((k, _consistent, call) => {
            if(k.SK === key(1).SK) {
                return memoryItem(1);
            }
            return call <= 2 ? memoryItem(2, 'new') : undefined;
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: applyingIndexer() });
        await scheduler.runOnce();
        expect(index.getHash(key(2).PK, key(2).SK)).toBeUndefined();
        expect(summaryOf(logger)).toMatchObject({ deleted: 1, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('leaves a vanished requeue alone once it was recreated at a later rowid', async () => {
        openIndex();
        seed(1, 'old');
        seed(2, await identityHash(2));
        const recreated = await identityHash(1, 'new');
        const { send } = fakeTable((k, _consistent, call) => {
            if(k.SK === key(2).SK) {
                return memoryItem(2);
            }
            return call === 3 ? undefined : memoryItem(1, 'new');
        });
        const indexer = withDrain(() => {
            recreateRow1(recreated);
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer });
        await scheduler.runOnce();
        expect(index.getHash(key(1).PK, key(1).SK)).toBe(recreated);
        expect(summaryOf(logger)).toMatchObject({ deleted: 0, completed: true });
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('does not treat a requeue whose index row the drain removed as converged', async () => {
        openIndex();
        seed(1, 'old');
        const { send } = fakeTable(() => memoryItem(1, 'new'));
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer: withDrain(removeRow1) });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: NOT_CONVERGED, msg: RUN_FAILED }]]);
    });

    it('does not treat a requeue with the wrong indexed TTL as converged', async () => {
        openIndex();
        seed(1, 'old');
        const recreated = await identityHash(1, 'new');
        const { send } = fakeTable(() => ({ ...memoryItem(1, 'new'), TTL: 1_800_000_000 }));
        const indexer = withDrain(() => {
            seed(1, recreated, { sourceUpdatedAt: VERSION });
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: NOT_CONVERGED, msg: RUN_FAILED }]]);
    });

    it('does not treat a requeue recreated at a later rowid as converged', async () => {
        openIndex();
        seed(1, 'old');
        seed(2, await identityHash(2));
        const recreated = await identityHash(1, 'new');
        const { send } = fakeTable(k => (k.SK === key(2).SK ? memoryItem(2) : memoryItem(1, 'new')));
        const indexer = withDrain(() => {
            recreateRow1(recreated);
        });
        const { scheduler, logger } = makeScheduler({ docClient: { send }, indexer });
        await scheduler.runOnce();
        expect(logger.error.mock.calls).toEqual([[{ error: NOT_CONVERGED, msg: RUN_FAILED }]]);
    });
});
