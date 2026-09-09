/**
 * Hot-reload guard for the composition root.
 *
 * `running/` starts the bot with `bun --hot src/index.ts`, and under Bun 1.4.2 `import.meta.hot`
 * is `undefined` there (verified 2026-09-09 with a throwaway `--hot` entry), so the entry module's
 * `import.meta.hot.dispose(...)` never registers. A reload therefore re-runs the whole entry
 * module and builds a second bot — Discord handlers, conductors, presence, task board — while the
 * first keeps running. Three stacked copies handled every message on 2026-09-09 (three synopses
 * per turn, three replies, presence flipping between three ledgers).
 *
 * `globalThis` DOES survive a `--hot` reload, so the entry point parks a stop handle for the live
 * instance there and, on the next evaluation, stops it before starting its own. The host object
 * is injected so the guard is testable with a plain object.
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
