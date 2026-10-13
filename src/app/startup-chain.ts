/**
 * Single-flight, cancellable startup ownership for one app lifecycle.
 *
 * The callable chain memoizes startup, including failure. `stop()` aborts synchronously and
 * joins any startup already in flight. Startup must observe the signal while waiting for
 * readiness and between stages. The session composition root uses this join before the
 * host-ordered teardown and supervisor fallback in `stopSessions`; it does not supply the
 * optional final cleanup callback. Other callers may provide that callback for owners without
 * a host-specific teardown order. A stop before the first invocation permanently prevents
 * startup. A rebuilt lifecycle gets a fresh chain.
 *
 * @module app/startup-chain
 */

/** A single-flight startup action with an idempotent abort/join/shutdown operation. */
export interface StartupChain {
    (): Promise<void>
    stop(): Promise<void>
}

/** Build one chain per lifecycle. `shutdown` runs after startup settles, even on failure. */
export function createStartupChain(run: (signal: AbortSignal) => Promise<void>, shutdown: () => Promise<void> = async () => undefined): StartupChain {
    const controller = new AbortController();
    let cached: Promise<void> | undefined;
    let stopping: Promise<void> | undefined;
    const chain = (): Promise<void> => {
        cached ??= controller.signal.aborted ? Promise.resolve() : run(controller.signal);
        return cached;
    };
    chain.stop = (): Promise<void> => {
        controller.abort();
        stopping ??= (async () => {
            await Promise.allSettled([cached]);
            await shutdown();
        })();
        return stopping;
    };
    return chain;
}
