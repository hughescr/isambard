import { createContextBuilder, EventDeltaTracker, summarizeEventBatches } from '@/agent';
import type { ContextBuilder, EmailService } from '@/agent/context-builder';
import type { MemoryToolBackend } from '@/storage';

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
 * @param emailService  - Optional email service for perch inbox section
 * @returns Context layer components
 */
export function createContextLayer(memoryBackend: MemoryToolBackend, emailService?: EmailService): ContextLayer {
    const contextBuilder = createContextBuilder({ backend: memoryBackend, summarizeEventBatches, emailService });
    const eventDeltaTracker = new EventDeltaTracker(contextBuilder);

    return { contextBuilder, eventDeltaTracker };
}
