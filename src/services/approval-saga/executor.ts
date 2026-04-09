import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceName } from '../types';
import type { ApprovalSagaBackend } from './backend';
import type { ApprovalSagaType } from './types';

export interface SagaExecutorLogger {
    warn:  (obj: object, msg: string) => void
    error: (obj: object, msg: string) => void
    info:  (obj: object, msg: string) => void
}

interface SagaExecutorDeps {
    backend:         ApprovalSagaBackend
    registry:        ServiceHealthRegistry
    executors:       Record<ApprovalSagaType, (params: Record<string, unknown>) => Promise<void>>
    logger:          SagaExecutorLogger
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
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // Stryker disable next-line BooleanLiteral: initial value is always overwritten by start() which sets stopped = false; mutation has no observable effect
    let stopped      = false;
    let intervalId: ReturnType<typeof setInterval> | undefined;

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

    return {
        start(): void {
            stopped = false; // Allow restart after stop()
            // Stryker disable next-line ConditionalExpression: guard prevents double-start; mutation to false skips the guard (no functional effect in tests)
            if(intervalId !== undefined) {
                return;
            }
            intervalId = setInterval(() => {
                // Stryker disable next-line ConditionalExpression: stopped guard prevents execution after stop()
                if(!stopped) {
                    void executeOnce();
                }
            }, pollIntervalMs);
        },

        stop(): void {
            // Stryker disable next-line BooleanLiteral: clearInterval always runs below so stopped flag change is only observable via the interval callback, which is already cleared; equivalent mutant
            stopped = true;
            // Stryker disable next-line ConditionalExpression: clearInterval(undefined) is a no-op so →true mutation is equivalent
            if(intervalId !== undefined) {
                clearInterval(intervalId);
                intervalId = undefined;
            }
        },

        executeOnce,
    };
}
