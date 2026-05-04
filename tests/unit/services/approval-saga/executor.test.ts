import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import type { ApprovalSagaBackend } from '@/services/approval-saga/backend';
import { createSagaExecutor, type SagaExecutorLogger  } from '@/services/approval-saga/executor';
import type { ApprovalSaga, ApprovalSagaType } from '@/services/approval-saga/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';

const SAGA_UUID = 'aaaaaaaa-1111-4222-8333-444444444444';

function makeSaga(overrides: Partial<ApprovalSaga> = {}): ApprovalSaga {
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

describe('createSagaExecutor', () => {
    let backend: ApprovalSagaBackend;
    let registry: ServiceHealthRegistry;
    let executors: Record<ApprovalSagaType, (params: Record<string, unknown>) => Promise<void>>;
    let logger: SagaExecutorLogger;

    beforeEach(() => {
        jest.useFakeTimers();

        backend = {
            listByState: mock(async (): Promise<ApprovalSaga[]> => []),
            updateState: mock(async (): Promise<void> => undefined),
            create:      mock(async (): Promise<void> => undefined),
            get:         mock(async (): Promise<ApprovalSaga | undefined> => undefined),
        } as unknown as ApprovalSagaBackend;

        registry = {
            isAvailable: mock((_service: string): boolean => true),
        } as unknown as ServiceHealthRegistry;

        executors = {

            bsky_reply: mock(async (): Promise<void> => undefined),

            bsky_dm: mock(async (): Promise<void> => undefined),

            email_send: mock(async (): Promise<void> => undefined),

            email_reply: mock(async (): Promise<void> => undefined),
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
                async (): Promise<ApprovalSaga[]> => []
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 0 });
        });

        test('executes saga and marks it as executed when service is available', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 1, failed: 0 });
            expect(executors.bsky_reply).toHaveBeenCalledWith(saga.params);
            expect(backend.updateState).toHaveBeenCalledWith(SAGA_UUID, 'executed');
        });

        test('skips saga when required service is unavailable', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation(
                (_service: string): boolean => false
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 0 });
            expect(executors.bsky_reply).not.toHaveBeenCalled();
            expect(backend.updateState).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ sagaId: SAGA_UUID, service: 'bluesky' }),
                expect.stringContaining('unavailable')
            );
        });

        test('marks saga as failed with lastError when executor throws', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('network failure'); }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 0, failed: 1 });
            expect(backend.updateState).toHaveBeenCalledWith(
                SAGA_UUID,
                'failed',
                { lastError: 'network failure' }
            );
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ sagaId: SAGA_UUID, error: 'network failure' }),
                expect.stringContaining('failed')
            );
        });

        test('uses String(err) for non-Error exceptions', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw 'string error'; }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            await executor.executeOnce();

            expect(backend.updateState).toHaveBeenCalledWith(
                SAGA_UUID,
                'failed',
                { lastError: 'string error' }
            );
        });

        test('counts multiple sagas — some succeed, some fail', async () => {
            const SAGA_UUID_2 = 'bbbbbbbb-1111-4222-8333-444444444444';
            const SAGA_UUID_3 = 'cccccccc-1111-4222-8333-444444444444';
            const saga1 = makeSaga({ id: SAGA_UUID,   type: 'bsky_reply' });
            const saga2 = makeSaga({ id: SAGA_UUID_2, type: 'bsky_dm' });
            const saga3 = makeSaga({ id: SAGA_UUID_3, type: 'email_send' });

            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga1, saga2, saga3]
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

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            const result = await executor.executeOnce();

            expect(result).toEqual({ executed: 2, failed: 1 });
        });

        test('logs info on successful saga execution', async () => {
            const saga = makeSaga({ type: 'bsky_reply' });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            await executor.executeOnce();

            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ sagaId: SAGA_UUID, type: 'bsky_reply' }),
                expect.stringContaining('executed successfully')
            );
        });

        test('calls listByState with "approved" state specifically', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger });
            await executor.executeOnce();

            expect(backend.listByState).toHaveBeenCalledWith('approved');
        });
    });

    describe('getRequiredService mapping', () => {
        test.each([
            ['bsky_reply', 'bluesky'],
            ['bsky_dm',    'bluesky'],
            ['email_send', 'email'],
            ['email_reply', 'email'],
        ] as const)('%s maps to service %s', async (sagaType, expectedService) => {
            const saga = makeSaga({ type: sagaType });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );
            // Track what service was queried
            const serviceChecked: string[] = [];
            (registry.isAvailable as ReturnType<typeof mock>).mockImplementation(
                (service: string): boolean => {
                    serviceChecked.push(service);
                    return true;
                }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
            await executor.executeOnce();

            expect(serviceChecked).toContain(expectedService);
        });
    });

    describe('start and stop', () => {
        test('start creates a timer that calls executeOnce', async () => {
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            expect(backend.listByState).toHaveBeenCalled();

            executor.stop();
        });

        test('double-start guard: second start does not create a second timer', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // Only one poll tick despite two start() calls
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('stop clears timer so executeOnce is no longer called', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            jest.advanceTimersByTime(5000);
            await Promise.resolve();

            expect(backend.listByState).not.toHaveBeenCalled();
        });

        test('restart after stop works: stopped flag is reset', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
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
            const executor = createSagaExecutor({ backend, registry, executors, logger });
            // Should not throw
            expect(() => {
                executor.stop();
            }).not.toThrow();
        });

        test('stop then start during mid-flight tick leaves exactly one pending timer (no leak)', async () => {
            // Regression test for stop/start race: Bun's advanceTimersByTime drains microtasks
            // synchronously, so the race window must be opened by using a deferred (manually
            // resolved) promise for listByState — this keeps the async IIFE suspended while we
            // call stop()+start(), then we resolve to let the IIFE complete.
            //
            // Without the generation-counter fix, the in-flight IIFE's trailing scheduleNextTick
            // runs after start() has already scheduled T2, producing two pending timers (T2+T3).
            // With the fix, the IIFE detects its generation is stale and skips rescheduling.
            let resolveListByState!: (value: ApprovalSaga[]) => void;
            const deferredListByState = new Promise<ApprovalSaga[]>((resolve) => {
                resolveListByState = resolve;
            });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                (): Promise<ApprovalSaga[]> => deferredListByState
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // Fire T1 — async IIFE begins, suspends at await backend.listByState()
            jest.advanceTimersByTime(1000);
            // T1 fired; IIFE is now truly suspended (timerCount=0 — no new timer scheduled yet)
            expect(jest.getTimerCount()).toBe(0);

            // Race: stop+start while T1's IIFE is mid-flight
            executor.stop();   // stopped=true, clears timeoutId (T1 already fired, no-op)
            executor.start();  // stopped=false, bumps generation, schedules T2 → timerCount=1
            expect(jest.getTimerCount()).toBe(1);

            // Now resolve listByState → T1's IIFE can complete
            resolveListByState([]);
            await Promise.resolve(); // listByState resolves inside executeOnce
            await Promise.resolve(); // executeOnce returns; IIFE runs backoff branch
            await Promise.resolve(); // trailing scheduleNextTick() — must be suppressed by generation check

            // With the fix: only T2 (from start()) pending, T1's trailing reschedule was suppressed
            expect(jest.getTimerCount()).toBe(1);

            executor.stop();
        });

        test('stop alone (no restart) leaves zero pending timers after mid-flight tick', async () => {
            // Verify that stop() without a subsequent start() leaves 0 timers, even when stop()
            // races with a mid-flight tick (deferred listByState keeps the IIFE suspended).
            let resolveListByState!: (value: ApprovalSaga[]) => void;
            const deferredListByState = new Promise<ApprovalSaga[]>((resolve) => {
                resolveListByState = resolve;
            });
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                (): Promise<ApprovalSaga[]> => deferredListByState
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // Fire T1 — IIFE starts, suspends at listByState
            jest.advanceTimersByTime(1000);
            expect(jest.getTimerCount()).toBe(0); // T1 fired, IIFE suspended, no new timer yet

            // Stop only — no subsequent start()
            executor.stop();

            // Resolve the deferred so IIFE can complete
            resolveListByState([]);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // stopped=true → scheduleNextTick must bail out → 0 timers
            expect(jest.getTimerCount()).toBe(0);
        });

        test('stopped flag starts as false: timer callback fires executeOnce on first tick', async () => {
            // If stopped started as true, timer callback would skip executeOnce
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start(); // stopped must be false for timer to execute

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // If stopped started as true, listByState would NOT be called
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('clearTimeout is called when stop() is called after start()', async () => {
            const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
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
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });

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
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger });
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
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 5000 });
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
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
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
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Next tick SHOULD fire at doubled interval (2000ms more = 3000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            executor.stop();
        });

        test('two consecutive empty results produce interval of 4x base on third tick', async () => {
            // tick 1 at 1000ms → empty → next at 2000ms
            // tick 2 at 3000ms → empty → next at 4000ms
            // tick 3 at 7000ms
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Second tick at 3000ms (1000 + 2000)
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            // Third tick should NOT fire at 6999ms (3000 + 3999 < 3000 + 4000)
            jest.advanceTimersByTime(3999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            // Third tick fires at 7000ms (3000 + 4000)
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

            executor.stop();
        });

        test('interval is capped at MAX_POLL_INTERVAL_MS (5 minutes)', async () => {
            // Use a large base so we reach the cap quickly without many doublings
            // base = 200_000ms → doubled = 400_000ms > MAX (300_000ms) → capped at 300_000ms
            const base = 200_000;
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: base });
            executor.start();

            // First tick at 200_000ms — empty result
            jest.advanceTimersByTime(base);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Doubled would be 400_000ms but cap is 300_000ms (5 min)
            // Should NOT fire at 299_999ms more
            jest.advanceTimersByTime(299_999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Should fire at 300_000ms more (the cap)
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            // Another empty — should still use cap (300_000ms), not double further
            jest.advanceTimersByTime(299_999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

            executor.stop();
        });

        test('non-empty result resets interval to base', async () => {
            // Start with an empty tick to build up backoff, then a non-empty tick
            const saga = makeSaga();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => {
                    callCount += 1;
                    // First call: empty; second call: has a saga
                    return callCount === 1 ? [] : [saga];
                }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → interval doubles to 2000
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Second tick at 3000ms — non-empty → resets interval to 1000
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            // Third tick should fire at 1000ms after (not 2000ms), i.e. 4000ms total
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

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
                async (): Promise<ApprovalSaga[]> => {
                    callCount += 1;
                    return callCount === 2 ? [saga] : [];
                }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
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
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

            // Tick 4 should NOT fire at 1000ms after tick 3 (5000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

            // Tick 4 SHOULD fire at 2000ms after tick 3 (6000ms total)
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(4);

            executor.stop();
        });

        test('stop() mid-backoff cancels the scheduled timer', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → next scheduled at 2000ms
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Stop mid-backoff
            executor.stop();

            // Advance past where the next backoff tick would have fired
            jest.advanceTimersByTime(3000);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);
        });

        test('non-empty result (failed sagas) also resets interval to base', async () => {
            const saga = makeSaga();
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => {
                    callCount += 1;
                    return callCount === 1 ? [] : [saga];
                }
            );
            // Make executor throw so result.failed > 0
            (executors.bsky_reply as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<void> => { throw new Error('oops'); }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — empty → interval doubles to 2000
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            // Second tick at 3000ms — failed saga → reset to base (1000)
            jest.advanceTimersByTime(2000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            // Third tick should fire at 1000ms (base) not 2000ms
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(3);

            executor.stop();
        });

        test('executeOnce rejection (backend throws) does not stop rescheduling', async () => {
            // If listByState throws, executeOnce rejects and the .catch() handler reschedules
            let callCount = 0;
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => {
                    callCount += 1;
                    if(callCount === 1) {
                        throw new Error('DynamoDB unavailable');
                    }
                    return [];
                }
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();

            // First tick at 1000ms — throws, catch block logs at debug level, reschedules at base interval
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);
            expect(logger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ error: 'DynamoDB unavailable' }),
                expect.stringContaining('Saga poll tick threw')
            );

            // Next tick should still fire at base interval (not doubled — rejection doesn't backoff)
            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(1);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect((backend.listByState as ReturnType<typeof mock>).mock.calls.length).toBe(2);

            executor.stop();
        });
    });
});
