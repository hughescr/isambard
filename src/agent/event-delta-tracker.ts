/**
 * Event Delta Tracker
 *
 * Tracks new events that occur during message processing. Used to provide
 * context about what happened during an interrupted processing session.
 */
import { type ContextBuilder, formatMemoryPreview  } from './context-builder';

/**
 * Event delta tracker for tracking new events during message processing.
 */
export class EventDeltaTracker {
    private startEventCount = 0;
    private readonly contextBuilder: ContextBuilder;

    constructor(contextBuilder: ContextBuilder) {
        this.contextBuilder = contextBuilder;
    }

    /**
     * Mark the start of processing. Captures current event count.
     */
    async markStart(): Promise<void> {
        // Load recent events and store the count
        const result = await this.contextBuilder.loadRecentEvents(50);
        this.startEventCount = result.items.length;
    }

    /**
     * Get events that occurred after the start marker.
     * @returns Array of formatted event strings (preview format)
     */
    async getNewEvents(): Promise<string[]> {
        const now = new Date();
        // Load recent events
        const result = await this.contextBuilder.loadRecentEvents(50);

        // Return only events that occurred after the start marker
        // Events are sorted oldest-first, so new events are at the end
        const newItems = result.items.slice(this.startEventCount);
        return newItems.map(item =>
            formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now));
    }
}
