/* eslint-disable no-restricted-syntax -- this file exists to create each real timer creator under fake timers and see where it lands; every timer is either faked (discarded by useRealTimers) or awaited */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import nodeTimers from 'node:timers';
import * as promiseTimers from 'node:timers/promises';

/**
 * Pins the runtime fact tests/setup.ts's leaked-timer guard is configured around: under
 * `jest.useFakeTimers()` every timeout/interval creator is FAKE (it lands on the fake clock) and
 * every setImmediate is REAL (it does not). The guard stops tracking only the faked kinds, so if a
 * Bun upgrade changes either list this file fails and `realInFakeMode` in tests/setup.ts must be
 * updated to match; otherwise a real timer created under fake timers would slip past the guard.
 */
describe('which creators jest.useFakeTimers() really fakes', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const faked: readonly [string, () => unknown][] = [
        ['global setTimeout', () => setTimeout(() => undefined, 60_000)],
        ['global setInterval', () => setInterval(() => undefined, 60_000)],
        ['node:timers setTimeout', () => nodeTimers.setTimeout(() => undefined, 60_000)],
        ['node:timers setInterval', () => nodeTimers.setInterval(() => undefined, 60_000)],
        ['AbortSignal.timeout', () => AbortSignal.timeout(60_000)],
        ['Bun.sleep', async () => Bun.sleep(60_000)],
        ['timers/promises setTimeout', async () => promiseTimers.setTimeout(60_000)],
        ['timers/promises setInterval', () => promiseTimers.setInterval(60_000)],
    ];

    it.each(faked)('%s lands on the fake clock', (_name, create) => {
        const before = jest.getTimerCount();

        const created = create();
        if(created instanceof Promise) {
            created.catch(() => undefined);
        }

        expect(jest.getTimerCount()).toBeGreaterThan(before);
    });

    const real: readonly [string, () => unknown][] = [
        ['global setImmediate', () => setImmediate(() => undefined)],
        ['node:timers setImmediate', () => nodeTimers.setImmediate(() => undefined)],
        ['timers/promises setImmediate', async () => promiseTimers.setImmediate()],
    ];

    it.each(real)('%s stays real: it never reaches the fake clock', async (_name, create) => {
        const before = jest.getTimerCount();

        const created = create();

        expect(jest.getTimerCount()).toBe(before);
        // let the real immediate fire so the guard sees nothing pending at the end of this test
        await new Promise<void>((resolve) => {
            setImmediate(resolve);
        });
        await created;
    });
});
