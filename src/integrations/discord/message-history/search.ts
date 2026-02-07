/**
 * Message Search Service
 *
 * Orchestrates the fetcher and summarizer to provide comprehensive
 * Discord message search functionality. Handles text filtering,
 * pagination with overflow summaries, and time range queries.
 */

import _ from 'lodash';
import type { z } from 'zod';
import type { MessageFetcher } from '@/integrations/discord/message-history/fetcher';
import type { MessageSummarizer } from '@/integrations/discord/message-history/summarizer';
import { createChannelId } from '@/integrations/discord/types';
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
 * Maximum number of overflow messages to summarize in batches.
 * Beyond this, the response includes a count and hint to narrow the search.
 */
const MAX_OVERFLOW_FOR_SUMMARY = 100;

/**
 * Internal options for controlling search behavior.
 * @internal
 */
interface SearchOptions {
    /** Whether to summarize overflow messages (default: true) */
    summarizeOverflow?: boolean
    /** Maximum number of messages to fetch from Discord API */
    fetchLimit?:        number
}

/**
 * Options for creating a message search service.
 */
export interface MessageSearchServiceOptions {
    /** Message fetcher for Discord API calls */
    fetcher:               MessageFetcher
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
     * Automatically handles overflow summaries.
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

    /**
     * Get multiple messages by IDs.
     *
     * @param channelId - Discord channel ID
     * @param messageIds - Array of Discord message IDs
     * @returns Array of found messages (empty for not found)
     */
    getMessagesById(channelId: string, messageIds: string[]): Promise<DiscordSearchResult[]>
}

/**
 * Creates a message search service that orchestrates fetcher and summarizer.
 *
 * The service fetches messages directly from Discord API and applies filtering:
 * - Messages are fetched from Discord API in the specified time range
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
        summarizer,
        defaultLimit = DEFAULT_LIMIT,
        defaultTimeRangeDays = DEFAULT_TIME_RANGE_DAYS,
    } = options;

    /**
     * Main search implementation.
     */
    async function searchMessages(params: SearchParamsInput, options?: SearchOptions): Promise<SearchResponse> {
        const { channelId: channelIdInput, query, startTime, endTime, limit = defaultLimit } = params;

        // Parse channelId to ensure it's a valid ChannelId
        const channelId = createChannelId(channelIdInput);

        // 1. Calculate time range (default: last N days)
        const now = new Date();
        const effectiveEnd = endTime ?? now;
        const effectiveStart = startTime ?? new Date(now.getTime() - defaultTimeRangeDays * 24 * 60 * 60 * 1000);

        // 2. Fetch messages from Discord API
        const fetchResult = await fetcher.fetchMessages({
            channelId,
            startTime: effectiveStart,
            endTime:   effectiveEnd,
            ...(options?.fetchLimit !== undefined && { limit: options.fetchLimit }),
        });

        // 3. Start with all fetched messages
        let allMessages: DiscordSearchResult[] = fetchResult.messages;

        // 4. Sort by timestamp (oldest first) - snowflakes sort chronologically
        allMessages = _.sortBy(allMessages, 'id');

        // 5. Filter by text query if provided
        // Stryker disable next-line ConditionalExpression: if(true) is equivalent since _.includes(x, '') is always true
        if(query) {
            const lowerQuery = _.toLower(query);
            allMessages = _.filter(allMessages, msg =>
                _.includes(_.toLower(msg.content), lowerQuery)
            );
        }

        // 6. Apply limit and handle overflow
        const totalFound = allMessages.length;
        const returnMessages = _.take(allMessages, limit);

        let overflow: SearchResponse['overflow'] = undefined;
        if(allMessages.length > limit) {
            const overflowMessages = _.drop(allMessages, limit);

            if(options?.summarizeOverflow === false) {
                // Count-only overflow (no Haiku calls)
                overflow = {
                    count: overflowMessages.length,
                    // Stryker disable next-line StringLiteral: Hint message is documentation only
                    hint:  'Use searchMessages with startTime/endTime to get AI summaries of older messages',
                };
            } else {
                // Batch summarization (Fix 3): cap at 100, batch into groups of 10
                const cappedOverflow = _.take(overflowMessages, MAX_OVERFLOW_FOR_SUMMARY);
                const batchSummaries = await summarizer.summarizeMessageBatch(cappedOverflow);
                overflow = {
                    count: overflowMessages.length,
                    batchSummaries,
                    ...(overflowMessages.length > MAX_OVERFLOW_FOR_SUMMARY && {
                        hasMore: true,
                        // Stryker disable next-line StringLiteral: Hint message is documentation only
                        hint:    'Narrow your search with startTime/endTime to see all messages',
                    }),
                };
            }
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
        const effectiveLimit = limit ?? defaultLimit;
        return searchMessages(
            {
                channelId: createChannelId(channelId),
                limit:     effectiveLimit,
            },
            {
                summarizeOverflow: false,
                fetchLimit:        effectiveLimit + 50,
            }
        );
    }

    /**
     * Get a single message by ID.
     */
    async function getMessageById(channelId: string, messageId: string): Promise<DiscordSearchResult | null> {
        return fetcher.fetchById(channelId, messageId);
    }

    /**
     * Get multiple messages by IDs.
     */
    async function getMessagesById(channelId: string, messageIds: string[]): Promise<DiscordSearchResult[]> {
        return fetcher.fetchByIds(channelId, messageIds);
    }

    return {
        searchMessages,
        getRecentMessages,
        getMessageById,
        getMessagesById,
    };
}
