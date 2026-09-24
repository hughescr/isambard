import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { createChannelId } from '@/agent/types';
import { ChannelNotFoundByIdError } from '@/errors';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import type { OutboxBackend } from '@/services/outbox/backend';
import { createOutboxDrainer, OutboxVerificationPendingError, type OutboxDrainerDeps, type OutboxDrainer } from '@/services/outbox/drainer';
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
        expect(outboxBackend.discard).toHaveBeenCalledWith(item, 'classified_abandon');
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
            expect(jest.getTimerCount()).toBe(0);
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

            expect(outboxBackend.dequeue).toHaveBeenCalledWith(SERVICE, 10);
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
