import { describe, expect, it } from 'bun:test';
import { FakeJournal } from '../../helpers/fake-journal';
import type { JournalEntry } from '@/agent/session/types';

function envelopeSubmitted(at: Date) {
    return { type: 'envelope_submitted' as const, at, envelopeId: 'e1', kind: 'discord' as const };
}

function sessionOpened(at: Date, overrides: Partial<Extract<JournalEntry, { type: 'session_opened' }>> = {}): Extract<JournalEntry, { type: 'session_opened' }> {
    return { type: 'session_opened', at, role: 'conversation', sessionId: 'sess-1', resumed: false, ...overrides };
}

describe('FakeJournal', () => {
    it('append() records synchronously — entries() sees it with no await', () => {
        const journal = new FakeJournal();
        const first = envelopeSubmitted(new Date(1000));

        journal.append(first);

        expect(journal.entries()).toEqual([first]);
    });

    it('records every appended entry, returned by entries() in append order', () => {
        const journal = new FakeJournal();
        const first = envelopeSubmitted(new Date(1000));
        const second = sessionOpened(new Date(2000));

        journal.append(first);
        journal.append(second);

        expect(journal.entries()).toEqual([first, second]);
    });

    it('byKind filters entries down to the given discriminant', () => {
        const journal = new FakeJournal();
        const submitted = envelopeSubmitted(new Date(1000));
        const opened = sessionOpened(new Date(2000));
        const completed: JournalEntry = { type: 'turn_completed', at: new Date(3000), envelopeId: 'e1', kind: 'discord' };

        journal.append(submitted);
        journal.append(opened);
        journal.append(completed);

        expect(journal.byKind('envelope_submitted')).toEqual([submitted]);
        expect(journal.byKind('session_opened')).toEqual([opened]);
        expect(journal.byKind('compaction_started')).toEqual([]);
    });

    it('scriptReadSince() makes readSince() resolve with exactly the scripted entries', async () => {
        const journal = new FakeJournal();
        const scripted: JournalEntry[] = [sessionOpened(new Date(500), { sessionId: 'sess-0' })];
        journal.scriptReadSince(scripted);

        await expect(journal.readSince(0)).resolves.toEqual(scripted);
    });

    it('readSince() defaults to an empty list when nothing was scripted', async () => {
        const journal = new FakeJournal();

        await expect(journal.readSince(0)).resolves.toEqual([]);
    });

    it('scriptReadSinceRejection() makes the next readSince() reject', async () => {
        const journal = new FakeJournal();
        const failure = new Error('DynamoDB throttled');
        journal.scriptReadSinceRejection(failure);

        await expect(journal.readSince(0)).rejects.toBe(failure);
    });

    it('scriptReadSinceRejection(undefined) clears a scripted rejection so readSince() resolves again', async () => {
        const journal = new FakeJournal();
        journal.scriptReadSinceRejection(new Error('down'));
        journal.scriptReadSinceRejection(undefined);
        const scripted: JournalEntry[] = [sessionOpened(new Date(500), { sessionId: 'sess-0' })];
        journal.scriptReadSince(scripted);

        await expect(journal.readSince(0)).resolves.toEqual(scripted);
    });

    it('flush() resolves and counts the call in flushCount', async () => {
        const journal = new FakeJournal();

        await expect(journal.flush()).resolves.toBeUndefined();

        expect(journal.flushCount).toBe(1);
    });

    it('flushCount accumulates across multiple flush() calls', async () => {
        const journal = new FakeJournal();

        await journal.flush();
        await journal.flush();
        await journal.flush();

        expect(journal.flushCount).toBe(3);
    });

    it('scriptFlushRejection() makes the next flush() reject, but still counts it', async () => {
        const journal = new FakeJournal();
        const failure = new Error('journal store unavailable');
        journal.scriptFlushRejection(failure);

        await expect(journal.flush()).rejects.toBe(failure);

        expect(journal.flushCount).toBe(1);
    });

    it('scriptFlushRejection() persists across calls until cleared', async () => {
        const journal = new FakeJournal();
        const failure = new Error('still down');
        journal.scriptFlushRejection(failure);

        await expect(journal.flush()).rejects.toBe(failure);
        await expect(journal.flush()).rejects.toBe(failure);

        expect(journal.flushCount).toBe(2);
    });

    it('scriptFlushRejection(undefined) clears a scripted rejection so flush() resolves again', async () => {
        const journal = new FakeJournal();
        journal.scriptFlushRejection(new Error('down'));
        journal.scriptFlushRejection(undefined);

        await expect(journal.flush()).resolves.toBeUndefined();
    });
});
