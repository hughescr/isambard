/**
 * #113: the single-flight memoization guard #41 left behind in `src/index.ts` (`let ... ??=`),
 * extracted so it is mutation-measured. `src/index.ts` stays out of the mutate glob, so these
 * tests exercise `createStartupChain` directly rather than through the composition root; the
 * wiring itself (that `src/index.ts` still calls `startSessions` with the same shape through the
 * extracted guard) is covered separately by `tests/unit/index.test.ts`.
 */
import { describe, test, expect, mock } from 'bun:test';
import { createStartupChain } from '@/app/startup-chain';

describe('createStartupChain', () => {
    test('reuses the pending promise', async () => {
        let resolveRun: () => void = () => undefined;
        const pending = new Promise<void>((resolve) => {
            resolveRun = resolve;
        });
        const run = mock(() => pending);

        const chain = createStartupChain(run);
        const first = chain();
        const second = chain();

        expect(run).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);

        resolveRun();
        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
    });

    test('reuses the settled promise after it resolves', async () => {
        const run = mock(async () => undefined);
        const chain = createStartupChain(run);

        await chain();
        await chain();

        expect(run).toHaveBeenCalledTimes(1);
    });

    test('still reuses the cached promise after it rejects - never retried', async () => {
        const run = mock(async () => {
            throw new Error('boom');
        });
        const chain = createStartupChain(run);

        await expect(chain()).rejects.toThrow('boom');
        await expect(chain()).rejects.toThrow('boom');

        expect(run).toHaveBeenCalledTimes(1);
    });

    test('a fresh createStartupChain() call gets an independent cache - a new lifecycle', async () => {
        const firstRun = mock(async () => undefined);
        const secondRun = mock(async () => undefined);

        const firstChain = createStartupChain(firstRun);
        const secondChain = createStartupChain(secondRun);
        await firstChain();
        await secondChain();

        expect(firstRun).toHaveBeenCalledTimes(1);
        expect(secondRun).toHaveBeenCalledTimes(1);
    });

    test('does not call run until the returned function is first invoked', () => {
        const run = mock(async () => undefined);

        createStartupChain(run);

        expect(run).not.toHaveBeenCalled();
    });
});
