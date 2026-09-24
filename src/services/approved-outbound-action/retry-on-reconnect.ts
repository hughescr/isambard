import type { HealthChangeListener, ServiceLogger, ServiceName } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import { requiredServiceFor } from './executor';
import { approvedOutboundActionTypeSchema } from './types';

interface RetryDeps {
    backend: Pick<ApprovedOutboundActionBackend, 'listByState' | 'updateState'>
    logger:  ServiceLogger
}

/** Services that at least one action type depends on; other services' events are ignored. */
const SERVICES_WITH_ACTIONS: ReadonlySet<ServiceName> = new Set(approvedOutboundActionTypeSchema.options.map(type => requiredServiceFor(type)));

/**
 * Reset `service`'s transiently failed actions to `approved` so the executor retries them.
 * Permanent failures, and unclassified ones written before #40, stay failed.
 *
 * A transient failure with no `firstClaimedAt` was recorded by a build that labelled errors
 * which do not prove the message was refused (a network failure, a timeout, a 5xx) transient
 * too, so it may have been delivered. It is moved to `unverified` instead, and the executor
 * checks its destination before any resend (#108).
 *
 * Moves are written one at a time in the backend's listed order; the first write failure stops
 * the pass (later actions stay failed for the next reconnect) and is logged once.
 */
export async function retryTransientFailures(deps: RetryDeps, service: ServiceName): Promise<void> {
    const { backend, logger } = deps;
    try {
        const failed = await backend.listByState('failed');
        const forService = failed.filter(action => requiredServiceFor(action.type) === service);
        let reset = 0;
        let verifying = 0;
        for(const action of forService) {
            if(action.failureKind !== 'transient') {
                continue;
            }
            if(action.firstClaimedAt === undefined) {
                // eslint-disable-next-line no-await-in-loop -- ordered durable state transitions; a failed write stops the pass.
                await backend.updateState(action.id, 'unverified');
                verifying++;
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- ordered durable state transitions; a failed write stops the pass.
            await backend.updateState(action.id, 'approved');
            reset++;
        }
        if(forService.length > 0) {
            logger.info(
                { service, reset, verifying, skipped: forService.length - reset - verifying },
                'Reset transient approved outbound action failures on reconnect'
            );
        }
    } catch (err: unknown) {
        logger.warn({ service, error: err instanceof Error ? err.message : String(err) }, 'Failed to reset approved outbound actions on reconnect');
    }
}

interface RetryListenerDeps extends RetryDeps {
    /** Wakes the executor, so reset rows — and approved rows skipped during the outage — go out at once. */
    wake: () => void
}

/**
 * Health listener that retries transiently failed approved outbound actions when the service
 * they need comes back online, then wakes the executor. The wake follows every reset pass —
 * whether it reset rows, found none, or failed — because approved rows skipped while the service
 * was down are waiting too. `retryTransientFailures` never rejects.
 */
export function createApprovedActionRetryListener(deps: RetryListenerDeps): HealthChangeListener {
    return (change) => {
        if(change.newState !== 'online' || !SERVICES_WITH_ACTIONS.has(change.service)) {
            return;
        }
        void (async () => {
            await retryTransientFailures(deps, change.service);
            deps.wake();
        })();
    };
}
