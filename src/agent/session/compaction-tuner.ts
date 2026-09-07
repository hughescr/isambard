/**
 * Q11: nudges the live compaction threshold toward a configured target inter-compaction
 * interval, clamped to a configured band. With no new env vars set the band collapses to a
 * single value (`config.compactThresholdPercent`), so deployed behaviour is provably unchanged
 * -- see the "collapsed-default" tests in this module's test file.
 *
 * ## Interval source (binding reconciliation decision -- see the Q11 gap note)
 * `CompactionTelemetry.getRecords()` (Q4, `./compaction-telemetry.ts`) does not expose
 * precomputed intervals, only per-attempt `{startedAt, finishedAt?, failedAt?}` records. When
 * `telemetry` is supplied, this module derives millisecond intervals from consecutive *finished*
 * records' `startedAt` deltas, read fresh from `telemetry.getRecords()` every time a
 * `compact_boundary` event is observed. `createCompactionTelemetry`'s own `record()` runs
 * synchronously off the very same ledger event, so callers should subscribe `telemetry` to the
 * `ledgerStore` before constructing this tuner, so `getRecords()` already reflects the
 * just-finished compaction by the time this module's own subscriber callback runs.
 *
 * When `telemetry` is omitted, this module instead derives the same interval history itself by
 * tracking consecutive `compact_boundary` `sdk_frame` timestamps as they arrive on
 * `ledgerStore.subscribe`, seeded at construction from `ledgerStore.get().context.lastCompactionAt`
 * (an existing `Ledger.context` field, stamped by `ledger.ts` on the same event) so a compaction
 * that already completed before this tuner was created still supplies one endpoint of the first
 * interval, rather than needing two more live compactions to observe anything.
 *
 * ## Band resolution and the collapsed-default guarantee
 * `createCompactionThresholdTuner` resolves the band from `config`: `min`/`max` each
 * independently default to `config.compactThresholdPercent`, and `targetIntervalMs` defaults to
 * `Infinity`. A non-finite `targetIntervalMs` is an explicit no-op step in `computeTunedThreshold`
 * -- never a step (an unset target has nothing to compare an observed interval against, so it
 * must not behave like "every interval is shorter than target") -- and the result is still always
 * clamped to `[min, max]`. Together these two rules give the collapsed-default guarantee: with
 * `min === max === compactThresholdPercent` (the all-defaults case) the clamp alone forces every
 * computed value back to that single starting percentage, and with a widened band but no target
 * set, the no-op step does the same job without relying on the band being collapsed too --
 * deployed behaviour needs no special case anywhere in this module to stay unchanged with no new
 * env vars set. A misconfigured inverted band (`min > max`) is treated the same way (logged at
 * `warn`, then collapsed to `config.compactThresholdPercent` for that tuner instance) rather than
 * propagated into `computeTunedThreshold`, whose own contract is a plain `[min, max]` clamp with
 * no ordering guarantee on its own. A deliberate single-value pin (`min === max` at a value other
 * than `compactThresholdPercent`) is NOT treated as inverted (`resolvedMin > resolvedMax` is
 * false when they're equal) and is honoured, not collapsed.
 *
 * ## Trailing window
 * Both interval sources can retain more history than is relevant to current conditions (Q4's
 * telemetry buffer defaults to 50 records; the fallback tracker never evicts on its own). Only the
 * most recent {@link INTERVAL_HISTORY_WINDOW} intervals are ever passed to `computeTunedThreshold`,
 * so the tuner responds to how compactions are spaced NOW rather than being dragged toward a band
 * edge by a long-past burst and staying pinned there once conditions change.
 *
 * @module agent/session/compaction-tuner
 */
import type { Logger } from '@hughescr/logger';
import type { CompactionTelemetry } from './compaction-telemetry';
import type { LedgerStore } from './ledger';
import type { Clock } from './types';
import type { SessionConfig } from '@/config';

/** Default step, in percentage points, {@link computeTunedThreshold} moves per recompute. */
export const DEFAULT_STEP_PERCENT = 5;

/** The interval band {@link computeTunedThreshold} steps the threshold within, and the target it steps toward. */
export interface CompactionThresholdBand {
    /**
     * Desired interval, in ms, between compactions. A non-finite value (`Infinity`, the collapsed
     * default) makes {@link computeTunedThreshold} take an explicit no-op step -- it never counts
     * as "shorter than target" -- so an unset target is a no-op even in a widened band, not only
     * when paired with the collapsed `min === max` default.
     */
    targetIntervalMs: number
    min:              number
    max:              number
    /** Percentage points moved per recompute. Defaults to {@link DEFAULT_STEP_PERCENT}. */
    stepPercent?:     number
}

/** Dependencies {@link createCompactionThresholdTuner} needs. */
export interface CreateCompactionThresholdTunerParams {
    ledgerStore:         Pick<LedgerStore, 'subscribe' | 'get'>
    /** Q4's compaction telemetry, when available -- see the module doc's interval-source decision. */
    telemetry?:          CompactionTelemetry
    config:              SessionConfig
    getThresholdPercent: () => number
    setThresholdPercent: (percent: number) => void
    clock:               Clock
    logger:              Pick<Logger, 'info' | 'debug' | 'warn'>
}

function median(values: readonly number[]): number {
    const sorted = [...values].toSorted((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
        : (sorted[mid] ?? 0);
}

/**
 * Pure step-and-clamp: fewer than two observed intervals leaves `currentPercent` unchanged
 * (nothing to compare against yet). Otherwise the median of `intervalsMs` is compared against
 * `band.targetIntervalMs` to decide one bounded step (shorter-than-target raises, longer-than
 * lowers, equal is a no-op step), and the result is always clamped to `[band.min, band.max]`.
 * @param intervalsMs Observed inter-compaction intervals, in ms.
 * @param currentPercent The threshold currently in effect.
 * @param band See {@link CompactionThresholdBand}.
 * @returns The tuned threshold percentage.
 */
export function computeTunedThreshold(intervalsMs: readonly number[], currentPercent: number, band: CompactionThresholdBand): number {
    if(intervalsMs.length < 2) {
        return currentPercent;
    }

    const { targetIntervalMs, min, max, stepPercent = DEFAULT_STEP_PERCENT } = band;

    // A non-finite (unset/`Infinity`) target has no interval it could compare against, so it is
    // an explicit no-op step -- never "shorter than target" -- rather than the vacuously-true
    // comparison `observedMs < Infinity` would otherwise produce. The result is still clamped
    // below: a widened band with an out-of-band `currentPercent` still gets pulled back in.
    let stepped = currentPercent;
    if(Number.isFinite(targetIntervalMs)) {
        const observedMs = median(intervalsMs);
        if(observedMs < targetIntervalMs) {
            stepped = currentPercent + stepPercent;
        } else if(observedMs > targetIntervalMs) {
            stepped = currentPercent - stepPercent;
        }
    }

    return Math.min(max, Math.max(min, stepped));
}

/** How many of the most recent observed intervals feed {@link computeTunedThreshold} -- see the module doc's "Trailing window" section. */
export const INTERVAL_HISTORY_WINDOW = 5;

function intervalsFromFinishedRecords(telemetry: CompactionTelemetry): number[] {
    const finishedStarts = telemetry.getRecords()
        .filter(record => record.finishedAt !== undefined)
        .map(record => record.startedAt.getTime());

    const intervals: number[] = [];
    for(let i = 1; i < finishedStarts.length; i += 1) {
        intervals.push(finishedStarts[i]! - finishedStarts[i - 1]!);
    }
    return intervals;
}

/**
 * Subscribes to `ledgerStore` and recomputes the tuned threshold on every observed
 * `compact_boundary` `sdk_frame` event (the only event that can change either interval source --
 * see the module doc), calling `setThresholdPercent` only when the computed value differs from
 * `getThresholdPercent()`'s current answer.
 * @param params See {@link CreateCompactionThresholdTunerParams}.
 * @returns An unsubscribe function; call it once at shutdown so a torn-down conductor's ledger
 * can never drive a stray `setThresholdPercent` call afterward.
 */
export function createCompactionThresholdTuner(params: CreateCompactionThresholdTunerParams): () => void {
    const { ledgerStore, telemetry, config, getThresholdPercent, setThresholdPercent, clock, logger } = params;

    let resolvedMin = config.compactThresholdMinPercent ?? config.compactThresholdPercent;
    let resolvedMax = config.compactThresholdMaxPercent ?? config.compactThresholdPercent;
    if(resolvedMin > resolvedMax) {
        logger.warn({ min: resolvedMin, max: resolvedMax }, 'Compaction threshold tuner: configured min exceeds max, collapsing band to compactThresholdPercent');
        resolvedMin = config.compactThresholdPercent;
        resolvedMax = config.compactThresholdPercent;
    }
    const band: CompactionThresholdBand = {
        targetIntervalMs: config.compactTargetIntervalMs ?? Number.POSITIVE_INFINITY,
        min:              resolvedMin,
        max:              resolvedMax,
    };

    // Fallback interval tracking, used only when `telemetry` is not supplied -- see module doc.
    let lastBoundaryAtMs: number | undefined = telemetry === undefined
        ? ledgerStore.get().context.lastCompactionAt?.getTime()
        : undefined;
    const fallbackIntervalsMs: number[] = [];

    return ledgerStore.subscribe((_ledger, event) => {
        if(!(event.type === 'sdk_frame' && event.frame.type === 'system' && event.frame.subtype === 'compact_boundary')) {
            return;
        }

        let intervalsMs: readonly number[];
        if(telemetry === undefined) {
            const boundaryAtMs = event.at.getTime();
            if(lastBoundaryAtMs !== undefined) {
                fallbackIntervalsMs.push(boundaryAtMs - lastBoundaryAtMs);
                if(fallbackIntervalsMs.length > INTERVAL_HISTORY_WINDOW) {
                    // Bound memory the same way the window bounds relevance -- an unbounded
                    // process lifetime should never grow this array without limit.
                    fallbackIntervalsMs.shift();
                }
            }
            lastBoundaryAtMs = boundaryAtMs;
            intervalsMs = fallbackIntervalsMs;
        } else {
            intervalsMs = intervalsFromFinishedRecords(telemetry).slice(-INTERVAL_HISTORY_WINDOW);
        }

        const currentPercent = getThresholdPercent();
        const tuned = computeTunedThreshold(intervalsMs, currentPercent, band);
        if(tuned === currentPercent) {
            logger.debug({ intervalsMs, currentPercent, at: new Date(clock.now()) }, 'Compaction threshold tuner: no change');
            return;
        }
        logger.info({ from: currentPercent, to: tuned, at: new Date(clock.now()) }, 'Compaction threshold tuner: adjusting threshold');
        setThresholdPercent(tuned);
    });
}
