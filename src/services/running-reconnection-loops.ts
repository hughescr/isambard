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
const running = new Map<object, RunningLoop>();

/** Records that the loop identified by `id` is running. Called by the loop itself whenever it (re)engages. */
export function markLoopRunning(id: object, service: ServiceName, stop: () => void): void {
    running.set(id, { id, service, stop });
}

/** Records that the loop identified by `id` is no longer running (connected, or explicitly stopped). */
export function markLoopStopped(id: object): void {
    running.delete(id);
}

/**
 * Lists every reconnection loop that is running right now, in the order they began running.
 * Diagnostic only: the test preload uses it to catch a loop left running past its test.
 * @internal
 */
export function listRunningReconnectionLoops(): RunningLoop[] {
    return [...running.values()];
}
