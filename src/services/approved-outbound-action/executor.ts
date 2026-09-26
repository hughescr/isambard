import { ZodError } from 'zod';
import type { ServiceHealthRegistry } from '../health-registry';
import type { ServiceLogger, ServiceName } from '../types';
import type { ApprovedOutboundActionBackend, ClaimOutcome } from './backend';
import { DEFAULT_VERIFY_DELAY_MS, createDeliveryVerification } from './delivery-verification';
import { raceSendTimeout } from './send-timeout';
import { DEFAULT_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, createSingleFlightLoop, type SingleFlightLoop } from './single-flight-loop';
import {
    approvedOutboundActionTypeSchema,
    isClaimed,
    isUnverified,
    type ApprovedOutboundAction,
    type ApprovedOutboundActionType,
    type ClaimedApprovedOutboundAction,
    type DeliveryVerifier,
    type FailureKind,
    type UnverifiedApprovedOutboundAction
} from './types';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError, InvariantViolationError, WildDuckError } from '@/errors';
import type { ActivityLogEntry, ActivityLogger } from '@/storage';

/** Logger interface for the approved-outbound-action executor. Alias for {@link ServiceLogger}. */
export type ApprovedOutboundActionExecutorLogger = ServiceLogger;

type SentActivityType = 'email-sent' | 'bsky-post-sent' | 'bsky-dm-sent';

function sentActivityFor(type: ApprovedOutboundActionType): ActivityLogEntry<SentActivityType> {
    switch(type) {
        case 'email_send': {
            return { type: 'email-sent', summary: 'Email sent' };
        }
        case 'bsky_reply': {
            return { type: 'bsky-post-sent', summary: 'Bluesky reply posted' };
        }
        case 'bsky_dm': {
            return { type: 'bsky-dm-sent', summary: 'Bluesky DM sent' };
        }
    }
}

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
    return `No response within ${timeoutMs / 1000}s, so it may or may not have been delivered.`;
}

/** The lastError recorded for a claim abandoned between claim and settle. */
export const STALE_CLAIM_ERROR = 'The send was interrupted before its outcome was recorded, so it may or may not have been delivered.';

interface ApprovedOutboundActionExecutorDeps {
    backend:           Pick<ApprovedOutboundActionBackend, 'listOpen' | 'claim' | 'settleClaim' | 'resolveUnverified' | 'listAll'>
    registry:          ServiceHealthRegistry
    executors:         Record<ApprovedOutboundActionType, (params: Record<string, unknown>, signal: AbortSignal) => Promise<void>>
    /** How each action type's destination is checked when a send's outcome is unknown (#108). */
    verifiers:         Record<ApprovedOutboundActionType, DeliveryVerifier>
    logger:            ServiceLogger
    /** Best-effort event sink for sends that have already settled durably as executed. */
    activityLogger?:   ActivityLogger<SentActivityType>
    /**
     * Called after each durable outcome write (`executed`, `failed` or `unverified`), so the
     * outcome reporter can report it straight away. The write itself carries the report's outbox
     * marker (`outcomeReportPending`), so a lost signal only delays the report until its next poll.
     */
    onOutcomeRecorded: () => void
    pollIntervalMs?:   number
    /** Per-send timeout, which also bounds each destination check; defaults to {@link DEFAULT_SEND_TIMEOUT_MS}. */
    sendTimeoutMs?:    number
    /** Claim lease; defaults to {@link DEFAULT_CLAIM_LEASE_MS}. Must exceed the send timeout. */
    claimLeaseMs?:     number
    /** First destination-check delay; defaults to {@link DEFAULT_VERIFY_DELAY_MS}. */
    verifyDelayMs?:    number
    /** Clock for the claim lease and the check schedule, in epoch milliseconds; defaults to `Date.now`. */
    now?:              () => number
}

interface ExecuteOnceResult {
    executed:   number
    failed:     number
    /** Sends whose outcome is unknown, now waiting for a destination check. */
    unverified: number
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
 * How a send failed: `permanent` or `transient` (see {@link FailureKind}) when the error proves
 * the message was not delivered, or `ambiguous` when it may have been.
 */
export type SendFailureClass = FailureKind | 'ambiguous';

function numericStatus(err: BskyError | WildDuckError): number | undefined {
    const status = err.context?.status;
    return typeof status === 'number' ? status : undefined;
}

/**
 * Label a send failure (#108).
 *
 * `permanent` — retrying the same stored action cannot succeed: its params do not parse
 * (ZodError), Bluesky rejected the content (BskyValidationError), or Bluesky answered with any
 * other 4xx status.
 *
 * `transient` — the request was refused or never made, so it is retried when the service
 * reconnects: a missing client (InvariantViolationError), a Bluesky auth or rate-limit refusal,
 * a WildDuck 401, a WildDuck error with no HTTP status (raised before any request), or a WildDuck
 * 4xx other than 404.
 *
 * `ambiguous` — everything else, since it does not prove the message was not delivered: a
 * network failure, abort or unreadable response (Bluesky status 1 or 2, a status-less
 * BskyError, a fetch TypeError, a TimeoutError), any 5xx, a WildDuck 404 (the draft may already
 * have moved to Sent Mail), and anything unrecognised. The executor checks the destination
 * before deciding whether to resend.
 */
export function classifyFailure(err: unknown): SendFailureClass {
    if(err instanceof ZodError || err instanceof BskyValidationError) {
        return 'permanent';
    }
    if(err instanceof InvariantViolationError || err instanceof BskyAuthError || err instanceof BskyRateLimitError) {
        return 'transient';
    }
    if(err instanceof BskyError) {
        const status = numericStatus(err);
        return status !== undefined && status >= 400 && status <= 499 ? 'permanent' : 'ambiguous';
    }
    if(err instanceof WildDuckError) {
        // A WildDuckAuthError (a 401) carries no status either, so it is transient here.
        const status = numericStatus(err);
        return status === undefined || (status < 500 && status !== 404) ? 'transient' : 'ambiguous';
    }
    return 'ambiguous';
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

type LateSendOutcome = { lateOutcome: 'sent' } | { lateOutcome: 'failed', error: string };

interface PendingSettle {
    claimed:   ClaimedApprovedOutboundAction
    outcome:   ClaimOutcome
    /** Present only for this process's send that timed out, never for a stale-claim sweep. */
    lateSend?: Promise<LateSendOutcome>
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
 *    rows whose claim is older than the lease as `unverified`, outcome unknown;
 * 3. while the service is available, checks its due `unverified` rows at their destination
 *    (see {@link createDeliveryVerification}): found is recorded as sent, definitely absent is
 *    reset to `approved` and sent again in this same pass, undecided waits for a later pass;
 * 4. for each of its service's `approved` rows: claims it (`approved → sending`, conditional
 *    put with a fresh `claimId`), sends it with a per-send timeout, and settles the claim.
 *
 * The claim is the cross-process guard: of two processes that list the same row, only the one
 * whose claim lands sends it. Single-flight lanes are defence in depth within a process.
 * A send that times out, or fails in a way that does not prove it was refused (see
 * {@link classifyFailure}), is settled `unverified` and checked before any resend (#108); a
 * timed-out send that later succeeds conditionally resolves only that settled revision to
 * `executed`, while a late failure is logged and left for destination checking.
 */
export function createApprovedOutboundActionExecutor(deps: ApprovedOutboundActionExecutorDeps): ApprovedOutboundActionExecutor {
    const {
        backend,
        registry,
        executors,
        verifiers,
        logger,
        activityLogger,
        onOutcomeRecorded,
        sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
        claimLeaseMs = DEFAULT_CLAIM_LEASE_MS,
        verifyDelayMs = DEFAULT_VERIFY_DELAY_MS,
        now = Date.now,
    } = deps;

    if(claimLeaseMs <= sendTimeoutMs) {
        throw new InvariantViolationError('createApprovedOutboundActionExecutor', 'claim lease must exceed the send timeout');
    }

    /** Resolve a successful late send only if its own unverified revision is still current. */
    async function logLateOutcome(claimed: ClaimedApprovedOutboundAction, unverified: UnverifiedApprovedOutboundAction, lateSend: Promise<LateSendOutcome>): Promise<void> {
        const late = await lateSend;
        logger.warn(
            { actionId: claimed.id, type: claimed.type, ...late },
            'Approved outbound action send finished after its timeout; its row already records the outcome as unknown'
        );
        if(late.lateOutcome === 'failed') {
            return;
        }
        try {
            const resolved = await backend.resolveUnverified(unverified, 'executed');
            if(resolved === undefined) {
                logger.warn({ actionId: claimed.id, outcome: { state: 'executed' } }, 'Approved outbound action late success not recorded: its unverified row was already resolved elsewhere');
                return;
            }
            recordedSent(resolved);
        } catch (err: unknown) {
            logger.error(
                { actionId: claimed.id, error: errorMessage(err) },
                'Approved outbound action late success could not resolve its unverified row; destination checking will decide it'
            );
        }
    }

    /** Send a claimed row, bounded by the send timeout, and say what its claim should record. */
    async function send(claimed: ClaimedApprovedOutboundAction): Promise<Omit<PendingSettle, 'claimed'>> {
        const controller = new AbortController();
        // Starting the send on a microtask turns an executor's synchronous throw into a rejection.
        const sending = Promise.resolve().then(async () => executors[claimed.type](claimed.params, controller.signal));
        // Attach the rejection handler immediately: settling the timeout outcome may take a database round trip.
        const lateSend: Promise<LateSendOutcome> = sending
            .then((): LateSendOutcome => ({ lateOutcome: 'sent' }))
            .catch((err: unknown): LateSendOutcome => ({ lateOutcome: 'failed', error: errorMessage(err) }));
        try {
            if(await raceSendTimeout(sending, sendTimeoutMs, () => controller.abort()) === 'sent') {
                return { outcome: { state: 'executed' } };
            }
        } catch (err: unknown) {
            const failureClass = classifyFailure(err);
            return {
                outcome: failureClass === 'ambiguous'
                    ? { state: 'unverified', lastError: errorMessage(err) }
                    : { state: 'failed', lastError: errorMessage(err), failureKind: failureClass }
            };
        }
        return { outcome: { state: 'unverified', lastError: sendTimedOutError(sendTimeoutMs) }, lateSend };
    }

    /** Log and report an action now durably recorded as sent. */
    function recordedSent(action: ApprovedOutboundAction): void {
        logger.info({ actionId: action.id, type: action.type }, 'Approved outbound action executed successfully');
        void activityLogger?.log(sentActivityFor(action.type)).catch((err: unknown) => {
            logger.warn({ actionId: action.id, type: action.type, error: errorMessage(err) }, 'Approved outbound action sent activity log failed');
        });
        onOutcomeRecorded();
    }

    function createLaneRun(service: ServiceName): () => Promise<ExecuteOnceResult> {
        /** Outcomes whose write failed, keyed by action id, to retry before this lane's next pass. */
        const unsettled = new Map<string, PendingSettle>();
        const verification = createDeliveryVerification({ backend, verifiers, logger, timeoutMs: sendTimeoutMs, delayMs: verifyDelayMs, now });

        async function record(pending: PendingSettle, result: ExecuteOnceResult): Promise<void> {
            const { claimed, outcome } = pending;
            let recorded: ApprovedOutboundAction | undefined;
            try {
                recorded = await backend.settleClaim(claimed, outcome);
            } catch (err: unknown) {
                unsettled.set(claimed.id, pending);
                logger.error(
                    { actionId: claimed.id, outcome, error: errorMessage(err) },
                    'Approved outbound action outcome write failed; will retry the write, never the send'
                );
                throw err;
            }
            unsettled.delete(claimed.id);
            if(recorded === undefined) {
                logger.warn({ actionId: claimed.id, outcome }, 'Approved outbound action outcome not recorded: its claim was already resolved elsewhere');
                return;
            }
            if(outcome.state === 'executed') {
                result.executed++;
                recordedSent(recorded);
                return;
            }
            if(outcome.state === 'unverified') {
                result.unverified++;
                logger.warn(
                    { actionId: claimed.id, type: claimed.type, error: outcome.lastError },
                    'Approved outbound action send outcome unknown; will check its destination before any resend'
                );
                if(pending.lateSend !== undefined && isUnverified(recorded)) {
                    void logLateOutcome(claimed, recorded, pending.lateSend);
                }
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
            const result: ExecuteOnceResult = { executed: 0, failed: 0, unverified: 0 };

            // A failed retry propagates and stops this pass before anything new is claimed.
            for(const pending of unsettled.values()) {
                // eslint-disable-next-line no-await-in-loop -- outcome writes are retried one at a time; a failure stops the pass.
                await record(pending, result);
            }

            const listing = await backend.listOpen();
            const open = listing.filter(action => requiredServiceFor(action.type) === service);

            for(const action of open) {
                if(isClaimed(action) && now() - Date.parse(action.updatedAt) >= claimLeaseMs) {
                    // eslint-disable-next-line no-await-in-loop -- abandoned claims are settled one at a time; a failure stops the pass.
                    await record({ claimed: action, outcome: { state: 'unverified', lastError: STALE_CLAIM_ERROR } }, result);
                }
            }

            // Checks read the destination, so they wait for the service like sends do. A row
            // swept above is checked on a later pass, once its revision's delay has passed.
            const unverified = open.filter(isUnverified);
            const checked = await verification.verify(unverified.length > 0 && registry.isAvailable(service) ? unverified : []);
            for(const action of checked.delivered) {
                result.executed++;
                recordedSent(action);
            }

            for(const action of [...open, ...checked.requeued]) {
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
                await record({ claimed, ...await send(claimed) }, result);
            }

            return result;
        };
    }

    const lanes: SingleFlightLoop<ExecuteOnceResult>[] = LANE_SERVICES.map(service => createSingleFlightLoop({
        run:            createLaneRun(service),
        madeProgress:   result => result.executed > 0 || result.failed > 0 || result.unverified > 0,
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
            const total: ExecuteOnceResult = { executed: 0, failed: 0, unverified: 0 };
            for(const pass of passes) {
                if(pass.status === 'rejected') {
                    throw pass.reason;
                }
                total.executed += pass.value.executed;
                total.failed += pass.value.failed;
                total.unverified += pass.value.unverified;
            }
            return total;
        },
    };
}
