import { z } from 'zod';

/** Validated, platform-agnostic identifiers shared by configuration and the session bridge. */
export const channelIdSchema = z.string().min(1, 'Channel ID cannot be empty').brand<'ChannelId'>();
export type ChannelId = z.infer<typeof channelIdSchema>;

export const userIdSchema = z.string().min(1, 'User ID cannot be empty').brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

/**
 * A Discord-issued id (channel, message, user or guild) as Discord sends it: a decimal snowflake.
 * Unlike {@link channelIdSchema} this is Discord-specific, for data that only ever holds ids read
 * off Discord objects (e.g. the approval card a click came from). The pattern also rejects `''`.
 */
export const discordSnowflakeSchema = z.string().regex(/^\d+$/, 'Discord ID must be a decimal snowflake');
