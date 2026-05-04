import { createMemoryPath, createContentType, type MemoryToolBackend } from './memory-tool';

/**
 * All activity types that can be logged automatically by the system.
 */
export type ActivityType
    = | 'email-sent' | 'email-rejected'
      | 'bsky-post-sent' | 'bsky-post-rejected'
      | 'bsky-dm-sent' | 'bsky-dm-rejected'
      | 'discord-exchange'
      | 'perch-start' | 'perch-end' | 'perch-suspend' | 'perch-resume'
      | 'catchup-start' | 'catchup-complete' | 'catchup-suspend';

/**
 * An entry to be logged in the activity log.
 */
export interface ActivityLogEntry {
    type:      ActivityType
    summary:   string
    details?:  string
    tags?:     string[]
    metadata?: Record<string, unknown>
}

/**
 * Lightweight activity logger that persists entries to the memory tool backend.
 */
export interface ActivityLogger {
    log(entry: ActivityLogEntry): Promise<void>
}

/**
 * Creates an activity logger that persists activity entries at
 * `/events/activity/{type}/{isoTimestamp}` in the memory tool backend.
 *
 * Errors from `backend.create()` are propagated to the caller.
 * For fire-and-forget usage: `void logger.log(entry).catch(() => undefined)`.
 */
// Auto-logged activity entries expire after 30 days. Manual logEvent entries do not get a TTL.
const ACTIVITY_TTL_DAYS = 30;

export function createActivityLogger(backend: MemoryToolBackend): ActivityLogger {
    return {
        async log(entry: ActivityLogEntry): Promise<void> {
            const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
            const path = createMemoryPath(`/events/activity/${entry.type}/${timestamp}`);
            const content = entry.details
                ? `[auto] ${entry.summary}\n\n${entry.details}`
                : `[auto] ${entry.summary}`;
            const tags = new Set(['auto-logged', entry.type, ...(entry.tags ?? [])]);
            // Stryker disable next-line ArithmeticOperator: TTL arithmetic — 30-day constant; mutation to a different constant would still expire, just at a different time
            const ttl = Math.floor(Date.now() / 1000) + ACTIVITY_TTL_DAYS * 86_400;

            await backend.create({
                path,
                content,
                contentType: createContentType('text/plain'),
                tags,
                ttl,
                ...(entry.metadata !== undefined && { metadata: entry.metadata }),
            });
        },
    };
}
