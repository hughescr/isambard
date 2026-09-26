import { describe, expect, test } from 'bun:test';
import { mapBounded } from '@/integrations/discord/map-bounded';

// Drains pending promise continuations with no real timers. Admitting the next item costs
// several microtask hops (the mapper settles -> its `await` resumes -> the worker recurses
// into the next item), so a single `await Promise.resolve()` does not observe the hand-off.
// Over-draining is harmless: the drained chain is parked on a gate the test controls.
const flushMicrotasks = async (remaining = 16): Promise<void> => {
    if(remaining > 0) {
        await Promise.resolve();
        await flushMicrotasks(remaining - 1);
    }
};

describe('mapBounded', () => {
    test('limits in-flight work and returns results in input order', async () => {
        const releases: (() => void)[] = [];
        let inFlight = 0;
        let peak = 0;
        const pending = mapBounded([1, 2, 3, 4], 2, async (value) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            inFlight--;
            return value * 10;
        });

        expect(releases).toHaveLength(2);
        releases.shift()?.();
        await flushMicrotasks();
        expect(releases).toHaveLength(2);
        releases.shift()?.();
        await flushMicrotasks();
        releases.shift()?.();
        releases.shift()?.();

        expect(await pending).toEqual([10, 20, 30, 40]);
        expect(peak).toBe(2);
    });

    test('reports a failure before unrelated in-flight work settles and starts no more items', async () => {
        let release!: () => void;
        const started: number[] = [];
        const pending = mapBounded([1, 2, 3], 2, async (value) => {
            started.push(value);
            if(value === 1) {
                await Promise.resolve();
                throw new Error('failed');
            }
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return value;
        });
        await expect(pending).rejects.toThrow('failed');
        expect(started).toEqual([1, 2]);
        release();
        await flushMicrotasks();
        expect(started).toEqual([1, 2]);
    });
    test('rejects a sparse input instead of passing an absent item to the mapper', async () => {
        const sparse = [1];
        sparse.length = 3;
        sparse[2] = 3;
        const mapped: number[] = [];

        await expect(mapBounded(sparse, 1, async (value) => {
            mapped.push(value);
            return value;
        })).rejects.toThrow('Invariant violated in mapBounded: missing item at index 1');

        expect(mapped).toEqual([1]);
    });

    test('clamps a concurrency below one to a single worker instead of skipping the work', async () => {
        const seen: number[] = [];

        const results = await mapBounded([1, 2, 3], 0, async (value) => {
            seen.push(value);
            return value * 10;
        });

        expect(seen).toEqual([1, 2, 3]);
        expect(results).toEqual([10, 20, 30]);
    });

    test('admits the next item only after the previous one settles when concurrency is one', async () => {
        const started: number[] = [];
        const releases: (() => void)[] = [];
        const pending = mapBounded([1, 2], 1, async (value) => {
            started.push(value);
            await new Promise<void>((resolve) => {
                releases.push(resolve);
            });
            return value;
        });

        await flushMicrotasks();
        expect(started).toEqual([1]);

        releases.shift()?.();
        await flushMicrotasks();
        expect(started).toEqual([1, 2]);

        releases.shift()?.();
        expect(await pending).toEqual([1, 2]);
    });
});
