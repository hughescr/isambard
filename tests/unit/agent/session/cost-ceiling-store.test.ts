/**
 * Tests for the Q3/B4 cost-ceiling persistence adapter over the existing session journal port —
 * see src/agent/session/cost-ceiling-store.ts.
 */
import { describe, test, expect } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { createCostCeilingStore } from '@/agent/session/cost-ceiling-store';
import type { JournalEntry } from '@/agent/session/types';

const T0 = Date.parse('2026-09-05T12:00:00.000Z');

describe('createCostCeilingStore — save', () => {
    test('appends a cost_ceiling_snapshot entry through the journal, stamped with the current clock time', () => {
        const journal = new FakeJournal();
        const clock = new FakeClock(T0);
        const store = createCostCeilingStore({ journal, clock });

        store.save({ dateKey: '2026-09-05', totalUsd: 1.5, paused: true });

        expect(journal.byKind('cost_ceiling_snapshot')).toEqual([
            { type: 'cost_ceiling_snapshot', at: new Date(T0), dateKey: '2026-09-05', totalUsd: 1.5, paused: true },
        ]);
    });

    test('a later save() appends a second entry rather than replacing the first (readSince picks the latest)', () => {
        const journal = new FakeJournal();
        const clock = new FakeClock(T0);
        const store = createCostCeilingStore({ journal, clock });

        store.save({ dateKey: '2026-09-05', totalUsd: 1, paused: false });
        store.save({ dateKey: '2026-09-05', totalUsd: 2, paused: false });

        expect(journal.byKind('cost_ceiling_snapshot')).toHaveLength(2);
    });
});

describe('createCostCeilingStore — load', () => {
    test('returns undefined when the journal has never recorded a snapshot', async () => {
        const journal = new FakeJournal();
        const clock = new FakeClock(T0);
        const store = createCostCeilingStore({ journal, clock });
        journal.scriptReadSince([]);

        await expect(store.load()).resolves.toBeUndefined();
    });

    test('returns the latest cost_ceiling_snapshot entry, ignoring other journal entry kinds', async () => {
        const journal = new FakeJournal();
        const clock = new FakeClock(T0);
        const store = createCostCeilingStore({ journal, clock });
        const unrelated: JournalEntry = { type: 'shutdown', at: new Date(T0 - 3000) };
        // Three snapshots (not two): an `at(-1)`->`at(1)` UnaryOperator mutant would still pick
        // the correct entry out of a 2-element list (indices -1 and 1 coincide there), so this
        // needs at least 3 to distinguish "last" from "second".
        const oldest: JournalEntry = { type: 'cost_ceiling_snapshot', at: new Date(T0 - 3000), dateKey: '2026-09-03', totalUsd: 9, paused: true };
        const middle: JournalEntry = { type: 'cost_ceiling_snapshot', at: new Date(T0 - 2000), dateKey: '2026-09-04', totalUsd: 5, paused: true };
        const latest: JournalEntry = { type: 'cost_ceiling_snapshot', at: new Date(T0 - 1000), dateKey: '2026-09-05', totalUsd: 0.5, paused: false };
        journal.scriptReadSince([unrelated, oldest, middle, latest]);

        await expect(store.load()).resolves.toEqual({ dateKey: '2026-09-05', totalUsd: 0.5, paused: false });
    });

    test('reads a bounded lookback window ending at the current clock time, not the whole journal', async () => {
        const journal = new FakeJournal();
        const clock = new FakeClock(T0);
        const store = createCostCeilingStore({ journal, clock });
        let sinceMsSeen: number | undefined;
        journal.readSince = (sinceMs: number) => {
            sinceMsSeen = sinceMs;
            return Promise.resolve([]);
        };

        await store.load();

        // Exact value, not a loose range: restore() discards any snapshot whose dateKey isn't the
        // current local day on the very next isPaused()/snapshot() call, so nothing older than
        // ~48h can ever survive restore — an under-shrunk lookback (e.g. an ArithmeticOperator
        // mutant turning `2 * 24 * 60 * 60 * 1000` into `2 * 24 / 60 * 60 * 1000` = 172,800 -> 2,880
        // ms) would silently make load() find nothing at boot.
        expect(sinceMsSeen).toBe(T0 - 2 * 24 * 60 * 60 * 1000);
    });
});
