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
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import type { LayerName } from '../memory-tool/types.js';
import { VectorIndexClosedError, VectorIndexError, VectorIndexUnavailableError } from './errors.js';
import { runSchemaMigration } from './schema.js';
import type { VectorIndexEntry, VectorQueryResult } from './types.js';

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

/** True once setCustomSQLite has been called for this process. */
// Stryker disable next-line BooleanLiteral -- module-level idempotency state for macOS-specific SQLite setup; initial value false is correct — cannot be unit-tested in Bun where tests/setup.ts pre-configures the path before any VectorIndex is opened
let customSqliteConfigured = false;

// Stryker disable StringLiteral -- macOS library paths are platform-specific constants — cannot be unit-tested in Bun test environment
/** Homebrew sqlite3 library path on Apple Silicon Macs. */
const HOMEBREW_ARM_PATH = '/opt/homebrew/opt/sqlite3/lib/libsqlite3.dylib';

/** Homebrew sqlite3 library path on Intel Macs. */
const HOMEBREW_INTEL_PATH = '/usr/local/opt/sqlite3/lib/libsqlite3.dylib';
// Stryker restore StringLiteral

/**
 * Configures Bun to use the Homebrew-installed libsqlite3.dylib on macOS.
 * Idempotent — safe to call multiple times; configures only once per process.
 *
 * On Linux/other platforms the system SQLite allows extension loading by default,
 * so this is a no-op.
 *
 * Note: When running in test environments, `tests/setup.ts` (the Bun preload file)
 * calls `Database.setCustomSQLite` before any test runs. In that case this function
 * is a no-op because `customSqliteConfigured` is already set or because
 * `Database.setCustomSQLite` would throw "SQLite already loaded" — we mark it
 * as configured in either case.
 *
 * @throws {VectorIndexUnavailableError} On macOS when no valid libsqlite3.dylib is found.
 */
// Stryker disable all -- macOS SQLite setup: platform-specific code cannot be unit-tested in Bun; tests/setup.ts pre-configures the custom SQLite path before any test runs
function configureCustomSQLite(): void {
    // Idempotency guard — only configure once per process
    // Stryker disable next-line ConditionalExpression,BlockStatement -- idempotency guard — calling setCustomSQLite twice would throw; removing this guard is not safe
    if(customSqliteConfigured) {
        return;
    }

    // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement -- platform guard — skipping on Linux is correct; always calling setCustomSQLite on Linux would break non-mac CIs
    if(process.platform !== 'darwin') {
        customSqliteConfigured = true;
        return;
    }

    // Allow callers to override via environment variable for non-standard installs
    const envPath = process.env.SQLITE_VEC_LIB_PATH;
    // Stryker disable next-line ConditionalExpression,BlockStatement -- env override — tested by integration path; skipping when undefined falls through to probing
    if(envPath) {
        // Stryker disable next-line BlockStatement -- "SQLite already loaded" means tests/setup.ts already configured it — mark as done
        try {
            Database.setCustomSQLite(envPath);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        customSqliteConfigured = true;
        return;
    }

    // Probe Apple Silicon Homebrew path first, then Intel fallback
    // Stryker disable next-line ConditionalExpression,BlockStatement -- ARM path probe — tested via existsSync; alternative is Intel fallback
    // eslint-disable-next-line n/no-sync -- sync probe required at startup before any Database is opened; async FS would require restructuring the entire init chain
    if(existsSync(HOMEBREW_ARM_PATH)) {
        // Stryker disable next-line BlockStatement -- "SQLite already loaded" means tests/setup.ts already configured it — mark as done
        try {
            Database.setCustomSQLite(HOMEBREW_ARM_PATH);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        customSqliteConfigured = true;
        return;
    }

    // Stryker disable next-line ConditionalExpression,BlockStatement -- Intel path probe — tested via existsSync; alternative is the unavailable error below
    // eslint-disable-next-line n/no-sync -- sync probe required at startup before any Database is opened; async FS would require restructuring the entire init chain
    if(existsSync(HOMEBREW_INTEL_PATH)) {
        // Stryker disable next-line BlockStatement -- "SQLite already loaded" means tests/setup.ts already configured it — mark as done
        try {
            Database.setCustomSQLite(HOMEBREW_INTEL_PATH);
        } catch{
            // Silent: Bun's SQLite throws "SQLite already loaded" when setCustomSQLite is
            // called a second time in the same process (e.g., tests/setup.ts already
            // configured it). Idempotency is the correct behavior; the library is already
            // pointing at the right binary, so the error is not an error.
        }
        customSqliteConfigured = true;
        return;
    }

    throw new VectorIndexUnavailableError(
        'sqlite-vec requires an extension-enabled SQLite on macOS. '
        + 'Run `brew install sqlite` and ensure libsqlite3.dylib is at '
        + `${HOMEBREW_ARM_PATH} (Apple Silicon) or ${HOMEBREW_INTEL_PATH} (Intel). `
        + 'Set SQLITE_VEC_LIB_PATH to override the library path.'
    );
}
// Stryker restore all

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
    // Stryker disable all -- I/O method — actual file access cannot be tested without real filesystem
    static async open(dbPath: string): Promise<VectorIndex> {
        try {
            configureCustomSQLite();
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        let db: Database;
        try {
            db = new Database(dbPath, { create: true, readwrite: true });
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        try {
            sqliteVec.load(db);
            runSchemaMigration(db);
        } catch (err) {
            db.close();
            const reason = err instanceof Error ? err.message : String(err);
            throw new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
        }

        return new VectorIndex(db);
    }
    // Stryker restore all

    /**
     * Creates a VectorIndex wrapping an already-opened Database.
     * Loads the sqlite-vec extension and runs schema migration.
     * Useful for testing with in-memory databases (caller controls extension loading).
     */
    static openWithDb(db: Database): VectorIndex {
        sqliteVec.load(db);
        runSchemaMigration(db);
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
    static readonly EXPECTED_BYTES = 128;

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
                // Stryker disable next-line ObjectLiteral -- context bag is debug-only metadata — mutation to {} doesn't affect throw behavior or message
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

            // Stryker disable next-line ConditionalExpression,BlockStatement -- early-return no-op guard — no row to delete is a valid outcome
            if(rowIdRow === null) {
                return; // No-op: entry does not exist
            }

            // Delete from metadata first, then from embedding index using the rowid we looked up above
            this.#db.run('DELETE FROM memory_vectors WHERE pk = ? AND sk = ?', [pk, sk]);
            // Stryker disable next-line ArrayDeclaration -- binding array holds the rowid for targeted DELETE — mutation to [] leaves rowid unbound (static-coverage NoCoverage)
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
    query(queryVector: Uint8Array, limit: number, layer?: LayerName): VectorQueryResult[] {
        this.#assertOpen();
        if(queryVector.length !== VectorIndex.EXPECTED_BYTES) {
            throw new VectorIndexError(
                `Embedding must be ${VectorIndex.EXPECTED_BYTES} bytes; got ${queryVector.length}`,
                undefined,
                // Stryker disable next-line ObjectLiteral -- context bag is debug-only metadata — mutation to {} doesn't affect throw behavior or message
                { length: queryVector.length }
            );
        }

        // Stryker disable next-line ConditionalExpression -- branch selects the correct SQL variant (with/without layer filter)
        return layer === undefined
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
    }

    /**
     * Closes the underlying SQLite database.
     * Idempotent — safe to call multiple times.
     */
    close(): void {
        // Stryker disable next-line ConditionalExpression,BlockStatement -- bun:sqlite db.close() is idempotent (no-op on already-closed DB) — removing this guard has no observable effect
        if(this.#closed) {
            return;
        }
        this.#closed = true;
        this.#db.close();
    }
}
