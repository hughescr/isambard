// Stryker disable StringLiteral: All .describe() calls in this file are documentation only
import { z } from 'zod';
import { channelIdSchema, guildIdSchema } from '@/integrations/discord/types';
import { snowflakeSchema } from '@/integrations/discord/message-history/snowflake';

/**
 * Discord channel checkpoint schema.
 * Stores the last-seen state for a channel to track unread messages.
 * Used to determine which messages are "new" since the bot's last activity.
 */
export const discordChannelCheckpointSchema = z
    .object({
        /** Service identifier (always 'discord') */
        service:           z.literal('discord'),
        /** Discord channel ID where the checkpoint was created */
        channelId:         channelIdSchema,
        /** Guild ID where the channel exists, or 'DM' for direct messages */
        guildId:           z.union([guildIdSchema, z.literal('DM')]),
        /** ISO 8601 timestamp when the channel was last seen */
        lastSeenAt:        z.string().datetime(),
        /** Discord message ID (snowflake) of the last seen message (optional) */
        lastSeenMessageId: snowflakeSchema.optional(),
        /** ISO 8601 timestamp when this checkpoint was last updated */
        updatedAt:         z.string().datetime(),
    })
    .describe('Last-seen checkpoint for a Discord channel');

export type DiscordChannelCheckpoint = z.infer<typeof discordChannelCheckpointSchema>;

/**
 * Unread message schema.
 * Represents a single unread message from a Discord channel.
 */
export const unreadMessageSchema = z
    .object({
        /** Discord message ID (snowflake) */
        id:          snowflakeSchema,
        /** Channel ID where the message was sent */
        channelId:   channelIdSchema,
        /** Human-readable channel name */
        channelName: z.string().min(1, 'Channel name cannot be empty'),
        /** Guild ID where the channel exists, or 'DM' for direct messages */
        guildId:     z.union([guildIdSchema, z.literal('DM')]),
        /** Author's display name */
        author:      z.string().min(1, 'Author cannot be empty'),
        /** Message text content */
        content:     z.string(),
        /** ISO 8601 timestamp when the message was created */
        timestamp:   z.string().datetime(),
        /** Whether the message has been marked as read */
        isRead:      z.boolean(),
    })
    .describe('Single unread message from a Discord channel');

export type UnreadMessage = z.infer<typeof unreadMessageSchema>;

/**
 * Channel summary schema.
 * Provides an overview of unread messages in a channel without full message content.
 */
export const channelSummarySchema = z
    .object({
        /** Discord channel ID */
        channelId:    channelIdSchema,
        /** Human-readable channel name */
        channelName:  z.string().min(1, 'Channel name cannot be empty'),
        /** Number of unread messages in the channel */
        messageCount: z.number().int().positive('Message count must be positive'),
        /** Unique authors who sent messages in this channel */
        authors:      z.array(z.string().min(1)),
        /** Time range spanning the unread messages */
        timeRange:    z.object({
            /** ISO 8601 timestamp of the first unread message */
            start: z.string().datetime(),
            /** ISO 8601 timestamp of the last unread message */
            end:   z.string().datetime(),
        }),
        /** Preview of the first message content (approximately 100 characters) */
        preview: z.string().max(100, 'Preview must not exceed 100 characters'),
    })
    .describe('Summary of unread messages in a Discord channel');

export type ChannelSummary = z.infer<typeof channelSummarySchema>;

/**
 * Message metadata schema.
 * Lightweight metadata for message selection in channel summaries.
 * Used to help the agent decide which messages to read in full.
 */
export const messageMetadataSchema = z
    .object({
        /** Discord message ID (snowflake) */
        id:        snowflakeSchema,
        /** Author's display name */
        author:    z.string().min(1, 'Author cannot be empty'),
        /** ISO 8601 timestamp when the message was created */
        timestamp: z.string().datetime(),
        /** Character count of the message content */
        sizeChars: z.number().int().min(0, 'Size cannot be negative'),
    })
    .describe('Lightweight message metadata for selection');

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * Channel summary response schema.
 * Full response from the getChannelSummary MCP tool.
 * Includes AI-generated summary and message metadata for selective reading.
 */
export const channelSummaryResponseSchema = z
    .object({
        /** Discord channel ID */
        channelId:    channelIdSchema,
        /** Human-readable channel name */
        channelName:  z.string().min(1, 'Channel name cannot be empty'),
        /** Total number of unread messages in the channel */
        messageCount: z.number().int().min(0, 'Message count cannot be negative'),
        /** AI-generated summary of the unread messages (Haiku-generated) */
        summary:      z.string().min(1, 'Summary cannot be empty'),
        /** Unique authors who sent messages in this channel */
        authors:      z.array(z.string().min(1)),
        /** Time range spanning the unread messages */
        timeRange:    z.object({
            /** ISO 8601 timestamp of the first unread message */
            start: z.string().datetime(),
            /** ISO 8601 timestamp of the last unread message */
            end:   z.string().datetime(),
        }),
        /** Array of message metadata for selective reading */
        messages: z.array(messageMetadataSchema),
    })
    .describe('Full channel summary response from getChannelSummary tool');

export type ChannelSummaryResponse = z.infer<typeof channelSummaryResponseSchema>;

/**
 * Unread overview schema.
 * Response from the getUnreadOverview MCP tool.
 * Provides a high-level view of all unread messages across channels.
 */
export const unreadOverviewSchema = z
    .object({
        /** Total number of unread messages across all channels */
        totalUnread: z.number().int().min(0, 'Total unread cannot be negative'),
        /** Array of channel summaries with message counts */
        channels:    z.array(
            z.object({
                /** Discord channel ID */
                channelId:    channelIdSchema,
                /** Human-readable channel name */
                channelName:  z.string().min(1, 'Channel name cannot be empty'),
                /** Number of unread messages in this channel */
                messageCount: z.number().int().min(0, 'Message count cannot be negative'),
            })
        ),
    })
    .describe('Overview of unread messages across all channels');

export type UnreadOverview = z.infer<typeof unreadOverviewSchema>;
