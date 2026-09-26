import { describe, test, expect, beforeEach, afterEach, jest, mock, spyOn } from 'bun:test';
import { createChannelId } from '@/agent/types';
import { ChannelNotFoundByIdError } from '@/errors';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import type { OutboxBackend } from '@/services/outbox/backend';
import { createOutboxDrainer, OutboxDeliveryDeferredError, OutboxDiscardRequestedError, OutboxVerificationPendingError, OUTBOX_DEFERRED_RETRY_DELAY_MS, type OutboxDrainerDeps, type OutboxDrainer } from '@/services/outbox/drainer';
import type { OutboxItem } from '@/services/outbox/types';
import type { ServiceName } from '@/services/types';

const SERVICE: ServiceName = 'discord';
const ITEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const CREATED = '2026-03-30T12:00:00.000Z';

function makeItem(overrides?: Partial<OutboxItem>): OutboxItem {
    return {
        id:          ITEM_ID,
        createdAt:   CREATED,
        type:        'agent_response',
        service:     'discord',
        destination: createChannelId('channel-123'),
        payload:     { text: 'Hello' },
        priority:    'medium',
        dedupeKey:   'dedup-abc',
        progress:    { attemptCount: 0 },
        epoch:       1,
        ...overrides,
    };
}

function makeEntry(epoch: number) {
    return {
        state:        'online' as const,
        epoch,
        failureCount: 0,
    };
}

describe('createOutboxDrainer', () => {
    let deps: OutboxDrainerDeps;
    let outboxBackend: {
        dequeue:              ReturnType<typeof mock>
        acknowledgeDelivered: ReturnType<typeof mock>
        discard:              ReturnType<typeof mock>
        markFailed:           ReturnType<typeof mock>
        markUnknown:          ReturnType<typeof mock>
        defer:                ReturnType<typeof mock>
        markPendingDiscard:   ReturnType<typeof mock>
    };
    let registry: {
        isAvailable: ReturnType<typeof mock>
        getEntry:    ReturnType<typeof mock>
    };
    let deliverFn: ReturnType<typeof mock>;
    let logger: {
        debug: ReturnType<typeof mock>
        warn:  ReturnType<typeof mock>
        error: ReturnType<typeof mock>
        info:  ReturnType<typeof mock>
    };
    let drainer: OutboxDrainer;

    beforeEach(() => {
        jest.useFakeTimers();
        outboxBackend = {
            dequeue:              mock(async (): Promise<OutboxItem[]> => []),
            acknowledgeDelivered: mock(async (): Promise<void> => undefined),
            discard:              mock(async (): Promise<void> => undefined),
            markFailed:           mock(async (): Promise<void> => undefined),
            markUnknown:          mock(async (): Promise<void> => undefined),
            defer:                mock(async (): Promise<void> => undefined),
            markPendingDiscard:   mock(async (): Promise<void> => undefined),
        };
        registry = {
            isAvailable: mock((): boolean => true),
            getEntry:    mock(() => makeEntry(1)),
        };
        deliverFn = mock(async (): Promise<void> => undefined);
        logger    = {
            debug: mock((): void => undefined),
            warn:  mock((): void => undefined),
            error: mock((): void => undefined),
            info:  mock((): void => undefined),
        };
        deps = {
            outboxBackend:   outboxBackend as unknown as OutboxBackend,
            registry:        registry as unknown as ServiceHealthRegistry,
            deliverFn,
            logger,
            batchSize:       3,
            drainIntervalMs: 100,
        };
        drainer = createOutboxDrainer(deps);
    });

    afterEach(() => {
        drainer.stop();
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('does not schedule repeated sends after a full failed batch', async () => {
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [makeItem(), makeItem(), makeItem()]);
        deliverFn.mockImplementation(async (): Promise<void> => {
            throw new Error('transient');
        });
        const result = await drainer.drain(SERVICE);
        expect(result.failed).toBe(3);
        expect(jest.getTimerCount()).toBe(1);
    });

    test('reports delivered-but-unacknowledged separately and does not reschedule', async () => {
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [makeItem(), makeItem(), makeItem()]);
        outboxBackend.acknowledgeDelivered.mockImplementationOnce(async (): Promise<void> => {
            throw new Error('delete unavailable');
        });
        const result = await drainer.drain(SERVICE);
        expect(result.unacknowledged).toBe(1);
        expect(result.failed).toBe(0);
        expect(outboxBackend.markFailed).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
    });

    describe('drain() — stopped guard', () => {
        test('returns zero result immediately when stop() was called before drain()', async () => {
            drainer.stop();

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.dequeue).not.toHaveBeenCalled();
        });
    });

    describe('drain() — service unavailability', () => {
        test('returns zero result when service is not available', async () => {
            registry.isAvailable.mockImplementation((): boolean => false);

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.dequeue).not.toHaveBeenCalled();
        });
    });

    describe('drain() — successful delivery', () => {
        test('does not start a second drain while delivery is in flight', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            const gate = Promise.withResolvers<void>();
            deliverFn.mockImplementation((): Promise<void> => gate.promise);

            const first = drainer.drain(SERVICE);
            await Promise.resolve();
            await Promise.resolve();
            const second = drainer.drain(SERVICE);
            gate.resolve();
            expect(await second).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            const result = await first;
            expect(result.delivered).toBe(1);
        });

        test('delivers items and marks them sent', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            const result = await drainer.drain(SERVICE);

            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(0);
            expect(deliverFn).toHaveBeenCalledWith(item);
            expect(outboxBackend.acknowledgeDelivered).toHaveBeenCalledWith(item);
        });

        test('delivers multiple items and counts each', async () => {
            const items = [
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
            ];
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);

            const result = await drainer.drain(SERVICE);

            expect(result.delivered).toBe(2);
            expect(result.failed).toBe(0);
            expect(outboxBackend.acknowledgeDelivered).toHaveBeenCalledTimes(2);
        });
    });

    describe('drain() — delivery failure', () => {
        test('reports acknowledgement failure without misclassifying delivery', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            outboxBackend.acknowledgeDelivered.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delete unavailable');
            });

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 1 });
            expect(outboxBackend.markFailed).not.toHaveBeenCalled();
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: item.id, attemptCount: 0 }),
                'Outbox item delivered but unacknowledged'
            );
        });

        test('logs retry persistence failure and continues to later items', async () => {
            const item = makeItem();
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item, next]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delivery unavailable');
            });
            outboxBackend.markFailed.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Write unavailable');
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 1, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.acknowledgeDelivered).toHaveBeenCalledWith(next);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: item.id, reason: 'retry', attemptCount: 1 }),
                'Failed to record outbox delivery failure'
            );
        });

        test('marks item failed and continues to next item when deliverFn throws Error', async () => {
            const item1 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
            const item2 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item1, item2]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Network error');
            });

            const result = await drainer.drain(SERVICE);

            expect(result.failed).toBe(1);
            expect(result.delivered).toBe(1);
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item1, 'Network error', expect.objectContaining({ retryable: true, nextAttemptAt: expect.any(String) }));
            expect(outboxBackend.acknowledgeDelivered).toHaveBeenCalledWith(item2);
        });

        test('marks item failed when deliverFn throws a non-Error value', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw { message: 'ignored', toString: () => 'plain string error' };
            });

            const result = await drainer.drain(SERVICE);

            expect(result.failed).toBe(1);
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'plain string error', expect.objectContaining({ retryable: true, nextAttemptAt: expect.any(String) }));
        });

        test('records a null delivery failure as the string null', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw null;
            });

            await drainer.drain(SERVICE);

            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'null', expect.objectContaining({ retryable: true, nextAttemptAt: expect.any(String) }));
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, error: 'null' }, 'Failed to deliver outbox item');
        });

        test('records an undefined delivery failure as an unclassified retry', async () => {
            const item = makeItem();
            const classify = mock(async () => ({ disposition: 'abandon' as const, confidence: 1 }));
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw undefined;
            });
            const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify }, now: () => 1000 });

            expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(classify).not.toHaveBeenCalled();
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'undefined', { retryable: true, nextAttemptAt: '1970-01-01T00:00:01.100Z' });
            classified.stop();
        });

        test('logs error when delivery fails', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Boom');
            });

            await drainer.drain(SERVICE);

            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ service: SERVICE, itemId: item.id, error: 'Boom' }),
                'Failed to deliver outbox item'
            );
        });
    });

    test('schedules an already-past failed-delivery retry with zero delay', async () => {
        const item = makeItem();
        let clock = 1000;
        outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [item]);
        outboxBackend.markFailed.mockImplementationOnce(async (): Promise<void> => {
            clock = 2000;
        });
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new Error('offline');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => clock });
        const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

        await retrying.drain(SERVICE);

        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'offline', { retryable: true, nextAttemptAt: '1970-01-01T00:00:01.100Z' });
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 0);
        jest.advanceTimersByTime(0);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        retrying.stop();
    });

    test('persists a verification-pending failure as unknown with a scheduled retry', async () => {
        const item = makeItem({ progress: { attemptCount: 1, outcome: 'unknown' } });
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new OutboxVerificationPendingError('history unavailable');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });

        expect(await retrying.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
        expect(outboxBackend.markUnknown).toHaveBeenCalledWith(item, 'history unavailable', '1970-01-01T00:00:01.200Z');
        expect(outboxBackend.markFailed).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(1);
        retrying.stop();
    });

    test('schedules an already-past unknown-outcome retry with zero delay', async () => {
        const item = makeItem();
        let clock = 1000;
        outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [item]);
        outboxBackend.markUnknown.mockImplementationOnce(async (): Promise<void> => {
            clock = 2000;
        });
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new OutboxVerificationPendingError('unverified');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => clock });
        const setTimeoutSpy = spyOn(globalThis, 'setTimeout');

        await retrying.drain(SERVICE);

        expect(outboxBackend.markUnknown).toHaveBeenCalledWith(item, 'unverified', '1970-01-01T00:00:01.100Z');
        expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 0);
        jest.advanceTimersByTime(0);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        retrying.stop();
    });

    test('names verification-pending errors and uses their default message', () => {
        const error = new OutboxVerificationPendingError();
        expect(error.name).toBe('OutboxVerificationPendingError');
        expect(error.message).toBe('Discord delivery verification remains indeterminate');
    });

    test('waits for unknown-outcome persistence before scheduling its retry', async () => {
        const item = makeItem({ progress: { attemptCount: 0 } });
        const persisted = Promise.withResolvers<void>();
        outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [item]);
        outboxBackend.markUnknown.mockImplementationOnce(() => persisted.promise);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new OutboxVerificationPendingError('unverified');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });
        const draining = retrying.drain(SERVICE);

        await Promise.resolve();
        await Promise.resolve();
        expect(jest.getTimerCount()).toBe(0);
        persisted.resolve();
        expect(await draining).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
        expect(jest.getTimerCount()).toBe(1);
        retrying.stop();
    });

    test('logs a failed unknown-outcome persistence without scheduling a retry', async () => {
        const item = makeItem();
        const persistenceError = new Error('write unavailable');
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        outboxBackend.markUnknown.mockImplementationOnce(async (): Promise<void> => {
            throw persistenceError;
        });
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new OutboxVerificationPendingError('unverified');
        });

        expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
        expect(logger.error).toHaveBeenCalledWith(
            { service: SERVICE, itemId: item.id, error: persistenceError },
            'Failed to persist indeterminate outbox verification'
        );
        expect(jest.getTimerCount()).toBe(0);
    });

    test('waits exactly one backoff interval before retrying an unknown outcome', async () => {
        const item = makeItem();
        outboxBackend.dequeue
            .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
            .mockImplementationOnce(async (): Promise<OutboxItem[]> => []);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new OutboxVerificationPendingError('unverified');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });

        await retrying.drain(SERVICE);
        jest.advanceTimersByTime(99);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        retrying.stop();
    });

    test('abandons a classified known rejection and records its decision', async () => {
        const item = makeItem();
        const classify = mock(async () => ({ disposition: 'abandon' as const, confidence: 0.97 }));
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw Object.assign(new Error('Missing Permissions'), { status: 403 });
        });
        const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify } });

        expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
        expect(classify).toHaveBeenCalledWith({ message: 'Missing Permissions', status: 403 });
        expect(outboxBackend.discard).toHaveBeenCalledWith({ ...item, progress: { attemptCount: 0, lastError: 'Missing Permissions' } }, 'classified_abandon');
        expect(logger.warn).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, decision: 'abandon', confidence: 0.97 }, 'Discarded classified outbox delivery failure');
        classified.stop();
    });

    test('uses the deterministic retry fallback when no classifier is configured', async () => {
        const item = makeItem();
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw Object.assign(new Error('Discord unavailable'), { status: 503 });
        });

        expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Discord unavailable', { retryable: true, nextAttemptAt: expect.any(String) });
        expect(outboxBackend.discard).not.toHaveBeenCalled();
    });

    test('classifies a numeric code rejection with exactly its message and code', async () => {
        const item = makeItem();
        const classify = mock(async () => ({ disposition: 'retry' as const, confidence: 0.83 }));
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw Object.assign(new Error('rate limited'), { code: 429 });
        });
        const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify } });

        expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
        expect(classify).toHaveBeenCalledWith({ message: 'rate limited', code: 429 });
        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'rate limited', { retryable: true, nextAttemptAt: expect.any(String) });
        classified.stop();
    });

    test('does not classify delivery errors without a numeric status or code', async () => {
        const item = makeItem();
        const classify = mock(async () => ({ disposition: 'abandon' as const, confidence: 1 }));
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new Error('connection reset');
        });
        const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify } });

        expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
        expect(classify).not.toHaveBeenCalled();
        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'connection reset', { retryable: true, nextAttemptAt: expect.any(String) });
        classified.stop();
    });

    test('logs a failed classified discard and still reports the delivery failure', async () => {
        const item = makeItem();
        const discardError = new Error('delete unavailable');
        const classify = mock(async () => ({ disposition: 'abandon' as const, confidence: 0.97 }));
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
            throw discardError;
        });
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw Object.assign(new Error('Missing Permissions'), { status: 403 });
        });
        const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify } });

        expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
        expect(logger.error).toHaveBeenCalledWith(
            { service: SERVICE, itemId: item.id, reason: 'classified_abandon', error: discardError },
            'Failed to discard classified outbox item'
        );
        classified.stop();
    });

    test('preserves the earliest pending retry from a batch', async () => {
        const early = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', progress: { attemptCount: 0 } });
        const late = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002', progress: { attemptCount: 8 } });
        outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [early, late]).mockImplementationOnce(async (): Promise<OutboxItem[]> => []);
        deliverFn.mockImplementation(async (): Promise<void> => {
            throw new Error('offline');
        });

        await drainer.drain(SERVICE);
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        await Promise.resolve();

        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
    });

    test('replaces a later retry timer with an earlier one and clears the old timer', async () => {
        const late = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', progress: { attemptCount: 8 } });
        const early = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002', progress: { attemptCount: 0 } });
        outboxBackend.dequeue
            .mockImplementationOnce(async (): Promise<OutboxItem[]> => [late, early])
            .mockImplementation(async (): Promise<OutboxItem[]> => []);
        deliverFn.mockImplementation(async (): Promise<void> => {
            throw new Error('offline');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });

        await retrying.drain(SERVICE);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(100);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        jest.advanceTimersByTime(25_500);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        retrying.stop();
    });

    test('keeps the pending retry timer when a later failure retries at the same instant', async () => {
        const first = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
        const second = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
        outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [first, second]);
        deliverFn.mockImplementation(async (): Promise<void> => {
            throw new Error('offline');
        });
        const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });
        const setTimeoutSpy = spyOn(globalThis, 'setTimeout');
        const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

        expect(await retrying.drain(SERVICE)).toEqual({ delivered: 0, failed: 2, discarded: 0, unacknowledged: 0 });
        expect(outboxBackend.markFailed).toHaveBeenNthCalledWith(1, first, 'offline', { retryable: true, nextAttemptAt: '1970-01-01T00:00:01.100Z' });
        expect(outboxBackend.markFailed).toHaveBeenNthCalledWith(2, second, 'offline', { retryable: true, nextAttemptAt: '1970-01-01T00:00:01.100Z' });
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 100);
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
        retrying.stop();
    });

    test('caps retry backoff at sixty seconds and schedules it from the injected clock', async () => {
        const item = makeItem({ progress: { attemptCount: 10 } });
        outboxBackend.dequeue
            .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
            .mockImplementationOnce(async (): Promise<OutboxItem[]> => []);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new Error('offline');
        });
        const retrying = createOutboxDrainer({ ...deps, maxAttempts: 12, now: () => 1000 });

        expect(await retrying.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'offline', { retryable: true, nextAttemptAt: '1970-01-01T00:01:01.000Z' });
        jest.advanceTimersByTime(59_999);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        retrying.stop();
    });

    test('treats an unready channel after registry check as a retryable delivery error', async () => {
        const item = makeItem();
        outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
        deliverFn.mockImplementationOnce(async (): Promise<void> => {
            throw new ChannelNotFoundByIdError(item.destination);
        });
        const result = await drainer.drain(SERVICE);
        expect(result.failed).toBe(1);
        expect(result.discarded).toBe(0);
        expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, expect.any(String), expect.objectContaining({ retryable: true, nextAttemptAt: expect.any(String) }));
    });

    describe('drain() — bounded attempts', () => {
        test('custom maximum terminates at its configured boundary', async () => {
            const custom = createOutboxDrainer({ ...deps, maxAttempts: 2 });
            const item = makeItem({ progress: { attemptCount: 1 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('offline');
            });
            expect(await custom.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'offline', { retryable: false });
            custom.stop();
        });

        test('eighth prior failure is still retryable on the ninth failed delivery', async () => {
            const item = makeItem({ progress: { attemptCount: 8 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });
            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Channel unavailable', expect.objectContaining({ retryable: true, nextAttemptAt: expect.any(String) }));
        });

        test('ninth prior failure is terminal on the tenth failed delivery', async () => {
            const item = makeItem({ progress: { attemptCount: 9 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });
            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Channel unavailable', { retryable: false });
        });

        test('schedules no retry timer after a terminal delivery failure', async () => {
            const item = makeItem({ progress: { attemptCount: 9 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Channel unavailable', { retryable: false });
            expect(jest.getTimerCount()).toBe(0);
        });

        test('already exhausted row is discarded without another send', async () => {
            const item = makeItem({ progress: { attemptCount: 10 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(deliverFn).not.toHaveBeenCalled();
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'permanent_error');
        });

        test('does not schedule a follow-up after a discard error in a full otherwise successful batch', async () => {
            const exhausted = makeItem({ progress: { attemptCount: 10 } });
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            const last = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [exhausted, next, last]);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delete unavailable');
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 2, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.discard).toHaveBeenCalledWith(exhausted, 'permanent_error');
            expect(deliverFn).toHaveBeenCalledTimes(2);
            // The only timer is the kept row's 30 s retry, not a continuation of the batch.
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledWith(exhausted, 'permanent_error', expect.any(String));
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
        });

        test('continues after exhausted-row discard failure and logs count', async () => {
            const item = makeItem({ progress: { attemptCount: 11 } });
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item, next]);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delete unavailable');
            });
            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 1, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: item.id, reason: 'permanent_error', attemptCount: 11 }),
                'Failed to discard outbox item'
            );
        });

        test('logs failed terminal persistence without rejecting or skipping later work', async () => {
            const item = makeItem({ progress: { attemptCount: 9 } });
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item, next]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });
            outboxBackend.markFailed.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delete unavailable');
            });
            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 1, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: item.id, reason: 'permanent_error', attemptCount: 10 }),
                'Failed to record outbox delivery failure'
            );
        });
    });

    describe('drain() — epoch skipping', () => {
        test('logs future-epoch discard failure and continues to later items', async () => {
            const futureItem = makeItem({ epoch: 2 });
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [futureItem, next]);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Delete unavailable');
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 1, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.acknowledgeDelivered).toHaveBeenCalledWith(next);
            expect(logger.error).toHaveBeenCalledWith(
                expect.objectContaining({ itemId: futureItem.id, reason: 'stale_epoch', attemptCount: 0 }),
                'Failed to discard outbox item'
            );
        });

        test('skips and deletes item with epoch greater than current epoch', async () => {
            registry.getEntry.mockImplementation(() => makeEntry(1));
            const futureItem = makeItem({ epoch: 2 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [futureItem]);

            const result = await drainer.drain(SERVICE);

            expect(result.discarded).toBe(1);
            expect(result.delivered).toBe(0);
            expect(deliverFn).not.toHaveBeenCalled();
            expect(outboxBackend.discard).toHaveBeenCalledWith(futureItem, 'stale_epoch');
        });

        test('does not skip item with epoch equal to current epoch', async () => {
            registry.getEntry.mockImplementation(() => makeEntry(1));
            const currentEpochItem = makeItem({ epoch: 1 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [currentEpochItem]);

            const result = await drainer.drain(SERVICE);

            expect(result.discarded).toBe(0);
            expect(result.delivered).toBe(1);
        });

        test('discards future-epoch item regardless of its attempt count', async () => {
            const futureItem = makeItem({ epoch: 5, progress: { attemptCount: 11 } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [futureItem]);
            await drainer.drain(SERVICE);
            expect(outboxBackend.discard).toHaveBeenCalledWith(futureItem, 'stale_epoch');
        });
    });

    describe('drain() — service goes offline mid-drain', () => {
        test('stops processing items when service goes offline between items', async () => {
            const item1 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' });
            const item2 = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item1, item2]);

            let callCount = 0;
            registry.isAvailable.mockImplementation((): boolean => {
                callCount += 1;
                // First call (top-level guard) = available; second call (inside loop) = offline
                return callCount === 1;
            });

            const result = await drainer.drain(SERVICE);

            // item1 skipped because the per-item check fires before delivery
            expect(result.delivered).toBe(0);
            expect(outboxBackend.acknowledgeDelivered).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ service: SERVICE }),
                'Service went offline mid-drain, stopping'
            );
        });
    });

    describe('drain() — scheduling another drain', () => {
        test('uses default batch size and interval before scheduling the next drain', async () => {
            const defaultDrainer = createOutboxDrainer({
                ...deps,
                batchSize:       undefined,
                drainIntervalMs: undefined,
            });
            const items = Array.from({ length: 10 }, (_, index) => makeItem({
                id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`,
            }));
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => items)
                .mockImplementation(async (): Promise<OutboxItem[]> => []);

            await defaultDrainer.drain(SERVICE);

            expect(outboxBackend.dequeue).toHaveBeenCalledWith(SERVICE, 10, expect.any(Function));
            expect(jest.getTimerCount()).toBe(1);

            jest.advanceTimersByTime(999);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            defaultDrainer.stop();
        });

        test('schedules another drain when batch is full', async () => {
            // batchSize is 3; return exactly 3 items
            const items = [
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' }),
            ];
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => items)
                .mockImplementation(async (): Promise<OutboxItem[]> => []);

            await drainer.drain(SERVICE);

            // Timer should have been scheduled
            expect(jest.getTimerCount()).toBe(1);

            // Advance timer so second drain runs
            jest.advanceTimersByTime(200);
            await Promise.resolve();

            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        });

        test('keeps the later backoff retry instead of an immediate follow-up after a full batch with a failure', async () => {
            const failing = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', progress: { attemptCount: 1 } });
            const next = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' });
            const last = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' });
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [failing, next, last])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('offline');
            });
            const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });

            expect(await retrying.drain(SERVICE)).toEqual({ delivered: 2, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(failing, 'offline', { retryable: true, nextAttemptAt: '1970-01-01T00:00:01.200Z' });
            jest.advanceTimersByTime(199);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            retrying.stop();
        });

        test('does NOT schedule another drain when batch is partial (less than batchSize)', async () => {
            const items = [
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
            ];
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);

            await drainer.drain(SERVICE);

            expect(jest.getTimerCount()).toBe(0);
        });

        test('does NOT schedule another drain when service is offline after batch', async () => {
            const items = [
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' }),
            ];
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);

            let callCount = 0;
            registry.isAvailable.mockImplementation((): boolean => {
                callCount += 1;
                // First (top-level guard) = available; inside-loop checks = available; post-loop check = offline
                return callCount <= 4;
            });

            await drainer.drain(SERVICE);

            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('drain() — requested discards and deferrals', () => {
        test('discards an item whose delivery requested it, without classifying or recording a failure', async () => {
            const item = makeItem();
            const classify = mock(async () => ({ disposition: 'retry' as const, confidence: 0.9 }));
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw Object.assign(new OutboxDiscardRequestedError('reply_target_deleted'), { code: 10_008 });
            });
            const classified = createOutboxDrainer({ ...deps, failureClassifier: { classify } });

            expect(await classified.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(outboxBackend.discard).toHaveBeenCalledTimes(1);
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'reply_target_deleted');
            expect(classify).not.toHaveBeenCalled();
            expect(outboxBackend.markFailed).not.toHaveBeenCalled();
            expect(outboxBackend.markUnknown).not.toHaveBeenCalled();
            expect(outboxBackend.acknowledgeDelivered).not.toHaveBeenCalled();
            classified.stop();
        });

        test('names the requested discard reason in its default error message', () => {
            const error = new OutboxDiscardRequestedError('reply_target_deleted');

            expect(error.message).toBe('Outbox item discard requested: reply_target_deleted');
            expect(error.name).toBe('OutboxDiscardRequestedError');
            expect(error.reason).toBe('reply_target_deleted');
            expect(new OutboxDiscardRequestedError('stale_epoch', 'custom').message).toBe('custom');
        });

        test('logs a failed requested discard and does not continue a full batch', async () => {
            const items = [makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' })];
            const failure = new Error('delete failed');
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw failure;
            });
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new OutboxDiscardRequestedError('reply_target_deleted');
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 2, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: items[0].id, reason: 'reply_target_deleted', error: failure }, 'Failed to discard outbox item');
            expect(jest.getTimerCount()).toBe(0);
        });

        test('defers an item for thirty seconds without counting it or spending an attempt', async () => {
            const item = makeItem();
            const classify = mock(async () => ({ disposition: 'abandon' as const, confidence: 0.9 }));
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new OutboxDeliveryDeferredError('Izzy not yet notified');
            });
            const deferring = createOutboxDrainer({ ...deps, failureClassifier: { classify }, now: () => 1000 });

            expect(await deferring.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.defer).toHaveBeenCalledWith(item, 'Izzy not yet notified', '1970-01-01T00:00:31.000Z');
            expect(outboxBackend.markFailed).not.toHaveBeenCalled();
            expect(outboxBackend.markUnknown).not.toHaveBeenCalled();
            expect(outboxBackend.discard).not.toHaveBeenCalled();
            expect(classify).not.toHaveBeenCalled();
            jest.advanceTimersByTime(OUTBOX_DEFERRED_RETRY_DELAY_MS - 1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            deferring.stop();
        });

        test('deferral has a default message and a thirty-second delay', () => {
            const error = new OutboxDeliveryDeferredError();

            expect(error.message).toBe('Outbox delivery deferred');
            expect(error.name).toBe('OutboxDeliveryDeferredError');
            expect(OUTBOX_DEFERRED_RETRY_DELAY_MS).toBe(30_000);
        });

        test('logs a failed deferral and still resolves the drain without continuing a full batch', async () => {
            const items = [makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' })];
            const failure = new Error('put failed');
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);
            outboxBackend.defer.mockImplementationOnce(async (): Promise<void> => {
                throw failure;
            });
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new OutboxDeliveryDeferredError();
            });

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 2, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: items[0].id, error: failure }, 'Failed to defer outbox item');
            expect(jest.getTimerCount()).toBe(0);
        });

        test('re-arms a deferred row\'s retry after a full-batch continuation displaced its timer', async () => {
            const items = [makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' })];
            let clock = 1000;
            outboxBackend.dequeue
                .mockImplementationOnce(async (_service: unknown, _limit: unknown, onDeferred: (at: string) => void): Promise<OutboxItem[]> => {
                    onDeferred('1970-01-01T00:00:31.000Z');
                    return items;
                })
                .mockImplementationOnce(async (_service: unknown, _limit: unknown, onDeferred: (at: string) => void): Promise<OutboxItem[]> => {
                    onDeferred('1970-01-01T00:00:31.000Z');
                    return [];
                })
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            const retrying = createOutboxDrainer({ ...deps, now: () => clock });

            expect(await retrying.drain(SERVICE)).toEqual({ delivered: 3, failed: 0, discarded: 0, unacknowledged: 0 });
            clock += 100;
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            expect(outboxBackend.dequeue).toHaveBeenNthCalledWith(2, SERVICE, 3, expect.any(Function));
            clock += 29_899;
            jest.advanceTimersByTime(29_899);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(3);
            retrying.stop();
        });

        test('re-arms immediately for a deferred row that is already due by the drainer clock', async () => {
            outboxBackend.dequeue
                .mockImplementationOnce(async (_service: unknown, _limit: unknown, onDeferred: (at: string) => void): Promise<OutboxItem[]> => {
                    onDeferred('1970-01-01T00:00:00.500Z');
                    return [];
                })
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            const retrying = createOutboxDrainer({ ...deps, now: () => 1000 });

            await retrying.drain(SERVICE);
            jest.advanceTimersByTime(0);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            retrying.stop();
        });
    });

    describe('drain() — requests during an active drain', () => {
        test('runs a deferred row\'s retry that fired mid-drain once the active drain settles', async () => {
            let clock = 1000;
            const gate = Promise.withResolvers<void>();
            deliverFn.mockImplementation((): Promise<void> => gate.promise);
            outboxBackend.dequeue
                .mockImplementationOnce(async (_service: unknown, _limit: unknown, onDeferred: (at: string) => void): Promise<OutboxItem[]> => {
                    onDeferred('1970-01-01T00:00:31.000Z');
                    return [makeItem()];
                })
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            const retrying = createOutboxDrainer({ ...deps, now: () => clock });

            const active = retrying.drain(SERVICE);
            await Promise.resolve();
            await Promise.resolve();
            expect(jest.getTimerCount()).toBe(1);
            clock += 30_000;
            jest.advanceTimersByTime(30_000);
            expect(jest.getTimerCount()).toBe(0);
            gate.resolve();
            expect(await active).toEqual({ delivered: 1, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(jest.getTimerCount()).toBe(1);
            jest.advanceTimersByTime(99);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            await Promise.resolve();
            await Promise.resolve();
            expect(jest.getTimerCount()).toBe(0);
            retrying.stop();
        });

        test('runs a drain requested mid-drain exactly once', async () => {
            const gate = Promise.withResolvers<void>();
            deliverFn.mockImplementation((): Promise<void> => gate.promise);
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [makeItem()])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);

            const active = drainer.drain(SERVICE);
            await Promise.resolve();
            await Promise.resolve();
            await drainer.drain(SERVICE);
            await drainer.drain(SERVICE);
            gate.resolve();
            await active;
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('does not run a mid-drain request once the drainer is stopped', async () => {
            const gate = Promise.withResolvers<void>();
            deliverFn.mockImplementation((): Promise<void> => gate.promise);
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [makeItem()]);

            const active = drainer.drain(SERVICE);
            await Promise.resolve();
            await Promise.resolve();
            await drainer.drain(SERVICE);
            drainer.stop();
            gate.resolve();
            await active;
            expect(jest.getTimerCount()).toBe(0);
        });

        test('does not run a drain after one that had no mid-drain request', async () => {
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [makeItem()]);

            await drainer.drain(SERVICE);
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('drain() — reporting discards', () => {
        const DEFERRED_AT = '1970-01-01T00:00:31.000Z';
        let reportDiscard: ReturnType<typeof mock>;
        let reporting: OutboxDrainer;

        function missingPermissions(): Error {
            return Object.assign(new Error('Missing Permissions'), { status: 403 });
        }

        beforeEach(() => {
            reportDiscard = mock((): boolean => true);
            reporting = createOutboxDrainer({
                ...deps,
                reportDiscard,
                now:               () => 1000,
                failureClassifier: { classify: mock(async () => ({ disposition: 'abandon' as const, confidence: 0.97 })) },
            });
        });

        afterEach(() => {
            reporting.stop();
        });

        test('reports an exhausted row with its unconfirmed outcome before discarding it', async () => {
            const item = makeItem({ progress: { attemptCount: 10, outcome: 'unknown', lastError: 'Discord delivery verification remains indeterminate' } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(item, 'permanent_error');
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'permanent_error');
            expect(reportDiscard.mock.invocationCallOrder[0]).toBeLessThan(outboxBackend.discard.mock.invocationCallOrder[0]);
            expect(deliverFn).not.toHaveBeenCalled();
        });

        test('reports a future-epoch row as stale without delivering it', async () => {
            const item = makeItem({ epoch: 2 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(item, 'stale_epoch');
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'stale_epoch');
            expect(deliverFn).not.toHaveBeenCalled();
        });

        test('reports a classified abandon with the outcome its delivery settled before discarding it', async () => {
            const item = makeItem({ progress: { attemptCount: 2, outcome: 'unknown', lastError: 'earlier' } });
            const rejected = { ...item, progress: { attemptCount: 2, outcome: 'retryable', lastError: 'Missing Permissions' } };
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (delivering: OutboxItem): Promise<void> => {
                // As the replay does once history shows the uncertain part was not posted.
                delivering.progress.outcome = 'retryable';
                throw missingPermissions();
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(rejected, 'classified_abandon');
            expect(outboxBackend.discard).toHaveBeenCalledWith(rejected, 'classified_abandon');
            expect(reportDiscard.mock.invocationCallOrder[0]).toBeLessThan(outboxBackend.discard.mock.invocationCallOrder[0]);
            expect(outboxBackend.markPendingDiscard).not.toHaveBeenCalled();
        });

        test('keeps an unknown outcome in a classified abandon report when delivery failed before checking history', async () => {
            const item = makeItem({ progress: { attemptCount: 2, outcome: 'unknown', lastError: 'earlier' } });
            const unconfirmed = { ...item, progress: { attemptCount: 2, outcome: 'unknown', lastError: 'Missing Permissions' } };
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw missingPermissions();
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(unconfirmed, 'classified_abandon');
            expect(outboxBackend.discard).toHaveBeenCalledWith(unconfirmed, 'classified_abandon');
        });

        test('reports a final failed attempt with its error and unsettled outcome before recording it as terminal', async () => {
            const item = makeItem({ progress: { attemptCount: 9, outcome: 'unknown' } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith({ ...item, progress: { attemptCount: 9, outcome: 'unknown', lastError: 'Channel unavailable' } }, 'permanent_error');
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Channel unavailable', { retryable: false });
            expect(reportDiscard.mock.invocationCallOrder[0]).toBeLessThan(outboxBackend.markFailed.mock.invocationCallOrder[0]);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('does not report a retryable failure, an unknown outcome or a delivery', async () => {
            const retrying = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', progress: { attemptCount: 8 } });
            const unknown = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002', progress: { attemptCount: 9 } });
            const delivered = makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [retrying, unknown, delivered]);
            deliverFn
                .mockImplementationOnce(async (): Promise<void> => {
                    throw new Error('offline');
                })
                .mockImplementationOnce(async (): Promise<void> => {
                    throw new OutboxVerificationPendingError();
                });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 1, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(reportDiscard).not.toHaveBeenCalled();
        });

        test('never reports a discard its delivery function requested, so reply_target_deleted is told once', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new OutboxDiscardRequestedError('reply_target_deleted');
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).not.toHaveBeenCalled();
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'reply_target_deleted');
        });

        test('keeps an exhausted row as a pending discard for thirty seconds while Izzy cannot be told', async () => {
            const item = makeItem({ progress: { attemptCount: 10, lastError: 'Missing Access' } });
            reportDiscard.mockImplementation((): boolean => false);
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledWith(item, 'permanent_error', DEFERRED_AT);
            expect(outboxBackend.discard).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, reason: 'permanent_error' }, 'Outbox discard waits until Izzy can be told');
            jest.advanceTimersByTime(OUTBOX_DEFERRED_RETRY_DELAY_MS - 1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        });

        test('keeps a classified abandon Izzy cannot be told about as a pending discard with its Discord error', async () => {
            const item = makeItem();
            reportDiscard.mockImplementation((): boolean => false);
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw missingPermissions();
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledWith({ ...item, progress: { attemptCount: 0, lastError: 'Missing Permissions' } }, 'classified_abandon', DEFERRED_AT);
            expect(outboxBackend.discard).not.toHaveBeenCalled();
            expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'Discarded classified outbox delivery failure');
        });

        test('keeps a final failure Izzy cannot be told about as an exhausted marker for thirty seconds', async () => {
            const item = makeItem({ progress: { attemptCount: 9 } });
            reportDiscard.mockImplementation((): boolean => false);
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('Channel unavailable');
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'Channel unavailable', { retryable: true, nextAttemptAt: DEFERRED_AT });
            jest.advanceTimersByTime(OUTBOX_DEFERRED_RETRY_DELAY_MS - 1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        });

        test('logs a failed pending-discard write and does not continue a full batch', async () => {
            const items = [makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001', epoch: 2 }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }), makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' })];
            const failure = new Error('put failed');
            reportDiscard.mockImplementationOnce((): boolean => false);
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => items);
            outboxBackend.markPendingDiscard.mockImplementationOnce(async (): Promise<void> => {
                throw failure;
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 2, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: items[0].id, reason: 'stale_epoch', attemptCount: 0, error: failure }, 'Failed to discard outbox item');
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('waits to persist a decided discard after delete fails before completing the drain', async () => {
            const item = makeItem({ epoch: 2 });
            outboxBackend.dequeue.mockImplementationOnce(async (): Promise<OutboxItem[]> => [item]).mockImplementation(async (): Promise<OutboxItem[]> => []);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('delete unavailable');
            });
            let release!: () => void;
            outboxBackend.markPendingDiscard.mockImplementation(() => new Promise<void>((resolve) => {
                release = resolve;
            }));
            let settled = false;
            const pending = reporting.drain(SERVICE).finally(() => {
                settled = true;
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledTimes(1);
            expect(settled).toBe(false);
            release();
            await pending;
            expect(settled).toBe(true);
        });

        test('keeps a stale-epoch row whose delete failed after Izzy was told, so a later epoch never resends it', async () => {
            const item = makeItem({ epoch: 2 });
            const discardError = new Error('delete unavailable');
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw discardError;
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(item, 'stale_epoch');
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledWith(item, 'stale_epoch', DEFERRED_AT);
            expect(outboxBackend.discard.mock.invocationCallOrder[0]).toBeLessThan(outboxBackend.markPendingDiscard.mock.invocationCallOrder[0]);
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, reason: 'stale_epoch', attemptCount: 0, error: discardError }, 'Failed to discard outbox item');
            expect(deliverFn).not.toHaveBeenCalled();
            jest.advanceTimersByTime(OUTBOX_DEFERRED_RETRY_DELAY_MS - 1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        });

        test('reports and discards a pending discard with its recorded reason without delivering it', async () => {
            const item = makeItem({ progress: { attemptCount: 0, pendingDiscard: 'classified_abandon' } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(item, 'classified_abandon');
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'classified_abandon');
            expect(deliverFn).not.toHaveBeenCalled();
        });

        test('a recorded pending discard reason takes precedence over a stale epoch and exhausted attempts', async () => {
            const item = makeItem({ epoch: 5, progress: { attemptCount: 11, pendingDiscard: 'classified_abandon' } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            await reporting.drain(SERVICE);

            expect(reportDiscard).toHaveBeenCalledWith(item, 'classified_abandon');
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'classified_abandon');
        });

        test('discards a pending discard without delivering it when no reporter is configured', async () => {
            const item = makeItem({ progress: { attemptCount: 0, pendingDiscard: 'stale_epoch' } });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            expect(await drainer.drain(SERVICE)).toEqual({ delivered: 0, failed: 0, discarded: 1, unacknowledged: 0 });
            expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'stale_epoch');
            expect(deliverFn).not.toHaveBeenCalled();
        });

        test('keeps a classified abandon whose delete failed after Izzy was told, so it is never resent', async () => {
            const item = makeItem();
            const discardError = new Error('delete unavailable');
            const rejected = { ...item, progress: { attemptCount: 0, lastError: 'Missing Permissions' } };
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => [item])
                .mockImplementation(async (): Promise<OutboxItem[]> => []);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw discardError;
            });
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw missingPermissions();
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(reportDiscard).toHaveBeenCalledWith(rejected, 'classified_abandon');
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, reason: 'classified_abandon', error: discardError }, 'Failed to discard classified outbox item');
            expect(outboxBackend.markPendingDiscard).toHaveBeenCalledWith(rejected, 'classified_abandon', DEFERRED_AT);
            jest.advanceTimersByTime(OUTBOX_DEFERRED_RETRY_DELAY_MS - 1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(2);
        });

        test('logs when a classified abandon can neither be deleted nor kept from being resent', async () => {
            const item = makeItem();
            const markError = new Error('put unavailable');
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            outboxBackend.discard.mockImplementationOnce(async (): Promise<void> => {
                throw new Error('delete unavailable');
            });
            outboxBackend.markPendingDiscard.mockImplementationOnce(async (): Promise<void> => {
                throw markError;
            });
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw missingPermissions();
            });

            expect(await reporting.drain(SERVICE)).toEqual({ delivered: 0, failed: 1, discarded: 0, unacknowledged: 0 });
            expect(logger.error).toHaveBeenCalledWith({ service: SERVICE, itemId: item.id, reason: 'classified_abandon', error: markError }, 'Failed to keep discarded outbox item from being resent');
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('stop()', () => {
        test('prevents further drains after stop()', async () => {
            drainer.stop();

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, discarded: 0, unacknowledged: 0 });
            expect(outboxBackend.dequeue).not.toHaveBeenCalled();
        });

        test('clears a pending timer when stop() is called', async () => {
            // Fill the batch to trigger a scheduled drain
            const items = [
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000001' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000002' }),
                makeItem({ id: 'aaaaaaaa-0000-4000-8000-000000000003' }),
            ];
            outboxBackend.dequeue
                .mockImplementationOnce(async (): Promise<OutboxItem[]> => items)
                .mockImplementation(async (): Promise<OutboxItem[]> => []);

            await drainer.drain(SERVICE);
            expect(jest.getTimerCount()).toBe(1);

            drainer.stop();
            expect(jest.getTimerCount()).toBe(0);

            // Ensure dequeue was only called once (stop prevented the scheduled second drain)
            jest.advanceTimersByTime(500);
            await Promise.resolve();
            expect(outboxBackend.dequeue).toHaveBeenCalledTimes(1);
        });

        test('stop() is safe to call when no timer is pending', () => {
            // Should not throw
            expect(() => drainer.stop()).not.toThrow();
        });
    });
});
