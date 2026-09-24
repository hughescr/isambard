import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { ApprovedOutboundActionBackend } from '@/services/approved-outbound-action/backend';
import { createApprovedActionRetryListener, retryTransientFailures } from '@/services/approved-outbound-action/retry-on-reconnect';
import type { ApprovedOutboundAction, ApprovedOutboundActionType, FailureKind } from '@/services/approved-outbound-action/types';
import type { ServiceHealthChange, ServiceLogger, ServiceName } from '@/services/types';

const TIMESTAMP = '2026-09-12T00:00:00.000Z';

/** A failed row; `firstClaimedAt` null means a failure recorded before #108 classified ambiguous errors. */
function failedAction(id: string, type: ApprovedOutboundActionType, failureKind?: FailureKind, firstClaimedAt: string | null = TIMESTAMP): ApprovedOutboundAction {
    return {
        id,
        type,
        state:     'failed',
        params:    {},
        lastError: 'boom',
        ...(failureKind === undefined ? {} : { failureKind }),
        ...(firstClaimedAt === null ? {} : { firstClaimedAt }),
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
    };
}

function change(service: ServiceName, newState: ServiceHealthChange['newState'] = 'online'): ServiceHealthChange {
    return { service, previousState: 'offline', newState, epoch: 1, timestamp: new Date(TIMESTAMP) };
}

type Backend = Pick<ApprovedOutboundActionBackend, 'listByState' | 'updateState'>;

describe('retryTransientFailures', () => {
    let listByState: ReturnType<typeof mock<(state: string) => Promise<ApprovedOutboundAction[]>>>;
    let updateState: ReturnType<typeof mock<(id: string, to: string) => Promise<void>>>;
    let backend: Backend;
    let logger: ServiceLogger;

    beforeEach(() => {
        listByState = mock(async (_state: string): Promise<ApprovedOutboundAction[]> => []);
        updateState = mock(async (_id: string, _to: string): Promise<void> => undefined);
        backend = { listByState, updateState };
        logger = {
            debug: mock((): void => undefined),
            info:  mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
        };
    });

    test('lists failed actions and resets only the transient ones for the service, in listed order', async () => {
        listByState.mockImplementation(async () => [
            failedAction('00000000-0000-4000-8000-000000000001', 'email_send', 'transient'),
            failedAction('00000000-0000-4000-8000-000000000002', 'bsky_reply', 'transient'),
            failedAction('00000000-0000-4000-8000-000000000003', 'email_send', 'permanent'),
            failedAction('00000000-0000-4000-8000-000000000004', 'email_send'),
            failedAction('00000000-0000-4000-8000-000000000005', 'email_send', 'transient'),
        ]);

        await retryTransientFailures({ backend, logger }, 'email');

        expect(listByState.mock.calls).toEqual([['failed']]);
        expect(updateState.mock.calls).toEqual([
            ['00000000-0000-4000-8000-000000000001', 'approved'],
            ['00000000-0000-4000-8000-000000000005', 'approved'],
        ]);
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            { service: 'email', reset: 2, verifying: 0, skipped: 2 },
            'Reset transient approved outbound action failures on reconnect'
        );
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('sends a transient failure recorded before #108 to be checked at its destination, never straight back to approved', async () => {
        listByState.mockImplementation(async () => [
            failedAction('00000000-0000-4000-8000-000000000001', 'email_send', 'transient', null),
            failedAction('00000000-0000-4000-8000-000000000002', 'email_send', 'transient'),
            failedAction('00000000-0000-4000-8000-000000000003', 'email_send', 'permanent', null),
        ]);

        await retryTransientFailures({ backend, logger }, 'email');

        expect(updateState.mock.calls).toEqual([
            ['00000000-0000-4000-8000-000000000001', 'unverified'],
            ['00000000-0000-4000-8000-000000000002', 'approved'],
        ]);
        expect(logger.info).toHaveBeenCalledWith(
            { service: 'email', reset: 1, verifying: 1, skipped: 1 },
            'Reset transient approved outbound action failures on reconnect'
        );
    });

    test('never resets a permanent failure on reconnect', async () => {
        listByState.mockImplementation(async () => [failedAction('00000000-0000-4000-8000-000000000001', 'bsky_reply', 'permanent')]);

        await retryTransientFailures({ backend, logger }, 'bsky');

        expect(updateState).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            { service: 'bsky', reset: 0, verifying: 0, skipped: 1 },
            'Reset transient approved outbound action failures on reconnect'
        );
    });

    test('never resets an unclassified failure written before #40', async () => {
        listByState.mockImplementation(async () => [failedAction('00000000-0000-4000-8000-000000000001', 'bsky_dm')]);

        await retryTransientFailures({ backend, logger }, 'bsky');

        expect(updateState).not.toHaveBeenCalled();
    });

    test('logs nothing when no failed action belongs to the service', async () => {
        listByState.mockImplementation(async () => [failedAction('00000000-0000-4000-8000-000000000001', 'bsky_reply', 'transient')]);

        await retryTransientFailures({ backend, logger }, 'email');

        expect(updateState).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    test('writes one reset at a time and stops after the first write failure', async () => {
        const failed = [
            failedAction('00000000-0000-4000-8000-000000000001', 'email_send', 'transient'),
            failedAction('00000000-0000-4000-8000-000000000002', 'email_send', 'transient'),
            failedAction('00000000-0000-4000-8000-000000000003', 'email_send', 'transient'),
        ];
        listByState.mockImplementation(async () => failed);
        const firstEntered = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const order: string[] = [];
        updateState.mockImplementation(async (id: string) => {
            order.push(id);
            if(id === failed[0].id) {
                firstEntered.resolve();
                await releaseFirst.promise;
            } else if(id === failed[1].id) {
                throw new Error('second write failed');
            }
        });

        const pass = retryTransientFailures({ backend, logger }, 'email');
        await firstEntered.promise;
        expect(order).toEqual([failed[0].id]);
        releaseFirst.resolve();
        await pass;

        expect(order).toEqual([failed[0].id, failed[1].id]);
        expect(logger.info).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            { service: 'email', error: 'second write failed' },
            'Failed to reset approved outbound actions on reconnect'
        );
    });

    test('warns with String(err) when the listing rejects with a non-Error', async () => {
        listByState.mockImplementation(async () => {
            throw 'dynamo unavailable';
        });

        await retryTransientFailures({ backend, logger }, 'bsky');

        expect(updateState).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            { service: 'bsky', error: 'dynamo unavailable' },
            'Failed to reset approved outbound actions on reconnect'
        );
    });
});

describe('createApprovedActionRetryListener', () => {
    let listByState: ReturnType<typeof mock<(state: string) => Promise<ApprovedOutboundAction[]>>>;
    let updateState: ReturnType<typeof mock<(id: string, to: string) => Promise<void>>>;
    let backend: Backend;
    let logger: ServiceLogger;
    let wake: ReturnType<typeof mock<() => void>>;

    async function flush(): Promise<void> {
        for(let turn = 0; turn < 10; turn++) {
            // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the reset pass.
            await Promise.resolve();
        }
    }

    beforeEach(() => {
        listByState = mock(async (_state: string): Promise<ApprovedOutboundAction[]> => []);
        updateState = mock(async (_id: string, _to: string): Promise<void> => undefined);
        backend = { listByState, updateState };
        wake = mock((): void => undefined);
        logger = {
            debug: mock((): void => undefined),
            info:  mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
        };
    });

    test('an online event for bsky resets that service\'s transient failures', async () => {
        listByState.mockImplementation(async () => [failedAction('00000000-0000-4000-8000-000000000001', 'bsky_dm', 'transient')]);
        const written = Promise.withResolvers<void>();
        updateState.mockImplementation(async () => {
            written.resolve();
        });

        createApprovedActionRetryListener({ backend, logger, wake })(change('bsky'));
        await written.promise;

        expect(updateState.mock.calls).toEqual([['00000000-0000-4000-8000-000000000001', 'approved']]);
    });

    test('an online event for email lists failed actions', () => {
        createApprovedActionRetryListener({ backend, logger, wake })(change('email'));

        expect(listByState.mock.calls).toEqual([['failed']]);
    });

    test('ignores an event that is not online', async () => {
        createApprovedActionRetryListener({ backend, logger, wake })(change('bsky', 'offline'));
        await flush();

        expect(listByState).not.toHaveBeenCalled();
        expect(wake).not.toHaveBeenCalled();
    });

    test('ignores an online event for a service with no action types', async () => {
        const listener = createApprovedActionRetryListener({ backend, logger, wake });
        listener(change('discord'));
        listener(change('caldav'));
        listener(change('dynamodb'));
        await flush();

        expect(listByState).not.toHaveBeenCalled();
        expect(wake).not.toHaveBeenCalled();
    });

    test('wakes the executor after the reset pass completes', async () => {
        listByState.mockImplementation(async () => [failedAction('00000000-0000-4000-8000-000000000001', 'email_send', 'transient')]);
        const release = Promise.withResolvers<undefined>();
        updateState.mockImplementation(() => release.promise);

        createApprovedActionRetryListener({ backend, logger, wake })(change('email'));
        await flush();
        expect(updateState).toHaveBeenCalledTimes(1);
        expect(wake).not.toHaveBeenCalled();

        release.resolve(undefined);
        await flush();
        expect(wake).toHaveBeenCalledTimes(1);
    });

    test('wakes the executor on reconnect even with no failed actions', async () => {
        createApprovedActionRetryListener({ backend, logger, wake })(change('bsky'));
        await flush();

        expect(wake).toHaveBeenCalledTimes(1);
    });

    test('wakes the executor after a failed reset pass', async () => {
        listByState.mockImplementation(async () => {
            throw new Error('dynamo unavailable');
        });

        createApprovedActionRetryListener({ backend, logger, wake })(change('email'));
        await flush();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(wake).toHaveBeenCalledTimes(1);
    });
});
