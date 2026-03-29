import { createMemoryPath, createContentType, type MemoryToolBackend } from '@/storage';

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
export function createActivityLogger(backend: MemoryToolBackend): ActivityLogger {
    return {
        async log(entry: ActivityLogEntry): Promise<void> {
            const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
            const path = createMemoryPath(`/events/activity/${entry.type}/${timestamp}`);
            const content = entry.details
                ? `[auto] ${entry.summary}\n\n${entry.details}`
                : `[auto] ${entry.summary}`;
            const tags = new Set(['auto-logged', entry.type, ...(entry.tags ?? [])]);

            await backend.create({
                path,
                content,
                contentType: createContentType('text/plain'),
                tags,
                ...(entry.metadata !== undefined && { metadata: entry.metadata }),
            });
        },
    };
}
