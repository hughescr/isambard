/**
 * Message Search Service
 *
 * Orchestrates the fetcher, cache, and summarizer to provide comprehensive
 * Discord message search functionality. Handles caching strategy, text filtering,
 * pagination with overflow summaries, and time range queries.
 */

import _ from 'lodash';
import type { z } from 'zod';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import type { MessageCache } from '@/storage/message-cache/cache';
import type { CachedMessage } from '@/storage/message-cache/types';
import { createMessageId } from '@/storage/message-cache/types';
import { timestampToSnowflake, snowflakeToTimestamp } from '@/integrations/discord/message-history/snowflake';
import { createChannelId, type ChannelId } from '@/integrations/discord/types';
import type { DiscordSearchResult, SearchResponse } from '@/integrations/discord/message-history/types';
import { searchParamsSchema } from '@/integrations/discord/message-history/types';

/**
 * Input type for search parameters.
 * Uses z.input to allow optional fields with defaults to be omitted.
 */
export type SearchParamsInput = z.input<typeof searchParamsSchema>;

/**
 * Default number of messages to return when no limit is specified.
 */
const DEFAULT_LIMIT = 10;

/**
 * Default time range in days when no startTime is specified.
 */
const DEFAULT_TIME_RANGE_DAYS = 7;

/**
 * Options for creating a message search service.
 */
export interface MessageSearchServiceOptions {
    /** Message fetcher for Discord API calls */
    fetcher:               MessageFetcher
    /** Message cache for storing/retrieving cached messages */
    cache:                 MessageCache
    /** Message summarizer for overflow handling */
    summarizer:            MessageSummarizer
    /** Default number of messages to return (default: 10) */
    defaultLimit?:         number
    /** Default time range in days (default: 7) */
    defaultTimeRangeDays?: number
}

/**
 * Interface for the message search service.
 */
export interface MessageSearchService {
    /**
     * Search messages with optional filtering by time range and text query.
     * Automatically handles caching and overflow summaries.
     *
     * @param params - Search parameters including channelId, query, time range, and limit
     * @returns Search response with messages, optional overflow summaries, and metadata
     */
    searchMessages(params: SearchParamsInput): Promise<SearchResponse>

    /**
     * Get recent messages from a channel (convenience method).
     *
     * @param channelId - Discord channel ID (plain string)
     * @param limit - Maximum number of messages to return
     * @returns Search response with recent messages
     */
    getRecentMessages(channelId: string, limit?: number): Promise<SearchResponse>

    /**
     * Get a single message by ID.
     *
     * @param channelId - Discord channel ID
     * @param messageId - Discord message ID
     * @returns The message if found, null otherwise
     */
    getMessageById(channelId: string, messageId: string): Promise<DiscordSearchResult | null>
}

/**
 * Converts a CachedMessage to a DiscordSearchResult.
 *
 * Note: Since the cache stores minimal data, some fields will have default values:
 * - guildId: null
 * - author.username: 'unknown'
 * - author.displayName: 'Unknown User'
 * - attachments, embeds, reactions: empty arrays
 *
 * @param cached - The cached message
 * @param channelId - The channel ID for the message
 * @returns A DiscordSearchResult with partial data
 */
function convertCachedToSearchResult(cached: CachedMessage, channelId: ChannelId): DiscordSearchResult {
    return {
        id:      cached.id as string,
        channelId,
        guildId: null,
        author:  {
            id:          cached.authorId,
            username:    'unknown',
            displayName: 'Unknown User',
        },
        content:     cached.content,
        timestamp:   cached.timestamp,
        attachments: [],
        embeds:      [],
        reactions:   [],
    };
}

/**
 * Converts a DiscordSearchResult to a CachedMessage for storage.
 *
 * @param result - The Discord search result
 * @returns A CachedMessage with minimal data
 */
function convertSearchResultToCached(result: DiscordSearchResult): CachedMessage {
    return {
        id:        createMessageId(result.id),
        content:   result.content,
        authorId:  result.author.id,
        timestamp: result.timestamp,
    };
}

/**
 * Creates a message search service that orchestrates fetcher, cache, and summarizer.
 *
 * The service implements a caching strategy where:
 * - Cache is checked first for any available messages
 * - Gaps in the cache are filled by fetching from Discord API
 * - Newly fetched messages are cached only if the time range is in the past (closed window)
 * - Results are filtered by text query if provided
 * - Overflow messages beyond the limit are summarized using Haiku
 *
 * @param options - Configuration options
 * @returns MessageSearchService instance
 *
 * @example
 * ```typescript
 * const searchService = createMessageSearchService({
 *   fetcher: createMessageFetcher(discordClient),
 *   cache: new MessageCache(docClient, tableName),
 *   summarizer: createMessageSummarizer({ anthropicClient }),
 * });
 *
 * // Search with time range and query
 * const results = await searchService.searchMessages({
 *   channelId: createChannelId('123456789012345678'),
 *   query: 'deployment',
 *   startTime: new Date('2025-01-01'),
 *   endTime: new Date('2025-01-15'),
 *   limit: 20,
 * });
 *
 * // Get recent messages
 * const recent = await searchService.getRecentMessages('123456789012345678', 50);
 *
 * // Get specific message
 * const message = await searchService.getMessageById('123456789012345678', '987654321098765432');
 * ```
 */
export function createMessageSearchService(options: MessageSearchServiceOptions): MessageSearchService {
    const {
        fetcher,
        cache,
        summarizer,
        defaultLimit = DEFAULT_LIMIT,
        defaultTimeRangeDays = DEFAULT_TIME_RANGE_DAYS,
    } = options;

    /**
     * Main search implementation.
     */
    async function searchMessages(params: SearchParamsInput): Promise<SearchResponse> {
        const { channelId: channelIdInput, query, startTime, endTime, limit = defaultLimit } = params;

        // Parse channelId to ensure it's a valid ChannelId
        const channelId = createChannelId(channelIdInput);

        // 1. Calculate time range (default: last N days)
        const now = new Date();
        const effectiveEnd = endTime ?? now;
        const effectiveStart = startTime ?? new Date(now.getTime() - defaultTimeRangeDays * 24 * 60 * 60 * 1000);

        // 2. Convert to snowflakes
        const startSnowflake = timestampToSnowflake(effectiveStart);
        const endSnowflake = timestampToSnowflake(effectiveEnd);

        // 3. Get messages from cache
        const cacheResult = await cache.getMessagesInRange(
            channelId,
            createMessageId(startSnowflake),
            createMessageId(endSnowflake)
        );

        // 4. Convert cached messages to DiscordSearchResult format
        let allMessages: DiscordSearchResult[] = _.map(
            cacheResult.messages,
            cached => convertCachedToSearchResult(cached, channelId)
        );

        // 5. Fetch any gaps from Discord API
        for(const gap of cacheResult.gaps) {
            const gapStartTime = snowflakeToTimestamp(gap.start as string);
            const gapEndTime = snowflakeToTimestamp(gap.end as string);

            const fetchResult = await fetcher.fetchMessages({
                channelId,
                startTime: gapStartTime,
                endTime:   gapEndTime,
            });

            // 6. Cache if gap endTime is in the past (closed window)
            if(gapEndTime < now) {
                const cachedMessages = _.map(fetchResult.messages, convertSearchResultToCached);
                await cache.storeMessages(
                    channelId,
                    gap.start,
                    gap.end,
                    cachedMessages
                );
            }

            allMessages = allMessages.concat(fetchResult.messages);
        }

        // 7. Sort by timestamp (oldest first) - snowflakes sort chronologically
        allMessages = _.sortBy(allMessages, 'id');

        // 8. Filter by text query if provided
        if(query) {
            const lowerQuery = _.toLower(query);
            allMessages = _.filter(allMessages, msg =>
                _.includes(_.toLower(msg.content), lowerQuery)
            );
        }

        // 9. Apply limit and handle overflow
        const totalFound = allMessages.length;
        const returnMessages = _.take(allMessages, limit);

        let overflow: SearchResponse['overflow'] = undefined;
        if(allMessages.length > limit) {
            const overflowMessages = _.drop(allMessages, limit);
            const summaries = await summarizer.summarizeMessages(overflowMessages);
            overflow = {
                count: overflowMessages.length,
                summaries,
            };
        }

        return {
            messages: returnMessages,
            overflow,
            metadata: {
                totalFound,
                timeRange: {
                    start: effectiveStart.toISOString(),
                    end:   effectiveEnd.toISOString(),
                },
                query,
            },
        };
    }

    /**
     * Get recent messages (convenience method).
     */
    async function getRecentMessages(channelId: string, limit?: number): Promise<SearchResponse> {
        return searchMessages({
            channelId: createChannelId(channelId),
            limit:     limit ?? defaultLimit,
        });
    }

    /**
     * Get a single message by ID.
     */
    async function getMessageById(channelId: string, messageId: string): Promise<DiscordSearchResult | null> {
        return fetcher.fetchById(channelId, messageId);
    }

    return {
        searchMessages,
        getRecentMessages,
        getMessageById,
    };
}
