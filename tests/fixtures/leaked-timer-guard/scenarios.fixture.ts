/* eslint-disable jest/expect-expect, sonarjs/assertions-in-tests -- each scenario deliberately asserts nothing: the leaked-timer guard's own afterEach is what must fail it */
/* eslint-disable no-restricted-syntax -- the point of this fixture is REAL leaked timers (and one real elapsed wait to prove a cancelled sleep never resumes) */
/**
 * Scenarios that MUST each fail under the leaked-timer guard in tests/setup.ts. This file is not
 * a `*.test.ts`, so a plain `bun test` never runs it; tests/integration/leaked-timer-guard-runner.test.ts
 * spawns a real `bun test` on it (so the real preload and real runtime timers are exercised) and
 * asserts that every scenario below was reported as a failure naming its leak.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import nodeTimers from 'node:timers';
import { setTimeout as promiseSetTimeout } from 'node:timers/promises';
import { createReconnectionLoop } from '../../../src/services/reconnection-loop';

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

    describe('concurrent overlap', () => {
        const gate = Promise.withResolvers<void>();

        test.concurrent('SCENARIO concurrent A leaks a timer until afterAll', async () => {
            pendingFixtureTimers.push(setTimeout(() => undefined, LEAK_MS + 6));
            await gate.promise;
        });

        test.concurrent('SCENARIO concurrent B releases A', () => {
            gate.resolve();
        });
    });
});
