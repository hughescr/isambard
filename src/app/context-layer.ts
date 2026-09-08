import { createContextBuilder, summarizeEventBatches, type ContextBuilder, type EmailService, type BskyDMService, type CalendarService } from '@/agent';
import type { BskyRejectionBackend } from '@/integrations/bsky';
import type { ServiceHealthRegistry } from '@/services';
import type { MemoryToolBackend } from '@/storage';

/**
 * Context layer components for memory-aware agent operation.
 */
interface ContextLayer {
    contextBuilder: ContextBuilder
}

/**
 * Creates the context layer with a context builder.
 *
 * P13b: no longer constructs a shared EventDeltaTracker here — that was the one-shot
 * path's own delta-tracking seam; the conductor's ledger owns event deltas now.
 *
 * @param memoryBackend        - Memory tool backend for context loading
 * @param emailService         - Optional email service for perch inbox section
 * @param bskyDMService        - Optional Bluesky DM service for perch DM section
 * @param calendarService      - Optional calendar service for perch calendar section
 * @param bskyRejectionBackend - Optional Bluesky rejection backend for rejected post tracking
 * @param healthRegistry       - Optional service health registry for status section
 * @returns Context layer components
 */
export function createContextLayer(memoryBackend: MemoryToolBackend, emailService?: EmailService, bskyDMService?: BskyDMService, calendarService?: CalendarService, bskyRejectionBackend?: BskyRejectionBackend, healthRegistry?: ServiceHealthRegistry): ContextLayer {
    const contextBuilder = createContextBuilder({ backend: memoryBackend, summarizeEventBatches, emailService, bskyDMService, calendarService, bskyRejectionBackend, healthRegistry });

    return { contextBuilder };
}
