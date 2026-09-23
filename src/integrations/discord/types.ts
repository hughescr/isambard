import type { Message } from 'discord.js';
import { z } from 'zod';
import { AttachmentMetadataSchema } from './attachments/types';
// eslint-disable-next-line boundaries/dependencies -- direct import from agent/types.ts breaks circular dep: discord/types → @/agent → discord-mcp-server → @/integrations/discord
import { channelIdSchema, userIdSchema } from '@/agent/types';
import { guildIdSchema, type GuildId  } from '@/config';

// eslint-disable-next-line boundaries/dependencies -- direct re-export from agent/types.ts breaks circular dep (see import above)
export { channelIdSchema, type ChannelId, userIdSchema, type UserId, createChannelId, createUserId, isChannelId, isUserId } from '@/agent/types';
export { guildIdSchema, type GuildId } from '@/config';

/** Fixed channel scope for direct messages, which do not have a Discord guild. */
export const DM_SCOPE = 'DM' as const;

/** A channel's Discord guild or the direct-message scope sentinel. */
export type ChannelScope = GuildId | typeof DM_SCOPE;

/** Schema for a channel's guild or direct-message scope. */
export const channelScopeSchema = z.union([guildIdSchema, z.literal(DM_SCOPE)]);

/** Returns whether a channel scope represents a direct message. */
export function isDmScope(scope: ChannelScope): scope is typeof DM_SCOPE {
    return scope === DM_SCOPE;
}

/** Derives a channel scope from a Discord message. */
export function scopeOf(message: Message): ChannelScope {
    return message.guild ? createGuildId(message.guild.id) : DM_SCOPE;
}

/**
 * Discord message context schema with Zod validation.
 * Represents the full context of a Discord message for processing.
 */
export const discordMessageContextSchema = z.object({
    guildId:     channelScopeSchema,
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
 * Type guard to check if a value is a valid GuildId.
 */
export function isGuildId(value: unknown): value is GuildId {
    const result = guildIdSchema.safeParse(value);
    return result.success;
}
