import { ZodError } from 'zod';
import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { ApprovedOutboundActionBackend, ClaimOutcome } from './backend';
import { raceSendTimeout } from './send-timeout';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, createSingleFlightLoop, type SingleFlightLoop } from './single-flight-loop';
import {
    approvedOutboundActionTypeSchema,
    isClaimed,
    type ApprovedOutboundActionType,
    type ClaimedApprovedOutboundAction,
    type FailureKind
} from './types';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError, InvariantViolationError } from '@/errors';

/** Logger interface for the approved-outbound-action executor. Alias for {@link ServiceLogger}. */
export type ApprovedOutboundActionExecutorLogger = ServiceLogger;

/**
 * How long one external send may take before its outcome is recorded as unknown (2 minutes).
 * It must exceed the clients' own worst case — WildDuck's 30 s per-request timeout, plus one
 * re-auth and one retry, is about 90 s — so a send that would still have answered is not cut off.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 120_000;

/**
 * How old a `sending` row's claim must be before any executor treats it as abandoned (15
 * minutes): a process died, or restarted after its outcome write failed, between claim and
 * settle. Far above the send timeout, so a live claim is never swept.
 */
export const DEFAULT_CLAIM_LEASE_MS = 15 * 60_000;

/** The lastError recorded for a send that timed out: it may or may not have been delivered. */
export function sendTimedOutError(timeoutMs: number): string {
    return `No response within ${timeoutMs / 1000}s, so it may or may not have been delivered. Not retried automatically, to avoid sending it twice; check before resending.`;
}

/** The lastError recorded for a claim abandoned between claim and settle. */
export const STALE_CLAIM_ERROR = 'The send was interrupted before its outcome was recorded, so it may or may not have been delivered. Not retried automatically, to avoid sending it twice; check before resending.';

interface ApprovedOutboundActionExecutorDeps {
    backend:           Pick<ApprovedOutboundActionBackend, 'listOpen' | 'claim' | 'settleClaim'>
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
    /** Per-send timeout; defaults to {@link DEFAULT_SEND_TIMEOUT_MS}. */
    sendTimeoutMs?:    number
    /** Claim lease; defaults to {@link DEFAULT_CLAIM_LEASE_MS}. Must exceed the send timeout. */
    claimLeaseMs?:     number
    /** Clock for the claim lease, in epoch milliseconds; defaults to `Date.now`. */
    now?:              () => number
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
     * row is created or its service comes back online. Never starts a second concurrent run of
     * any one service's lane.
     */
    wake(): void
    /** Run every service's lane once and sum their results; rejects with the first lane's failure. */
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

/** Every service some action type needs, in first-seen order: one executor lane each. */
const LANE_SERVICES: readonly ServiceName[] = [...new Set(approvedOutboundActionTypeSchema.options.map(type => requiredServiceFor(type)))];

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

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

interface PendingSettle {
    claimed: ClaimedApprovedOutboundAction
    outcome: ClaimOutcome
}

/**
 * Build the executor: one lane per service (Bluesky, email), each its own
 * {@link createSingleFlightLoop} with its own poll timer and backoff, so a hung send in one
 * service never delays the other — including rows approved while the hang lasts. Within a lane,
 * rows go strictly one at a time in listed order.
 *
 * Each lane pass:
 * 1. retries any outcome write that failed on an earlier pass — the write, never the send;
 * 2. lists the open rows (one strongly consistent query) and settles its service's `sending`
 *    rows whose claim is older than the lease as `failed(permanent)`, outcome unknown;
 * 3. for each of its service's `approved` rows: claims it (`approved → sending`, conditional
 *    put with a fresh `claimId`), sends it with a per-send timeout, and settles the claim.
 *
 * The claim is the cross-process guard: of two processes that list the same row, only the one
 * whose claim lands sends it. Single-flight lanes are defence in depth within a process.
 * A send that times out is settled `failed(permanent)` with its outcome unknown, and its late
 * result is only logged.
 */
export function createApprovedOutboundActionExecutor(deps: ApprovedOutboundActionExecutorDeps): ApprovedOutboundActionExecutor {
    const {
        backend,
        registry,
        executors,
        logger,
        onOutcomeRecorded,
        sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
        claimLeaseMs = DEFAULT_CLAIM_LEASE_MS,
        now = Date.now,
    } = deps;

    if(claimLeaseMs <= sendTimeoutMs) {
        throw new InvariantViolationError('createApprovedOutboundActionExecutor', 'claim lease must exceed the send timeout');
    }

    /** Log how a timed-out send finally ended. Nothing is written: its row already says "unknown". */
    async function logLateOutcome(claimed: ClaimedApprovedOutboundAction, sending: Promise<void>): Promise<void> {
        let late: { lateOutcome: 'sent' } | { lateOutcome: 'failed', error: string };
        try {
            await sending;
            late = { lateOutcome: 'sent' };
        } catch (err: unknown) {
            late = { lateOutcome: 'failed', error: errorMessage(err) };
        }
        logger.warn(
            { actionId: claimed.id, type: claimed.type, ...late },
            'Approved outbound action send finished after its timeout; its row already records the outcome as unknown'
        );
    }

    /** Send a claimed row, bounded by the send timeout, and say what its claim should record. */
    async function send(claimed: ClaimedApprovedOutboundAction): Promise<ClaimOutcome> {
        // Starting the send on a microtask turns an executor's synchronous throw into a rejection.
        const sending = Promise.resolve().then(async () => executors[claimed.type](claimed.params));
        try {
            if(await raceSendTimeout(sending, sendTimeoutMs) === 'sent') {
                return { state: 'executed' };
            }
        } catch (err: unknown) {
            return { state: 'failed', lastError: errorMessage(err), failureKind: classifyFailure(err) };
        }
        void logLateOutcome(claimed, sending);
        return { state: 'failed', lastError: sendTimedOutError(sendTimeoutMs), failureKind: 'permanent' };
    }

    function createLaneRun(service: ServiceName): () => Promise<ExecuteOnceResult> {
        /** Outcomes whose write failed, keyed by action id, to retry before this lane's next pass. */
        const unsettled = new Map<string, PendingSettle>();

        async function record(claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome, result: ExecuteOnceResult): Promise<void> {
            let recorded: boolean;
            try {
                recorded = await backend.settleClaim(claimed, outcome);
            } catch (err: unknown) {
                unsettled.set(claimed.id, { claimed, outcome });
                logger.error(
                    { actionId: claimed.id, outcome, error: errorMessage(err) },
                    'Approved outbound action outcome write failed; will retry the write, never the send'
                );
                throw err;
            }
            unsettled.delete(claimed.id);
            if(!recorded) {
                logger.warn({ actionId: claimed.id, outcome }, 'Approved outbound action outcome not recorded: its claim was already resolved elsewhere');
                return;
            }
            if(outcome.state === 'executed') {
                result.executed++;
                logger.info({ actionId: claimed.id, type: claimed.type }, 'Approved outbound action executed successfully');
            } else {
                result.failed++;
                logger.error(
                    { actionId: claimed.id, type: claimed.type, error: outcome.lastError, failureKind: outcome.failureKind },
                    'Approved outbound action execution failed'
                );
            }
            onOutcomeRecorded();
        }

        return async () => {
            const result: ExecuteOnceResult = { executed: 0, failed: 0 };

            // A failed retry propagates and stops this pass before anything new is claimed.
            for(const { claimed, outcome } of unsettled.values()) {
                // eslint-disable-next-line no-await-in-loop -- outcome writes are retried one at a time; a failure stops the pass.
                await record(claimed, outcome, result);
            }

            const listing = await backend.listOpen();
            const open = listing.filter(action => requiredServiceFor(action.type) === service);

            for(const action of open) {
                if(isClaimed(action) && now() - Date.parse(action.updatedAt) >= claimLeaseMs) {
                    // eslint-disable-next-line no-await-in-loop -- abandoned claims are settled one at a time; a failure stops the pass.
                    await record(action, { state: 'failed', lastError: STALE_CLAIM_ERROR, failureKind: 'permanent' }, result);
                }
            }

            for(const action of open) {
                if(action.state !== 'approved') {
                    continue;
                }
                if(!registry.isAvailable(service)) {
                    logger.info({ actionId: action.id, type: action.type, service }, 'Skipping approved outbound action — required service unavailable');
                    continue;
                }
                // A claim failure other than losing the race propagates, and nothing is sent.
                // eslint-disable-next-line no-await-in-loop -- one row at a time per service: claim, send, settle.
                const claimed = await backend.claim(action);
                if(claimed === undefined) {
                    logger.info({ actionId: action.id, type: action.type }, 'Skipping approved outbound action — already claimed elsewhere');
                    continue;
                }
                // eslint-disable-next-line no-await-in-loop -- later sends in this service wait for this one's durable outcome.
                await record(claimed, await send(claimed), result);
            }

            return result;
        };
    }

    const lanes: SingleFlightLoop<ExecuteOnceResult>[] = LANE_SERVICES.map(service => createSingleFlightLoop({
        run:            createLaneRun(service),
        madeProgress:   result => result.executed > 0 || result.failed > 0,
        baseIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        maxIntervalMs:  MAX_POLL_INTERVAL_MS,
        logger,
        label:          `Approved outbound action ${service} lane`,
    }));

    return {
        start: () => {
            for(const lane of lanes) {
                lane.start();
            }
        },
        stop: () => {
            for(const lane of lanes) {
                lane.stop();
            }
        },
        wake: () => {
            for(const lane of lanes) {
                lane.wake();
            }
        },
        executeOnce: async () => {
            const passes = await Promise.allSettled(lanes.map(async lane => lane.runOnce()));
            const total: ExecuteOnceResult = { executed: 0, failed: 0 };
            for(const pass of passes) {
                if(pass.status === 'rejected') {
                    throw pass.reason;
                }
                total.executed += pass.value.executed;
                total.failed += pass.value.failed;
            }
            return total;
        },
    };
}
