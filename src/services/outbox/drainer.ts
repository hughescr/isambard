import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { OutboxBackend } from './backend';
import type { OutboxItem } from './types';

export interface OutboxDrainerDeps {
    outboxBackend:    OutboxBackend
    registry:         ServiceHealthRegistry
    deliverFn:        (item: OutboxItem) => Promise<void>
    logger:           ServiceLogger
    batchSize?:       number
    drainIntervalMs?: number
}

interface DrainResult {
    delivered: number
    failed:    number
    skipped:   number
}

export interface OutboxDrainer {
    drain(service: ServiceName): Promise<DrainResult>
    stop(): void
}

const DEFAULT_BATCH_SIZE      = 10;
const DEFAULT_DRAIN_INTERVAL  = 1000;

export function createOutboxDrainer(deps: OutboxDrainerDeps): OutboxDrainer {
    const {
        outboxBackend,
        registry,
        deliverFn,
        logger,
    } = deps;

    const batchSize      = deps.batchSize      ?? DEFAULT_BATCH_SIZE;
    const drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL;

    let stopped       = false;
    let draining      = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

    async function drain(service: ServiceName): Promise<DrainResult> {
        const result: DrainResult = { delivered: 0, failed: 0, skipped: 0 };

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

            for(const item of items) {
                // Re-check availability after each item
                if(!registry.isAvailable(service)) {
                    logger.info({ service }, 'Service went offline mid-drain, stopping');
                    break;
                }

                // Defensive check: items from a future epoch shouldn't exist; delete and skip them
                if(item.epoch > currentEpoch) {
                    result.skipped += 1;
                    logger.warn({ service, itemId: item.id, itemEpoch: item.epoch, currentEpoch }, 'Deleting outbox item from future epoch');
                    // eslint-disable-next-line no-await-in-loop -- Sequential outbox drain required for ordering guarantees
                    await outboxBackend.markSent(item);
                    continue;
                }

                try {
                    // eslint-disable-next-line no-await-in-loop -- Sequential outbox drain required for ordering guarantees
                    await deliverFn(item);
                    // eslint-disable-next-line no-await-in-loop -- Sequential outbox drain required for ordering guarantees
                    await outboxBackend.markSent(item);
                    result.delivered += 1;
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.error({ service, itemId: item.id, error: message }, 'Failed to deliver outbox item');
                    // eslint-disable-next-line no-await-in-loop -- Sequential outbox drain required for ordering guarantees
                    await outboxBackend.markFailed(item, message);
                    result.failed += 1;
                }
            }

            // If the batch was full and the service is still up, schedule another drain
            // Stryker disable next-line llm: dequeue caps returned valid items at batchSize even when malformed rows require multiple pages, so items.length cannot exceed batchSize and === and >= coincide.
            const batchFull = items.length === batchSize;
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stopped can be set true by stop() between awaits
            if(batchFull && registry.isAvailable(service) && !stopped) {
                pendingTimer = setTimeout(() => {
                    // Stryker disable next-line llm: pendingTimer is only read by stop()'s clearTimeout, which is a no-op on a fired timer, and the next schedule overwrites it, so a retained handle is unobservable.
                    pendingTimer = undefined;
                    void drain(service);
                }, drainIntervalMs);
            }

            return result;
        } finally {
            // eslint-disable-next-line require-atomic-updates -- single-threaded: draining is only set here and at guard; no true race condition possible
            draining = false;
        }
    }

    return {
        drain,

        stop(): void {
            stopped = true;
            clearTimeout(pendingTimer);
            pendingTimer = undefined;
        },
    };
}
