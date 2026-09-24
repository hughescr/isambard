/**
 * Tests for connection.ts — busy_timeout + WAL on every vector-index connection (#129).
 */
import { Database } from 'bun:sqlite';
import { describe, expect, it, mock } from 'bun:test';
import { configureVectorDbConnection, VECTOR_DB_BUSY_TIMEOUT_MS } from '@/storage/memory-vec-store/connection';

const FALLBACK_MSG = 'Vector index could not switch to WAL; continuing in rollback-journal mode';

/** A spy Database that records statements and answers `PRAGMA journal_mode = WAL` with `journal`. */
function spyDb(journal: () => { journal_mode: string } | null) {
    const calls: string[] = [];
    const db = {
        run:   mock((sql: string) => { calls.push(`run:${sql}`); }),
        query: mock((sql: string) => ({
            get: () => {
                calls.push(`query:${sql}`);
                return journal();
            },
        })),
    } as unknown as Database;
    return { db, calls };
}

describe('configureVectorDbConnection', () => {
    it('waits up to five seconds for a competing lock', () => {
        expect(VECTOR_DB_BUSY_TIMEOUT_MS).toBe(5000);
    });

    it('sets busy_timeout before switching the journal mode to WAL', () => {
        const { db, calls } = spyDb(() => ({ journal_mode: 'wal' }));
        const warn = mock((_obj: Record<string, unknown>) => {});
        configureVectorDbConnection(db, { warn });
        expect(calls).toEqual(['run:PRAGMA busy_timeout = 5000', 'query:PRAGMA journal_mode = WAL']);
        expect(warn).not.toHaveBeenCalled();
    });

    it('reads busy_timeout back as 5000 on a real connection, and accepts the in-memory journal mode silently', () => {
        const db = new Database(':memory:');
        const warn = mock((_obj: Record<string, unknown>) => {});
        try {
            configureVectorDbConnection(db, { warn });
            expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
            expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'memory' });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            db.close();
        }
    });

    it.each([
        ['delete', { journal_mode: 'delete' }, 'delete'],
        ['an upper-case WAL', { journal_mode: 'WAL' }, 'WAL'],
        ['no row', null, undefined],
    ])('warns once and continues when the switch reports %s', (_label, row, reported) => {
        const { db } = spyDb(() => row);
        const warn = mock((_obj: Record<string, unknown>) => {});
        expect(() => configureVectorDbConnection(db, { warn })).not.toThrow();
        expect(warn.mock.calls).toEqual([[{ journalMode: reported, msg: FALLBACK_MSG }]]);
    });

    it('warns once and continues when switching to WAL throws SQLITE_BUSY', () => {
        const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        const { db } = spyDb(() => {
            throw busy;
        });
        const warn = mock((_obj: Record<string, unknown>) => {});
        expect(() => configureVectorDbConnection(db, { warn })).not.toThrow();
        expect(warn.mock.calls).toEqual([[{ error: busy, msg: FALLBACK_MSG }]]);
    });
});
