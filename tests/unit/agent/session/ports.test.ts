import { describe, expect, it } from 'bun:test';
import { FakeJournal } from '../../../helpers/fake-journal';
import { FakeResumeStore } from '../../../helpers/fake-resume-store';
import type { ResumeStore, SessionJournal } from '@/agent/session/ports';
import type { JournalEntry } from '@/agent/session/types';

// Compile-time-only assertions live in this file; each `describe`/`it` below carries exactly
// one runtime `expect` so `jest/expect-expect` is satisfied without pretending these are
// behavioural tests (that coverage lives in fake-journal.test.ts / fake-resume-store.test.ts).

describe('SessionJournal', () => {
    it('is satisfiable by FakeJournal with no `as` casts', () => {
        const journal: SessionJournal = new FakeJournal();

        expect(journal).toBeInstanceOf(FakeJournal);
    });

    it('declares readSince(sinceMs) -> Promise<JournalEntry[]> for P8 recovery (gap a)', () => {
        const journal: SessionJournal = new FakeJournal();
        const readSince: (sinceMs: number) => Promise<JournalEntry[]> = journal.readSince;

        expect(typeof readSince).toBe('function');
    });
});

describe('ResumeStore', () => {
    it('is satisfiable by FakeResumeStore with no `as` casts', () => {
        const store: ResumeStore = new FakeResumeStore();

        expect(store).toBeInstanceOf(FakeResumeStore);
    });
});
