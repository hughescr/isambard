import { createMemoryPath, createContentType, type MemoryToolBackend } from './memory-tool';
import { DynamoTableAccess } from './repositories/base';

/**
 * An entry to be logged in the activity log.
 */
export interface ActivityLogEntry<TType extends string> {
    type:      TType
    summary:   string
    details?:  string
    tags?:     string[]
    metadata?: Record<string, unknown>
}

/**
 * Lightweight activity logger that persists entries to the memory tool backend.
 */
export interface ActivityLogger<TType extends string> {
    log(entry: ActivityLogEntry<TType>): Promise<void>
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

export function createActivityLogger<TType extends string>(backend: MemoryToolBackend): ActivityLogger<TType> {
    return {
        async log(entry: ActivityLogEntry<TType>): Promise<void> {
            const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
            const path = createMemoryPath(`/events/activity/${entry.type}/${timestamp}`);
            const content = entry.details
                ? `[auto] ${entry.summary}\n\n${entry.details}`
                : `[auto] ${entry.summary}`;
            const tags = new Set(['auto-logged', entry.type, ...(entry.tags ?? [])]);
            const ttl = DynamoTableAccess.expiresAt(Date.now(), { days: ACTIVITY_TTL_DAYS });

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
