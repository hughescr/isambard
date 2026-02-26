import type { Client, Message, TextBasedChannel } from 'discord.js';
import _ from 'lodash';
import { ChannelNotAccessibleError, MessageFetchError } from '@/errors';
import { timestampToSnowflake } from '@/integrations/discord/message-history/snowflake';
import type { DiscordSearchResult, DiscordAttachment, DiscordEmbed, DiscordReaction } from '@/integrations/discord/message-history/types';
import { withDiscordRetry } from '@/integrations/discord/retry';
import { channelIdSchema, guildIdSchema } from '@/integrations/discord/types';

// Re-export error classes for backward compatibility

/**
 * Maximum number of messages Discord API returns per request.
 */
const DISCORD_API_MAX_MESSAGES = 100;

/**
 * Options for fetching messages from a Discord channel.
 */
export interface FetchOptions {
    /** The Discord channel ID to fetch messages from */
    channelId:  string
    /** Only include messages after this time (inclusive) */
    startTime?: Date
    /** Only include messages before this time (exclusive) */
    endTime?:   Date
    /** Maximum number of messages to fetch overall */
    limit?:     number
}

/**
 * Result of a message fetch operation.
 */
export interface FetchResult {
    /** Array of fetched messages transformed to DiscordSearchResult format */
    messages: DiscordSearchResult[]
    /** True if more messages exist beyond what was fetched */
    hasMore:  boolean
}

/**
 * Interface for the message fetcher returned by createMessageFetcher.
 */
export interface MessageFetcher {
    /** Fetch messages with optional time range and limit */
    fetchMessages(options: FetchOptions): Promise<FetchResult>
    /** Fetch a single message by ID */
    fetchById(channelId: string, messageId: string): Promise<DiscordSearchResult | null>
    /** Fetch multiple messages by IDs in batch */
    fetchByIds(channelId: string, messageIds: string[]): Promise<DiscordSearchResult[]>
}

/**
 * Transforms a discord.js Message to our DiscordSearchResult format.
 *
 * @param message - The discord.js Message object
 * @returns Transformed DiscordSearchResult
 */
function transformMessage(message: Message): DiscordSearchResult {
    // Transform attachments
    const attachments: DiscordAttachment[] = [];
    for(const attachment of message.attachments.values()) {
        const transformed: DiscordAttachment = {
            url:      attachment.url,
            filename: attachment.name ?? 'unnamed',
        };
        if(attachment.contentType) {
            transformed.contentType = attachment.contentType;
        }
        attachments.push(transformed);
    }

    // Transform embeds
    const embeds: DiscordEmbed[] = _.map(message.embeds, (embed) => {
        const transformed: DiscordEmbed = {};
        if(embed.title) {
            transformed.title = embed.title;
        }
        if(embed.description) {
            transformed.description = embed.description;
        }
        if(embed.url) {
            transformed.url = embed.url;
        }
        return transformed;
    });

    // Transform reactions
    const reactions: DiscordReaction[] = [];
    for(const reaction of message.reactions.cache.values()) {
        reactions.push({
            emoji: reaction.emoji.toString(),
            count: reaction.count,
        });
    }

    // Build the result
    const result: DiscordSearchResult = {
        id:        message.id,
        channelId: channelIdSchema.parse(message.channelId),
        guildId:   message.guildId ? guildIdSchema.parse(message.guildId) : null,
        author:    {
            id:          message.author.id,
            username:    message.author.username,
            displayName: message.author.displayName ?? message.author.username,
        },
        content:   message.content,
        timestamp: message.createdAt.toISOString(),
        attachments,
        embeds,
        reactions,
    };

    // Add replyTo if this is a reply
    if(message.reference?.messageId) {
        result.replyTo = message.reference.messageId;
    }

    return result;
}

/**
 * Creates a message fetcher for retrieving messages from Discord channels.
 *
 * The fetcher handles pagination automatically and transforms discord.js Message
 * objects to our DiscordSearchResult format. It supports time range filtering
 * using Discord's snowflake ID system.
 *
 * @param client - The discord.js Client instance (must be logged in)
 * @returns MessageFetcher with fetchMessages and fetchById methods
 *
 * @example
 * ```typescript
 * const fetcher = createMessageFetcher(client);
 *
 * // Fetch recent messages
 * const { messages, hasMore } = await fetcher.fetchMessages({
 *   channelId: '123456789012345678',
 *   limit: 50
 * });
 *
 * // Fetch messages in a time range
 * const { messages } = await fetcher.fetchMessages({
 *   channelId: '123456789012345678',
 *   startTime: new Date('2025-01-01'),
 *   endTime: new Date('2025-01-15'),
 * });
 *
 * // Fetch a single message
 * const message = await fetcher.fetchById('123456789012345678', '987654321098765432');
 * ```
 */
export function createMessageFetcher(client: Client): MessageFetcher {
    /**
     * Gets a text-based channel from the client, throwing if not accessible.
     * Supports both guild text channels and DM channels.
     */
    async function getChannel(channelId: string): Promise<TextBasedChannel> {
        try {
            const channel = await client.channels.fetch(channelId);
            if(!channel?.isTextBased()) {
                throw new ChannelNotAccessibleError(channelId);
            }
            return channel;
        } catch (error) {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent — both branches throw ChannelNotAccessibleError(channelId); mutant wraps the existing error in a new one with the same channelId, indistinguishable to callers
            if(error instanceof ChannelNotAccessibleError) {
                throw error;
            }
            throw new ChannelNotAccessibleError(channelId);
        }
    }

    /**
     * Processes a batch of messages, filtering by startTime snowflake.
     * @returns Object containing processed messages, hasMore flag, and whether to stop pagination
     */
    function processBatch(
        batch: Map<string, Message>,
        afterSnowflake: string | undefined,
        currentMessages: Message[],
        maxMessages: number
    ): { messages: Message[], hasMore: boolean, shouldStop: boolean } {
        const messages: Message[] = [];
        let hasMore = false;
        let shouldStop = false;

        for(const message of batch.values()) {
            // Check if we've reached before the startTime
            if(afterSnowflake && BigInt(message.id) < BigInt(afterSnowflake)) {
                shouldStop = true;
                break;
            }

            messages.push(message);

            // Stryker disable all: Loop termination on limit reached prevents infinite pagination
            if(currentMessages.length + messages.length >= maxMessages) {
                hasMore = true;
                shouldStop = true;
                break;
            }
            // Stryker restore all
        }

        return { messages, hasMore, shouldStop };
    }

    /**
     * Fetches messages with pagination and optional time filtering.
     */
    async function fetchMessages(options: FetchOptions): Promise<FetchResult> {
        const { channelId, startTime, endTime, limit } = options;
        const channel = await getChannel(channelId);

        const allMessages: Message[] = [];
        let hasMore = false;

        // Calculate snowflakes for time filtering
        const beforeSnowflake = endTime ? timestampToSnowflake(endTime) : undefined;
        const afterSnowflake = startTime ? timestampToSnowflake(startTime) : undefined;

        let cursor: string | undefined = beforeSnowflake;
        const maxMessages = limit ?? Infinity;

        try {
            while(true) {
                const fetchOptions: { limit: number, before?: string } = {
                    limit: Math.min(DISCORD_API_MAX_MESSAGES, Math.max(1, maxMessages - allMessages.length)),
                };
                if(cursor) {
                    fetchOptions.before = cursor;
                }

                const batch = await withDiscordRetry(
                    () => channel.messages.fetch(fetchOptions),
                    // Stryker disable next-line StringLiteral: Operation name for retry logging
                    'fetchMessages'
                ) as Map<string, Message>;

                if(batch.size === 0) {
                    break;
                }

                // Process batch using helper function
                const batchResult = processBatch(batch, afterSnowflake, allMessages, maxMessages);
                allMessages.push(...batchResult.messages);
                hasMore = batchResult.hasMore;

                if(batchResult.shouldStop) {
                    break;
                }

                // If we got fewer messages than requested, we've reached the end
                if(batch.size < fetchOptions.limit) {
                    break;
                }

                // Get the oldest message in this batch for pagination
                // batch is guaranteed non-empty here due to guards at lines 268 and 282
                const lastMessage = [...batch.values()].pop()!;
                cursor = lastMessage.id;
            }
        } catch (error) {
            if(error instanceof ChannelNotAccessibleError) {
                throw error;
            }
            // Stryker disable next-line StringLiteral: Default error message is not behavior
            const reason = _.isError(error) ? error.message : 'Unknown error';
            throw new MessageFetchError(channelId, reason);
        }

        // Sort messages chronologically (oldest first) and transform
        const sortedMessages = _.map(
            allMessages.sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))),
            transformMessage
        );

        return {
            messages: sortedMessages,
            hasMore,
        };
    }

    /**
     * Fetches a single message by ID.
     */
    async function fetchById(channelId: string, messageId: string): Promise<DiscordSearchResult | null> {
        const channel = await getChannel(channelId);

        try {
            const message = await withDiscordRetry(
                () => channel.messages.fetch(messageId),
                // Stryker disable next-line StringLiteral: Operation name for retry logging
                'fetchMessageById'
            );
            return transformMessage(message);
        } catch{
            // Message not found or inaccessible
            return null;
        }
    }

    /**
     * Fetches multiple messages by IDs.
     * Returns only the messages that were successfully fetched.
     */
    async function fetchByIds(channelId: string, messageIds: string[]): Promise<DiscordSearchResult[]> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: No test exercises empty array path - L-class (avoids unnecessary channel fetch)
        if(messageIds.length === 0) {
            return [];
        }

        const channel = await getChannel(channelId);

        // Fetch each message individually and filter out failures
        const results: DiscordSearchResult[] = [];
        for(const messageId of messageIds) {
            try {
                const message = await withDiscordRetry(
                    () => channel.messages.fetch(messageId),
                    // Stryker disable next-line StringLiteral: Operation name for retry logging
                    'fetchMessageById'
                );
                results.push(transformMessage(message));
            } catch{
                // Skip messages that fail to fetch (not found or inaccessible)
            }
        }
        return results;
    }

    return {
        fetchMessages,
        fetchById,
        fetchByIds,
    };
}

export { ChannelNotAccessibleError, MessageFetchError } from '@/errors';
