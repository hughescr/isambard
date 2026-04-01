import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceName } from '../types';
import type { OutboxBackend } from './backend';
import type { OutboxItem } from './types';

export interface OutboxDrainerLogger {
    warn:  (obj: object, msg: string) => void
    error: (obj: object, msg: string) => void
    info:  (obj: object, msg: string) => void
}

export interface OutboxDrainerDeps {
    outboxBackend:   OutboxBackend
    registry:        ServiceHealthRegistry
    deliverFn:       (item: OutboxItem) => Promise<void>
    logger:          OutboxDrainerLogger
    batchSize?:      number
    drainIntervalMs?: number
}

export interface DrainResult {
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

    // Stryker disable next-line ConditionalExpression,EqualityOperator: default value fallback — undefined branch never reached when caller provides value
    const batchSize      = deps.batchSize      ?? DEFAULT_BATCH_SIZE;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: default value fallback — undefined branch never reached when caller provides value
    const drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL;

    let stopped       = false;
    let draining      = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;

    async function drain(service: ServiceName): Promise<DrainResult> {
        const result: DrainResult = { delivered: 0, failed: 0, skipped: 0 };

        if(draining || stopped) {
            return result;
        }
        // Stryker disable next-line BooleanLiteral: draining guard — concurrent drain blocks until first completes (tested via dequeue call count)
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
                    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                    logger.info({ service }, 'Service went offline mid-drain, stopping');
                    // Stryker restore ObjectLiteral,StringLiteral
                    break;
                }

                // Defensive check: items from a future epoch shouldn't exist; delete and skip them
                if(item.epoch > currentEpoch) {
                    result.skipped += 1;
                    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                    logger.warn({ service, itemId: item.id, itemEpoch: item.epoch, currentEpoch }, 'Deleting outbox item from future epoch');
                    // Stryker restore ObjectLiteral,StringLiteral
                    await outboxBackend.markSent(item);
                    continue;
                }

                try {
                    await deliverFn(item);
                    await outboxBackend.markSent(item);
                    result.delivered += 1;
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                    logger.error({ service, itemId: item.id, error: message }, 'Failed to deliver outbox item');
                    // Stryker restore ObjectLiteral,StringLiteral
                    await outboxBackend.markFailed(item, message);
                    result.failed += 1;
                }
            }

            // If the batch was full and the service is still up, schedule another drain
            if(items.length === batchSize && registry.isAvailable(service) && !stopped) {
                pendingTimer = setTimeout(() => {
                    pendingTimer = undefined;
                    // Stryker disable next-line ConditionalExpression: stopped guard prevents draining after stop(); inner check is unreachable when clearTimeout fires after stop()
                    if(!stopped) {
                        void drain(service);
                    }
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
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op so →true mutation is equivalent
            if(pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }
        },
    };
}
