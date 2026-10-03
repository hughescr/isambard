import { describe, expect, it } from 'bun:test';
import { createTimerGuard, formatLeakedTimers, type SleepHost, type TimerGuardHost } from '../../helpers/leaked-timer-guard';

interface FakeHandle { _destroyed: boolean }

/** Host whose "native" creators hand back `{ _destroyed }` handles and whose cancellers flip the flag. */
function makeHost(): { host: TimerGuardHost, sleepHost: SleepHost, handles: FakeHandle[], resolveSleeps: () => void } {
    const handles: FakeHandle[] = [];
    const sleepResolvers: (() => void)[] = [];
    const create = (): FakeHandle => {
        const handle = { _destroyed: false };
        handles.push(handle);
        return handle;
    };
    const cancel = (handle: unknown): void => {
        (handle as FakeHandle)._destroyed = true;
    };
    return {
        host: {
            setTimeout:     create,
            setInterval:    create,
            setImmediate:   create,
            clearTimeout:   cancel,
            clearInterval:  cancel,
            clearImmediate: cancel,
        },
        sleepHost: {
            sleep: async () => new Promise<void>((resolve) => { sleepResolvers.push(resolve); }),
        },
        handles,
        resolveSleeps: () => {
            for(const resolve of sleepResolvers) {
                resolve();
            }
        },
    };
}

describe('createTimerGuard', () => {
    it('reports a pending setTimeout with kind, delay and a creation stack, then cancels it', () => {
        const { host, handles } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();

        host.setTimeout(() => undefined, 250);
        const leaks = guard.collectLeaks('test');

        expect(leaks).toHaveLength(1);
        expect(leaks[0]?.kind).toBe('setTimeout');
        expect(leaks[0]?.delayMs).toBe(250);
        expect(leaks[0]?.stack.some(frame => frame.includes('leaked-timer-guard.test.ts'))).toBe(true);
        expect(handles[0]?._destroyed).toBe(true);
        // reported once only
        expect(guard.collectLeaks('test')).toHaveLength(0);
    });

    it('does not report timers that were cleared or have fired', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();

        const cleared = host.setTimeout(() => undefined, 10);
        host.clearTimeout(cleared);
        const fired = host.setTimeout(() => undefined, 10) as { _destroyed: boolean };
        fired._destroyed = true;

        expect(guard.collectLeaks('test')).toHaveLength(0);
    });

    it('covers setInterval and setImmediate and keeps an interval pending until cleared', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();

        host.setInterval(() => undefined, 5);
        host.setImmediate(() => undefined);

        expect(guard.collectLeaks('test').map(leak => leak.kind)).toEqual(['setInterval', 'setImmediate']);
    });

    it('ignores timers created while fake timers are active', () => {
        const { host } = makeHost();
        let fake = true;
        const guard = createTimerGuard(host, () => fake);
        guard.install();
        guard.markTestStart();

        host.setTimeout(() => undefined, 5);
        fake = false;

        expect(guard.collectLeaks('test')).toHaveLength(0);
    });

    it('only counts timers created since the test start, but the file scope counts them all', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markFileStart();
        host.setTimeout(() => undefined, 1);
        guard.markTestStart();
        host.setTimeout(() => undefined, 2);

        expect(guard.collectLeaks('test').map(leak => leak.delayMs)).toEqual([2]);
        expect(guard.collectLeaks('file').map(leak => leak.delayMs)).toEqual([1]);
    });

    it('ignores timers created before the file start', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        host.setTimeout(() => undefined, 1);
        guard.markFileStart();

        expect(guard.collectLeaks('file')).toHaveLength(0);
    });

    it('tracks Bun.sleep until it settles', async () => {
        const { host, sleepHost, resolveSleeps } = makeHost();
        const guard = createTimerGuard(host, () => false, sleepHost);
        guard.install();
        guard.markTestStart();

        const slept = sleepHost.sleep(30);
        const leaks = guard.collectLeaks('test');
        expect(leaks.map(leak => `${leak.kind}:${String(leak.delayMs)}`)).toEqual(['Bun.sleep:30']);

        guard.markTestStart();
        const awaited = sleepHost.sleep(5);
        resolveSleeps();
        await awaited;
        await slept;
        expect(guard.collectLeaks('test')).toHaveLength(0);
    });

    it('install is idempotent and uninstall restores the originals', () => {
        const { host, sleepHost } = makeHost();
        const { setTimeout: originalSetTimeout } = host;
        const { sleep: originalSleep } = sleepHost;
        const guard = createTimerGuard(host, () => false, sleepHost);

        guard.install();
        const wrapped = host.setTimeout;
        guard.install();

        expect(host.setTimeout).toBe(wrapped);
        expect(wrapped).not.toBe(originalSetTimeout);

        guard.uninstall();

        expect(host.setTimeout).toBe(originalSetTimeout);
        expect(sleepHost.sleep).toBe(originalSleep);
    });
});

describe('formatLeakedTimers', () => {
    it('names the scope, kind, delay and every creation frame', () => {
        const message = formatLeakedTimers([
            { kind: 'setTimeout', delayMs: 30_000, stack: ['at navigate (src/x.ts:1:1)', 'at test (tests/y.test.ts:2:2)'] },
            { kind: 'setImmediate', delayMs: undefined, stack: [] },
        ], 'test');

        expect(message).toContain('2 real timer(s) still pending after this test finished');
        expect(message).toContain('setTimeout 30000ms, created at:');
        expect(message).toContain('at navigate (src/x.ts:1:1)');
        expect(message).toContain('at test (tests/y.test.ts:2:2)');
        expect(message).toContain('- setImmediate, created at:');
    });

    it('words the file scope differently', () => {
        expect(formatLeakedTimers([{ kind: 'setInterval', delayMs: 1, stack: [] }], 'file')).toContain('after this test file finished');
    });
});
