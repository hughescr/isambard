import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { z } from 'zod';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError, InvariantViolationError, WildDuckAuthError, WildDuckError } from '@/errors';
import type { ClaimOutcome } from '@/services/approved-outbound-action/backend';
import {
    DEFAULT_CLAIM_LEASE_MS,
    DEFAULT_SEND_TIMEOUT_MS,
    STALE_CLAIM_ERROR,
    classifyFailure,
    createApprovedOutboundActionExecutor,
    requiredServiceFor,
    sendTimedOutError,
    type ApprovedOutboundActionExecutor,
    type ApprovedOutboundActionExecutorLogger
} from '@/services/approved-outbound-action/executor';
import type {
    ApprovedOutboundAction,
    ApprovedOutboundActionType,
    ClaimedApprovedOutboundAction,
    DeliveryCheck,
    DeliveryCheckInput,
    UnverifiedApprovedOutboundAction
} from '@/services/approved-outbound-action/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';

type ExecutorDeps = Parameters<typeof createApprovedOutboundActionExecutor>[0];
type ExecutorBackend = ExecutorDeps['backend'];
type CheckMock = ReturnType<typeof mock<(input: DeliveryCheckInput) => Promise<DeliveryCheck>>>;

const BSKY_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const BSKY_ID_2 = 'aaaaaaaa-1111-4222-8333-000000000002';
const EMAIL_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const STALE_ID = 'cccccccc-1111-4222-8333-444444444444';
const STALE_ID_2 = 'cccccccc-1111-4222-8333-000000000002';
const CLAIM_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CLAIM_ID = '99999999-2222-4333-8444-555555555555';
/** The fake clock's time in every test: when the default claim mock stamps its claims. */
const CLAIMED_AT = '2026-03-30T10:05:00.000Z';
const STALE_CLAIMED_AT = '2026-03-30T09:00:00.000Z';

/** A send that never settles: a hung Bluesky or WildDuck call. */
async function hang(): Promise<void> {
    return Promise.withResolvers<undefined>().promise;
}

/** Enough microtask turns for a lane pass to reach its trailing reschedule. */
async function flush(): Promise<void> {
    for(let turn = 0; turn < 50; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the pass's promise chain.
        await Promise.resolve();
    }
}

function makeAction(overrides: Partial<ApprovedOutboundAction> = {}): ApprovedOutboundAction {
    return {
        id:        BSKY_ID,
        state:     'approved',
        type:      'bsky_reply',
        params:    { text: 'hello' },
        createdAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T10:00:00.000Z',
        ...overrides,
    };
}

function claimedOf(action: ApprovedOutboundAction): ClaimedApprovedOutboundAction {
    return { ...action, state: 'sending', claimId: CLAIM_ID, updatedAt: CLAIMED_AT };
}

const BSKY = makeAction();
const BSKY_2 = makeAction({ id: BSKY_ID_2, params: { text: 'second' } });
const EMAIL = makeAction({ id: EMAIL_ID, type: 'email_send', params: { uid: 42 } });
const STALE: ClaimedApprovedOutboundAction = {
    ...makeAction({ id: STALE_ID, type: 'bsky_dm', params: { convoId: 'c1', text: 'hi' } }),
    state:     'sending',
    claimId:   OTHER_CLAIM_ID,
    updatedAt: STALE_CLAIMED_AT,
};
const STALE_OUTCOME: ClaimOutcome = { state: 'unverified', lastError: STALE_CLAIM_ERROR };
/** The fake clock's time, 5 minutes after CLAIMED_AT: an unverified row settled at CLAIMED_AT is due for its first check. */
const CHECK_DUE_AT = '2026-03-30T10:10:00.000Z';

function unverifiedOf(action: ApprovedOutboundAction, overrides: Partial<ApprovedOutboundAction> = {}): UnverifiedApprovedOutboundAction {
    return { ...action, lastError: 'fetch failed', ambiguousSends: 1, firstClaimedAt: CLAIMED_AT, updatedAt: CLAIMED_AT, ...overrides, state: 'unverified' };
}

function settledOf(claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome): ApprovedOutboundAction {
    const { claimId: _claimId, ...action } = claimed;
    return { ...action, ...outcome, outcomeReportPending: true, updatedAt: CLAIMED_AT };
}

describe('createApprovedOutboundActionExecutor', () => {
    let listed: ApprovedOutboundAction[];
    let listOpen: ReturnType<typeof mock<ExecutorBackend['listOpen']>>;
    let claim: ReturnType<typeof mock<ExecutorBackend['claim']>>;
    let settleClaim: ReturnType<typeof mock<ExecutorBackend['settleClaim']>>;
    let resolveUnverified: ReturnType<typeof mock<ExecutorBackend['resolveUnverified']>>;
    let listAll: ReturnType<typeof mock<ExecutorBackend['listAll']>>;
    let checks: Record<ApprovedOutboundActionType, CheckMock>;
    let backend: ExecutorBackend;
    let registry: ServiceHealthRegistry;
    let executors: Record<ApprovedOutboundActionType, ReturnType<typeof mock<(params: Record<string, unknown>, signal: AbortSignal) => Promise<void>>>>;
    let logger: ApprovedOutboundActionExecutorLogger;
    let activityLog: ReturnType<typeof mock<(entry: { type: string, summary: string }) => Promise<void>>>;
    let onOutcomeRecorded: ReturnType<typeof mock<() => void>>;

    function build(extra: Partial<ExecutorDeps> = {}): ApprovedOutboundActionExecutor {
        const verifiers = {
            bsky_reply: { check: checks.bsky_reply, contentKey: () => undefined },
            bsky_dm:    { check: checks.bsky_dm, contentKey: () => undefined },
            email_send: { check: checks.email_send, contentKey: () => undefined },
        };
        return createApprovedOutboundActionExecutor({ backend, registry, executors, verifiers, logger, activityLogger: { log: activityLog }, onOutcomeRecorded, ...extra });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date(CLAIMED_AT));
        onOutcomeRecorded = mock((): void => undefined);

        // A tiny store: a claim turns the listed row into `sending`, a settle removes it.
        listed = [];
        listOpen = mock(async (): Promise<ApprovedOutboundAction[]> => listed);
        claim = mock(async (action: ApprovedOutboundAction): Promise<ClaimedApprovedOutboundAction | undefined> => {
            const claimed = claimedOf(action);
            listed = listed.map(row => (row.id === action.id ? claimed : row));
            return claimed;
        });
        settleClaim = mock(async (claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome): Promise<ApprovedOutboundAction> => {
            const settled = settledOf(claimed, outcome);
            listed = listed.filter(row => row.id !== claimed.id);
            return settled;
        });
        // A resolution rewrites the unverified row in the listing: `executed` leaves it, `approved` requeues it.
        resolveUnverified = mock(async (action: UnverifiedApprovedOutboundAction, to: 'executed' | 'approved'): Promise<ApprovedOutboundAction | undefined> => {
            const resolved: ApprovedOutboundAction = { ...action, state: to, updatedAt: new Date().toISOString() };
            listed = listed.filter(row => row.id !== action.id);
            return resolved;
        });
        listAll = mock(async (): Promise<ApprovedOutboundAction[]> => listed);
        backend = { listOpen, claim, settleClaim, resolveUnverified, listAll };
        checks = {
            bsky_reply: mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
            bsky_dm:    mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
            email_send: mock(async (_input: DeliveryCheckInput): Promise<DeliveryCheck> => ({ verdict: 'delivered' })),
        };

        registry = {
            isAvailable: mock((_service: string): boolean => true),
        } as unknown as ServiceHealthRegistry;

        executors = {
            bsky_reply: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
            bsky_dm:    mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
            email_send: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
        };

        logger = {
            debug: mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
            info:  mock((): void => undefined),
        };
        activityLog = mock(async (_entry: { type: string, summary: string }): Promise<void> => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('executeOnce', () => {
        test('returns zero counts when nothing is open, after listing once per service lane', async () => {
            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(listOpen).toHaveBeenCalledTimes(2);
        });

        test('claims, sends and settles an approved row as executed, in that order', async () => {
            listed = [BSKY];

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });

            expect(claim.mock.calls).toEqual([[BSKY]]);
            expect(executors.bsky_reply.mock.calls[0]?.[0]).toEqual(BSKY.params);
            expect(executors.bsky_reply.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'executed' }]]);
            expect(claim.mock.invocationCallOrder[0]).toBeLessThan(executors.bsky_reply.mock.invocationCallOrder[0]);
            expect(executors.bsky_reply.mock.invocationCallOrder[0]).toBeLessThan(settleClaim.mock.invocationCallOrder[0]);
            expect(logger.info).toHaveBeenCalledWith({ actionId: BSKY_ID, type: 'bsky_reply' }, 'Approved outbound action executed successfully');
        });

        test.each([
            [BSKY, { type: 'bsky-post-sent', summary: 'Bluesky reply posted' }],
            [makeAction({ type: 'bsky_dm', params: { convoId: 'c1', text: 'hi' } }), { type: 'bsky-dm-sent', summary: 'Bluesky DM sent' }],
            [EMAIL, { type: 'email-sent', summary: 'Email sent' }],
        ] as const)('logs %s as sent only after its executed settle succeeds', async (action, expectedEntry) => {
            listed = [action];

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });

            expect(activityLog.mock.calls).toEqual([[expectedEntry]]);
            expect(settleClaim.mock.invocationCallOrder[0]).toBeLessThan(activityLog.mock.invocationCallOrder[0]);
        });

        test('settles a successful send without an activity logger', async () => {
            listed = [BSKY];

            expect(await build({ activityLogger: undefined }).executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });
            expect(settleClaim).toHaveBeenCalledWith(claimedOf(BSKY), { state: 'executed' });
            expect(activityLog).not.toHaveBeenCalled();
        });

        test('skips a row whose service is unavailable without claiming it', async () => {
            listed = [BSKY];
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation((): boolean => false);

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });

            expect(claim).not.toHaveBeenCalled();
            expect(executors.bsky_reply).not.toHaveBeenCalled();
            expect(activityLog).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', service: 'bsky' },
                'Skipping approved outbound action — required service unavailable'
            );
        });

        test('skips a row another process claimed first, without sending or settling it', async () => {
            listed = [BSKY];
            claim.mockImplementation(async () => undefined);

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });

            expect(executors.bsky_reply).not.toHaveBeenCalled();
            expect(settleClaim).not.toHaveBeenCalled();
            expect(activityLog).not.toHaveBeenCalled();
            expect(onOutcomeRecorded).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith({ actionId: BSKY_ID, type: 'bsky_reply' }, 'Skipping approved outbound action — already claimed elsewhere');
        });

        test('a claim write failure rejects the pass and sends nothing', async () => {
            listed = [BSKY];
            claim.mockImplementation(async () => {
                throw new Error('claim write failed');
            });

            await expect(build().executeOnce()).rejects.toThrow('claim write failed');
            expect(executors.bsky_reply).not.toHaveBeenCalled();
            expect(settleClaim).not.toHaveBeenCalled();
        });

        test('records a transient failure when the send is refused', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new BskyAuthError('session expired');
            });

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 1, unverified: 0 });

            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'failed', lastError: 'session expired', failureKind: 'transient' }]]);
            expect(activityLog).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', error: 'session expired', failureKind: 'transient' },
                'Approved outbound action execution failed'
            );
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
        });

        test('records an ambiguous send failure as unverified, to check before any resend', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new TypeError('fetch failed');
            });

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 1 });

            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: 'fetch failed' }]]);
            expect(activityLog).not.toHaveBeenCalled();
            expect(logger.error).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', error: 'fetch failed' },
                'Approved outbound action send outcome unknown; will check its destination before any resend'
            );
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(onOutcomeRecorded.mock.invocationCallOrder[0]).toBeGreaterThan(settleClaim.mock.invocationCallOrder[0]);
        });

        test('records a permanent failure when the send throws a validation error', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new BskyValidationError('Post exceeds 300 graphemes (301)');
            });

            await build().executeOnce();

            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'failed', lastError: 'Post exceeds 300 graphemes (301)', failureKind: 'permanent' }]]);
        });

        test('records String(err) for a non-Error rejection', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw 'string error';
            });

            await build().executeOnce();

            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: 'string error' }]]);
        });

        test('records an executor that throws synchronously as a settled outcome', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation((): Promise<void> => {
                throw new Error('sync boom');
            });

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 1 });
            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: 'sync boom' }]]);
        });

        test('sums outcomes across both service lanes', async () => {
            const dm = makeAction({ id: BSKY_ID_2, type: 'bsky_dm' });
            const dm2 = makeAction({ id: STALE_ID_2, type: 'bsky_dm' });
            listed = [BSKY, dm, dm2, EMAIL];
            executors.bsky_dm.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('DM outcome unknown');
            }).mockImplementationOnce(async (): Promise<void> => {
                throw new BskyValidationError('DM too long');
            });
            executors.email_send.mockImplementation(async (): Promise<void> => {
                throw new Error('email outcome unknown');
            });

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 1, unverified: 2 });
        });

        test('persists each outcome before starting the next send in the same service', async () => {
            listed = [BSKY, BSKY_2];
            const events: string[] = [];
            executors.bsky_reply.mockImplementation(async (params: Record<string, unknown>) => {
                events.push(`send:${String(params.text)}`);
            });
            settleClaim.mockImplementation(async (claimed: ClaimedApprovedOutboundAction) => {
                events.push(`settle:${claimed.id}`);
                return settledOf(claimed, { state: 'executed' });
            });

            expect(await build().executeOnce()).toEqual({ executed: 2, failed: 0, unverified: 0 });
            expect(events).toEqual(['send:hello', `settle:${BSKY_ID}`, 'send:second', `settle:${BSKY_ID_2}`]);
        });

        test('a failed outcome write stops its lane before the next row is claimed, and is logged', async () => {
            listed = [BSKY, BSKY_2];
            settleClaim.mockImplementation(async () => {
                throw new Error('state write failed');
            });

            await expect(build().executeOnce()).rejects.toThrow('state write failed');

            expect(claim.mock.calls).toEqual([[BSKY]]);
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
            expect(onOutcomeRecorded).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                { actionId: BSKY_ID, outcome: { state: 'executed' }, error: 'state write failed' },
                'Approved outbound action outcome write failed; will retry the write, never the send'
            );
        });

        test('a failed outcome write in the Bluesky lane still lets the email lane finish', async () => {
            listed = [BSKY, EMAIL];
            settleClaim.mockImplementation(async (claimed: ClaimedApprovedOutboundAction) => {
                if(claimed.id === BSKY_ID) {
                    throw new Error('bsky write failed');
                }
                return settledOf(claimed, { state: 'executed' });
            });

            await expect(build().executeOnce()).rejects.toThrow('bsky write failed');

            expect(executors.email_send.mock.calls[0]?.[0]).toEqual({ uid: 42 });
            expect(executors.email_send.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
            expect(settleClaim).toHaveBeenCalledWith(claimedOf(EMAIL), { state: 'executed' });
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
        });

        test('rejects with the first lane failure when both lanes fail', async () => {
            listed = [BSKY, EMAIL];
            settleClaim.mockImplementation(async (claimed: ClaimedApprovedOutboundAction) => {
                throw new Error(`write failed for ${claimed.type}`);
            });

            await expect(build().executeOnce()).rejects.toThrow('write failed for bsky_reply');
        });

        test('a settle that finds its claim already resolved is logged and not counted', async () => {
            listed = [BSKY];
            settleClaim.mockImplementation(async () => undefined);

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });

            expect(onOutcomeRecorded).not.toHaveBeenCalled();
            expect(activityLog).not.toHaveBeenCalled();
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, outcome: { state: 'executed' } },
                'Approved outbound action outcome not recorded: its claim was already resolved elsewhere'
            );
        });

        test('a listing failure rejects the pass', async () => {
            listOpen.mockImplementation(async () => {
                throw new Error('DynamoDB unavailable');
            });

            await expect(build().executeOnce()).rejects.toThrow('DynamoDB unavailable');
        });

        test('warns when a settled sent activity log fails without changing the successful outcome', async () => {
            listed = [BSKY];
            const failure = new Error('activity down');
            activityLog.mockImplementation(async () => {
                throw failure;
            });

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });
            await Promise.resolve();

            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', error: 'activity down' },
                'Approved outbound action sent activity log failed'
            );
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
        });

        test('signals a recorded outcome after the executed write', async () => {
            listed = [BSKY];

            await build().executeOnce();

            expect(onOutcomeRecorded.mock.calls).toEqual([[]]);
            expect(onOutcomeRecorded.mock.invocationCallOrder[0]).toBeGreaterThan(settleClaim.mock.invocationCallOrder[0]);
        });

        test('signals a recorded outcome after the failed write', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new Error('network failure');
            });

            await build().executeOnce();

            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(onOutcomeRecorded.mock.invocationCallOrder[0]).toBeGreaterThan(settleClaim.mock.invocationCallOrder[0]);
        });

        test('signals no outcome for a row skipped because its service is unavailable', async () => {
            listed = [BSKY];
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation((): boolean => false);

            await build().executeOnce();

            expect(onOutcomeRecorded).not.toHaveBeenCalled();
        });
    });

    describe('outcome write retry', () => {
        test('retries a failed outcome write before listing on the next pass, and never re-sends', async () => {
            listed = [BSKY];
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('state write failed');
            });
            const executor = build();
            await expect(executor.executeOnce()).rejects.toThrow('state write failed');
            expect(activityLog).not.toHaveBeenCalled();

            expect(await executor.executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });
            expect(activityLog.mock.calls).toEqual([[{ type: 'bsky-post-sent', summary: 'Bluesky reply posted' }]]);

            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
            expect(claim).toHaveBeenCalledTimes(1);
            expect(settleClaim.mock.calls).toEqual([
                [claimedOf(BSKY), { state: 'executed' }],
                [claimedOf(BSKY), { state: 'executed' }],
            ]);
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(settleClaim.mock.invocationCallOrder[1]).toBeLessThan(Math.min(listOpen.mock.invocationCallOrder[2], listOpen.mock.invocationCallOrder[3]));
        });

        test('keeps retrying the write while it keeps failing, and lists nothing in that lane meanwhile', async () => {
            listed = [BSKY];
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('first write failed');
            }).mockImplementationOnce(async () => {
                throw new Error('second write failed');
            });
            const executor = build();
            await expect(executor.executeOnce()).rejects.toThrow('first write failed');

            await expect(executor.executeOnce()).rejects.toThrow('second write failed');
            expect(listOpen).toHaveBeenCalledTimes(3);

            expect(await executor.executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
        });

        test('drops a retried write whose claim was resolved elsewhere, and does not retry it again', async () => {
            listed = [BSKY];
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('state write failed');
            }).mockImplementationOnce(async () => undefined);
            const executor = build();
            await expect(executor.executeOnce()).rejects.toThrow('state write failed');

            expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, outcome: { state: 'executed' } },
                'Approved outbound action outcome not recorded: its claim was already resolved elsewhere'
            );

            await executor.executeOnce();
            expect(settleClaim).toHaveBeenCalledTimes(2);
        });

        test('a retried failure outcome is counted as failed', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new BskyRateLimitError('slow down');
            });
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('state write failed');
            });
            const executor = build();
            await expect(executor.executeOnce()).rejects.toThrow('state write failed');

            expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 1, unverified: 0 });
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
        });

        test('a retried unverified outcome is counted as unverified', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(async (): Promise<void> => {
                throw new Error('socket hang up');
            });
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('state write failed');
            });
            const executor = build();
            await expect(executor.executeOnce()).rejects.toThrow('state write failed');

            expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 1 });
            expect(settleClaim.mock.calls[1]).toEqual([claimedOf(BSKY), { state: 'unverified', lastError: 'socket hang up' }]);
        });

        test('keeps a timed-out send continuation until its retry writes the exact unverified revision', async () => {
            listed = [BSKY];
            const send = Promise.withResolvers<undefined>();
            const retryUnverified = unverifiedOf(BSKY, { lastError: sendTimedOutError(1000), updatedAt: '2026-03-30T10:05:02.000Z' });
            executors.bsky_reply.mockImplementation(async () => send.promise);
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('state write failed');
            }).mockImplementationOnce(async () => retryUnverified);
            const executor = build({ sendTimeoutMs: 1000 });
            const firstPass = executor.executeOnce();
            await flush();
            jest.advanceTimersByTime(1000);
            await expect(firstPass).rejects.toThrow('state write failed');

            expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 1 });
            send.resolve(undefined);
            await flush();

            expect(resolveUnverified).toHaveBeenCalledWith(retryUnverified, 'executed');
            expect(activityLog).toHaveBeenCalledWith({ type: 'bsky-post-sent', summary: 'Bluesky reply posted' });
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(2);
        });
    });

    describe('abandoned claims', () => {
        const staleAge = (ms: number): (() => number) => () => Date.parse(STALE_CLAIMED_AT) + ms;

        test('settles a sending row whose claim is exactly the lease old as unverified, outcome unknown', async () => {
            listed = [STALE];

            expect(await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 1 });

            expect(settleClaim.mock.calls).toEqual([[STALE, STALE_OUTCOME]]);
            expect(claim).not.toHaveBeenCalled();
            expect(executors.bsky_dm).not.toHaveBeenCalled();
            expect(checks.bsky_dm).not.toHaveBeenCalled();
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: STALE_ID, type: 'bsky_dm', error: STALE_CLAIM_ERROR },
                'Approved outbound action send outcome unknown; will check its destination before any resend'
            );
        });

        test('leaves a sending row one millisecond short of the lease alone', async () => {
            listed = [STALE];

            expect(await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS - 1) }).executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(settleClaim).not.toHaveBeenCalled();
        });

        test('never sweeps a sending row that carries no claimId', async () => {
            const { claimId: _claimId, ...unclaimed } = STALE;
            listed = [unclaimed];

            await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce();
            expect(settleClaim).not.toHaveBeenCalled();
        });

        test('honours a custom claim lease', async () => {
            listed = [STALE];

            await build({ claimLeaseMs: 200_000, sendTimeoutMs: 1000, now: staleAge(200_000) }).executeOnce();
            expect(settleClaim.mock.calls).toEqual([[STALE, STALE_OUTCOME]]);
        });

        test('uses the system clock and the 15-minute lease by default: swept at exactly 900000 ms', async () => {
            listed = [STALE];
            jest.setSystemTime(new Date(Date.parse(STALE_CLAIMED_AT) + 900_000));

            await build().executeOnce();
            expect(settleClaim.mock.calls).toEqual([[STALE, STALE_OUTCOME]]);
        });

        test('uses the system clock and the 15-minute lease by default: not swept at 899999 ms', async () => {
            listed = [STALE];
            jest.setSystemTime(new Date(Date.parse(STALE_CLAIMED_AT) + 899_999));

            await build().executeOnce();
            expect(settleClaim).not.toHaveBeenCalled();
        });

        test('an abandoned email claim is swept once, by the email lane', async () => {
            const staleEmail: ClaimedApprovedOutboundAction = { ...STALE, type: 'email_send', params: { uid: 7 } };
            listed = [staleEmail];

            await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce();
            expect(settleClaim.mock.calls).toEqual([[staleEmail, STALE_OUTCOME]]);
        });

        test('sweeps abandoned claims before claiming new rows', async () => {
            listed = [BSKY, STALE];

            await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce();
            expect(settleClaim.mock.calls[0]).toEqual([STALE, STALE_OUTCOME]);
            expect(settleClaim.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
        });

        test('a stale-claim settle failure stops the sweep before the next stale claim', async () => {
            const stale2: ClaimedApprovedOutboundAction = { ...STALE, id: STALE_ID_2 };
            listed = [STALE, stale2];
            settleClaim.mockImplementationOnce(async () => {
                throw new Error('write failed');
            });

            await expect(build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce()).rejects.toThrow('write failed');

            expect(settleClaim).toHaveBeenCalledTimes(1);
        });

        test('a swept claim already resolved elsewhere is logged and not counted', async () => {
            listed = [STALE];
            settleClaim.mockImplementation(async () => undefined);

            expect(await build({ now: staleAge(DEFAULT_CLAIM_LEASE_MS) }).executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: STALE_ID, outcome: STALE_OUTCOME },
                'Approved outbound action outcome not recorded: its claim was already resolved elsewhere'
            );
        });
    });

    describe('send timeout', () => {
        test('the outcome-unknown messages are exact', () => {
            expect(sendTimedOutError(120_000)).toBe('No response within 120s, so it may or may not have been delivered.');
            expect(STALE_CLAIM_ERROR).toBe('The send was interrupted before its outcome was recorded, so it may or may not have been delivered.');
        });

        test('a send still pending at the default 120000 ms timeout is settled unverified, never before', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(hang);
            const pass = build().executeOnce();
            await flush();

            jest.advanceTimersByTime(119_999);
            await flush();
            expect(settleClaim).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            await flush();
            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: sendTimedOutError(120_000) }]]);
            expect(await pass).toEqual({ executed: 0, failed: 0, unverified: 1 });
            expect(DEFAULT_SEND_TIMEOUT_MS).toBe(120_000);
        });

        test('honours a custom send timeout', async () => {
            listed = [BSKY];
            executors.bsky_reply.mockImplementation(hang);
            const pass = build({ sendTimeoutMs: 5000 }).executeOnce();
            await flush();

            jest.advanceTimersByTime(5000);
            await flush();
            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: sendTimedOutError(5000) }]]);
            expect(await pass).toEqual({ executed: 0, failed: 0, unverified: 1 });
        });

        test('aborts a hung send at its deadline while settling its outcome as unknown', async () => {
            listed = [BSKY];
            const capturedSignal = Promise.withResolvers<AbortSignal>();
            executors.bsky_reply.mockImplementation(async (_params, signal) => {
                capturedSignal.resolve(signal);
                return Promise.withResolvers<void>().promise;
            });
            const pass = build({ sendTimeoutMs: 1000 }).executeOnce();
            await flush();

            const signal = await capturedSignal.promise;
            expect(signal.aborted).toBe(false);
            jest.advanceTimersByTime(1000);
            await flush();

            expect(signal.aborted).toBe(true);
            expect(settleClaim.mock.calls).toEqual([[claimedOf(BSKY), { state: 'unverified', lastError: sendTimedOutError(1000) }]]);
            expect(await pass).toEqual({ executed: 0, failed: 0, unverified: 1 });
        });

        test('a send that succeeds after its timeout conditionally resolves its settled unverified revision as sent', async () => {
            listed = [BSKY];
            const send = Promise.withResolvers<undefined>();
            const unverified = unverifiedOf(BSKY, { lastError: sendTimedOutError(1000), updatedAt: '2026-03-30T10:05:01.000Z' });
            settleClaim.mockImplementation(async () => unverified);
            executors.bsky_reply.mockImplementation(async () => send.promise);
            const pass = build({ sendTimeoutMs: 1000 }).executeOnce();
            await flush();
            jest.advanceTimersByTime(1000);
            await pass;

            send.resolve(undefined);
            await flush();

            expect(resolveUnverified).toHaveBeenCalledWith(unverified, 'executed');
            expect(activityLog).toHaveBeenCalledWith({ type: 'bsky-post-sent', summary: 'Bluesky reply posted' });
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(2);
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', lateOutcome: 'sent' },
                'Approved outbound action send finished after its timeout; its row already records the outcome as unknown'
            );
            expect(settleClaim).toHaveBeenCalledTimes(1);
            expect(claim).toHaveBeenCalledTimes(1);
        });

        test('a send that fails after its timeout is only logged', async () => {
            listed = [BSKY];
            const send = Promise.withResolvers<undefined>();
            executors.bsky_reply.mockImplementation(async () => send.promise);
            const pass = build({ sendTimeoutMs: 1000 }).executeOnce();
            await flush();
            jest.advanceTimersByTime(1000);
            await pass;

            send.reject(new Error('late failure'));
            await flush();

            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', lateOutcome: 'failed', error: 'late failure' },
                'Approved outbound action send finished after its timeout; its row already records the outcome as unknown'
            );
            expect(settleClaim).toHaveBeenCalledTimes(1);
            expect(resolveUnverified).not.toHaveBeenCalled();
            expect(activityLog).not.toHaveBeenCalled();
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
        });

        test('a hung send holds later rows of the same service until it times out', async () => {
            listed = [BSKY, BSKY_2];
            executors.bsky_reply.mockImplementationOnce(hang);
            const pass = build({ sendTimeoutMs: 1000 }).executeOnce();
            await flush();
            expect(claim.mock.calls).toEqual([[BSKY]]);

            jest.advanceTimersByTime(1000);
            await flush();
            expect(claim.mock.calls).toEqual([[BSKY], [BSKY_2]]);
            expect(executors.bsky_reply.mock.calls.at(-1)?.[0]).toEqual({ text: 'second' });
            expect(executors.bsky_reply.mock.calls.at(-1)?.[1]).toBeInstanceOf(AbortSignal);
            expect(await pass).toEqual({ executed: 1, failed: 0, unverified: 1 });
        });

        test('rejects a claim lease equal to the send timeout', () => {
            let thrown: unknown;
            try {
                build({ sendTimeoutMs: 1000, claimLeaseMs: 1000 });
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(InvariantViolationError);
            expect((thrown as InvariantViolationError).context).toEqual({
                location:  'createApprovedOutboundActionExecutor',
                invariant: 'claim lease must exceed the send timeout',
            });
        });

        test('accepts a claim lease one millisecond above the send timeout', () => {
            expect(() => build({ sendTimeoutMs: 1000, claimLeaseMs: 1001 })).not.toThrow();
        });

        test('rejects a send timeout at the default lease', () => {
            expect(() => build({ sendTimeoutMs: 900_000 })).toThrow(InvariantViolationError);
        });
    });

    describe('destination checks', () => {
        const UNVERIFIED_BSKY = unverifiedOf(BSKY);
        const UNVERIFIED_EMAIL = unverifiedOf(EMAIL);

        test('records a due unverified row found at its destination as sent, like a send', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });

            expect(checks.bsky_reply.mock.calls[0]?.[0].params).toEqual(BSKY.params);
            expect(checks.bsky_reply.mock.calls[0]?.[0].since).toEqual(new Date(CLAIMED_AT));
            expect(checks.bsky_reply.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
            expect(resolveUnverified.mock.calls).toEqual([[UNVERIFIED_BSKY, 'executed']]);
            expect(activityLog.mock.calls).toEqual([[{ type: 'bsky-post-sent', summary: 'Bluesky reply posted' }]]);
            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(logger.info).toHaveBeenCalledWith({ actionId: BSKY_ID, type: 'bsky_reply' }, 'Approved outbound action executed successfully');
            expect(claim).not.toHaveBeenCalled();
            expect(executors.bsky_reply).not.toHaveBeenCalled();
        });

        test('resends a row found definitely absent in the same pass', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));
            checks.bsky_reply.mockImplementation(async () => ({ verdict: 'not-delivered' }));

            expect(await build().executeOnce()).toEqual({ executed: 1, failed: 0, unverified: 0 });

            expect(resolveUnverified.mock.calls).toEqual([[UNVERIFIED_BSKY, 'approved']]);
            expect(claim.mock.calls).toEqual([[{ ...UNVERIFIED_BSKY, state: 'approved', updatedAt: CHECK_DUE_AT }]]);
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
            expect(resolveUnverified.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
        });

        test('leaves an undecided row unverified and sends nothing', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));
            checks.bsky_reply.mockImplementation(async () => ({ verdict: 'undetermined', reason: 'lookup failed' }));

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });

            expect(resolveUnverified).not.toHaveBeenCalled();
            expect(claim).not.toHaveBeenCalled();
            expect(onOutcomeRecorded).not.toHaveBeenCalled();
        });

        test('checks nothing while the service is unavailable', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation((): boolean => false);

            expect(await build().executeOnce()).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(checks.bsky_reply).not.toHaveBeenCalled();
            expect(resolveUnverified).not.toHaveBeenCalled();
        });

        test('asks whether the service is available once for its unverified rows', async () => {
            listed = [unverifiedOf(makeAction({ type: 'bsky_dm', params: { convoId: 'c1', text: 'hi' } }))];
            jest.setSystemTime(new Date(CHECK_DUE_AT));

            await build().executeOnce();

            expect((registry.isAvailable as ReturnType<typeof mock>).mock.calls).toEqual([['bsky']]);
            expect(checks.bsky_dm).toHaveBeenCalledTimes(1);
        });

        test('each lane checks only its own service\'s unverified rows', async () => {
            listed = [UNVERIFIED_BSKY, UNVERIFIED_EMAIL];
            jest.setSystemTime(new Date(CHECK_DUE_AT));

            expect(await build().executeOnce()).toEqual({ executed: 2, failed: 0, unverified: 0 });
            expect(checks.bsky_reply).toHaveBeenCalledTimes(1);
            expect(checks.email_send).toHaveBeenCalledTimes(1);
            expect(checks.email_send.mock.calls[0]?.[0].params).toEqual({ uid: 42 });
        });

        test('checks unverified rows before sending approved ones', async () => {
            listed = [BSKY_2, UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));

            await build().executeOnce();

            expect(checks.bsky_reply.mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]);
        });

        test('waits the default 5-minute delay before a first check', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(Date.parse(CHECK_DUE_AT) - 1));

            await build().executeOnce();
            expect(checks.bsky_reply).not.toHaveBeenCalled();
        });

        test('honours a custom first-check delay', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(Date.parse(CLAIMED_AT) + 1000));

            await build({ verifyDelayMs: 1000 }).executeOnce();
            expect(checks.bsky_reply).toHaveBeenCalledTimes(1);
        });

        test('schedules checks on the injected clock', async () => {
            listed = [UNVERIFIED_BSKY];

            await build({ now: () => Date.parse(CHECK_DUE_AT) }).executeOnce();
            expect(checks.bsky_reply).toHaveBeenCalledTimes(1);
        });

        test('bounds each check by the send timeout', async () => {
            listed = [UNVERIFIED_BSKY];
            jest.setSystemTime(new Date(CHECK_DUE_AT));
            checks.bsky_reply.mockImplementation(async () => Promise.withResolvers<DeliveryCheck>().promise);
            const pass = build({ sendTimeoutMs: 1000 }).executeOnce();
            await flush();

            jest.advanceTimersByTime(1000);
            expect(await pass).toEqual({ executed: 0, failed: 0, unverified: 0 });
            expect(logger.warn).toHaveBeenCalledWith(
                { actionId: BSKY_ID, type: 'bsky_reply', reason: 'no answer from the destination within 1s', undecidedChecks: 1 },
                'Approved outbound action delivery still unknown; will check its destination again'
            );
        });
    });

    describe('service lanes', () => {
        test('an email approved while two Bluesky sends hang is sent on its wake', async () => {
            listed = [BSKY, BSKY_2];
            executors.bsky_reply.mockImplementation(hang);
            const executor = build();
            executor.start();
            jest.advanceTimersByTime(30_000);
            await flush();
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);

            listed = [...listed, EMAIL];
            executor.wake();
            jest.advanceTimersByTime(0);
            await flush();

            expect(executors.email_send.mock.calls[0]?.[0]).toEqual({ uid: 42 });
            expect(executors.email_send.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
            expect(settleClaim.mock.calls).toEqual([[claimedOf(EMAIL), { state: 'executed' }]]);
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
            executor.stop();
        });

        test('a hung Bluesky send does not hold an email listed in the same poll', async () => {
            listed = [BSKY, EMAIL];
            executors.bsky_reply.mockImplementation(hang);
            const executor = build();
            executor.start();

            jest.advanceTimersByTime(30_000);
            await flush();

            expect(settleClaim.mock.calls).toEqual([[claimedOf(EMAIL), { state: 'executed' }]]);
            jest.advanceTimersByTime(DEFAULT_SEND_TIMEOUT_MS);
            await flush();
            expect(settleClaim).toHaveBeenLastCalledWith(claimedOf(BSKY), { state: 'unverified', lastError: sendTimedOutError(DEFAULT_SEND_TIMEOUT_MS) });
            executor.stop();
        });
    });

    describe('wake', () => {
        test('wake() before start() arms no timer and lists nothing', async () => {
            const executor = build({ pollIntervalMs: 30_000 });

            executor.wake();
            jest.advanceTimersByTime(30_000);
            await flush();

            expect(jest.getTimerCount()).toBe(0);
            expect(listOpen).not.toHaveBeenCalled();
        });

        test('wake() while idle runs both lanes on a zero-delay timer', async () => {
            const executor = build({ pollIntervalMs: 30_000 });
            executor.start();

            executor.wake();
            jest.advanceTimersByTime(0);
            await flush();

            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });

        test('an approved email is submitted exactly once when wake() lands mid-send, through the coalesced rerun', async () => {
            listed = [EMAIL];
            const send = Promise.withResolvers<undefined>();
            executors.email_send.mockImplementation(async () => send.promise);
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            executor.wake();
            jest.advanceTimersByTime(0);
            await flush();
            expect(executors.email_send).toHaveBeenCalledTimes(1);
            // The idle Bluesky lane ran on the wake; the email lane only asked for a rerun.
            expect(listOpen).toHaveBeenCalledTimes(3);

            send.resolve(undefined);
            await flush();
            expect(settleClaim.mock.calls).toEqual([[claimedOf(EMAIL), { state: 'executed' }]]);

            jest.advanceTimersByTime(0);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);
            expect(executors.email_send.mock.calls[0]?.[0]).toEqual({ uid: 42 });
            expect(executors.email_send.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
            executor.stop();
        });
    });

    describe('requiredServiceFor mapping', () => {
        test.each([
            ['bsky_reply', 'bsky'],
            ['bsky_dm',    'bsky'],
            ['email_send', 'email'],
        ] as const)('requiredServiceFor(%s) returns %s', (type, expectedService) => {
            expect(requiredServiceFor(type)).toBe(expectedService);
        });

        test.each([
            ['bsky_reply', 'bsky'],
            ['bsky_dm',    'bsky'],
            ['email_send', 'email'],
        ] as const)('executeOnce checks %s against service %s', async (actionType, expectedService) => {
            listed = [makeAction({ type: actionType })];

            await build().executeOnce();

            expect((registry.isAvailable as ReturnType<typeof mock>).mock.calls).toEqual([[expectedService]]);
        });
    });

    describe('start and stop', () => {
        test('start creates a timer that runs the lanes', async () => {
            listed = [BSKY];
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();

            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });

        test('double-start guard: second start does not create a second timer per lane', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();

            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });

        test('redundant start() while mid-flight tick does not kill the poll loop', async () => {
            const listing = Promise.withResolvers<ApprovedOutboundAction[]>();
            listOpen.mockImplementation(async () => listing.promise);
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            expect(listOpen).toHaveBeenCalledTimes(2);
            expect(jest.getTimerCount()).toBe(0);

            executor.start();
            listing.resolve([]);
            await flush();

            expect(jest.getTimerCount()).toBe(2);
            executor.stop();
        });

        test('redundant start() while running leaves exactly one pending timer per lane', () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            expect(jest.getTimerCount()).toBe(2);

            executor.start();
            expect(jest.getTimerCount()).toBe(2);
            executor.stop();
        });

        test('stop clears the timers so no lane runs', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            jest.advanceTimersByTime(5000);
            await flush();

            expect(listOpen).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });

        test('restart after stop works', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            executor.start();
            jest.advanceTimersByTime(1000);
            await flush();

            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });

        test('stop is idempotent when not started', () => {
            const executor = build();
            expect(() => {
                executor.stop();
            }).not.toThrow();
        });

        test('stop then start during a mid-flight tick leaves exactly one pending timer per lane', async () => {
            const listing = Promise.withResolvers<ApprovedOutboundAction[]>();
            listOpen.mockImplementation(async () => listing.promise);
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            expect(jest.getTimerCount()).toBe(0);

            executor.stop();
            executor.start();
            expect(jest.getTimerCount()).toBe(2);

            listing.resolve([]);
            await flush();

            expect(jest.getTimerCount()).toBe(2);
            executor.stop();
        });

        test('a timer firing during a run left over from stop/start defers to a rerun instead of overlapping', async () => {
            // A second concurrent listing in one lane would be an in-process double claim attempt;
            // the stale run's timer successor must only ask for a rerun.
            const first = Promise.withResolvers<ApprovedOutboundAction[]>();
            let callCount = 0;
            listOpen.mockImplementation(async () => {
                callCount++;
                return callCount <= 2 ? first.promise : [];
            });
            const executor = build({ pollIntervalMs: 1000 });

            try {
                executor.start();
                jest.advanceTimersByTime(1000);
                executor.stop();
                executor.start();
                expect(jest.getTimerCount()).toBe(2);
                jest.advanceTimersByTime(1000);
                expect(listOpen).toHaveBeenCalledTimes(2);
                expect(jest.getTimerCount()).toBe(0);
                executor.stop();
                executor.start();
                expect(jest.getTimerCount()).toBe(2);

                first.resolve([]);
                await flush();
                expect(listOpen).toHaveBeenCalledTimes(2);
                expect(jest.getTimerCount()).toBe(2);

                jest.advanceTimersByTime(0);
                await flush();
                expect(listOpen).toHaveBeenCalledTimes(4);
                expect(jest.getTimerCount()).toBe(2);
            } finally {
                first.resolve([]);
                await Promise.resolve();
                executor.stop();
            }
        });

        test('stop alone after a mid-flight tick leaves zero pending timers', async () => {
            const listing = Promise.withResolvers<ApprovedOutboundAction[]>();
            listOpen.mockImplementation(async () => listing.promise);
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            executor.stop();
            listing.resolve([]);
            await flush();

            expect(jest.getTimerCount()).toBe(0);
        });

        test('clearTimeout is called when stop() is called after start()', async () => {
            const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            expect(clearTimeoutSpy).toHaveBeenCalled();
            jest.advanceTimersByTime(3000);
            await flush();
            expect(listOpen).not.toHaveBeenCalled();
            clearTimeoutSpy.mockRestore();
        });

        test('start() after stop() resumes at base interval', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();
            jest.advanceTimersByTime(1000);
            await flush();
            jest.advanceTimersByTime(2000);
            await flush();
            executor.stop();

            executor.start();
            jest.advanceTimersByTime(999);
            await flush();
            const callsBefore = listOpen.mock.calls.length;

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen.mock.calls).toHaveLength(callsBefore + 2);
            executor.stop();
        });
    });

    describe('pollIntervalMs', () => {
        test('uses DEFAULT_POLL_INTERVAL_MS (30000) when not provided', async () => {
            const executor = build();
            executor.start();

            jest.advanceTimersByTime(29_999);
            await flush();
            expect(listOpen).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });

        test('uses custom pollIntervalMs when provided', async () => {
            const executor = build({ pollIntervalMs: 5000 });
            executor.start();

            jest.advanceTimersByTime(4999);
            await flush();
            expect(listOpen).not.toHaveBeenCalled();

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);
            executor.stop();
        });
    });

    describe('poll backoff', () => {
        test('an empty pass doubles each lane\'s next interval', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);
            executor.stop();
        });

        test('two consecutive empty passes produce an interval of 4x base on the third tick', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            jest.advanceTimersByTime(2000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(3999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);
            executor.stop();
        });

        test('the interval is capped at MAX_POLL_INTERVAL_MS (5 minutes), logged once per lane', async () => {
            const base = 200_000;
            const executor = build({ pollIntervalMs: base });
            executor.start();

            jest.advanceTimersByTime(base);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(299_999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(299_999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);
            expect((logger.debug as ReturnType<typeof mock>).mock.calls).toEqual([
                [{ intervalMs: 300_000 }, 'Approved outbound action bsky lane poll interval extended'],
                [{ intervalMs: 300_000 }, 'Approved outbound action email lane poll interval extended'],
            ]);
            executor.stop();
        });

        test('a pass that sent something resets its lane to the base interval', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();

            listed = [BSKY, EMAIL];
            jest.advanceTimersByTime(2000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);
            expect(logger.debug).toHaveBeenCalledWith({ intervalMs: 1000 }, 'Approved outbound action bsky lane poll interval reset to base');

            jest.advanceTimersByTime(999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);
            executor.stop();
        });

        test('a productive first tick does not emit a redundant base-reset log', async () => {
            listed = [BSKY, EMAIL];
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();

            expect(logger.debug).not.toHaveBeenCalled();
            executor.stop();
        });

        test('an empty pass after a productive one restarts backoff from base', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            listed = [BSKY, EMAIL];
            jest.advanceTimersByTime(2000);
            await flush();
            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(8);
            executor.stop();
        });

        test('stop() mid-backoff cancels the scheduled timers', async () => {
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            executor.stop();

            jest.advanceTimersByTime(3000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);
        });

        test.each([
            ['failures', new InvariantViolationError('executor', 'client not available')],
            ['unknown outcomes', new Error('socket hang up')],
        ])('a pass that recorded only %s also resets to base', async (_label, error) => {
            for(const type of ['bsky_reply', 'email_send'] as const) {
                executors[type].mockImplementation(async (): Promise<void> => {
                    throw error;
                });
            }
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            listed = [BSKY, EMAIL];
            jest.advanceTimersByTime(2000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(6);
            executor.stop();
        });

        test('a rejected pass does not stop rescheduling', async () => {
            let callCount = 0;
            listOpen.mockImplementation(async () => {
                callCount += 1;
                if(callCount <= 2) {
                    throw new Error('DynamoDB unavailable');
                }
                return [];
            });
            const executor = build({ pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);
            expect(logger.debug).toHaveBeenCalledWith(
                { error: 'DynamoDB unavailable' },
                'Approved outbound action bsky lane poll tick threw unexpectedly; rescheduling'
            );

            jest.advanceTimersByTime(999);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(1);
            await flush();
            expect(listOpen).toHaveBeenCalledTimes(4);
            executor.stop();
        });
    });
});

describe('classifyFailure', () => {
    const zodError = z.object({ uid: z.number() }).safeParse({ uid: 'x' }).error;

    const cases: [string, unknown, 'transient' | 'permanent' | 'ambiguous'][] = [
        ['a ZodError (unreadable params)', zodError, 'permanent'],
        ['a BskyValidationError', new BskyValidationError('too long'), 'permanent'],
        ['a BskyError with status 400', new BskyError('bad', undefined, { status: 400 }), 'permanent'],
        ['a BskyError with status 499', new BskyError('bad', undefined, { status: 499 }), 'permanent'],
        ['a BskyError with status 399', new BskyError('odd', undefined, { status: 399 }), 'ambiguous'],
        ['a BskyError with status 500', new BskyError('down', undefined, { status: 500 }), 'ambiguous'],
        ['a BskyError with status 599', new BskyError('down', undefined, { status: 599 }), 'ambiguous'],
        ['a BskyError with status 1 (network failure or abort, no response)', new BskyError('network', undefined, { status: 1 }), 'ambiguous'],
        ['a BskyError with status 2 (a response that failed validation)', new BskyError('invalid', undefined, { status: 2 }), 'ambiguous'],
        ['a BskyError with a non-numeric status', new BskyError('odd', undefined, { status: '404' }), 'ambiguous'],
        ['a status-less BskyError (a network error the client wrapped)', new BskyError('Failed to reply to post', undefined, { originalMessage: 'socket hang up' }), 'ambiguous'],
        ['a BskyError with no context', new BskyError('no context'), 'ambiguous'],
        ['a BskyAuthError even if it carries status 401', new BskyAuthError('auth', { status: 401 }), 'transient'],
        ['a BskyRateLimitError even if it carries status 429', new BskyRateLimitError('slow down', { status: 429 }), 'transient'],
        ['an InvariantViolationError (a missing client, before any request)', new InvariantViolationError('executor', 'client not available'), 'transient'],
        ['a WildDuckAuthError', new WildDuckAuthError('WildDuck authentication failed (401)'), 'transient'],
        ['a status-less WildDuckError (raised before any request)', new WildDuckError('WildDuck: unknown mailbox path: Drafts'), 'transient'],
        ['a WildDuckError with status 400', new WildDuckError('bad', undefined, { status: 400 }), 'transient'],
        ['a WildDuckError with status 403', new WildDuckError('forbidden', undefined, { status: 403 }), 'transient'],
        ['a WildDuckError with status 499', new WildDuckError('odd', undefined, { status: 499 }), 'transient'],
        ['a WildDuckError with status 404 (the draft may already be in Sent Mail)', new WildDuckError('gone', undefined, { status: 404 }), 'ambiguous'],
        ['a WildDuckError with status 500', new WildDuckError('down', undefined, { status: 500 }), 'ambiguous'],
        ['a WildDuckError with status 503', new WildDuckError('down', undefined, { status: 503 }), 'ambiguous'],
        ['a WildDuckError with a non-numeric status', new WildDuckError('odd', undefined, { status: '500' }), 'transient'],
        ['a WildDuck request timeout', new DOMException('The operation timed out.', 'TimeoutError'), 'ambiguous'],
        ['an aborted request', new DOMException('The operation was aborted.', 'AbortError'), 'ambiguous'],
        ['a fetch TypeError', new TypeError('fetch failed'), 'ambiguous'],
        ['a plain Error', new Error('network failure'), 'ambiguous'],
        ['a thrown string', 'string error', 'ambiguous'],
    ];
    for(const [name, err, expected] of cases) {
        test(`classifies ${name} as ${expected}`, () => {
            expect(classifyFailure(err)).toBe(expected);
        });
    }
});
