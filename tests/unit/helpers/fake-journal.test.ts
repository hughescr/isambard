import { describe, expect, it } from 'bun:test';
import { FakeJournal } from '../../helpers/fake-journal';
import type { JournalEntry } from '@/agent/session/types';

function envelopeSubmitted(at: Date) {
    return { type: 'envelope_submitted' as const, at, envelopeId: 'e1', kind: 'discord' as const };
}

describe('FakeJournal', () => {
    it('records every appended entry, returned by entries() in append order', async () => {
        const journal = new FakeJournal();
        const first = envelopeSubmitted(new Date(1000));
        const second: JournalEntry = { type: 'session_opened', at: new Date(2000), sessionId: 'sess-1' };

        await journal.append(first);
        await journal.append(second);

        expect(journal.entries()).toEqual([first, second]);
    });

    it('byKind filters entries down to the given discriminant', async () => {
        const journal = new FakeJournal();
        const submitted = envelopeSubmitted(new Date(1000));
        const opened: JournalEntry = { type: 'session_opened', at: new Date(2000), sessionId: 'sess-1' };
        const completed: JournalEntry = { type: 'turn_completed', at: new Date(3000), envelopeId: 'e1', kind: 'discord' };

        await journal.append(submitted);
        await journal.append(opened);
        await journal.append(completed);

        expect(journal.byKind('envelope_submitted')).toEqual([submitted]);
        expect(journal.byKind('session_opened')).toEqual([opened]);
        expect(journal.byKind('compaction_started')).toEqual([]);
    });

    it('scriptReadSince() makes readSince() resolve with exactly the scripted entries', async () => {
        const journal = new FakeJournal();
        const scripted: JournalEntry[] = [
            { type: 'session_opened', at: new Date(500), sessionId: 'sess-0' },
        ];
        journal.scriptReadSince(scripted);

        await expect(journal.readSince(0)).resolves.toEqual(scripted);
    });

    it('readSince() defaults to an empty list when nothing was scripted', async () => {
        const journal = new FakeJournal();

        await expect(journal.readSince(0)).resolves.toEqual([]);
    });

    it('flush() resolves', async () => {
        const journal = new FakeJournal();

        await expect(journal.flush()).resolves.toBeUndefined();
    });
});
