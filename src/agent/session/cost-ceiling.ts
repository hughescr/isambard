/**
 * Daily cost ceiling (design doc Q3 / plan amendment B4): a day-bucketed spend accumulator,
 * independent of {@link import('./ledger').Ledger}'s `cost.cumulativeUsd`'s `session_opened`
 * reset (`ledger.ts:336-341`, which zeroes `cumulativeUsd` only), tracked per-store via a
 * `cumulativeUsd` delta so a caller can subscribe it to any number of {@link
 * import('./ledger').LedgerStore}s (conversation and perch) and see their spend accumulate into
 * one shared local-calendar-day bucket. `isPaused()` flips true once the day's total crosses a
 * configured USD ceiling and self-clears at local midnight — no restart, no `stop()`/`start()`.
 *
 * Deliberately event-type-agnostic: {@link record} never inspects `event.type`. A `session_opened`
 * reset makes the next delta negative, which clamps to 0 and re-baselines cleanly; a repeat
 * notification with an unchanged `cumulativeUsd` adds nothing.
 *
 * `snapshot()`/`restore()` are the B4 persistence seam: a caller pairs them with a {@link
 * CostCeilingPersistence} adapter (e.g. {@link import('./cost-ceiling-store').createCostCeilingStore}
 * over the session journal) to survive a process restart — `restore()` only needs to rehydrate the
 * day bucket and paused flag, never the per-store baselines: a store's first `record()` call after
 * restart re-baselines against its then-current `cumulativeUsd`, so the spend already folded into
 * the restored bucket is never double-booked.
 *
 * @module agent/session/cost-ceiling
 */
import type { Logger } from '@hughescr/logger';
import { DateTime } from 'luxon';
import type { Ledger, LedgerEvent } from './ledger';
import type { Clock } from './types';

/** The day-bucketed state a {@link CostCeiling} persists and restores across a process restart. */
export interface CostCeilingSnapshot {
    /** The local-calendar-day this bucket belongs to, `yyyy-MM-dd` in the ceiling's configured timezone. */
    dateKey:  string
    /** Cumulative USD booked into this day so far. */
    totalUsd: number
    /** Whether the ceiling was paused as of this snapshot. */
    paused:   boolean
}

/** Durable persistence for a {@link CostCeiling}'s day bucket — see {@link import('./cost-ceiling-store').createCostCeilingStore}. */
export interface CostCeilingPersistence {
    /** The most recently saved snapshot, or `undefined` if none has ever been saved. */
    load: () => Promise<CostCeilingSnapshot | undefined>
    /** Fire-and-forget, mirroring {@link import('./ports').SessionJournal.append} — never throws. */
    save: (snapshot: CostCeilingSnapshot) => void
}

/** Dependencies for {@link createCostCeiling}. */
export interface CreateCostCeilingParams {
    clock:        Clock
    /** IANA timezone the local-calendar day is computed in (e.g. `config.session.timezone`). */
    timezone:     string
    /** Daily USD ceiling; `undefined` disables the ceiling entirely — `isPaused()` is always false. */
    ceilingUsd?:  number
    /** Optional B4 persistence adapter, saved to on every state-changing `record()`/rollover. */
    persistence?: CostCeilingPersistence
    /** Optional: logs a warn the moment the ceiling is first crossed, and an info when a paused day clears at local midnight. */
    logger?:      Pick<Logger, 'warn' | 'info'>
}

/** What {@link createCostCeiling} returns. */
export interface CostCeiling {
    /**
     * Folds one ledger change into the day bucket. `ledgerStoreIdentity` distinguishes the
     * per-store `cumulativeUsd` baseline (e.g. pass the `LedgerStore` reference itself) — the
     * first call seen for a given identity baselines against its current `cumulativeUsd` rather
     * than booking that store's entire prior spend.
     */
    record:   (ledgerStoreIdentity: unknown, ledger: Ledger, event: LedgerEvent) => void
    /** Whether today's total has reached `ceilingUsd`. Always false when `ceilingUsd` is undefined. */
    isPaused: () => boolean
    /** The current day bucket, rolled over first if the local day has changed since the last check. */
    snapshot: () => CostCeilingSnapshot
    /** Rehydrates the day bucket and paused flag from a previously-saved {@link CostCeilingSnapshot}. */
    restore:  (snapshot: CostCeilingSnapshot) => void
}

/** The local-calendar-day key (`yyyy-MM-dd`) for `clock.now()` in `timezone`. */
function localDateKey(clock: Clock, timezone: string): string {
    return DateTime.fromMillis(clock.now(), { zone: timezone }).toFormat('yyyy-MM-dd');
}

/**
 * Creates a {@link CostCeiling}. See the module doc for the accumulation, rollover, and
 * persistence semantics.
 * @param params See {@link CreateCostCeilingParams}.
 */
export function createCostCeiling(params: CreateCostCeilingParams): CostCeiling {
    const { clock, timezone, ceilingUsd, persistence, logger } = params;
    const baselines = new Map<unknown, number>();
    let dateKey = localDateKey(clock, timezone);
    let totalUsd = 0;
    let paused = false;
    // The last snapshot actually handed to `persistence.save`, so a ledger-changing notification
    // that leaves the bucket untouched (the overwhelming majority — createLedgerStore notifies on
    // every phase transition, task frame, envelope_queued/turn_submitted and tick, not only on a
    // cumulativeUsd change) never re-writes a byte-identical row (finding: unconditional persist()
    // amplifies every ledger event into a DynamoDB PutItem).
    let lastPersisted: CostCeilingSnapshot | undefined;

    function persist(): void {
        const current: CostCeilingSnapshot = { dateKey, totalUsd, paused };
        if(
            lastPersisted?.dateKey === current.dateKey
            && lastPersisted.totalUsd === current.totalUsd
            && lastPersisted.paused === current.paused
        ) {
            return;
        }
        lastPersisted = current;
        persistence?.save(current);
    }

    /** Resets the bucket when the local day has moved on since it was last checked. */
    function rolloverIfNeeded(): void {
        const currentDateKey = localDateKey(clock, timezone);
        if(currentDateKey === dateKey) {
            return;
        }
        const wasPaused = paused;
        dateKey = currentDateKey;
        totalUsd = 0;
        paused = false;
        if(wasPaused) {
            // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
            logger?.info({ dateKey }, 'Daily cost ceiling cleared at local midnight');
        }
        persist();
    }

    /** Flips `paused` true the moment `totalUsd` first reaches `ceilingUsd`; never re-warns while still over. */
    function evaluatePause(): void {
        if(ceilingUsd === undefined) {
            return;
        }
        if(totalUsd >= ceilingUsd && !paused) {
            paused = true;
            // Stryker disable next-line ObjectLiteral,StringLiteral: log message content is not behavior-affecting
            logger?.warn({ dateKey, totalUsd, ceilingUsd }, 'Daily cost ceiling reached; perch paused');
        }
    }

    return {
        record(ledgerStoreIdentity, ledger, _event) {
            rolloverIfNeeded();
            const lastSeen = baselines.get(ledgerStoreIdentity) ?? ledger.cost.cumulativeUsd;
            const delta = Math.max(0, ledger.cost.cumulativeUsd - lastSeen);
            baselines.set(ledgerStoreIdentity, ledger.cost.cumulativeUsd);
            totalUsd += delta;
            evaluatePause();
            persist();
        },

        isPaused(): boolean {
            rolloverIfNeeded();
            return paused;
        },

        snapshot(): CostCeilingSnapshot {
            rolloverIfNeeded();
            return { dateKey, totalUsd, paused };
        },

        restore(snapshot: CostCeilingSnapshot): void {
            dateKey = snapshot.dateKey;
            totalUsd = snapshot.totalUsd;
            // Derived from the CURRENT ceilingUsd rather than trusted from the persisted flag: an
            // operator who raised, lowered, or removed SESSION_DAILY_COST_CEILING_USD across a
            // restart must see that take effect immediately, not stay stuck on whatever was true
            // when the snapshot was written (finding: the undefined-ceiling kill switch was
            // unreachable across a restart while a stale paused:true snapshot survived).
            paused = ceilingUsd !== undefined && totalUsd >= ceilingUsd;
        },
    };
}
