/**
 * Tests for schema.ts — SQLite DDL idempotency and vec0 virtual table
 * Uses bun:sqlite in-memory with sqlite-vec extension loaded by tests/setup.ts.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as sqliteVec from 'sqlite-vec';
import { VectorIndexUnavailableError } from '@/storage/memory-vec-store/errors';
import { runSchemaMigration } from '@/storage/memory-vec-store/schema';

describe('runSchemaMigration', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database(':memory:');
        // Load sqlite-vec extension — required for vec0 virtual table support
        sqliteVec.load(db);
    });

    afterEach(() => {
        db.close();
    });

    it('creates memory_vectors table on first run', () => {
        runSchemaMigration(db);
        const row = db.query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'`
        ).get();
        expect(row).toBeDefined();
        expect(row?.name).toBe('memory_vectors');
    });

    it('creates vec_memory virtual table on first run', () => {
        runSchemaMigration(db);
        const row = db.query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name='vec_memory'`
        ).get();
        expect(row).toBeDefined();
        expect(row?.name).toBe('vec_memory');
    });

    it('creates both memory_vectors and vec_memory together', () => {
        runSchemaMigration(db);
        const rows = db.query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name IN ('memory_vectors','vec_memory') ORDER BY name`
        ).all();
        const names = rows.map(r => r.name).toSorted((a, b) => a.localeCompare(b));
        expect(names).toEqual(['memory_vectors', 'vec_memory']);
    });

    it('creates idx_memory_vectors_layer index on first run', () => {
        runSchemaMigration(db);
        const row = db.query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_vectors_layer'`
        ).get();
        expect(row).toBeDefined();
        expect(row?.name).toBe('idx_memory_vectors_layer');
    });

    it('is idempotent — running twice does not throw', () => {
        runSchemaMigration(db);
        expect(() => runSchemaMigration(db)).not.toThrow();
    });

    it('is idempotent — tables still exist after second run', () => {
        runSchemaMigration(db);
        runSchemaMigration(db);
        const row = db.query<{ name: string }, []>(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'`
        ).get();
        expect(row).toBeDefined();
    });

    it('memory_vectors has UNIQUE constraint on (pk, sk)', () => {
        runSchemaMigration(db);
        // Insert a row
        db.run(
            'INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)',
            ['pk1', 'sk1', 'identity', 'hash1', 1000]
        );
        // Attempt to insert duplicate — should throw
        expect(() => {
            db.run(
                'INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)',
                ['pk1', 'sk1', 'identity', 'hash2', 2000]
            );
        }).toThrow();
    });

    it('memory_vectors does NOT have an embedding column', () => {
        runSchemaMigration(db);
        // PRAGMA table_info returns one row per column
        const cols = db.query<{ name: string }, []>('PRAGMA table_info(memory_vectors)').all();
        expect(cols.some(c => c.name === 'embedding')).toBe(false);
    });

    it('vec_memory accepts bit[1024] embeddings via vec_bit()', () => {
        runSchemaMigration(db);
        // Insert a metadata row first to get a rowid
        db.run(
            'INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)',
            ['pk1', 'sk1', 'identity', 'h1', 1]
        );
        const rowIdRow = db.query<{ rowid: number }, []>('SELECT rowid FROM memory_vectors').get();
        const rowId = rowIdRow!.rowid;

        // Insert into vec_memory using vec_bit() to convert Uint8Array → bit vector
        const embedding = new Uint8Array(128).fill(0xAA);
        expect(() => {
            db.run('INSERT INTO vec_memory (rowid, embedding) VALUES (?, vec_bit(?))', [rowId, embedding]);
        }).not.toThrow();
    });

    describe('legacy schema migration guard', () => {
        it('throws VectorIndexUnavailableError when memory_vectors has an embedding column', () => {
            // Manually create the old schema (with embedding column)
            db.run(`
                CREATE TABLE memory_vectors (
                    rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
                    pk           TEXT    NOT NULL,
                    sk           TEXT    NOT NULL,
                    layer        TEXT    NOT NULL,
                    content_hash TEXT    NOT NULL,
                    updated_at   INTEGER NOT NULL,
                    embedding    BLOB    NOT NULL,
                    UNIQUE(pk, sk)
                )
            `);

            expect(() => runSchemaMigration(db)).toThrow(VectorIndexUnavailableError);
        });

        it('includes helpful deletion instructions in the error message', () => {
            db.run(`
                CREATE TABLE memory_vectors (
                    rowid INTEGER PRIMARY KEY,
                    pk TEXT NOT NULL,
                    sk TEXT NOT NULL,
                    layer TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    embedding BLOB NOT NULL,
                    UNIQUE(pk, sk)
                )
            `);

            let caughtError: VectorIndexUnavailableError | undefined;
            try {
                runSchemaMigration(db);
            } catch (e) {
                if(e instanceof VectorIndexUnavailableError) {
                    caughtError = e;
                }
            }

            expect(caughtError).toBeDefined();
            expect(caughtError?.message).toContain('Legacy vector index schema');
            expect(caughtError?.message).toContain('backfill-vectors');
        });
    });
});
