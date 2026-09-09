/**
 * Hot-reload guard tests: under `bun --hot`, `import.meta.hot` is undefined (Bun 1.4.2, verified
 * 2026-09-09), so a reload re-runs the entry module without ever firing a dispose callback and
 * the previous bot instance keeps running. `globalThis` survives a reload, so the guard parks the
 * live instance's stop there and the next evaluation stops it before starting its own.
 */
import { describe, test, expect, mock } from 'bun:test';
import { HOT_RELOAD_KEY, registerHotReloadInstance, stopPreviousHotReloadInstance } from '@/app/hot-reload-guard';

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
