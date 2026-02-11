/**
 * Event Delta Tracker
 *
 * Tracks new events that occur during message processing. Used to provide
 * context about what happened during an interrupted processing session.
 */

import type { ContextBuilder } from './context-builder';

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
        const events = await this.contextBuilder.loadRecentEvents(50);
        this.startEventCount = events.length;
    }

    /**
     * Get events that occurred after the start marker.
     * @returns Array of formatted event strings (from context-builder format)
     */
    async getNewEvents(): Promise<string[]> {
        // Load recent events
        const events = await this.contextBuilder.loadRecentEvents(50);

        // Return only events that occurred after the start marker
        // Events are sorted oldest-first, so new events are at the end
        return events.slice(this.startEventCount);
    }
}
