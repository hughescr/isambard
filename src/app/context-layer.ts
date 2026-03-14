import { createContextBuilder, EventDeltaTracker, summarizeEventBatches, type ContextBuilder, type EmailService, type BskyDMService } from '@/agent';
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
 * @param memoryBackend  - Memory tool backend for context loading
 * @param emailService   - Optional email service for perch inbox section
 * @param bskyDMService  - Optional Bluesky DM service for perch DM section
 * @returns Context layer components
 */
export function createContextLayer(memoryBackend: MemoryToolBackend, emailService?: EmailService, bskyDMService?: BskyDMService): ContextLayer {
    const contextBuilder = createContextBuilder({ backend: memoryBackend, summarizeEventBatches, emailService, bskyDMService });
    const eventDeltaTracker = new EventDeltaTracker(contextBuilder);

    return { contextBuilder, eventDeltaTracker };
}
