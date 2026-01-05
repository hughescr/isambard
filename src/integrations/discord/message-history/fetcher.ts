import _ from 'lodash';
import type { Client, Message, TextChannel } from 'discord.js';
import { DiscordIntegrationError } from '@/integrations/discord/errors';
import { timestampToSnowflake } from '@/integrations/discord/message-history/snowflake';
import type { DiscordSearchResult, DiscordAttachment, DiscordEmbed, DiscordReaction } from '@/integrations/discord/message-history/types';
import { channelIdSchema, guildIdSchema } from '@/integrations/discord/types';
import { withDiscordRetry } from '@/integrations/discord/retry';

/**
 * Maximum number of messages Discord API returns per request.
 */
const DISCORD_API_MAX_MESSAGES = 100;

/**
 * Error thrown when a Discord channel cannot be accessed.
 * This can happen when the channel doesn't exist or the bot lacks permissions.
 */
export class ChannelNotAccessibleError extends DiscordIntegrationError {
    constructor(public readonly channelId: string) {
        // Stryker disable next-line StringLiteral: Error message and error code are not behavior
        super(`Discord channel not accessible: ${channelId}`, 'CHANNEL_NOT_ACCESSIBLE');
        // Stryker disable next-line StringLiteral: Error class name is not behavior
        this.name = 'ChannelNotAccessibleError';
    }
}

/**
 * Error thrown when message fetching fails.
 * Wraps generic errors during Discord API message fetch operations.
 */
export class MessageFetchError extends DiscordIntegrationError {
    constructor(
        public readonly channelId: string,
        public readonly reason: string
    ) {
        // Stryker disable next-line StringLiteral: Error message and error code are not behavior
        super(`Failed to fetch messages from channel ${channelId}: ${reason}`, 'MESSAGE_FETCH_ERROR');
        // Stryker disable next-line StringLiteral: Error class name is not behavior
        this.name = 'MessageFetchError';
    }
}

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
            filename: attachment.name,
        };
        if(attachment.contentType) {
            transformed.contentType = attachment.contentType;
        }
        attachments.push(transformed);
    }

    // Transform embeds
    const embeds: DiscordEmbed[] = _.map(message.embeds, (embed) => {
        const transformed: DiscordEmbed = {};
        // Stryker disable next-line ConditionalExpression: Falsy check filters undefined/null
        if(embed.title) {
            transformed.title = embed.title;
        }
        // Stryker disable next-line ConditionalExpression: Falsy check filters undefined/null
        if(embed.description) {
            transformed.description = embed.description;
        }
        // Stryker disable next-line ConditionalExpression: Falsy check filters undefined/null
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
            displayName: message.author.displayName,
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
     * Gets a text channel from the client, throwing if not accessible.
     */
    async function getChannel(channelId: string): Promise<TextChannel> {
        try {
            const channel = await client.channels.fetch(channelId);
            if(!channel) {
                throw new ChannelNotAccessibleError(channelId);
            }
            return channel as TextChannel;
        } catch (error) {
            // Stryker disable next-line ConditionalExpression,BlockStatement: Re-throwing original error preserves stack trace
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

            if(currentMessages.length + messages.length >= maxMessages) {
                hasMore = true;
                shouldStop = true;
                break;
            }
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
                    'fetchMessages'
                );

                // Stryker disable next-line ConditionalExpression,BlockStatement: Empty batch check terminates pagination loop early; break is redundant with line 277 but clearer
                if(batch.size === 0) {
                    break;
                }

                // Process batch using helper function
                const batchResult = processBatch(batch as unknown as Map<string, Message>, afterSnowflake, allMessages, maxMessages);
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
                const lastMessage = [...batch.values()].pop();
                if(lastMessage) {
                    cursor = lastMessage.id;
                } else {
                    break;
                }
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
        // Stryker disable next-line BlockStatement: Early return for empty array avoids unnecessary channel fetch
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
