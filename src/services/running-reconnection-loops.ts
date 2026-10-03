import type { ServiceName } from './types';

/** A loop that is currently running (retrying, or with a connect attempt in flight). */
interface RunningLoop {
    /** Stable identity of the loop */
    readonly id:      object
    readonly service: ServiceName
    /** Stops the loop and delists it */
    readonly stop:    () => void
}

// Deliberately a leaf module with no runtime imports: the test preload reads it to fail any test
// that leaves a loop running, and must be able to do so without pulling in the rest of the service layer.
//
// Tracking is OFF unless the test preload turns it on (`enableRunningLoopTracking()`). Production
// therefore registers nothing and holds no reference to any loop: each stop closure roots its loop's
// whole state, so a process-lifetime registry of them would be a leak of its own.
let running: Map<object, RunningLoop> | undefined;

/**
 * Turns tracking on. Only the test preload calls this; production never does, so by default
 * nothing is registered. Keeps whatever is already tracked.
 * @internal
 */
export function enableRunningLoopTracking(): void {
    running ??= new Map();
}

/**
 * Turns tracking off and drops everything held.
 * @internal
 */
export function disableRunningLoopTracking(): void {
    running = undefined;
}

/** Records that the loop identified by `id` is running. Called by the loop itself whenever it (re)engages; a no-op unless tracking is on. */
export function markLoopRunning(id: object, service: ServiceName, stop: () => void): void {
    running?.set(id, { id, service, stop });
}

/** Records that the loop identified by `id` is no longer running (connected, or explicitly stopped). */
export function markLoopStopped(id: object): void {
    running?.delete(id);
}

/**
 * Lists every reconnection loop that is running right now, in the order they began running.
 * Diagnostic only: the test preload uses it to catch a loop left running past its test. Always
 * empty while tracking is off.
 * @internal
 */
export function listRunningReconnectionLoops(): RunningLoop[] {
    return [...running?.values() ?? []];
}
