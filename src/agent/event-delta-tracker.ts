/**
 * Event Delta Tracker
 *
 * Tracks new events that occur during message processing. Used to provide
 * context about what happened during an interrupted processing session.
 */

import type { ContextBuilder } from './context-builder';

export interface EventDeltaTracker {
    /**
     * Mark the start of processing. Captures current event count.
     */
    markStart(): Promise<void>

    /**
     * Get events that occurred after the start marker.
     * @returns Array of formatted event strings (from context-builder format)
     */
    getNewEvents(): Promise<string[]>
}

/**
 * Creates an event delta tracker
 * @param contextBuilder Context builder to load events from
 * @returns EventDeltaTracker instance
 */
export function createEventDeltaTracker(contextBuilder: ContextBuilder): EventDeltaTracker {
    let startEventCount = 0;

    return {
        async markStart(): Promise<void> {
            // Load recent events and store the count
            const events = await contextBuilder.loadRecentEvents(50);
            startEventCount = events.length;
        },

        async getNewEvents(): Promise<string[]> {
            // Load recent events
            const events = await contextBuilder.loadRecentEvents(50);

            // Return only events that occurred after the start marker
            // Events are sorted oldest-first, so new events are at the end
            return events.slice(startEventCount);
        },
    };
}
