import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import type { ClaimOutcome } from '@/services/approved-outbound-action/backend';
import {
    DEFAULT_CLAIM_LEASE_MS,
    STALE_CLAIM_ERROR,
    createApprovedOutboundActionExecutor,
    type ApprovedOutboundActionExecutor,
    type ApprovedOutboundActionExecutorLogger
} from '@/services/approved-outbound-action/executor';
import type { ApprovedOutboundAction, ApprovedOutboundActionType, ClaimedApprovedOutboundAction } from '@/services/approved-outbound-action/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';

/**
 * Two executors sharing one store stand in for two bot processes sharing the DynamoDB table.
 * The store applies each claim and settle atomically under the same conditions the real
 * backend's conditional puts use: a claim needs the row still `approved` at the listed
 * revision, a settle needs the row still `sending` under the settling claim's `claimId`.
 */

type ExecutorDeps = Parameters<typeof createApprovedOutboundActionExecutor>[0];

const ACTION_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
/** Every write in these tests is stamped with this one instant, as a frozen or skewed clock would. */
const FROZEN_AT = '2026-03-30T10:00:00.000Z';

const ROW: ApprovedOutboundAction = {
    id:        ACTION_ID,
    state:     'approved',
    type:      'bsky_reply',
    params:    { text: 'hello' },
    createdAt: FROZEN_AT,
    updatedAt: FROZEN_AT,
};

async function flush(): Promise<void> {
    for(let turn = 0; turn < 50; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the passes' promise chains.
        await Promise.resolve();
    }
}

interface SettleFault {
    error:   Error
    /** The write lands although the caller sees the error (a lost response). */
    applied: boolean
}

function createFakeStore(initial: ApprovedOutboundAction) {
    const rows = new Map<string, ApprovedOutboundAction>([[initial.id, initial]]);
    let listingGate: Promise<void> | undefined;
    const settleFaults: SettleFault[] = [];

    function current(): ApprovedOutboundAction {
        const row = rows.get(ACTION_ID);
        if(row === undefined) {
            throw new Error('row missing');
        }
        return row;
    }

    const backend: ExecutorDeps['backend'] = {
        listOpen: mock(async () => {
            const snapshot = [...rows.values()].filter(row => row.state === 'approved' || row.state === 'sending');
            await listingGate;
            return snapshot;
        }),
        claim: mock(async (action: ApprovedOutboundAction) => {
            const row = rows.get(action.id);
            if(row?.state !== 'approved' || row.updatedAt !== action.updatedAt) {
                return undefined;
            }
            const claimed: ClaimedApprovedOutboundAction = { ...row, state: 'sending', claimId: crypto.randomUUID(), updatedAt: FROZEN_AT };
            rows.set(action.id, claimed);
            return claimed;
        }),
        settleClaim: mock(async (claimed: ClaimedApprovedOutboundAction, outcome: ClaimOutcome) => {
            const fault = settleFaults.shift();
            const row = rows.get(claimed.id);
            const holdsClaim = row?.state === 'sending' && row.claimId === claimed.claimId;
            if(holdsClaim && fault?.applied !== false) {
                const { claimId: _claimId, ...rest } = claimed;
                const { state, ...failure } = outcome;
                rows.set(claimed.id, { ...rest, ...failure, state, outcomeReportPending: true, updatedAt: FROZEN_AT });
            }
            if(fault !== undefined) {
                throw fault.error;
            }
            return holdsClaim;
        }),
    };

    return {
        backend,
        current,
        gateListings(gate: Promise<void>): void {
            listingGate = gate;
        },
        failNextSettle(fault: SettleFault): void {
            settleFaults.push(fault);
        },
        /** What retry-on-reconnect does to a transient failure: back to approved, same frozen clock. */
        resetToApproved(): void {
            const { failureKind: _failureKind, outcomeReportPending: _pending, ...rest } = current();
            rows.set(ACTION_ID, { ...rest, state: 'approved', updatedAt: FROZEN_AT });
        },
    };
}

describe('approved outbound action executor across processes', () => {
    let registry: ServiceHealthRegistry;

    function makeLogger(): ApprovedOutboundActionExecutorLogger {
        return {
            debug: mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
            info:  mock((): void => undefined),
        };
    }

    function makeExecutors(): Record<ApprovedOutboundActionType, ReturnType<typeof mock<(params: Record<string, unknown>) => Promise<void>>>> {
        return {
            bsky_reply: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
            bsky_dm:    mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
            email_send: mock(async (_params: Record<string, unknown>): Promise<void> => undefined),
        };
    }

    function botProcess(store: ReturnType<typeof createFakeStore>, extra: Partial<ExecutorDeps> = {}): ApprovedOutboundActionExecutor {
        return createApprovedOutboundActionExecutor({
            backend:           store.backend,
            registry,
            executors:         makeExecutors(),
            logger:            makeLogger(),
            onOutcomeRecorded: mock((): void => undefined),
            now:               () => Date.parse(FROZEN_AT),
            ...extra,
        });
    }

    beforeEach(() => {
        jest.useFakeTimers();
        registry = { isAvailable: mock((): boolean => true) } as unknown as ServiceHealthRegistry;
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('two processes that both list the same approved row send it exactly once', async () => {
        const store = createFakeStore(ROW);
        const gate = Promise.withResolvers<undefined>();
        store.gateListings(gate.promise);
        const executors = makeExecutors();
        const loggers = [makeLogger(), makeLogger()];
        const [first, second] = loggers.map(logger => botProcess(store, { executors, logger }));

        const passes = Promise.all([first.executeOnce(), second.executeOnce()]);
        await flush();
        // Both processes (two lanes each) listed before either claimed: both saw the row approved.
        expect(store.backend.listOpen).toHaveBeenCalledTimes(4);
        gate.resolve(undefined);
        const results = await passes;

        expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
        expect(store.current().state).toBe('executed');
        expect(results.map(result => result.executed).toSorted((a, b) => a - b)).toEqual([0, 1]);
        const loser = loggers[results.findIndex(result => result.executed === 0)];
        expect(loser.info).toHaveBeenCalledWith({ actionId: ACTION_ID, type: 'bsky_reply' }, 'Skipping approved outbound action — already claimed elsewhere');
    });

    test('a failed outcome write after a successful send is retried as a write, and the send is not repeated', async () => {
        const store = createFakeStore(ROW);
        store.failNextSettle({ error: new Error('throughput exceeded'), applied: false });
        const executors = makeExecutors();
        const onOutcomeRecorded = mock((): void => undefined);
        const executor = botProcess(store, { executors, onOutcomeRecorded });

        await expect(executor.executeOnce()).rejects.toThrow('throughput exceeded');
        expect(store.current().state).toBe('sending');

        expect(await executor.executeOnce()).toEqual({ executed: 1, failed: 0 });
        expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
        expect(store.current().state).toBe('executed');
        expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
    });

    test('after a restart, a row whose outcome write failed is not re-sent, and is reported unknown once its lease expires', async () => {
        const store = createFakeStore(ROW);
        store.failNextSettle({ error: new Error('throughput exceeded'), applied: false });
        const executors = makeExecutors();
        await expect(botProcess(store, { executors }).executeOnce()).rejects.toThrow('throughput exceeded');

        let now = Date.parse(FROZEN_AT);
        const restarted = botProcess(store, { executors, now: () => now });
        expect(await restarted.executeOnce()).toEqual({ executed: 0, failed: 0 });
        expect(store.current().state).toBe('sending');

        now += DEFAULT_CLAIM_LEASE_MS;
        expect(await restarted.executeOnce()).toEqual({ executed: 0, failed: 1 });
        expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
        expect(store.current()).toMatchObject({ state: 'failed', lastError: STALE_CLAIM_ERROR, failureKind: 'permanent', outcomeReportPending: true });
    });

    test('an outcome write that landed though its response was lost is not counted twice or re-sent', async () => {
        const store = createFakeStore(ROW);
        store.failNextSettle({ error: new Error('socket hang up'), applied: true });
        const executors = makeExecutors();
        const executor = botProcess(store, { executors });

        await expect(executor.executeOnce()).rejects.toThrow('socket hang up');
        expect(store.current().state).toBe('executed');

        expect(await executor.executeOnce()).toEqual({ executed: 0, failed: 0 });
        expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
    });

    test('a late settle of an old claim cannot overwrite a newer claim stamped with the same instant', async () => {
        const store = createFakeStore(ROW);
        // Process A's send fails transiently; its settle lands but A never hears back.
        const executorsA = makeExecutors();
        executorsA.bsky_reply.mockImplementation(async (): Promise<void> => {
            throw new Error('socket hang up');
        });
        const loggerA = makeLogger();
        const processA = botProcess(store, { executors: executorsA, logger: loggerA });
        store.failNextSettle({ error: new Error('response lost'), applied: true });
        await expect(processA.executeOnce()).rejects.toThrow('response lost');
        expect(store.current()).toMatchObject({ state: 'failed', failureKind: 'transient', updatedAt: FROZEN_AT });

        // The service reconnects, the row is reset, and process B claims it at the same instant.
        store.resetToApproved();
        const executorsB = makeExecutors();
        const sendB = Promise.withResolvers<undefined>();
        executorsB.bsky_reply.mockImplementation(async () => sendB.promise);
        const passB = botProcess(store, { executors: executorsB }).executeOnce();
        await flush();
        const claimB = store.current();
        expect(claimB).toMatchObject({ state: 'sending', updatedAt: FROZEN_AT });

        // A retries its old settle while B's send is in flight: it must not touch B's claim.
        expect(await processA.executeOnce()).toEqual({ executed: 0, failed: 0 });
        expect(store.current()).toEqual(claimB);
        expect(loggerA.warn).toHaveBeenCalledWith(
            { actionId: ACTION_ID, outcome: { state: 'failed', lastError: 'socket hang up', failureKind: 'transient' } },
            'Approved outbound action outcome not recorded: its claim was already resolved elsewhere'
        );

        sendB.resolve(undefined);
        expect(await passB).toEqual({ executed: 1, failed: 0 });
        expect(store.current().state).toBe('executed');
        expect(executorsA.bsky_reply).toHaveBeenCalledTimes(1);
        expect(executorsB.bsky_reply).toHaveBeenCalledTimes(1);
    });
});
