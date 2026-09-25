import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger } from '../types';
import type { OutboxBackend } from './backend';
import { OUTBOX_FAILURE_FALLBACK, type OutboxFailureClassifier } from './failure-classifier';
import type { OutboxItem, OutboxService, OutboxDiscardReason } from './types';

/** Raised by the replay adapter when an unknown result could not be verified safely. */
export class OutboxVerificationPendingError extends Error {
    constructor(message = 'Discord delivery verification remains indeterminate') {
        super(message);
        this.name = 'OutboxVerificationPendingError';
    }
}

export interface OutboxDrainerDeps {
    outboxBackend:      OutboxBackend
    registry:           ServiceHealthRegistry
    deliverFn:          (item: OutboxItem) => Promise<void>
    logger:             ServiceLogger
    batchSize?:         number
    drainIntervalMs?:   number
    maxAttempts?:       number
    failureClassifier?: OutboxFailureClassifier
    /** Injected for deterministic delayed-retry tests. */
    now?:               () => number
}

export interface DrainResult {
    delivered:      number
    failed:         number
    discarded:      number
    unacknowledged: number
}

export interface OutboxDrainer {
    drain(service: OutboxService): Promise<DrainResult>
    stop(): void
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_DRAIN_INTERVAL = 1000;
const DEFAULT_MAX_ATTEMPTS = 10;

export function createOutboxDrainer(deps: OutboxDrainerDeps): OutboxDrainer {
    const { outboxBackend, registry, deliverFn, logger } = deps;
    const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    const drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL;
    const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const now = deps.now ?? Date.now;
    const failureClassifier = deps.failureClassifier;
    let stopped = false;
    let draining = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingAt: number | undefined;

    function retryAt(item: OutboxItem): string {
        const delay = Math.min(drainIntervalMs * 2 ** item.progress.attemptCount, 60_000);
        return new Date(now() + delay).toISOString();
    }

    function schedule(service: OutboxService, delay: number): void {
        const scheduledAt = now() + delay;
        if(pendingAt === undefined || scheduledAt < pendingAt) {
            clearTimeout(pendingTimer);
            pendingAt = scheduledAt;
            pendingTimer = setTimeout(() => {
                pendingTimer = undefined;
                pendingAt = undefined;
                void drain(service);
            }, delay);
        }
    }

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- sequential send, retry, discard and acknowledgement have distinct failure contracts
    async function drain(service: OutboxService): Promise<DrainResult> {
        const result: DrainResult = { delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 };
        if(draining || stopped) {
            return result;
        }
        draining = true;
        try {
            if(!registry.isAvailable(service)) {
                return result;
            }
            const currentEpoch = registry.getEntry(service).epoch;
            const items = await outboxBackend.dequeue(service, batchSize);
            let dispositionError = false;
            for(const item of items) {
                if(!registry.isAvailable(service)) {
                    logger.info({ service }, 'Service went offline mid-drain, stopping');
                    break;
                }
                let reason: OutboxDiscardReason | undefined;
                if(item.epoch > currentEpoch) {
                    reason = 'stale_epoch';
                } else if(item.progress.attemptCount >= maxAttempts) {
                    reason = 'permanent_error';
                }
                if(reason !== undefined) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                        await outboxBackend.discard(item, reason);
                        result.discarded += 1;
                    } catch (error: unknown) {
                        dispositionError = true;
                        logger.error({ service, itemId: item.id, reason, attemptCount: item.progress.attemptCount, error }, 'Failed to discard outbox item');
                    }
                    continue;
                }
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                    await deliverFn(item);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    const nextAttemptAt = retryAt(item);
                    if(err instanceof OutboxVerificationPendingError) {
                        try {
                            // eslint-disable-next-line no-await-in-loop -- persist the safe verification state before processing later work
                            await outboxBackend.markUnknown(item, message, nextAttemptAt);
                            schedule(service, Math.max(0, new Date(nextAttemptAt).getTime() - now()));
                        } catch (error: unknown) {
                            logger.error({ service, itemId: item.id, error }, 'Failed to persist indeterminate outbox verification');
                        }
                        continue;
                    }
                    const details = typeof err === 'object' && err !== null ? err as { status?: unknown, code?: unknown } : {};
                    const knownRejection = typeof details.status === 'number' || typeof details.code === 'number';
                    const classification = knownRejection && failureClassifier !== undefined
                        // eslint-disable-next-line no-await-in-loop -- a classification belongs to this item and must precede its disposition
                        ? await failureClassifier.classify({ message, ...(typeof details.status === 'number' ? { status: details.status } : {}), ...(typeof details.code === 'number' ? { code: details.code } : {}) })
                        : OUTBOX_FAILURE_FALLBACK;
                    if(classification.disposition === 'abandon') {
                        try {
                            // eslint-disable-next-line no-await-in-loop -- discard must complete before continuing with later work
                            await outboxBackend.discard(item, 'classified_abandon');
                            logger.warn({ service, itemId: item.id, decision: classification.disposition, confidence: classification.confidence }, 'Discarded classified outbox delivery failure');
                            result.discarded += 1;
                        } catch (error: unknown) {
                            logger.error({ service, itemId: item.id, reason: 'classified_abandon', error }, 'Failed to discard classified outbox item');
                        }
                        result.failed += 1;
                        continue;
                    }
                    const retryable = item.progress.attemptCount + 1 < maxAttempts;
                    logger.error({ service, itemId: item.id, error: message }, 'Failed to deliver outbox item');
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                        await outboxBackend.markFailed(item, message, { retryable, ...(retryable ? { nextAttemptAt } : {}) });
                        if(retryable) {
                            schedule(service, Math.max(0, new Date(nextAttemptAt).getTime() - now()));
                        }
                        if(!retryable) {
                            result.discarded += 1;
                        }
                    } catch (error: unknown) {
                        logger.error({ service, itemId: item.id, reason: retryable ? 'retry' : 'permanent_error', attemptCount: item.progress.attemptCount + 1, error }, 'Failed to record outbox delivery failure');
                    }
                    result.failed += 1;
                    continue;
                }
                try {
                    // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                    await outboxBackend.acknowledgeDelivered(item);
                    result.delivered += 1;
                } catch (error: unknown) {
                    logger.error({ service, itemId: item.id, attemptCount: item.progress.attemptCount, error }, 'Outbox item delivered but unacknowledged');
                    result.unacknowledged += 1;
                }
            }
            // No immediate retry of a failure or uncertain acknowledgement: a full batch of
            // failures otherwise exhausts attempts (or duplicates sends) in seconds.
            // Dequeue caps the batch at batchSize; a full batch may have more work queued.
            const batchFull = items.length >= batchSize;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can run between awaits
            if(batchFull && result.failed === 0 && result.unacknowledged === 0 && !dispositionError && registry.isAvailable(service) && !stopped) {
                schedule(service, drainIntervalMs);
            }
            return result;
        } finally {
            // eslint-disable-next-line require-atomic-updates -- single-threaded guard
            draining = false;
        }
    }

    return {
        drain,
        stop(): void {
            stopped = true;
            clearTimeout(pendingTimer);
            pendingTimer = undefined;
            pendingAt = undefined;
        },
    };
}
