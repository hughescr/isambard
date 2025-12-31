import { z } from 'zod';
import { channelIdSchema, guildIdSchema } from '@/integrations/discord/types';
import { snowflakeSchema } from '@/integrations/discord/message-history/snowflake';

/**
 * Discord author information from a message.
 * Contains the user's ID, username, and display name.
 */
export const discordAuthorSchema = z
    .object({
        /** Discord user ID (snowflake) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        id:          z.string().min(1, 'Author ID cannot be empty'),
        /** Discord username (unique handle) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        username:    z.string().min(1, 'Username cannot be empty'),
        /** Display name (can be server-specific nickname) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        displayName: z.string().min(1, 'Display name cannot be empty'),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Author information from a Discord message');

export type DiscordAuthor = z.infer<typeof discordAuthorSchema>;

/**
 * Discord message attachment.
 * Represents a file attached to a message (image, document, etc.).
 */
export const discordAttachmentSchema = z
    .object({
        /** URL to the attachment file */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        url:         z.string().url('URL must be a valid URL'),
        /** Original filename of the attachment */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        filename:    z.string().min(1, 'Filename cannot be empty'),
        /** MIME type of the attachment (optional) */
        contentType: z.string().optional(),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('File attachment from a Discord message');

export type DiscordAttachment = z.infer<typeof discordAttachmentSchema>;

/**
 * Discord message embed.
 * Rich content cards that can contain titles, descriptions, and links.
 */
export const discordEmbedSchema = z
    .object({
        /** Embed title (optional) */
        title:       z.string().optional(),
        /** Embed description/body text (optional) */
        description: z.string().optional(),
        /** URL linked in the embed (optional) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        url:         z.string().url('URL must be a valid URL').optional(),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Rich embed content from a Discord message');

export type DiscordEmbed = z.infer<typeof discordEmbedSchema>;

/**
 * Discord message reaction.
 * Represents an emoji reaction with its count.
 */
export const discordReactionSchema = z
    .object({
        /** Emoji string (Unicode emoji or custom emoji format like <:name:id>) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        emoji: z.string().min(1, 'Emoji cannot be empty'),
        /** Number of users who reacted with this emoji */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        count: z.number().int().positive('Count must be a positive integer'),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Reaction emoji with count from a Discord message');

export type DiscordReaction = z.infer<typeof discordReactionSchema>;

/**
 * Discord message search result.
 * Full message data returned from searching message history.
 */
export const discordSearchResultSchema = z
    .object({
        /** Message ID (snowflake) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        id:          z.string().min(1, 'Message ID cannot be empty'),
        /** Channel ID where the message was sent */
        channelId:   channelIdSchema,
        /** Guild ID where the message was sent (null for DMs) */
        guildId:     guildIdSchema.nullable(),
        /** Author information */
        author:      discordAuthorSchema,
        /** Message text content */
        content:     z.string(),
        /** ISO 8601 timestamp when the message was created */
        timestamp:   z.string().datetime(),
        /** File attachments on the message */
        attachments: z.array(discordAttachmentSchema),
        /** Rich embeds in the message */
        embeds:      z.array(discordEmbedSchema),
        /** Reactions on the message */
        reactions:   z.array(discordReactionSchema),
        /** Parent message ID if this is a reply (optional) */
        replyTo:     z.string().min(1).optional(),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Full Discord message data from search results');

export type DiscordSearchResult = z.infer<typeof discordSearchResultSchema>;

/**
 * Overflow summary for truncated search results.
 * When search results exceed the limit, older messages are summarized.
 * Synopsis is approximately 50 words generated by Haiku.
 */
export const overflowSummarySchema = z
    .object({
        /** Message ID (snowflake) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        id:        z.string().min(1, 'Message ID cannot be empty'),
        /** ISO 8601 timestamp when the message was created */
        timestamp: z.string().datetime(),
        /** Author's username or display name */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        author:    z.string().min(1, 'Author cannot be empty'),
        /** Brief summary of the message content (~50 words) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        synopsis:  z.string().min(1, 'Synopsis cannot be empty'),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Summarized message for overflow results');

export type OverflowSummary = z.infer<typeof overflowSummarySchema>;

/**
 * Complete search response with messages and metadata.
 * Includes full messages, optional overflow summaries, and search metadata.
 */
export const searchResponseSchema = z
    .object({
        /** Array of full message search results */
        messages: z.array(discordSearchResultSchema),
        /** Overflow information for truncated results (optional) */
        overflow: z
            .object({
                /** Total count of overflow messages */
                // Stryker disable next-line StringLiteral: Error message text is not behavior
                count:     z.number().int().min(0, 'Count cannot be negative'),
                /** Summarized versions of overflow messages */
                summaries: z.array(overflowSummarySchema),
            })
            .optional(),
        /** Metadata about the search operation */
        metadata: z.object({
            /** Total number of messages found */
            totalFound: z.number().int().min(0),
            /** Time range of the search results */
            timeRange:  z.object({
                /** Start of the time range (ISO 8601) */
                start: z.string().datetime(),
                /** End of the time range (ISO 8601) */
                end:   z.string().datetime(),
            }),
            /** Original search query string (optional) */
            query: z.string().optional(),
        }),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Complete search response with messages and metadata');

export type SearchResponse = z.infer<typeof searchResponseSchema>;

/**
 * Search parameters for querying message history.
 * Only channelId is required; all other parameters are optional filters.
 */
export const searchParamsSchema = z
    .object({
        /** Channel ID to search in */
        channelId: channelIdSchema,
        /** Text query to filter messages (optional) */
        query:     z.string().optional(),
        /** Start time for the search range (optional) */
        startTime: z.date().optional(),
        /** End time for the search range (optional) */
        endTime:   z.date().optional(),
        /** Maximum number of messages to return (default: 10, max: 100) */
        limit:     z.number().int().positive().max(100).default(10),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Parameters for searching Discord message history');

export type SearchParams = z.infer<typeof searchParamsSchema>;

/**
 * Cached message segment for DynamoDB storage.
 * Stores a range of messages with TTL for automatic expiration.
 */
export const cachedMessageSegmentSchema = z
    .object({
        /** Channel ID this segment belongs to */
        channelId:      channelIdSchema,
        /** Start of the snowflake range (inclusive) */
        startSnowflake: snowflakeSchema,
        /** End of the snowflake range (inclusive) */
        endSnowflake:   snowflakeSchema,
        /** Array of cached messages in this segment */
        messages:       z.array(discordSearchResultSchema),
        /** ISO 8601 timestamp when this segment was created */
        createdAt:      z.string().datetime(),
        /** Unix timestamp for DynamoDB TTL (seconds since epoch) */
        // Stryker disable next-line StringLiteral: Error message text is not behavior
        ttl:            z.number().int().positive('TTL must be a positive integer'),
    })
    // Stryker disable next-line StringLiteral: describe() is documentation only
    .describe('Cached message segment for DynamoDB storage');

export type CachedMessageSegment = z.infer<typeof cachedMessageSegmentSchema>;
