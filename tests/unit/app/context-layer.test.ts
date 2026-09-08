import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mockLogger } from '../../setup';
// Import modules once for spyOn — avoids expensive per-test dynamic import()
import * as contextBuilderModule from '@/agent/context-builder';
import type { ContextBuilder } from '@/agent/context-builder';
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

    test('should return ContextLayer with contextBuilder only (P13b: no shared EventDeltaTracker)', () => {
        // Mock createContextBuilder
        const mockContextBuilder = {} as unknown as ContextBuilder;
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue(mockContextBuilder);
        spies.push(createContextBuilderSpy);

        const result = contextLayerModule.createContextLayer(mockMemoryBackend);

        // Verify result has expected fields
        expect(result).toHaveProperty('contextBuilder');
        expect(result).not.toHaveProperty('eventDeltaTracker');
        expect(result.contextBuilder).toBe(mockContextBuilder);
    });

    test('should pass memoryBackend and summarizeEventBatches to createContextBuilder', () => {
        // Mock createContextBuilder
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockReturnValue({} as unknown as ContextBuilder);
        spies.push(createContextBuilderSpy);

        contextLayerModule.createContextLayer(mockMemoryBackend);

        // Verify createContextBuilder was called with correct args
        expect(createContextBuilderSpy).toHaveBeenCalledWith({ backend: mockMemoryBackend, summarizeEventBatches: eventSummarizerModule.summarizeEventBatches });
    });

    test('should throw when createContextBuilder throws', () => {
        // Mock createContextBuilder to throw
        const createContextBuilderSpy = spyOn(contextBuilderModule, 'createContextBuilder').mockImplementation(() => {
            throw new Error('Context builder initialization failed');
        });
        spies.push(createContextBuilderSpy);

        expect(() => contextLayerModule.createContextLayer(mockMemoryBackend)).toThrow('Context builder initialization failed');
    });
});
