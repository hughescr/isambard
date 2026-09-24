import { z } from 'zod';
import { channelIdSchema, guildIdSchema } from '@/integrations/discord/types';

/**
 * Discord author information from a message.
 * Contains the user's ID, username, and display name.
 */
export const discordAuthorSchema = z
    .object({
        /** Discord user ID (snowflake) */
        id:          z.string().min(1, 'Author ID cannot be empty'),
        /** Discord username (unique handle) */
        username:    z.string().min(1, 'Username cannot be empty'),
        /** Display name (can be server-specific nickname) */
        displayName: z.string().min(1, 'Display name cannot be empty'),
    })
    .describe('Author information from a Discord message');

export type DiscordAuthor = z.infer<typeof discordAuthorSchema>;

/**
 * Discord message attachment.
 * Represents a file attached to a message (image, document, etc.).
 */
export const discordAttachmentSchema = z
    .object({
        /** URL to the attachment file */
        url:         z.url('URL must be a valid URL'),
        /** Original filename of the attachment */
        filename:    z.string().min(1, 'Filename cannot be empty'),
        /** MIME type of the attachment (optional) */
        contentType: z.string().optional(),
    })
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
        url:         z.url('URL must be a valid URL').optional(),
    })
    .describe('Rich embed content from a Discord message');

export type DiscordEmbed = z.infer<typeof discordEmbedSchema>;

/**
 * Discord message reaction.
 * Represents an emoji reaction with its count.
 */
export const discordReactionSchema = z
    .object({
        /** Emoji string (Unicode emoji or custom emoji format like <:name:id>) */
        emoji: z.string().min(1, 'Emoji cannot be empty'),
        /** Number of users who reacted with this emoji */
        count: z.number().int().positive('Count must be a positive integer'),
    })
    .describe('Reaction emoji with count from a Discord message');

export type DiscordReaction = z.infer<typeof discordReactionSchema>;

/**
 * Discord message search result.
 * Full message data returned from searching message history.
 */
export const discordSearchResultSchema = z
    .object({
        /** Message ID (snowflake) */
        id:             z.string().min(1, 'Message ID cannot be empty'),
        /** Channel ID where the message was sent */
        channelId:      channelIdSchema,
        /** Guild ID where the message was sent (null for DMs) */
        guildId:        guildIdSchema.nullable(),
        /** Author information */
        author:         discordAuthorSchema,
        /** Message text content */
        content:        z.string(),
        /** ISO 8601 timestamp when the message was created */
        timestamp:      z.iso.datetime(),
        /** File attachments on the message */
        attachments:    z.array(discordAttachmentSchema),
        /** Rich embeds in the message */
        embeds:         z.array(discordEmbedSchema),
        /** Reactions on the message */
        reactions:      z.array(discordReactionSchema),
        /** Parent message ID if this is a reply (optional) */
        replyTo:        z.string().min(1).optional(),
        /** Local timezone timestamp (optional, added when timezone is resolved) */
        localTimestamp: z.string().optional(),
    })
    .describe('Full Discord message data from search results');

export type DiscordSearchResult = z.infer<typeof discordSearchResultSchema>;

/**
 * Batch overflow summary grouping multiple messages.
 * When search results have overflow, messages are batched into groups
 * for efficient summarization (one Haiku call per batch instead of per message).
 */
export const batchOverflowSummarySchema = z
    .object({
        /** ISO 8601 timestamp of the earliest message in the batch */
        startTimestamp: z.iso.datetime(),
        /** ISO 8601 timestamp of the latest message in the batch */
        endTimestamp:   z.iso.datetime(),
        /** Number of messages in this batch */
        messageCount:   z.number().int().positive(),
        /** Unique authors in this batch */
        authors:        z.array(z.string().min(1)),
        /** Brief summary of the batch content */
        synopsis:       z.string().min(1, 'Synopsis cannot be empty'),
    })
    .describe('Batch summary grouping multiple overflow messages');

export type BatchOverflowSummary = z.infer<typeof batchOverflowSummarySchema>;

/** Count-only overflow, used when returning the newest page of recent history. */
const countOnlyOverflowSchema = z
    .object({
        mode:  z.literal('count-only'),
        count: z.number().int().min(0, 'Count cannot be negative'),
        hint:  z.string().optional(),
    })
    .strict();

/** Summarized overflow, used when returning the oldest page of text search results. */
const summarizedOverflowSchema = z
    .object({
        mode:            z.literal('summarized'),
        count:           z.number().int().min(0, 'Count cannot be negative'),
        batchSummaries:  z.array(batchOverflowSummarySchema),
        summarizedCount: z.number().int().min(0, 'Summarized count cannot be negative'),
        hint:            z.string().optional(),
    })
    .strict()
    .refine(value => value.summarizedCount <= value.count, {
        message: 'Summarized count cannot exceed overflow count',
        path:    ['summarizedCount'],
    });

/**
 * Complete search response with explicit coverage boundaries.
 * Coverage describes the channel interval versus the fetched set, overflow describes
 * the fetched set versus the returned page, and summarizedCount describes the portion
 * of overflow represented by Haiku summaries.
 */
export const searchResponseSchema = z
    .object({
        /** Array of full message search results */
        messages: z.array(discordSearchResultSchema),
        /** Overflow from the fetched set which is not present in messages */
        overflow: z.discriminatedUnion('mode', [countOnlyOverflowSchema, summarizedOverflowSchema]).optional(),
        /** Metadata about the search operation and fetched-set coverage */
        metadata: z.object({
            /** Whether Discord pagination completed the requested channel interval */
            coverage:         z.enum(['complete', 'limitReached']),
            /** Number of source messages fetched before text-query filtering */
            fetched:          z.number().int().min(0),
            /** Number of fetched messages which matched the text query */
            matchedInFetched: z.number().int().min(0),
            /** Time range of the search results */
            timeRange:        z.object({
                /** Start of the time range (ISO 8601) */
                start: z.iso.datetime(),
                /** End of the time range (ISO 8601) */
                end:   z.iso.datetime(),
            }),
            /** Original search query string (optional) */
            query: z.string().optional(),
        }),
    })
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
    .describe('Parameters for searching Discord message history');
