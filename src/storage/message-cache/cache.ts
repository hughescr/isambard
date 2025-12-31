import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ChannelId } from '@/integrations/discord/types';
import type { MessageId, CachedMessage, CacheGap, CachedSegmentData } from './types';
import { MessageCacheBackend } from './backend';
import { SegmentManager } from './segment-manager';

/**
 * Result from getMessagesInRange operation.
 */
export interface CacheQueryResult {
    /** Messages found in the cache within the requested range */
    messages:      CachedMessage[]
    /** Gaps in the cache that need to be fetched from Discord API */
    gaps:          CacheGap[]
    /** True if the entire requested range is covered by the cache */
    fullyResolved: boolean
}

/**
 * High-level interface for Discord message caching.
 * Combines backend storage with segment management logic.
 */
export class MessageCache {
    private readonly backend: MessageCacheBackend;

    constructor(docClient: DynamoDBDocumentClient, tableName: string) {
        this.backend = new MessageCacheBackend(docClient, tableName);
    }

    /**
     * Retrieves messages from the cache for a given range.
     * Returns cached messages along with any gaps that need fetching.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the range (inclusive)
     * @param endSnowflake - End of the range (inclusive)
     * @returns Cached messages, gaps, and whether the range is fully resolved
     *
     * @example
     * ```ts
     * const result = await cache.getMessagesInRange(
     *   channelId,
     *   '100' as MessageId,
     *   '200' as MessageId
     * );
     *
     * if (!result.fullyResolved) {
     *   for (const gap of result.gaps) {
     *     // Fetch messages from Discord API for this gap
     *     const fetched = await discordApi.fetchMessages(gap.start, gap.end);
     *     await cache.storeMessages(channelId, gap.start, gap.end, fetched);
     *   }
     * }
     *
     * // result.messages contains all cached messages in range
     * ```
     */
    async getMessagesInRange(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<CacheQueryResult> {
        // Get all segments for this channel
        const allSegments = await this.backend.listSegments(channelId);

        // Find segments that overlap with the requested range
        const overlappingSegments = SegmentManager.findOverlappingSegments(
            allSegments,
            startSnowflake,
            endSnowflake
        );

        // Find gaps in coverage
        const gaps = SegmentManager.findGaps(
            overlappingSegments,
            startSnowflake,
            endSnowflake
        );

        // Merge messages from overlapping segments
        const messages = SegmentManager.mergeMessages(
            overlappingSegments,
            startSnowflake,
            endSnowflake
        );

        return {
            messages,
            gaps,
            fullyResolved: gaps.length === 0,
        };
    }

    /**
     * Stores messages in the cache for a given range.
     * Use this after fetching messages from Discord API to fill gaps.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the range (inclusive)
     * @param endSnowflake - End of the range (inclusive)
     * @param messages - Messages to store (can be empty to mark range as checked)
     * @returns The stored segment data
     */
    async storeMessages(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId,
        messages: CachedMessage[]
    ): Promise<CachedSegmentData> {
        return this.backend.storeSegment({
            channelId,
            startSnowflake,
            endSnowflake,
            messages,
        });
    }

    /**
     * Finds gaps in cache coverage for a given range.
     * Useful for determining what needs to be fetched from Discord API.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the range (inclusive)
     * @param endSnowflake - End of the range (inclusive)
     * @returns Array of gaps that need to be fetched
     */
    async findGaps(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<CacheGap[]> {
        const allSegments = await this.backend.listSegments(channelId);
        return SegmentManager.findGaps(allSegments, startSnowflake, endSnowflake);
    }

    /**
     * Checks if a range is fully covered by the cache.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the range (inclusive)
     * @param endSnowflake - End of the range (inclusive)
     * @returns True if the range has no gaps
     */
    async isRangeFullyCached(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<boolean> {
        const gaps = await this.findGaps(channelId, startSnowflake, endSnowflake);
        return gaps.length === 0;
    }

    /**
     * Gets all cached segments for a channel.
     * Useful for debugging or cache management.
     *
     * @param channelId - Discord channel ID
     * @returns Array of all cached segments
     */
    async listSegments(channelId: ChannelId): Promise<CachedSegmentData[]> {
        return this.backend.listSegments(channelId);
    }

    /**
     * Deletes a specific segment from the cache.
     *
     * @param channelId - Discord channel ID
     * @param startSnowflake - Start of the segment range
     * @param endSnowflake - End of the segment range
     */
    async deleteSegment(
        channelId: ChannelId,
        startSnowflake: MessageId,
        endSnowflake: MessageId
    ): Promise<void> {
        return this.backend.deleteSegment(channelId, startSnowflake, endSnowflake);
    }

    /**
     * Clears all cached segments for a channel.
     *
     * @param channelId - Discord channel ID
     * @returns Number of segments deleted
     */
    async clearChannel(channelId: ChannelId): Promise<number> {
        return this.backend.deleteAllSegments(channelId);
    }
}
