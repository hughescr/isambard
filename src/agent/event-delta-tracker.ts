/**
 * Event Delta Tracker
 *
 * Tracks new events that occur during message processing. Used to provide
 * context about what happened during an interrupted processing session.
 */
import { type ContextBuilder, formatMemoryPreview  } from './context-builder';

/**
 * Event delta tracker for tracking new events during message processing.
 *
 * Uses timestamp-based tracking so that markStart() is a pure in-memory
 * operation (no DB I/O), and getNewEvents() queries only for events that
 * arrived after the start timestamp — correctly handling edge cases where
 * there are already ≥ 50 events in the window at markStart time.
 */
export class EventDeltaTracker {
    private startTimeMs: number | undefined;
    private readonly contextBuilder: ContextBuilder;

    constructor(contextBuilder: ContextBuilder) {
        this.contextBuilder = contextBuilder;
    }

    /**
     * Mark the start of processing. Captures the current timestamp as an
     * in-memory operation — no database I/O is performed.
     */
    markStart(): void {
        this.startTimeMs = Date.now();
    }

    /**
     * Get events that occurred after the start marker.
     * @returns Array of formatted event strings (preview format), or empty
     *   array if markStart has not been called.
     */
    async getNewEvents(): Promise<string[]> {
        if (this.startTimeMs === undefined) {
            return [];
        }
        const now = new Date();
        const windowMs = now.getTime() - this.startTimeMs;
        const items = await this.contextBuilder.loadRecentEventsSince(windowMs, 50);
        return items.map(item =>
            formatMemoryPreview(item.path, item.content, item.contentPreview, item.updatedAt, now));
    }
}
