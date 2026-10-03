/**
 * Leaked real-timer guard. Wraps the global timer creators so every REAL timer a test creates is
 * remembered with a short creation stack, and reports any that is still pending once the test
 * (or, at file scope, the test file) is over. A pending real timer after a test is a leak: it can
 * fire into a later test, keep the process alive, or hide a missing `stop()`/`clearTimeout()`.
 *
 * There is deliberately no allowlist and `unref()` does not exempt a timer. Fake timers
 * (`jest.useFakeTimers()`) are out of scope: while they are active the wrapper passes straight
 * through without recording anything.
 *
 * "Pending" is read from the handle's own `_destroyed` flag, which Bun sets when a timer fires
 * (one-shot), is cleared via `clearTimeout`/`clearInterval`/`clearImmediate`, or is `close()`d.
 * That makes the guard independent of how the timer was cancelled.
 *
 * @module tests/helpers/leaked-timer-guard
 */

/** Signature shared by the global timer creators; only the first two arguments are inspected. */
type TimerCreator = (callback: unknown, delay?: unknown, ...rest: unknown[]) => unknown;
type TimerCanceller = (handle: unknown) => unknown;
type SleepFn = (duration: unknown) => Promise<unknown>;

/** The slice of the global object (and `Bun`) the guard patches; injectable so it is unit-testable. */
export interface TimerGuardHost {
    setTimeout:     TimerCreator
    setInterval:    TimerCreator
    setImmediate:   TimerCreator
    clearTimeout:   TimerCanceller
    clearInterval:  TimerCanceller
    clearImmediate: TimerCanceller
}

/** The `Bun` object's patchable sleep. */
export interface SleepHost {
    sleep: SleepFn
}

export type LeakedTimerKind = 'setTimeout' | 'setInterval' | 'setImmediate' | 'Bun.sleep';

/** One timer found still pending at the end of its test. */
export interface LeakedTimer {
    readonly kind:    LeakedTimerKind
    readonly delayMs: number | undefined
    /** The first few caller frames at creation, guard frames removed */
    readonly stack:   readonly string[]
}

interface TrackedTimer extends LeakedTimer {
    readonly seq:       number
    readonly isPending: () => boolean
    readonly cancel:    () => void
}

const STACK_FRAMES_SHOWN = 6;

/** Real timers expose `_destroyed`; it is true once fired, cleared or closed. */
function isHandlePending(handle: unknown): boolean {
    if(typeof handle !== 'object' || handle === null) {
        return false;
    }
    return (handle as { _destroyed?: unknown })._destroyed === false;
}

function captureStack(): string[] {
    const raw = new Error('timer created here').stack ?? '';
    return raw
        .split('\n')
        .slice(1)
        .map(line => line.trim())
        // The runner's own frames above a hook come back source-mapped onto tests/setup.ts's hook lines; they are noise
        .filter(line => line.length > 0 && !line.includes('helpers/leaked-timer-guard.ts') && !line.includes('tests/setup.ts'))
        .slice(0, STACK_FRAMES_SHOWN);
}

function delayOf(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/** Renders leaks as one failure message naming every offender's kind, delay and creation frames. */
export function formatLeakedTimers(leaks: readonly LeakedTimer[], scope: 'test' | 'file'): string {
    const where = scope === 'test' ? 'this test finished' : 'this test file finished';
    const lines = [`${leaks.length} real timer(s) still pending after ${where}. Every timer must be cleared (clearTimeout / clearInterval / stop()) or replaced with fake timers:`];
    for(const leak of leaks) {
        const delay = leak.delayMs === undefined ? '' : ` ${leak.delayMs}ms`;
        lines.push(`  - ${leak.kind}${delay}, created at:`);
        for(const frame of leak.stack) {
            lines.push(`      ${frame}`);
        }
    }
    return lines.join('\n');
}

/** The guard's controls; see {@link createTimerGuard}. */
export interface TimerGuard {
    /** Patches the host's timer creators. Idempotent. */
    install(): void
    /** Restores the host's original timer creators. */
    uninstall(): void
    /** Marks the start of a test: only timers created from here on count against it. */
    markTestStart(): void
    /** Marks the start of a test file: only timers created from here on count against it. */
    markFileStart(): void
    /**
     * Returns every still-pending timer created since the matching mark, cancelling each one so a
     * leak is reported once and cannot cascade into later tests; also forgets finished timers.
     */
    collectLeaks(scope: 'test' | 'file'): LeakedTimer[]
}

/**
 * Builds a guard bound to `host`.
 * @param host Object whose timer creators are wrapped (the global object in production)
 * @param isFakeTimers True while fake timers are active, so the wrapper must not record
 * @param sleepHost Object whose `sleep` is wrapped too (`Bun` in production); omit to leave sleeping untracked
 * @returns The guard controls
 */
export function createTimerGuard(host: TimerGuardHost, isFakeTimers: () => boolean, sleepHost?: SleepHost): TimerGuard {
    let installed = false;
    let seq = 0;
    let testStartSeq = 0;
    let fileStartSeq = 0;
    let tracked: TrackedTimer[] = [];

    const originals = {
        setTimeout:   host.setTimeout,
        setInterval:  host.setInterval,
        setImmediate: host.setImmediate,
        sleep:        sleepHost?.sleep,
    };

    function wrapCreator(kind: Exclude<LeakedTimerKind, 'Bun.sleep'>, original: TimerCreator, cancel: TimerCanceller): TimerCreator {
        return (callback, delay, ...rest) => {
            const handle = original(callback, delay, ...rest);
            if(!isFakeTimers()) {
                seq += 1;
                tracked.push({
                    seq,
                    kind,
                    delayMs:   delayOf(delay),
                    stack:     captureStack(),
                    isPending: () => isHandlePending(handle),
                    cancel:    () => { cancel(handle); },
                });
            }
            return handle;
        };
    }

    function wrapSleep(original: SleepFn): SleepFn {
        return async (duration) => {
            const sleeping = original(duration);
            if(!isFakeTimers()) {
                let settled = false;
                const markSettled = (): void => {
                    settled = true;
                };
                const watch = async (): Promise<void> => {
                    try {
                        await sleeping;
                    } catch{
                        // a rejected sleep is still over; the caller sees the rejection via `sleeping`
                    } finally {
                        markSettled();
                    }
                };
                void watch();
                seq += 1;
                tracked.push({
                    seq,
                    kind:      'Bun.sleep',
                    delayMs:   delayOf(duration),
                    stack:     captureStack(),
                    isPending: () => !settled,
                    cancel:    markSettled,
                });
            }
            return sleeping;
        };
    }

    return {
        install(): void {
            if(installed) {
                return;
            }
            installed = true;
            host.setTimeout = wrapCreator('setTimeout', originals.setTimeout, host.clearTimeout);
            host.setInterval = wrapCreator('setInterval', originals.setInterval, host.clearInterval);
            host.setImmediate = wrapCreator('setImmediate', originals.setImmediate, host.clearImmediate);
            if(sleepHost !== undefined && originals.sleep !== undefined) {
                sleepHost.sleep = wrapSleep(originals.sleep);
            }
        },

        uninstall(): void {
            installed = false;
            host.setTimeout = originals.setTimeout;
            host.setInterval = originals.setInterval;
            host.setImmediate = originals.setImmediate;
            if(sleepHost !== undefined && originals.sleep !== undefined) {
                sleepHost.sleep = originals.sleep;
            }
        },

        markTestStart(): void {
            testStartSeq = seq + 1;
        },

        markFileStart(): void {
            fileStartSeq = seq + 1;
        },

        collectLeaks(scope): LeakedTimer[] {
            const since = scope === 'test' ? testStartSeq : fileStartSeq;
            const leaks: TrackedTimer[] = [];
            const keep: TrackedTimer[] = [];
            for(const timer of tracked) {
                if(!timer.isPending()) {
                    continue;
                }
                if(timer.seq >= since) {
                    leaks.push(timer);
                } else {
                    keep.push(timer);
                }
            }
            for(const leak of leaks) {
                leak.cancel();
            }
            tracked = keep;
            return leaks;
        },
    };
}
