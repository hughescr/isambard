/**
 * Tests for schema.ts — SQLite DDL idempotency and vec0 virtual table
 * Uses bun:sqlite in-memory with sqlite-vec extension loaded by tests/setup.ts.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as sqliteVec from 'sqlite-vec';
import { VectorIndexUnavailableError } from '@/errors';
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

    it('adds the singleton cross-check state table without changing existing vectors', () => {
        runSchemaMigration(db);
        db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)', ['DIR#/identity', 'FILE#old.md', 'identity', 'original', 1]);
        db.run('INSERT INTO vector_cross_check_state (id, next_due_at, last_run_at, last_completed_rowid) VALUES (1, 70, 20, 10)');
        runSchemaMigration(db);
        expect(db.query<{ content_hash: string }, [string]>('SELECT content_hash FROM memory_vectors WHERE sk = ?').get('FILE#old.md')?.content_hash).toBe('original');
        expect(db.query<{ next_due_at: number, last_run_at: number, last_completed_rowid: number }, []>('SELECT next_due_at, last_run_at, last_completed_rowid FROM vector_cross_check_state WHERE id = 1').get()).toEqual({ next_due_at: 70, last_run_at: 20, last_completed_rowid: 10 });
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

    describe('ttl column (#129)', () => {
        const PRE_129_DDL = `
            CREATE TABLE memory_vectors (
                rowid      INTEGER PRIMARY KEY,
                pk         TEXT    NOT NULL,
                sk         TEXT    NOT NULL,
                layer      TEXT    NOT NULL,
                content_hash TEXT  NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(pk, sk)
            )
        `;

        function ttlColumn() {
            return db.query<{ name: string, type: string, notnull: number }, []>('PRAGMA table_info(memory_vectors)')
                .all()
                .filter(c => c.name === 'ttl')
                .map(c => ({ name: c.name, type: c.type, notnull: c.notnull }));
        }

        function ttlIndexSql() {
            return db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_memory_vectors_ttl'`).get()?.sql;
        }

        it('a fresh database gets a nullable INTEGER ttl column and the partial ttl index', () => {
            runSchemaMigration(db);
            expect(ttlColumn()).toEqual([{ name: 'ttl', type: 'INTEGER', notnull: 0 }]);
            expect(ttlIndexSql()?.replaceAll(/\s+/g, ' ').trim()).toBe('CREATE INDEX idx_memory_vectors_ttl ON memory_vectors(ttl) WHERE ttl IS NOT NULL');
        });

        it('adds ttl to a pre-#129 table, keeping every row with a NULL ttl', () => {
            db.run(PRE_129_DDL);
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)', ['DIR#/events', 'FILE#a', 'events', 'h1', 1]);
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)', ['DIR#/state', 'FILE#b', 'state', 'h2', 2]);

            runSchemaMigration(db);

            expect(ttlColumn()).toEqual([{ name: 'ttl', type: 'INTEGER', notnull: 0 }]);
            expect(db.query('SELECT pk, sk, content_hash, ttl FROM memory_vectors ORDER BY rowid').all()).toEqual([
                { pk: 'DIR#/events', sk: 'FILE#a', content_hash: 'h1', ttl: null },
                { pk: 'DIR#/state', sk: 'FILE#b', content_hash: 'h2', ttl: null },
            ]);
            expect(ttlIndexSql()).toBeDefined();
        });

        it('a second run on a migrated table neither re-adds the column nor throws', () => {
            db.run(PRE_129_DDL);
            runSchemaMigration(db);
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at, ttl) VALUES (?, ?, ?, ?, ?, ?)', ['p', 's', 'events', 'h', 1, 42]);
            expect(() => runSchemaMigration(db)).not.toThrow();
            expect(ttlColumn()).toHaveLength(1);
            expect(db.query('SELECT ttl FROM memory_vectors').all()).toEqual([{ ttl: 42 }]);
        });

        function addedColumns() {
            return db.query<{ name: string, type: string, notnull: number }, []>('PRAGMA table_info(memory_vectors)')
                .all()
                .filter(c => c.name === 'ttl' || c.name === 'source_updated_at')
                .map(c => ({ name: c.name, type: c.type, notnull: c.notnull }));
        }

        it('a fresh database also gets a nullable INTEGER source_updated_at column after ttl', () => {
            runSchemaMigration(db);
            expect(addedColumns()).toEqual([
                { name: 'ttl', type: 'INTEGER', notnull: 0 },
                { name: 'source_updated_at', type: 'INTEGER', notnull: 0 },
            ]);
        });

        it('adds both columns to a pre-#129 table, every existing row reading NULL', () => {
            db.run(PRE_129_DDL);
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at) VALUES (?, ?, ?, ?, ?)', ['DIR#/events', 'FILE#a', 'events', 'h1', 1]);
            runSchemaMigration(db);
            expect(addedColumns()).toEqual([
                { name: 'ttl', type: 'INTEGER', notnull: 0 },
                { name: 'source_updated_at', type: 'INTEGER', notnull: 0 },
            ]);
            expect(db.query('SELECT ttl, source_updated_at FROM memory_vectors').all()).toEqual([{ ttl: null, source_updated_at: null }]);
        });

        it('adds only source_updated_at to a table that already has ttl, keeping its ttl values', () => {
            db.run(PRE_129_DDL);
            db.run('ALTER TABLE memory_vectors ADD COLUMN ttl INTEGER');
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at, ttl) VALUES (?, ?, ?, ?, ?, ?)', ['p', 's', 'events', 'h', 1, 42]);
            runSchemaMigration(db);
            expect(addedColumns()).toEqual([
                { name: 'ttl', type: 'INTEGER', notnull: 0 },
                { name: 'source_updated_at', type: 'INTEGER', notnull: 0 },
            ]);
            expect(db.query('SELECT ttl, source_updated_at FROM memory_vectors').all()).toEqual([{ ttl: 42, source_updated_at: null }]);
        });

        it('a second run on a fully migrated table adds nothing and keeps both columns\' values', () => {
            db.run(PRE_129_DDL);
            runSchemaMigration(db);
            db.run('INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at, ttl, source_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['p', 's', 'events', 'h', 1, 42, 7]);
            expect(() => runSchemaMigration(db)).not.toThrow();
            expect(db.query<{ name: string }, []>('PRAGMA table_info(memory_vectors)').all().map(c => c.name)).toEqual([
                'rowid', 'pk', 'sk', 'layer', 'content_hash', 'updated_at', 'ttl', 'source_updated_at',
            ]);
            expect(db.query('SELECT ttl, source_updated_at FROM memory_vectors').all()).toEqual([{ ttl: 42, source_updated_at: 7 }]);
        });

        it('leaves the legacy-schema guard first: a legacy table is refused before any ALTER', () => {
            db.run(`
                CREATE TABLE memory_vectors (
                    rowid INTEGER PRIMARY KEY, pk TEXT NOT NULL, sk TEXT NOT NULL, layer TEXT NOT NULL,
                    content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, embedding BLOB NOT NULL, UNIQUE(pk, sk)
                )
            `);
            expect(() => runSchemaMigration(db)).toThrow(VectorIndexUnavailableError);
            expect(ttlColumn()).toEqual([]);
        });
    });

    describe('vector_delete_tombstones table (#134)', () => {
        it('creates vector_delete_tombstones table on first run', () => {
            runSchemaMigration(db);
            const row = db.query<{ name: string }, []>(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='vector_delete_tombstones'`
            ).get();
            expect(row).toBeDefined();
            expect(row?.name).toBe('vector_delete_tombstones');
        });

        it('creates idx_vector_delete_tombstones_created_at index on first run', () => {
            runSchemaMigration(db);
            const row = db.query<{ name: string }, []>(
                `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_vector_delete_tombstones_created_at'`
            ).get();
            expect(row).toBeDefined();
            expect(row?.name).toBe('idx_vector_delete_tombstones_created_at');
        });

        it('vector_delete_tombstones has UNIQUE constraint on (pk, sk)', () => {
            runSchemaMigration(db);
            db.run(
                'INSERT INTO vector_delete_tombstones (pk, sk, source_updated_at, created_at) VALUES (?, ?, ?, ?)',
                ['pk1', 'sk1', 100, 1000]
            );
            expect(() => {
                db.run(
                    'INSERT INTO vector_delete_tombstones (pk, sk, source_updated_at, created_at) VALUES (?, ?, ?, ?)',
                    ['pk1', 'sk1', 200, 2000]
                );
            }).toThrow();
        });

        it('is idempotent — running twice keeps the table and does not throw', () => {
            runSchemaMigration(db);
            db.run(
                'INSERT INTO vector_delete_tombstones (pk, sk, source_updated_at, created_at) VALUES (?, ?, ?, ?)',
                ['pk1', 'sk1', 100, 1000]
            );
            expect(() => runSchemaMigration(db)).not.toThrow();
            expect(db.query('SELECT pk, sk, source_updated_at, created_at FROM vector_delete_tombstones').all()).toEqual([
                { pk: 'pk1', sk: 'sk1', source_updated_at: 100, created_at: 1000 },
            ]);
        });
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
