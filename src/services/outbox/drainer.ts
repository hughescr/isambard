import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger } from '../types';
import type { OutboxBackend } from './backend';
import { OUTBOX_FAILURE_FALLBACK, type OutboxFailureClassifier } from './failure-classifier';
import type { DrainerDiscardReason, OutboxItem, OutboxService, OutboxDiscardReason } from './types';

/** Raised by the replay adapter when an unknown result could not be verified safely. */
export class OutboxVerificationPendingError extends Error {
    constructor(message = 'Discord delivery verification remains indeterminate') {
        super(message);
        this.name = 'OutboxVerificationPendingError';
    }
}

/**
 * Raised by a delivery function that has settled an item's fate itself (for example after
 * telling Izzy that a queued reply's target was deleted): the drainer discards the item with
 * `reason` and never classifies the error, so it cannot be retried or silently abandoned.
 */
export class OutboxDiscardRequestedError extends Error {
    constructor(readonly reason: OutboxDiscardReason, message = `Outbox item discard requested: ${reason}`) {
        super(message);
        this.name = 'OutboxDiscardRequestedError';
    }
}

/** How long {@link OutboxDeliveryDeferredError} postpones an item. */
export const OUTBOX_DEFERRED_RETRY_DELAY_MS = 30_000;

/**
 * Raised by a delivery function that cannot finish an item yet for a reason that is not a
 * delivery failure (for example Izzy cannot be told about a dropped reply until the conductor
 * accepts work). The drainer postpones the item by {@link OUTBOX_DEFERRED_RETRY_DELAY_MS}
 * without spending one of its attempts.
 */
export class OutboxDeliveryDeferredError extends Error {
    constructor(message = 'Outbox delivery deferred') {
        super(message);
        this.name = 'OutboxDeliveryDeferredError';
    }
}

/**
 * Reports that the drainer is about to discard `item` undelivered. It is called before every
 * discard the drainer decides itself (stale_epoch, permanent_error, classified_abandon) and never
 * for an {@link OutboxDiscardRequestedError}, whose delivery function already settled and reported
 * its item, so a reply_target_deleted discard is never reported twice. A `false` return means the
 * loss cannot be reported yet: the drainer keeps the row as a pending discard, never resends it,
 * and reports it again after {@link OUTBOX_DEFERRED_RETRY_DELAY_MS}.
 */
export type OutboxDiscardReporter = (item: OutboxItem, reason: DrainerDiscardReason) => boolean;

export interface OutboxDrainerDeps {
    outboxBackend:      OutboxBackend
    registry:           ServiceHealthRegistry
    deliverFn:          (item: OutboxItem) => Promise<void>
    logger:             ServiceLogger
    batchSize?:         number
    drainIntervalMs?:   number
    maxAttempts?:       number
    failureClassifier?: OutboxFailureClassifier
    /** See {@link OutboxDiscardReporter}. Without one, discards are only logged. */
    reportDiscard?:     OutboxDiscardReporter
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
    let drainRequested = false;
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

    function scheduleAt(service: OutboxService, nextAttemptAt: string): void {
        schedule(service, Math.max(0, new Date(nextAttemptAt).getTime() - now()));
    }

    function deferredRetryAt(): string {
        return new Date(now() + OUTBOX_DEFERRED_RETRY_DELAY_MS).toISOString();
    }

    /** A discard already decided on (a stale epoch, spent attempts, or one recorded earlier). */
    function terminalReason(item: OutboxItem, currentEpoch: number): DrainerDiscardReason | undefined {
        if(item.progress.pendingDiscard !== undefined) {
            return item.progress.pendingDiscard;
        }
        if(item.epoch > currentEpoch) {
            return 'stale_epoch';
        }
        if(item.progress.attemptCount >= maxAttempts) {
            return 'permanent_error';
        }
        return undefined;
    }

    async function keepPendingDiscard(service: OutboxService, item: OutboxItem, reason: DrainerDiscardReason): Promise<void> {
        const until = deferredRetryAt();
        await outboxBackend.markPendingDiscard(item, reason, until);
        scheduleAt(service, until);
    }

    /**
     * After a failed delete the loss has already been reported, so the row must not stay eligible
     * to resend: a stale-epoch row would otherwise be delivered once the epoch caught up (a failed
     * terminal markFailed delete keeps an exhausted marker for the same reason).
     */
    async function keepDecidedDiscard(service: OutboxService, item: OutboxItem, reason: DrainerDiscardReason): Promise<void> {
        try {
            await keepPendingDiscard(service, item, reason);
        } catch (error: unknown) {
            logger.error({ service, itemId: item.id, reason, error }, 'Failed to keep discarded outbox item from being resent');
        }
    }

    /**
     * Reports a drainer-decided discard, then deletes the row. Returns false, keeping the row as
     * a pending discard, while the loss cannot be reported yet. A failed delete rethrows after
     * marking the row as a pending discard.
     */
    async function reportThenDiscard(service: OutboxService, item: OutboxItem, reason: DrainerDiscardReason): Promise<boolean> {
        if(deps.reportDiscard?.(item, reason) === false) {
            logger.info({ service, itemId: item.id, reason }, 'Outbox discard waits until Izzy can be told');
            await keepPendingDiscard(service, item, reason);
            return false;
        }
        try {
            await outboxBackend.discard(item, reason);
        } catch (error: unknown) {
            await keepDecidedDiscard(service, item, reason);
            throw error;
        }
        return true;
    }

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- sequential send, retry, discard and acknowledgement have distinct failure contracts
    async function drain(service: OutboxService): Promise<DrainResult> {
        const result: DrainResult = { delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 };
        if(stopped) {
            return result;
        }
        if(draining) {
            // A request that arrives mid-drain (a retry timer firing, an enqueue wakeup) may concern
            // a row the active scan already passed over, so it runs once that drain settles.
            drainRequested = true;
            return result;
        }
        draining = true;
        try {
            if(!registry.isAvailable(service)) {
                return result;
            }
            const currentEpoch = registry.getEntry(service).epoch;
            // schedule() keeps only its earliest timer, so a shorter continuation can displace a
            // retry deadline; every scan re-arms the deadlines of the rows it skipped as not yet due.
            const items = await outboxBackend.dequeue(service, batchSize, (nextAttemptAt) => {
                scheduleAt(service, nextAttemptAt);
            });
            let dispositionError = false;
            for(const item of items) {
                if(!registry.isAvailable(service)) {
                    logger.info({ service }, 'Service went offline mid-drain, stopping');
                    break;
                }
                const reason = terminalReason(item, currentEpoch);
                if(reason !== undefined) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                        if(await reportThenDiscard(service, item, reason)) {
                            result.discarded += 1;
                        }
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
                    if(err instanceof OutboxDiscardRequestedError) {
                        try {
                            // eslint-disable-next-line no-await-in-loop -- discard must complete before continuing with later work
                            await outboxBackend.discard(item, err.reason);
                            result.discarded += 1;
                        } catch (error: unknown) {
                            dispositionError = true;
                            logger.error({ service, itemId: item.id, reason: err.reason, error }, 'Failed to discard outbox item');
                        }
                        continue;
                    }
                    if(err instanceof OutboxDeliveryDeferredError) {
                        const deferredUntil = deferredRetryAt();
                        try {
                            // eslint-disable-next-line no-await-in-loop -- persist the deferral before processing later work
                            await outboxBackend.defer(item, message, deferredUntil);
                            scheduleAt(service, deferredUntil);
                        } catch (error: unknown) {
                            dispositionError = true;
                            logger.error({ service, itemId: item.id, error }, 'Failed to defer outbox item');
                        }
                        continue;
                    }
                    const nextAttemptAt = retryAt(item);
                    if(err instanceof OutboxVerificationPendingError) {
                        try {
                            // eslint-disable-next-line no-await-in-loop -- persist the safe verification state before processing later work
                            await outboxBackend.markUnknown(item, message, nextAttemptAt);
                            scheduleAt(service, nextAttemptAt);
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
                    // What a discard report says about this failure. The outcome is left as delivery
                    // left it: the replay settles an unknown outcome only once it has checked history,
                    // so a failure before that (a channel lookup) is still reported as unconfirmed.
                    const rejected: OutboxItem = { ...item, progress: { ...item.progress, lastError: message } };
                    if(classification.disposition === 'abandon') {
                        try {
                            // eslint-disable-next-line no-await-in-loop -- discard must complete before continuing with later work
                            if(await reportThenDiscard(service, rejected, 'classified_abandon')) {
                                logger.warn({ service, itemId: item.id, decision: classification.disposition, confidence: classification.confidence }, 'Discarded classified outbox delivery failure');
                                result.discarded += 1;
                            }
                        } catch (error: unknown) {
                            logger.error({ service, itemId: item.id, reason: 'classified_abandon', error }, 'Failed to discard classified outbox item');
                        }
                        result.failed += 1;
                        continue;
                    }
                    const retryable = item.progress.attemptCount + 1 < maxAttempts;
                    logger.error({ service, itemId: item.id, error: message }, 'Failed to deliver outbox item');
                    // The loss is reported before a final failure is discarded. While it cannot be,
                    // the row is kept as an exhausted marker that a later pass reports and discards.
                    const unreported = !retryable && deps.reportDiscard?.(rejected, 'permanent_error') === false;
                    const keep = retryable || unreported;
                    const keepUntil = unreported ? deferredRetryAt() : nextAttemptAt;
                    try {
                        // eslint-disable-next-line no-await-in-loop -- sequential outbox processing preserves order
                        await outboxBackend.markFailed(item, message, { retryable: keep, ...(keep ? { nextAttemptAt: keepUntil } : {}) });
                        if(keep) {
                            scheduleAt(service, keepUntil);
                        } else {
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
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stop() can run between awaits
            if(drainRequested && !stopped) {
                drainRequested = false;
                schedule(service, drainIntervalMs);
            }
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
