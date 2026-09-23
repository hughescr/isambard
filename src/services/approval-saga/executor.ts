import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { ApprovalSagaBackend } from './backend';
import type { ApprovalSagaType } from './types';

/** Logger interface for the saga executor. Alias for {@link ServiceLogger}. */
export type SagaExecutorLogger = ServiceLogger;

interface SagaExecutorDeps {
    backend:         ApprovalSagaBackend
    registry:        ServiceHealthRegistry
    executors:       Record<ApprovalSagaType, (params: Record<string, unknown>) => Promise<void>>
    logger:          ServiceLogger
    pollIntervalMs?: number
}

interface ExecuteOnceResult {
    executed: number
    failed:   number
}

export interface SagaExecutor {
    start(): void
    stop(): void
    executeOnce(): Promise<ExecuteOnceResult>
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Maximum poll interval after repeated empty results (5 minutes). */
const MAX_POLL_INTERVAL_MS = 5 * 60_000;

function getRequiredService(type: ApprovalSagaType): ServiceName {
    switch(type) {
        case 'bsky_reply':
        case 'bsky_dm': {
            return 'bsky';
        }
        case 'email_send':
        case 'email_reply': {
            return 'email';
        }
    }
}

export function createSagaExecutor(deps: SagaExecutorDeps): SagaExecutor {
    const {
        backend,
        registry,
        executors,
        logger,
    } = deps;

    const baseIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Stryker disable next-line BooleanLiteral: initial value is always overwritten by start() which sets stopped = false; mutation has no observable effect
    let stopped          = false;
    let generation: object = {};
    let currentIntervalMs = baseIntervalMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function executeOnce(): Promise<ExecuteOnceResult> {
        const result: ExecuteOnceResult = { executed: 0, failed: 0 };

        const approved = await backend.listByState('approved');

        for(const saga of approved) {
            const requiredService = getRequiredService(saga.type);

            if(!registry.isAvailable(requiredService)) {
                logger.info({ sagaId: saga.id, type: saga.type, service: requiredService }, 'Skipping saga — required service unavailable');
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- Later external actions must wait for this saga's durable outcome.
                await executors[saga.type](saga.params);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                // eslint-disable-next-line no-await-in-loop -- Persist failure before the next action; a failed write propagates and stops this loop.
                await backend.updateState(saga.id, 'failed', { lastError: message });
                result.failed++;
                logger.error({ sagaId: saga.id, type: saga.type, error: message }, 'Saga execution failed');
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- Persist success before starting the next external action; a failed write stops this loop.
            await backend.updateState(saga.id, 'executed');
            result.executed++;
            logger.info({ sagaId: saga.id, type: saga.type }, 'Saga executed successfully');
        }

        return result;
    }

    function scheduleNextTick(): void {
        if(stopped) {
            return;
        }
        const scheduledGeneration = generation;
        timeoutId = setTimeout(() => {
            void (async () => {
                try {
                    const result = await executeOnce();
                    if(result.executed > 0 || result.failed > 0) {
                        if(currentIntervalMs !== baseIntervalMs) {
                            logger.debug({ intervalMs: baseIntervalMs }, 'Saga poll interval reset to base');
                        }
                        currentIntervalMs = baseIntervalMs;
                    } else {
                        const next = Math.min(currentIntervalMs * 2, MAX_POLL_INTERVAL_MS);
                        if(next !== currentIntervalMs) {
                            logger.debug({ intervalMs: next }, 'Saga poll interval extended');
                        }
                        currentIntervalMs = next;
                    }
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.debug({ error: message }, 'Saga poll tick threw unexpectedly; rescheduling');
                }
                // Only reschedule if this tick's generation still matches the current generation.
                // If stop()+start() ran while this tick was mid-flight, generation was replaced and
                // start() already scheduled a new timer — skip to prevent a leaked duplicate timer.
                if(generation === scheduledGeneration) {
                    scheduleNextTick();
                }
            })();
        }, currentIntervalMs);
    }

    return {
        start(): void {
            if(timeoutId !== undefined) {
                return;
            }
            stopped = false; // Allow restart after stop()
            generation = {}; // Invalidate any mid-flight tick's trailing reschedule
            currentIntervalMs = baseIntervalMs;
            scheduleNextTick();
        },

        stop(): void {
            stopped = true;
            clearTimeout(timeoutId);
            timeoutId = undefined;
        },

        executeOnce,
    };
}
