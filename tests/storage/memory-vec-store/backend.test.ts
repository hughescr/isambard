/**
 * Tests for backend.ts — VectorIndex CRUD + KNN query + layer filter + close behavior + error paths
 * Uses bun:sqlite in-memory with sqlite-vec extension.
 *
 * Note: tests/setup.ts (Bun preload) calls Database.setCustomSQLite() before any test runs,
 * ensuring sqlite-vec extension loading works on macOS.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { logger } from '@hughescr/logger';
import { VectorIndexClosedError, VectorIndexError } from '@/errors';
import { createLayerName, createMemoryPath, createIndexLayer, createSearchableNamespace } from '@/storage/memory-tool/types';
import { DELETE_TOMBSTONE_TTL_MS, PRUNE_EXPIRED_BATCH_SIZE, PRUNE_TOMBSTONE_BATCH_SIZE, VectorIndex } from '@/storage/memory-vec-store/backend';
import type { PackedBinaryEmbedding1024, VectorIndexEntry } from '@/storage/memory-vec-store/types';
import { createEpochSeconds } from '@/storage/repositories/types';

type IsExactly<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _VectorIndexEntryUsesPackedEmbedding = Assert<IsExactly<VectorIndexEntry['vector'], PackedBinaryEmbedding1024>>;

/** Create a deterministic 128-byte test vector with all bits set to given pattern byte */
function makeVector(byte: number): PackedBinaryEmbedding1024 {
    return new Uint8Array(128).fill(byte) as PackedBinaryEmbedding1024;
}

describe('VectorIndex', () => {
    let db: Database;
    let index: VectorIndex;

    beforeEach(() => {
        db = new Database(':memory:');
        // openWithDb loads the sqlite-vec extension and runs schema migration
        index = VectorIndex.openWithDb(db);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if(!index.isClosed) {
            index.close();
        }
    });

    describe('cross-check closed-index safety', () => {
        it('rejects every cross-check read and write after close with VectorIndexClosedError', () => {
            index.close();
            expect(() => index.listRowSnapshotsAfter(0, 1)).toThrow(VectorIndexClosedError);
            expect(() => index.getCrossCheckState()).toThrow(VectorIndexClosedError);
            expect(() => index.enrollCrossCheck(10, 100)).toThrow(VectorIndexClosedError);
            expect(() => index.saveCrossCheckState({ nextDueAt: 10, lastRunAt: null, lastCompletedRowid: 0 })).toThrow(VectorIndexClosedError);
        });
    });

    describe('schema verification', () => {
        it('creates both memory_vectors table and vec_memory virtual table', () => {
            const rows = db.query<{ name: string }, []>(
                `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('memory_vectors','vec_memory') ORDER BY name`
            ).all();
            const names = rows.map(r => r.name).toSorted((a, b) => a.localeCompare(b));
            expect(names).toEqual(['memory_vectors', 'vec_memory']);
        });
    });

    describe('embedding byte-length validation', () => {
        it('upsert throws VectorIndexError for a vector shorter than 128 bytes', () => {
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h', vector: new Uint8Array(64) as PackedBinaryEmbedding1024, updatedAt: 1, ttl: null })).toThrow(VectorIndexError);
        });

        it('upsert throws VectorIndexError for a vector longer than 128 bytes', () => {
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h', vector: new Uint8Array(256) as PackedBinaryEmbedding1024, updatedAt: 1, ttl: null })).toThrow(VectorIndexError);
        });

        it('upsert succeeds for exactly 128 bytes', () => {
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h', vector: makeVector(0xAA), updatedAt: 1, ttl: null })).not.toThrow();
        });

        it('upsert error message includes the actual length', () => {
            let thrown: unknown;
            try {
                index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h', vector: new Uint8Array(64) as PackedBinaryEmbedding1024, updatedAt: 1, ttl: null });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeInstanceOf(VectorIndexError);
            expect((thrown as VectorIndexError).message).toContain('64');
        });

        it('query throws VectorIndexError for a query vector shorter than 128 bytes', () => {
            expect(() => index.query(new Uint8Array(64) as PackedBinaryEmbedding1024, 5)).toThrow(VectorIndexError);
        });

        it('query throws VectorIndexError for a query vector longer than 128 bytes', () => {
            expect(() => index.query(new Uint8Array(256) as PackedBinaryEmbedding1024, 5)).toThrow(VectorIndexError);
        });

        it('query succeeds for exactly 128 bytes', () => {
            expect(() => index.query(makeVector(0xFF), 5)).not.toThrow();
        });

        it('query error message includes the actual length', () => {
            let thrown: unknown;
            try {
                index.query(new Uint8Array(256) as PackedBinaryEmbedding1024, 5);
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeInstanceOf(VectorIndexError);
            expect((thrown as VectorIndexError).message).toContain('256');
        });
    });

    describe('upsert + getHash', () => {
        it('returns undefined for unknown (pk, sk)', () => {
            expect(index.getHash('pk1', 'sk1')).toBeUndefined();
        });

        it('stores a hash after upsert', () => {
            index.upsert({
                pk:          'pk1',
                sk:          'sk1',
                layer:       createIndexLayer('identity'),
                contentHash: 'abc123',
                vector:      makeVector(0xFF),
                updatedAt:   1000,
                ttl:         null,
            });
            expect(index.getHash('pk1', 'sk1')).toBe('abc123');
        });

        it('updates hash when same (pk, sk) is upserted again', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'old', vector: makeVector(0xAA), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'new', vector: makeVector(0xBB), updatedAt: 2000, ttl: null });
            expect(index.getHash('pk1', 'sk1')).toBe('new');
        });

        it('stores entries with different (pk, sk) pairs independently', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'hash1', vector: makeVector(0x11), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'pk2', sk: 'sk2', layer: createIndexLayer('state'),    contentHash: 'hash2', vector: makeVector(0x22), updatedAt: 2000, ttl: null });
            expect(index.getHash('pk1', 'sk1')).toBe('hash1');
            expect(index.getHash('pk2', 'sk2')).toBe('hash2');
        });
    });

    describe('delete', () => {
        it('removes the entry so getHash returns undefined', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000, ttl: null });
            index.delete('pk1', 'sk1');
            expect(index.getHash('pk1', 'sk1')).toBeUndefined();
        });

        it('is a no-op for non-existent (pk, sk)', () => {
            expect(() => index.delete('nonexistent', 'nonexistent')).not.toThrow();
        });

        it('removed entry no longer appears in query results', () => {
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#one', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#two', layer: createIndexLayer('identity'), contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000, ttl: null });
            index.delete('DIR#/identity', 'FILE#one');
            expect(index.query(makeVector(0xFF), 10)).toEqual([
                { path: createMemoryPath('/identity/two'), layer: createIndexLayer('identity'), distance: 0 },
            ]);
        });

        it('removes the row from vec_memory too (re-query returns empty)', () => {
            index.upsert({ pk: 'only', sk: 'sk', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000, ttl: null });
            index.delete('only', 'sk');
            const results = index.query(makeVector(0xFF), 10);
            expect(results).toHaveLength(0);
        });

        it('removes the vec_memory row by the correct rowid (verifies DELETE binding)', () => {
            // Insert two entries so the rowids are distinct — deleting pk1 must only remove
            // its specific vec_memory row, not both (verifies [rowIdRow.rowid] is bound correctly).
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'pk2', sk: 'sk2', layer: createIndexLayer('identity'), contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000, ttl: null });
            index.delete('pk1', 'sk1');
            // Directly verify vec_memory row count — should be 1 (pk2 still present)
            const vecCount = db.query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM vec_memory').get();
            expect(vecCount!.cnt).toBe(1);
        });
    });

    describe('query (KNN using sqlite-vec Hamming distance)', () => {
        it('returns empty array when no entries exist', () => {
            const results = index.query(makeVector(0xFF), 5);
            expect(results).toHaveLength(0);
        });

        it('returns results sorted by distance ascending — known bit patterns', () => {
            // 0xFF vector: all 1024 bits set → Hamming distance to query 0xFF = 0
            // 0x00 vector: all bits cleared → Hamming distance to query 0xFF = 1024
            // 0xAA vector: alternating bits (half set) → distance = 512
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#farthest', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0x00), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#nearest', layer: createIndexLayer('identity'), contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000, ttl: null });
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#midpoint', layer: createIndexLayer('identity'), contentHash: 'h3', vector: makeVector(0xAA), updatedAt: 3000, ttl: null });

            const results = index.query(makeVector(0xFF), 10);
            expect(results).toHaveLength(3);
            // First result must be nearest (distance 0)
            expect(results[0].path).toBe(createMemoryPath('/identity/nearest'));
            expect(results[0].distance).toBe(0);
            // Middle result is midpoint (distance 512)
            expect(results[1].path).toBe(createMemoryPath('/identity/midpoint'));
            expect(results[1].distance).toBe(512);
            // Last result is farthest (distance 1024)
            expect(results[2].path).toBe(createMemoryPath('/identity/farthest'));
            expect(results[2].distance).toBe(1024);
        });

        it('skips malformed legacy keys and root vectors, deriving valid result layers from paths', () => {
            const warn = spyOn(logger, 'warn').mockClear();
            index.upsert({ pk: 'bad', sk: 'FILE#bad', layer: createIndexLayer('unknown'), contentHash: 'a', vector: makeVector(0xFF), updatedAt: 1, ttl: null });
            index.upsert({ pk: 'DIR#/', sk: 'FILE#', layer: createIndexLayer('unknown'), contentHash: 'b', vector: makeVector(0xFF), updatedAt: 2, ttl: null });
            index.upsert({ pk: 'DIR#/users/alice', sk: 'FILE#name', layer: createIndexLayer('unknown'), contentHash: 'c', vector: makeVector(0xFF), updatedAt: 3, ttl: null });
            expect(index.query(makeVector(0xFF), 3)).toEqual([{ path: createMemoryPath('/users/alice/name'), layer: createIndexLayer('users'), distance: 0 }]);
            expect(warn.mock.calls.filter(call => (call[0] as Record<string, unknown> | undefined)?.msg === 'Skipping malformed legacy vector-index row')).toHaveLength(2);
        });

        it('returns at most limit results', () => {
            for(let i = 0; i < 10; i++) {
                index.upsert({ pk: 'DIR#/identity', sk: `FILE#item${i}`, layer: createIndexLayer('identity'), contentHash: `h${i}`, vector: makeVector(i), updatedAt: i, ttl: null });
            }
            const results = index.query(makeVector(0xFF), 3);
            expect(results).toHaveLength(3);
        });

        it('returns the memory path and layer from physical keys', () => {
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#core', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000, ttl: null });
            expect(index.query(makeVector(0xFF), 10)).toEqual([
                { path: createMemoryPath('/identity/core'), layer: createIndexLayer('identity'), distance: 0 },
            ]);
        });

        it('layer filter returns only matching layer', () => {
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#item', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'DIR#/state',    sk: 'FILE#item', layer: createIndexLayer('state'),    contentHash: 'h2', vector: makeVector(0xAA), updatedAt: 2000, ttl: null });
            const results = index.query(makeVector(0xAA), 10, createLayerName('identity'));
            expect(results).toHaveLength(1);
            expect(results[0]).toEqual({ path: createMemoryPath('/identity/item'), layer: createIndexLayer('identity'), distance: 0 });
        });

        it('users filter returns only /users rows; a legacy unknown-labelled row waits for the forced rebuild', () => {
            index.upsert({ pk: 'DIR#/users/alice', sk: 'FILE#name', layer: createSearchableNamespace('users'), contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'DIR#/users/bob', sk: 'FILE#name', layer: createIndexLayer('unknown'), contentHash: 'h2', vector: makeVector(0xAA), updatedAt: 2000, ttl: null });
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#item', layer: createLayerName('identity'), contentHash: 'h3', vector: makeVector(0xAA), updatedAt: 3000, ttl: null });
            expect(index.query(makeVector(0xAA), 10, createSearchableNamespace('users'))).toEqual([
                { path: createMemoryPath('/users/alice/name'), layer: createIndexLayer('users'), distance: 0 },
            ]);
        });

        it('returns all layers when no layer filter specified', () => {
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#item', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000, ttl: null });
            index.upsert({ pk: 'DIR#/state',    sk: 'FILE#item', layer: createIndexLayer('state'),    contentHash: 'h2', vector: makeVector(0xAA), updatedAt: 2000, ttl: null });
            const results = index.query(makeVector(0xAA), 10);
            expect(results).toEqual(expect.arrayContaining([
                { path: createMemoryPath('/identity/item'), layer: createIndexLayer('identity'), distance: 0 },
                { path: createMemoryPath('/state/item'), layer: createIndexLayer('state'), distance: 0 },
            ]));
        });

        it('returns distance of 0 for identical vector', () => {
            const vec = makeVector(0xAB);
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#same', layer: createIndexLayer('identity'), contentHash: 'h1', vector: vec, updatedAt: 1000, ttl: null });
            const results = index.query(vec, 10);
            expect(results[0].distance).toBe(0);
        });

        it('returns distance 1024 for fully inverted vector (all bits differ)', () => {
            index.upsert({ pk: 'DIR#/identity', sk: 'FILE#inverted', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0x00), updatedAt: 1000, ttl: null });
            const results = index.query(makeVector(0xFF), 10);
            expect(results[0].distance).toBe(1024);
        });
    });

    describe('close()', () => {
        it('sets isClosed to true', () => {
            index.close();
            expect(index.isClosed).toBe(true);
            expect(() => db.query('SELECT 1').get()).toThrow();
        });

        it('subsequent close() does not throw', () => {
            index.close();
            expect(() => index.close()).not.toThrow();
        });

        it('getHash throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.getHash('pk1', 'sk1')).toThrow(VectorIndexClosedError);
        });

        it('upsert throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: createIndexLayer('identity'), contentHash: 'h1', vector: makeVector(0), updatedAt: 1, ttl: null })).toThrow(VectorIndexClosedError);
        });

        it('delete throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.delete('pk1', 'sk1')).toThrow(VectorIndexClosedError);
        });

        it('deleteAndTombstone throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.deleteAndTombstone('pk1', 'sk1', 1)).toThrow(VectorIndexClosedError);
        });

        it('pruneExpiredTombstones throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.pruneExpiredTombstones()).toThrow(VectorIndexClosedError);
        });

        it('query throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.query(makeVector(0), 5)).toThrow(VectorIndexClosedError);
        });

        it('second close() is a no-op — getHash still throws (db is closed)', () => {
            index.close();
            index.close(); // idempotent second call
            expect(() => index.getHash('pk1', 'sk1')).toThrow(VectorIndexClosedError);
        });
    });

    describe('VectorIndex.open()', () => {
        it('uses the default KNN ceiling on the open path without an override', async () => {
            const openedDb = new Database(':memory:');
            const originalQuery = openedDb.query.bind(openedDb);
            const requestedK: unknown[] = [];
            spyOn(openedDb, 'query').mockImplementation(((sql: string) => {
                const statement = originalQuery(sql);
                if(sql.includes('MATCH vec_bit(?)')) {
                    const originalAll = statement.all.bind(statement) as (...args: unknown[]) => ReturnType<typeof statement.all>;
                    spyOn(statement, 'all').mockImplementation((...args: unknown[]) => {
                        requestedK.push(args[1]);
                        return originalAll(...args);
                    });
                }
                return statement;
            }) as typeof openedDb.query);
            const opened = await VectorIndex.open(':memory:', { createDatabase: () => openedDb });
            try {
                opened.upsert({ pk: 'DIR#/identity', sk: 'FILE#found', layer: createIndexLayer('identity'), contentHash: 'h', vector: makeVector(0), updatedAt: 1, ttl: null });
                expect(opened.query(makeVector(0), 1)).toEqual([
                    { path: createMemoryPath('/identity/found'), layer: createIndexLayer('identity'), distance: 0 },
                ]);
                expect(requestedK).toEqual([1]);
            } finally {
                opened.close();
            }
        });

        // This test's genuine purpose is to exercise the real file-backed open path:
        // a real bun:sqlite Database on disk, real sqlite-vec native extension loading
        // (configureCustomSQLite + sqliteVec.load), a real schema migration, and real
        // file cleanup — unlike every other test in this file, which uses
        // VectorIndex.openWithDb(new Database(':memory:')) and stays well under 1ms.
        // That is genuine native-binding/file I/O, not fakeable without testing
        // something else, so per CLAUDE.md's documented last-resort exception this
        // gets an explicit per-test timeout override instead of a sub-1ms budget.
        // Observed CI durations vary by runner load (local: ~4ms; CI: up to ~1020ms),
        // so the override is generous rather than tuned to a specific runner.
        it('opens a database at the given path and returns a VectorIndex', async () => {
            const tmpPath = `${process.env.TMPDIR ?? '/tmp'}/vec-test-${Date.now()}.sqlite`;
            const vi = await VectorIndex.open(tmpPath);
            try {
                expect(vi.isClosed).toBe(false);
                // Verify both tables exist via the public API (upsert + query)
                vi.upsert({ pk: 'DIR#/identity', sk: 'FILE#reopened', layer: createIndexLayer('identity'), contentHash: 'h', vector: makeVector(0xAA), updatedAt: 1, ttl: null });
                expect(vi.getHash('DIR#/identity', 'FILE#reopened')).toBe('h');
                vi.close();
                const reopened = await VectorIndex.open(tmpPath);
                expect(reopened.query(makeVector(0xAA), 5)).toEqual([
                    { path: createMemoryPath('/identity/reopened'), layer: createIndexLayer('identity'), distance: 0 },
                ]);
                reopened.close();
            } finally {
                vi.close();
                await Bun.file(tmpPath).delete().catch(() => undefined);
                // Also clean up WAL/SHM files
                await Bun.file(`${tmpPath}-wal`).delete().catch(() => undefined);
                await Bun.file(`${tmpPath}-shm`).delete().catch(() => undefined);
            }
        }, 5000);
    });
});

// ── #129: TTL rows, local expiry, generation-guarded deletes, prefix listing ──────────────

/** Fixed clock: 1_000_000 s since the epoch, plus half a second so floor() matters. */
const NOW_MS = 1_000_000_500;
const NOW_S = 1_000_000;

function entry(sk: string, ttl: number | null, overrides: Partial<VectorIndexEntry> = {}): VectorIndexEntry {
    return {
        pk:          'DIR#/events/activity/chat',
        sk:          `FILE#${sk}`,
        layer:       createIndexLayer('events'),
        contentHash: `hash-${sk}`,
        vector:      makeVector(0xFF),
        updatedAt:   1000,
        ttl:         ttl === null ? null : createEpochSeconds(ttl),
        ...overrides,
    };
}

describe('VectorIndex TTL and prune (#129)', () => {
    let db: Database;
    let index: VectorIndex;
    let clockMs: number;

    function rowCounts() {
        return {
            meta: db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM memory_vectors').get()!.n,
            vec:  db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM vec_memory').get()!.n,
        };
    }

    function storedTtls() {
        return db.query<{ sk: string, ttl: number | null }, []>('SELECT sk, ttl FROM memory_vectors ORDER BY rowid').all();
    }

    beforeEach(() => {
        clockMs = NOW_MS;
        db = new Database(':memory:');
        index = VectorIndex.openWithDb(db, { now: () => clockMs });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        index.close();
    });

    describe('upsert', () => {
        it('stores the ttl, and a conflicting upsert replaces it, including back to null', () => {
            index.upsert(entry('a', NOW_S + 60));
            expect(storedTtls()).toEqual([{ sk: 'FILE#a', ttl: NOW_S + 60 }]);
            index.upsert(entry('a', NOW_S + 120));
            expect(storedTtls()).toEqual([{ sk: 'FILE#a', ttl: NOW_S + 120 }]);
            index.upsert(entry('a', null));
            expect(storedTtls()).toEqual([{ sk: 'FILE#a', ttl: null }]);
        });
    });

    describe('query excludes expired rows', () => {
        it.each([
            ['unfiltered', undefined],
            ['layer-filtered', createLayerName('events')],
        ] as const)('%s: ttl == now is hidden, ttl == now+1 and NULL are returned', (_label, layer) => {
            index.upsert(entry('expired-now', NOW_S));
            index.upsert(entry('expires-next-second', NOW_S + 1));
            index.upsert(entry('never', null));
            const paths = index.query(makeVector(0xFF), 10, layer).map(result => result.path as string).toSorted((a, b) => a.localeCompare(b));
            expect(paths).toEqual([
                createMemoryPath('/events/activity/chat/expires-next-second'),
                createMemoryPath('/events/activity/chat/never'),
            ]);
        });

        it('uses whole seconds of the injected clock (floor, not ceil)', () => {
            index.upsert(entry('boundary', NOW_S + 1));
            // 1_000_000.5 s floors to 1_000_000, so ttl 1_000_001 is still live
            expect(index.query(makeVector(0xFF), 10)).toHaveLength(1);
            clockMs = (NOW_S + 1) * 1000;
            expect(index.query(makeVector(0xFF), 10)).toEqual([]);
        });
    });

    describe('query overfetch', () => {
        function ranked(sk: string, bits: number, ttl: number | null, overrides: Partial<VectorIndexEntry> = {}): void {
            const vector = makeVector(0);
            vector[0] = bits;
            index.upsert(entry(sk, ttl, { vector, ...overrides }));
        }

        it('does not count or retry when the first KNN pass fills the limit', () => {
            ranked('near', 0, null);
            ranked('far', 1, null);
            const queries = spyOn(db, 'query');
            expect(index.query(makeVector(0), 1)).toEqual([
                { path: createMemoryPath('/events/activity/chat/near'), layer: createIndexLayer('events'), distance: 0 },
            ]);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('MATCH vec_bit(?)'))).toHaveLength(1);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('COUNT(*) AS n FROM vec_memory'))).toHaveLength(0);
        });

        it('finds two live neighbours beyond the expired nearest two in distance order', () => {
            ranked('expired-0', 0, NOW_S);
            ranked('expired-1', 1, NOW_S - 1);
            ranked('live-2', 3, NOW_S + 1);
            ranked('live-3', 7, null);
            ranked('live-4', 15, null);
            const queries = spyOn(db, 'query');
            expect(index.query(makeVector(0), 2)).toEqual([
                { path: createMemoryPath('/events/activity/chat/live-2'), layer: createIndexLayer('events'), distance: 2 },
                { path: createMemoryPath('/events/activity/chat/live-3'), layer: createIndexLayer('events'), distance: 3 },
            ]);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('MATCH vec_bit(?)'))).toHaveLength(2);
        });

        it('finds matching-layer neighbours beyond the wrong-layer nearest two', () => {
            ranked('wrong-0', 0, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            ranked('wrong-1', 1, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            ranked('right-2', 3, null);
            ranked('right-3', 7, null);
            expect(index.query(makeVector(0), 2, createLayerName('events'))).toEqual([
                { path: createMemoryPath('/events/activity/chat/right-2'), layer: createIndexLayer('events'), distance: 2 },
                { path: createMemoryPath('/events/activity/chat/right-3'), layer: createIndexLayer('events'), distance: 3 },
            ]);
        });

        it('grows twice past mixed TTL and layer rejections before returning exactly two results', () => {
            ranked('expired-0', 0, NOW_S);
            ranked('wrong-1', 1, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            ranked('expired-2', 3, NOW_S - 1);
            ranked('wrong-3', 7, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            ranked('right-4', 15, null);
            ranked('right-5', 31, NOW_S + 1);
            ranked('right-6', 63, null);
            const queries = spyOn(db, 'query');
            expect(index.query(makeVector(0), 2, createLayerName('events'))).toEqual([
                { path: createMemoryPath('/events/activity/chat/right-4'), layer: createIndexLayer('events'), distance: 4 },
                { path: createMemoryPath('/events/activity/chat/right-5'), layer: createIndexLayer('events'), distance: 5 },
            ]);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('MATCH vec_bit(?)'))).toHaveLength(3);
        });

        it('terminates when every indexed candidate is filtered out', () => {
            ranked('expired', 0, NOW_S);
            ranked('wrong', 1, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            const queries = spyOn(db, 'query');
            expect(index.query(makeVector(0), 1, createLayerName('events'))).toEqual([]);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('MATCH vec_bit(?)'))).toHaveLength(2);
            expect(queries.mock.calls.filter(call => String(call[0]).includes('vec_distance_hamming'))).toHaveLength(0);
        });

        it('returns fewer than the requested limit when all indexed candidates have been examined', () => {
            ranked('expired', 0, NOW_S);
            ranked('live', 1, null);
            ranked('wrong', 3, null, { pk: 'DIR#/state', layer: createIndexLayer('state') });
            expect(index.query(makeVector(0), 2, createLayerName('events'))).toEqual([
                { path: createMemoryPath('/events/activity/chat/live'), layer: createIndexLayer('events'), distance: 1 },
            ]);
        });

        it('uses an exact scan beyond the vec0 KNN ceiling to find a live matching-layer row', () => {
            const smallDb = new Database(':memory:');
            const small = VectorIndex.openWithDb(smallDb, { now: () => NOW_MS, knnMaxK: 2 });
            try {
                const vector = (bits: number): PackedBinaryEmbedding1024 => {
                    const v = makeVector(0);
                    v[0] = bits;
                    return v;
                };
                small.upsert(entry('expired', NOW_S, { vector: vector(0) }));
                small.upsert(entry('wrong', null, { pk: 'DIR#/state', layer: createIndexLayer('state'), vector: vector(1) }));
                small.upsert(entry('live', null, { vector: vector(3) }));
                expect(small.query(makeVector(0), 1, createLayerName('events'))).toEqual([
                    { path: createMemoryPath('/events/activity/chat/live'), layer: createIndexLayer('events'), distance: 2 },
                ]);
            } finally {
                small.close();
            }
        });

        it('caps initial KNN k when the requested limit exceeds the ceiling', () => {
            const smallDb = new Database(':memory:');
            const small = VectorIndex.openWithDb(smallDb, { now: () => NOW_MS, knnMaxK: 2 });
            try {
                small.upsert(entry('first', null));
                small.upsert(entry('second', null));
                small.upsert(entry('third', null));
                const queries = spyOn(smallDb, 'query');
                expect(small.query(makeVector(0xFF), 3)).toHaveLength(3);
                expect(queries.mock.calls.filter(call => String(call[0]).includes('MATCH vec_bit(?)'))).toHaveLength(1);
                expect(queries.mock.calls.filter(call => String(call[0]).includes('vec_distance_hamming'))).toHaveLength(1);
            } finally {
                small.close();
            }
        });

        it('the ceiling scan excludes malformed paths and returns fewer than requested', () => {
            const smallDb = new Database(':memory:');
            const small = VectorIndex.openWithDb(smallDb, { now: () => NOW_MS, knnMaxK: 2 });
            const warn = spyOn(logger, 'warn').mockClear();
            try {
                const vector = makeVector(0);
                small.upsert(entry('bad', null, { pk: 'bad', vector }));
                const live = makeVector(0);
                live[0] = 1;
                small.upsert(entry('live', null, { vector: live }));
                const expired = makeVector(0);
                expired[0] = 3;
                small.upsert(entry('expired', NOW_S, { vector: expired }));
                expect(small.query(makeVector(0), 2)).toEqual([
                    { path: createMemoryPath('/events/activity/chat/live'), layer: createIndexLayer('events'), distance: 1 },
                ]);
                expect(warn.mock.calls.filter(call => (call[0] as Record<string, unknown> | undefined)?.msg === 'Skipping malformed legacy vector-index row')).toHaveLength(1);
            } finally {
                small.close();
            }
        });

        describe('default sqlite-vec KNN ceiling', () => {
            /** Records the k bound to each vec0 KNN statement the index runs. */
            function recordKnnK(): number[] {
                const ks: number[] = [];
                const realQuery = db.query.bind(db);
                spyOn(db, 'query').mockImplementation(((sql: string) => {
                    const statement = realQuery(sql);
                    if(!sql.includes('MATCH vec_bit(?)')) {
                        return statement;
                    }
                    return {
                        all: (...params: unknown[]) => {
                            ks.push(params[1] as number);
                            return statement.all(...(params as never[]));
                        },
                    };
                }) as unknown as typeof db.query);
                return ks;
            }

            it('asks sqlite-vec for exactly 4096 neighbours when the limit is at the ceiling', () => {
                index.upsert(entry('only', null));
                const ks = recordKnnK();
                expect(index.query(makeVector(0xFF), 4096)).toEqual([
                    { path: createMemoryPath('/events/activity/chat/only'), layer: createIndexLayer('events'), distance: 0 },
                ]);
                expect(ks).toEqual([4096]);
            });

            it('caps a limit one above the ceiling at the 4096 neighbours sqlite-vec accepts', () => {
                index.upsert(entry('only', null));
                const ks = recordKnnK();
                expect(index.query(makeVector(0xFF), 4097)).toEqual([
                    { path: createMemoryPath('/events/activity/chat/only'), layer: createIndexLayer('events'), distance: 0 },
                ]);
                expect(ks).toEqual([4096]);
            });
        });

        it('skips a malformed nearest path during expansion and warns only once', () => {
            const warn = spyOn(logger, 'warn').mockClear();
            ranked('bad', 0, null, { pk: 'bad' });
            ranked('live', 1, null);
            ranked('far', 3, null);
            expect(index.query(makeVector(0), 2)).toEqual([
                { path: createMemoryPath('/events/activity/chat/live'), layer: createIndexLayer('events'), distance: 1 },
                { path: createMemoryPath('/events/activity/chat/far'), layer: createIndexLayer('events'), distance: 2 },
            ]);
            expect(warn.mock.calls.filter(call => (call[0] as Record<string, unknown> | undefined)?.msg === 'Skipping malformed legacy vector-index row')).toHaveLength(1);
        });
    });

    describe('pruneExpired', () => {
        it('deletes only rows with ttl <= now from BOTH tables and returns the metadata count', () => {
            index.upsert(entry('past', NOW_S - 100));
            index.upsert(entry('now', NOW_S));
            index.upsert(entry('future', NOW_S + 1));
            index.upsert(entry('never', null));
            expect(rowCounts()).toEqual({ meta: 4, vec: 4 });

            expect(index.pruneExpired()).toBe(2);

            expect(rowCounts()).toEqual({ meta: 2, vec: 2 });
            expect(storedTtls()).toEqual([{ sk: 'FILE#future', ttl: NOW_S + 1 }, { sk: 'FILE#never', ttl: null }]);
            // The surviving vectors are the right ones: both still answer a query
            expect(index.query(makeVector(0xFF), 10)).toHaveLength(2);
        });

        it('floors the clock to whole seconds', () => {
            index.upsert(entry('next-second', NOW_S + 1));
            expect(index.pruneExpired()).toBe(0);
            clockMs = (NOW_S + 1) * 1000;
            expect(index.pruneExpired()).toBe(1);
        });

        it('loops over bounded batches until a batch comes back short', () => {
            for(const sk of ['e1', 'e2', 'e3', 'e4', 'e5']) {
                index.upsert(entry(sk, NOW_S - 1));
            }
            index.upsert(entry('live', NOW_S + 5));
            expect(index.pruneExpired(2)).toBe(5);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
        });

        it('stops after an exactly-full final batch', () => {
            for(const sk of ['e1', 'e2', 'e3', 'e4']) {
                index.upsert(entry(sk, NOW_S - 1));
            }
            expect(index.pruneExpired(2)).toBe(4);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('returns 0 and deletes nothing when no row has expired', () => {
            index.upsert(entry('never', null));
            expect(index.pruneExpired()).toBe(0);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
        });

        it('defaults to batches of 500', () => {
            expect(PRUNE_EXPIRED_BATCH_SIZE).toBe(500);
        });

        it('throws VectorIndexClosedError once closed', () => {
            index.close();
            expect(() => index.pruneExpired()).toThrow(VectorIndexClosedError);
        });
    });

    describe('pruneExpiredTombstones (#134)', () => {
        function tombstoneCount(): number {
            return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM vector_delete_tombstones').get()!.n;
        }

        it('deletes only tombstones created at or before the cutoff and returns the count', () => {
            index.deleteAndTombstone('DIR#/events/activity/chat', 'FILE#old', 1); // created_at = clockMs = NOW_MS
            clockMs = NOW_MS + DELETE_TOMBSTONE_TTL_MS;
            index.deleteAndTombstone('DIR#/events/activity/chat', 'FILE#new', 2); // created_at = NOW_MS + TTL
            expect(tombstoneCount()).toBe(2);

            expect(index.pruneExpiredTombstones()).toBe(1);

            expect(tombstoneCount()).toBe(1);
            expect(db.query<{ sk: string }, []>('SELECT sk FROM vector_delete_tombstones').get()).toEqual({ sk: 'FILE#new' });
        });

        it('prunes a tombstone exactly DELETE_TOMBSTONE_TTL_MS old (boundary is inclusive)', () => {
            index.deleteAndTombstone('DIR#/events/activity/chat', 'FILE#old', 1); // created_at = NOW_MS
            clockMs = NOW_MS + DELETE_TOMBSTONE_TTL_MS;
            expect(index.pruneExpiredTombstones()).toBe(1);
            expect(tombstoneCount()).toBe(0);
        });

        it('keeps a tombstone one millisecond younger than the TTL boundary', () => {
            index.deleteAndTombstone('DIR#/events/activity/chat', 'FILE#old', 1); // created_at = NOW_MS
            clockMs = NOW_MS + DELETE_TOMBSTONE_TTL_MS - 1;
            expect(index.pruneExpiredTombstones()).toBe(0);
            expect(tombstoneCount()).toBe(1);
        });

        it('returns 0 and deletes nothing when no tombstone has expired', () => {
            index.deleteAndTombstone('DIR#/events/activity/chat', 'FILE#fresh', 1);
            expect(index.pruneExpiredTombstones()).toBe(0);
            expect(tombstoneCount()).toBe(1);
        });

        it('loops over bounded batches until a batch comes back short', () => {
            for(const sk of ['t1', 't2', 't3', 't4', 't5']) {
                index.deleteAndTombstone('DIR#/events/activity/chat', `FILE#${sk}`, 1);
            }
            clockMs = NOW_MS + DELETE_TOMBSTONE_TTL_MS;
            expect(index.pruneExpiredTombstones(2)).toBe(5);
            expect(tombstoneCount()).toBe(0);
        });

        it('stops after an exactly-full final batch', () => {
            for(const sk of ['t1', 't2', 't3', 't4']) {
                index.deleteAndTombstone('DIR#/events/activity/chat', `FILE#${sk}`, 1);
            }
            clockMs = NOW_MS + DELETE_TOMBSTONE_TTL_MS;
            expect(index.pruneExpiredTombstones(2)).toBe(4);
            expect(tombstoneCount()).toBe(0);
        });

        it('defaults to batches of 500', () => {
            expect(PRUNE_TOMBSTONE_BATCH_SIZE).toBe(500);
        });

        it('pins the tombstone TTL at 15 minutes', () => {
            expect(DELETE_TOMBSTONE_TTL_MS).toBe(15 * 60 * 1000);
        });
    });

    describe('setTtls', () => {
        it('updates many rows in one call and counts only rows whose ttl actually changed', () => {
            index.upsert(entry('a', null));
            index.upsert(entry('b', NOW_S + 10));
            index.upsert(entry('c', NOW_S + 20));
            const changed = index.setTtls([
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#a', ttl: createEpochSeconds(NOW_S + 30) },
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#b', ttl: createEpochSeconds(NOW_S + 10) },
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#c', ttl: null },
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#missing', ttl: createEpochSeconds(NOW_S) },
            ]);
            expect(changed).toBe(2);
            expect(storedTtls()).toEqual([
                { sk: 'FILE#a', ttl: NOW_S + 30 },
                { sk: 'FILE#b', ttl: NOW_S + 10 },
                { sk: 'FILE#c', ttl: null },
            ]);
        });

        it('treats null == null as unchanged', () => {
            index.upsert(entry('a', null));
            expect(index.setTtls([{ pk: 'DIR#/events/activity/chat', sk: 'FILE#a', ttl: null }])).toBe(0);
        });

        it('returns 0 for an empty batch and throws once closed', () => {
            expect(index.setTtls([])).toBe(0);
            index.close();
            expect(() => index.setTtls([])).toThrow(VectorIndexClosedError);
        });
    });

    describe('source version guard (#129 review)', () => {
        const PK = 'DIR#/events/activity/chat';

        function storedRow() {
            return db.query<{ content_hash: string, ttl: number | null, source_updated_at: number | null }, []>(
                'SELECT content_hash, ttl, source_updated_at FROM memory_vectors'
            ).all();
        }

        it('an upsert older than the stored source version changes neither table and returns false', () => {
            expect(index.upsert(entry('a', NOW_S + 3000, { contentHash: 'new', sourceUpdatedAt: 2000 }))).toBe(true);
            expect(index.upsert(entry('a', NOW_S + 1001, { contentHash: 'old', vector: makeVector(0x11), sourceUpdatedAt: 1999 }))).toBe(false);
            expect(storedRow()).toEqual([{ content_hash: 'new', ttl: NOW_S + 3000, source_updated_at: 2000 }]);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
            expect(index.query(makeVector(0xFF), 1)[0].distance).toBe(0);
        });

        it('an upsert at the same or a newer source version replaces the row and its vector', () => {
            index.upsert(entry('a', NOW_S + 60, { contentHash: 'v1', sourceUpdatedAt: 2000 }));
            expect(index.upsert(entry('a', NOW_S + 61, { contentHash: 'v2', vector: makeVector(0x00), sourceUpdatedAt: 2000 }))).toBe(true);
            expect(storedRow()).toEqual([{ content_hash: 'v2', ttl: NOW_S + 61, source_updated_at: 2000 }]);
            expect(index.query(makeVector(0x00), 1)[0].distance).toBe(0);
            expect(index.upsert(entry('a', null, { contentHash: 'v3', sourceUpdatedAt: 2001 }))).toBe(true);
            expect(storedRow()).toEqual([{ content_hash: 'v3', ttl: null, source_updated_at: 2001 }]);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
        });

        it('a versioned upsert replaces a legacy row with no version; an unversioned one never replaces a versioned row', () => {
            expect(index.upsert(entry('a', null, { contentHash: 'legacy' }))).toBe(true);
            expect(storedRow()).toEqual([{ content_hash: 'legacy', ttl: null, source_updated_at: null }]);
            expect(index.upsert(entry('a', NOW_S + 60, { contentHash: 'v1', sourceUpdatedAt: 5 }))).toBe(true);
            expect(index.upsert(entry('a', null, { contentHash: 'unversioned' }))).toBe(false);
            expect(storedRow()).toEqual([{ content_hash: 'v1', ttl: NOW_S + 60, source_updated_at: 5 }]);
        });

        it('setTtls ignores a TTL read before the stored source version (a newer live refresh wins)', () => {
            index.upsert(entry('a', NOW_S + 3000, { sourceUpdatedAt: 2000 }));
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: createEpochSeconds(NOW_S + 1001), sourceUpdatedAt: 1000 }])).toBe(0);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: NOW_S + 3000, source_updated_at: 2000 }]);
        });

        it('setTtls applies a TTL at the same or a newer source version and records that version', () => {
            index.upsert(entry('a', NOW_S + 60, { sourceUpdatedAt: 2000 }));
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: createEpochSeconds(NOW_S + 70), sourceUpdatedAt: 2000 }])).toBe(1);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: NOW_S + 70, source_updated_at: 2000 }]);
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: null, sourceUpdatedAt: 2500 }])).toBe(1);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: null, source_updated_at: 2500 }]);
        });

        it('setTtls advances the version of a row whose TTL already matches without counting it, and never moves it back', () => {
            index.upsert(entry('a', NOW_S + 60));
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: createEpochSeconds(NOW_S + 60), sourceUpdatedAt: 1500 }])).toBe(0);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: NOW_S + 60, source_updated_at: 1500 }]);
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: createEpochSeconds(NOW_S + 60), sourceUpdatedAt: 1200 }])).toBe(0);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: NOW_S + 60, source_updated_at: 1500 }]);
        });

        it('an unversioned setTtls never touches a versioned row', () => {
            index.upsert(entry('a', NOW_S + 60, { sourceUpdatedAt: 5 }));
            expect(index.setTtls([{ pk: PK, sk: 'FILE#a', ttl: null }])).toBe(0);
            expect(storedRow()).toEqual([{ content_hash: 'hash-a', ttl: NOW_S + 60, source_updated_at: 5 }]);
        });

        it('setTtls never creates a row for a missing key', () => {
            expect(index.setTtls([{ pk: PK, sk: 'FILE#missing', ttl: createEpochSeconds(NOW_S), sourceUpdatedAt: 1 }])).toBe(0);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });
    });

    describe('generation-guarded delete', () => {
        const generation = { contentHash: 'hash-a', updatedAt: 1000, ttl: NOW_S + 60, sourceUpdatedAt: null };

        it('without a guard returns true when a row was deleted and false for a miss', () => {
            index.upsert(entry('a', null));
            expect(index.delete('DIR#/events/activity/chat', 'FILE#a')).toBe(true);
            expect(index.delete('DIR#/events/activity/chat', 'FILE#a')).toBe(false);
        });

        it('deletes the row from both tables when it is still the snapshotted generation', () => {
            index.upsert(entry('a', NOW_S + 60));
            index.upsert(entry('b', null));
            expect(index.delete('DIR#/events/activity/chat', 'FILE#a', generation)).toBe(true);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
            expect(storedTtls()).toEqual([{ sk: 'FILE#b', ttl: null }]);
        });

        it.each([
            ['content hash', { contentHash: 'hash-other' }],
            ['updated_at', { updatedAt: 2000 }],
            ['ttl', { ttl: createEpochSeconds(NOW_S + 61) }],
            ['ttl (now null)', { ttl: null }],
            ['source_updated_at', { sourceUpdatedAt: 7 }],
        ] as const)('keeps a row whose %s changed since the snapshot', (_label, change) => {
            index.upsert(entry('a', NOW_S + 60, change));
            expect(index.delete('DIR#/events/activity/chat', 'FILE#a', generation)).toBe(false);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
        });

        it('returns false for a missing row even with a guard', () => {
            expect(index.delete('DIR#/events/activity/chat', 'FILE#a', generation)).toBe(false);
        });
    });

    describe('generation-checked orphan delete tombstone (#143)', () => {
        const PK = 'DIR#/events/activity/chat';
        const generation = { contentHash: 'hash-a', updatedAt: 1000, ttl: NOW_S + 60, sourceUpdatedAt: 100 };

        it('deletes an unchanged row, writes a delete-time tombstone, and refuses a stale backfill upsert', () => {
            index.upsert(entry('a', NOW_S + 60, { sourceUpdatedAt: 100 }));

            expect(index.deleteIfSameGenerationAndTombstone(PK, 'FILE#a', generation, 200)).toBe(true);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#a')).toEqual({ source_updated_at: 200, created_at: NOW_MS });
            expect(index.upsert(entry('a', NOW_S + 60, { sourceUpdatedAt: 100 }))).toBe(false);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('keeps a changed row and writes no tombstone', () => {
            index.upsert(entry('a', NOW_S + 60, { contentHash: 'reindexed', sourceUpdatedAt: 101 }));

            expect(index.deleteIfSameGenerationAndTombstone(PK, 'FILE#a', generation, 200)).toBe(false);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#a')).toBeNull();
            expect(index.getHash(PK, 'FILE#a')).toBe('reindexed');
        });

        it('leaves a missing row untombstoned', () => {
            expect(index.deleteIfSameGenerationAndTombstone(PK, 'FILE#missing', generation, 200)).toBe(false);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#missing')).toBeNull();
        });

        it('throws once closed', () => {
            index.close();
            expect(() => index.deleteIfSameGenerationAndTombstone(PK, 'FILE#a', generation, 200)).toThrow(VectorIndexClosedError);
        });
    });

    describe('deleteAndTombstone (#134)', () => {
        const PK = 'DIR#/events/activity/chat';

        it('removes an existing row from both tables and returns true', () => {
            index.upsert(entry('a', null, { sourceUpdatedAt: 100 }));
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
            expect(index.deleteAndTombstone(PK, 'FILE#a', 200)).toBe(true);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('deletes a row whose source version exactly ties the delete\'s version', () => {
            index.upsert(entry('a', null, { sourceUpdatedAt: 100 }));
            expect(index.deleteAndTombstone(PK, 'FILE#a', 100)).toBe(true);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('deletes a legacy row with no source version regardless of the delete\'s version', () => {
            index.upsert(entry('a', null));
            expect(index.deleteAndTombstone(PK, 'FILE#a', 1)).toBe(true);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('returns false and still records a tombstone when no row exists', () => {
            expect(index.deleteAndTombstone(PK, 'FILE#missing', 100)).toBe(false);
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#missing')).toEqual({ source_updated_at: 100, created_at: NOW_MS });
            // The tombstone landed: a stale upsert for that key is now refused.
            expect(index.upsert(entry('missing', null, { sourceUpdatedAt: 50 }))).toBe(false);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('keeps a row that a concurrent recreate made newer than a late-arriving delete job, but still advances the tombstone (#134 challenge fix)', () => {
            // The delete job was enqueued for an old version (300); by the time it runs, a
            // concurrent recreate has already written a newer row (1000) via its own upsert job.
            index.upsert(entry('a', null, { sourceUpdatedAt: 1000, contentHash: 'recreated' }));
            expect(index.deleteAndTombstone(PK, 'FILE#a', 300)).toBe(false);
            // The newer row must survive untouched.
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
            expect(index.getHash(PK, 'FILE#a')).toBe('recreated');
            // The tombstone is still recorded at the delete's version, so a backfill page read
            // before the delete (but also before the recreate) is still refused.
            expect(index.upsert(entry('a', null, { sourceUpdatedAt: 200, contentHash: 'stale-backfill' }))).toBe(false);
            expect(index.getHash(PK, 'FILE#a')).toBe('recreated');
            // A legitimate write at or after the surviving row's own version still succeeds.
            expect(index.upsert(entry('a', null, { sourceUpdatedAt: 1000, contentHash: 'refresh' }))).toBe(true);
            expect(index.getHash(PK, 'FILE#a')).toBe('refresh');
        });

        it('keeps the maximum source_updated_at across repeated tombstones for the same key', () => {
            index.deleteAndTombstone(PK, 'FILE#a', 100);
            index.deleteAndTombstone(PK, 'FILE#a', 50); // out-of-order duplicate: must not regress the tombstone
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#a')?.source_updated_at).toBe(100);
            expect(index.upsert(entry('a', null, { sourceUpdatedAt: 75 }))).toBe(false);

            index.deleteAndTombstone(PK, 'FILE#a', 200);
            expect(db.query<{ source_updated_at: number, created_at: number }, [string, string]>('SELECT source_updated_at, created_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?').get(PK, 'FILE#a')?.source_updated_at).toBe(200);
            expect(index.upsert(entry('a', null, { sourceUpdatedAt: 150 }))).toBe(false);
            expect(index.upsert(entry('a', null, { sourceUpdatedAt: 200 }))).toBe(true);
        });
    });

    describe('upsert delete-tombstone guard (#134)', () => {
        const PK = 'DIR#/events/activity/chat';

        it.each([
            ['strictly before the tombstone\'s version', 99, false],
            ['tying the tombstone\'s version', 100, true],
            ['newer than the tombstone\'s version', 101, true],
        ] as const)('an upsert %s is resolved by the guard', (_label, sourceUpdatedAt, expected) => {
            index.deleteAndTombstone(PK, 'FILE#a', 100);
            expect(index.upsert(entry('a', null, { sourceUpdatedAt }))).toBe(expected);
            expect(rowCounts()).toEqual(expected ? { meta: 1, vec: 1 } : { meta: 0, vec: 0 });
        });

        it('refuses an upsert with no sourceUpdatedAt when a tombstone exists', () => {
            index.deleteAndTombstone(PK, 'FILE#a', 100);
            expect(index.upsert(entry('a', null))).toBe(false);
            expect(rowCounts()).toEqual({ meta: 0, vec: 0 });
        });

        it('an upsert on an unrelated key is unaffected by another key\'s tombstone', () => {
            index.deleteAndTombstone(PK, 'FILE#a', 100);
            expect(index.upsert(entry('b', null, { sourceUpdatedAt: 1 }))).toBe(true);
            expect(rowCounts()).toEqual({ meta: 1, vec: 1 });
        });
    });

    describe('listRowsByPathPrefix', () => {
        it('returns directory children and nested rows with their generation, in rowid order, excluding siblings', () => {
            index.upsert(entry('direct', NOW_S + 1, { pk: 'DIR#/events/activity', updatedAt: 11, sourceUpdatedAt: 21 }));
            index.upsert(entry('nested', null, { pk: 'DIR#/events/activity/chat/deep', updatedAt: 12 }));
            index.upsert(entry('sibling', null, { pk: 'DIR#/events/activityx' }));
            index.upsert(entry('sibling-nested', null, { pk: 'DIR#/events/activityx/chat' }));
            index.upsert(entry('other', null, { pk: 'DIR#/events/other' }));
            index.upsert(entry('parent', null, { pk: 'DIR#/events' }));
            expect(index.listRowsByPathPrefix('/events/activity/')).toEqual([
                { pk: 'DIR#/events/activity', sk: 'FILE#direct', contentHash: 'hash-direct', updatedAt: 11, ttl: NOW_S + 1, sourceUpdatedAt: 21 },
                { pk: 'DIR#/events/activity/chat/deep', sk: 'FILE#nested', contentHash: 'hash-nested', updatedAt: 12, ttl: null, sourceUpdatedAt: null },
            ]);
        });

        it('treats _ and % literally, unlike LIKE', () => {
            index.upsert(entry('match', null, { pk: 'DIR#/events/a_b' }));
            index.upsert(entry('wildcard-bait', null, { pk: 'DIR#/events/axb' }));
            index.upsert(entry('percent-bait', null, { pk: 'DIR#/events/a%b' }));
            expect(index.listRowsByPathPrefix('/events/a_b/').map(row => row.sk)).toEqual(['FILE#match']);
        });

        it.each(['/', '', 'events/activity/', '/events/activity'])('rejects the prefix %p', (prefix) => {
            expect(() => index.listRowsByPathPrefix(prefix)).toThrow(
                new VectorIndexError(`Path prefix must start and end with '/' and not be the root; got '${prefix}'`)
            );
        });

        it('throws VectorIndexClosedError once closed', () => {
            index.close();
            expect(() => index.listRowsByPathPrefix('/events/activity/')).toThrow(VectorIndexClosedError);
        });
    });
});

// ── #129: two connections on one file (WAL + busy_timeout + IMMEDIATE writes) ─────────────
// These exercise real file locking between two SQLite connections, which an in-memory database
// cannot share, so like the VectorIndex.open() test above they get an explicit timeout override.

describe('VectorIndex with a second connection on the same file (#129)', () => {
    let tmpPath: string;
    let seq = 0;

    beforeEach(() => {
        seq++;
        tmpPath = `${process.env.TMPDIR ?? '/tmp'}/vec-129-${process.pid}-${seq}.sqlite`;
    });

    afterEach(async () => {
        await Promise.all(['', '-wal', '-shm'].map(suffix => Bun.file(`${tmpPath}${suffix}`).delete().catch(() => undefined)));
    });

    /** A raw second connection with no busy wait, so lock conflicts surface immediately. */
    function secondConnection(): Database {
        const other = new Database(tmpPath, { readwrite: true });
        other.run('PRAGMA busy_timeout = 0');
        return other;
    }

    it('opens the file in WAL mode with busy_timeout set', async () => {
        const vi = await VectorIndex.open(tmpPath);
        const other = new Database(tmpPath, { readwrite: true });
        try {
            expect(other.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        } finally {
            other.close();
            vi.close();
        }
    }, 5000);

    it('migrates a pre-#129 file in place and reopens it idempotently', async () => {
        const legacy = new Database(tmpPath, { create: true, readwrite: true });
        legacy.run(`CREATE TABLE memory_vectors (rowid INTEGER PRIMARY KEY, pk TEXT NOT NULL, sk TEXT NOT NULL, layer TEXT NOT NULL,
            content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(pk, sk))`);
        legacy.run(`INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES ('DIR#/events/activity/chat', 'FILE#old', 'events', 'h', 1)`);
        legacy.close();

        const first = await VectorIndex.open(tmpPath);
        first.close();
        const second = await VectorIndex.open(tmpPath);
        try {
            expect(second.listRowsByPathPrefix('/events/activity/')).toEqual([
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#old', contentHash: 'h', updatedAt: 1, ttl: null, sourceUpdatedAt: null },
            ]);
            second.setTtls([{ pk: 'DIR#/events/activity/chat', sk: 'FILE#old', ttl: createEpochSeconds(NOW_S), sourceUpdatedAt: 7 }]);
        } finally {
            second.close();
        }
        // A third open of the migrated file changes nothing and keeps the stamped values.
        const third = await VectorIndex.open(tmpPath);
        try {
            expect(third.listRowsByPathPrefix('/events/activity/')).toEqual([
                { pk: 'DIR#/events/activity/chat', sk: 'FILE#old', contentHash: 'h', updatedAt: 1, ttl: NOW_S, sourceUpdatedAt: 7 },
            ]);
        } finally {
            third.close();
        }
    }, 5000);

    it('a TTL refreshed by another connection before the prune takes the lock is honoured', async () => {
        const vi = await VectorIndex.open(tmpPath, { now: () => NOW_MS });
        const other = secondConnection();
        try {
            vi.upsert(entry('refreshed', NOW_S - 10));
            other.run('UPDATE memory_vectors SET ttl = ? WHERE sk = ?', [NOW_S + 1000, 'FILE#refreshed']);
            expect(vi.pruneExpired()).toBe(0);
            expect(vi.listRowsByPathPrefix('/events/activity/').map(row => row.ttl)).toEqual([NOW_S + 1000]);
        } finally {
            other.close();
            vi.close();
        }
    }, 5000);

    it.each([
        ['pruneExpired (nothing to prune)', (vi: VectorIndex) => vi.pruneExpired()],
        ['delete (missing key)', (vi: VectorIndex) => vi.delete('DIR#/nope', 'FILE#nope')],
        ['setTtls (missing key)', (vi: VectorIndex) => vi.setTtls([{ pk: 'DIR#/nope', sk: 'FILE#nope', ttl: null }])],
    ] as const)('%s takes the write lock before reading, so it cannot straddle another writer\'s commit', async (_label, write) => {
        // With a deferred transaction these calls would read, find nothing to do and return
        // without ever needing the lock; IMMEDIATE acquires it first, so a held lock blocks them.
        const vi = await VectorIndex.open(tmpPath, { now: () => NOW_MS });
        vi.close();
        // An index on the same file that does not wait for locks, so the conflict surfaces at once.
        const impatient = VectorIndex.openWithDb(new Database(tmpPath, { readwrite: true }), {
            now:                 () => NOW_MS,
            configureConnection: (db) => { db.run('PRAGMA busy_timeout = 0'); },
        });
        const other = secondConnection();
        try {
            other.run('BEGIN IMMEDIATE');
            expect(() => write(impatient)).toThrow('database is locked');
            other.run('COMMIT');
            expect(() => write(impatient)).not.toThrow();
        } finally {
            other.close();
            impatient.close();
        }
    }, 5000);
});
