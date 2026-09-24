/**
 * VectorIndex — SQLite-backed vector index for semantic memory search.
 *
 * Wraps bun:sqlite + sqlite-vec to provide:
 * - Upsert (insert/update) of 1024-bit binary embeddings stored in a vec0 virtual table
 * - Hash-based deduplication (skip re-embed when content unchanged)
 * - KNN query using sqlite-vec's built-in Hamming distance for bit[] columns
 * - Delete (pruning) that removes from both the metadata and embedding tables
 *
 * Architecture: two tables share a rowid:
 *   memory_vectors  — metadata (pk, sk, layer, content_hash, updated_at)
 *   vec_memory      — vec0 virtual table with embedding bit[1024]
 *
 * Embeddings are stored as bit vectors via `vec_bit(?)`. sqlite-vec uses Hamming
 * distance for bit[] columns, which is correct for our packed binary embeddings.
 *
 * The sqlite-vec extension must be loaded before any vec0 table operations.
 * On macOS, Bun's built-in SQLite blocks extensions; a Homebrew-installed
 * libsqlite3.dylib is required. See `configureCustomSQLite()` for details.
 *
 * All public methods are synchronous (bun:sqlite is sync).
 * Open with `VectorIndex.open(path)` for file-backed DB, or
 * `VectorIndex.openWithDb(db)` for a pre-opened in-memory DB (testing).
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { logger } from '@hughescr/logger';
import * as sqliteVec from 'sqlite-vec';
import { MemoryToolKeyGenerator } from '../memory-tool/key-generator.js';
import { createMemoryPath, classifyMemoryPath, type IndexLayer } from '../memory-tool/types.js';
import { runSchemaMigration } from './schema.js';
import { PACKED_EMBEDDING_BYTES, type VectorIndexEntry, type VectorQueryResult } from './types.js';
import { VectorIndexClosedError, VectorIndexError, VectorIndexUnavailableError } from '@/errors';

// ---------------------------------------------------------------------------
// macOS custom-SQLite setup
//
// Bun bundles its own SQLite which blocks extension loading for security.
// On macOS we must redirect to the Homebrew-installed libsqlite3.dylib which
// was compiled with extension loading enabled (-DSQLITE_OMIT_LOAD_EXTENSION=0).
//
// Database.setCustomSQLite is a static that must be called BEFORE any Database
// is opened. We track whether we've already configured it to make multiple
// VectorIndex.open() calls idempotent.
// ---------------------------------------------------------------------------

/** Shared state for the process-global SQLite selection. */
export function createSQLiteConfigurationState(): { configured: boolean } {
    return { configured: false };
}

const sqliteConfigurationState = createSQLiteConfigurationState();

/** Homebrew sqlite3 library path on Apple Silicon Macs. */
const HOMEBREW_ARM_PATH = '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib';

/** Homebrew sqlite3 library path on Intel Macs. */
const HOMEBREW_INTEL_PATH = '/usr/local/opt/sqlite3/lib/libsqlite3.dylib';

/**
 * Configures Bun to use the Homebrew-installed libsqlite3.dylib on macOS.
 * Idempotent — safe to call multiple times; configures only once per process.
 *
 * On Linux/other platforms the system SQLite allows extension loading by default,
 * so this is a no-op.
 *
 * Note: When running in test environments, `tests/setup.ts` (the Bun preload file)
 * calls `Database.setCustomSQLite` before any test runs. In that case this function
 * is a no-op because `sqliteConfigurationState.configured` is already set or because
 * `Database.setCustomSQLite` would throw "SQLite already loaded" — we mark it
 * as configured in either case.
 *
 * @throws {VectorIndexUnavailableError} On macOS when no valid libsqlite3.dylib is found.
 */
export interface SQLiteConfigurationDeps {
    state:           { configured: boolean }
    platform:        string
    overridePath?:   string
    exists:          (path: string) => boolean
    setCustomSQLite: (path: string) => void
}

function defaultSQLiteConfigurationDeps(): SQLiteConfigurationDeps {
    return {
        state:           sqliteConfigurationState,
        platform:        process.platform,
        overridePath:    process.env.SQLITE_VEC_LIB_PATH,
        exists:          existsSync,
        setCustomSQLite: path => Database.setCustomSQLite(path),
    };
}

export function configureCustomSQLite(deps: SQLiteConfigurationDeps = defaultSQLiteConfigurationDeps()): void {
    // Idempotency guard — only configure once per process
    if(deps.state.configured) {
        return;
    }

    // Stryker disable next-line llm: `undefined !== 'darwin'` is already true, so appending `|| deps.platform === undefined` cannot change the guard for any platform value
    if(deps.platform !== 'darwin') {
        deps.state.configured = true;
        return;
    }

    // Allow callers to override via environment variable for non-standard installs
    const envPath = deps.overridePath;
    if(envPath) {
        try {
            deps.setCustomSQLite(envPath);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        deps.state.configured = true;
        return;
    }

    // Probe Apple Silicon Homebrew path first, then Intel fallback
    if(deps.exists(HOMEBREW_ARM_PATH)) {
        try {
            deps.setCustomSQLite(HOMEBREW_ARM_PATH);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        deps.state.configured = true;
        return;
    }

    if(deps.exists(HOMEBREW_INTEL_PATH)) {
        try {
            deps.setCustomSQLite(HOMEBREW_INTEL_PATH);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        deps.state.configured = true;
        return;
    }

    throw new VectorIndexUnavailableError(
        'sqlite-vec requires an extension-enabled SQLite on macOS. '
        + 'Run `brew install sqlite` and ensure libsqlite3.dylib is at '
        + `${HOMEBREW_ARM_PATH} (Apple Silicon) or ${HOMEBREW_INTEL_PATH} (Intel). `
        + 'Set SQLITE_VEC_LIB_PATH to override the library path.'
    );
}

// ---------------------------------------------------------------------------
// Row types for internal queries
// ---------------------------------------------------------------------------

/** Row for metadata+distance from the KNN join query. */
interface KnnRow {
    pk:       string
    sk:       string
    layer:    string
    distance: number
}

/** Row for hash lookup. */
interface HashRow {
    content_hash: string
}

/** Row for rowid lookup by (pk, sk). */
interface RowIdRow {
    rowid: number
}

export interface VectorIndexOpenDeps {
    configure?:      () => void
    createDatabase?: (dbPath: string, options: { create: boolean, readwrite: boolean }) => Database
    loadExtension?:  (db: Database) => void
    migrateSchema?:  (db: Database) => void
}

// ---------------------------------------------------------------------------
// VectorIndex class
// ---------------------------------------------------------------------------

/**
 * SQLite-backed vector index for 1024-bit binary embeddings.
 *
 * Metadata in `memory_vectors`, embeddings in the `vec_memory` vec0 virtual table.
 * KNN search delegates to sqlite-vec Hamming distance (correct for bit[] columns).
 */
export class VectorIndex {
    #db: Database;
    #closed = false;

    private constructor(db: Database) {
        this.#db = db;
    }

    /**
     * Opens a file-backed SQLite database, loads the sqlite-vec extension,
     * runs schema migration, and returns a VectorIndex.
     *
     * On macOS this also calls `Database.setCustomSQLite` once per process
     * to redirect Bun to the Homebrew-installed libsqlite3.dylib.
     *
     * @throws {VectorIndexUnavailableError} If the sqlite-vec extension cannot
     *   be loaded, if the database cannot be opened, or if schema migration fails.
     */
    static async open(dbPath: string, deps: VectorIndexOpenDeps = {}): Promise<VectorIndex> {
        try {
            (deps.configure ?? configureCustomSQLite)();
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        let db: Database;
        try {
            db = (deps.createDatabase ?? ((path, options) => new Database(path, options)))(dbPath, { create: true, readwrite: true });
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        try {
            (deps.loadExtension ?? sqliteVec.load)(db);
            (deps.migrateSchema ?? runSchemaMigration)(db);
        } catch (err) {
            db.close();
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        return new VectorIndex(db);
    }

    /**
     * Creates a VectorIndex wrapping an already-opened Database.
     * Loads the sqlite-vec extension and runs schema migration.
     * Useful for testing with in-memory databases (caller controls extension loading).
     */
    static openWithDb(db: Database, deps: Pick<VectorIndexOpenDeps, 'loadExtension' | 'migrateSchema'> = {}): VectorIndex {
        (deps.loadExtension ?? sqliteVec.load)(db);
        (deps.migrateSchema ?? runSchemaMigration)(db);
        return new VectorIndex(db);
    }

    /** True once close() has been called. */
    get isClosed(): boolean {
        return this.#closed;
    }

    #assertOpen(): void {
        if(this.#closed) {
            throw new VectorIndexClosedError();
        }
    }

    /**
     * Returns the stored content hash for (pk, sk), or undefined if not indexed.
     */
    getHash(pk: string, sk: string): string | undefined {
        this.#assertOpen();
        const row = this.#db
            .query<HashRow, [string, string]>(
                'SELECT content_hash FROM memory_vectors WHERE pk = ? AND sk = ?'
            )
            .get(pk, sk);
        return row?.content_hash;
    }

    /** Expected byte length for 1024-bit packed binary embeddings (1024 bits / 8 = 128 bytes). */
    static readonly EXPECTED_BYTES = PACKED_EMBEDDING_BYTES;

    /**
     * Upserts a vector entry in a single transaction.
     *
     * 1. INSERT OR REPLACE into `memory_vectors` (gets a rowid).
     * 2. Upsert the matching vec_memory row at the same rowid using vec_bit() to
     *    convert the Uint8Array BLOB into a bit vector.
     *
     * The embedding must be a Uint8Array (128 bytes for 1024 bits).
     * vec0 does not support ON CONFLICT, so the vec_memory row is deleted and re-inserted.
     *
     * @throws {VectorIndexError} If the embedding vector is not exactly 128 bytes.
     */
    upsert(entry: VectorIndexEntry): void {
        this.#assertOpen();
        if(entry.vector.length !== VectorIndex.EXPECTED_BYTES) {
            throw new VectorIndexError(
                `Embedding must be ${VectorIndex.EXPECTED_BYTES} bytes; got ${entry.vector.length}`,
                undefined,
                { length: entry.vector.length }
            );
        }

        const upsertTx = this.#db.transaction(() => {
            // Step 1: upsert metadata row; ON CONFLICT updates all fields and preserves rowid
            this.#db.run(
                `INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(pk, sk) DO UPDATE SET
                     layer        = excluded.layer,
                     content_hash = excluded.content_hash,
                     updated_at   = excluded.updated_at`,
                [entry.pk, entry.sk, entry.layer, entry.contentHash, entry.updatedAt]
            );

            // Step 2: look up the rowid and upsert the vec_memory row at the same rowid
            const rowIdRow = this.#db
                .query<RowIdRow, [string, string]>(
                    'SELECT rowid FROM memory_vectors WHERE pk = ? AND sk = ?'
                )
                .get(entry.pk, entry.sk);

            // rowid is guaranteed to exist immediately after the INSERT above
            const rowId = rowIdRow!.rowid;

            // vec0 does not support ON CONFLICT — delete existing row first, then insert
            // vec_bit() converts the raw Uint8Array BLOB into the bit vector format
            this.#db.run('DELETE FROM vec_memory WHERE rowid = ?', [rowId]);
            this.#db.run(
                'INSERT INTO vec_memory (rowid, embedding) VALUES (?, vec_bit(?))',
                [rowId, entry.vector]
            );
        });

        upsertTx();
    }

    /**
     * Deletes the vector entry for (pk, sk).
     * Removes from both `memory_vectors` and `vec_memory` in a single transaction.
     * No-op if the entry does not exist.
     */
    delete(pk: string, sk: string): void {
        this.#assertOpen();

        const deleteTx = this.#db.transaction(() => {
            // Look up rowid before deleting from metadata table
            const rowIdRow = this.#db
                .query<RowIdRow, [string, string]>(
                    'SELECT rowid FROM memory_vectors WHERE pk = ? AND sk = ?'
                )
                .get(pk, sk);

            // Stryker disable next-line llm: SQLite returns null for a miss and RowIdRow is an object, so a falsiness check has identical results.
            if(rowIdRow === null) {
                return; // No-op: entry does not exist
            }

            // Delete from metadata first, then from embedding index using the rowid we looked up above
            this.#db.run('DELETE FROM memory_vectors WHERE pk = ? AND sk = ?', [pk, sk]);
            this.#db.run('DELETE FROM vec_memory WHERE rowid = ?', [rowIdRow.rowid]);
        });

        deleteTx();
    }

    /**
     * Runs a KNN query against the vec0 virtual table using sqlite-vec Hamming distance.
     *
     * sqlite-vec returns rows in distance order ascending (smallest distance = most similar).
     * The `k` parameter controls how many candidates sqlite-vec evaluates internally.
     *
     * vec_bit() converts the raw Uint8Array query vector into the bit vector format
     * that sqlite-vec's MATCH operator expects.
     *
     * @param queryVector - 128-byte packed binary query vector (Uint8Array)
     * @param limit - Maximum number of results (maps to `k = ?` in vec0 KNN syntax)
     * @param layer - Optional layer filter (identity, state, events, etc.)
     * @returns Results sorted by Hamming distance ascending (most similar first)
     * @throws {VectorIndexError} If the query vector is not exactly 128 bytes.
     */
    query(queryVector: Uint8Array, limit: number, layer?: IndexLayer): VectorQueryResult[] {
        this.#assertOpen();
        if(queryVector.length !== VectorIndex.EXPECTED_BYTES) {
            throw new VectorIndexError(
                `Embedding must be ${VectorIndex.EXPECTED_BYTES} bytes; got ${queryVector.length}`,
                undefined,
                { length: queryVector.length }
            );
        }

        const rows = layer === undefined
            ? this.#db
                .query<KnnRow, [Uint8Array, number]>(
                    `SELECT m.pk, m.sk, m.layer, v.distance
                     FROM vec_memory v
                     JOIN memory_vectors m ON m.rowid = v.rowid
                     WHERE v.embedding MATCH vec_bit(?) AND k = ?
                     ORDER BY v.distance`
                )
                .all(queryVector, limit)
            : this.#db
                .query<KnnRow, [Uint8Array, number, string]>(
                    `SELECT m.pk, m.sk, m.layer, v.distance
                     FROM vec_memory v
                     JOIN memory_vectors m ON m.rowid = v.rowid
                     WHERE v.embedding MATCH vec_bit(?) AND k = ?
                       AND m.layer = ?
                     ORDER BY v.distance`
                )
                .all(queryVector, limit, layer);
        const valid: VectorQueryResult[] = [];
        for(const row of rows) {
            try {
                const path = createMemoryPath(MemoryToolKeyGenerator.parsePath(row.pk, row.sk));
                valid.push({ path, layer: classifyMemoryPath(path).namespace, distance: row.distance });
            } catch (error) {
                logger.warn({ error, pk: row.pk, sk: row.sk, msg: 'Skipping malformed legacy vector-index row' });
            }
        }
        return valid;
    }

    /**
     * Closes the underlying SQLite database.
     * Idempotent — safe to call multiple times.
     */
    close(): void {
        if(this.#closed) {
            return;
        }
        this.#closed = true;
        this.#db.close();
    }
}
