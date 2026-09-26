import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { createIndexLayer } from '@/storage/memory-tool/types';
import { VectorIndex } from '@/storage/memory-vec-store/backend';
import { createVectorCrossCheckScheduler, VECTOR_CROSS_CHECK_INTERVAL_MS } from '@/storage/memory-vec-store/cross-check';
import { sha256Hex } from '@/storage/memory-vec-store/hash';

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

describe('weekly vector cross-check', () => {
    let db: Database;
    let index: VectorIndex;
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        index.close();
    });

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
        const scheduler = createVectorCrossCheckScheduler({ vectorIndex: index, docClient: { getDocClient }, tableName: 'test', indexer: { enqueue: jest.fn(), drain: async () => {} }, logger: { info: jest.fn(), error: jest.fn() }, sleep: async () => {} });
        await scheduler.runOnce();
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
        expect(logger.error.mock.calls[0]?.[0].error).toBeInstanceOf(Error);
        expect(index.getCrossCheckState()).toStrictEqual({ nextDueAt: 3_610_000, lastRunAt: null, lastCompletedRowid: 0 });
        expect(index.getHash(key(1).PK, key(1).SK)).toBe('x');
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
        await Promise.resolve();
        await Promise.resolve();
        expect(logger.error).toHaveBeenCalled();
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
});
