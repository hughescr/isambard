/**
 * Structured per-compaction telemetry, fed by the compaction lifecycle {@link LedgerEvent}s (design
 * doc Q4): a record opens on `compaction_started`, closes with `finishedAt` on
 * `compaction_completed`, or closes with `failedAt`/`failureReason` on `compaction_failed`.
 *
 * There is one producer of those events — the conductor (`conductor.ts`'s `compactionStarted`,
 * `compactionCompleted`, `compactionFailed`) — and every reducer for them is idempotent, so the
 * ledger store notifies its subscribers only on a real `none -> compacting` or
 * `compacting -> none` transition. Fed from a ledger subscriber, starts and terminal events
 * therefore strictly alternate, and every `compaction_started` opens a fresh record. A direct
 * caller that breaks the alternation (two starts in a row) simply leaves the earlier record
 * unfinished; the tuner never counts an unfinished record.
 *
 * This module never reads a clock: every timestamp on a {@link CompactionTelemetryRecord} is
 * copied straight from the triggering event's own `at` field.
 *
 * @module agent/session/compaction-telemetry
 */
import type { LedgerEvent } from './ledger';

const DEFAULT_MAX_RECORDS = 50;

/** One compaction attempt's observed lifecycle. */
export interface CompactionTelemetryRecord {
    startedAt:        Date
    /** The threshold {@link CreateCompactionTelemetryParams.getThresholdPercent} returned at the moment this attempt started. */
    thresholdAtStart: number
    finishedAt?:      Date
    failedAt?:        Date
    /** The `compaction_failed` event's own `reason`. */
    failureReason?:   string
}

/** Dependencies {@link createCompactionTelemetry} needs. */
export interface CreateCompactionTelemetryParams {
    /** Read fresh on every `compaction_started`, so a threshold change between two compactions is reflected in each one's own record. */
    getThresholdPercent: () => number
    /** Maximum records retained; the oldest is evicted once a new record would exceed it. Default 50. */
    maxRecords?:         number
}

/** Compaction telemetry recorder returned by {@link createCompactionTelemetry}. */
export interface CompactionTelemetry {
    /** Feed one ledger event. Events unrelated to a compaction's start/completion/failure are a no-op. */
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
    const { getThresholdPercent, maxRecords = DEFAULT_MAX_RECORDS } = params;

    const records: CompactionTelemetryRecord[] = [];

    function openRecord(): CompactionTelemetryRecord | undefined {
        const last = records.at(-1);
        return last !== undefined && isOpen(last) ? last : undefined;
    }

    return {
        record(event: LedgerEvent): void {
            if(event.type === 'compaction_started') {
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

            if(event.type === 'compaction_completed') {
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
