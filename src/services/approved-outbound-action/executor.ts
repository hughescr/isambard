import { ZodError } from 'zod';
import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { ApprovedOutboundActionBackend } from './backend';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, createSingleFlightLoop } from './single-flight-loop';
import type { ApprovedOutboundActionType, FailureKind } from './types';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError } from '@/errors';

/** Logger interface for the approved-outbound-action executor. Alias for {@link ServiceLogger}. */
export type ApprovedOutboundActionExecutorLogger = ServiceLogger;

interface ApprovedOutboundActionExecutorDeps {
    backend:           ApprovedOutboundActionBackend
    registry:          ServiceHealthRegistry
    executors:         Record<ApprovedOutboundActionType, (params: Record<string, unknown>) => Promise<void>>
    logger:            ServiceLogger
    /**
     * Called after each durable terminal write (`executed` or `failed`), so the outcome
     * reporter can report it straight away. The write itself carries the report's outbox marker
     * (`outcomeReportPending`), so a lost signal only delays the report until its next poll.
     */
    onOutcomeRecorded: () => void
    pollIntervalMs?:   number
}

interface ExecuteOnceResult {
    executed: number
    failed:   number
}

export interface ApprovedOutboundActionExecutor {
    start(): void
    stop(): void
    /**
     * Run as soon as possible instead of waiting for the next poll — called when an approved
     * row is created or its service comes back online. Never starts a second concurrent run.
     */
    wake(): void
    executeOnce(): Promise<ExecuteOnceResult>
}

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

/**
 * Build the executor. Every run — poll timer, {@link ApprovedOutboundActionExecutor.wake} or
 * `executeOnce()` — goes through one {@link createSingleFlightLoop}, so two runs never overlap:
 * an overlapping run would list the same approved row and call its external send twice, and the
 * conditional state write only notices after the send.
 */
export function createApprovedOutboundActionExecutor(deps: ApprovedOutboundActionExecutorDeps): ApprovedOutboundActionExecutor {
    const {
        backend,
        registry,
        executors,
        logger,
        onOutcomeRecorded,
    } = deps;

    async function executeActions(): Promise<ExecuteOnceResult> {
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
                onOutcomeRecorded();
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- Persist success before starting the next external action; a failed write stops this loop.
            await backend.updateState(action.id, 'executed');
            result.executed++;
            logger.info({ actionId: action.id, type: action.type }, 'Approved outbound action executed successfully');
            onOutcomeRecorded();
        }

        return result;
    }

    const loop = createSingleFlightLoop({
        run:            executeActions,
        madeProgress:   result => result.executed > 0 || result.failed > 0,
        baseIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        maxIntervalMs:  MAX_POLL_INTERVAL_MS,
        logger,
        label:          'Approved outbound action',
    });

    return {
        start:       loop.start,
        stop:        loop.stop,
        wake:        loop.wake,
        executeOnce: loop.runOnce,
    };
}
