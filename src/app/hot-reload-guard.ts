/**
 * Hot-reload guard for the composition root.
 *
 * Bun 1.4.2's `--hot` re-evaluates the entry module without defining `import.meta.hot`.
 * `globalThis` survives: the guard keeps a generation, a shared teardown barrier, and the live
 * instance's stop handle there. Every evaluation claims a generation before awaiting anything.
 * Reloads stop the parked owner, join any teardown already underway, then settle for 1000ms;
 * the first cold evaluation has no delay. Only the latest generation builds. A second check
 * after async construction closes the unregistered createApp window: obsolete owners are stopped
 * without starting or overwriting the newer handle. Registering before start covers mid-start
 * reloads too. The host and sleep are injectable for deterministic tests.
 *
 * @module app/hot-reload-guard
 */

/** Slot on the host object (`globalThis` in production) holding the live instance's handle. */
export const HOT_RELOAD_KEY = '__isambardHotReloadInstance';

/** What the entry point registers: one async stop that tears the whole instance down. */
export interface HotReloadInstance {
    stop: () => Promise<void>
}

/** The two logger methods the guard needs. */
export interface HotReloadLogger {
    info: (message: string) => void
    warn: (obj: { error: string, msg: string }) => void
}

function isHotReloadInstance(value: unknown): value is HotReloadInstance {
    return typeof value === 'object' && value !== null && typeof (value as { stop?: unknown }).stop === 'function';
}

/**
 * Stops and clears the instance registered under `key` on `host`, if any.
 * @returns `true` when a previous instance was found (whether or not its stop succeeded).
 */
export async function stopPreviousHotReloadInstance(
    host:   Record<string, unknown>,
    logger: HotReloadLogger,
    key:    string = HOT_RELOAD_KEY
): Promise<boolean> {
    const previous = host[key];
    delete host[key];
    if(!isHotReloadInstance(previous)) {
        return false;
    }
    logger.info('Hot reload: stopping the previous application instance');
    try {
        await previous.stop();
    } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Hot reload: previous instance failed to stop cleanly' });
    }
    return true;
}

/** Parks `instance` under `key` on `host` so the next evaluation of the entry module can stop it. */
export function registerHotReloadInstance(
    host:     Record<string, unknown>,
    instance: HotReloadInstance,
    key:      string = HOT_RELOAD_KEY
): void {
    host[key] = instance;
}

interface HotReloadState {
    generation: number
    stopping:   Promise<unknown>
}

/** An asynchronously constructed owner; construction must not start the application. */
export interface HotReloadApplication extends HotReloadInstance {
    start: () => Promise<void>
}

/** Dependencies for generation-aware, debounced application launch. */
export interface LaunchHotReloadParams {
    host:   Record<string, unknown>
    logger: HotReloadLogger
    create: () => Promise<HotReloadApplication>
    sleep?: (ms: number) => Promise<void>
}

/** Launch only the newest evaluation, joining previous teardown before the reload settle delay. */
export async function launchHotReloadInstance({ host, logger, create, sleep = ms => new Promise((resolve) => {
    setTimeout(resolve, ms);
}) }: LaunchHotReloadParams): Promise<HotReloadApplication | undefined> {
    const stateKey = '__isambardHotReloadState';
    // Private runtime-persistent slot written only by this guard, unlike the public stop handle.
    const state = (host[stateKey] as HotReloadState | undefined) ?? { generation: 0, stopping: Promise.resolve() };
    host[stateKey] = state;
    const generation = ++state.generation;
    state.stopping = state.stopping.then(() => stopPreviousHotReloadInstance(host, logger));
    const foundPrevious = await state.stopping;
    if(generation > 1 || foundPrevious) {
        await sleep(1000);
    }
    if(generation !== state.generation) {
        return undefined;
    }
    const instance = await create();
    // Construction can overlap an obsolete owner's teardown. Join the live barrier again
    // before the final generation check and registration; no await may follow that check.
    await state.stopping;
    if(generation !== state.generation) {
        state.stopping = state.stopping.then(() => instance.stop()).catch((error: unknown) => {
            logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Hot reload: obsolete instance failed to stop cleanly' });
        });
        await state.stopping;
        return undefined;
    }
    let started: Promise<void> = Promise.resolve();
    registerHotReloadInstance(host, {
        stop: async () => {
            await started.catch((error: unknown) => {
                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Hot reload: previous start had failed; tearing down anyway' });
            });
            await instance.stop();
        },
    });
    started = instance.start();
    await started;
    return instance;
}
