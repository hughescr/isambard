/**
 * In-memory double for the session write-ahead journal: `append()` records, `entries()`/
 * `byKind()` read back what was recorded, and `scriptReadSince()` scripts what `readSince()`
 * resolves with (mirroring the real journal port P7 declares in src/agent/session/ports.ts).
 *
 * @module tests/helpers/fake-journal
 */
import type { JournalEntry } from '@/agent/session/types';

/** Scriptable double of the session's write-ahead journal port. */
export class FakeJournal {
    private readonly recorded: JournalEntry[] = [];
    private scriptedReadSince: JournalEntry[] = [];

    /** Record `entry`. Write-through, like the real journal: resolves once recorded. */
    append(entry: JournalEntry): Promise<void> {
        this.recorded.push(entry);
        return Promise.resolve();
    }

    /** Barrier over in-flight appends. This fake has none, so it resolves immediately. */
    flush(): Promise<void> {
        return Promise.resolve();
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

    /** Resolves with whatever {@link scriptReadSince} last set (`[]` if never scripted). */
    readSince(_sinceMs: number): Promise<JournalEntry[]> {
        return Promise.resolve(this.scriptedReadSince);
    }
}
