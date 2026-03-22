import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockLogger } from '../../setup';
// Import modules once for spyOn — avoids expensive per-test dynamic import()
import * as contextBuilderModule from '@/agent/context-builder';
import type { ContextBuilder } from '@/agent/context-builder';
import * as eventDeltaTrackerModule from '@/agent/event-delta-tracker';
import type { EventDeltaTracker } from '@/agent/event-delta-tracker';
import * as eventSummarizerModule from '@/agent/event-summarizer';
import * as contextLayerModule from '@/app/context-layer';
import type { MemoryToolBackend } from '@/storage/memory-tool/backend';

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

    test('should return ContextLayer with contextBuilder and eventDeltaTracker', () => {
        // Mock createContextBuilder
        const mockContextBuilder = {} as unknown as ContextBuilder;
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder);
        spies.push(createContextBuilderSpy);

        // Mock EventDeltaTracker constructor
        const mockEventDeltaTracker = {} as unknown as EventDeltaTracker;
        // @ts-expect-error - Mocking class constructor
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => mockEventDeltaTracker) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker);
        spies.push(EventDeltaTrackerSpy);

        const result = contextLayerModule.createContextLayer(mockMemoryBackend);

        // Verify result has expected fields
        expect(result).toHaveProperty('contextBuilder');
        expect(result).toHaveProperty('eventDeltaTracker');
        expect(result.contextBuilder).toBe(mockContextBuilder);
        expect(result.eventDeltaTracker).toBe(mockEventDeltaTracker);
    });

    test('should pass memoryBackend and summarizeEventBatches to createContextBuilder', () => {
        // Mock createContextBuilder
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ContextBuilder);
        // @ts-expect-error - Mocking class constructor
        const EventDeltaTrackerSpy2 = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => ({})) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker);
        spies.push(createContextBuilderSpy, EventDeltaTrackerSpy2);

        contextLayerModule.createContextLayer(mockMemoryBackend);

        // Verify createContextBuilder was called with correct args
        expect(createContextBuilderSpy).toHaveBeenCalledWith({ backend: mockMemoryBackend, summarizeEventBatches: eventSummarizerModule.summarizeEventBatches });
    });

    test('should pass contextBuilder to EventDeltaTracker', () => {
        // Mock createContextBuilder
        const mockContextBuilder = {} as unknown as ContextBuilder;
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder));

        // Mock EventDeltaTracker constructor
        // @ts-expect-error - Mocking class constructor
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((() => ({})) as unknown as typeof eventDeltaTrackerModule.EventDeltaTracker);
        spies.push(EventDeltaTrackerSpy);

        contextLayerModule.createContextLayer(mockMemoryBackend);

        // Verify EventDeltaTracker was called with contextBuilder
        expect(EventDeltaTrackerSpy).toHaveBeenCalledWith(mockContextBuilder);
    });

    test('should throw when createContextBuilder throws', () => {
        // Mock createContextBuilder to throw
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockImplementation(() => {
            throw new Error('Context builder initialization failed');
        });
        spies.push(createContextBuilderSpy);

        expect(() => contextLayerModule.createContextLayer(mockMemoryBackend)).toThrow('Context builder initialization failed');
    });

    test('should throw when EventDeltaTracker constructor throws', () => {
        // Mock createContextBuilder to succeed
        spies.push(spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ContextBuilder));

        // Mock EventDeltaTracker constructor to throw
        // @ts-expect-error - Mocking class constructor that throws
        const EventDeltaTrackerSpy = spyOn(eventDeltaTrackerModule, 'EventDeltaTracker').mockImplementation((): EventDeltaTracker => {
            throw new Error('Event delta tracker initialization failed');
        });
        spies.push(EventDeltaTrackerSpy);

        expect(() => contextLayerModule.createContextLayer(mockMemoryBackend)).toThrow('Event delta tracker initialization failed');
    });
});
