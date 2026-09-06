/**
 * Structured per-compaction telemetry, fed exclusively by {@link LedgerEvent}s the system
 * genuinely dispatches today (design doc Q4): a record opens on `compaction_started`, closes with
 * `finishedAt` on the `sdk_frame` carrying `system`/`compact_boundary` (the actual, currently-only
 * production success signal -- see `ledger.ts`'s `compact_boundary` handling), or closes with
 * `failedAt`/`failureReason` on `compaction_failed`. Both {@link CompactionGuard}'s own `submit()`
 * and `sessions.ts`'s PreCompact-hook sink dispatch `compaction_started` for the same real
 * compaction, so a second `compaction_started` arriving less than `staleAfterMs` after the open
 * record's own start is ignored rather than opening a new record. `compaction_finished` is
 * declared on `LedgerEvent` for forward compatibility but is never dispatched by anything in
 * `src` today; this module intentionally has no branch for it, so it falls through as a harmless
 * no-op exactly like any other unrelated event (`tick`, `context_usage_polled`, ...) -- it neither
 * opens nor closes a record.
 *
 * Staleness escape hatch: a `compaction_started` dispatched via `sessions.ts`'s PreCompact hook
 * (not via {@link CompactionGuard}'s own `submit()`) can end without either a `compact_boundary`
 * frame or a `compaction_failed` event -- the guard is never in flight for that path, so its
 * ceiling timer never arms and `release()` never fires. Without an escape hatch that record would
 * stay open forever and `openRecord()` would then swallow every subsequent `compaction_started`
 * for the rest of the process's life. So when a new `compaction_started` arrives `staleAfterMs` or
 * more after the currently-open record's own `startedAt`, that record is closed with
 * `failureReason: 'stale'` (using the new event's own `at`, never a clock read) and a fresh record
 * opens for the new start.
 *
 * This module never reads a clock: every timestamp on a {@link CompactionTelemetryRecord} is
 * copied straight from the triggering event's own `at` field.
 *
 * @module agent/session/compaction-telemetry
 */
import type { LedgerEvent } from './ledger';

const DEFAULT_MAX_RECORDS = 50;
/** Matches {@link CompactionGuard}'s own default `ceilingMs` -- any real compaction the guard drives should reach a terminal event well within this window. */
const DEFAULT_STALE_AFTER_MS = 300_000;

/** One compaction attempt's observed lifecycle. */
export interface CompactionTelemetryRecord {
    startedAt:        Date
    /** The threshold {@link CreateCompactionTelemetryParams.getThresholdPercent} returned at the moment this attempt started. */
    thresholdAtStart: number
    finishedAt?:      Date
    failedAt?:        Date
    /** The `compaction_failed` event's own `reason`, or the literal `'stale'` when this record was abandoned by a later `compaction_started` rather than closed by a real terminal event -- see module doc. */
    failureReason?:   string
}

/** Dependencies {@link createCompactionTelemetry} needs. */
export interface CreateCompactionTelemetryParams {
    /** Read fresh on every `compaction_started`, so a threshold change between two compactions is reflected in each one's own record. */
    getThresholdPercent: () => number
    /** Maximum records retained; the oldest is evicted once a new record would exceed it. Default 50. */
    maxRecords?:         number
    /** A `compaction_started` arriving this many milliseconds or more after the currently-open record's own `startedAt` abandons that record as stale (`failureReason: 'stale'`) instead of being ignored -- see module doc. Default 300000 (5 minutes), matching {@link CompactionGuard}'s own default `ceilingMs`. */
    staleAfterMs?:       number
}

/** Compaction telemetry recorder returned by {@link createCompactionTelemetry}. */
export interface CompactionTelemetry {
    /** Feed one ledger event. Events unrelated to a compaction's start/finish/failure are a no-op. */
    record:     (event: LedgerEvent) => void
    /** All retained records, oldest first. */
    getRecords: () => readonly CompactionTelemetryRecord[]
}

function isOpen(record: CompactionTelemetryRecord): boolean {
    return record.finishedAt === undefined && record.failedAt === undefined;
}

/**
 * @param params See {@link CreateCompactionTelemetryParams}.
 */
export function createCompactionTelemetry(params: CreateCompactionTelemetryParams): CompactionTelemetry {
    const { getThresholdPercent, maxRecords = DEFAULT_MAX_RECORDS, staleAfterMs = DEFAULT_STALE_AFTER_MS } = params;

    const records: CompactionTelemetryRecord[] = [];

    function openRecord(): CompactionTelemetryRecord | undefined {
        const last = records.at(-1);
        return last !== undefined && isOpen(last) ? last : undefined;
    }

    return {
        record(event: LedgerEvent): void {
            if(event.type === 'compaction_started') {
                const current = openRecord();
                if(current !== undefined) {
                    if(event.at.getTime() - current.startedAt.getTime() < staleAfterMs) {
                        return;
                    }
                    // Never reached a terminal event within staleAfterMs -- abandon it rather
                    // than let it wedge every future compaction_started forever (see module doc).
                    current.failedAt = event.at;
                    current.failureReason = 'stale';
                }
                records.push({ startedAt: event.at, thresholdAtStart: getThresholdPercent() });
                if(records.length > maxRecords) {
                    records.shift();
                }
                return;
            }

            if(event.type === 'compaction_failed') {
                const current = openRecord();
                if(current === undefined) {
                    return;
                }
                current.failedAt = event.at;
                current.failureReason = event.reason;
                return;
            }

            if(event.type === 'sdk_frame' && event.frame.type === 'system' && event.frame.subtype === 'compact_boundary') {
                const current = openRecord();
                if(current === undefined) {
                    return;
                }
                current.finishedAt = event.at;
            }
        },

        getRecords(): readonly CompactionTelemetryRecord[] {
            return records;
        },
    };
}
