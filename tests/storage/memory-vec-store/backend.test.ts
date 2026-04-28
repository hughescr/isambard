/**
 * Tests for backend.ts — VectorIndex CRUD + KNN query + layer filter + close behavior + error paths
 * Uses bun:sqlite in-memory with sqlite-vec extension.
 *
 * Note: tests/setup.ts (Bun preload) calls Database.setCustomSQLite() before any test runs,
 * ensuring sqlite-vec extension loading works on macOS.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createLayerName } from '@/storage/memory-tool/types';
import { VectorIndex } from '@/storage/memory-vec-store/backend';
import { VectorIndexClosedError, VectorIndexError } from '@/storage/memory-vec-store/errors';

/** Create a deterministic 128-byte test vector with all bits set to given pattern byte */
function makeVector(byte: number): Uint8Array {
    return new Uint8Array(128).fill(byte);
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
        if(!index.isClosed) {
            index.close();
        }
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
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h', vector: new Uint8Array(64), updatedAt: 1 })).toThrow(VectorIndexError);
        });

        it('upsert throws VectorIndexError for a vector longer than 128 bytes', () => {
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h', vector: new Uint8Array(256), updatedAt: 1 })).toThrow(VectorIndexError);
        });

        it('upsert succeeds for exactly 128 bytes', () => {
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h', vector: makeVector(0xAA), updatedAt: 1 })).not.toThrow();
        });

        it('upsert error message includes the actual length', () => {
            let thrown: unknown;
            try {
                index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h', vector: new Uint8Array(64), updatedAt: 1 });
            } catch (e) {
                thrown = e;
            }
            expect(thrown).toBeInstanceOf(VectorIndexError);
            expect((thrown as VectorIndexError).message).toContain('64');
        });

        it('query throws VectorIndexError for a query vector shorter than 128 bytes', () => {
            expect(() => index.query(new Uint8Array(64), 5)).toThrow(VectorIndexError);
        });

        it('query throws VectorIndexError for a query vector longer than 128 bytes', () => {
            expect(() => index.query(new Uint8Array(256), 5)).toThrow(VectorIndexError);
        });

        it('query succeeds for exactly 128 bytes', () => {
            expect(() => index.query(makeVector(0xFF), 5)).not.toThrow();
        });

        it('query error message includes the actual length', () => {
            let thrown: unknown;
            try {
                index.query(new Uint8Array(256), 5);
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
                layer:       'identity',
                contentHash: 'abc123',
                vector:      makeVector(0xFF),
                updatedAt:   1000,
            });
            expect(index.getHash('pk1', 'sk1')).toBe('abc123');
        });

        it('updates hash when same (pk, sk) is upserted again', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'old', vector: makeVector(0xAA), updatedAt: 1000 });
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'new', vector: makeVector(0xBB), updatedAt: 2000 });
            expect(index.getHash('pk1', 'sk1')).toBe('new');
        });

        it('stores entries with different (pk, sk) pairs independently', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'hash1', vector: makeVector(0x11), updatedAt: 1000 });
            index.upsert({ pk: 'pk2', sk: 'sk2', layer: 'state',    contentHash: 'hash2', vector: makeVector(0x22), updatedAt: 2000 });
            expect(index.getHash('pk1', 'sk1')).toBe('hash1');
            expect(index.getHash('pk2', 'sk2')).toBe('hash2');
        });
    });

    describe('delete', () => {
        it('removes the entry so getHash returns undefined', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000 });
            index.delete('pk1', 'sk1');
            expect(index.getHash('pk1', 'sk1')).toBeUndefined();
        });

        it('is a no-op for non-existent (pk, sk)', () => {
            expect(() => index.delete('nonexistent', 'nonexistent')).not.toThrow();
        });

        it('removed entry no longer appears in query results', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000 });
            index.upsert({ pk: 'pk2', sk: 'sk2', layer: 'identity', contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000 });
            index.delete('pk1', 'sk1');
            const results = index.query(makeVector(0xFF), 10);
            expect(results.every(r => r.pk !== 'pk1')).toBe(true);
        });

        it('removes the row from vec_memory too (re-query returns empty)', () => {
            index.upsert({ pk: 'only', sk: 'sk', layer: 'identity', contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000 });
            index.delete('only', 'sk');
            const results = index.query(makeVector(0xFF), 10);
            expect(results).toHaveLength(0);
        });

        it('removes the vec_memory row by the correct rowid (verifies DELETE binding)', () => {
            // Insert two entries so the rowids are distinct — deleting pk1 must only remove
            // its specific vec_memory row, not both (verifies [rowIdRow.rowid] is bound correctly).
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000 });
            index.upsert({ pk: 'pk2', sk: 'sk2', layer: 'identity', contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000 });
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
            index.upsert({ pk: 'farthest',  sk: 'sk', layer: 'identity', contentHash: 'h1', vector: makeVector(0x00), updatedAt: 1000 });
            index.upsert({ pk: 'nearest',   sk: 'sk', layer: 'identity', contentHash: 'h2', vector: makeVector(0xFF), updatedAt: 2000 });
            index.upsert({ pk: 'midpoint',  sk: 'sk', layer: 'identity', contentHash: 'h3', vector: makeVector(0xAA), updatedAt: 3000 });

            const results = index.query(makeVector(0xFF), 10);
            expect(results).toHaveLength(3);
            // First result must be nearest (distance 0)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[0]!.pk).toBe('nearest');
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[0]!.distance).toBe(0);
            // Middle result is midpoint (distance 512)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[1]!.pk).toBe('midpoint');
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[1]!.distance).toBe(512);
            // Last result is farthest (distance 1024)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[2]!.pk).toBe('farthest');
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has 3 items per assertion above
            expect(results[2]!.distance).toBe(1024);
        });

        it('returns at most limit results', () => {
            for(let i = 0; i < 10; i++) {
                index.upsert({ pk: `pk${i}`, sk: 'sk', layer: 'identity', contentHash: `h${i}`, vector: makeVector(i), updatedAt: i });
            }
            const results = index.query(makeVector(0xFF), 3);
            expect(results).toHaveLength(3);
        });

        it('returns pk, sk, layer, distance fields in each result', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0xFF), updatedAt: 1000 });
            const results = index.query(makeVector(0xFF), 10);
            expect(results).toHaveLength(1);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has exactly 1 item per check above
            const r = results[0]!;
            expect(r.pk).toBe('pk1');
            expect(r.sk).toBe('sk1');
            expect(r.layer).toBe('identity');
            expect(typeof r.distance).toBe('number');
        });

        it('layer filter returns only matching layer', () => {
            index.upsert({ pk: 'identity-item', sk: 'sk', layer: 'identity', contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000 });
            index.upsert({ pk: 'state-item',    sk: 'sk', layer: 'state',    contentHash: 'h2', vector: makeVector(0xAA), updatedAt: 2000 });
            const results = index.query(makeVector(0xAA), 10, createLayerName('identity'));
            expect(results).toHaveLength(1);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has exactly 1 item per check above
            expect(results[0]!.pk).toBe('identity-item');
        });

        it('returns all layers when no layer filter specified', () => {
            index.upsert({ pk: 'identity-item', sk: 'sk', layer: 'identity', contentHash: 'h1', vector: makeVector(0xAA), updatedAt: 1000 });
            index.upsert({ pk: 'state-item',    sk: 'sk', layer: 'state',    contentHash: 'h2', vector: makeVector(0xAA), updatedAt: 2000 });
            const results = index.query(makeVector(0xAA), 10);
            expect(results).toHaveLength(2);
        });

        it('returns distance of 0 for identical vector', () => {
            const vec = makeVector(0xAB);
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: vec, updatedAt: 1000 });
            const results = index.query(vec, 10);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has exactly 1 item per upsert above
            expect(results[0]!.distance).toBe(0);
        });

        it('returns distance 1024 for fully inverted vector (all bits differ)', () => {
            index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0x00), updatedAt: 1000 });
            const results = index.query(makeVector(0xFF), 10);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has exactly 1 item per upsert above
            expect(results[0]!.distance).toBe(1024);
        });
    });

    describe('close()', () => {
        it('sets isClosed to true', () => {
            index.close();
            expect(index.isClosed).toBe(true);
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
            expect(() => index.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h1', vector: makeVector(0), updatedAt: 1 })).toThrow(VectorIndexClosedError);
        });

        it('delete throws VectorIndexClosedError after close', () => {
            index.close();
            expect(() => index.delete('pk1', 'sk1')).toThrow(VectorIndexClosedError);
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
        it('opens a database at the given path and returns a VectorIndex', async () => {
            const tmpPath = `${process.env.TMPDIR ?? '/tmp'}/vec-test-${Date.now()}.sqlite`;
            const vi = await VectorIndex.open(tmpPath);
            try {
                expect(vi.isClosed).toBe(false);
                // Verify both tables exist via the public API (upsert + query)
                vi.upsert({ pk: 'pk1', sk: 'sk1', layer: 'identity', contentHash: 'h', vector: makeVector(0xAA), updatedAt: 1 });
                expect(vi.getHash('pk1', 'sk1')).toBe('h');
                const results = vi.query(makeVector(0xAA), 5);
                expect(results).toHaveLength(1);
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- assertion required for noUncheckedIndexedAccess in tsconfig.src.json; results has exactly 1 item per upsert above
                expect(results[0]!.distance).toBe(0);
            } finally {
                vi.close();
                await Bun.file(tmpPath).delete().catch(() => undefined);
                // Also clean up WAL/SHM files
                await Bun.file(`${tmpPath}-wal`).delete().catch(() => undefined);
                await Bun.file(`${tmpPath}-shm`).delete().catch(() => undefined);
            }
        });
    });
});
