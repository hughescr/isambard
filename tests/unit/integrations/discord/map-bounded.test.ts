import { describe, expect, test } from 'bun:test';
import { mapBounded } from '@/integrations/discord/map-bounded';

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
        await Bun.sleep(0);
        expect(releases).toHaveLength(2);
        releases.shift()?.();
        await Bun.sleep(0);
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
                await Bun.sleep(0);
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
        await Bun.sleep(0);
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
});
