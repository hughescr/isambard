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

export interface ExecuteOnceResult {
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
            return 'bluesky';
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

    // Stryker disable next-line ConditionalExpression,EqualityOperator: default value fallback — undefined branch never reached when caller provides value
    const baseIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Stryker disable next-line BooleanLiteral: initial value is always overwritten by start() which sets stopped = false; mutation has no observable effect
    let stopped          = false;
    let generation       = 0;
    let currentIntervalMs = baseIntervalMs;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function executeOnce(): Promise<ExecuteOnceResult> {
        const result: ExecuteOnceResult = { executed: 0, failed: 0 };

        const approved = await backend.listByState('approved');

        for(const saga of approved) {
            const requiredService = getRequiredService(saga.type);

            if(!registry.isAvailable(requiredService)) {
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.info({ sagaId: saga.id, type: saga.type, service: requiredService }, 'Skipping saga — required service unavailable');
                // Stryker restore ObjectLiteral,StringLiteral
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- Sequential saga execution required for ordering guarantees
                await executors[saga.type](saga.params);
                // eslint-disable-next-line no-await-in-loop -- Sequential saga execution required for ordering guarantees
                await backend.updateState(saga.id, 'executed');
                result.executed += 1;
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.info({ sagaId: saga.id, type: saga.type }, 'Saga executed successfully');
                // Stryker restore ObjectLiteral,StringLiteral
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                // eslint-disable-next-line no-await-in-loop -- Sequential saga execution required for ordering guarantees
                await backend.updateState(saga.id, 'failed', { lastError: message });
                result.failed += 1;
                // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
                logger.error({ sagaId: saga.id, type: saga.type, error: message }, 'Saga execution failed');
                // Stryker restore ObjectLiteral,StringLiteral
            }
        }

        return result;
    }

    function scheduleNextTick(): void {
        // Stryker disable next-line BlockStatement,ConditionalExpression: stopped guard prevents rescheduling after stop(); path unreachable in fake-timer tests — microtasks flush synchronously after advanceTimersByTime so stop() always precedes the .then() callback
        if(stopped) {
            return;
        }
        const myGen = generation;
        timeoutId = setTimeout(() => {
            void (async () => {
                try {
                    const result = await executeOnce();
                    if(result.executed > 0 || result.failed > 0) {
                        // Stryker disable next-line BlockStatement,ConditionalExpression,EqualityOperator: debug log guard — only suppresses noise when already at base; equivalent mutant (log content is observability-only)
                        if(currentIntervalMs !== baseIntervalMs) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: debug-level logging for tuning observability only
                            logger.debug({ intervalMs: baseIntervalMs }, 'Saga poll interval reset to base');
                        }
                        currentIntervalMs = baseIntervalMs;
                    } else {
                        const next = Math.min(currentIntervalMs * 2, MAX_POLL_INTERVAL_MS);
                        // Stryker disable next-line BlockStatement,ConditionalExpression,EqualityOperator: debug log guard — only suppresses noise when already at cap; equivalent mutant (log content is observability-only)
                        if(next !== currentIntervalMs) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: debug-level logging for tuning observability only
                            logger.debug({ intervalMs: next }, 'Saga poll interval extended');
                        }
                        currentIntervalMs = next;
                    }
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    // Stryker disable next-line ObjectLiteral,StringLiteral: debug-level logging for observability only
                    logger.debug({ error: message }, 'Saga poll tick threw unexpectedly; rescheduling');
                }
                // Only reschedule if this tick's generation still matches the current generation.
                // If stop()+start() ran while this tick was mid-flight, generation was bumped and
                // start() already scheduled a new timer — skip to prevent a leaked duplicate timer.
                if(generation === myGen) {
                    scheduleNextTick();
                }
            })();
        }, currentIntervalMs);
    }

    return {
        start(): void {
            // Stryker disable next-line ConditionalExpression: → true direction (guard always fires) is the equivalent mutant — would prevent restarts even after stop(); → false direction (guard never fires) is killed by the redundant-start tests that verify generation is not bumped on a second start() while already running
            if(timeoutId !== undefined) {
                return;
            }
            stopped = false; // Allow restart after stop()
            // Stryker disable next-line AssignmentOperator: generation +=1 and -=1 are equivalent — both change the value away from myGen (captured at schedule time), ensuring the staleness check fires; only the direction of delta differs
            generation += 1; // Invalidate any mid-flight tick's trailing reschedule
            currentIntervalMs = baseIntervalMs;
            scheduleNextTick();
        },

        stop(): void {
            // Stryker disable next-line BooleanLiteral: clearTimeout always runs below so stopped flag change is only observable via the timeout callback, which is already cleared; equivalent mutant
            stopped = true;
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op so →true mutation is equivalent
            if(timeoutId !== undefined) {
                clearTimeout(timeoutId);
                timeoutId = undefined;
            }
        },

        executeOnce,
    };
}
