/**
 * SQLite DDL for the memory vector index.
 *
 * Uses bun:sqlite with the sqlite-vec extension for KNN search.
 * Metadata is stored in `memory_vectors`; embeddings live in the `vec_memory` vec0 virtual table.
 * Both tables share the same rowid so a JOIN retrieves both in a single query.
 *
 * Table: memory_vectors
 * - Stores pk, sk, layer, content_hash, updated_at.
 * - UNIQUE(pk, sk) guarantees at-most-one vector per memory item.
 *
 * Virtual table: vec_memory
 * - bit[1024] column stores 1024-bit (128-byte) binary embeddings.
 * - sqlite-vec's default distance for bit[] columns is Hamming distance.
 *
 * Migration guard: if the legacy `embedding` column is present on `memory_vectors`,
 * the old schema is detected and `VectorIndexUnavailableError` is thrown — the caller
 * must delete the DB file and re-run the backfill script.
 *
 * Idempotent: all non-migration statements use IF NOT EXISTS.
 */
import type { Database } from 'bun:sqlite';
import { VectorIndexUnavailableError } from './errors.js';

/** Column info row returned by PRAGMA table_info */
interface ColumnInfoRow {
    name: string
}

/**
 * Returns true when the legacy `embedding` BLOB column is present on `memory_vectors`.
 * Used to detect the old schema and fail-fast with a helpful message.
 */
function hasLegacyEmbeddingColumn(db: Database): boolean {
    const columns = db
        .query<ColumnInfoRow, []>('PRAGMA table_info(memory_vectors)')
        .all();
    return columns.some(c => c.name === 'embedding');
}

/**
 * Applies the schema DDL to the given database.
 * Safe to call multiple times — uses IF NOT EXISTS guards.
 *
 * @throws {VectorIndexUnavailableError} If the legacy schema (embedding column on memory_vectors) is detected.
 *   Delete the SQLite file and re-run the backfill script to rebuild from DynamoDB.
 */
export function runSchemaMigration(db: Database): void {
    // Detect legacy schema: memory_vectors with an embedding BLOB column
    // Stryker disable next-line BlockStatement: migration guard — removing the throw body means we'd proceed with a corrupt schema
    if(hasLegacyEmbeddingColumn(db)) {
        throw new VectorIndexUnavailableError(
            'Legacy vector index schema detected (memory_vectors has an "embedding" column). '
            + 'Delete the SQLite file and re-run `bun tools/backfill-vectors.ts` to rebuild from DynamoDB.'
        );
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
            rowid      INTEGER PRIMARY KEY,
            pk         TEXT    NOT NULL,
            sk         TEXT    NOT NULL,
            layer      TEXT    NOT NULL,
            content_hash TEXT  NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(pk, sk)
        )
    `);

    db.run(`
        CREATE INDEX IF NOT EXISTS idx_memory_vectors_layer
        ON memory_vectors(layer)
    `);

    db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(embedding bit[1024])
    `);
}
