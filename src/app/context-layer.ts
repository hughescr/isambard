import { createContextBuilder, type ContextBuilder } from '@/agent/context-builder';
import { EventDeltaTracker } from '@/agent/event-delta-tracker';
import type { MemoryToolBackend } from '@/storage/memory-tool';

/**
 * Context layer components for memory-aware agent operation.
 */
export interface ContextLayer {
    contextBuilder:    ContextBuilder
    eventDeltaTracker: EventDeltaTracker
}

/**
 * Creates the context layer with context builder and event delta tracker.
 *
 * @param memoryBackend - Memory tool backend for context loading
 * @returns Context layer components
 */
export function createContextLayer(memoryBackend: MemoryToolBackend): ContextLayer {
    const contextBuilder = createContextBuilder({ backend: memoryBackend });
    const eventDeltaTracker = new EventDeltaTracker(contextBuilder);

    return { contextBuilder, eventDeltaTracker };
}
