import { ZodError } from 'zod';
import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import type { ApprovedOutboundActionType, FailureKind } from './types';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError } from '@/errors';

/** Logger interface for the approved-outbound-action executor. Alias for {@link ServiceLogger}. */
export type ApprovedOutboundActionExecutorLogger = ServiceLogger;

interface ApprovedOutboundActionExecutorDeps {
    backend:         ApprovedOutboundActionBackend
    registry:        ServiceHealthRegistry
    executors:       Record<ApprovedOutboundActionType, (params: Record<string, unknown>) => Promise<void>>
    logger:          ServiceLogger
    pollIntervalMs?: number
}

interface ExecuteOnceResult {
    executed: number
    failed:   number
}

export interface ApprovedOutboundActionExecutor {
    start(): void
    stop(): void
    executeOnce(): Promise<ExecuteOnceResult>
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Maximum poll interval after repeated empty results (5 minutes). */
const MAX_POLL_INTERVAL_MS = 5 * 60_000;

/** The service that must be available before an action of this type can execute. */
export function requiredServiceFor(type: ApprovedOutboundActionType): ServiceName {
    switch(type) {
        case 'bsky_reply':
        case 'bsky_dm': {
            return 'bsky';
        }
        case 'email_send': {
            return 'email';
        }
    }
}

/**
 * Label an execution failure. `permanent` means retrying the same stored action cannot
 * succeed: its params do not parse (ZodError), Bluesky rejected the content
 * (BskyValidationError), or Bluesky answered with a 4xx status other than auth (401) or rate
 * limit (429). Everything else — network errors, Bluesky 5xx, auth and rate-limit errors, and
 * every WildDuck error (which carries no status to inspect) — is `transient` and retried on
 * reconnect.
 */
export function classifyFailure(err: unknown): FailureKind {
    if(err instanceof ZodError || err instanceof BskyValidationError) {
        return 'permanent';
    }
    if(err instanceof BskyAuthError || err instanceof BskyRateLimitError) {
        return 'transient';
    }
    if(err instanceof BskyError) {
        const status = err.context?.status;
        if(typeof status === 'number' && status >= 400 && status <= 499) {
            return 'permanent';
        }
    }
    return 'transient';
}

export function createApprovedOutboundActionExecutor(deps: ApprovedOutboundActionExecutorDeps): ApprovedOutboundActionExecutor {
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

        for(const action of approved) {
            const requiredService = requiredServiceFor(action.type);

            if(!registry.isAvailable(requiredService)) {
                logger.info({ actionId: action.id, type: action.type, service: requiredService }, 'Skipping approved outbound action — required service unavailable');
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- Later external actions must wait for this action's durable outcome.
                await executors[action.type](action.params);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                const failureKind = classifyFailure(err);
                // eslint-disable-next-line no-await-in-loop -- Persist failure before the next action; a failed write propagates and stops this loop.
                await backend.updateState(action.id, 'failed', { lastError: message, failureKind });
                result.failed++;
                logger.error({ actionId: action.id, type: action.type, error: message, failureKind }, 'Approved outbound action execution failed');
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- Persist success before starting the next external action; a failed write stops this loop.
            await backend.updateState(action.id, 'executed');
            result.executed++;
            logger.info({ actionId: action.id, type: action.type }, 'Approved outbound action executed successfully');
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
                            logger.debug({ intervalMs: baseIntervalMs }, 'Approved outbound action poll interval reset to base');
                        }
                        currentIntervalMs = baseIntervalMs;
                    } else {
                        const next = Math.min(currentIntervalMs * 2, MAX_POLL_INTERVAL_MS);
                        if(next !== currentIntervalMs) {
                            logger.debug({ intervalMs: next }, 'Approved outbound action poll interval extended');
                        }
                        currentIntervalMs = next;
                    }
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    logger.debug({ error: message }, 'Approved outbound action poll tick threw unexpectedly; rescheduling');
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
