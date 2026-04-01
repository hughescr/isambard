import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import type { OutboxBackend } from '@/services/outbox/backend';
import { createOutboxDrainer, type OutboxDrainerDeps, type OutboxDrainer } from '@/services/outbox/drainer';
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
        destination: 'channel-123',
        payload:     { text: 'Hello' },
        priority:    'medium',
        dedupeKey:   'dedup-abc',
        progress:    {},
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
        dequeue:    ReturnType<typeof mock>
        markSent:   ReturnType<typeof mock>
        markFailed: ReturnType<typeof mock>
    };
    let registry: {
        isAvailable: ReturnType<typeof mock>
        getEntry:    ReturnType<typeof mock>
    };
    let deliverFn: ReturnType<typeof mock>;
    let logger: {
        warn:  ReturnType<typeof mock>
        error: ReturnType<typeof mock>
        info:  ReturnType<typeof mock>
    };
    let drainer: OutboxDrainer;

    beforeEach(() => {
        jest.useFakeTimers();
        outboxBackend = {
            dequeue:    mock(async (): Promise<OutboxItem[]> => []),
            markSent:   mock(async (): Promise<void> => undefined),
            markFailed: mock(async (): Promise<void> => undefined),
        };
        registry = {
            isAvailable: mock((): boolean => true),
            getEntry:    mock(() => makeEntry(1)),
        };
        deliverFn = mock(async (): Promise<void> => undefined);
        logger    = {
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

    describe('drain() — stopped guard', () => {
        test('returns zero result immediately when stop() was called before drain()', async () => {
            drainer.stop();

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, skipped: 0 });
            expect(outboxBackend.dequeue).not.toHaveBeenCalled();
        });
    });

    describe('drain() — service unavailability', () => {
        test('returns zero result when service is not available', async () => {
            registry.isAvailable.mockImplementation((): boolean => false);

            const result = await drainer.drain(SERVICE);

            expect(result).toEqual({ delivered: 0, failed: 0, skipped: 0 });
            expect(outboxBackend.dequeue).not.toHaveBeenCalled();
        });
    });

    describe('drain() — successful delivery', () => {
        test('delivers items and marks them sent', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);

            const result = await drainer.drain(SERVICE);

            expect(result.delivered).toBe(1);
            expect(result.failed).toBe(0);
            expect(deliverFn).toHaveBeenCalledWith(item);
            expect(outboxBackend.markSent).toHaveBeenCalledWith(item);
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
            expect(outboxBackend.markSent).toHaveBeenCalledTimes(2);
        });
    });

    describe('drain() — delivery failure', () => {
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
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item1, 'Network error');
            expect(outboxBackend.markSent).toHaveBeenCalledWith(item2);
        });

        test('marks item failed when deliverFn throws a non-Error value', async () => {
            const item = makeItem();
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [item]);
            deliverFn.mockImplementationOnce(async (): Promise<void> => {
                throw { message: 'ignored', toString: () => 'plain string error' };
            });

            const result = await drainer.drain(SERVICE);

            expect(result.failed).toBe(1);
            expect(outboxBackend.markFailed).toHaveBeenCalledWith(item, 'plain string error');
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
                expect.any(String)
            );
        });
    });

    describe('drain() — epoch skipping', () => {
        test('skips and deletes item with epoch greater than current epoch', async () => {
            registry.getEntry.mockImplementation(() => makeEntry(1));
            const futureItem = makeItem({ epoch: 2 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [futureItem]);

            const result = await drainer.drain(SERVICE);

            expect(result.skipped).toBe(1);
            expect(result.delivered).toBe(0);
            expect(deliverFn).not.toHaveBeenCalled();
            // Future-epoch items are deleted (markSent) so they don't accumulate
            expect(outboxBackend.markSent).toHaveBeenCalledWith(futureItem);
        });

        test('does not skip item with epoch equal to current epoch', async () => {
            registry.getEntry.mockImplementation(() => makeEntry(1));
            const currentEpochItem = makeItem({ epoch: 1 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [currentEpochItem]);

            const result = await drainer.drain(SERVICE);

            expect(result.skipped).toBe(0);
            expect(result.delivered).toBe(1);
        });

        test('logs warning when skipping future-epoch item', async () => {
            registry.getEntry.mockImplementation(() => makeEntry(1));
            const futureItem = makeItem({ epoch: 5 });
            outboxBackend.dequeue.mockImplementation(async (): Promise<OutboxItem[]> => [futureItem]);

            await drainer.drain(SERVICE);

            expect(logger.warn).toHaveBeenCalledWith(
                expect.objectContaining({ service: SERVICE, itemId: futureItem.id }),
                expect.any(String)
            );
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
            expect(outboxBackend.markSent).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(
                expect.objectContaining({ service: SERVICE }),
                expect.any(String)
            );
        });
    });

    describe('drain() — scheduling another drain', () => {
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

            expect(result).toEqual({ delivered: 0, failed: 0, skipped: 0 });
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
