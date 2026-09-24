import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { z } from 'zod';
import { BskyAuthError, BskyError, BskyRateLimitError, BskyValidationError, WildDuckError } from '@/errors';
import type { ApprovedOutboundActionBackend } from '@/services/approved-outbound-action/backend';
import {
    classifyFailure,
    createApprovedOutboundActionExecutor,
    requiredServiceFor,
    type ApprovedOutboundActionExecutorLogger
} from '@/services/approved-outbound-action/executor';
import type { ApprovedOutboundAction, ApprovedOutboundActionType } from '@/services/approved-outbound-action/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

/** Enough microtask turns for a settled run to reach the loop's trailing reschedule. */
async function flush(): Promise<void> {
    for(let turn = 0; turn < 10; turn++) {
        // eslint-disable-next-line no-await-in-loop -- each turn drains one microtask hop of the run's promise chain.
        await Promise.resolve();
    }
}

function makeSaga(overrides: Partial<ApprovedOutboundAction> = {}): ApprovedOutboundAction {
    return {
        id:        SAGA_UUID,
        state:     'approved',
        type:      'bsky_reply',
        params:    { text: 'hello' },
        createdAt: '2026-03-30T10:00:00.000Z',
        updatedAt: '2026-03-30T10:00:00.000Z',
        ...overrides,
    };
}

describe('createApprovedOutboundActionExecutor', () => {
    let backend: ApprovedOutboundActionBackend;
    let registry: ServiceHealthRegistry;
    let executors: Record<ApprovedOutboundActionType, (params: Record<string, unknown>) => Promise<void>>;
    let logger: ApprovedOutboundActionExecutorLogger;
    let onOutcomeRecorded: ReturnType<typeof mock<() => void>>;

    beforeEach(() => {
        jest.useFakeTimers();
        onOutcomeRecorded = mock((): void => undefined);

        backend = {
            listByState: mock(async (): Promise<ApprovedOutboundAction[]> => []),
            updateState: mock(async (): Promise<void> => undefined),
            create:      mock(async (): Promise<void> => undefined),
            get:         mock(async (): Promise<ApprovedOutboundAction | undefined> => undefined),
        } as unknown as ApprovedOutboundActionBackend;

        registry = {
            isAvailable: mock((_service: string): boolean => true),
        } as unknown as ServiceHealthRegistry;

        executors = {

            bsky_reply: mock(async (): Promise<void> => undefined),

            bsky_dm: mock(async (): Promise<void> => undefined),

            email_send: mock(async (): Promise<void> => undefined),
        };

        logger = {
            debug: mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
            info:  mock((): void => undefined),
        };
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    describe('executeOnce', () => {
        test('returns {executed: 0, failed: 0} when no approved sagas', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => []
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 0 });
        });

        test('executes saga and marks it as executed when service is available', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 1, failed: 0 });
            expect(executors.bsky_reply).toHaveBeenCalledWith(saga.params);
            expect(backend.updateState).toHaveBeenCalledWith(SAGA_UUID, 'executed');
        });

        test('skips saga when required service is unavailable', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation(
                (_service: string): boolean => false
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 0 });
            expect(executors.bsky_reply).not.toHaveBeenCalled();
            expect(backend.updateState).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                { actionId: SAGA_UUID, type: 'bsky_reply', service: 'bsky' },
                'Skipping approved outbound action — required service unavailable'
            );
        });

        test('marks saga as failed with lastError when executor throws', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('network failure'); }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 1 });
            expect(backend.updateState).toHaveBeenCalledWith(
                SAGA_UUID,
                'failed',
                { lastError: 'network failure', failureKind: 'transient' }
            );
            expect(logger.error).toHaveBeenCalledWith(
                { actionId: SAGA_UUID, type: 'bsky_reply', error: 'network failure', failureKind: 'transient' },
                'Approved outbound action execution failed'
            );
        });

        test('records a permanent failureKind when the executor throws a validation error', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [makeSaga({ type: 'bsky_reply' })]);
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(async (): Promise<void> => {
                throw new BskyValidationError('Post exceeds 300 graphemes (301)');
            });

            await createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce();

            expect(backend.updateState).toHaveBeenCalledWith(
                SAGA_UUID,
                'failed',
                { lastError: 'Post exceeds 300 graphemes (301)', failureKind: 'permanent' }
            );
            expect(logger.error).toHaveBeenCalledWith(
                { actionId: SAGA_UUID, type: 'bsky_reply', error: 'Post exceeds 300 graphemes (301)', failureKind: 'permanent' },
                'Approved outbound action execution failed'
            );
        });

        test('propagates rejection when persisting the failed state fails', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('network failure'); }
            );
            (backend.updateState as ReturnType<typeof mock>).mockImplementation(
                async (_id: string, state: string): Promise<void> => {
                    if(state === 'failed') {
                        throw new Error('persist failed-state write failed');
                    }
                }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });

            await expect(executor.executeOnce()).rejects.toThrow('persist failed-state write failed');
        });

        test('uses String(err) for non-Error exceptions', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw 'string error'; }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            await executor.executeOnce();

            expect(backend.updateState).toHaveBeenCalledWith(
                SAGA_UUID,
                'failed',
                { lastError: 'string error', failureKind: 'transient' }
            );
        });

        test('counts multiple sagas — some succeed, some fail', async () => {
            const SAGA_UUID_2 = 'bbbbbbbb-1111-4222-8333-444444444444';
            const SAGA_UUID_3 = 'cccccccc-1111-4222-8333-444444444444';
            const saga1 = makeSaga({ id: SAGA_UUID,   type: 'bsky_reply' });
            const saga2 = makeSaga({ id: SAGA_UUID_2, type: 'bsky_dm' });
            const saga3 = makeSaga({ id: SAGA_UUID_3, type: 'email_send' });

            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga1, saga2, saga3]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => undefined
            );
            (executors.bsky_dm as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('DM failed'); }
            );
            (executors.email_send as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => undefined
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 2, failed: 1 });
        });

        test('persists each outcome before starting the next external action', async () => {
            const first = makeSaga({ id: 'aaaaaaaa-1111-4222-8333-000000000001', params: { label: 'first' } });
            const second = makeSaga({ id: 'aaaaaaaa-1111-4222-8333-000000000002', params: { label: 'second' } });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [first, second]);
            const events: string[] = [];
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(async (params: Record<string, unknown>) => {
                events.push(`execute:${String(params.label)}`);
            });
            (backend.updateState as ReturnType<typeof mock>).mockImplementation(async (id: string) => {
                events.push(`persist:${id}`);
            });

            const result = await createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce();
            expect(result).toEqual({ executed: 2, failed: 0 });
            expect(events).toEqual([
                'execute:first', `persist:${first.id}`,
                'execute:second', `persist:${second.id}`,
            ]);
        });

        test('never mislabels an action or starts a later action when the executed-state write fails', async () => {
            const first = makeSaga({ id: 'aaaaaaaa-1111-4222-8333-000000000001', type: 'bsky_reply' });
            const second = makeSaga({ id: 'aaaaaaaa-1111-4222-8333-000000000002', type: 'email_send' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [first, second]);
            (backend.updateState as ReturnType<typeof mock>).mockImplementation(async (id: string, state: string) => {
                if(id === first.id && state === 'executed') {
                    throw new Error('state write failed');
                }
            });
            await expect(createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce()).rejects.toThrow('state write failed');
            expect(executors.bsky_reply).toHaveBeenCalledTimes(1);
            expect(executors.email_send).not.toHaveBeenCalled();
            expect(backend.updateState).toHaveBeenCalledTimes(1);
            expect(backend.updateState).toHaveBeenCalledWith(first.id, 'executed');
            expect(backend.updateState).not.toHaveBeenCalledWith(first.id, 'failed', expect.anything());
        });

        test('logs info on successful saga execution', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            await executor.executeOnce();

            expect(logger.info).toHaveBeenCalledWith(
                { actionId: SAGA_UUID, type: 'bsky_reply' },
                'Approved outbound action executed successfully'
            );
        });

        test('calls listByState with "approved" state specifically', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            await executor.executeOnce();

            expect(backend.listByState).toHaveBeenCalledWith('approved');
        });

        test('signals a recorded outcome after the executed-state write', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [makeSaga()]);

            await createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce();

            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            expect(onOutcomeRecorded.mock.calls[0]).toEqual([]);
            const writeOrder = (backend.updateState as ReturnType<typeof mock>).mock.invocationCallOrder[0];
            expect(onOutcomeRecorded.mock.invocationCallOrder[0]).toBeGreaterThan(writeOrder);
        });

        test('signals a recorded outcome after the failed-state write', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [makeSaga()]);
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(async (): Promise<void> => {
                throw new Error('network failure');
            });

            await createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce();

            expect(onOutcomeRecorded).toHaveBeenCalledTimes(1);
            const writeOrder = (backend.updateState as ReturnType<typeof mock>).mock.invocationCallOrder[0];
            expect(onOutcomeRecorded.mock.invocationCallOrder[0]).toBeGreaterThan(writeOrder);
        });

        test('signals no outcome when the executed-state write rejects', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [makeSaga()]);
            (backend.updateState as ReturnType<typeof mock>).mockImplementation(async () => {
                throw new Error('state write failed');
            });

            await expect(createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce()).rejects.toThrow('state write failed');
            expect(onOutcomeRecorded).not.toHaveBeenCalled();
        });

        test('signals no outcome for an action skipped because its service is unavailable', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => [makeSaga()]);
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation((): boolean => false);

            await createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded }).executeOnce();

            expect(onOutcomeRecorded).not.toHaveBeenCalled();
        });
    });

    describe('wake', () => {
        test('wake() before start() arms no timer and lists nothing', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 30_000 });

            executor.wake();
            jest.advanceTimersByTime(30_000);
            await flush();

            expect(jest.getTimerCount()).toBe(0);
            expect(backend.listByState).not.toHaveBeenCalled();
        });

        test('wake() while idle runs the executor on a zero-delay timer', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 30_000 });
            executor.start();

            executor.wake();
            jest.advanceTimersByTime(0);
            await flush();

            expect(backend.listByState).toHaveBeenCalledTimes(1);
            executor.stop();
        });

        test('an approved email is submitted exactly once when wake() lands mid-send, through the coalesced rerun', async () => {
            const email = makeSaga({ type: 'email_send', params: { uid: 42 } });
            // The strongly consistent listing sees the row as approved until its executed write lands.
            let executedWritten = false;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(async () => (executedWritten ? [] : [email]));
            (backend.updateState as ReturnType<typeof mock>).mockImplementation(async () => {
                executedWritten = true;
            });
            const send = Promise.withResolvers<undefined>();
            (executors.email_send as ReturnType<typeof mock>).mockImplementation(() => send.promise);
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await flush();
            executor.wake();
            jest.advanceTimersByTime(0);
            await flush();
            expect(executors.email_send).toHaveBeenCalledTimes(1);
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            send.resolve(undefined);
            await flush();
            expect(backend.updateState).toHaveBeenCalledTimes(1);
            expect(backend.updateState).toHaveBeenCalledWith(SAGA_UUID, 'executed');

            jest.advanceTimersByTime(0);
            await flush();
            expect(backend.listByState).toHaveBeenCalledTimes(2);
            expect(executors.email_send).toHaveBeenCalledTimes(1);
            expect(executors.email_send).toHaveBeenCalledWith({ uid: 42 });
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
        ] as const)('executeOnce checks %s against service %s', async (sagaType, expectedService) => {
            const saga = makeSaga({ type: sagaType });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );
            // Track what service was queried
            const serviceChecked: string[] = [];
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation(
                (service: string): boolean => {
                    serviceChecked.push(service);
                    return true;
                }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            await executor.executeOnce();

            expect(serviceChecked).toContain(expectedService);
        });
    });

    describe('start and stop', () => {
        test('start creates a timer that calls executeOnce', async () => {
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            expect(backend.listByState).toHaveBeenCalled();

            executor.stop();
        });

        test('double-start guard: second start does not create a second timer', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // Only one poll tick despite two start() calls
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('redundant start() while mid-flight tick does not kill the poll loop', async () => {
            // A redundant start() while a run is in flight must not disturb that run's trailing
            // reschedule. A deferred listByState holds run T1 in flight while we inject the
            // redundant start(); after resolving, T1 must still arm T2, proving the loop is alive.
            let resolveListByState!: (value: ApprovedOutboundAction[]) => void;
            const deferredListByState = new Promise<ApprovedOutboundAction[]>((resolve) => {
                resolveListByState = resolve;
            });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                (): Promise<ApprovedOutboundAction[]> => deferredListByState
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // Fire T1 — the run starts and suspends at listByState.
            jest.advanceTimersByTime(1000);
            expect(backend.listByState).toHaveBeenCalledTimes(1);
            // No new timer while suspended (T1 fired, nothing rescheduled yet)
            expect(jest.getTimerCount()).toBe(0);

            // Inject a redundant start() while T1 is mid-flight: the loop is already started, so
            // it must be a no-op.
            executor.start();

            // Resolve the deferred — let T1 complete and arm T2.
            resolveListByState([]);
            await flush();

            expect(jest.getTimerCount()).toBe(1);

            executor.stop();
        });

        test('redundant start() while running leaves exactly one pending timer', async () => {
            // After a no-op start(), timer count must remain 1 (the already-scheduled next tick).
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();
            expect(jest.getTimerCount()).toBe(1);

            // Redundant start() — must not create a second timer
            executor.start();
            expect(jest.getTimerCount()).toBe(1);

            executor.stop();
        });

        test('stop clears timer so executeOnce is no longer called', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            jest.advanceTimersByTime(5000);
            await Promise.resolve();

            expect(backend.listByState).not.toHaveBeenCalled();
        });

        test('restart after stop works: stopped flag is reset', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            // Should be able to restart
            executor.start();
            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            expect(backend.listByState).toHaveBeenCalled();

            executor.stop();
        });

        test('stop is idempotent when not started', () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            // Should not throw
            expect(() => {
                executor.stop();
            }).not.toThrow();
        });

        test('stop then start during mid-flight tick leaves exactly one pending timer (no leak)', async () => {
            // Regression test for stop/start race: Bun's advanceTimersByTime drains microtasks
            // synchronously, so the race window must be opened by using a deferred (manually
            // resolved) promise for listByState — this keeps run T1 suspended while we call
            // stop()+start(), then we resolve to let T1 complete.
            //
            // start() already armed T2, so T1's trailing reschedule must not add a second timer.
            let resolveListByState!: (value: ApprovedOutboundAction[]) => void;
            const deferredListByState = new Promise<ApprovedOutboundAction[]>((resolve) => {
                resolveListByState = resolve;
            });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                (): Promise<ApprovedOutboundAction[]> => deferredListByState
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // Fire T1 — the run begins and suspends at await backend.listByState()
            jest.advanceTimersByTime(1000);
            // T1 fired; the run is suspended (timerCount=0 — no new timer scheduled yet)
            expect(jest.getTimerCount()).toBe(0);

            // Race: stop+start while T1 is mid-flight
            executor.stop();   // stopped, clears the timer (T1 already fired, no-op)
            executor.start();  // started again, arms T2 → timerCount=1
            expect(jest.getTimerCount()).toBe(1);

            // Now resolve listByState → T1 can complete
            resolveListByState([]);
            await flush();

            // Only T2 (from start()) is pending: T1 found a timer already armed
            expect(jest.getTimerCount()).toBe(1);

            executor.stop();
        });

        test('timer firing during a run left over from stop/start defers to a rerun instead of overlapping', async () => {
            // A second concurrent listByState here would be the double-send bug: both runs would
            // list and send the same approved row. The stale run's timer successor must only ask
            // for a rerun, and exactly one timer may be pending throughout.
            const first = Promise.withResolvers<ApprovedOutboundAction[]>();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(() => {
                callCount++;
                return callCount === 1 ? first.promise : Promise.resolve([]);
            });
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });

            try {
                executor.start();
                jest.advanceTimersByTime(1000); // first run remains in flight
                executor.stop();
                executor.start();
                expect(jest.getTimerCount()).toBe(1);
                jest.advanceTimersByTime(1000); // timer fires while the first run is still in flight
                expect(backend.listByState).toHaveBeenCalledTimes(1);
                expect(jest.getTimerCount()).toBe(0);
                executor.stop();
                executor.start();
                expect(jest.getTimerCount()).toBe(1);

                first.resolve([]);
                await flush();
                expect(backend.listByState).toHaveBeenCalledTimes(1);
                expect(jest.getTimerCount()).toBe(1);

                jest.advanceTimersByTime(0); // the coalesced rerun
                await flush();
                expect(backend.listByState).toHaveBeenCalledTimes(2);
                expect(jest.getTimerCount()).toBe(1);
            } finally {
                first.resolve([]);
                await Promise.resolve();
                executor.stop();
            }
        });

        test('stop alone (no restart) leaves zero pending timers after mid-flight tick', async () => {
            // Verify that stop() without a subsequent start() leaves 0 timers, even when stop()
            // races with a mid-flight tick (deferred listByState keeps the run suspended).
            let resolveListByState!: (value: ApprovedOutboundAction[]) => void;
            const deferredListByState = new Promise<ApprovedOutboundAction[]>((resolve) => {
                resolveListByState = resolve;
            });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                (): Promise<ApprovedOutboundAction[]> => deferredListByState
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // Fire T1 — the run starts and suspends at listByState
            jest.advanceTimersByTime(1000);
            expect(jest.getTimerCount()).toBe(0); // T1 fired, run suspended, no new timer yet

            // Stop only — no subsequent start()
            executor.stop();

            // Resolve the deferred so the run can complete
            resolveListByState([]);
            await flush();

            // Stopped → the finishing run must arm nothing → 0 timers
            expect(jest.getTimerCount()).toBe(0);
        });

        test('the first poll after start() runs the executor', async () => {
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('clearTimeout is called when stop() is called after start()', async () => {
            const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            // clearTimeout must have been called (not skipped by inverted guard)
            expect(clearTimeoutSpy).toHaveBeenCalled();

            // After stop, advancing time should not trigger listByState
            jest.advanceTimersByTime(3000);
            await Promise.resolve();
            expect(backend.listByState).not.toHaveBeenCalled();

            clearTimeoutSpy.mockRestore();
        });

        test('start() after stop() resumes at base interval', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });

            // Start, let it run two empty ticks (interval should have doubled to 2000)
            executor.start();
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();

            executor.stop();

            // Restart — interval should snap back to base (1000)
            executor.start();

            // Should NOT fire before 1000ms
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            const callsBefore = (backend.listByState as ReturnType<typeof mock>).mock.calls.length;

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            const callsAfter = (backend.listByState as ReturnType<typeof mock>).mock.calls.length;

            expect(callsAfter).toBe(callsBefore + 1);

            executor.stop();
        });
    });

    describe('pollIntervalMs', () => {
        test('uses DEFAULT_POLL_INTERVAL_MS (30000) when not provided', async () => {
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded });
            executor.start();

            // Should not trigger at 29 seconds
            jest.advanceTimersByTime(29_999);
            await Promise.resolve();
            expect(backend.listByState).not.toHaveBeenCalled();

            // Should trigger at 30 seconds
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(backend.listByState).toHaveBeenCalled();

            executor.stop();
        });

        test('uses custom pollIntervalMs when provided', async () => {
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => [saga]
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 5000 });
            executor.start();

            // Should not trigger at 4999 ms
            jest.advanceTimersByTime(4999);
            await Promise.resolve();
            expect(backend.listByState).not.toHaveBeenCalled();

            // Should trigger at 5000 ms
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(backend.listByState).toHaveBeenCalled();

            executor.stop();
        });
    });

    describe('poll backoff', () => {
        test('empty result doubles the next tick interval', async () => {
            // baseInterval = 1000, empty result → next tick at 2000
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick fires at 1000ms, returns empty
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();

            const callsAfterFirstTick = (backend.listByState as ReturnType<typeof mock>).mock.calls.length;
            expect(callsAfterFirstTick).toBe(1);

            // Next tick should NOT fire at base interval (1000ms more = 2000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Next tick SHOULD fire at doubled interval (2000ms more = 3000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            executor.stop();
        });

        test('two consecutive empty results produce interval of 4x base on third tick', async () => {
            // tick 1 at 1000ms → empty → next at 2000ms
            // tick 2 at 3000ms → empty → next at 4000ms
            // tick 3 at 7000ms
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Second tick at 3000ms (1000 + 2000)
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            // Third tick should NOT fire at 6999ms (3000 + 3999 < 3000 + 4000)
            jest.advanceTimersByTime(3999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            // Third tick fires at 7000ms (3000 + 4000)
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
            executor.stop();
        });

        test('interval is capped at MAX_POLL_INTERVAL_MS (5 minutes)', async () => {
            // Use a large base so we reach the cap quickly without many doublings
            // base = 200_000ms → doubled = 400_000ms > MAX (300_000ms) → capped at 300_000ms
            const base = 200_000;
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: base });
            executor.start();

            // First tick at 200_000ms — empty result
            jest.advanceTimersByTime(base);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Doubled would be 400_000ms but cap is 300_000ms (5 min)
            // Should NOT fire at 299_999ms more
            jest.advanceTimersByTime(299_999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Should fire at 300_000ms more (the cap)
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            // Another empty — should still use cap (300_000ms), not double further
            jest.advanceTimersByTime(299_999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
            expect(logger.debug).toHaveBeenCalledWith(
                { intervalMs: 300_000 },
                'Approved outbound action poll interval extended'
            );
            expect(logger.debug).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('non-empty result resets interval to base', async () => {
            // Start with an empty tick to build up backoff, then a non-empty tick
            const saga = makeSaga();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => {
                    callCount += 1;
                    // First call: empty; second call: has a saga
                    return callCount === 1 ? [] : [saga];
                }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → interval doubles to 2000
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Second tick at 3000ms — non-empty → resets interval to 1000
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
            expect(logger.debug).toHaveBeenCalledWith(
                { intervalMs: 1000 },
                'Approved outbound action poll interval reset to base'
            );

            // Third tick should fire at 1000ms after (not 2000ms), i.e. 4000ms total
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);

            executor.stop();
        });

        test('non-empty first tick does not emit a redundant base-reset log', async () => {
            (backend.listByState as ReturnType<typeof mock>).mockResolvedValue([makeSaga()]);
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();

            expect(logger.debug).not.toHaveBeenCalled();
            executor.stop();
        });

        test('empty after non-empty restarts backoff from base', async () => {
            // Tick 1 at 1000ms: empty → interval 2000
            // Tick 2 at 3000ms: non-empty → reset to 1000
            // Tick 3 at 4000ms: empty → interval 2000
            // Tick 4 should fire at 6000ms (4000 + 2000), not 5000ms (4000 + 1000)
            const saga = makeSaga();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => {
                    callCount += 1;
                    return callCount === 2 ? [saga] : [];
                }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // Tick 1 at 1000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            // Tick 2 at 3000ms
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            // Tick 3 at 4000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);

            // Tick 4 should NOT fire at 1000ms after tick 3 (5000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);

            // Tick 4 SHOULD fire at 2000ms after tick 3 (6000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(4);

            executor.stop();
        });

        test('stop() mid-backoff cancels the scheduled timer', async () => {
            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → next scheduled at 2000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Stop mid-backoff
            executor.stop();

            // Advance past where the next backoff tick would have fired
            jest.advanceTimersByTime(3000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
        });

        test('non-empty result (failed sagas) also resets interval to base', async () => {
            const saga = makeSaga();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => {
                    callCount += 1;
                    return callCount === 1 ? [] : [saga];
                }
            );
            // Make executor throw so result.failed > 0
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('oops'); }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → interval doubles to 2000
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            // Second tick at 3000ms — failed saga → reset to base (1000)
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            // Third tick should fire at 1000ms (base) not 2000ms
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(3);

            executor.stop();
        });

        test('executeOnce rejection (backend throws) does not stop rescheduling', async () => {
            // If listByState throws, executeOnce rejects and the .catch() handler reschedules
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovedOutboundAction[]> => {
                    callCount += 1;
                    if(callCount === 1) {
                        throw new Error('DynamoDB unavailable');
                    }
                    return [];
                }
            );

            const executor = createApprovedOutboundActionExecutor({ backend, registry, executors, logger, onOutcomeRecorded, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — throws, catch block logs at debug level, reschedules at base interval
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'DynamoDB unavailable' }),
                expect.stringContaining('Approved outbound action poll tick threw')
            );

            // Next tick should still fire at base interval (not doubled — rejection doesn't backoff)
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(1);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls).toHaveLength(2);

            executor.stop();
        });
    });
});

describe('classifyFailure', () => {
    const zodError = z.object({ uid: z.number() }).safeParse({ uid: 'x' }).error;

    const cases: [string, unknown, 'transient' | 'permanent'][] = [
        ['a ZodError (unreadable params)', zodError, 'permanent'],
        ['a BskyValidationError', new BskyValidationError('too long'), 'permanent'],
        ['a BskyError with status 400', new BskyError('bad', undefined, { status: 400 }), 'permanent'],
        ['a BskyError with status 499', new BskyError('bad', undefined, { status: 499 }), 'permanent'],
        ['a BskyError with status 399', new BskyError('odd', undefined, { status: 399 }), 'transient'],
        ['a BskyError with status 500', new BskyError('down', undefined, { status: 500 }), 'transient'],
        ['a BskyError with a non-numeric status', new BskyError('odd', undefined, { status: '404' }), 'transient'],
        ['a BskyError with no context', new BskyError('no context'), 'transient'],
        ['a BskyAuthError even if it carries status 401', new BskyAuthError('auth', { status: 401 }), 'transient'],
        ['a BskyRateLimitError even if it carries status 429', new BskyRateLimitError('slow down', { status: 429 }), 'transient'],
        ['a WildDuckError', new WildDuckError('smtp down'), 'transient'],
        ['a plain Error', new Error('network failure'), 'transient'],
        ['a thrown string', 'string error', 'transient'],
    ];
    for(const [name, err, expected] of cases) {
        test(`classifies ${name} as ${expected}`, () => {
            expect(classifyFailure(err)).toBe(expected);
        });
    }
});
