import { describe, test, expect, beforeEach, mock } from 'bun:test';
import padStart from 'lodash/padStart';
import { type ContextBuilder, type RecentEventsResult  } from '../../../src/agent/context-builder';
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

// Helper to create a RecentEventsResult
function eventsResult(items: MemoryToolItemData[], isFallback = false): RecentEventsResult {
    return { items, isFallback };
}

describe.concurrent('EventDeltaTracker', () => {
    let mockContextBuilder: ContextBuilder;

    beforeEach(() => {
        // Create a minimal mock ContextBuilder with just the methods we need
        mockContextBuilder = {
            loadRecentEvents: mock(async (): Promise<RecentEventsResult> => eventsResult([])),
        } as unknown as ContextBuilder;
    });

    describe('initial state', () => {
        test('should return empty array before markStart is called', async () => {
            const tracker = new EventDeltaTracker(mockContextBuilder);

            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toEqual([]);
        });
    });

    describe('markStart', () => {
        test('should capture current event count', async () => {
            const existingItems = [
                createMockEventItem('/events/2025-01-15/interaction_abc', '2025-01-15T10:00:00.000Z', 'User asked about X'),
                createMockEventItem('/events/2025-01-15/interaction_def', '2025-01-15T11:00:00.000Z', 'User asked about Y'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(existingItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // After markStart, getNewEvents should return empty (no new events yet)
            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should handle case when no events exist at start', async () => {
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult([]));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should be callable multiple times (resets the marker)', async () => {
            // First call: 2 events exist
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:00.000Z', 'First event'),
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T11:00:00.000Z', 'Second event'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Simulate new events being added (3 events total now)
            const updatedItems = [
                ...initialItems,
                createMockEventItem('/events/2025-01-15/event3', '2025-01-15T11:30:00.000Z', 'Third event'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(updatedItems));

            // Before second markStart, should show 1 new event
            let newEvents = await tracker.getNewEvents();
            expect(newEvents).toHaveLength(1);
            expect(newEvents[0]).toContain('/events/2025-01-15/event3');
            expect(newEvents[0]).toContain('Third event');

            // Call markStart again (resets to current 3 events)
            await tracker.markStart();

            // After reset, no new events
            newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });
    });

    describe('getNewEvents', () => {
        test('should return empty array when no new events after markStart', async () => {
            const existingItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:00.000Z', 'Event 1'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(existingItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // No new events added, loadRecentEvents still returns same events
            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should return new events added after markStart', async () => {
            // Start with 2 events
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T09:00:00.000Z', 'First event'),
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T10:00:00.000Z', 'Second event'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Now simulate 2 new events being added
            const updatedItems = [
                ...initialItems,
                createMockEventItem('/events/2025-01-15/event3', '2025-01-15T11:00:00.000Z', 'Third event'),
                createMockEventItem('/events/2025-01-15/event4', '2025-01-15T11:30:00.000Z', 'Fourth event'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(updatedItems));

            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toHaveLength(2);
            expect(newEvents[0]).toContain('/events/2025-01-15/event3');
            expect(newEvents[0]).toContain('Third event');
            expect(newEvents[1]).toContain('/events/2025-01-15/event4');
            expect(newEvents[1]).toContain('Fourth event');
        });

        test('should be idempotent (multiple calls return same count of results)', async () => {
            // Start with 1 event
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:00.000Z', 'First event'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Add a new event
            const updatedItems = [
                ...initialItems,
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T11:00:00.000Z', 'Second event'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(updatedItems));

            // Call getNewEvents multiple times
            const firstCall = await tracker.getNewEvents();
            const secondCall = await tracker.getNewEvents();
            const thirdCall = await tracker.getNewEvents();

            // All calls should return same number of results
            expect(firstCall).toHaveLength(1);
            expect(secondCall).toHaveLength(1);
            expect(thirdCall).toHaveLength(1);
            // All should contain the new event
            expect(firstCall[0]).toContain('/events/2025-01-15/event2');
            expect(secondCall[0]).toContain('/events/2025-01-15/event2');
            expect(thirdCall[0]).toContain('/events/2025-01-15/event2');
        });

        test('should handle events being added at the end (sorted oldest-first)', async () => {
            // Start with events from today
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:00.000Z', 'Recent event'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // New events added at end (sorted oldest-first by context-builder)
            const updatedItems = [
                ...initialItems,
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T11:00:00.000Z', 'Newer event'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(updatedItems));

            const newEvents = await tracker.getNewEvents();

            // New events should be at the end
            expect(newEvents).toHaveLength(1);
            expect(newEvents[0]).toContain('/events/2025-01-15/event2');
            expect(newEvents[0]).toContain('Newer event');
        });

        test('should handle limit of 50 events in loadRecentEvents', async () => {
            // Generate 48 initial events
            const initialItems = Array.from({ length: 48 }, (_elem, i) =>
                createMockEventItem(`/events/2025-01-15/event${i}`, `2025-01-15T${padStart(String(i), 2, '0')}:00:00.000Z`, `Event ${i}`)
            );
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Add 5 more events (total 53, but limit is 50 so oldest 3 are dropped)
            const newItems = Array.from({ length: 50 }, (_elem, i) =>
                createMockEventItem(`/events/2025-01-15/event${i + 3}`, `2025-01-15T${padStart(String(i + 3), 2, '0')}:00:00.000Z`, `Event ${i + 3}`)
            );
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(newItems));

            const newEvents = await tracker.getNewEvents();

            // Should return last 2 events (50 - 48 = 2)
            expect(newEvents.length).toBe(2);
        });
    });

    describe('edge cases', () => {
        test('should handle events being removed (count decreases)', async () => {
            // Start with 3 events
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T09:00:00.000Z', 'First'),
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T10:00:00.000Z', 'Second'),
                createMockEventItem('/events/2025-01-15/event3', '2025-01-15T11:00:00.000Z', 'Third'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Events are removed/expired (only 1 remains)
            const reducedItems = [
                createMockEventItem('/events/2025-01-15/event3', '2025-01-15T11:00:00.000Z', 'Third'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(reducedItems));

            const newEvents = await tracker.getNewEvents();

            // When count decreases, slice returns empty array (no new events)
            expect(newEvents).toEqual([]);
        });

        test('should call loadRecentEvents with limit of 50', async () => {
            const mockLoad = mock(async (): Promise<RecentEventsResult> => eventsResult([]));
            mockContextBuilder.loadRecentEvents = mockLoad;

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Verify markStart calls with default limit
            expect(mockLoad).toHaveBeenCalledWith(50);

            mockLoad.mockClear();
            await tracker.getNewEvents();

            // Verify getNewEvents also calls with limit of 50
            expect(mockLoad).toHaveBeenCalledWith(50);
        });

        test('should format new events using formatMemoryPreview', async () => {
            const initialItems = [
                createMockEventItem('/events/2025-01-15/event1', '2025-01-15T10:00:00.000Z', 'First event'),
            ];
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(initialItems));

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Add a new event with long content
            const updatedItems = [
                ...initialItems,
                createMockEventItem('/events/2025-01-15/event2', '2025-01-15T11:00:00.000Z', 'New event with some content'),
            ];
            // eslint-disable-next-line require-atomic-updates -- test mock setup: single-threaded, no concurrent access
            mockContextBuilder.loadRecentEvents = mock(async (): Promise<RecentEventsResult> => eventsResult(updatedItems));

            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toHaveLength(1);
            // Should be formatted by formatMemoryPreview: "- path (age): content"
            expect(newEvents[0]).toMatch(/^- \/events\/2025-01-15\/event2 \(.+\): New event with some content$/);
        });
    });
});
