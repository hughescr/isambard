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
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
            info:  mock((): void => undefined),
        };
    });

    afterEach(() => {
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
        test('start creates an interval that calls executeOnce', async () => {
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

        test('double-start guard: second start does not create a second interval', async () => {
            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();
            executor.start();

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // Only one poll tick despite two start() calls
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('stop clears interval so executeOnce is no longer called', async () => {
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

        test('stopped flag starts as false: interval callback fires executeOnce immediately on first tick', async () => {
            // If stopped started as true, interval callback would skip executeOnce
            const saga = makeSaga();
            (backend.listByState as ReturnType<typeof mock>).mockImplementation(
                async (): Promise<ApprovalSaga[]> => [saga]
            );

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start(); // stopped must be false for interval to execute

            jest.advanceTimersByTime(1000);
            await Promise.resolve();

            // If stopped started as true, listByState would NOT be called
            expect(backend.listByState).toHaveBeenCalledTimes(1);

            executor.stop();
        });

        test('clearInterval is called when stop() is called after start()', async () => {
            const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');

            const executor = createSagaExecutor({ backend, registry, executors, logger, pollIntervalMs: 1000 });
            executor.start();
            executor.stop();

            // clearInterval must have been called (not skipped by inverted guard)
            expect(clearIntervalSpy).toHaveBeenCalled();

            // After stop, advancing time should not trigger listByState
            jest.advanceTimersByTime(3000);
            await Promise.resolve();
            expect(backend.listByState).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
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
});
