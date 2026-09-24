import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import type { ApprovedOutboundActionBackend } from '@/services/approved-outbound-action/backend';
import { createApprovedActionOutcomeReporter } from '@/services/approved-outbound-action/outcome-reporter';
import type { ApprovedOutboundAction } from '@/services/approved-outbound-action/types';
import type { ServiceLogger } from '@/services/types';

const FIRST = 'aaaaaaaa-1111-4222-8333-000000000001';
const SECOND = 'aaaaaaaa-1111-4222-8333-000000000002';

function pendingRow(id: string, overrides: Partial<ApprovedOutboundAction> = {}): ApprovedOutboundAction {
    return {
        id,
        state:                'executed',
        type:                 'email_send',
        params:               { uid: 42 },
        outcomeReportPending: true,
        createdAt:            '2026-09-24T11:00:00.000Z',
        updatedAt:            '2026-09-24T12:00:00.000Z',
        ...overrides,
    };
}

async function flush(): Promise<void> {
    for(let turn = 0; turn < 10; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the pass's promise chain.
        await Promise.resolve();
    }
}

type Backend = Pick<ApprovedOutboundActionBackend, 'listPendingOutcomeReports' | 'markOutcomeReported'>;

describe('createApprovedActionOutcomeReporter', () => {
    let listPendingOutcomeReports: ReturnType<typeof mock<() => Promise<ApprovedOutboundAction[]>>>;
    let markOutcomeReported: ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<boolean>>>;
    let backend: Backend;
    let deliver: ReturnType<typeof mock<(action: ApprovedOutboundAction) => Promise<boolean>>>;
    let logger: ServiceLogger;

    beforeEach(() => {
        jest.useFakeTimers();
        listPendingOutcomeReports = mock(async (): Promise<ApprovedOutboundAction[]> => []);
        markOutcomeReported = mock(async (): Promise<boolean> => true);
        backend = { listPendingOutcomeReports, markOutcomeReported };
        deliver = mock(async (): Promise<boolean> => true);
        logger = {
            debug: mock((): void => undefined),
            info:  mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('delivers each pending outcome in listed order and clears its marker only after delivery', async () => {
        const first = pendingRow(FIRST);
        const second = pendingRow(SECOND, { state: 'failed', lastError: 'boom', failureKind: 'transient' });
        listPendingOutcomeReports.mockImplementation(async () => [first, second]);
        const events: string[] = [];
        deliver.mockImplementation(async (action) => {
            events.push(`deliver:${action.id}`);
            return true;
        });
        markOutcomeReported.mockImplementation(async (action) => {
            events.push(`mark:${action.id}`);
            return true;
        });

        const result = await createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce();

        expect(result).toEqual({ delivered: 2, pending: 0 });
        expect(events).toEqual([`deliver:${FIRST}`, `mark:${FIRST}`, `deliver:${SECOND}`, `mark:${SECOND}`]);
        expect(markOutcomeReported.mock.calls).toEqual([[first], [second]]);
    });

    test('leaves an undelivered outcome pending without clearing its marker', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST)]);
        deliver.mockImplementation(async () => false);

        const result = await createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce();

        expect(result).toEqual({ delivered: 0, pending: 1 });
        expect(markOutcomeReported).not.toHaveBeenCalled();
    });

    test('a throwing delivery is logged, left pending, and does not stop later outcomes', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST), pendingRow(SECOND)]);
        deliver.mockImplementationOnce(async () => {
            throw new Error('describe failed');
        });

        const result = await createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce();

        expect(result).toEqual({ delivered: 1, pending: 1 });
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { actionId: FIRST, error: 'describe failed' },
            'Approved outbound action outcome report failed; will retry'
        );
        expect(markOutcomeReported.mock.calls).toEqual([[pendingRow(SECOND)]]);
    });

    test('a delivery throwing a non-Error value logs its string form', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST)]);
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises the non-Error branch of the log.
        deliver.mockImplementation(() => Promise.reject('plain failure'));

        await createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce();

        expect(logger.warn).toHaveBeenCalledWith(
            { actionId: FIRST, error: 'plain failure' },
            'Approved outbound action outcome report failed; will retry'
        );
    });

    test('counts an outcome whose row moved on before its marker was cleared as delivered', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST)]);
        markOutcomeReported.mockImplementation(async () => false);

        expect(await createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce()).toEqual({ delivered: 1, pending: 0 });
    });

    test('a failed marker clear rejects the pass', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST), pendingRow(SECOND)]);
        markOutcomeReported.mockImplementation(async () => {
            throw new Error('throughput exceeded');
        });

        await expect(createApprovedActionOutcomeReporter({ backend, deliver, logger }).reportOnce()).rejects.toThrow('throughput exceeded');
        expect(deliver).toHaveBeenCalledTimes(1);
    });

    test('after a restart the first poll reports an outcome recorded before it, from durable state alone', async () => {
        const recorded = pendingRow(FIRST, { approvalCard: { channelId: 'ch-1', messageId: 'msg-1' } });
        listPendingOutcomeReports.mockImplementation(async () => [recorded]);
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 1000 });

        reporter.start();
        jest.advanceTimersByTime(1000);
        await flush();

        expect(deliver.mock.calls).toEqual([[recorded]]);
        expect(markOutcomeReported.mock.calls).toEqual([[recorded]]);
        reporter.stop();
    });

    test('an undelivered outcome is retried on a later poll and cleared once delivery succeeds', async () => {
        const row = pendingRow(FIRST);
        let stillPending = true;
        listPendingOutcomeReports.mockImplementation(async () => (stillPending ? [row] : []));
        deliver.mockImplementationOnce(async () => false);
        markOutcomeReported.mockImplementation(async () => {
            stillPending = false;
            return true;
        });
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 1000 });

        reporter.start();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(markOutcomeReported).not.toHaveBeenCalled();

        // Nothing was delivered, so the next poll backs off to twice the base interval.
        jest.advanceTimersByTime(1500);
        await flush();
        expect(deliver).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(500);
        await flush();
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(markOutcomeReported.mock.calls).toEqual([[row]]);
        reporter.stop();
    });

    test('a slow failure card edit never ends up over a later success on the same card', async () => {
        // The failed(transient) outcome's card edit is slow (Discord retrying). Meanwhile the
        // row is reset on reconnect, re-sent, and recorded as executed — which wakes the
        // reporter mid-pass. The success must be the card's final state.
        const failed = pendingRow(FIRST, { state: 'failed', lastError: 'socket hang up', failureKind: 'transient', updatedAt: '2026-09-24T12:00:00.000Z' });
        const executed = pendingRow(FIRST, { state: 'executed', updatedAt: '2026-09-24T12:05:00.000Z' });
        let current: ApprovedOutboundAction[] = [failed];
        listPendingOutcomeReports.mockImplementation(async () => current);
        markOutcomeReported.mockImplementation(async action => action.updatedAt === current[0]?.updatedAt);
        const card: string[] = [];
        const slowEdit = Promise.withResolvers<undefined>();
        deliver.mockImplementation(async (action) => {
            if(action.state === 'failed') {
                await slowEdit.promise;
            }
            card.push(action.state);
            return true;
        });
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 1000 });
        reporter.start();

        reporter.wake();
        jest.advanceTimersByTime(0);
        await flush();
        expect(deliver).toHaveBeenCalledTimes(1);

        current = [executed];
        reporter.wake();
        jest.advanceTimersByTime(0);
        await flush();
        expect(deliver).toHaveBeenCalledTimes(1);

        slowEdit.resolve(undefined);
        await flush();
        jest.advanceTimersByTime(0);
        await flush();

        expect(card).toEqual(['failed', 'executed']);
        expect(markOutcomeReported.mock.calls).toEqual([[failed], [executed]]);
        reporter.stop();
    });

    test('a pass that delivers keeps polling at the base interval', async () => {
        listPendingOutcomeReports.mockImplementation(async () => [pendingRow(FIRST)]);
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 1000 });

        reporter.start();
        jest.advanceTimersByTime(1000);
        await flush();
        jest.advanceTimersByTime(1000);
        await flush();

        expect(listPendingOutcomeReports).toHaveBeenCalledTimes(2);
        reporter.stop();
    });

    test('wake() reports straight away on a zero-delay timer', async () => {
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 30_000 });
        reporter.start();

        reporter.wake();
        jest.advanceTimersByTime(0);
        await flush();

        expect(listPendingOutcomeReports).toHaveBeenCalledTimes(1);
        reporter.stop();
    });

    test('polls every 30 seconds by default', async () => {
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger });
        reporter.start();

        jest.advanceTimersByTime(29_000);
        await flush();
        expect(listPendingOutcomeReports).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1000);
        await flush();
        expect(listPendingOutcomeReports).toHaveBeenCalledTimes(1);
        reporter.stop();
    });

    test('logs its poll backoff under its own label', async () => {
        const reporter = createApprovedActionOutcomeReporter({ backend, deliver, logger, pollIntervalMs: 1000 });
        reporter.start();

        jest.advanceTimersByTime(1000);
        await flush();

        expect(logger.debug).toHaveBeenCalledWith({ intervalMs: 2000 }, 'Approved outbound action outcome report poll interval extended');
        reporter.stop();
    });
});
