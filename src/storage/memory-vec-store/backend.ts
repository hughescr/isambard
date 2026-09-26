/**
 * VectorIndex — SQLite-backed vector index for semantic memory search.
 *
 * Wraps bun:sqlite + sqlite-vec to provide:
 * - Upsert (insert/update) of 1024-bit binary embeddings stored in a vec0 virtual table
 * - Hash-based deduplication (skip re-embed when content unchanged)
 * - KNN query using sqlite-vec's built-in Hamming distance for bit[] columns
 * - Delete (pruning) that removes from both the metadata and embedding tables
 * - TTL expiry (#129): each row carries its memory's DynamoDB TTL (epoch seconds); expired rows
 *   are excluded from queries and removed by `pruneExpired()` with zero DynamoDB reads
 * - Source-version guard (#129): each row carries the DynamoDB item's `updatedAt` it reflects, and
 *   `upsert`/`setTtls` never replace a row with a newer one, so a stale read cannot roll it back
 * - Delete tombstones (#134): `deleteAndTombstone()` records the version of every live delete in
 *   `vector_delete_tombstones`, and `upsert()` refuses to recreate a row at an older version than
 *   the delete it would resurrect — closing the gap where a backfill page read before a live
 *   delete could otherwise re-insert an orphan row. `pruneExpiredTombstones()` bounds the table's
 *   size with zero DynamoDB reads, mirroring `pruneExpired()`.
 *
 * Architecture: two tables share a rowid:
 *   memory_vectors  — metadata (pk, sk, layer, content_hash, updated_at, ttl, source_updated_at)
 *   vec_memory      — vec0 virtual table with embedding bit[1024]
 *
 * Embeddings are stored as bit vectors via `vec_bit(?)`. sqlite-vec uses Hamming
 * distance for bit[] columns, which is correct for our packed binary embeddings.
 *
 * The sqlite-vec extension must be loaded before any vec0 table operations.
 * On macOS, Bun's built-in SQLite blocks extensions; a Homebrew-installed
 * libsqlite3.dylib is required. See `configureCustomSQLite()` for details.
 *
 * Concurrency (#129): every connection sets busy_timeout and WAL (see connection.ts), and every
 * write transaction is IMMEDIATE — it takes the write lock before its first read, so a
 * read-then-write can neither act on a stale read nor fail with SQLITE_BUSY_SNAPSHOT when another
 * process (Izzy, the backfill, the orphan prune) commits in between.
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
import { configureVectorDbConnection } from './connection.js';
import { runSchemaMigration } from './schema.js';
import {
    PACKED_EMBEDDING_BYTES,
    type PackedBinaryEmbedding1024,
    type VectorIndexEntry,
    type VectorQueryResult,
    type VectorRowSnapshot,
    type VectorTtlUpdate
} from './types.js';
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

/** Row for a guarded delete: the rowid plus the generation fields. */
interface GenerationRow {
    rowid:             number
    content_hash:      string
    updated_at:        number
    ttl:               number | null
    source_updated_at: number | null
}

/** Row for a path-prefix listing. */
interface SnapshotRow {
    pk:                string
    sk:                string
    content_hash:      string
    updated_at:        number
    ttl:               number | null
    source_updated_at: number | null
}

/** Row for a rowid + source-version lookup, used by `deleteAndTombstone` (#134). */
interface RowIdAndVersionRow {
    rowid:             number
    source_updated_at: number | null
}

/** Row for a delete-tombstone lookup, used by `upsert` (#134). */
interface TombstoneRow {
    source_updated_at: number
}

/** sqlite-vec 0.1.x rejects KNN k values above this ceiling. */
const SQLITE_VEC_KNN_MAX_K = 4096;

/** Default number of expired rows deleted per IMMEDIATE transaction by `pruneExpired`. */
export const PRUNE_EXPIRED_BATCH_SIZE = 500;

/** Default number of expired tombstones deleted per IMMEDIATE transaction by `pruneExpiredTombstones` (#134). */
export const PRUNE_TOMBSTONE_BATCH_SIZE = 500;

/**
 * How long a delete tombstone (#134) is kept before `pruneExpiredTombstones` removes it: a large
 * safety margin over the actual race window (one backfill page's read-to-write gap, bounded to
 * low seconds even with the indexer's retries/backoff), chosen so retuning it later is cheap.
 */
export const DELETE_TOMBSTONE_TTL_MS = 15 * 60 * 1000;

export interface VectorIndexOpenDeps {
    configure?:           () => void
    createDatabase?:      (dbPath: string, options: { create: boolean, readwrite: boolean }) => Database
    /** Sets per-connection pragmas (busy_timeout, WAL); runs before the extension and schema. */
    configureConnection?: (db: Database) => void
    loadExtension?:       (db: Database) => void
    migrateSchema?:       (db: Database) => void
    /** Clock (epoch ms) for TTL expiry decisions; defaults to Date.now. */
    now?:                 () => number
    /** Override the sqlite-vec KNN ceiling for small fallback tests. Must be positive. */
    knnMaxK?:             number
}

function defaultConfigureConnection(db: Database): void {
    configureVectorDbConnection(db, logger);
}

/** True when a stored row is still the generation the caller snapshotted. */
function isSameGeneration(row: GenerationRow, expected: Omit<VectorRowSnapshot, 'pk' | 'sk'>): boolean {
    const { contentHash, updatedAt, ttl, sourceUpdatedAt } = expected;
    return row.content_hash === contentHash && row.updated_at === updatedAt && row.ttl === ttl && row.source_updated_at === sourceUpdatedAt;
}

/** Wraps any open-time failure as the index being unavailable, keeping the cause. */
function unavailable(err: unknown): VectorIndexUnavailableError {
    const reason = err instanceof Error ? err.message : String(err);
    return new VectorIndexUnavailableError(reason, err instanceof Error ? err : undefined);
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
    readonly #db:      Database;
    readonly #now:     () => number;
    readonly #knnMaxK: number;
    #closed = false;

    private constructor(db: Database, now: () => number, knnMaxK: number) {
        this.#db = db;
        this.#now = now;
        this.#knnMaxK = knnMaxK;
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
            throw unavailable(err);
        }

        let db: Database;
        try {
            db = (deps.createDatabase ?? ((path, options) => new Database(path, options)))(dbPath, { create: true, readwrite: true });
        } catch (err) {
            throw unavailable(err);
        }

        try {
            (deps.configureConnection ?? defaultConfigureConnection)(db);
            (deps.loadExtension ?? sqliteVec.load)(db);
            (deps.migrateSchema ?? runSchemaMigration)(db);
        } catch (err) {
            db.close();
            throw unavailable(err);
        }

        return new VectorIndex(db, deps.now ?? Date.now, deps.knnMaxK ?? SQLITE_VEC_KNN_MAX_K);
    }

    /**
     * Creates a VectorIndex wrapping an already-opened Database.
     * Sets the connection pragmas, loads the sqlite-vec extension and runs schema migration.
     * Useful for testing with in-memory databases (caller controls extension loading).
     */
    static openWithDb(
        db: Database,
        deps: Pick<VectorIndexOpenDeps, 'configureConnection' | 'loadExtension' | 'migrateSchema' | 'now' | 'knnMaxK'> = {}
    ): VectorIndex {
        (deps.configureConnection ?? defaultConfigureConnection)(db);
        (deps.loadExtension ?? sqliteVec.load)(db);
        (deps.migrateSchema ?? runSchemaMigration)(db);
        return new VectorIndex(db, deps.now ?? Date.now, deps.knnMaxK ?? SQLITE_VEC_KNN_MAX_K);
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
     * Source-version guard: an existing row is replaced only when it has no source version or the
     * entry's is the same or newer; otherwise neither table changes (the row already reflects a
     * later DynamoDB write than the one this entry was read from).
     *
     * Delete-tombstone guard (#134): if a live delete tombstoned this (pk, sk) more recently than
     * this entry's own source version (or the entry has none), the write is refused — a stale
     * backfill page read before that delete cannot resurrect the row it removed. A tie is let
     * through, matching the row-vs-row guard's `>=` convention.
     *
     * @returns false when a guard kept a newer row (or a delete), true when the entry was written.
     * @throws {VectorIndexError} If the embedding vector is not exactly 128 bytes.
     */
    upsert(entry: VectorIndexEntry): boolean {
        this.#assertOpen();
        if(entry.vector.length !== PACKED_EMBEDDING_BYTES) {
            throw new VectorIndexError(
                `Embedding must be ${PACKED_EMBEDDING_BYTES} bytes; got ${entry.vector.length}`,
                undefined,
                { length: entry.vector.length }
            );
        }

        const upsertTx = this.#db.transaction((): boolean => {
            // Delete-tombstone guard (#134): an entry with no version, or one older than the most
            // recent live delete of this key, is refused before it ever touches memory_vectors.
            const tombstone = this.#db
                .query<TombstoneRow, [string, string]>(
                    'SELECT source_updated_at FROM vector_delete_tombstones WHERE pk = ? AND sk = ?'
                )
                .get(entry.pk, entry.sk);
            if(tombstone !== null && (entry.sourceUpdatedAt === undefined || entry.sourceUpdatedAt === null || entry.sourceUpdatedAt < tombstone.source_updated_at)) {
                return false;
            }

            // Step 1: upsert metadata row; ON CONFLICT updates all fields (ttl included, so a
            // re-put without a TTL clears it, as DynamoDB PutItem does) and preserves rowid —
            // unless the stored row reflects a newer source version, when nothing changes.
            const written = this.#db.run(
                `INSERT INTO memory_vectors (pk, sk, layer, content_hash, updated_at, ttl, source_updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(pk, sk) DO UPDATE SET
                     layer             = excluded.layer,
                     content_hash      = excluded.content_hash,
                     updated_at        = excluded.updated_at,
                     ttl               = excluded.ttl,
                     source_updated_at = excluded.source_updated_at
                 WHERE memory_vectors.source_updated_at IS NULL
                    OR excluded.source_updated_at >= memory_vectors.source_updated_at`,
                [entry.pk, entry.sk, entry.layer, entry.contentHash, entry.updatedAt, entry.ttl, entry.sourceUpdatedAt ?? null]
            ).changes;
            if(written === 0) {
                return false;
            }

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
            return true;
        });

        return upsertTx.immediate();
    }

    /**
     * Deletes the vector entry for (pk, sk).
     * Removes from both `memory_vectors` and `vec_memory` in a single IMMEDIATE transaction.
     * No-op if the entry does not exist.
     *
     * With `expected`, the row is deleted only if it is still that generation (same content hash,
     * updated_at, ttl and source_updated_at): the orphan-prune tool uses this so a vector
     * re-indexed or re-stamped after its snapshot survives.
     *
     * @returns true when a row was deleted.
     */
    delete(pk: string, sk: string, expected?: Omit<VectorRowSnapshot, 'pk' | 'sk'>): boolean {
        this.#assertOpen();

        const deleteTx = this.#db.transaction((): boolean => {
            // Look up rowid (and generation) before deleting from metadata table
            const row = this.#db
                .query<GenerationRow, [string, string]>(
                    'SELECT rowid, content_hash, updated_at, ttl, source_updated_at FROM memory_vectors WHERE pk = ? AND sk = ?'
                )
                .get(pk, sk);

            // Stryker disable next-line llm: SQLite returns null for a miss and GenerationRow is an object, so a falsiness check has identical results.
            if(row === null) {
                return false; // No-op: entry does not exist
            }
            if(expected !== undefined && !isSameGeneration(row, expected)) {
                return false; // Rewritten since the caller's snapshot: keep it
            }

            // Delete from metadata first, then from embedding index using the rowid we looked up above
            this.#db.run('DELETE FROM memory_vectors WHERE rowid = ?', [row.rowid]);
            this.#db.run('DELETE FROM vec_memory WHERE rowid = ?', [row.rowid]);
            return true;
        });

        return deleteTx.immediate();
    }

    /**
     * Live-delete path for the AsyncIndexer (#134): deletes (pk, sk) from both tables — but, unlike
     * {@link delete}, only when no row exists or the stored row's source version is no newer than
     * `sourceUpdatedAt` — and always records/advances a tombstone for (pk, sk) at `sourceUpdatedAt`
     * (or the tombstone's own prior value if that is newer), in the same IMMEDIATE transaction.
     *
     * The version guard matters because delete jobs and upsert jobs for the same path are not
     * always processed in real-time order: if this memory was legitimately recreated with a newer
     * source version before this (older) delete job reaches the front of the queue, deleting the
     * newer row would destroy live data. The tombstone is still recorded in that case (advanced,
     * never regressed) so a backfill page read before this delete's own version keeps being
     * refused by {@link upsert} even though the row itself was not touched.
     *
     * @returns true when a row was actually deleted; false when there was none, or the stored row
     *   was kept because it is strictly newer than `sourceUpdatedAt`.
     */
    deleteAndTombstone(pk: string, sk: string, sourceUpdatedAt: number): boolean {
        this.#assertOpen();
        const now = this.#now();

        const tx = this.#db.transaction((): boolean => {
            const row = this.#db
                .query<RowIdAndVersionRow, [string, string]>(
                    'SELECT rowid, source_updated_at FROM memory_vectors WHERE pk = ? AND sk = ?'
                )
                .get(pk, sk);

            let deleted = false;
            // Stryker disable next-line llm: SQLite returns null for a miss and RowIdAndVersionRow is an object, so a falsiness check has identical results.
            if(row !== null && (row.source_updated_at === null || row.source_updated_at <= sourceUpdatedAt)) {
                this.#db.run('DELETE FROM memory_vectors WHERE rowid = ?', [row.rowid]);
                this.#db.run('DELETE FROM vec_memory WHERE rowid = ?', [row.rowid]);
                deleted = true;
            }

            this.#db.run(
                `INSERT INTO vector_delete_tombstones (pk, sk, source_updated_at, created_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(pk, sk) DO UPDATE SET
                     source_updated_at = MAX(source_updated_at, excluded.source_updated_at),
                     created_at        = excluded.created_at`,
                [pk, sk, sourceUpdatedAt, now]
            );

            return deleted;
        });

        return tx.immediate();
    }

    /**
     * Deletes every row whose TTL has passed (`ttl <= now`, epoch seconds) from both tables.
     * Each batch selects and deletes inside one IMMEDIATE transaction, so a TTL refreshed by
     * another connection before the batch takes the write lock is honoured, and each lock hold
     * stays short. Zero DynamoDB reads: DynamoDB applies the same TTL to the memory itself.
     *
     * @returns the number of rows deleted.
     */
    pruneExpired(batchSize: number = PRUNE_EXPIRED_BATCH_SIZE): number {
        this.#assertOpen();
        const nowSeconds = Math.floor(this.#now() / 1000);
        let total = 0;
        for(;;) {
            const deleted = this.#pruneExpiredBatch(nowSeconds, batchSize);
            total += deleted;
            if(deleted < batchSize) {
                return total;
            }
        }
    }

    #pruneExpiredBatch(nowSeconds: number, batchSize: number): number {
        const batchTx = this.#db.transaction((): number => {
            const rowIds = this.#db
                .query<RowIdRow, [number, number]>(
                    'SELECT rowid FROM memory_vectors WHERE ttl IS NOT NULL AND ttl <= ? ORDER BY rowid LIMIT ?'
                )
                .all(nowSeconds, batchSize)
                .map(row => row.rowid);
            const ids = JSON.stringify(rowIds);
            // vec0's DELETE `changes` over-reports, so the count comes from memory_vectors only.
            this.#db.run('DELETE FROM vec_memory WHERE rowid IN (SELECT value FROM json_each(?))', [ids]);
            return this.#db.run('DELETE FROM memory_vectors WHERE rowid IN (SELECT value FROM json_each(?))', [ids]).changes;
        });
        return batchTx.immediate();
    }

    /**
     * Deletes every delete-tombstone (#134) older than {@link DELETE_TOMBSTONE_TTL_MS}. Each batch
     * selects and deletes inside one IMMEDIATE transaction, mirroring {@link pruneExpired}.
     * Zero DynamoDB reads: the tombstone's own `created_at` is authoritative.
     *
     * @returns the number of tombstones deleted.
     */
    pruneExpiredTombstones(batchSize: number = PRUNE_TOMBSTONE_BATCH_SIZE): number {
        this.#assertOpen();
        const cutoffMs = this.#now() - DELETE_TOMBSTONE_TTL_MS;
        let total = 0;
        for(;;) {
            const deleted = this.#pruneExpiredTombstonesBatch(cutoffMs, batchSize);
            total += deleted;
            if(deleted < batchSize) {
                return total;
            }
        }
    }

    #pruneExpiredTombstonesBatch(cutoffMs: number, batchSize: number): number {
        const batchTx = this.#db.transaction((): number => {
            const rowIds = this.#db
                .query<RowIdRow, [number, number]>(
                    'SELECT rowid FROM vector_delete_tombstones WHERE created_at <= ? ORDER BY rowid LIMIT ?'
                )
                .all(cutoffMs, batchSize)
                .map(row => row.rowid);
            const ids = JSON.stringify(rowIds);
            return this.#db.run('DELETE FROM vector_delete_tombstones WHERE rowid IN (SELECT value FROM json_each(?))', [ids]).changes;
        });
        return batchTx.immediate();
    }

    /**
     * Sets the TTL of existing rows in one IMMEDIATE transaction. Missing keys are ignored.
     *
     * Source-version guard, as for {@link upsert}: an entry applies only to a row with no source
     * version or one no newer than the entry's, so a TTL read before a live refresh is ignored.
     * An applied entry records its source version; one whose TTL already matches only advances
     * the row's version (never moving it back).
     *
     * @returns the number of rows whose TTL actually changed (a row already at that TTL counts 0).
     */
    setTtls(entries: readonly VectorTtlUpdate[]): number {
        this.#assertOpen();
        const setTx = this.#db.transaction((): number => {
            const setTtl = this.#db.prepare<unknown, [number | null, number | null, string, string]>(
                `UPDATE memory_vectors SET ttl = ?1, source_updated_at = ?2
                 WHERE pk = ?3 AND sk = ?4 AND ttl IS NOT ?1
                   AND (source_updated_at IS NULL OR ?2 >= source_updated_at)`
            );
            const advanceVersion = this.#db.prepare<unknown, [number | null, string, string]>(
                `UPDATE memory_vectors SET source_updated_at = ?1
                 WHERE pk = ?2 AND sk = ?3 AND (source_updated_at IS NULL OR ?1 > source_updated_at)`
            );
            let changed = 0;
            for(const entry of entries) {
                const sourceUpdatedAt = entry.sourceUpdatedAt ?? null;
                changed += setTtl.run(entry.ttl, sourceUpdatedAt, entry.pk, entry.sk).changes;
                advanceVersion.run(sourceUpdatedAt, entry.pk, entry.sk);
            }
            return changed;
        });
        return setTx.immediate();
    }

    /**
     * Lists every row whose memory path is under `prefix` (which must start and end with `/`, and
     * is not the root), ordered by rowid. Matches the directory itself (`DIR#/a/b` for `/a/b/`)
     * and anything nested below it; a sibling such as `/a/bx/` is not matched. Uses substr
     * rather than LIKE, whose `_` wildcard would match any character in a path.
     *
     * @throws {VectorIndexError} For a prefix that is not a non-root `/…/` directory.
     */
    listRowsByPathPrefix(prefix: string): VectorRowSnapshot[] {
        this.#assertOpen();
        if(!prefix.startsWith('/') || !prefix.endsWith('/') || prefix === '/') {
            throw new VectorIndexError(`Path prefix must start and end with '/' and not be the root; got '${prefix}'`);
        }
        const directoryPk = `DIR#${prefix.slice(0, -1)}`;
        const nestedPkPrefix = `DIR#${prefix}`;
        return this.#db
            .query<SnapshotRow, [string, string]>(
                `SELECT pk, sk, content_hash, updated_at, ttl, source_updated_at FROM memory_vectors
                 WHERE pk = ?1 OR substr(pk, 1, length(?2)) = ?2
                 ORDER BY rowid`
            )
            .all(directoryPk, nestedPkPrefix)
            .map(row => ({
                pk:              row.pk,
                sk:              row.sk,
                contentHash:     row.content_hash,
                updatedAt:       row.updated_at,
                ttl:             row.ttl,
                sourceUpdatedAt: row.source_updated_at,
            }));
    }

    /**
     * Runs a KNN query against the vec0 virtual table using sqlite-vec Hamming distance.
     *
     * sqlite-vec returns rows in distance order ascending (smallest distance = most similar).
     * The requested result limit is distinct from vec0's candidate k: post-filtered
     * TTL/layer rows and malformed paths trigger bounded KNN overfetch. Beyond vec0's
     * k ceiling, an exact local scan considers the remaining indexed rows.
     *
     * vec_bit() converts the raw Uint8Array query vector into the bit vector format
     * that sqlite-vec's MATCH operator expects.
     *
     * @param queryVector - 128-byte packed binary query vector
     * @param limit - Maximum number of eligible results (candidate k may grow beyond this)
     * @param layer - Optional layer filter (identity, state, events, etc.)
     * @returns Results sorted by Hamming distance ascending (most similar first)
     * @throws {VectorIndexError} If the query vector is not exactly 128 bytes.
     */
    query(queryVector: PackedBinaryEmbedding1024, limit: number, layer?: IndexLayer): VectorQueryResult[] {
        this.#assertOpen();
        if(queryVector.length !== PACKED_EMBEDDING_BYTES) {
            throw new VectorIndexError(
                `Embedding must be ${PACKED_EMBEDDING_BYTES} bytes; got ${queryVector.length}`,
                undefined,
                { length: queryVector.length }
            );
        }

        // Rows past their TTL are hidden until the next pruneExpired() removes them.
        const nowSeconds = Math.floor(this.#now() / 1000);
        const knn = (k: number): KnnRow[] => (layer === undefined
            ? this.#db
                .query<KnnRow, [Uint8Array, number, number]>(
                    `SELECT m.pk, m.sk, m.layer, v.distance
                     FROM vec_memory v
                     JOIN memory_vectors m ON m.rowid = v.rowid
                     WHERE v.embedding MATCH vec_bit(?) AND k = ?
                       AND (m.ttl IS NULL OR m.ttl > ?)
                     ORDER BY v.distance`
                )
                .all(queryVector, k, nowSeconds)
            : this.#db
                .query<KnnRow, [Uint8Array, number, number, string]>(
                    `SELECT m.pk, m.sk, m.layer, v.distance
                     FROM vec_memory v
                     JOIN memory_vectors m ON m.rowid = v.rowid
                     WHERE v.embedding MATCH vec_bit(?) AND k = ?
                       AND (m.ttl IS NULL OR m.ttl > ?)
                       AND m.layer = ?
                     ORDER BY v.distance`
                )
                .all(queryVector, k, nowSeconds, layer));
        const warned = new Set<string>();
        const eligible = (rows: KnnRow[]): VectorQueryResult[] => {
            const valid: VectorQueryResult[] = [];
            for(const row of rows) {
                try {
                    const path = createMemoryPath(MemoryToolKeyGenerator.parsePath(row.pk, row.sk));
                    valid.push({ path, layer: classifyMemoryPath(path).namespace, distance: row.distance });
                    if(valid.length === limit) {
                        break;
                    }
                } catch (error) {
                    const key = JSON.stringify([row.pk, row.sk]);
                    if(!warned.has(key)) {
                        logger.warn({ error, pk: row.pk, sk: row.sk, msg: 'Skipping malformed legacy vector-index row' });
                        warned.add(key);
                    }
                }
            }
            return valid;
        };

        let k = Math.min(limit, this.#knnMaxK);
        let valid = eligible(knn(k));
        if(valid.length === limit) {
            return valid;
        }
        // Count vec0 itself: counting only the filtered join would falsely signal exhaustion.
        const total = this.#db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM vec_memory').get()!.n;
        while(k < total && k < this.#knnMaxK) {
            k = Math.min(total, this.#knnMaxK, k * 2);
            valid = eligible(knn(k));
            if(valid.length === limit) {
                return valid;
            }
        }
        if(k >= total) {
            return valid;
        }
        // sqlite-vec 0.1.x rejects k > 4096. Scan the small local index exactly,
        // retaining SQL TTL/layer predicates and checking legacy paths before slicing.
        const rows = layer === undefined
            ? this.#db.query<KnnRow, [Uint8Array, number]>(
                `SELECT m.pk, m.sk, m.layer, vec_distance_hamming(v.embedding, vec_bit(?)) AS distance
                 FROM vec_memory v JOIN memory_vectors m ON m.rowid = v.rowid
                 WHERE m.ttl IS NULL OR m.ttl > ? ORDER BY distance`
            ).all(queryVector, nowSeconds)
            : this.#db.query<KnnRow, [Uint8Array, number, string]>(
                `SELECT m.pk, m.sk, m.layer, vec_distance_hamming(v.embedding, vec_bit(?)) AS distance
                 FROM vec_memory v JOIN memory_vectors m ON m.rowid = v.rowid
                 WHERE (m.ttl IS NULL OR m.ttl > ?) AND m.layer = ? ORDER BY distance`
            ).all(queryVector, nowSeconds, layer);
        return eligible(rows);
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
