/**
 * Port interfaces the long-lived session conductor writes through: a write-ahead journal and a
 * role-keyed store for the resumable session id. This module declares the interfaces only — P8
 * implements them against DynamoDB (src/storage/session-journal/**, src/agent/session/journal.ts,
 * src/agent/session/resume-store.ts). `JournalEntry` itself is owned by ./types (plan amendment
 * A1); this file imports it rather than redeclaring any member.
 *
 * @module agent/session/ports
 */
import type { JournalEntry, SessionRole } from './types';

/**
 * Append-only write-ahead journal for session lifecycle facts. `append` is fire-and-forget from
 * the caller's perspective — it returns synchronously and never throws — while a real
 * implementation buffers and writes through underneath; `flush` is the barrier a caller awaits to
 * know every append issued so far has settled (the conductor calls it last in its shutdown
 * sequence, before closing the query).
 */
export interface SessionJournal {
    append: (entry: JournalEntry) => void
    flush:  () => Promise<void>
}

/** Role-keyed store for the one resumable session id per {@link SessionRole}. */
export interface ResumeStore {
    load: (role: SessionRole) => Promise<string | undefined>
    save: (role: SessionRole, sessionId: string) => Promise<void>
}
