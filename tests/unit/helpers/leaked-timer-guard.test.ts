import { describe, expect, it } from 'bun:test';
import { createTimerGuard, formatLeakedTimers, STRYKER_PRELOAD_FRAME, type AbortSignalHost, type LeakedTimerKind, type LiveOwner, type PromiseTimersHost, type SleepHost, type TimerGuardHost } from '../../helpers/leaked-timer-guard';

interface FakeHandle { _destroyed: boolean, callback: unknown }

/** What a native `timers/promises.setInterval` hands back in these tests: one tick, then done. */
async function* nativeTicks(): AsyncGenerator<string> {
    yield 'native';
}

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

    it('keeps tracking the creator kinds that stay real while fake timers are active, and ignores the faked ones', () => {
        const { host } = makeHost();
        const { host: nodeTimers } = makeHost();
        const guard = createTimerGuard(host, () => true, undefined, { nodeTimers, realInFakeMode: new Set<LeakedTimerKind>(['setImmediate']) });
        guard.install();
        guard.markTestStart();

        host.setTimeout(() => undefined, 5);
        host.setInterval(() => undefined, 5);
        host.setImmediate(() => undefined);
        nodeTimers.setTimeout(() => undefined, 5);
        nodeTimers.setImmediate(() => undefined);

        expect(guard.collectLeaks('test').map(leak => leak.kind)).toEqual(['setImmediate', 'setImmediate']);
    });

    it('tracks a real Bun.sleep, AbortSignal.timeout and promise timers while fake timers are on when told they stay real', async () => {
        const { host, sleepHost } = makeHost();
        const abortSignal: AbortSignalHost = { timeout: () => new AbortController().signal };
        const promiseTimers: PromiseTimersHost = {
            setTimeout:   async () => undefined,
            setImmediate: async () => undefined,
            setInterval:  nativeTicks,
        };
        const real = new Set<LeakedTimerKind>(['Bun.sleep', 'AbortSignal.timeout', 'timers/promises.setTimeout', 'timers/promises.setImmediate', 'timers/promises.setInterval']);
        const guard = createTimerGuard(host, () => true, sleepHost, { abortSignal, promiseTimers, realInFakeMode: real });
        guard.install();
        guard.markTestStart();

        void sleepHost.sleep(5);
        abortSignal.timeout(5);
        void promiseTimers.setTimeout(5);
        void promiseTimers.setImmediate();
        promiseTimers.setInterval(5);

        expect(guard.collectLeaks('test').map(leak => leak.kind)).toEqual(['Bun.sleep', 'AbortSignal.timeout', 'timers/promises.setTimeout', 'timers/promises.setImmediate', 'timers/promises.setInterval']);
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

    it('flags every test of an overlapping group as concurrent (unsupported), until a test starts alone again', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();

        guard.markTestStart();
        expect(guard.hasConcurrentTests()).toBe(false);
        guard.markTestStart();
        expect(guard.hasConcurrentTests()).toBe(true);
        guard.collectLeaks('test');
        expect(guard.hasConcurrentTests()).toBe(true);
        guard.collectLeaks('test');
        expect(guard.hasConcurrentTests()).toBe(true);

        guard.markTestStart();
        expect(guard.hasConcurrentTests()).toBe(false);
    });

    it('does not flag tests that run one after another as concurrent', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();

        guard.markTestStart();
        guard.collectLeaks('test');
        guard.markTestStart();

        expect(guard.hasConcurrentTests()).toBe(false);
    });

    it('forgets a concurrent group at file teardown', () => {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false);
        guard.install();
        guard.markTestStart();
        guard.markTestStart();

        guard.collectLeaks('file');

        expect(guard.hasConcurrentTests()).toBe(false);
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
                    setInterval:  () => {
                        nativeCalls.push('setInterval');
                        return nativeTicks();
                    },
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
            const first = await promiseTimers.setInterval(10)[Symbol.asyncIterator]().next();

            expect(nativeCalls).toEqual(['setTimeout', 'setImmediate', 'setInterval']);
            expect(first.value).toBe('native');
            expect(handles).toHaveLength(0);
        });

        describe('setInterval', () => {
            function start(): { handles: FakeHandle[], guard: ReturnType<typeof createTimerGuard>, promiseTimers: PromiseTimersHost } {
                const { host, handles } = makeHost();
                const { promiseTimers } = makePromiseHost();
                const guard = createTimerGuard(host, () => false, undefined, { promiseTimers });
                guard.install();
                guard.markTestStart();
                return { handles, guard, promiseTimers };
            }
            const tick = (handles: FakeHandle[], index = 0): void => {
                (handles[index]?.callback as () => void)();
            };

            it('reports an interval still pending when the test ends, with its kind and delay, and cancels it', () => {
                const { guard, handles, promiseTimers } = start();

                promiseTimers.setInterval(250, 'v');
                const leaks = guard.collectLeaks('test');

                expect(leaks.map(leak => [leak.kind, leak.delayMs])).toEqual([['timers/promises.setInterval', 250]]);
                expect(handles[0]?._destroyed).toBe(true);
            });

            it('yields the value once per tick, counting ticks nobody was waiting for', async () => {
                const { guard, handles, promiseTimers } = start();
                const iterator = promiseTimers.setInterval(5, 'v')[Symbol.asyncIterator]();

                const waiting = iterator.next();
                tick(handles);
                tick(handles);
                tick(handles);

                expect(await waiting).toEqual({ value: 'v', done: false });
                expect(await iterator.next()).toEqual({ value: 'v', done: false });
                expect(await iterator.next()).toEqual({ value: 'v', done: false });
                const pending = iterator.next();
                expect(Bun.peek.status(pending)).toBe('pending');
                await iterator.return?.();
                expect(await pending).toEqual({ value: undefined, done: true });
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });

            it('clears the interval when the iterator is returned (break in a for-await), and is done afterwards', async () => {
                const { guard, handles, promiseTimers } = start();
                const iterator = promiseTimers.setInterval(5)[Symbol.asyncIterator]();

                expect(await iterator.return?.()).toEqual({ value: undefined, done: true });

                expect(handles[0]?._destroyed).toBe(true);
                expect(await iterator.next()).toEqual({ value: undefined, done: true });
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });

            it('rejects the waiting next() with an AbortError and clears the interval when its signal aborts', async () => {
                const { guard, handles, promiseTimers } = start();
                const controller = new AbortController();
                const iterator = promiseTimers.setInterval(5, 'v', { signal: controller.signal })[Symbol.asyncIterator]();

                const waiting = iterator.next();
                controller.abort();

                await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
                expect(handles[0]?._destroyed).toBe(true);
                expect(await iterator.next()).toEqual({ value: undefined, done: true });
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });

            it('rejects the next next() once when the signal aborted while nobody was waiting', async () => {
                const { guard, handles, promiseTimers } = start();
                const controller = new AbortController();
                const iterator = promiseTimers.setInterval(5, 'v', { signal: controller.signal })[Symbol.asyncIterator]();

                controller.abort();

                expect(handles[0]?._destroyed).toBe(true);
                await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
                expect(await iterator.next()).toEqual({ value: undefined, done: true });
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });

            it('rejects at once for a signal that is already aborted, without scheduling anything', async () => {
                const { guard, handles, promiseTimers } = start();
                const iterator = promiseTimers.setInterval(5, 'v', { signal: AbortSignal.abort() })[Symbol.asyncIterator]();

                await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });

                expect(handles).toHaveLength(0);
                expect(await iterator.next()).toEqual({ value: undefined, done: true });
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });

            it('is its own async iterator, and needs no signal', async () => {
                const { promiseTimers, guard } = start();
                const iterator = promiseTimers.setInterval(5)[Symbol.asyncIterator]() as AsyncIterableIterator<unknown>;

                expect(iterator[Symbol.asyncIterator]()).toBe(iterator);
                await iterator.return?.();
                expect(guard.collectLeaks('test')).toHaveLength(0);
            });
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
        const promiseTimers: PromiseTimersHost = { setTimeout: async () => undefined, setImmediate: async () => undefined, setInterval: nativeTicks };
        const { setTimeout: originalPromiseTimeout, setImmediate: originalPromiseImmediate, setInterval: originalPromiseInterval } = promiseTimers;
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
        expect(promiseTimers.setInterval).not.toBe(originalPromiseInterval);

        guard.uninstall();

        expect(host.setTimeout).toBe(originalSetTimeout);
        expect(nodeTimers.setTimeout).toBe(originalNodeSetTimeout);
        expect(sleepHost.sleep).toBe(originalSleep);
        expect(abortSignal.timeout).toBe(originalTimeout);
        expect(promiseTimers.setTimeout).toBe(originalPromiseTimeout);
        expect(promiseTimers.setImmediate).toBe(originalPromiseImmediate);
        expect(promiseTimers.setInterval).toBe(originalPromiseInterval);
    });
});

describe('createTimerGuard tooling preload timers', () => {
    const PRELOAD = `at startOrphanWatchdog (/x/node_modules${STRYKER_PRELOAD_FRAME}:61:33)`;
    const TEMPLATE = 'at <anonymous> (/tmp/stryker-bun-runner/stryker-coverage-preload-1.ts:30:5)';

    /** Creates one interval with the given creation stack, then reports what the guard still tracks after teardown. */
    function leakedDelays(frames: string[], beforeCreate: (guard: ReturnType<typeof createTimerGuard>) => void = () => undefined, ownCodeFrames?: string[]): (number | undefined)[] {
        const { host } = makeHost();
        const guard = createTimerGuard(host, () => false, undefined, { captureStack: () => frames, ...(ownCodeFrames === undefined ? {} : { ownCodeFrames }) });
        guard.install();
        beforeCreate(guard);
        host.setInterval(() => undefined, 1000);
        const delays = guard.collectLeaks('file').map(leak => leak.delayMs);
        guard.uninstall();
        return delays;
    }

    it('exempts the runner preload watchdog created while the guard is still booting, from tooling-only frames', () => {
        expect(leakedDelays([PRELOAD, TEMPLATE])).toEqual([]);
    });

    it('does not exempt that same watchdog once any test has started', () => {
        const startATest = (guard: ReturnType<typeof createTimerGuard>): void => {
            guard.markTestStart();
        };

        expect(leakedDelays([PRELOAD, TEMPLATE], startATest)).toEqual([1000]);
    });

    it('does not exempt a call to the runner preload that has project test code in its stack, even during boot (module scope of a test file)', () => {
        expect(leakedDelays([PRELOAD, 'at <anonymous> (/repo/tests/unit/x.test.ts:3:1)'])).toEqual([1000]);
    });

    it('does not exempt one with project source code anywhere in a deep stack', () => {
        const deep = [PRELOAD, TEMPLATE, TEMPLATE, TEMPLATE, TEMPLATE, TEMPLATE, TEMPLATE, 'at run (/repo/src/x.ts:3:1)'];

        expect(leakedDelays(deep)).toEqual([1000]);
    });

    it('does not exempt a timer whose first frame is not the runner preload, even with the preload deeper in the stack', () => {
        expect(leakedDelays(['at leaky (/other/y.js:2:2)', PRELOAD])).toEqual([1000]);
    });

    it('exempts only the exact preload-logic.js file: neighbouring files in the runner directory are tracked', () => {
        const dir = '/x/node_modules/@hughescr/stryker-bun-runner/dist/coverage';

        expect(leakedDelays([`at f (${dir}/preload-unrelated.js:1:1)`])).toEqual([1000]);
        expect(leakedDelays([`at f (${dir}/preload-logic.js.backup)`])).toEqual([1000]);
        expect(leakedDelays([`at f (${dir}/preload-logic.js.backup:1:1)`])).toEqual([1000]);
        expect(leakedDelays([`at f (${dir}/preload-logic.jsx:1:1)`])).toEqual([1000]);
        expect(leakedDelays([`at f (${dir}/preload.js:1:1)`])).toEqual([1000]);
    });

    it('requires a path-segment boundary before the runner package path', () => {
        expect(leakedDelays(['at f (/x/node_modules/evil@hughescr/stryker-bun-runner/dist/coverage/preload-logic.js:1:1)'])).toEqual([1000]);
    });

    it('accepts the preload frame with or without a line, column or closing paren', () => {
        const file = `/x/node_modules${STRYKER_PRELOAD_FRAME}`;

        expect(leakedDelays([`at f (${file}:61:33)`])).toEqual([]);
        expect(leakedDelays([`at ${file}:61:33`])).toEqual([]);
        expect(leakedDelays([`at f (${file}:61)`])).toEqual([]);
        expect(leakedDelays([`at f (${file})`])).toEqual([]);
        expect(leakedDelays([`at ${file}`])).toEqual([]);
        expect(leakedDelays([`at f (${file}:61:33:7)`])).toEqual([1000]);
        expect(leakedDelays([`at f (${file}:x)`])).toEqual([1000]);
    });

    it('honours custom project-code path fragments', () => {
        expect(leakedDelays([PRELOAD, 'at app (/work/app/main.ts:1:1)'], undefined, ['/app/'])).toEqual([1000]);
        expect(leakedDelays([PRELOAD, 'at app (/repo/tests/main.ts:1:1)'], undefined, ['/app/'])).toEqual([]);
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
