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
 * (`jest.useFakeTimers()`) are out of scope for the creators they really fake: while they are
 * active those wrappers pass straight through without recording anything. That is decided PER
 * CREATOR KIND, not once for everything: a kind listed in `extras.realInFakeMode` (on Bun,
 * `setImmediate`, which the fake clock leaves real) keeps being tracked while fake timers are on.
 *
 * Ownership: a timer belongs to the test during which it was created. Concurrent tests
 * (`test.concurrent`) are NOT supported: the runner gives no per-test context, so a timer created
 * by one of several overlapping tests cannot be attributed to it. The guard therefore fails every
 * test that overlaps another (see {@link TimerGuard.hasConcurrentTests}); run such tests
 * sequentially. (Leaks from an overlapping group are still collected and cancelled once the last
 * test ends, so they cannot cascade into later tests.) Timers created before the first test of a
 * file (module scope, `beforeAll`) belong to the file and are reported at file teardown.
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
    setInterval:  (delay?: unknown, value?: unknown, options?: unknown) => AsyncIterable<unknown>
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
    nodeTimers?:     TimerGuardHost
    promiseTimers?:  PromiseTimersHost
    abortSignal?:    AbortSignalHost
    /** Lists the owners that are running right now */
    liveOwners?:     () => readonly LiveOwner[]
    /** Test seam: replaces the creation-stack capture (returns every frame, innermost first) */
    captureStack?:   () => string[]
    /**
     * Creator kinds whose timers stay REAL while fake timers are active, so they are still tracked
     * then. Default: none (every creator is faked). On Bun the fake clock covers every timeout and
     * interval creator but leaves `setImmediate` real.
     */
    realInFakeMode?: ReadonlySet<LeakedTimerKind>
    /**
     * Path fragments that mark a stack frame as project code (tests or source) rather than tooling.
     * Default `['/tests/', '/src/']`. Only used to refuse the boot-time tooling exemption, see
     * {@link STRYKER_PRELOAD_FRAME}.
     */
    ownCodeFrames?:  readonly string[]
}

/**
 * The Stryker bun runner's own preload creates an unref'd orphan-watchdog interval before any test
 * file loads. That is test-harness plumbing, not a timer a test created. It is exempt only while the
 * guard is still BOOTING (no test has started yet), only when the creating (first) frame is in that
 * preload file, and only when no frame anywhere in the creation stack is project code. A test (or a
 * test file's module scope) that calls the runner's `startOrphanWatchdog()` has its own file in the
 * stack, so it is tracked; nothing created after the first test starts is ever exempt.
 */
export const STRYKER_PRELOAD_FRAME = '/@hughescr/stryker-bun-runner/dist/coverage/preload-logic.js';

/** What may follow the preload file name in a frame: an optional `:line:col` and the closing paren of `at fn (...)`. */
const FRAME_LOCATION_TAIL = /^(?::\d+){0,2}\)?$/;

/** True when `frame` is exactly a frame in the runner's `preload-logic.js` (path-segment boundary before it, nothing but a location after it). */
function isStrykerPreloadFrame(frame: string | undefined): boolean {
    if(frame === undefined) {
        return false;
    }
    const at = frame.indexOf(STRYKER_PRELOAD_FRAME);
    return at !== -1 && FRAME_LOCATION_TAIL.test(frame.slice(at + STRYKER_PRELOAD_FRAME.length));
}

const DEFAULT_OWN_CODE_FRAMES: readonly string[] = ['/tests/', '/src/'];

export type LeakedTimerKind = 'setTimeout' | 'setInterval' | 'setImmediate' | 'Bun.sleep' | 'AbortSignal.timeout' | 'timers/promises.setTimeout' | 'timers/promises.setImmediate' | 'timers/promises.setInterval' | 'running-owner';

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
        .filter(line => line.length > 0 && !line.includes('helpers/leaked-timer-guard.ts') && !line.includes('tests/setup.ts'));
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

function abortError(): DOMException {
    return new DOMException('The operation was aborted', 'AbortError');
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
    /** Marks the start of a test. A test that starts while another is still running makes both "concurrent" (unsupported). */
    markTestStart(): void
    /**
     * Ends a test (`'test'`) or the file (`'file'`). Returns every still-pending timer and running
     * owner belonging to it, cancelling/stopping each so a leak is reported once and cannot cascade
     * into later tests; also forgets finished timers. For `'test'`, an empty result while other
     * overlapping tests are still running is "not yet attributable", not "clean" (such a group
     * fails anyway, see {@link TimerGuard.hasConcurrentTests}). `'file'` covers everything since
     * the previous file's teardown (module scope included) and starts the next file.
     */
    collectLeaks(scope: 'test' | 'file'): LeakedTimer[]
    /**
     * True for every test of a group of overlapping tests, from the moment the overlap is seen until
     * the next test that starts alone. Concurrent tests are unsupported (timers cannot be attributed
     * to one of them), so the caller fails each test while this is true.
     */
    hasConcurrentTests(): boolean
}

/** Why a test is failed for overlapping another test. */
export const CONCURRENT_TESTS_MESSAGE = 'Concurrent tests (test.concurrent / describe.concurrent) are not supported with the leaked-timer guard: a timer created by one of several overlapping tests cannot be attributed to it. Run these tests sequentially.';

/**
 * Builds a guard bound to `host`.
 * @param host Object whose timer creators are wrapped (the global object in production)
 * @param isFakeTimers True while fake timers are active; the creators they fake are then not recorded (kinds in `extras.realInFakeMode` still are)
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
    let groupOverlapped = false;
    // True until the first test starts: only then may the runner's own preload timers be exempt
    let booting = true;
    let tracked: TrackedTimer[] = [];
    const patches: (() => void)[] = [];
    const ownCodeFrames = extras.ownCodeFrames ?? DEFAULT_OWN_CODE_FRAMES;

    // Captured now, before install() replaces them, so tracked sleeps/deadlines use the real timers
    const rawSetTimeout = host.setTimeout;
    const rawClearTimeout = host.clearTimeout;
    const rawSetInterval = host.setInterval;
    const rawClearInterval = host.clearInterval;
    const rawSetImmediate = host.setImmediate;
    const rawClearImmediate = host.clearImmediate;

    /** True when a creator of `kind` currently makes a FAKE timer (so it is out of scope); real ones are tracked even while fake timers are on. */
    function isFaked(kind: LeakedTimerKind): boolean {
        return isFakeTimers() && extras.realInFakeMode?.has(kind) !== true;
    }

    function isTestHarnessBootTimer(stack: readonly string[]): boolean {
        if(!booting || !isStrykerPreloadFrame(stack[0])) {
            return false;
        }
        return !stack.some(frame => ownCodeFrames.some(own => frame.includes(own)));
    }

    function track(entry: Omit<TrackedTimer, 'seq' | 'stack'>): void {
        const stack = (extras.captureStack ?? captureStack)();
        if(isTestHarnessBootTimer(stack)) {
            return;
        }
        seq += 1;
        tracked.push({ ...entry, seq, stack: stack.slice(0, STACK_FRAMES_SHOWN) });
    }

    /** Runs `fire` on a real timer, interval or immediate that the guard tracks; returns how to cancel it. */
    function startTracked(kind: LeakedTimerKind, delayMs: number | undefined, how: 'timeout' | 'interval' | 'immediate', fire: () => void): () => void {
        const create = { timeout: rawSetTimeout, interval: rawSetInterval, immediate: rawSetImmediate }[how];
        const clear = { timeout: rawClearTimeout, interval: rawClearInterval, immediate: rawClearImmediate }[how];
        // An immediate has no delay; passing none keeps the (undefined) delay out of its callback arguments
        const handle = how === 'immediate' ? create(fire) : create(fire, delayMs);
        const cancel = (): void => {
            clear(handle);
        };
        track({ kind, delayMs, isPending: () => isHandlePending(handle), cancel });
        return cancel;
    }

    function wrapCreator(kind: Exclude<LeakedTimerKind, 'Bun.sleep' | 'AbortSignal.timeout' | 'running-owner' | `timers/promises.${string}`>, original: TimerCreator, cancel: TimerCanceller): TimerCreator {
        return (callback, delay, ...rest) => {
            const handle = original(callback, delay, ...rest);
            if(!isFaked(kind)) {
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
            if(isFaked('Bun.sleep') || ms === undefined) {
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
            if(isFaked('AbortSignal.timeout')) {
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

    /**
     * `timers/promises.setInterval` re-implemented on one tracked real interval. Ticks that arrive
     * while nobody is waiting are counted and handed out first (as Node does). `return()` (what
     * `break` in a `for await` calls) and an aborting signal both clear the interval; an abort
     * rejects the pending (or next) `next()` with an AbortError, after which the iterator is done.
     */
    function trackedInterval(delayMs: number | undefined, value: unknown, options: unknown): AsyncIterableIterator<unknown> {
        const signal = signalOf(options);
        const finished: IteratorResult<unknown> = { value: undefined, done: true };
        let waiting: PromiseWithResolvers<IteratorResult<unknown>> | undefined;
        let ticksNotYielded = 0;
        let ended = false;
        let abortPending = false;
        let cancel: (() => void) | undefined;

        const end = (): void => {
            ended = true;
            cancel?.();
            signal?.removeEventListener('abort', onAbort);
        };
        function onAbort(): void {
            end();
            if(waiting === undefined) {
                abortPending = true;
                return;
            }
            waiting.reject(abortError());
            waiting = undefined;
        }

        if(signal?.aborted === true) {
            ended = true;
            abortPending = true;
        } else {
            cancel = startTracked('timers/promises.setInterval', delayMs, 'interval', () => {
                if(waiting === undefined) {
                    ticksNotYielded += 1;
                    return;
                }
                waiting.resolve({ value, done: false });
                waiting = undefined;
            });
            signal?.addEventListener('abort', onAbort, { once: true });
        }

        return {
            async next(): Promise<IteratorResult<unknown>> {
                if(abortPending) {
                    abortPending = false;
                    throw abortError();
                }
                if(ended) {
                    return finished;
                }
                if(ticksNotYielded > 0) {
                    ticksNotYielded -= 1;
                    return { value, done: false };
                }
                waiting = Promise.withResolvers<IteratorResult<unknown>>();
                return waiting.promise;
            },
            async return(): Promise<IteratorResult<unknown>> {
                end();
                waiting?.resolve(finished);
                waiting = undefined;
                return finished;
            },
            [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
                return this;
            },
        };
    }

    function patchPromiseTimers(target: PromiseTimersHost): void {
        const originals = { setTimeout: target.setTimeout, setImmediate: target.setImmediate, setInterval: target.setInterval };
        target.setTimeout = async (delay, value, options) => {
            if(isFaked('timers/promises.setTimeout')) {
                return originals.setTimeout(delay, value, options);
            }
            return deferred('timers/promises.setTimeout', delayOf(delay), 'timeout', value, options);
        };
        target.setImmediate = async (value, options) => {
            if(isFaked('timers/promises.setImmediate')) {
                return originals.setImmediate(value, options);
            }
            return deferred('timers/promises.setImmediate', undefined, 'immediate', value, options);
        };
        target.setInterval = (delay, value, options) => {
            if(isFaked('timers/promises.setInterval')) {
                return originals.setInterval(delay, value, options);
            }
            return trackedInterval(delayOf(delay), value, options);
        };
        patches.push(() => {
            target.setTimeout = originals.setTimeout;
            target.setImmediate = originals.setImmediate;
            target.setInterval = originals.setInterval;
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
            booting = false;
            if(activeTests === 0) {
                groupOverlapped = false;
                groupStartSeq = seq + 1;
                groupBaseline = new Set((extras.liveOwners?.() ?? []).map(owner => owner.id));
            } else {
                groupOverlapped = true;
            }
            activeTests += 1;
        },

        hasConcurrentTests(): boolean {
            return groupOverlapped;
        },

        collectLeaks(scope): LeakedTimer[] {
            if(scope === 'file') {
                const leaks = collect(fileStartSeq, () => false);
                // The next file starts here: its module-scope timers count against it, and no test of this file is still "active"
                fileStartSeq = seq + 1;
                groupStartSeq = seq + 1;
                activeTests = 0;
                groupOverlapped = false;
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
