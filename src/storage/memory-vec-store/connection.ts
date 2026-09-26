/**
 * Per-connection pragmas for the vector-index SQLite file (#129).
 *
 * Izzy keeps the file open while an operator tool (the backfill) writes to it, so
 * every connection sets:
 * - `busy_timeout` FIRST, so a competing writer waits (synchronously, up to the timeout) instead of
 *   failing at once with SQLITE_BUSY — and so the journal-mode switch below can itself wait;
 * - `journal_mode = WAL`, so readers never block on a writer and a writer never blocks readers.
 *
 * WAL persists in the file header once set. An in-memory database reports `memory` and cannot use
 * WAL; that is expected. Any other outcome (or an error, e.g. SQLITE_BUSY while switching) is logged
 * and the open continues in rollback mode with busy_timeout still set: the index is derived data,
 * so degraded concurrency is not worth refusing to start.
 */
import type { Database } from 'bun:sqlite';

/** How long a connection waits for another connection's lock before SQLITE_BUSY. */
export const VECTOR_DB_BUSY_TIMEOUT_MS = 5000;

/** Journal modes accepted without a warning: WAL for files, `memory` for `:memory:` databases. */
const ACCEPTED_JOURNAL_MODES: ReadonlySet<string | undefined> = new Set(['wal', 'memory']);

interface VectorDbConnectionLogger {
    warn: (obj: Record<string, unknown>) => void
}

/**
 * Sets busy_timeout, then WAL journaling, on a freshly opened vector-index connection.
 * Never throws for a journal-mode problem; throws only if busy_timeout itself cannot be set.
 */
export function configureVectorDbConnection(db: Database, logger: VectorDbConnectionLogger): void {
    db.run(`PRAGMA busy_timeout = ${VECTOR_DB_BUSY_TIMEOUT_MS}`);
    try {
        const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL').get()?.journal_mode;
        if(!ACCEPTED_JOURNAL_MODES.has(mode)) {
            logger.warn({ journalMode: mode, msg: 'Vector index could not switch to WAL; continuing in rollback-journal mode' });
        }
    } catch (error) {
        logger.warn({ error, msg: 'Vector index could not switch to WAL; continuing in rollback-journal mode' });
    }
}
