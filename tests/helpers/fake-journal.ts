/**
 * In-memory double for the {@link SessionJournal} port (src/agent/session/ports.ts): `append()`
 * records synchronously (the real port's `append` is fire-and-forget, returning `void`),
 * `entries()`/`byKind()` read back what was recorded, `flushCount` counts calls to `flush()`, and
 * `scriptFlushRejection()`/`scriptReadSince()`/`scriptReadSinceRejection()` script
 * `flush()`/`readSince()`'s outcome.
 *
 * @module tests/helpers/fake-journal
 */
import type { SessionJournal } from '@/agent/session/ports';
import type { JournalEntry } from '@/agent/session/types';

/** Scriptable double of the session's write-ahead journal port. */
export class FakeJournal implements SessionJournal {
    private readonly recorded:          JournalEntry[] = [];
    private scriptedReadSince:          JournalEntry[] = [];
    private scriptedReadSinceRejection: Error | undefined;
    private scriptedFlushRejection:     Error | undefined;

    /** Number of times {@link flush} has been called (whether it resolved or rejected). */
    flushCount = 0;

    /** Record `entry`. Synchronous, like the real port's `append` — never throws. */
    append(entry: JournalEntry): void {
        this.recorded.push(entry);
    }

    /** Barrier over in-flight appends. This fake has none, so it resolves immediately — unless {@link scriptFlushRejection} scripted a rejection. */
    flush(): Promise<void> {
        this.flushCount += 1;
        if(this.scriptedFlushRejection !== undefined) {
            return Promise.reject(this.scriptedFlushRejection);
        }
        return Promise.resolve();
    }

    /** Make every subsequent {@link flush} call reject with `error`, until cleared with `undefined`. */
    scriptFlushRejection(error: Error | undefined): void {
        this.scriptedFlushRejection = error;
    }

    /** Every entry appended so far, in append order. */
    entries(): JournalEntry[] {
        return [...this.recorded];
    }

    /** Entries appended so far whose discriminant `type` equals `kind`. */
    byKind<K extends JournalEntry['type']>(kind: K): Extract<JournalEntry, { type: K }>[] {
        return this.recorded.filter((recordedEntry): recordedEntry is Extract<JournalEntry, { type: K }> => recordedEntry.type === kind);
    }

    /** Script what the next `readSince()` calls resolve with. */
    scriptReadSince(entries: JournalEntry[]): void {
        this.scriptedReadSince = entries;
    }

    /** Make every subsequent {@link readSince} call reject with `error`, until cleared with `undefined`. */
    scriptReadSinceRejection(error: Error | undefined): void {
        this.scriptedReadSinceRejection = error;
    }

    /** Resolves with whatever {@link scriptReadSince} last set (`[]` if never scripted), or rejects with whatever {@link scriptReadSinceRejection} last set. */
    readSince(_sinceMs: number): Promise<JournalEntry[]> {
        if(this.scriptedReadSinceRejection !== undefined) {
            return Promise.reject(this.scriptedReadSinceRejection);
        }
        return Promise.resolve(this.scriptedReadSince);
    }
}
