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
 * Permanent failures, and unclassified ones written before #40, stay failed. Resets are
 * written one at a time in the backend's listed order; the first write failure stops the
 * pass (later actions stay failed for the next reconnect) and is logged once.
 */
export async function retryTransientFailures(deps: RetryDeps, service: ServiceName): Promise<void> {
    const { backend, logger } = deps;
    try {
        const failed = await backend.listByState('failed');
        const forService = failed.filter(action => requiredServiceFor(action.type) === service);
        let reset = 0;
        for(const action of forService) {
            if(action.failureKind !== 'transient') {
                continue;
            }
            // eslint-disable-next-line no-await-in-loop -- ordered durable state transitions; a failed write stops the pass.
            await backend.updateState(action.id, 'approved');
            reset++;
        }
        if(forService.length > 0) {
            logger.info({ service, reset, skipped: forService.length - reset }, 'Reset transient approved outbound action failures on reconnect');
        }
    } catch (err: unknown) {
        logger.warn({ service, error: err instanceof Error ? err.message : String(err) }, 'Failed to reset approved outbound actions on reconnect');
    }
}

/**
 * Health listener that retries transiently failed approved outbound actions when the service
 * they need comes back online.
 */
export function createApprovedActionRetryListener(deps: RetryDeps): HealthChangeListener {
    return (change) => {
        if(change.newState !== 'online' || !SERVICES_WITH_ACTIONS.has(change.service)) {
            return;
        }
        void retryTransientFailures(deps, change.service);
    };
}
