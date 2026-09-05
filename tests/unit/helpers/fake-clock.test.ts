import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../helpers/fake-clock';

describe('FakeClock', () => {
    it('starts at epoch 0 by default', () => {
        const clock = new FakeClock();

        expect(clock.now()).toBe(0);
    });

    it('starts at a given epoch when provided', () => {
        const clock = new FakeClock(1000);

        expect(clock.now()).toBe(1000);
    });

    it('now() advances exactly by the advanced ms', () => {
        const clock = new FakeClock(100);

        clock.advance(50);

        expect(clock.now()).toBe(150);
    });

    it('fires a timer once its delay has elapsed', () => {
        const calls: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => calls.push('fired'), 100);

        clock.advance(100);

        expect(calls).toEqual(['fired']);
    });

    it('does not fire a timer before its delay has elapsed', () => {
        const calls: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => calls.push('fired'), 100);

        clock.advance(99);

        expect(calls).toEqual([]);
    });

    it('fires timers in fireAt order, then insertion order for ties', () => {
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => order.push('second-inserted-earlier-fire'), 50);
        clock.setTimer(() => order.push('first-inserted-same-fire'), 100);
        clock.setTimer(() => order.push('second-inserted-same-fire'), 100);

        clock.advance(100);

        expect(order).toEqual(['second-inserted-earlier-fire', 'first-inserted-same-fire', 'second-inserted-same-fire']);
    });

    it('fires a timer scheduled during a callback if it falls within the same advance window', () => {
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => {
            order.push('outer');
            clock.setTimer(() => order.push('inner'), 10);
        }, 50);

        clock.advance(100);

        expect(order).toEqual(['outer', 'inner']);
    });

    it('does not fire a timer scheduled during a callback if it falls outside the advance window', () => {
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => {
            order.push('outer');
            clock.setTimer(() => order.push('inner'), 200);
        }, 50);

        clock.advance(100);

        expect(order).toEqual(['outer']);
    });

    it('schedules a callback-nested timer relative to the currently firing timer, not the advance start', () => {
        // Outer fires at 50; inner is scheduled with a relative delay of 60 from inside outer's
        // callback, so its correct fireAt is 50 + 60 = 110 — past the advance(100) target of 100,
        // so it must NOT fire. If the firing loop failed to advance `now()` to the outer timer's
        // fireAt before invoking it, the inner timer would be scheduled from 0 instead of 50,
        // landing at fireAt 60 — inside the window — and firing when it should not.
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => {
            order.push('outer');
            clock.setTimer(() => order.push('inner'), 60);
        }, 50);

        clock.advance(100);

        expect(order).toEqual(['outer']);
    });

    it('now() reflects the firing timer\'s fireAt while its callback runs', () => {
        const clock = new FakeClock();
        let observedNow: number | undefined;
        clock.setTimer(() => {
            observedNow = clock.now();
        }, 50);

        clock.advance(100);

        expect(observedNow).toBe(50);
    });

    it('clearTimer cancels a pending timer so it never fires', () => {
        const calls: string[] = [];
        const clock = new FakeClock();
        const handle = clock.setTimer(() => calls.push('fired'), 100);
        clock.clearTimer(handle);

        clock.advance(1000);

        expect(calls).toEqual([]);
    });

    it('runAll drains every pending timer and pending() reaches 0', () => {
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => order.push('a'), 100);
        clock.setTimer(() => order.push('b'), 5000);

        expect(clock.pending()).toBe(2);

        clock.runAll();

        expect(order).toEqual(['a', 'b']);
        expect(clock.pending()).toBe(0);
    });

    it('runAll fires timers scheduled during a callback too', () => {
        const order: string[] = [];
        const clock = new FakeClock();
        clock.setTimer(() => {
            order.push('outer');
            clock.setTimer(() => order.push('inner'), 10);
        }, 50);

        clock.runAll();

        expect(order).toEqual(['outer', 'inner']);
        expect(clock.pending()).toBe(0);
    });

    it('pending() excludes cancelled timers', () => {
        const clock = new FakeClock();
        const handle = clock.setTimer(() => { /* noop */ }, 100);
        clock.setTimer(() => { /* noop */ }, 200);

        clock.clearTimer(handle);

        expect(clock.pending()).toBe(1);
    });
});
