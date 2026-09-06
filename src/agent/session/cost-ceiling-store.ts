/**
 * B4 persistence adapter for {@link import('./cost-ceiling').CostCeiling} over the existing
 * session journal port: `save()` appends a `cost_ceiling_snapshot` {@link
 * import('./types').JournalEntry}; `load()` reads a bounded recent window and returns the latest
 * one, if any, for {@link import('./cost-ceiling').CostCeiling.restore} to rehydrate from at boot.
 *
 * Deliberately role-independent, unlike the P8 role-bound {@link
 * import('./resume-store').createResumeStore}: the cost ceiling tracks spend across both the
 * conversation and perch conductors, so it is not itself scoped to either role's journal — the
 * composition root passes whichever role's already-constructed {@link
 * import('./ports').SessionJournal} it has in hand (its `readSince`/`append` are journaled to
 * that role's own DynamoDB partition, but a snapshot's content carries no role-specific data, so
 * either role's journal instance can hold it).
 *
 * @module agent/session/cost-ceiling-store
 */
import type { CostCeilingPersistence, CostCeilingSnapshot } from './cost-ceiling';
import type { SessionJournal } from './ports';
import type { Clock, JournalEntry } from './types';

/**
 * How far back `load()` looks for the latest snapshot. Deliberately short, NOT "generous enough
 * to survive a long outage": {@link import('./cost-ceiling').CostCeiling.restore} rolls over (and
 * zeroes) any snapshot whose `dateKey` isn't the current local day on the very next
 * `isPaused()`/`snapshot()` call, so a snapshot older than ~48h can never survive `restore()`
 * regardless of how far back `load()` looked for it — a wider window (this used to match
 * `sessionConfigSchema`'s 30-day `transcriptRetentionMs`, then a 7-day compromise) only adds cost
 * for zero behavioural benefit. `SessionJournalBackend.readSince` pages the whole window with no
 * `Limit` (see `conductor.ts`'s own `RECOVERY_WINDOW_MS` doc for why that matters against a
 * free-tier-provisioned table), so this stays a small multiple of the longest possible local day
 * (25h, DST fall-back) rather than a multi-day margin that buys nothing.
 */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/** Dependencies for {@link createCostCeilingStore}. */
export interface CreateCostCeilingStoreParams {
    /** Narrowed to the two methods this module calls — any role's journal instance works (see the module doc). */
    journal: Pick<SessionJournal, 'append' | 'readSince'>
    clock:   Clock
}

/**
 * Creates a {@link CostCeilingPersistence} adapter backed by `journal`.
 * @param params See {@link CreateCostCeilingStoreParams}.
 */
export function createCostCeilingStore(params: CreateCostCeilingStoreParams): CostCeilingPersistence {
    const { journal, clock } = params;

    return {
        save(snapshot: CostCeilingSnapshot): void {
            journal.append({ type: 'cost_ceiling_snapshot', at: new Date(clock.now()), ...snapshot });
        },

        async load(): Promise<CostCeilingSnapshot | undefined> {
            const entries = await journal.readSince(clock.now() - LOOKBACK_MS);
            const snapshots = entries.filter((entry): entry is Extract<JournalEntry, { type: 'cost_ceiling_snapshot' }> => entry.type === 'cost_ceiling_snapshot');
            const latest = snapshots.at(-1);
            if(latest === undefined) {
                return undefined;
            }
            return { dateKey: latest.dateKey, totalUsd: latest.totalUsd, paused: latest.paused };
        },
    };
}
