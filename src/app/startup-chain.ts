/**
 * Single-flight startup chain guard for the composition root.
 *
 * #41's session-startup chain (open, attachSessions, boot recovery — `startSessions` in
 * `./runtime`) must run at most once per app lifecycle: `createApp()` lets `app.start()`
 * re-enter a lifecycle's `start()` without an intervening `stop()` (see `createApp`'s queue in
 * `src/index.ts`), and a second run would attach a second set of Discord wiring and rerun boot
 * recovery. `createStartupChain` memoizes exactly one call to `run`, forever — including a
 * rejection, which is never retried. That is deliberately simpler than the sequencing it wraps:
 * `startSessions` itself never actually rejects (it swallows and logs internally, covered by
 * `tests/unit/app/runtime.test.ts`), so this module's contract does not need to special-case
 * failure at all, it only needs to never re-run `run` once the guard has been used.
 *
 * `run` is not invoked until the returned function is first called, mirroring the short-circuiting
 * `??=` this replaces — its right-hand side is never evaluated once the left-hand side is already
 * set, so nothing is constructed or started until `start()` actually calls it.
 *
 * One `createStartupChain()` call is meant per app lifecycle (one per `createAppLifecycle()`),
 * exactly like `createSessionSupervisor` — a stop-then-start rebuild in `createApp()` calls
 * `createAppLifecycle()` again and so gets a fresh, independent chain for free.
 *
 * @module app/startup-chain
 */

/** A memoized zero-argument async action: call it as many times as you like, `run` fires once. */
export type StartupChain = () => Promise<void>;

/**
 * Builds a {@link StartupChain} that calls `run` on its first invocation and, on every later
 * invocation, returns that same cached promise without calling `run` again — including when the
 * cached promise has rejected.
 */
export function createStartupChain(run: () => Promise<void>): StartupChain {
    let cached: Promise<void> | undefined;
    return () => {
        cached ??= run();
        return cached;
    };
}
