import { z } from 'zod';
import { channelIdSchema, type ChannelId } from '@/integrations/discord/types';

/**
 * MessageId is a branded type representing a Discord message ID (snowflake).
 * Discord message IDs are snowflakes - unique 64-bit integers represented as strings.
 */
export const messageIdSchema = z
    .string()
    .min(1, 'Message ID cannot be empty')
    .brand<'MessageId'>();

export type MessageId = z.infer<typeof messageIdSchema>;

/**
 * Creates a validated MessageId from a string.
 * @throws {z.ZodError} If the message ID is invalid
 */
export function createMessageId(id: string): MessageId {
    return messageIdSchema.parse(id);
}

/**
 * Type guard to check if a value is a valid MessageId.
 */
export function isMessageId(value: unknown): value is MessageId {
    const result = messageIdSchema.safeParse(value);
    return result.success;
}

/**
 * Cached Discord message schema.
 * Represents the essential fields of a Discord message stored in the cache.
 */
export const cachedMessageSchema = z.object({
    id:        messageIdSchema,
    content:   z.string(),
    authorId:  z.string().min(1),
    timestamp: z.string().datetime(),
});

export type CachedMessage = z.infer<typeof cachedMessageSchema>;

/**
 * Cached segment schema.
 * Represents a contiguous range of messages from a Discord channel.
 */
export const cachedSegmentSchema = z.object({
    channelId:      channelIdSchema,
    startSnowflake: messageIdSchema,
    endSnowflake:   messageIdSchema,
    messages:       z.array(cachedMessageSchema),
    fetchedAt:      z.string().datetime(),
});

export type CachedSegmentData = z.infer<typeof cachedSegmentSchema>;

/**
 * DynamoDB item structure for cached segments.
 */
export interface CachedSegmentItem extends CachedSegmentData {
    PK: string   // CHANNEL#{channelId}
    SK: string   // SEGMENT#{startSnowflake}#{endSnowflake}
}

/**
 * Gap in cached message coverage.
 * Represents a range that needs to be fetched from Discord API.
 */
export interface CacheGap {
    start: MessageId
    end:   MessageId
}

// Re-export ChannelId for convenience
export { channelIdSchema, type ChannelId };
