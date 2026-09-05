/**
 * Implements the P7 {@link SessionJournal} port (./ports.ts) over the P8 DynamoDB backend
 * (src/storage/session-journal/backend.ts). `append` is write-through and fire-and-forget from
 * the caller's perspective (mirroring the port's `void` return): it forwards to the backend
 * immediately, tracks the resulting promise so {@link flush} can wait on it, and on a backend
 * rejection logs via the injected logger rather than throwing or buffering for retry — a lost
 * journal write degrades crash recovery (P8 recovery.ts) rather than the live turn, so the
 * conductor must never be blocked or crashed by a journal outage.
 *
 * @module agent/session/journal
 */
import type { Logger } from '@hughescr/logger';
import type { SessionJournal } from './ports';
import type { Clock, JournalEntry, SessionRole } from './types';
import type { SessionJournalBackend } from '@/storage';

/** Dependencies for {@link createSessionJournal}. */
export interface CreateSessionJournalParams {
    /** Narrowed to the two methods this module calls — a fake backend in tests need not extend the real DynamoDB-backed class. */
    backend: Pick<SessionJournalBackend, 'append' | 'readSince'>
    role:    SessionRole
    /** Timestamps the diagnostic log line on a backend rejection; this module never stamps `entry.at` itself (the caller already set it). */
    clock:   Clock
    logger:  Pick<Logger, 'error'>
}

/**
 * Creates a {@link SessionJournal} bound to one role, backed by DynamoDB via `backend`.
 * @param params See {@link CreateSessionJournalParams}.
 */
export function createSessionJournal(params: CreateSessionJournalParams): SessionJournal {
    const { backend, role, clock, logger } = params;
    const inFlight = new Set<Promise<void>>();

    return {
        append(entry: JournalEntry): void {
            const appended: Promise<void> = backend.append(role, entry)
                .catch((error: unknown) => {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
                    logger.error({ error, kind: entry.type, at: clock.now(), msg: 'SessionJournal: failed to write journal entry' });
                })
                .finally(() => {
                    inFlight.delete(appended);
                });
            inFlight.add(appended);
        },

        flush(): Promise<void> {
            return Promise.allSettled(inFlight).then(() => undefined);
        },

        readSince(sinceMs: number): Promise<JournalEntry[]> {
            return backend.readSince(role, new Date(sinceMs).toISOString());
        },
    };
}
