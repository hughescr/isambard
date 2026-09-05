/**
 * A manually-driven {@link Clock} for tests: no real timers anywhere. Time only moves when a
 * test calls {@link FakeClock.advance} or {@link FakeClock.runAll}; `setTimer`/`clearTimer` just
 * record intent against an internal, sorted queue.
 *
 * @module tests/helpers/fake-clock
 */
import type { Clock, TimerHandle } from '@/agent/session/types';

interface ScheduledTimer {
    readonly id: number
    fireAt:      number
    readonly fn: () => void
    cancelled:   boolean
    fired:       boolean
}

function toTimerHandle(id: number): TimerHandle {
    // boundary cast: TimerHandle is an opaque brand with no runtime shape (see src/agent/session/types.ts);
    // this wraps the fake's internal timer id, mirroring the real Clock's systemClock.ts cast.
    return id as unknown as TimerHandle;
}

function fromTimerHandle(handle: TimerHandle): number {
    // boundary cast: reversing the opaque TimerHandle brand back to the internal id
    return handle as unknown as number;
}

/** Manual fake implementation of {@link Clock}, keyed by (fireAt, insertion order). */
export class FakeClock implements Clock {
    private currentTime:     number;
    private nextId = 0;
    private readonly timers: ScheduledTimer[] = [];

    constructor(startAt = 0) {
        this.currentTime = startAt;
    }

    now = (): number => this.currentTime;

    setTimer = (fn: () => void, ms: number): TimerHandle => {
        const id = this.nextId;
        this.nextId += 1;
        this.timers.push({ id, fireAt: this.currentTime + ms, fn, cancelled: false, fired: false });
        return toTimerHandle(id);
    };

    clearTimer = (handle: TimerHandle): void => {
        const id = fromTimerHandle(handle);
        const timer = this.timers.find(t => t.id === id);
        if(timer !== undefined) {
            timer.cancelled = true;
        }
    };

    /**
     * Fires every due, uncancelled timer whose `fireAt` falls at or before `currentTime + ms`, in
     * (fireAt, insertion order); a timer scheduled by a firing callback is picked up by the same
     * pass when it too falls inside the window. `now()` ends up exactly `ms` past where it
     * started, even if the last fired timer's `fireAt` was earlier than that.
     */
    advance(ms: number): void {
        const targetTime = this.currentTime + ms;
        this.drainDueBy(targetTime);
        this.currentTime = targetTime;
    }

    /** Fires every pending timer, including ones scheduled by earlier callbacks, until none remain. */
    runAll(): void {
        this.drainDueBy(Number.POSITIVE_INFINITY);
    }

    /** Count of timers neither fired nor cancelled. */
    pending(): number {
        return this.timers.filter(t => !t.fired && !t.cancelled).length;
    }

    private drainDueBy(targetTime: number): void {
        for(;;) {
            const due = this.timers
                .filter(t => !t.fired && !t.cancelled && t.fireAt <= targetTime)
                .toSorted((a, b) => a.fireAt - b.fireAt || a.id - b.id);
            if(due.length === 0) {
                break;
            }
            const next = due[0];
            next.fired = true;
            this.currentTime = next.fireAt;
            next.fn();
        }
    }
}
