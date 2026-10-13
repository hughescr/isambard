/**
 * Hot-reload guard for the composition root.
 *
 * Bun's `--hot` (1.4.2/1.4.3) re-evaluates the entry module without defining `import.meta.hot`.
 * It starts no re-evaluation until the current evaluation's top-level await settles (plus ~100ms),
 * so the entry must not await the launch: a blocked entry serialises a burst of file changes
 * (a `git checkout` writing two files) into full restarts seconds apart, whereas a non-blocking
 * entry re-evaluates 2-13ms after each change and the burst lands inside the debounce below.
 * Evaluations whose async work is still running after a reload carry on; the generation handles that.
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

/** The logger the detached entry launch needs: the guard's two methods plus `error` for a fatal failure. */
export interface HotReloadEntryLogger extends HotReloadLogger {
    error: (obj: { error: string, msg: string, stack: string | undefined }) => void
}

/** Dependencies for the non-blocking entry launch. */
export interface LaunchHotReloadDetachedParams extends Omit<LaunchHotReloadParams, 'logger'> {
    logger:     HotReloadEntryLogger
    /** Called with the started application, never for a superseded evaluation. */
    onLaunched: (app: HotReloadApplication) => void
    /** Terminates the process; injected so a fatal launch failure is testable. */
    exit:       (code: number) => void
}

/**
 * Runs `launchHotReloadInstance` without the caller awaiting it, so the entry module's top-level
 * evaluation can finish at once (Bun `--hot` starts no further re-evaluation until the current
 * one's top-level await settles). The generation is still claimed synchronously: the launch's
 * first statements run before this function returns. The returned promise never rejects; a launch
 * failure (or a throwing `onLaunched`) is logged and fatal via `exit(1)`, never unhandled.
 */
export async function launchHotReloadDetached({ onLaunched, exit, ...params }: LaunchHotReloadDetachedParams): Promise<void> {
    try {
        const app = await launchHotReloadInstance(params);
        if(app) {
            onLaunched(app);
        }
    } catch (error) {
        params.logger.error({
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            msg:   'Fatal: hot-reload launch failed',
        });
        exit(1);
    }
}
