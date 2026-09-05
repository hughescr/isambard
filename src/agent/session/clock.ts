/**
 * The real-time {@link Clock} implementation over `Date.now`/`setTimeout`/`clearTimeout`.
 * This is the only file under src/agent/session/ allowed to touch real timer primitives —
 * everything else takes a `Clock` and is driven by `tests/helpers/fake-clock.ts` in tests.
 *
 * @module agent/session/clock
 */
import type { Clock, TimerHandle } from './types';

type RealTimer = ReturnType<typeof setTimeout>;

function toTimerHandle(timer: RealTimer): TimerHandle {
    // boundary cast: TimerHandle is an opaque brand with no runtime shape; the real setTimeout return value passes through unchanged
    return timer as unknown as TimerHandle;
}

function fromTimerHandle(handle: TimerHandle): RealTimer {
    // boundary cast: reversing the opaque TimerHandle brand back to the real timer clearTimeout expects
    return handle as unknown as RealTimer;
}

export const systemClock: Clock = {
    now:        () => Date.now(),
    setTimer:   (fn, ms) => toTimerHandle(setTimeout(fn, ms)),
    clearTimer: (handle) => {
        clearTimeout(fromTimerHandle(handle));
    },
};
