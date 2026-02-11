/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- Test mocks */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockLogger } from '../../setup';
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
        const mockContextBuilder = {} as any;
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder);
        spies.push(createContextBuilderSpy);

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        const mockEventDeltaTracker = {} as any;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test mock
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation(() => mockEventDeltaTracker);
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

    test('should pass memoryBackend to createContextBuilder', async () => {
        // Mock createContextBuilder
        const contextBuilderModule = await import('@/agent/context-builder');
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as any);
        spies.push(createContextBuilderSpy);

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test mock
        spies.push(spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation(() => ({})));

        // Import and call createContextLayer
        const { createContextLayer } = await import('@/app/context-layer');
        createContextLayer(mockMemoryBackend);

        // Verify createContextBuilder was called with correct args
        expect(createContextBuilderSpy).toHaveBeenCalledWith({ backend: mockMemoryBackend });
    });

    test('should pass contextBuilder to EventDeltaTracker', async () => {
        // Mock createContextBuilder
        const contextBuilderModule = await import('@/agent/context-builder');
        const mockContextBuilder = {} as any;
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder));

        // Mock EventDeltaTracker constructor
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Test mock
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation(() => ({}));
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
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as any));

        // Mock EventDeltaTracker constructor to throw
        const eventDeltaTrackerModule = await import('@/agent/event-delta-tracker');
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation(() => {
            throw new Error('Event delta tracker initialization failed');
        });
        spies.push(EventDeltaTrackerSpy);

        // Import and call createContextLayer - should throw
        const { createContextLayer } = await import('@/app/context-layer');
        expect(() => createContextLayer(mockMemoryBackend)).toThrow('Event delta tracker initialization failed');
    });
});
