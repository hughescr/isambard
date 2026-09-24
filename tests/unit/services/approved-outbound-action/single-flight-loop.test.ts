import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { createSingleFlightLoop, type SingleFlightLoop } from '@/services/approved-outbound-action/single-flight-loop';
import type { ServiceLogger } from '@/services/types';

const BASE = 1000;
const MAX = 8000;

/** Enough microtask turns for a settled pass to reach its `.finally(settle)`. */
async function flush(): Promise<void> {
    for(let turn = 0; turn < 10; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the pass's promise chain.
        await Promise.resolve();
    }
}

describe('createSingleFlightLoop', () => {
    let passes: PromiseWithResolvers<number>[];
    let run: ReturnType<typeof mock<() => Promise<number>>>;
    let logger: ServiceLogger;
    let loop: SingleFlightLoop<number>;

    /** Resolve the pass at `index` with `value` (0 = no progress) and let it settle. */
    async function finish(index: number, value = 0): Promise<void> {
        passes[index].resolve(value);
        await flush();
    }

    beforeEach(() => {
        jest.useFakeTimers();
        passes = [];
        run = mock(() => {
            const pass = Promise.withResolvers<number>();
            passes.push(pass);
            return pass.promise;
        });
        logger = {
            debug: mock((): void => undefined),
            info:  mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
        };
        loop = createSingleFlightLoop({
            run,
            madeProgress:   result => result > 0,
            baseIntervalMs: BASE,
            maxIntervalMs:  MAX,
            logger,
            label:          'Test loop',
        });
    });

    afterEach(async () => {
        loop.stop();
        for(const pass of passes) {
            pass.resolve(0);
        }
        await flush();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('wake() before start() arms no timer and runs nothing', async () => {
        loop.wake();
        jest.advanceTimersByTime(BASE * 10);
        await flush();

        expect(jest.getTimerCount()).toBe(0);
        expect(run).not.toHaveBeenCalled();
    });

    test('start() runs the first pass at the base interval, not before', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE - 1);
        await flush();
        expect(run).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
    });

    test('start() while started leaves exactly one pending timer', () => {
        loop.start();
        loop.start();

        expect(jest.getTimerCount()).toBe(1);
    });

    test('start() while started keeps the first poll deadline instead of re-arming it', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE / 2);
        loop.start();
        jest.advanceTimersByTime(BASE / 2);
        await flush();

        expect(run).toHaveBeenCalledTimes(1);
    });

    test('wake() during a manual runOnce() keeps the pending poll timer and arms no immediate one', async () => {
        loop.start();
        void loop.runOnce();
        await flush();

        loop.wake();
        jest.advanceTimersByTime(1);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(1);

        await finish(0);
        jest.advanceTimersByTime(1);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('wake() while idle runs the pass on an immediate timer', async () => {
        loop.start();
        loop.wake();
        jest.advanceTimersByTime(0);
        await flush();

        expect(run).toHaveBeenCalledTimes(1);
    });

    test('wake() replaces the pending poll timer instead of adding one', () => {
        loop.start();
        loop.wake();

        expect(jest.getTimerCount()).toBe(1);
    });

    test('wake() during an in-flight pass never starts a concurrent pass and coalesces into one rerun', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);

        loop.wake();
        loop.wake();
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);

        await finish(0);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('coalesced rerun is followed by the backoff interval, not another immediate pass', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();
        loop.wake();
        await finish(0);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);

        await finish(1);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
        // wake() reset the interval to base; each of the two empty passes doubled it. (The
        // immediate timer is clamped to 1ms, so the boundaries are checked a step either side.)
        jest.advanceTimersByTime(BASE * 3);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(3);
    });

    test('wake() resets backoff to the base interval', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await finish(0);
        jest.advanceTimersByTime(BASE * 2);
        await finish(1);
        expect(run).toHaveBeenCalledTimes(2);

        // Interval is now 4x base. A wake runs at once and resets it, so the empty wake pass
        // doubles it to 2x base rather than 8x.
        loop.wake();
        jest.advanceTimersByTime(0);
        await finish(2);
        expect(run).toHaveBeenCalledTimes(3);

        jest.advanceTimersByTime(BASE * 1.5);
        await flush();
        expect(run).toHaveBeenCalledTimes(3);
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(4);
    });

    test('wake() after stop() arms no timer', () => {
        loop.start();
        loop.stop();
        loop.wake();

        expect(jest.getTimerCount()).toBe(0);
    });

    test('runOnce() during an in-flight timer pass returns the same pass without running again', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();

        const joined = loop.runOnce();
        await flush();
        expect(run).toHaveBeenCalledTimes(1);

        passes[0].resolve(7);
        expect(await joined).toBe(7);
    });

    test('runOnce() during an in-flight pass asks for a rerun once that pass settles', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();

        void loop.runOnce();
        await finish(0);
        jest.advanceTimersByTime(0);
        await flush();

        expect(run).toHaveBeenCalledTimes(2);
    });

    test('a timer firing during a manual runOnce() reruns once the manual pass resolves', async () => {
        loop.start();
        const manual = loop.runOnce();
        await flush();
        expect(run).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);

        await finish(0);
        expect(await manual).toBe(0);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('a timer firing during a manual runOnce() reruns once the manual pass rejects', async () => {
        loop.start();
        const manual = loop.runOnce();
        await flush();
        jest.advanceTimersByTime(BASE);
        await flush();

        passes[0].reject(new Error('list failed'));
        await expect(manual).rejects.toThrow('list failed');
        await flush();
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('wake() during a manual runOnce() reruns after it settles', async () => {
        loop.start();
        void loop.runOnce();
        await flush();

        loop.wake();
        await finish(0);
        jest.advanceTimersByTime(0);
        await flush();

        expect(run).toHaveBeenCalledTimes(2);
    });

    test('a manual runOnce() on an idle started loop keeps the single pending poll timer', async () => {
        loop.start();
        void loop.runOnce();
        await flush();
        await finish(0);

        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(BASE - 1);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('runOnce() on a loop that was never started arms no timer after it settles', async () => {
        const result = loop.runOnce();
        await flush();
        await finish(0, 3);

        expect(await result).toBe(3);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('stop() during a pass leaves no timer after it settles, even with a rerun requested', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();
        loop.wake();
        loop.stop();

        await finish(0);

        expect(jest.getTimerCount()).toBe(0);
    });

    test('timer firing during a pass left over from stop/start defers to a rerun instead of overlapping', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE); // pass 1 in flight
        await flush();
        loop.stop();
        loop.start();
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(BASE); // the new timer finds pass 1 still in flight
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        loop.stop();
        loop.start();
        expect(jest.getTimerCount()).toBe(1);

        await finish(0); // pass 1 settles and replaces the armed timer with the rerun
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(0);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);

        await finish(1);
        expect(jest.getTimerCount()).toBe(1);
    });

    test('a pass that makes progress resets the interval to base and logs the reset once', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await finish(0);
        (logger.debug as ReturnType<typeof mock>).mockClear();

        jest.advanceTimersByTime(BASE * 2);
        await finish(1, 5);

        expect(logger.debug).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith({ intervalMs: BASE }, 'Test loop poll interval reset to base');
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(3);
    });

    test('an empty pass doubles the interval up to the cap and logs only real changes', async () => {
        loop.start();
        let elapsed = BASE;
        for(const [index, interval] of [BASE * 2, BASE * 4, MAX, MAX].entries()) {
            jest.advanceTimersByTime(elapsed);
            // eslint-disable-next-line no-await-in-loop -- each pass must settle before the next timer is armed.
            await finish(index);
            elapsed = interval;
        }

        expect((logger.debug as ReturnType<typeof mock>).mock.calls).toEqual([
            [{ intervalMs: BASE * 2 }, 'Test loop poll interval extended'],
            [{ intervalMs: BASE * 4 }, 'Test loop poll interval extended'],
            [{ intervalMs: MAX }, 'Test loop poll interval extended'],
        ]);
    });

    test('a rejected timer pass is logged and polling continues at the same interval', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();
        passes[0].reject(new Error('boom'));
        await flush();

        expect(logger.debug).toHaveBeenCalledWith({ error: 'boom' }, 'Test loop poll tick threw unexpectedly; rescheduling');
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('a rejected timer pass with a non-Error value logs its string form', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();
        passes[0].reject('plain failure');
        await flush();

        expect(logger.debug).toHaveBeenCalledWith({ error: 'plain failure' }, 'Test loop poll tick threw unexpectedly; rescheduling');
    });

    test('a synchronously throwing run still settles and keeps polling', async () => {
        run.mockImplementationOnce(() => {
            throw new Error('sync boom');
        });
        loop.start();
        jest.advanceTimersByTime(BASE);
        await flush();

        expect(logger.debug).toHaveBeenCalledWith({ error: 'sync boom' }, 'Test loop poll tick threw unexpectedly; rescheduling');
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(BASE);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    test('start() after stop() resumes at the base interval', async () => {
        loop.start();
        jest.advanceTimersByTime(BASE);
        await finish(0);
        loop.stop();
        loop.start();

        jest.advanceTimersByTime(BASE - 1);
        await flush();
        expect(run).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await flush();
        expect(run).toHaveBeenCalledTimes(2);
    });
});
