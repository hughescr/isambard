/* eslint-disable jest/expect-expect, sonarjs/assertions-in-tests -- each scenario deliberately asserts nothing: the leaked-timer guard's own afterEach is what must fail it */
/* eslint-disable no-restricted-syntax -- the point of this fixture is REAL leaked timers (and one real elapsed wait to prove a cancelled sleep never resumes) */
/**
 * Scenarios that MUST each fail under the leaked-timer guard in tests/setup.ts, plus a few that
 * must PASS (they exercise the same creators but clean up). This file is not a `*.test.ts`, so a
 * plain `bun test` never runs it; tests/integration/leaked-timer-guard-runner.test.ts spawns a
 * real `bun test` on it (so the real preload and real runtime timers are exercised) and asserts
 * exactly which scenarios were reported as failures, and that each names its leak.
 */
import { afterAll, describe, expect, jest, test } from 'bun:test';
import { createRequire } from 'node:module';
import nodeTimers from 'node:timers';
import { setInterval as promiseSetInterval, setTimeout as promiseSetTimeout } from 'node:timers/promises';
import { createReconnectionLoop } from '../../../src/services/reconnection-loop';

// The runner's preload logic is not an exported entry point, so reach it by path (as the guard's own exemption names it)
const requireModule = createRequire(import.meta.url);
const { startOrphanWatchdog } = requireModule('../../../node_modules/@hughescr/stryker-bun-runner/dist/coverage/preload-logic.js') as {
    startOrphanWatchdog: (deps: { getPpid: () => number, onOrphaned: () => void, intervalMs?: number }) => () => void
};

const LEAK_MS = 60_000;

const pendingFixtureTimers: ReturnType<typeof setTimeout>[] = [];
afterAll(() => {
    for(const handle of pendingFixtureTimers) {
        clearTimeout(handle);
    }
});

// Module scope: created before any test of this file starts, and deliberately NOT cleaned up by this
// file's afterAll; the guard must report (and cancel) it at file teardown.
setTimeout(() => undefined, LEAK_MS + 1);

describe('scenarios', () => {
    test('SCENARIO global setTimeout leak', () => {
        pendingFixtureTimers.push(setTimeout(() => undefined, LEAK_MS + 2));
    });

    test('SCENARIO node:timers setTimeout leak', () => {
        pendingFixtureTimers.push(nodeTimers.setTimeout(() => undefined, LEAK_MS + 3));
    });

    test('SCENARIO node:timers/promises setTimeout leak', () => {
        void promiseSetTimeout(LEAK_MS + 4).catch(() => undefined);
    });

    test('SCENARIO AbortSignal.timeout leak', () => {
        AbortSignal.timeout(LEAK_MS + 5);
    });

    let sleepContinued = false;
    const sleepThenFlag = async (): Promise<void> => {
        await Bun.sleep(30);
        sleepContinued = true;
    };
    test('SCENARIO Bun.sleep leak', () => {
        void sleepThenFlag();
    });

    test('SCENARIO a cancelled leaked Bun.sleep never resumes its caller', async () => {
        await new Promise<void>((resolve) => {
            nodeTimers.setTimeout(resolve, 60);
        });
        expect(sleepContinued).toBe(false);
    });

    test('SCENARIO reconnection loop left running with an attempt in flight', () => {
        const loop = createReconnectionLoop({
            service:   'discord',
            registry:  { sendEvent: () => undefined },
            connectFn: async () => Promise.withResolvers<void>().promise,
        });
        loop.start();
    });

    // Fake timers fake every timeout/interval creator on Bun but leave setImmediate real, so this one must still be caught
    // eslint-disable-next-line @hughescr/test-hygiene/require-fake-timers-cleanup -- the leak under test is created while fake timers are on; the preload's afterEach restores real timers before it inspects the test
    test('SCENARIO setImmediate created under fake timers leak', () => {
        jest.useFakeTimers();
        setImmediate(() => undefined);
    });

    test('SCENARIO timers/promises setInterval leak', () => {
        const ticks = promiseSetInterval(LEAK_MS + 7);
        void ticks[Symbol.asyncIterator]().next().catch(() => undefined);
    });

    test('SCENARIO timers/promises setInterval stopped by return() passes', async () => {
        const iterator = promiseSetInterval(LEAK_MS + 8)[Symbol.asyncIterator]();
        const pending = iterator.next();
        await iterator.return?.();
        const result = await pending;
        expect(result.done).toBe(true);
    });

    test('SCENARIO timers/promises setInterval stopped by its AbortSignal passes', async () => {
        const controller = new AbortController();
        const pending = promiseSetInterval(LEAK_MS + 9, undefined, { signal: controller.signal })[Symbol.asyncIterator]().next();
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    // The runner's preload exemption is for its own boot-time watchdog only; a test that starts one is a leak
    test('SCENARIO runner preload watchdog started by a test leak', () => {
        startOrphanWatchdog({ getPpid: () => process.ppid, onOrphaned: () => undefined, intervalMs: LEAK_MS + 10 });
    });

    test('SCENARIO runner preload watchdog started and stopped by a test passes', () => {
        const stop = startOrphanWatchdog({ getPpid: () => process.ppid, onOrphaned: () => undefined, intervalMs: LEAK_MS + 11 });
        stop();
    });

    // Concurrent tests cannot be attributed, so BOTH must fail (even B, which leaks nothing)
    describe('concurrent overlap', () => {
        // Each waits for the other, so they overlap whichever order the (randomized) runner starts them in
        const aStarted = Promise.withResolvers<void>();
        const bFinished = Promise.withResolvers<void>();

        test.concurrent('SCENARIO concurrent A leaks a timer until afterAll', async () => {
            pendingFixtureTimers.push(setTimeout(() => undefined, LEAK_MS + 6));
            aStarted.resolve();
            await bFinished.promise;
        });

        test.concurrent('SCENARIO concurrent B releases A', async () => {
            await aStarted.promise;
            bFinished.resolve();
        });
    });

    test('SCENARIO a plain test passes (the concurrent flag does not stick to it)', () => undefined);
});
