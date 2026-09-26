/**
 * Periodic local prune of expired vector-index rows (#129).
 *
 * DynamoDB deletes a memory silently when its TTL passes; the vector row carries the same TTL, so
 * pruning it locally keeps the index converged with zero DynamoDB reads. `start()` prunes at once
 * (the startup prune) and then every {@link VECTOR_PRUNE_INTERVAL_MS}. Queries already hide
 * expired rows, so the interval only bounds how long they occupy space and KNN candidate slots.
 */
import type { VectorIndex } from './backend.js';

/** How often the app prunes expired rows. A code constant, not a config knob. */
export const VECTOR_PRUNE_INTERVAL_MS = 3_600_000;

interface VectorPruneLogger {
    debug: (obj: Record<string, unknown>) => void
    info:  (obj: Record<string, unknown>) => void
    warn:  (obj: Record<string, unknown>) => void
}

export interface VectorPruneSchedulerDeps {
    vectorIndex: Pick<VectorIndex, 'pruneExpired' | 'pruneExpiredTombstones' | 'isClosed'>
    logger:      VectorPruneLogger
    intervalMs?: number
}

export interface VectorPruneScheduler {
    /** Prunes now, then on every interval. Idempotent while running. */
    start:   () => void
    /** Clears the interval. Idempotent. */
    stop:    () => void
    /** One prune pass; never throws. Skipped once the index is closed. */
    runOnce: () => void
}

export function createVectorPruneScheduler(deps: VectorPruneSchedulerDeps): VectorPruneScheduler {
    const intervalMs = deps.intervalMs ?? VECTOR_PRUNE_INTERVAL_MS;
    let timer: ReturnType<typeof setInterval> | undefined;

    const runOnce = (): void => {
        if(deps.vectorIndex.isClosed) {
            return;
        }
        try {
            const pruned = deps.vectorIndex.pruneExpired();
            if(pruned > 0) {
                deps.logger.info({ pruned, msg: 'Pruned expired vector-index rows' });
            } else {
                deps.logger.debug({ pruned, msg: 'No expired vector-index rows to prune' });
            }
        } catch (error) {
            deps.logger.warn({ error, msg: 'Vector-index expiry prune failed; will retry next interval' });
        }
        // Independent try/catch (#134): a tombstone-prune failure must never block the expiry
        // prune above, and vice versa — each kind retries on its own next interval.
        try {
            const pruned = deps.vectorIndex.pruneExpiredTombstones();
            if(pruned > 0) {
                deps.logger.info({ pruned, msg: 'Pruned expired delete tombstones' });
            } else {
                deps.logger.debug({ pruned, msg: 'No expired delete tombstones to prune' });
            }
        } catch (error) {
            deps.logger.warn({ error, msg: 'Vector-index tombstone prune failed; will retry next interval' });
        }
    };

    return {
        start: () => {
            if(timer !== undefined) {
                return;
            }
            runOnce();
            timer = setInterval(runOnce, intervalMs);
        },
        stop: () => {
            clearInterval(timer);
            timer = undefined;
        },
        runOnce,
    };
}
