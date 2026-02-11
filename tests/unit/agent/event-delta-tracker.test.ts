import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventDeltaTracker } from '../../../src/agent/event-delta-tracker';
import type { ContextBuilder } from '../../../src/agent/context-builder';

describe.concurrent('EventDeltaTracker', () => {
    let mockContextBuilder: ContextBuilder;

    beforeEach(() => {
        // Create a minimal mock ContextBuilder with just the methods we need
        mockContextBuilder = {
            loadRecentEvents: mock(async () => []),
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
            const existingEvents = [
                '- /events/2025-01-15/interaction_abc (2h ago): User asked about X...',
                '- /events/2025-01-15/interaction_def (1h ago): User asked about Y...',
            ];
            mockContextBuilder.loadRecentEvents = mock(async () => existingEvents);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // After markStart, getNewEvents should return empty (no new events yet)
            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should handle case when no events exist at start', async () => {
            mockContextBuilder.loadRecentEvents = mock(async () => []);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should be callable multiple times (resets the marker)', async () => {
            // First call: 2 events exist
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): First event',
                '- /events/2025-01-15/event2 (1h ago): Second event',
            ]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Simulate new events being added (3 events total now)
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): First event',
                '- /events/2025-01-15/event2 (1h ago): Second event',
                '- /events/2025-01-15/event3 (30m ago): Third event',
            ]);

            // Before second markStart, should show 1 new event
            let newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([
                '- /events/2025-01-15/event3 (30m ago): Third event',
            ]);

            // Call markStart again (resets to current 3 events)
            await tracker.markStart();

            // After reset, no new events
            newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });
    });

    describe('getNewEvents', () => {
        test('should return empty array when no new events after markStart', async () => {
            const existingEvents = [
                '- /events/2025-01-15/event1 (2h ago): Event 1',
            ];
            mockContextBuilder.loadRecentEvents = mock(async () => existingEvents);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // No new events added, loadRecentEvents still returns same events
            const newEvents = await tracker.getNewEvents();
            expect(newEvents).toEqual([]);
        });

        test('should return new events added after markStart', async () => {
            // Start with 2 events
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (3h ago): First event',
                '- /events/2025-01-15/event2 (2h ago): Second event',
            ]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Now simulate 2 new events being added
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (3h ago): First event',
                '- /events/2025-01-15/event2 (2h ago): Second event',
                '- /events/2025-01-15/event3 (1h ago): Third event',
                '- /events/2025-01-15/event4 (30m ago): Fourth event',
            ]);

            const newEvents = await tracker.getNewEvents();

            expect(newEvents).toEqual([
                '- /events/2025-01-15/event3 (1h ago): Third event',
                '- /events/2025-01-15/event4 (30m ago): Fourth event',
            ]);
        });

        test('should be idempotent (multiple calls return same results)', async () => {
            // Start with 1 event
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): First event',
            ]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Add a new event
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): First event',
                '- /events/2025-01-15/event2 (1h ago): Second event',
            ]);

            // Call getNewEvents multiple times
            const firstCall = await tracker.getNewEvents();
            const secondCall = await tracker.getNewEvents();
            const thirdCall = await tracker.getNewEvents();

            // All calls should return the same result
            expect(firstCall).toEqual([
                '- /events/2025-01-15/event2 (1h ago): Second event',
            ]);
            expect(secondCall).toEqual(firstCall);
            expect(thirdCall).toEqual(firstCall);
        });

        test('should handle events being added at the start of the array (sorted oldest-first)', async () => {
            // Start with events from today
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): Recent event',
            ]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Simulate older events being loaded (they appear at the beginning)
            // But since events are sorted oldest-first by context-builder,
            // new events always appear at the END
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (2h ago): Recent event',
                '- /events/2025-01-15/event2 (1h ago): Newer event',
            ]);

            const newEvents = await tracker.getNewEvents();

            // New events should be at the end (since sorted oldest-first)
            expect(newEvents).toEqual([
                '- /events/2025-01-15/event2 (1h ago): Newer event',
            ]);
        });

        test('should handle limit of 50 events in loadRecentEvents', async () => {
            // Generate 48 initial events
            const initialEvents = Array.from({ length: 48 }, (_, i) =>
                `- /events/2025-01-15/event${i} (${48 - i}h ago): Event ${i}`
            );
            mockContextBuilder.loadRecentEvents = mock(async () => initialEvents);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Add 5 more events (total 53, but limit is 50 so oldest 3 are dropped)
            const newEventsList = Array.from({ length: 50 }, (_, i) =>
                `- /events/2025-01-15/event${i + 3} (${50 - i}h ago): Event ${i + 3}`
            );
            mockContextBuilder.loadRecentEvents = mock(async () => newEventsList);

            const newEvents = await tracker.getNewEvents();

            // Should return last 2 events (50 - 48 = 2)
            expect(newEvents.length).toBe(2);
            expect(newEvents[0]).toContain('event51');
            expect(newEvents[1]).toContain('event52');
        });
    });

    describe('edge cases', () => {
        test('should handle events being removed (count decreases)', async () => {
            // Start with 3 events
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event1 (3h ago): First',
                '- /events/2025-01-15/event2 (2h ago): Second',
                '- /events/2025-01-15/event3 (1h ago): Third',
            ]);

            const tracker = new EventDeltaTracker(mockContextBuilder);
            await tracker.markStart();

            // Events are removed/expired (only 1 remains)
            mockContextBuilder.loadRecentEvents = mock(async () => [
                '- /events/2025-01-15/event3 (1h ago): Third',
            ]);

            const newEvents = await tracker.getNewEvents();

            // When count decreases, slice returns empty array (no new events)
            expect(newEvents).toEqual([]);
        });

        test('should call loadRecentEvents with limit of 50', async () => {
            const mockLoad = mock(async () => []);
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
    });
});
