import { z } from 'zod';

/** Validated, platform-agnostic identifiers shared by configuration and the session bridge. */
export const channelIdSchema = z.string().min(1, 'Channel ID cannot be empty').brand<'ChannelId'>();
export type ChannelId = z.infer<typeof channelIdSchema>;

export const userIdSchema = z.string().min(1, 'User ID cannot be empty').brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;
