/**
 * Table-driven tests for {@link createCompactionTelemetry} (design doc Q4): opens a record on
 * `compaction_started`, closes it on the `sdk_frame` carrying `system`/`compact_boundary` (the
 * actual, currently-only, production success signal) or on `compaction_failed`, and evicts the
 * oldest record once past `maxRecords`. Every timestamp comes straight off the event's own `at`
 * field -- this module never reads a clock itself. `compaction_finished` is declared on
 * `LedgerEvent` but never dispatched in production today, so it is deliberately left unhandled: a
 * harmless no-op, not a closing trigger.
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

function boundary(at: Date): LedgerEvent {
    return { type: 'sdk_frame', frame: frames.compactBoundary(), at };
}

function otherFrame(at: Date): LedgerEvent {
    return { type: 'sdk_frame', frame: frames.resultSuccess(), at };
}

function finished(at: Date): LedgerEvent {
    return { type: 'compaction_finished', at };
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

    it('opens a record on compaction_started and closes it on an sdk_frame compact_boundary', () => {
        telemetry.record(started(T1));
        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);

        telemetry.record(boundary(T2));
        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60, finishedAt: T2 }]);
    });

    it('records a failed-then-succeeded pair as two distinct records', () => {
        telemetry.record(started(T1));
        telemetry.record(failed(T2, 'no-boundary'));
        telemetry.record(started(T3));
        telemetry.record(boundary(T4));

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

    it('ignores a second compaction_started while one is already open, keeping the first start\'s thresholdAtStart', () => {
        telemetry.record(started(T1));
        getThresholdPercent.mockReturnValue(90);
        telemetry.record(started(T2));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);
    });

    it('abandons an open record as stale and opens a fresh one when a new compaction_started arrives at least staleAfterMs after it started', () => {
        telemetry = createCompactionTelemetry({ getThresholdPercent, staleAfterMs: 1000 });
        const staleStart = T1;
        const rescueStart = new Date(T1.getTime() + 1000);

        telemetry.record(started(staleStart));
        getThresholdPercent.mockReturnValue(90);
        telemetry.record(started(rescueStart));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: staleStart, thresholdAtStart: 60, failedAt: rescueStart, failureReason: 'stale' },
            { startedAt: rescueStart, thresholdAtStart: 90 },
        ]);
    });

    it('keeps ignoring a second compaction_started that arrives one millisecond short of staleAfterMs', () => {
        telemetry = createCompactionTelemetry({ getThresholdPercent, staleAfterMs: 1000 });
        const nearlyStale = new Date(T1.getTime() + 999);

        telemetry.record(started(T1));
        telemetry.record(started(nearlyStale));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);
    });

    it('defaults staleAfterMs to 5 minutes, matching CompactionGuard\'s own default ceilingMs', () => {
        const justUnderFiveMinutes = new Date(T1.getTime() + (5 * 60 * 1000) - 1);
        const fiveMinutesLater = new Date(T1.getTime() + (5 * 60 * 1000));

        telemetry.record(started(T1));
        telemetry.record(started(justUnderFiveMinutes));
        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);

        telemetry.record(started(fiveMinutesLater));
        expect(telemetry.getRecords()).toEqual([
            { startedAt: T1, thresholdAtStart: 60, failedAt: fiveMinutesLater, failureReason: 'stale' },
            { startedAt: fiveMinutesLater, thresholdAtStart: 60 },
        ]);
    });

    it('counts a stale-abandoned record toward maxRecords eviction like any other completed record', () => {
        telemetry = createCompactionTelemetry({ getThresholdPercent, maxRecords: 1, staleAfterMs: 1000 });
        const rescueStart = new Date(T1.getTime() + 1000);

        telemetry.record(started(T1));
        telemetry.record(started(rescueStart));

        expect(telemetry.getRecords()).toEqual([{ startedAt: rescueStart, thresholdAtStart: 60 }]);
    });

    it('no-ops a compaction_failed that arrives with no open record', () => {
        telemetry.record(failed(T1));

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('no-ops a compact_boundary sdk_frame that arrives with no open record', () => {
        telemetry.record(boundary(T1));

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('an sdk_frame that is not a compact_boundary does not close the open record', () => {
        telemetry.record(started(T1));
        telemetry.record(otherFrame(T2));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);
    });

    it('does not close an open record on compaction_finished -- never dispatched in production, a harmless no-op', () => {
        telemetry.record(started(T1));
        telemetry.record(finished(T2));

        expect(telemetry.getRecords()).toEqual([{ startedAt: T1, thresholdAtStart: 60 }]);
    });

    it('ignores unrelated ledger events entirely -- no record created, no crash', () => {
        telemetry.record({ type: 'tick', rssBytes: 100, at: T1 });

        expect(telemetry.getRecords()).toEqual([]);
    });

    it('keeps at most maxRecords records, evicting the oldest', () => {
        telemetry = createCompactionTelemetry({ getThresholdPercent, maxRecords: 2 });
        telemetry.record(started(T1));
        telemetry.record(boundary(T1));
        telemetry.record(started(T2));
        telemetry.record(boundary(T2));
        telemetry.record(started(T3));
        telemetry.record(boundary(T3));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T2, thresholdAtStart: 60, finishedAt: T2 },
            { startedAt: T3, thresholdAtStart: 60, finishedAt: T3 },
        ]);
    });

    it('getThresholdPercent is invoked per-start so two compactions with a threshold change between them keep distinct thresholdAtStart values', () => {
        telemetry.record(started(T1));
        telemetry.record(boundary(T2));
        getThresholdPercent.mockReturnValue(75);
        telemetry.record(started(T3));

        expect(telemetry.getRecords()).toEqual([
            { startedAt: T1, thresholdAtStart: 60, finishedAt: T2 },
            { startedAt: T3, thresholdAtStart: 75 },
        ]);
        expect(getThresholdPercent).toHaveBeenCalledTimes(2);
    });
});
