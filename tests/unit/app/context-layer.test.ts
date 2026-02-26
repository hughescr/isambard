import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockLogger } from '../../setup';
import type { ContextBuilder } from '@/agent/context-builder';
import type { EventDeltaTracker } from '@/agent/event-delta-tracker';
import type { MemoryToolBackend } from '@/storage/memory-tool';

describe('createContextLayer', () => {
    let spies: ReturnType<typeof spyOn>[];
    const mockMemoryBackend = {} as MemoryToolBackend;

    beforeEach(() => {
        spies = [];
        mockLogger.warn.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
    });

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
    });

    test('should return ContextLayer with contextBuilder and eventDeltaTracker', async () => {
        // Mock createContextBuilder
        const contextBuilderModule = await import('@/agent/context-builder');
        const mockContextBuilder = {} as unknown as ContextBuilder;
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder);
        spies.push(createContextBuilderSpy);

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        const mockEventDeltaTracker = {} as unknown as EventDeltaTracker;
        // @ts-expect-error - Mocking class constructor
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => mockEventDeltaTracker) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker);
        spies.push(EventDeltaTrackerSpy);

        // Import and call createContextLayer
        const { createContextLayer } = await import('@/app/context-layer');
        const result = createContextLayer(mockMemoryBackend);

        // Verify result has expected fields
        expect(result).toHaveProperty('contextBuilder');
        expect(result).toHaveProperty('eventDeltaTracker');
        expect(result.contextBuilder).toBe(mockContextBuilder);
        expect(result.eventDeltaTracker).toBe(mockEventDeltaTracker);
    });

    test('should pass memoryBackend and summarizeEventBatches to createContextBuilder', async () => {
        // Mock createContextBuilder
        const contextBuilderModule = await import('@/agent/context-builder');
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ContextBuilder);
        spies.push(createContextBuilderSpy);

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        // @ts-expect-error - Mocking class constructor
        spies.push(spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => ({})) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker));

        // Import summarizeEventBatches
        const eventSummarizerModule = await import('@/agent/event-summarizer');
        const { summarizeEventBatches } = eventSummarizerModule;

        // Import and call createContextLayer
        const { createContextLayer } = await import('@/app/context-layer');
        createContextLayer(mockMemoryBackend);

        // Verify createContextBuilder was called with correct args
        expect(createContextBuilderSpy).toHaveBeenCalledWith({ backend: mockMemoryBackend, summarizeEventBatches });
    });

    test('should pass contextBuilder to EventDeltaTracker', async () => {
        // Mock createContextBuilder
        const contextBuilderModule = await import('@/agent/context-builder');
        const mockContextBuilder = {} as unknown as ContextBuilder;
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder));

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        // @ts-expect-error - Mocking class constructor
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => ({})) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker);
        spies.push(EventDeltaTrackerSpy);

        // Import and call createContextLayer
        const { createContextLayer } = await import('@/app/context-layer');
        createContextLayer(mockMemoryBackend);

        // Verify EventDeltaTracker was called with contextBuilder
        expect(EventDeltaTrackerSpy).toHaveBeenCalledWith(mockContextBuilder);
    });

    test('should throw when createContextBuilder throws', async () => {
        // Mock createContextBuilder to throw
        const contextBuilderModule = await import('@/agent/context-builder');
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockImplementation(() => {
            throw new Error('Context builder initialization failed');
        });
        spies.push(createContextBuilderSpy);

        // Import and call createContextLayer - should throw
        const { createContextLayer } = await import('@/app/context-layer');
        expect(() => createContextLayer(mockMemoryBackend)).toThrow('Context builder initialization failed');
    });

    test('should throw when EventDeltaTracker constructor throws', async () => {
        // Mock createContextBuilder to succeed
        const contextBuilderModule = await import('@/agent/context-builder');
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ContextBuilder));

        // Mock EventDeltaTracker constructor to throw
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        // @ts-expect-error - Mocking class constructor that throws
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((): EventDeltaTracker => {
            throw new Error('Event delta tracker initialization failed');
        });
        spies.push(EventDeltaTrackerSpy);

        // Import and call createContextLayer - should throw
        const { createContextLayer } = await import('@/app/context-layer');
        expect(() => createContextLayer(mockMemoryBackend)).toThrow('Event delta tracker initialization failed');
    });
});
