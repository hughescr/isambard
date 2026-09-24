import type { ServiceLogger } from '../types';

/** Default poll interval for the approved-outbound-action loops. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Maximum poll interval after repeated passes that did nothing (5 minutes). */
export const MAX_POLL_INTERVAL_MS = 5 * 60_000;

export interface SingleFlightLoopDeps<T> {
    /** One pass of the loop's work. Never runs concurrently with itself. */
    run:            () => Promise<T>
    /** Whether a pass did work: progress resets the poll interval to base, none doubles it. */
    madeProgress:   (result: T) => boolean
    baseIntervalMs: number
    maxIntervalMs:  number
    logger:         ServiceLogger
    /** Prefix for the loop's debug log messages, e.g. `'Approved outbound action'`. */
    label:          string
}

export interface SingleFlightLoop<T> {
    /** Arm the poll timer at the base interval. A no-op while already started. */
    start:   () => void
    /** Cancel the poll timer. A pass already in flight finishes but schedules nothing. */
    stop:    () => void
    /**
     * Run a pass as soon as possible: on a zero-delay timer when idle, or straight after the
     * pass in flight. Also resets the poll interval to base. A no-op while stopped. Any number
     * of wakes during one pass coalesce into a single follow-up pass.
     */
    wake:    () => void
    /**
     * Run a pass now and return its result. If a pass is already in flight, returns that pass
     * instead of starting a second one, and (when started) a follow-up pass runs after it.
     */
    runOnce: () => Promise<T>
}

/**
 * A polling loop whose passes never overlap. Every pass — timer, wake or manual `runOnce()` —
 * starts in `beginRun()`, which is only reached after checking that no pass is in flight and
 * which records the new pass in the same synchronous step, so no timer, wake, start/stop or
 * caller can slip a second pass in between. The in-flight marker is cleared only when that pass
 * has settled. Every other trigger that finds a pass in flight only asks for a rerun, and every
 * pass — whoever started it — ends in `settle()`, which turns that request into a zero-delay
 * timer or, failing that, keeps the poll timer armed. `arm()` clears the previous timer before
 * setting a new one, so at most one timer is ever pending.
 */
export function createSingleFlightLoop<T>(deps: SingleFlightLoopDeps<T>): SingleFlightLoop<T> {
    const { run, madeProgress, baseIntervalMs, maxIntervalMs, logger, label } = deps;

    let stopped = true;
    let inFlight: Promise<T> | undefined;
    let rerunRequested = false;
    let currentIntervalMs = baseIntervalMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    function arm(delayMs: number): void {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            timeoutId = undefined;
            tick();
        }, delayMs);
    }

    function adjustInterval(result: T): void {
        if(madeProgress(result)) {
            if(currentIntervalMs !== baseIntervalMs) {
                logger.debug({ intervalMs: baseIntervalMs }, `${label} poll interval reset to base`);
            }
            currentIntervalMs = baseIntervalMs;
            return;
        }
        const next = Math.min(currentIntervalMs * 2, maxIntervalMs);
        if(next !== currentIntervalMs) {
            logger.debug({ intervalMs: next }, `${label} poll interval extended`);
        }
        currentIntervalMs = next;
    }

    function settle(): void {
        inFlight = undefined;
        if(stopped) {
            return;
        }
        if(rerunRequested) {
            rerunRequested = false;
            arm(0);
            return;
        }
        if(timeoutId === undefined) {
            arm(currentIntervalMs);
        }
    }

    function beginRun(): Promise<T> {
        // `run` starts on a microtask, after `inFlight` is recorded below, so even a `run` that
        // throws synchronously settles through `settle()` rather than before `inFlight` is set.
        const current = Promise.resolve()
            .then(run)
            .then((result) => {
                adjustInterval(result);
                return result;
            })
            .finally(settle);
        inFlight = current;
        return current;
    }

    function tick(): void {
        if(inFlight !== undefined) {
            rerunRequested = true;
            return;
        }
        beginRun().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            logger.debug({ error: message }, `${label} poll tick threw unexpectedly; rescheduling`);
        });
    }

    return {
        start: () => {
            if(!stopped) {
                return;
            }
            stopped = false;
            currentIntervalMs = baseIntervalMs;
            arm(baseIntervalMs);
        },

        stop: () => {
            stopped = true;
            clearTimeout(timeoutId);
            timeoutId = undefined;
        },

        wake: () => {
            if(stopped) {
                return;
            }
            currentIntervalMs = baseIntervalMs;
            if(inFlight !== undefined) {
                rerunRequested = true;
                return;
            }
            arm(0);
        },

        runOnce: () => {
            if(inFlight !== undefined) {
                rerunRequested = true;
                return inFlight;
            }
            return beginRun();
        },
    };
}
