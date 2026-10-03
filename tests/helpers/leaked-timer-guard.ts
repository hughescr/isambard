/**
 * Leaked real-timer guard. Wraps every real timer creator the runtime offers (the global
 * `setTimeout`/`setInterval`/`setImmediate`, the same three on `node:timers`, `Bun.sleep`,
 * `node:timers/promises`, and `AbortSignal.timeout`) so each REAL timer a test creates is
 * remembered with a short creation stack, and reports any that is still pending once the test
 * (or, at file scope, the test file) is over. A pending real timer after a test is a leak: it can
 * fire into a later test, keep the process alive, or hide a missing `stop()`/`clearTimeout()`.
 * It also checks "live owners" (running reconnection loops), which can leak with no timer armed.
 *
 * There is deliberately no allowlist and `unref()` does not exempt a timer. Fake timers
 * (`jest.useFakeTimers()`) are out of scope: while they are active the wrappers pass straight
 * through without recording anything.
 *
 * Ownership: a timer belongs to the test during which it was created. When tests overlap
 * (`test.concurrent`) the runner gives no per-test context, so the overlapping tests are treated
 * as one group: nothing is collected until the LAST overlapping test ends, and the failure is
 * reported on that last test (the creation stack still names the culprit). Timers created before
 * the first test of a file (module scope, `beforeAll`) belong to the file and are reported at
 * file teardown.
 *
 * "Pending" is read from the handle's own `_destroyed` flag, which Bun sets when a timer fires
 * (one-shot), is cleared via `clearTimeout`/`clearInterval`/`clearImmediate`, or is `close()`d.
 * That makes the guard independent of how the timer was cancelled. `Bun.sleep`,
 * `AbortSignal.timeout` and the promise timers are re-implemented on a real tracked timer so that
 * cancelling them truly cancels them (a cancelled sleep never resumes its caller).
 *
 * @module tests/helpers/leaked-timer-guard
 */

/** Signature shared by the global timer creators; only the first two arguments are inspected. */
type TimerCreator = (callback: unknown, delay?: unknown, ...rest: unknown[]) => unknown;
type TimerCanceller = (handle: unknown) => unknown;
type SleepFn = (duration: unknown) => Promise<unknown>;

/** The slice of the global object (and `node:timers`) the guard patches; injectable so it is unit-testable. */
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

/** `AbortSignal`'s patchable static deadline. */
export interface AbortSignalHost {
    timeout: (ms: number) => AbortSignal
}

/** The `node:timers/promises` creators the guard patches. */
export interface PromiseTimersHost {
    setTimeout:   (delay?: unknown, value?: unknown, options?: unknown) => Promise<unknown>
    setImmediate: (value?: unknown, options?: unknown) => Promise<unknown>
}

/** Something that can be running without any timer armed (e.g. a reconnection loop with an in-flight attempt). */
export interface LiveOwner {
    /** Stable identity, used to tell owners that predate a test from ones the test started */
    readonly id:    unknown
    readonly label: string
    /** Stops the owner so a leak is reported once and cannot cascade into later tests */
    stop():         void
}

/** Optional extra runtime surfaces the guard covers beyond the global timers. */
export interface TimerGuardExtras {
    nodeTimers?:    TimerGuardHost
    promiseTimers?: PromiseTimersHost
    abortSignal?:   AbortSignalHost
    /** Lists the owners that are running right now */
    liveOwners?:    () => readonly LiveOwner[]
    /** Test seam: replaces the creation-stack capture */
    captureStack?:  () => string[]
}

/**
 * The Stryker bun runner's own preload creates an unref'd orphan-watchdog interval before any test
 * file loads. That is test-harness plumbing, not a timer a test created, so a timer whose creating
 * (first) frame is in that preload is not tracked. This is not a test allowlist: only the exact
 * creating frame inside the runner's preload file qualifies, never a library called from test code.
 */
export const STRYKER_PRELOAD_FRAME = '@hughescr/stryker-bun-runner/dist/coverage/preload';

export type LeakedTimerKind = 'setTimeout' | 'setInterval' | 'setImmediate' | 'Bun.sleep' | 'AbortSignal.timeout' | 'timers/promises.setTimeout' | 'timers/promises.setImmediate' | 'running-owner';

/** One timer (or running owner) found still live at the end of its test. */
export interface LeakedTimer {
    readonly kind:    LeakedTimerKind
    readonly delayMs: number | undefined
    /** The first few caller frames at creation, guard frames removed */
    readonly stack:   readonly string[]
    /** Set for a running owner: its name */
    readonly label?:  string
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

/** How long to wait for a `Bun.sleep` argument, or undefined when it is not something this guard can schedule. */
function sleepMsOf(duration: unknown): number | undefined {
    const raw = duration instanceof Date ? duration.getTime() - Date.now() : duration;
    if(typeof raw !== 'number' || !Number.isFinite(raw)) {
        return undefined;
    }
    return Math.max(0, raw);
}

function signalOf(options: unknown): AbortSignal | undefined {
    if(typeof options !== 'object' || options === null) {
        return undefined;
    }
    const { signal } = options as { signal?: unknown };
    return signal instanceof AbortSignal ? signal : undefined;
}

/** Renders leaks as one failure message naming every offender's kind, delay and creation frames. */
export function formatLeakedTimers(leaks: readonly LeakedTimer[], scope: 'test' | 'file'): string {
    const where = scope === 'test' ? 'this test finished' : 'this test file finished';
    const lines = [`${leaks.length} leaked timer(s) or running owner(s) after ${where}. Every timer must be cleared (clearTimeout / clearInterval / stop()) or replaced with fake timers:`];
    for(const leak of leaks) {
        if(leak.label !== undefined) {
            lines.push(`  - ${leak.kind} "${leak.label}" is still running (stop() it)`);
            continue;
        }
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
    /** Restores every original creator. */
    uninstall(): void
    /** Marks the start of a test. Overlapping (concurrent) tests are treated as one group. */
    markTestStart(): void
    /**
     * Ends a test (`'test'`) or the file (`'file'`). Returns every still-pending timer and running
     * owner belonging to it, cancelling/stopping each so a leak is reported once and cannot cascade
     * into later tests; also forgets finished timers. For `'test'`, an empty result while other
     * overlapping tests are still running is "not yet attributable", not "clean". `'file'` covers
     * everything since the previous file's teardown (module scope included) and starts the next file.
     */
    collectLeaks(scope: 'test' | 'file'): LeakedTimer[]
}

/**
 * Builds a guard bound to `host`.
 * @param host Object whose timer creators are wrapped (the global object in production)
 * @param isFakeTimers True while fake timers are active, so the wrappers must not record
 * @param sleepHost Object whose `sleep` is wrapped too (`Bun` in production); omit to leave sleeping untracked
 * @param extras Further runtime surfaces to cover (node:timers, node:timers/promises, AbortSignal, live owners)
 * @returns The guard controls
 */
export function createTimerGuard(host: TimerGuardHost, isFakeTimers: () => boolean, sleepHost?: SleepHost, extras: TimerGuardExtras = {}): TimerGuard {
    let installed = false;
    let seq = 0;
    let activeTests = 0;
    let groupStartSeq = 0;
    let groupBaseline = new Set<unknown>();
    let fileStartSeq = 0;
    let tracked: TrackedTimer[] = [];
    const patches: (() => void)[] = [];

    // Captured now, before install() replaces them, so tracked sleeps/deadlines use the real timers
    const rawSetTimeout = host.setTimeout;
    const rawClearTimeout = host.clearTimeout;
    const rawSetImmediate = host.setImmediate;
    const rawClearImmediate = host.clearImmediate;

    function track(entry: Omit<TrackedTimer, 'seq' | 'stack'>): void {
        const stack = (extras.captureStack ?? captureStack)();
        if(stack[0]?.includes(STRYKER_PRELOAD_FRAME) === true) {
            return;
        }
        seq += 1;
        tracked.push({ ...entry, seq, stack });
    }

    /** Runs `fire` on a real timer or immediate that the guard tracks; returns how to cancel it. */
    function startTracked(kind: LeakedTimerKind, delayMs: number | undefined, how: 'timeout' | 'immediate', fire: () => void): () => void {
        const handle = how === 'timeout' ? rawSetTimeout(fire, delayMs) : rawSetImmediate(fire);
        const cancel = (): void => {
            if(how === 'timeout') {
                rawClearTimeout(handle);
            } else {
                rawClearImmediate(handle);
            }
        };
        track({ kind, delayMs, isPending: () => isHandlePending(handle), cancel });
        return cancel;
    }

    function wrapCreator(kind: Exclude<LeakedTimerKind, 'Bun.sleep' | 'AbortSignal.timeout' | 'running-owner' | `timers/promises.${string}`>, original: TimerCreator, cancel: TimerCanceller): TimerCreator {
        return (callback, delay, ...rest) => {
            const handle = original(callback, delay, ...rest);
            if(!isFakeTimers()) {
                track({
                    kind,
                    delayMs:   delayOf(delay),
                    isPending: () => isHandlePending(handle),
                    cancel:    () => { cancel(handle); },
                });
            }
            return handle;
        };
    }

    function patchCreators(target: TimerGuardHost): void {
        const originals = { setTimeout: target.setTimeout, setInterval: target.setInterval, setImmediate: target.setImmediate };
        target.setTimeout = wrapCreator('setTimeout', originals.setTimeout, target.clearTimeout);
        target.setInterval = wrapCreator('setInterval', originals.setInterval, target.clearInterval);
        target.setImmediate = wrapCreator('setImmediate', originals.setImmediate, target.clearImmediate);
        patches.push(() => {
            target.setTimeout = originals.setTimeout;
            target.setInterval = originals.setInterval;
            target.setImmediate = originals.setImmediate;
        });
    }

    function wrapSleep(original: SleepFn): SleepFn {
        return async (duration) => {
            const ms = sleepMsOf(duration);
            if(isFakeTimers() || ms === undefined) {
                return original(duration);
            }
            return new Promise<void>((resolve) => {
                // A cancelled sleep never resolves, so a leaked continuation cannot run into a later test
                startTracked('Bun.sleep', ms, 'timeout', resolve);
            });
        };
    }

    function wrapAbortTimeout(original: AbortSignalHost['timeout'], self: AbortSignalHost): AbortSignalHost['timeout'] {
        return (ms) => {
            if(isFakeTimers()) {
                return original.call(self, ms);
            }
            const controller = new AbortController();
            startTracked('AbortSignal.timeout', ms, 'timeout', () => {
                controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
            });
            return controller.signal;
        };
    }

    function deferred(kind: 'timers/promises.setTimeout' | 'timers/promises.setImmediate', delayMs: number | undefined, how: 'timeout' | 'immediate', value: unknown, options: unknown): Promise<unknown> {
        const signal = signalOf(options);
        if(signal?.aborted === true) {
            return Promise.reject(new DOMException('The operation was aborted', 'AbortError'));
        }
        return new Promise((resolve, reject) => {
            const timer: { cancel?: () => void } = {};
            const onAbort = (): void => {
                timer.cancel?.();
                reject(new DOMException('The operation was aborted', 'AbortError'));
            };
            timer.cancel = startTracked(kind, delayMs, how, () => {
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    function patchPromiseTimers(target: PromiseTimersHost): void {
        const originals = { setTimeout: target.setTimeout, setImmediate: target.setImmediate };
        target.setTimeout = async (delay, value, options) => {
            if(isFakeTimers()) {
                return originals.setTimeout(delay, value, options);
            }
            return deferred('timers/promises.setTimeout', delayOf(delay), 'timeout', value, options);
        };
        target.setImmediate = async (value, options) => {
            if(isFakeTimers()) {
                return originals.setImmediate(value, options);
            }
            return deferred('timers/promises.setImmediate', undefined, 'immediate', value, options);
        };
        patches.push(() => {
            target.setTimeout = originals.setTimeout;
            target.setImmediate = originals.setImmediate;
        });
    }

    function liveOwnerLeaks(isExcluded: (owner: LiveOwner) => boolean): TrackedTimer[] {
        const leaks: TrackedTimer[] = [];
        for(const owner of extras.liveOwners?.() ?? []) {
            if(isExcluded(owner)) {
                continue;
            }
            seq += 1;
            leaks.push({
                seq,
                kind:      'running-owner',
                delayMs:   undefined,
                stack:     [],
                label:     owner.label,
                isPending: () => true,
                cancel:    () => {
                    owner.stop();
                },
            });
        }
        return leaks;
    }

    function collect(since: number, isOwnerExcluded: (owner: LiveOwner) => boolean): LeakedTimer[] {
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
        leaks.push(...liveOwnerLeaks(isOwnerExcluded));
        for(const leak of leaks) {
            leak.cancel();
        }
        tracked = keep;
        return leaks;
    }

    return {
        install(): void {
            if(installed) {
                return;
            }
            installed = true;
            patchCreators(host);
            if(extras.nodeTimers !== undefined) {
                patchCreators(extras.nodeTimers);
            }
            if(sleepHost !== undefined) {
                const { sleep: originalSleep } = sleepHost;
                sleepHost.sleep = wrapSleep(originalSleep);
                patches.push(() => {
                    sleepHost.sleep = originalSleep;
                });
            }
            if(extras.abortSignal !== undefined) {
                const { abortSignal } = extras;
                const { timeout: originalTimeout } = abortSignal;
                abortSignal.timeout = wrapAbortTimeout(originalTimeout, abortSignal);
                patches.push(() => {
                    abortSignal.timeout = originalTimeout;
                });
            }
            if(extras.promiseTimers !== undefined) {
                patchPromiseTimers(extras.promiseTimers);
            }
        },

        uninstall(): void {
            installed = false;
            for(const restore of patches.splice(0)) {
                restore();
            }
        },

        markTestStart(): void {
            if(activeTests === 0) {
                groupStartSeq = seq + 1;
                groupBaseline = new Set((extras.liveOwners?.() ?? []).map(owner => owner.id));
            }
            activeTests += 1;
        },

        collectLeaks(scope): LeakedTimer[] {
            if(scope === 'file') {
                const leaks = collect(fileStartSeq, () => false);
                // The next file starts here: its module-scope timers count against it, and no test of this file is still "active"
                fileStartSeq = seq + 1;
                groupStartSeq = seq + 1;
                activeTests = 0;
                return leaks;
            }
            activeTests = Math.max(0, activeTests - 1);
            if(activeTests > 0) {
                return [];
            }
            return collect(groupStartSeq, owner => groupBaseline.has(owner.id));
        },
    };
}
