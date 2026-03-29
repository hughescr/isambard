import { z } from 'zod';
import { AttachmentMetadataSchema } from './attachments/types';
// eslint-disable-next-line boundaries/dependencies -- direct import from agent/types.ts breaks circular dep: discord/types → @/agent → discord-mcp-server → @/integrations/discord
import { channelIdSchema, userIdSchema } from '@/agent/types';
import { guildIdSchema, type GuildId  } from '@/config';

// eslint-disable-next-line boundaries/dependencies -- direct re-export from agent/types.ts breaks circular dep (see import above)
export { channelIdSchema, type ChannelId, userIdSchema, type UserId, createChannelId, createUserId, isChannelId, isUserId } from '@/agent/types';
export { guildIdSchema, type GuildId } from '@/config';

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
    /** Discord username (e.g. 'craig') — used for contact lookup and cross-platform history */
    username:    z.string().optional(),
    messageId:   z.string().min(1),
    content:     z.string(),
    timestamp:   z.iso.datetime(),
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
 * Type guard to check if a value is a valid MessageId.
 */
export function isMessageId(value: unknown): value is MessageId {
    const result = messageIdSchema.safeParse(value);
    return result.success;
}
