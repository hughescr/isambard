import { z } from 'zod';

/**
 * Maximum number of processed URIs to retain per checkpoint.
 * FIFO eviction keeps the newest entries when the cap is exceeded.
 * 500 entries ≈ 4× a single page fetch, covering ~half a day of activity.
 */
export const MAX_PROCESSED_URIS = 500;

/**
 * Bluesky feed checkpoint schema.
 * Tracks the last-seen state for a feed to avoid re-processing posts.
 */
// Stryker disable StringLiteral: All .describe() calls and literal schema values are documentation/configuration
export const bskyFeedCheckpointSchema = z.object({
    /** Service identifier (always 'bsky') */
    service:       z.literal('bsky'),
    /** Checkpoint type (always 'feed') */
    type:          z.literal('feed'),
    /** Feed name or sanitized AT URI */
    feedName:      z.string().min(1),
    /** High-water mark: latest indexedAt from fetched items */
    lastIndexedAt: z.iso.datetime().optional(),
    /** Bounded set of processed post AT URIs (FIFO-evicted at MAX_PROCESSED_URIS) */
    processedUris: z.array(z.string()),
    /** ISO 8601 timestamp when this checkpoint was last updated */
    updatedAt:     z.iso.datetime(),
});
// Stryker restore StringLiteral

export type BskyFeedCheckpoint = z.infer<typeof bskyFeedCheckpointSchema>;

/**
 * Bluesky notification checkpoint schema.
 * Tracks the last-seen state for notifications.
 */
// Stryker disable StringLiteral: All .describe() calls and literal schema values are documentation/configuration
export const bskyNotificationCheckpointSchema = z.object({
    /** Service identifier (always 'bsky') */
    service:       z.literal('bsky'),
    /** Checkpoint type (always 'notification') */
    type:          z.literal('notification'),
    /** Timestamp passed to updateNotificationsSeen API */
    lastSeenAt:    z.iso.datetime().optional(),
    /** Bounded set of processed notification AT URIs */
    processedUris: z.array(z.string()),
    /** ISO 8601 timestamp when this checkpoint was last updated */
    updatedAt:     z.iso.datetime(),
});
// Stryker restore StringLiteral

export type BskyNotificationCheckpoint = z.infer<typeof bskyNotificationCheckpointSchema>;
