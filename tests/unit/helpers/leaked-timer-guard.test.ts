import { describe, expect, it } from 'bun:test';
import { createTimerGuard, formatLeakedTimers, type AbortSignalHost, type LiveOwner, type PromiseTimersHost, type SleepHost, type TimerGuardHost } from '../../helpers/leaked-timer-guard';

interface FakeHandle { _destroyed: boolean, callback: unknown }

/** Host whose "native" creators hand back `{ _destroyed }` handles and whose cancellers flip the flag. */
function makeHost(): { host: TimerGuardHost, sleepHost: SleepHost, handles: FakeHandle[], fire: (index: number) => void, sleepCalls: unknown[] } {
    const handles: FakeHandle[] = [];
    const sleepCalls: unknown[] = [];
    const create = (callback: unknown): FakeHandle => {
        const handle = { _destroyed: false, callback };
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
            sleep: async (duration) => {
                sleepCalls.push(duration);
            },
        },
        handles,
        sleepCalls,
        fire: (index) => {
            const handle = handles.at(index);
            if(handle === undefined) {
                throw new Error(`no handle ${String(index)}`);
            }
            handle._destroyed = true;
            (handle.callback as () => void)();
        },
    };
}

function makeOwners(...labels: string[]): { owners: LiveOwner[], stopped: string[] } {
    const stopped: string[] = [];
    const owners = labels.map((label): LiveOwner => ({
        id:   label,
        label,
        stop: () => {
            stopped.push(label);
        },
    }));
    return { owners, stopped };
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

    it('only counts timers created since the test start, but the file scope counts the earlier ones too', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        host.setTimeout(() => undefined, 1);
        guard.markTestStart();
        host.setTimeout(() => undefined, 2);

        expect(guard.collectLeaks('test').map(leak => leak.delayMs)).toEqual([2]);
        expect(guard.collectLeaks('file').map(leak => leak.delayMs)).toEqual([1]);
    });

    it('reports a timer created at module scope (before any test started) at file teardown', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        host.setTimeout(() => undefined, 60_000);
        guard.markTestStart();

        expect(guard.collectLeaks('test')).toHaveLength(0);
        expect(guard.collectLeaks('file').map(leak => leak.delayMs)).toEqual([60_000]);
    });

    it('starts the next file fresh after file teardown, including its module-scope timers', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        host.setTimeout(() => undefined, 1);
        expect(guard.collectLeaks('file')).toHaveLength(1);

        host.setTimeout(() => undefined, 2);

        expect(guard.collectLeaks('file').map(leak => leak.delayMs)).toEqual([2]);
    });

    it('holds a leak from overlapping concurrent tests until the last of them ends, then reports it', () => {
        const { host, handles } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();

        guard.markTestStart();
        host.setTimeout(() => undefined, 60_000);
        guard.markTestStart();

        // the first test ends while the second is still running: the leak is not yet attributable
        expect(guard.collectLeaks('test')).toHaveLength(0);
        expect(handles[0]?._destroyed).toBe(false);

        // the last overlapping test ends: the timer that outlived its creator is reported
        expect(guard.collectLeaks('test').map(leak => leak.delayMs)).toEqual([60_000]);
        expect(handles[0]?._destroyed).toBe(true);
    });

    it('does not hold anything back when tests run one after another', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();

        guard.markTestStart();
        host.setTimeout(() => undefined, 1);
        expect(guard.collectLeaks('test')).toHaveLength(1);

        guard.markTestStart();
        expect(guard.collectLeaks('test')).toHaveLength(0);
    });

    it('treats an unbalanced test end as a plain test end rather than going negative', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();
        guard.collectLeaks('test');
        guard.collectLeaks('test');

        guard.markTestStart();
        host.setTimeout(() => undefined, 3);

        expect(guard.collectLeaks('test').map(leak => leak.delayMs)).toEqual([3]);
    });

    it('recovers from a test whose end hook never ran: file teardown resets the overlap count', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();
        guard.markTestStart();
        guard.collectLeaks('file');

        guard.markTestStart();
        host.setTimeout(() => undefined, 4);

        expect(guard.collectLeaks('test').map(leak => leak.delayMs)).toEqual([4]);
    });

    it('tracks node:timers creators the same way as the global ones', () => {
        const { host } = makeHost();
        const { host: nodeTimers, handles } = makeHost();
        const guard = createTimerGuard(host, () => false, undefined, { nodeTimers });
        guard.install();
        guard.markTestStart();

        nodeTimers.setTimeout(() => undefined, 7);
        nodeTimers.setInterval(() => undefined, 8);
        nodeTimers.setImmediate(() => undefined);

        expect(guard.collectLeaks('test').map(leak => leak.kind)).toEqual(['setTimeout', 'setInterval', 'setImmediate']);
        expect(handles.every(handle => handle._destroyed)).toBe(true);
    });

    describe('Bun.sleep', () => {
        it('really schedules the sleep on a tracked timer and resolves the caller when it fires', async () => {
            const { host, sleepHost, handles, fire, sleepCalls } = makeHost();
            const guard = createTimerGuard(host, () => false, sleepHost);
            guard.install();
            guard.markTestStart();

            const slept = sleepHost.sleep(30);
            expect(handles).toHaveLength(1);
            expect(handles[0]?._destroyed).toBe(false);
            fire(0);
            await slept;

            expect(sleepCalls).toHaveLength(0);
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('reports a pending sleep and cancels it so its continuation never runs', async () => {
            const { host, sleepHost, handles } = makeHost();
            const guard = createTimerGuard(host, () => false, sleepHost);
            guard.install();
            guard.markTestStart();

            let continued = false;
            const sleepThenFlag = async (): Promise<void> => {
                await sleepHost.sleep(30);
                continued = true;
            };
            void sleepThenFlag();
            const leaks = guard.collectLeaks('test');

            expect(leaks.map(leak => `${leak.kind}:${String(leak.delayMs)}`)).toEqual(['Bun.sleep:30']);
            expect(handles[0]?._destroyed).toBe(true);
            await Promise.resolve();
            expect(continued).toBe(false);
        });

        it('sleeps until a Date, clamped at zero for a Date in the past', () => {
            const { host, sleepHost, handles } = makeHost();
            const delays: unknown[] = [];
            const trackingHost: TimerGuardHost = {
                ...host,
                setTimeout: (callback, delay) => {
                    delays.push(delay);
                    return host.setTimeout(callback, delay);
                },
            };
            const guard = createTimerGuard(trackingHost, () => false, sleepHost);
            guard.install();
            guard.markTestStart();

            void sleepHost.sleep(new Date(Date.now() - 10_000));
            void sleepHost.sleep(new Date(Date.now() + 5000));

            expect(delays[0]).toBe(0);
            expect(delays[1]).toBeGreaterThan(4000);
            expect(delays[1]).toBeLessThanOrEqual(5000);
            expect(handles).toHaveLength(2);
        });

        it('hands arguments it cannot schedule (not a finite number or Date) to the real sleep untracked', async () => {
            const { host, sleepHost, handles, sleepCalls } = makeHost();
            const guard = createTimerGuard(host, () => false, sleepHost);
            guard.install();
            guard.markTestStart();

            await sleepHost.sleep('soon');
            await sleepHost.sleep(Number.NaN);

            expect(sleepCalls).toEqual(['soon', Number.NaN]);
            expect(handles).toHaveLength(0);
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('passes straight through to the real sleep while fake timers are active', async () => {
            const { host, sleepHost, handles, sleepCalls } = makeHost();
            const guard = createTimerGuard(host, () => true, sleepHost);
            guard.install();
            guard.markTestStart();

            await sleepHost.sleep(30);

            expect(sleepCalls).toEqual([30]);
            expect(handles).toHaveLength(0);
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });
    });

    describe('AbortSignal.timeout', () => {
        function makeAbortHost(): { abortSignal: AbortSignalHost, nativeCalls: number[] } {
            const nativeCalls: number[] = [];
            return {
                abortSignal: {
                    timeout: (ms) => {
                        nativeCalls.push(ms);
                        return new AbortController().signal;
                    },
                },
                nativeCalls,
            };
        }

        it('aborts the returned signal with a TimeoutError when its tracked timer fires', () => {
            const { host, fire } = makeHost();
            const { abortSignal } = makeAbortHost();
            const guard = createTimerGuard(host, () => false, undefined, { abortSignal });
            guard.install();
            guard.markTestStart();

            const signal = abortSignal.timeout(500);
            expect(signal.aborted).toBe(false);
            fire(0);

            expect(signal.aborted).toBe(true);
            expect((signal.reason as DOMException).name).toBe('TimeoutError');
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('reports a deadline still pending when the test ends and cancels it', () => {
            const { host, handles } = makeHost();
            const { abortSignal } = makeAbortHost();
            const guard = createTimerGuard(host, () => false, undefined, { abortSignal });
            guard.install();
            guard.markTestStart();

            const signal = abortSignal.timeout(300_000);
            const leaks = guard.collectLeaks('test');

            expect(leaks.map(leak => `${leak.kind}:${String(leak.delayMs)}`)).toEqual(['AbortSignal.timeout:300000']);
            expect(handles[0]?._destroyed).toBe(true);
            expect(signal.aborted).toBe(false);
        });

        it('leaves the native deadline alone while fake timers are active', () => {
            const { host, handles } = makeHost();
            const { abortSignal, nativeCalls } = makeAbortHost();
            const guard = createTimerGuard(host, () => true, undefined, { abortSignal });
            guard.install();

            abortSignal.timeout(9);

            expect(nativeCalls).toEqual([9]);
            expect(handles).toHaveLength(0);
        });
    });

    describe('node:timers/promises', () => {
        function makePromiseHost(): { promiseTimers: PromiseTimersHost, nativeCalls: string[] } {
            const nativeCalls: string[] = [];
            return {
                promiseTimers: {
                    setTimeout:   async () => { nativeCalls.push('setTimeout'); },
                    setImmediate: async () => { nativeCalls.push('setImmediate'); },
                },
                nativeCalls,
            };
        }

        it('resolves with the supplied value once the tracked timer fires', async () => {
            const { host, fire } = makeHost();
            const { promiseTimers } = makePromiseHost();
            const guard = createTimerGuard(host, () => false, undefined, { promiseTimers });
            guard.install();
            guard.markTestStart();

            const result = promiseTimers.setTimeout(10, 'value');
            fire(0);

            expect(await result).toBe('value');
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('tracks setImmediate too and reports it when pending', () => {
            const { host } = makeHost();
            const { promiseTimers } = makePromiseHost();
            const guard = createTimerGuard(host, () => false, undefined, { promiseTimers });
            guard.install();
            guard.markTestStart();

            void promiseTimers.setImmediate('x');

            expect(guard.collectLeaks('test').map(leak => leak.kind)).toEqual(['timers/promises.setImmediate']);
        });

        it('rejects with an AbortError and clears the timer when its signal aborts', async () => {
            const { host, handles } = makeHost();
            const { promiseTimers } = makePromiseHost();
            const guard = createTimerGuard(host, () => false, undefined, { promiseTimers });
            guard.install();
            guard.markTestStart();
            const controller = new AbortController();

            const result = promiseTimers.setTimeout(10, 'value', { signal: controller.signal });
            controller.abort();

            await expect(result).rejects.toMatchObject({ name: 'AbortError' });
            expect(handles[0]?._destroyed).toBe(true);
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('rejects at once for a signal that is already aborted, without scheduling anything', async () => {
            const { host, handles } = makeHost();
            const { promiseTimers } = makePromiseHost();
            const guard = createTimerGuard(host, () => false, undefined, { promiseTimers });
            guard.install();
            guard.markTestStart();

            await expect(promiseTimers.setTimeout(10, 'value', { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
            expect(handles).toHaveLength(0);
        });

        it('passes straight through while fake timers are active', async () => {
            const { host, handles } = makeHost();
            const { promiseTimers, nativeCalls } = makePromiseHost();
            const guard = createTimerGuard(host, () => true, undefined, { promiseTimers });
            guard.install();

            await promiseTimers.setTimeout(10);
            await promiseTimers.setImmediate();

            expect(nativeCalls).toEqual(['setTimeout', 'setImmediate']);
            expect(handles).toHaveLength(0);
        });
    });

    describe('running owners', () => {
        it('reports an owner that began running during the test, stops it, and names it', () => {
            const { host } = makeHost();
            const { owners, stopped } = makeOwners('discord');
            let live: LiveOwner[] = [];
            const guard = createTimerGuard(host, () => false, undefined, { liveOwners: () => live });
            guard.install();
            guard.markTestStart();
            live = owners;

            const leaks = guard.collectLeaks('test');

            expect(leaks).toHaveLength(1);
            expect(leaks[0]?.kind).toBe('running-owner');
            expect(leaks[0]?.label).toBe('discord');
            expect(stopped).toEqual(['discord']);
            live = [];
            expect(guard.collectLeaks('test')).toHaveLength(0);
        });

        it('leaves an owner that was already running when the test started to the file scope', () => {
            const { host } = makeHost();
            const { owners, stopped } = makeOwners('shared');
            const guard = createTimerGuard(host, () => false, undefined, { liveOwners: () => owners });
            guard.install();
            guard.markTestStart();

            expect(guard.collectLeaks('test')).toHaveLength(0);
            expect(stopped).toEqual([]);
            expect(guard.collectLeaks('file').map(leak => leak.label)).toEqual(['shared']);
            expect(stopped).toEqual(['shared']);
        });

        it('holds an owner leak from overlapping concurrent tests until the last one ends', () => {
            const { host } = makeHost();
            const { owners } = makeOwners('loop');
            let live: LiveOwner[] = [];
            const guard = createTimerGuard(host, () => false, undefined, { liveOwners: () => live });
            guard.install();
            guard.markTestStart();
            live = owners;
            guard.markTestStart();

            expect(guard.collectLeaks('test')).toHaveLength(0);
            expect(guard.collectLeaks('test').map(leak => leak.label)).toEqual(['loop']);
        });

        it('has nothing to report without an owner source', () => {
            const { host } = makeHost();
            const guard = createTimerGuard(host, () => false);
            guard.install();
            guard.markTestStart();

            expect(guard.collectLeaks('test')).toHaveLength(0);
            expect(guard.collectLeaks('file')).toHaveLength(0);
        });
    });

    it('install is idempotent and uninstall restores every original', () => {
        const { host, sleepHost } = makeHost();
        const { host: nodeTimers } = makeHost();
        const { setTimeout: originalSetTimeout } = host;
        const { setTimeout: originalNodeSetTimeout } = nodeTimers;
        const { sleep: originalSleep } = sleepHost;
        const abortSignal: AbortSignalHost = { timeout: () => new AbortController().signal };
        const { timeout: originalTimeout } = abortSignal;
        const promiseTimers: PromiseTimersHost = { setTimeout: async () => undefined, setImmediate: async () => undefined };
        const { setTimeout: originalPromiseTimeout, setImmediate: originalPromiseImmediate } = promiseTimers;
        const guard = createTimerGuard(host, () => false, sleepHost, { nodeTimers, abortSignal, promiseTimers });

        guard.install();
        const wrapped = host.setTimeout;
        guard.install();

        expect(host.setTimeout).toBe(wrapped);
        expect(wrapped).not.toBe(originalSetTimeout);
        expect(nodeTimers.setTimeout).not.toBe(originalNodeSetTimeout);
        expect(sleepHost.sleep).not.toBe(originalSleep);
        expect(abortSignal.timeout).not.toBe(originalTimeout);
        expect(promiseTimers.setTimeout).not.toBe(originalPromiseTimeout);

        guard.uninstall();

        expect(host.setTimeout).toBe(originalSetTimeout);
        expect(nodeTimers.setTimeout).toBe(originalNodeSetTimeout);
        expect(sleepHost.sleep).toBe(originalSleep);
        expect(abortSignal.timeout).toBe(originalTimeout);
        expect(promiseTimers.setTimeout).toBe(originalPromiseTimeout);
        expect(promiseTimers.setImmediate).toBe(originalPromiseImmediate);
    });
});

describe('formatLeakedTimers', () => {
    it('names the scope, kind, delay and every creation frame', () => {
        const message = formatLeakedTimers([
            { kind: 'setTimeout', delayMs: 30_000, stack: ['at navigate (src/x.ts:1:1)', 'at test (tests/y.test.ts:2:2)'] },
            { kind: 'setImmediate', delayMs: undefined, stack: [] },
        ], 'test');

        expect(message).toContain('2 leaked timer(s) or running owner(s) after this test finished');
        expect(message).toContain('setTimeout 30000ms, created at:');
        expect(message).toContain('at navigate (src/x.ts:1:1)');
        expect(message).toContain('at test (tests/y.test.ts:2:2)');
        expect(message).toContain('- setImmediate, created at:');
    });

    it('names a running owner by its label and says to stop it', () => {
        const message = formatLeakedTimers([{ kind: 'running-owner', delayMs: undefined, stack: [], label: 'bsky' }], 'test');

        expect(message).toContain('- running-owner "bsky" is still running (stop() it)');
        expect(message).not.toContain('created at:');
    });

    it('words the file scope differently', () => {
        expect(formatLeakedTimers([{ kind: 'setInterval', delayMs: 1, stack: [] }], 'file')).toContain('after this test file finished');
    });
});
