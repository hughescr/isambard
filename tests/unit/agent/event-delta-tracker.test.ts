import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { type ContextBuilder } from '../../../src/agent/context-builder';
import { EventDeltaTracker } from '../../../src/agent/event-delta-tracker';
import { createMemoryPath, type MemoryToolItemData  } from '../../../src/storage/memory-tool/types';

// Helper to create mock event items
function createMockEventItem(path: string, updatedAt: string, content: string): MemoryToolItemData {
    return {
        path:        createMemoryPath(path),
        content,
        contentType: 'text/markdown' as const,
        metadata:    {},
        createdAt:   updatedAt,
        updatedAt,
    };
}

// Fixed reference time for deterministic tests
const T0 = new Date('2025-01-15T10:00:00.000Z');

// Tests use fake timers to control Date.now() deterministically.
// describe.concurrent is intentionally NOT used here because jest.useFakeTimers()
// is global state and must be isolated per-test in serial execution.
// Note: in Bun, jest.advanceTimersByTime() only fires timer callbacks and does NOT
// advance Date.now(). Use jest.setSystemTime() to update the clock between calls.
describe('EventDeltaTracker', () => {
    let mockContextBuilder: ContextBuilder;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(T0);

        mockContextBuilder = {
            loadRecentEventsSince: mock(async (): Promise<MemoryToolItemData[]> => []),
        } as unknown as ContextBuilder;
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('initial state', () => {
        test('should return empty array before markStart is called', async () => {
            const tracker = new EventDeltaTracker(mockContextBuilder);

            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toEqual([]);
        });

        test('should NOT call any contextBuilder methods before markStart', async () => {
            const loadSince = mock(async (): Promise<MemoryToolItemData[]> => []);
            mockContextBuilder.loadRecentEventsSince = loadSince;

            const tracker = new EventDeltaTracker(mockContextBuilder);

            // getNewEvents before markStart must be a pure no-op
            await tracker.getNewEvents();

            expect(loadSince).not.toHaveBeenCalled();
        });
    });

    describe('markStart', () => {
        test('should capture timestamp without calling any contextBuilder methods (no DB I/O)', () => {
            const loadSince = mock(async (): Promise<MemoryToolItemData[]> => []);
            mockContextBuilder.loadRecentEventsSince = loadSince;

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            // markStart is a pure in-memory operation — no DB calls
            expect(loadSince).not.toHaveBeenCalled();
        });

        test('should handle case when no events exist after markStart', async () => {
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => []);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should be callable multiple times (resets the timestamp)', async () => {
            const twoNewItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:05.000Z', 'Event 1'),
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T10:00:10.000Z', 'Event 2'),
            ];
            const threeNewItems = [
                ...twoNewItems,
                createMockEventItem('/events/2025-01-15/event3', '2025-01-15T10:00:15.000Z', 'Event 3'),
            ];

            // First markStart at T0 = 10:00:00 UTC
            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            // Advance clock to T0+5s; mock returns 2 events
            jest.setSystemTime(new Date(T0.getTime() + 5000));
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => twoNewItems);

            let newEvents = await tracker.getNewEvents();
            expect(newEvents).toHaveLength(2);

            // Second markStart at T0+5s — resets the start time to now
            tracker.markStart();

            // Advance clock to T0+15s; mock returns 3 events after new start
            jest.setSystemTime(new Date(T0.getTime() + 15_000));
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => threeNewItems);

            newEvents = await tracker.getNewEvents();
            expect(newEvents).toHaveLength(3);
        });
    });

    describe('getNewEvents', () => {
        test('should return empty array when loadRecentEventsSince returns no items', async () => {
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => []);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should return events from loadRecentEventsSince as formatted strings', async () => {
            const newItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:03.000Z', 'Third event'),
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T10:00:06.000Z', 'Fourth event'),
            ];
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => newItems);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            jest.setSystemTime(new Date(T0.getTime() + 10_000));
            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toHaveLength(2);
            expect(newEvents[0]).toContain('/events/2025-01-15/event1');
            expect(newEvents[0]).toContain('Third event');
            expect(newEvents[1]).toContain('/events/2025-01-15/event2');
            expect(newEvents[1]).toContain('Fourth event');
        });

        test('should call loadRecentEventsSince with exact windowMs and limit 50', async () => {
            const loadSince = mock(async (): Promise<MemoryToolItemData[]> => []);
            mockContextBuilder.loadRecentEventsSince = loadSince;

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart(); // T0 = 10:00:00

            // Advance clock by exactly 3000ms
            jest.setSystemTime(new Date(T0.getTime() + 3000));
            await tracker.getNewEvents();

            expect(loadSince).toHaveBeenCalledTimes(1);
            const [windowMs, limit] = loadSince.mock.calls[0] as unknown as [number, number];
            expect(windowMs).toBe(3000);
            expect(limit).toBe(50);
        });

        test('should be idempotent (multiple calls each query independently)', async () => {
            const eventItem = createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:01.000Z', 'New event');
            const loadSince = mock(async (): Promise<MemoryToolItemData[]> => [eventItem]);
            mockContextBuilder.loadRecentEventsSince = loadSince;

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            jest.setSystemTime(new Date(T0.getTime() + 5000));

            const firstCall = await tracker.getNewEvents();
            const secondCall = await tracker.getNewEvents();
            const thirdCall = await tracker.getNewEvents();

            expect(firstCall).toHaveLength(1);
            expect(secondCall).toHaveLength(1);
            expect(thirdCall).toHaveLength(1);
            expect(loadSince).toHaveBeenCalledTimes(3);
        });

        test('should format new events using formatMemoryPreview', async () => {
            const eventItem = createMockEventItem('/events/2025-01-15/event2', '2025-01-15T10:00:02.000Z', 'New event with some content');
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => [eventItem]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            jest.setSystemTime(new Date(T0.getTime() + 5000));
            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toHaveLength(1);
            // Should be formatted by formatMemoryPreview: "- path (age): content"
            expect(newEvents[0]).toMatch(/^- \/events\/2025-01-15\/event2 \(.+\): New event with some content$/);
        });
    });

    describe('edge cases', () => {
        test('NEW: events layer has >50 items at markStart — new events still returned (was silently empty before)', async () => {
            // The old count-based approach: startEventCount=50, slice(50) → []
            // The new timestamp-based approach: loadRecentEventsSince returns only post-markStart items
            const newItemsAfterStart = [
                createMockEventItem('/events/2025-01-15/event51', '2025-01-15T10:00:05.000Z', 'New event A'),
                createMockEventItem('/events/2025-01-15/event52', '2025-01-15T10:00:10.000Z', 'New event B'),
                createMockEventItem('/events/2025-01-15/event53', '2025-01-15T10:00:15.000Z', 'New event C'),
            ];
            // loadRecentEventsSince is called with a small windowMs (seconds since markStart)
            // and returns only items created after the start time — not all 50+ existing items
            mockContextBuilder.loadRecentEventsSince = mock(async (): Promise<MemoryToolItemData[]> => newItemsAfterStart);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart(); // Captures T0 in memory — no DB call

            jest.setSystemTime(new Date(T0.getTime() + 20_000));
            const newEvents = await tracker.getNewEvents();

            // With timestamp-based tracking, the 3 new events are correctly returned
            expect(newEvents).toHaveLength(3);
            expect(newEvents[0]).toContain('New event A');
            expect(newEvents[1]).toContain('New event B');
            expect(newEvents[2]).toContain('New event C');
        });

        test('windowMs passed to loadRecentEventsSince is exact with fake timers', async () => {
            const loadSince = mock(async (): Promise<MemoryToolItemData[]> => []);
            mockContextBuilder.loadRecentEventsSince = loadSince;

            // Start at T0 = 10:00:00 UTC
            const tracker = new EventDeltaTracker(mockContextBuilder);
            tracker.markStart();

            // Advance exactly 7500ms
            jest.setSystemTime(new Date(T0.getTime() + 7500));
            await tracker.getNewEvents();

            const [windowMs] = loadSince.mock.calls[0] as unknown as [number, number];
            expect(windowMs).toBe(7500);
        });
    });
});
