import { z } from 'zod';
import { AttachmentMetadataSchema } from './attachments/types';

/**
 * GuildId is a branded type representing a Discord guild (server) ID.
 */
export const guildIdSchema = z
    .string()
    .min(1, 'Guild ID cannot be empty')
    .brand<'GuildId'>();

export type GuildId = z.infer<typeof guildIdSchema>;

/**
 * ChannelId is a branded type representing a Discord channel ID.
 */
export const channelIdSchema = z
    .string()
    .min(1, 'Channel ID cannot be empty')
    .brand<'ChannelId'>();

export type ChannelId = z.infer<typeof channelIdSchema>;

/**
 * UserId is a branded type representing a Discord user ID.
 */
export const userIdSchema = z
    .string()
    .min(1, 'User ID cannot be empty')
    .brand<'UserId'>();

export type UserId = z.infer<typeof userIdSchema>;

/**
 * MessageId is a branded type representing a Discord message ID.
 */
export const messageIdSchema = z
    .string()
    .min(1, 'MessageId cannot be empty')
    // Stryker disable next-line StringLiteral: brand name is not behavior-affecting
    .brand<'MessageId'>();

export type MessageId = z.infer<typeof messageIdSchema>;

/**
 * Discord message context schema with Zod validation.
 * Represents the full context of a Discord message for processing.
 */
export const discordMessageContextSchema = z.object({
    guildId:     guildIdSchema,
    channelId:   channelIdSchema,
    userId:      userIdSchema,
    messageId:   z.string().min(1),
    content:     z.string(),
    timestamp:   z.string().datetime(),
    /** The bot's own user ID (for self-awareness in memory operations) */
    botUserId:   userIdSchema,
    /** Optional attachments metadata from the message */
    attachments: z.array(AttachmentMetadataSchema).optional(),
});

export type DiscordMessageContext = z.infer<typeof discordMessageContextSchema>;

/**
 * Creates a validated GuildId from a string.
 * @throws {z.ZodError} If the guild ID is invalid
 */
export function createGuildId(id: string): GuildId {
    return guildIdSchema.parse(id);
}

/**
 * Creates a validated ChannelId from a string.
 * @throws {z.ZodError} If the channel ID is invalid
 */
export function createChannelId(id: string): ChannelId {
    return channelIdSchema.parse(id);
}

/**
 * Creates a validated UserId from a string.
 * @throws {z.ZodError} If the user ID is invalid
 */
export function createUserId(id: string): UserId {
    return userIdSchema.parse(id);
}

/**
 * Creates a validated MessageId from a string.
 * @throws {z.ZodError} If the message ID is invalid
 */
export function createMessageId(id: string): MessageId {
    return messageIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid GuildId.
 */
export function isGuildId(value: unknown): value is GuildId {
    const result = guildIdSchema.safeParse(value);
    return result.success;
}

/**
 * Type guard to check if a value is a valid ChannelId.
 */
export function isChannelId(value: unknown): value is ChannelId {
    const result = channelIdSchema.safeParse(value);
    return result.success;
}

/**
 * Type guard to check if a value is a valid UserId.
 */
export function isUserId(value: unknown): value is UserId {
    const result = userIdSchema.safeParse(value);
    return result.success;
}

/**
 * Type guard to check if a value is a valid MessageId.
 */
export function isMessageId(value: unknown): value is MessageId {
    const result = messageIdSchema.safeParse(value);
    return result.success;
}
