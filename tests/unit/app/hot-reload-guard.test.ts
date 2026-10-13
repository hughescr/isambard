/**
 * Hot-reload guard tests: under `bun --hot`, `import.meta.hot` is undefined (Bun 1.4.2, verified
 * 2026-09-09), so a reload re-runs the entry module without ever firing a dispose callback and
 * the previous bot instance keeps running. `globalThis` survives a reload, so the guard parks the
 * live instance's stop there and the next evaluation stops it before starting its own.
 */
import { describe, test, expect, mock, jest, beforeEach, afterEach } from 'bun:test';
import { HOT_RELOAD_KEY, registerHotReloadInstance, stopPreviousHotReloadInstance, launchHotReloadInstance } from '@/app/hot-reload-guard';

function makeLogger() {
    return { info: mock(() => undefined), warn: mock(() => undefined) };
}

describe('stopPreviousHotReloadInstance', () => {
    test('returns false and logs nothing when no previous instance is registered', async () => {
        const host: Record<string, unknown> = {};
        const logger = makeLogger();

        const stopped = await stopPreviousHotReloadInstance(host, logger);

        expect(stopped).toBe(false);
        expect(logger.info).not.toHaveBeenCalled();
        expect(host[HOT_RELOAD_KEY]).toBeUndefined();
    });

    test('stops the registered previous instance, clears the slot, and returns true', async () => {
        const host: Record<string, unknown> = {};
        const logger = makeLogger();
        const stop = mock(async () => undefined);
        registerHotReloadInstance(host, { stop });

        const stopped = await stopPreviousHotReloadInstance(host, logger);

        expect(stopped).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(host[HOT_RELOAD_KEY]).toBeUndefined();
        expect(logger.info).toHaveBeenCalledWith('Hot reload: stopping the previous application instance');
    });

    test('a previous instance whose stop rejects is logged at warn, cleared, and still counts as handled', async () => {
        const host: Record<string, unknown> = {};
        const logger = makeLogger();
        registerHotReloadInstance(host, {
            stop: async () => {
                throw new Error('boom');
            },
        });

        const stopped = await stopPreviousHotReloadInstance(host, logger);

        expect(stopped).toBe(true);
        expect(host[HOT_RELOAD_KEY]).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith({ error: 'boom', msg: 'Hot reload: previous instance failed to stop cleanly' });
    });

    test('logs a rejected non-Error reason as readable text', async () => {
        const host: Record<string, unknown> = {};
        const logger = makeLogger();
        registerHotReloadInstance(host, {
            stop: async () => {
                throw 'stopping failed';
            },
        });

        await stopPreviousHotReloadInstance(host, logger);

        expect(logger.warn).toHaveBeenCalledWith({
            error: 'stopping failed',
            msg:   'Hot reload: previous instance failed to stop cleanly',
        });
    });

    test.each([
        ['null', null],
        ['a string', 'stop'],
        ['a number', 7],
        ['an object without stop', {}],
    ])('ignores a slot holding %s', async (_label, value) => {
        const host: Record<string, unknown> = { [HOT_RELOAD_KEY]: value };

        expect(await stopPreviousHotReloadInstance(host, makeLogger())).toBe(false);
        expect(HOT_RELOAD_KEY in host).toBe(false);
    });

    test('ignores a slot value that is not a handle', async () => {
        const host: Record<string, unknown> = { [HOT_RELOAD_KEY]: { stop: 'not a function' } };
        const logger = makeLogger();

        const stopped = await stopPreviousHotReloadInstance(host, logger);

        expect(stopped).toBe(false);
        expect(host[HOT_RELOAD_KEY]).toBeUndefined();
    });

    test('honours a custom key', async () => {
        const host: Record<string, unknown> = {};
        const stop = mock(async () => undefined);
        registerHotReloadInstance(host, { stop }, 'custom');

        expect(host.custom).toBeDefined();
        expect(host[HOT_RELOAD_KEY]).toBeUndefined();
        expect(await stopPreviousHotReloadInstance(host, makeLogger(), 'custom')).toBe(true);
        expect(stop).toHaveBeenCalledTimes(1);
    });
});

async function flush(): Promise<void> {
    for(let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain
        await Promise.resolve();
    }
}

function deferred() {
    let resolveFn!: () => void;
    const promise = new Promise<void>((resolve) => {
        resolveFn = resolve;
    });
    return { promise, resolve: resolveFn };
}

function makeInstance() {
    return { start: mock(async (): Promise<void> => undefined), stop: mock(async (): Promise<void> => undefined) };
}

describe('launchHotReloadInstance', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    test('cold start builds immediately, starts once, and parks teardown', async () => {
        const host: Record<string, unknown> = {};
        const instance = makeInstance();
        const create = mock(async () => instance);
        const sleep = mock(async (_ms: number) => undefined);
        expect(await launchHotReloadInstance({ host, logger: makeLogger(), create, sleep })).toBe(instance);
        expect(create).toHaveBeenCalledTimes(1);
        expect(instance.start).toHaveBeenCalledTimes(1);
        expect(host.__isambardHotReloadState).toEqual({ generation: 1, stopping: expect.any(Promise) });
        expect(sleep).not.toHaveBeenCalled();
        await stopPreviousHotReloadInstance(host, makeLogger());
        expect(instance.stop).toHaveBeenCalledTimes(1);
    });

    test('a parked legacy instance also causes a 1000ms delay after stopping it', async () => {
        const host = {};
        const old = makeInstance();
        registerHotReloadInstance(host, old);
        const next = makeInstance();
        const create = mock(async () => next);
        const starting = launchHotReloadInstance({ host, logger: makeLogger(), create });
        await flush();
        expect(old.stop).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(999);
        await flush();
        expect(create).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(await starting).toBe(next);
    });

    test('rapid evaluations build only the newest generation after its settle window', async () => {
        const host = {};
        await launchHotReloadInstance({ host, logger: makeLogger(), create: async () => makeInstance() });
        const obsolete = mock(async () => makeInstance());
        const newest = mock(async () => makeInstance());
        const second = launchHotReloadInstance({ host, logger: makeLogger(), create: obsolete });
        await flush();
        jest.advanceTimersByTime(100);
        const third = launchHotReloadInstance({ host, logger: makeLogger(), create: newest });
        await flush();
        jest.advanceTimersByTime(900);
        expect(await second).toBeUndefined();
        expect(obsolete).not.toHaveBeenCalled();
        expect(newest).not.toHaveBeenCalled();
        jest.advanceTimersByTime(100);
        await third;
        expect(newest).toHaveBeenCalledTimes(1);
    });

    test('a newer evaluation waits for the stop already in progress even with an empty parked slot', async () => {
        const host = {};
        const stopping = deferred();
        const old = makeInstance();
        old.stop.mockImplementation(() => stopping.promise);
        await launchHotReloadInstance({ host, logger: makeLogger(), create: async () => old });
        const obsolete = mock(async () => makeInstance());
        const newest = mock(async () => makeInstance());
        const second = launchHotReloadInstance({ host, logger: makeLogger(), create: obsolete });
        await flush();
        const third = launchHotReloadInstance({ host, logger: makeLogger(), create: newest });
        await flush();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(newest).not.toHaveBeenCalled();
        stopping.resolve();
        await flush();
        jest.advanceTimersByTime(1000);
        await Promise.all([second, third]);
        expect(old.stop).toHaveBeenCalledTimes(1);
        expect(obsolete).not.toHaveBeenCalled();
        expect(newest).toHaveBeenCalledTimes(1);
    });

    test('superseded construction is stopped without starting or overwriting the new handle', async () => {
        const host = {};
        const building = deferred();
        const old = makeInstance();
        const stopping = deferred();
        old.stop.mockImplementation(() => stopping.promise);
        const create = mock(async () => {
            await building.promise;
            return old;
        });
        const first = launchHotReloadInstance({ host, logger: makeLogger(), create });
        await flush();
        expect(create).toHaveBeenCalledTimes(1);
        const next = makeInstance();
        const second = launchHotReloadInstance({ host, logger: makeLogger(), create: async () => next });
        await flush();
        expect(next.start).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        await second;
        let disposed = false;
        const disposedFirst = first.then((result) => {
            disposed = true;
            return result;
        });
        building.resolve();
        await flush();
        expect(old.start).not.toHaveBeenCalled();
        expect(old.stop).toHaveBeenCalledTimes(1);
        expect(disposed).toBe(false);
        stopping.resolve();
        expect(await disposedFirst).toBeUndefined();
        await stopPreviousHotReloadInstance(host, makeLogger());
        expect(next.stop).toHaveBeenCalledTimes(1);
    });

    test.each([new Error('obsolete stop failed'), 'obsolete stop failed'])('obsolete stop failure %s is logged without poisoning later launches', async (failure) => {
        const host = {};
        const building = deferred();
        const old = makeInstance();
        old.stop.mockImplementation(async () => {
            throw failure;
        });
        const logger = makeLogger();
        const first = launchHotReloadInstance({ host, logger, create: async () => {
            await building.promise;
            return old;
        } });
        await flush();
        const next = makeInstance();
        const second = launchHotReloadInstance({ host, logger, create: async () => next });
        await flush();
        jest.advanceTimersByTime(1000);
        await second;
        building.resolve();
        expect(await first).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith({ error: 'obsolete stop failed', msg: 'Hot reload: obsolete instance failed to stop cleanly' });
        const newest = makeInstance();
        const third = launchHotReloadInstance({ host, logger, create: async () => newest });
        await flush();
        jest.advanceTimersByTime(1000);
        expect(await third).toBe(newest);
        expect(next.stop).toHaveBeenCalledTimes(1);
    });

    test('the current generation joins obsolete teardown that began during its construction', async () => {
        const host = {};
        const firstBuild = deferred();
        const nextBuild = deferred();
        const oldStop = deferred();
        const old = makeInstance();
        old.stop.mockImplementation(() => oldStop.promise);
        const first = launchHotReloadInstance({ host, logger: makeLogger(), create: async () => {
            await firstBuild.promise;
            return old;
        } });
        await flush();
        const next = makeInstance();
        const second = launchHotReloadInstance({ host, logger: makeLogger(), create: async () => {
            await nextBuild.promise;
            return next;
        } });
        await flush();
        jest.advanceTimersByTime(1000);
        await flush();
        firstBuild.resolve();
        await flush();
        expect(old.stop).toHaveBeenCalledTimes(1);
        nextBuild.resolve();
        await flush();
        expect(next.start).not.toHaveBeenCalled();
        oldStop.resolve();
        await Promise.all([first, second]);
        expect(next.start).toHaveBeenCalledTimes(1);
    });

    test.each([new Error('start failed'), 'start failed'])('parked teardown waits for start and still stops after failure %s', async (failure) => {
        const host = {};
        const starting = deferred();
        const old = makeInstance();
        old.start.mockImplementation(async () => {
            await starting.promise;
            throw failure;
        });
        const logger = makeLogger();
        const first = launchHotReloadInstance({ host, logger, create: async () => old });
        await flush();
        const failed = first.catch((error: unknown) => error);
        const stopping = stopPreviousHotReloadInstance(host, logger);
        await flush();
        expect(old.stop).not.toHaveBeenCalled();
        starting.resolve();
        expect(await failed).toBe(failure);
        await stopping;
        expect(old.stop).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith({ error: 'start failed', msg: 'Hot reload: previous start had failed; tearing down anyway' });
    });
});

describe('HOT_RELOAD_KEY', () => {
    test('is the documented globalThis slot name', () => {
        expect(HOT_RELOAD_KEY).toBe('__isambardHotReloadInstance');
    });
});

describe('registerHotReloadInstance', () => {
    test('stores the handle under the default key, replacing any earlier one', () => {
        const host: Record<string, unknown> = {};
        const first = { stop: async () => undefined };
        const second = { stop: async () => undefined };

        registerHotReloadInstance(host, first);
        expect(host[HOT_RELOAD_KEY]).toBe(first);
        registerHotReloadInstance(host, second);
        expect(host[HOT_RELOAD_KEY]).toBe(second);
    });
});
