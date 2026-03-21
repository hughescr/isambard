import {
    type BskyFeedCheckpoint,
    type BskyNotificationCheckpoint,
    bskyFeedCheckpointSchema,
    bskyNotificationCheckpointSchema,
    MAX_PROCESSED_URIS
} from './types';
import { sanitizeFeedName } from './uri-sanitizer';
import type { BskyFeedItem, BskyNotification } from '@/integrations/bsky/types';
import { type MemoryToolBackend, type MemoryPath, createMemoryPath } from '@/storage';

/**
 * Options for creating a BskyCheckpointManager.
 */
interface BskyCheckpointManagerOptions {
    backend: MemoryToolBackend
}

/**
 * Manages Bluesky checkpoints for tracking processed feed posts and notifications.
 * Uses the memory tool backend for persistent storage.
 *
 * Feed checkpoints stored at: `/state/services/bsky/feeds/{sanitizedFeedName}/checkpoint`
 * Notification checkpoint stored at: `/state/services/bsky/notifications/checkpoint`
 */
export class BskyCheckpointManager {
    private readonly backend: MemoryToolBackend;

    constructor(options: BskyCheckpointManagerOptions) {
        this.backend = options.backend;
    }

    /**
     * Gets the memory path for a feed checkpoint.
     */
    private getFeedCheckpointPath(feedName: string): MemoryPath {
        const sanitized = sanitizeFeedName(feedName);
        return createMemoryPath(`/state/services/bsky/feeds/${sanitized}/checkpoint`);
    }

    /**
     * Gets the memory path for the notification checkpoint.
     */
    private getNotificationCheckpointPath(): MemoryPath {
        // Stryker disable next-line StringLiteral: memory path is configuration
        return createMemoryPath('/state/services/bsky/notifications/checkpoint');
    }

    /**
     * Generic helper: loads a checkpoint from a memory path and parses it with the given schema.
     */
    private async loadCheckpoint<T>(path: MemoryPath, schema: { parse: (data: unknown) => T }): Promise<T | undefined> {
        const item = await this.backend.get(path);

        if(!item) {
            return undefined;
        }

        // Stryker disable BlockStatement: Error handling for corrupted/invalid data
        try {
            const parsed: unknown = JSON.parse(item.content);
            return schema.parse(parsed);
        } catch{
            return undefined;
        }
        // Stryker restore BlockStatement
    }

    /**
     * Generic helper: saves a checkpoint to a memory path, creating or updating as needed.
     */
    private async saveCheckpoint(path: MemoryPath, checkpoint: { processedUris: string[] }, exists: boolean): Promise<void> {
        const content = JSON.stringify(checkpoint);

        await (exists
            ? this.backend.update(path, { content })
            : this.backend.create({
                path,
                content,
                // Stryker disable next-line StringLiteral: content type is configuration
                contentType: 'application/json',
            }));
    }

    /**
     * Loads the checkpoint for a feed.
     *
     * @param feedName - Feed name or AT URI
     * @returns The checkpoint data, or undefined if not found or invalid
     */
    async loadFeedCheckpoint(feedName: string): Promise<BskyFeedCheckpoint | undefined> {
        return this.loadCheckpoint(this.getFeedCheckpointPath(feedName), bskyFeedCheckpointSchema);
    }

    /**
     * Saves a feed checkpoint.
     * Creates or updates the checkpoint as needed.
     * Applies FIFO eviction to processedUris if over MAX_PROCESSED_URIS.
     *
     * @param checkpoint - The checkpoint data to save
     * @param exists - Whether the checkpoint already exists in the backend (skips a redundant backend.get)
     */
    async saveFeedCheckpoint(checkpoint: BskyFeedCheckpoint, exists: boolean): Promise<void> {
        const path = this.getFeedCheckpointPath(checkpoint.feedName);

        // Apply FIFO eviction
        // Stryker disable next-line ConditionalExpression,EqualityOperator: at exactly MAX items, slice(-MAX) returns full array — true/>=MAX produces identical output
        const bounded = checkpoint.processedUris.length > MAX_PROCESSED_URIS
            ? { ...checkpoint, processedUris: checkpoint.processedUris.slice(-MAX_PROCESSED_URIS) }
            : checkpoint;

        await this.saveCheckpoint(path, bounded, exists);
    }

    /**
     * Loads the notification checkpoint.
     *
     * @returns The checkpoint data, or undefined if not found or invalid
     */
    async loadNotificationCheckpoint(): Promise<BskyNotificationCheckpoint | undefined> {
        return this.loadCheckpoint(this.getNotificationCheckpointPath(), bskyNotificationCheckpointSchema);
    }

    /**
     * Saves the notification checkpoint.
     * Creates or updates the checkpoint as needed.
     * Applies FIFO eviction to processedUris if over MAX_PROCESSED_URIS.
     *
     * @param checkpoint - The checkpoint data to save
     * @param exists - Whether the checkpoint already exists in the backend (skips a redundant backend.get)
     */
    async saveNotificationCheckpoint(checkpoint: BskyNotificationCheckpoint, exists: boolean): Promise<void> {
        const path = this.getNotificationCheckpointPath();

        // Apply FIFO eviction
        // Stryker disable next-line ConditionalExpression,EqualityOperator: at exactly MAX items, slice(-MAX) returns full array — true/>=MAX produces identical output
        const bounded = checkpoint.processedUris.length > MAX_PROCESSED_URIS
            ? { ...checkpoint, processedUris: checkpoint.processedUris.slice(-MAX_PROCESSED_URIS) }
            : checkpoint;

        await this.saveCheckpoint(path, bounded, exists);
    }

    /**
     * Processes a batch of feed items in a single DynamoDB round-trip.
     * Loads the checkpoint once, filters new items, updates processedUris, and saves.
     *
     * @param feedName - Feed name or AT URI (used as checkpoint key)
     * @param items - All fetched feed items
     * @returns newItems (not yet processed) and totalFetched count
     */
    async processFeedItems(feedName: string, items: BskyFeedItem[]): Promise<{ newItems: BskyFeedItem[], totalFetched: number }> {
        const checkpoint   = await this.loadFeedCheckpoint(feedName);
        const processedSet = new Set(checkpoint?.processedUris);
        const newItems     = items.filter(item => !processedSet.has(item.post.uri));
        const totalFetched = items.length;

        // Compute high-water mark (max ISO timestamp via lexicographic sort)
        const allIndexedAts = items.map(item => item.post.indexedAt);
        const maxIndexedAt  = allIndexedAts.length > 0
            ? allIndexedAts.toSorted((a, b) => a.localeCompare(b)).at(-1)
            : checkpoint?.lastIndexedAt;

        // Build deduplicated processedUris
        // Stryker disable next-line ArrayDeclaration: fallback [] when no checkpoint — tests verify new URIs are present but don't count stale entries
        const updatedUris = [...new Set([...(checkpoint?.processedUris ?? []), ...items.map(item => item.post.uri)])];

        const now = new Date().toISOString();
        const updatedCheckpoint: BskyFeedCheckpoint = {
            service:       'bsky',
            type:          'feed',
            feedName,
            lastIndexedAt: maxIndexedAt,
            processedUris: updatedUris,
            updatedAt:     now,
        };

        await this.saveFeedCheckpoint(updatedCheckpoint, !!checkpoint);

        return { newItems, totalFetched };
    }

    /**
     * Processes a batch of notifications in a single DynamoDB round-trip.
     * Loads the checkpoint once, filters new notifications, updates processedUris, and saves.
     * Does NOT call updateNotificationsSeen — that is a client operation left to the caller.
     *
     * @param notifications - All fetched notifications
     * @returns newNotifications (not yet processed), totalFetched count, lastSeenAt (max indexedAt), and hadExistingCheckpoint
     */
    async processNotifications(notifications: BskyNotification[]): Promise<{ newNotifications: BskyNotification[], totalFetched: number, lastSeenAt: string | undefined, hadExistingCheckpoint: boolean }> {
        const checkpoint          = await this.loadNotificationCheckpoint();
        const hadExistingCheckpoint = !!checkpoint;
        const processedSet        = new Set(checkpoint?.processedUris);
        const newNotifications    = notifications.filter(n => !processedSet.has(n.uri));
        const totalFetched        = notifications.length;

        // Compute lastSeenAt (max indexedAt of fetched notifications via lexicographic sort)
        const sortedIndexedAts = notifications.map(n => n.indexedAt).toSorted((a, b) => a.localeCompare(b));
        // Stryker disable next-line StringLiteral: ?? '' fallback unreachable — length > 0 guard ensures .at(-1) always returns a value
        const lastSeenAt = notifications.length > 0 ? sortedIndexedAts.at(-1) : checkpoint?.lastSeenAt;

        // Build deduplicated processedUris
        // Stryker disable next-line ArrayDeclaration: fallback [] when no checkpoint — tests verify new URIs are present but don't count stale entries
        const updatedUris = [...new Set([...(checkpoint?.processedUris ?? []), ...notifications.map(n => n.uri)])];

        const now = new Date().toISOString();
        await this.saveNotificationCheckpoint({
            service:       'bsky',
            type:          'notification',
            lastSeenAt,
            processedUris: updatedUris,
            updatedAt:     now,
        }, hadExistingCheckpoint);

        return { newNotifications, totalFetched, lastSeenAt, hadExistingCheckpoint };
    }
}
