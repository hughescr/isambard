/**
 * Table-driven tests for {@link createCompactionTelemetry} (design doc Q4): opens a record on
 * `compaction_started`, closes it on `compaction_completed` or on `compaction_failed`, and evicts
 * the oldest record once past `maxRecords`. Every timestamp comes straight off the event's own
 * `at` field -- this module never reads a clock itself. A raw `compact_boundary` `sdk_frame` is
 * not a closing trigger: the conductor turns it into `compaction_completed`.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import * as frames from '../../../helpers/sdk-frames';
import { createCompactionTelemetry, type CompactionTelemetry, type CreateCompactionTelemetryParams } from '@/agent/session/compaction-telemetry';
import type { LedgerEvent } from '@/agent/session/ledger';

const T1 = new Date('2026-09-04T12:00:00Z');
const T2 = new Date('2026-09-04T12:00:01Z');
const T3 = new Date('2026-09-04T12:00:02Z');
const T4 = new Date('2026-09-04T12:00:03Z');

function started(at: Date): LedgerEvent {
    return { type: 'compaction_started', trigger: 'auto', at };
}

function failed(at: Date, reason = 'timeout'): LedgerEvent {
    return { type: 'compaction_failed', reason, at };
}

function completed(at: Date): LedgerEvent {
    return { type: 'compaction_completed', at };
}

function boundaryFrame(at: Date): LedgerEvent {
    return { type: 'sdk_frame', frame: frames.compactBoundary(), at };
}

describe('createCompactionTelemetry', () => {
    let getThresholdPercent: ReturnType<typeof jest.fn<CreateCompactionTelemetryParams['getThresholdPercent']>>;
    let telemetry: CompactionTelemetry;

    beforeEach(() => {
        getThresholdPercent = jest.fn<CreateCompactionTelemetryParams['getThresholdPercent']>().mockReturnValue(60);
        telemetry = createCompactionTelemetry({ getThresholdPercent });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('opens a record on compaction_started and closes it on compaction_completed', () => {
        telemetry.record(started(T1));
        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);

        telemetry.record(completed(T2));
        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60, finishedAt: T2 }]);
    });

    it('records a failed-then-succeeded pair as two distinct records', () => {
        telemetry.record(started(T1));
        telemetry.record(failed(T2, 'no-boundary'));
        telemetry.record(started(T3));
        telemetry.record(completed(T4));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T1, thresholdAtStart: 60, failedAt: T2, failureReason: 'no-boundary' },
            { startedAt: T3, thresholdAtStart: 60, finishedAt: T4 },
        ]);
    });

    it('leaves an unterminated compaction_started as a single in-flight record with no finishedAt/failedAt', () => {
        telemetry.record(started(T1));

        const [record] = telemetry.getRecords();
        expect(record).toEqual({ startedAt: T1, thresholdAtStart: 60 });
        expect(record).not.toHaveProperty('finishedAt');
        expect(record).not.toHaveProperty('failedAt');
    });

    it('a second compaction_started opens a fresh record and leaves the first unfinished', () => {
        telemetry.record(started(T1));
        getThresholdPercent.mockReturnValue(90);
        telemetry.record(started(T2));
        telemetry.record(completed(T3));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T1, thresholdAtStart: 60 },
            { startedAt: T2, thresholdAtStart: 90, finishedAt: T3 },
        ]);
    });

    it('no-ops a compaction_failed that arrives with no open record', () => {
        telemetry.record(failed(T1));

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('no-ops a compaction_completed that arrives with no open record', () => {
        telemetry.record(completed(T1));

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('a compaction_completed after the record already closed does not re-close it', () => {
        telemetry.record(started(T1));
        telemetry.record(completed(T2));
        telemetry.record(completed(T3));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60, finishedAt: T2 }]);
    });

    it('a compaction_completed after the record already failed does not also mark it finished', () => {
        telemetry.record(started(T1));
        telemetry.record(failed(T2, 'no-boundary'));
        telemetry.record(completed(T3));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60, failedAt: T2, failureReason: 'no-boundary' }]);
    });

    it('a raw compact_boundary sdk_frame does not close the open record', () => {
        telemetry.record(started(T1));
        telemetry.record(boundaryFrame(T2));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);
    });

    it('ignores unrelated ledger events entirely -- no record created, no crash', () => {
        telemetry.record({ type: 'tick', rssBytes: 100, at: T1 });

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('keeps at most maxRecords records, evicting the oldest', () => {
        telemetry = createCompactionTelemetry({ getThresholdPercent, maxRecords: 2 });
        telemetry.record(started(T1));
        telemetry.record(completed(T1));
        telemetry.record(started(T2));
        telemetry.record(completed(T2));
        telemetry.record(started(T3));
        telemetry.record(completed(T3));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T2, thresholdAtStart: 60, finishedAt: T2 },
            { startedAt: T3, thresholdAtStart: 60, finishedAt: T3 },
        ]);
    });

    it('retains exactly the newest 50 records when maxRecords is omitted', () => {
        const attempts = Array.from({ length: 51 }, (_value, index) => new Date(T1.getTime() + index));
        for(const at of attempts) {
            telemetry.record(started(at));
            telemetry.record(completed(at));
        }

        const records = telemetry.getRecords();

        expect(records).toHaveLength(50);
        expect(records[0]).toEqual({ startedAt: attempts[1], thresholdAtStart: 60, finishedAt: attempts[1] });
        expect(records.at(-1)).toEqual({ startedAt: attempts[50], thresholdAtStart: 60, finishedAt: attempts[50] });
    });

    it('getThresholdPercent is invoked per-start so two compactions with a threshold change between them keep distinct thresholdAtStart values', () => {
        telemetry.record(started(T1));
        telemetry.record(completed(T2));
        getThresholdPercent.mockReturnValue(75);
        telemetry.record(started(T3));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T1, thresholdAtStart: 60, finishedAt: T2 },
            { startedAt: T3, thresholdAtStart: 75 },
        ]);
        expect(getThresholdPercent).toHaveBeenCalledTimes(2);
    });
});
