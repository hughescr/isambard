/**
 * Tests for Q11's compaction threshold tuner: the pure `computeTunedThreshold` step-and-clamp,
 * and `createCompactionThresholdTuner`'s ledger-driven subscriber wrapping it. See
 * `src/agent/session/compaction-tuner.ts`'s module doc for the interval-source decision and the
 * collapsed-default no-op guarantee this file's last describe block asserts.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import * as frames from '../../../helpers/sdk-frames';
import type { CompactionTelemetry, CompactionTelemetryRecord } from '@/agent/session/compaction-telemetry';
import {
    computeTunedThreshold,
    createCompactionThresholdTuner,
    type CompactionThresholdBand,
    type CreateCompactionThresholdTunerParams
} from '@/agent/session/compaction-tuner';
import type { Ledger, LedgerEvent } from '@/agent/session/ledger';
import { sessionConfigSchema, type SessionConfig } from '@/config/schemas';

const DEFAULT_CONFIG: SessionConfig = sessionConfigSchema.parse({});

function boundaryEvent(at: Date): LedgerEvent {
    return { type: 'sdk_frame', frame: frames.compactBoundary(), at };
}

describe('computeTunedThreshold', () => {
    const WIDE: CompactionThresholdBand = { targetIntervalMs: 5000, min: 10, max: 90 };

    const table: { name: string, intervalsMs: number[], currentPercent: number, band: CompactionThresholdBand, expected: number }[] = [
        { name: 'two intervals shorter than target step up by the default step', intervalsMs: [1000, 1000], currentPercent: 50, band: WIDE, expected: 55 },
        { name: 'two intervals longer than target step down by the default step', intervalsMs: [10_000, 10_000], currentPercent: 50, band: WIDE, expected: 45 },
        { name: 'odd-length history steps on the median, not the mean', intervalsMs: [1000, 9000, 2000], currentPercent: 50, band: WIDE, expected: 55 },
        { name: 'an interval exactly equal to target is a no-op step', intervalsMs: [5000, 5000], currentPercent: 50, band: WIDE, expected: 50 },
        { name: 'a custom stepPercent overrides the default', intervalsMs: [1000, 1000], currentPercent: 50, band: { ...WIDE, stepPercent: 10 }, expected: 60 },
        { name: 'stepping up clamps at max rather than overshooting', intervalsMs: [1000, 1000], currentPercent: 88, band: WIDE, expected: 90 },
        { name: 'stepping down clamps at min rather than undershooting', intervalsMs: [10_000, 10_000], currentPercent: 12, band: WIDE, expected: 10 },
        { name: 'a pathologically large stepPercent still clamps into the band in one step', intervalsMs: [1, 1], currentPercent: 5, band: { targetIntervalMs: 5000, min: 0, max: 100, stepPercent: 200 }, expected: 100 },
        { name: 'an Infinity target (the collapsed default target) is an explicit no-op even in a widened band', intervalsMs: [1000, 2000], currentPercent: 50, band: { targetIntervalMs: Number.POSITIVE_INFINITY, min: 10, max: 90 }, expected: 50 },
        { name: 'an Infinity target still clamps an out-of-band currentPercent', intervalsMs: [1000, 2000], currentPercent: 95, band: { targetIntervalMs: Number.POSITIVE_INFINITY, min: 10, max: 90 }, expected: 90 },
        { name: 'fewer than two intervals (empty) leaves currentPercent unchanged', intervalsMs: [], currentPercent: 73, band: WIDE, expected: 73 },
        { name: 'fewer than two intervals (exactly one) leaves currentPercent unchanged', intervalsMs: [1000], currentPercent: 73, band: WIDE, expected: 73 },
        { name: 'a collapsed band (min===max) is a no-op even for a short-interval history', intervalsMs: [1, 1], currentPercent: 60, band: { targetIntervalMs: 5000, min: 60, max: 60 }, expected: 60 },
        { name: 'a collapsed band (min===max) is a no-op even for a long-interval history', intervalsMs: [999_999, 999_999], currentPercent: 60, band: { targetIntervalMs: 5000, min: 60, max: 60 }, expected: 60 },
        { name: 'a collapsed band with an unset (Infinity) target is a no-op regardless of history', intervalsMs: [1, 999_999], currentPercent: 60, band: { targetIntervalMs: Number.POSITIVE_INFINITY, min: 60, max: 60 }, expected: 60 },
        { name: 'an even-length history takes the mean of the middle two values, not a single element', intervalsMs: [1000, 9000], currentPercent: 50, band: WIDE, expected: 50 },
        { name: 'an odd-length history uses the single middle element, not a mean', intervalsMs: [1000, 3000, 9000], currentPercent: 50, band: { targetIntervalMs: 3000, min: 10, max: 90 }, expected: 50 },
    ];

    it.each(table)('$name', ({ intervalsMs, currentPercent, band, expected }) => {
        expect(computeTunedThreshold(intervalsMs, currentPercent, band)).toBe(expected);
    });
});

describe('createCompactionThresholdTuner', () => {
    let clock: FakeClock;
    let logger: CreateCompactionThresholdTunerParams['logger'];
    let getThresholdPercent: ReturnType<typeof jest.fn<() => number>>;
    let setThresholdPercent: ReturnType<typeof jest.fn<(percent: number) => void>>;
    let listeners: ((ledger: Ledger, event: LedgerEvent) => void)[];
    let ledgerSnapshot: Ledger;
    let ledgerStore: CreateCompactionThresholdTunerParams['ledgerStore'];

    function emit(event: LedgerEvent): void {
        for(const listener of listeners) {
            listener(ledgerSnapshot, event);
        }
    }

    function baseLedger(lastCompactionAt?: Date): Ledger {
        return {
            role:          'conversation',
            turn:          null,
            queued:        { human: 0, other: 0 },
            tasks:         [],
            finishedTasks: [],
            compaction:    'none',
            context:       { used: 0, window: 0, percentage: 0, lastCompactionAt },
            process:       { rssBytes: 0 },
            perch:         {},
            cost:          { cumulativeUsd: 0, lastTurnUsd: 0 },
            latency:       { bySource: {} },
        };
    }

    function build(overrides: Partial<CreateCompactionThresholdTunerParams> = {}): () => void {
        return createCompactionThresholdTuner({
            ledgerStore,
            config: DEFAULT_CONFIG,
            getThresholdPercent,
            setThresholdPercent,
            clock,
            logger,
            ...overrides,
        });
    }

    function telemetryOf(records: CompactionTelemetryRecord[]): CompactionTelemetry {
        return { record: jest.fn(), getRecords: () => records };
    }

    beforeEach(() => {
        clock = new FakeClock(0);
        logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn() };
        getThresholdPercent = jest.fn<() => number>().mockReturnValue(60);
        setThresholdPercent = jest.fn<(percent: number) => void>();
        listeners = [];
        ledgerSnapshot = baseLedger();
        ledgerStore = {
            subscribe: jest.fn((listener: (ledger: Ledger, event: LedgerEvent) => void) => {
                listeners.push(listener);
                return () => {
                    listeners = listeners.filter(l => l !== listener);
                };
            }),
            get: jest.fn(() => ledgerSnapshot),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns an unsubscribe function that stops further recomputation', () => {
        const unsubscribe = build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 1000 } });
        unsubscribe();

        emit(boundaryEvent(new Date(0)));
        emit(boundaryEvent(new Date(10_000)));

        expect(setThresholdPercent).not.toHaveBeenCalled();
    });

    it('ignores ledger events other than an sdk_frame compact_boundary', () => {
        // Target deliberately does NOT equal the spacing between the events below (1000ms): if
        // the compact_boundary guard were ever bypassed, these non-boundary events would still
        // feed the fallback tracker (each carries an `at`) and produce two 1000ms intervals,
        // which -- at this target -- would step the threshold up and be observed below. A target
        // that happened to equal the event spacing (as this test previously used) would make a
        // bypassed guard's step a no-op step, hiding the bug -- see the Q11 fixer's gap note.
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 } });

        emit({ type: 'compaction_started', trigger: 'auto', at: new Date(0) });
        emit({ type: 'compaction_failed', reason: 'timeout', at: new Date(1000) });
        emit({ type: 'sdk_frame', frame: frames.resultSuccess(), at: new Date(2000) });

        expect(setThresholdPercent).not.toHaveBeenCalled();
    });

    it('ignores a system sdk_frame whose subtype is not compact_boundary', () => {
        // Distinguishes the subtype check from the shallower `frame.type === 'system'` check
        // above it: `frames.init` is a real `system`-type frame, just not a `compact_boundary`
        // one, so a bypassed subtype guard would still feed the fallback tracker two 1000ms
        // intervals (three events needed for two intervals -- see the test above) and step the
        // threshold at this target -- same reasoning as the test above.
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 } });

        emit({ type: 'sdk_frame', frame: frames.init('s1'), at: new Date(0) });
        emit({ type: 'sdk_frame', frame: frames.init('s1'), at: new Date(1000) });
        emit({ type: 'sdk_frame', frame: frames.init('s1'), at: new Date(2000) });

        expect(setThresholdPercent).not.toHaveBeenCalled();
    });

    it('derives intervals from telemetry.getRecords() finished-record startedAt deltas when telemetry is supplied', () => {
        const records: CompactionTelemetryRecord[] = [
            { startedAt: new Date(0), thresholdAtStart: 60, finishedAt: new Date(100) },
            { startedAt: new Date(1000), thresholdAtStart: 60, finishedAt: new Date(1100) },
            { startedAt: new Date(2000), thresholdAtStart: 60, finishedAt: new Date(2100) },
        ];
        build({
            telemetry: telemetryOf(records),
            config:    { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 },
        });

        // A single boundary event is enough to trigger a recompute -- the two-interval history
        // ([0->1000], [1000->2000]) comes from telemetry's already-recorded records, not from
        // counting live events.
        emit(boundaryEvent(new Date(2100)));

        // Both 1000ms intervals are shorter than the 5000ms target -> steps up by the default 5.
        expect(setThresholdPercent).toHaveBeenCalledWith(65);
        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ from: 60, to: 65 }), 'Compaction threshold tuner: adjusting threshold');
        // The fallback-only seed (ledgerStore.get().context.lastCompactionAt) must never run when
        // telemetry is supplied -- see the module doc's interval-source decision.
        expect(ledgerStore.get).not.toHaveBeenCalled();
    });

    it('open (unfinished) telemetry records never contribute an interval', () => {
        // The middle record is still open. If the finishedAt filter were dropped (or replaced by
        // an always-true predicate), its startedAt would still count, turning the one real
        // interval ([0->6000], too few to tune) into two ([0->1000], [1000->6000], enough to
        // step) -- so this needs three records with the open one in the middle, not two, to
        // observe the filter actually doing something.
        const records: CompactionTelemetryRecord[] = [
            { startedAt: new Date(0), thresholdAtStart: 60, finishedAt: new Date(100) },
            { startedAt: new Date(1000), thresholdAtStart: 60 }, // still in flight -- no finishedAt
            { startedAt: new Date(6000), thresholdAtStart: 60, finishedAt: new Date(6100) },
        ];
        build({
            telemetry: telemetryOf(records),
            config:    { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 },
        });

        emit(boundaryEvent(new Date(6100)));

        expect(setThresholdPercent).not.toHaveBeenCalled();
    });

    it('derives each interval as a simple consecutive delta, not an off-by-one or a sum', () => {
        // Three distinct, non-uniform finished starts pin the exact interval history: a
        // loop-bound off-by-one (reading one element past the end) or a `+` in place of `-` would
        // both corrupt this specific array. The target sits exactly at the true median so the
        // real code takes the no-op branch, and the intervals actually fed to computeTunedThreshold
        // are pinned via the "no change" debug log -- any corruption changes that logged array.
        const records: CompactionTelemetryRecord[] = [
            { startedAt: new Date(100), thresholdAtStart: 60, finishedAt: new Date(150) },
            { startedAt: new Date(1300), thresholdAtStart: 60, finishedAt: new Date(1350) },
            { startedAt: new Date(3000), thresholdAtStart: 60, finishedAt: new Date(3050) },
        ];
        build({
            telemetry: telemetryOf(records),
            config:    { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 1450 },
        });

        emit(boundaryEvent(new Date(3050)));

        expect(setThresholdPercent).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith({ intervalsMs: [1200, 1700], currentPercent: 60, at: new Date(0) }, 'Compaction threshold tuner: no change');
    });

    it('tunes from only the most recent intervals, not the full retained telemetry history', () => {
        // Four old, widely-spaced intervals (90000ms each) followed by three recent, tight ones
        // (1000ms each). The full 7-interval history's median (90000ms, i.e. "longer than
        // target") would step the threshold DOWN; a trailing window over just the most recent
        // intervals sees only the tight recent spacing and steps UP instead. This is the
        // observable difference a windowed implementation must produce.
        const startsMs = [0, 90_000, 180_000, 270_000, 360_000, 361_000, 362_000, 363_000];
        const records: CompactionTelemetryRecord[] = startsMs.map(startedAtMs => ({
            startedAt:        new Date(startedAtMs),
            thresholdAtStart: 60,
            finishedAt:       new Date(startedAtMs + 50),
        }));
        getThresholdPercent.mockReturnValue(50);
        build({
            telemetry: telemetryOf(records),
            config:    { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 },
        });

        emit(boundaryEvent(new Date(363_050)));

        expect(setThresholdPercent).toHaveBeenCalledWith(55);
    });

    it('without telemetry, trims the fallback interval tracker to the trailing window as each boundary arrives', () => {
        // Six consecutive intervals (100, 200, ..., 600ms) pushed one at a time. A window that
        // trims eagerly (`>=` instead of `>` the window size, or on every push rather than only
        // once it overflows) drops one interval too many and settles at a 4-element window
        // ([300,400,500,600], median 450); a window that never trims (the shift call or its
        // containing branch removed) keeps growing past the window ([100,200,300,400,500,600],
        // median 350). The correct trailing-5 window is [200,300,400,500,600], median exactly
        // 400 -- pinned at this target as a no-op step so the debug log's `intervalsMs` proves
        // precisely which of the three array contents was actually used.
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 400 } });

        // Feed the first six intervals (each shorter-than-target and stepping the threshold up,
        // since getThresholdPercent is a fixed mock rather than tracking prior sets) before the
        // window fills; only the seventh event's resulting window is under test.
        for(const atMs of [0, 100, 300, 600, 1000, 1500]) {
            emit(boundaryEvent(new Date(atMs)));
        }
        jest.clearAllMocks();

        emit(boundaryEvent(new Date(2100)));

        expect(setThresholdPercent).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            { intervalsMs: [200, 300, 400, 500, 600], currentPercent: 60, at: new Date(0) },
            'Compaction threshold tuner: no change'
        );
    });

    it('without telemetry, falls back to tracking compact_boundary timestamps itself, seeded from ledgerStore.get().context.lastCompactionAt', () => {
        ledgerSnapshot = baseLedger(new Date(0));
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 } });

        // The seeded lastCompactionAt supplies one endpoint, so these two live events are enough
        // to produce two intervals ([0->1000], [1000->2000]) rather than needing a third.
        emit(boundaryEvent(new Date(1000)));
        expect(setThresholdPercent).not.toHaveBeenCalled();

        emit(boundaryEvent(new Date(2000)));
        expect(setThresholdPercent).toHaveBeenCalledWith(65);
    });

    it('without telemetry and with no seeded lastCompactionAt, needs three live boundary events before tuning', () => {
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 } });

        // First event only seeds the fallback tracker's baseline -- no interval yet.
        emit(boundaryEvent(new Date(0)));
        expect(setThresholdPercent).not.toHaveBeenCalled();

        // Second event produces exactly one interval -- still fewer than two.
        emit(boundaryEvent(new Date(1000)));
        expect(setThresholdPercent).not.toHaveBeenCalled();

        // Third event produces a second interval -- now there's enough history to tune.
        emit(boundaryEvent(new Date(2000)));
        expect(setThresholdPercent).toHaveBeenCalledWith(65);
    });

    it('calls setThresholdPercent only when the tuned value differs from the current one', () => {
        getThresholdPercent.mockReturnValue(50);
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 10, compactThresholdMaxPercent: 90, compactTargetIntervalMs: 5000 } });

        // Both intervals sit exactly at target -> computeTunedThreshold returns currentPercent.
        emit(boundaryEvent(new Date(0)));
        emit(boundaryEvent(new Date(5000)));
        emit(boundaryEvent(new Date(10_000)));

        expect(setThresholdPercent).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith({ intervalsMs: [5000, 5000], currentPercent: 50, at: new Date(0) }, 'Compaction threshold tuner: no change');
    });

    it('warns and collapses to compactThresholdPercent when the configured band is inverted (min > max)', () => {
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 90, compactThresholdMaxPercent: 10, compactTargetIntervalMs: 5000 } });

        // A third event is required: with only two, there is exactly one derived interval, which
        // is too few for computeTunedThreshold to do anything regardless of the band -- so the
        // collapse itself would go unobserved. With three events (two intervals, both 1000ms,
        // below the 5000ms target), an uncollapsed inverted band {min:90,max:10} would clamp to a
        // fixed 10 (Math.min(10, Math.max(90, stepped)) is 10 for any `stepped`), which differs
        // from the collapsed band's no-op 60 -- making the collapse itself observable.
        emit(boundaryEvent(new Date(0)));
        emit(boundaryEvent(new Date(1000)));
        emit(boundaryEvent(new Date(2000)));

        expect(logger.warn).toHaveBeenCalledWith({ min: 90, max: 10 }, 'Compaction threshold tuner: configured min exceeds max, collapsing band to compactThresholdPercent');
        expect(setThresholdPercent).not.toHaveBeenCalled();
    });

    it('does not warn, and honours the pinned value, when min===max is an explicit non-default pin', () => {
        // Distinguishes a deliberate single-value pin (90/90) from the misconfigured-and-collapsed
        // case above: `resolvedMin > resolvedMax` (90 > 90 is false) must NOT fire the inverted-band
        // warning, and the band must actually clamp to 90 -- not silently collapse to
        // compactThresholdPercent (60) the way a mutated `>=` guard would.
        build({ config: { ...DEFAULT_CONFIG, compactThresholdMinPercent: 90, compactThresholdMaxPercent: 90 } });

        emit(boundaryEvent(new Date(0)));
        emit(boundaryEvent(new Date(1000)));
        emit(boundaryEvent(new Date(2000)));

        expect(logger.warn).not.toHaveBeenCalled();
        expect(setThresholdPercent).toHaveBeenCalledWith(90);
    });

    describe('collapsed default (no new env vars set)', () => {
        const histories: { name: string, atsMs: number[] }[] = [
            { name: 'rapid successive compactions', atsMs: [0, 100, 250, 400] },
            { name: 'widely spaced compactions', atsMs: [0, 3_600_000, 10_800_000] },
            { name: 'a single compaction (no interval yet)', atsMs: [0] },
            { name: 'no compactions at all', atsMs: [] },
        ];

        it.each(histories)('$name never calls setThresholdPercent with a value different from compactThresholdPercent', ({ atsMs }) => {
            build();

            for(const atMs of atsMs) {
                emit(boundaryEvent(new Date(atMs)));
            }

            expect(setThresholdPercent).not.toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalled();
        });

        it('the same holds when a telemetry instance is supplied', () => {
            const records: CompactionTelemetryRecord[] = [
                { startedAt: new Date(0), thresholdAtStart: 60, finishedAt: new Date(50) },
                { startedAt: new Date(200), thresholdAtStart: 60, finishedAt: new Date(250) },
                { startedAt: new Date(300), thresholdAtStart: 60, finishedAt: new Date(350) },
            ];
            build({ telemetry: telemetryOf(records) });

            emit(boundaryEvent(new Date(50)));
            emit(boundaryEvent(new Date(250)));
            emit(boundaryEvent(new Date(350)));

            expect(setThresholdPercent).not.toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });
});
