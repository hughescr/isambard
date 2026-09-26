/**
 * SQLite DDL for the memory vector index.
 *
 * Uses bun:sqlite with the sqlite-vec extension for KNN search.
 * Metadata is stored in `memory_vectors`; embeddings live in the `vec_memory` vec0 virtual table.
 * Both tables share the same rowid so a JOIN retrieves both in a single query.
 *
 * Table: memory_vectors
 * - Stores pk, sk, layer, content_hash, updated_at, ttl, source_updated_at.
 * - UNIQUE(pk, sk) guarantees at-most-one vector per memory item.
 * - ttl is the memory's DynamoDB TTL in epoch SECONDS (NULL = never expires). Expired rows are
 *   excluded from queries and pruned locally (#129); the partial index keeps that prune cheap.
 * - source_updated_at is the DynamoDB item's `updatedAt` (epoch ms) the row reflects (NULL =
 *   unknown, a pre-#129 row). Writes never replace a row with a newer source version, so a stale
 *   read cannot roll back a live refresh.
 *
 * Virtual table: vec_memory
 * - bit[1024] column stores 1024-bit (128-byte) binary embeddings.
 * - sqlite-vec's default distance for bit[] columns is Hamming distance.
 *
 * Migration guard: if the legacy `embedding` column is present on `memory_vectors`,
 * the old schema is detected and `VectorIndexUnavailableError` is thrown — the caller
 * must delete the DB file and re-run the backfill script.
 *
 * TTL migration: a pre-#129 table gains the nullable `ttl` and `source_updated_at` columns by
 * `ALTER TABLE ... ADD COLUMN` (metadata-only, instant; existing rows read NULL). The check and the ALTERs run in one
 * IMMEDIATE transaction, so when Izzy and a tool open the file together the second waits on
 * busy_timeout and then sees the column, instead of failing with "duplicate column name".
 *
 * Table: vector_delete_tombstones (#134)
 * - Brand-new, purely additive table: no ALTER needed, created with the rest of the schema on
 *   every open (old file or new).
 * - Records the version (epoch ms) a live delete last observed for (pk, sk), so a backfill page
 *   read before that delete cannot resurrect the row it removed. See backend.ts's
 *   `deleteAndTombstone()`/`upsert()` for how it is written and consulted, and
 *   `pruneExpiredTombstones()` for its TTL-bounded cleanup.
 *
 * Idempotent: all non-migration statements use IF NOT EXISTS.
 */
import type { Database } from 'bun:sqlite';
import { VectorIndexUnavailableError } from '@/errors';

/** Column info row returned by PRAGMA table_info */
interface ColumnInfoRow {
    name: string
}

/** Nullable INTEGER columns added after the original schema, in column order (#129). */
const ADDED_COLUMNS = ['ttl', 'source_updated_at'] as const;

function columnNames(db: Database): string[] {
    return db
        .query<ColumnInfoRow, []>('PRAGMA table_info(memory_vectors)')
        .all()
        .map(c => c.name);
}

/**
 * Applies the schema DDL to the given database.
 * Safe to call multiple times — uses IF NOT EXISTS guards and adds each column only when absent.
 *
 * @throws {VectorIndexUnavailableError} If the legacy schema (embedding column on memory_vectors) is detected.
 *   Delete the SQLite file and re-run the backfill script to rebuild from DynamoDB.
 */
export function runSchemaMigration(db: Database): void {
    // Detect legacy schema: memory_vectors with an embedding BLOB column
    if(columnNames(db).includes('embedding')) {
        throw new VectorIndexUnavailableError(
            'Legacy vector index schema detected (memory_vectors has an "embedding" column). '
            + 'Delete the SQLite file and re-run `bun tools/backfill-vectors.ts` to rebuild from DynamoDB.'
        );
    }

    db.transaction(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS memory_vectors (
                rowid      INTEGER PRIMARY KEY,
                pk         TEXT    NOT NULL,
                sk         TEXT    NOT NULL,
                layer      TEXT    NOT NULL,
                content_hash TEXT  NOT NULL,
                updated_at INTEGER NOT NULL,
                ttl        INTEGER,
                source_updated_at INTEGER,
                UNIQUE(pk, sk)
            )
        `);

        // A table created before #129 lacks these columns; re-checked under the write lock.
        const existing = columnNames(db);
        for(const column of ADDED_COLUMNS) {
            if(!existing.includes(column)) {
                db.run(`ALTER TABLE memory_vectors ADD COLUMN ${column} INTEGER`);
            }
        }

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_memory_vectors_layer
            ON memory_vectors(layer)
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_memory_vectors_ttl
            ON memory_vectors(ttl) WHERE ttl IS NOT NULL
        `);

        db.run(`
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding bit[1024])
        `);

        // #134: brand-new table, so plain CREATE ... IF NOT EXISTS suffices (no ALTER needed).
        db.run(`
            CREATE TABLE IF NOT EXISTS vector_delete_tombstones (
                rowid              INTEGER PRIMARY KEY,
                pk                 TEXT    NOT NULL,
                sk                 TEXT    NOT NULL,
                source_updated_at  INTEGER NOT NULL,
                created_at         INTEGER NOT NULL,
                UNIQUE(pk, sk)
            )
        `);

        db.run(`
            CREATE INDEX IF NOT EXISTS idx_vector_delete_tombstones_created_at
            ON vector_delete_tombstones(created_at)
        `);

        // Local-only schedule and keyset checkpoint; survives restarts without DynamoDB writes.
        db.run(`
            CREATE TABLE IF NOT EXISTS vector_cross_check_state (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                next_due_at INTEGER NOT NULL,
                last_run_at INTEGER,
                last_completed_rowid INTEGER NOT NULL
            )
        `);
    }).immediate();
}
