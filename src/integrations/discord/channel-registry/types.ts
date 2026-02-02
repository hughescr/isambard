import { z } from 'zod';
import { channelIdSchema, guildIdSchema } from '../types';

/**
 * Well-known channel types that have special meaning in the system.
 */
export const wellKnownChannelSchema = z.enum(['general', 'catch-up', 'perch-time', 'fallback']);

export type WellKnownChannel = z.infer<typeof wellKnownChannelSchema>;

/**
 * Array of all well-known channel types.
 */
export const WELL_KNOWN_CHANNELS: readonly WellKnownChannel[] = [
    'general',
    'catch-up',
    'perch-time',
    'fallback',
] as const;

/**
 * Minimal channel data stored in DynamoDB.
 * Contains only Izzy-specific metadata - channel info fetched from Discord API.
 */
export const channelStorageRecordSchema = z.object({
    /** Discord channel ID */
    channelId:   channelIdSchema,
    /** Guild ID or 'DM' for direct messages */
    guildId:     z.union([guildIdSchema, z.literal('DM')]),
    /** Whether the channel is muted (defaults to false) */
    isMuted:     z.boolean().default(false),
    /** Optional well-known channel designation */
    isWellKnown: wellKnownChannelSchema.optional(),
    /** ISO 8601 timestamp when the record was created */
    createdAt:   z.iso.datetime(),
    /** ISO 8601 timestamp when the record was last updated */
    updatedAt:   z.iso.datetime(),
});

export type ChannelStorageRecord = z.infer<typeof channelStorageRecordSchema>;

/**
 * Full channel metadata for runtime use.
 * Merges stored data with channel info from Discord API.
 */
export const channelMetadataSchema = z.object({
    /** Discord channel ID */
    channelId:    channelIdSchema,
    /** Guild ID or 'DM' for direct messages */
    guildId:      z.union([guildIdSchema, z.literal('DM')]),
    /** Human-readable channel name (from Discord API) */
    channelName:  z.string().min(1),
    /** Whether the channel is muted (from storage) */
    isMuted:      z.boolean().default(false),
    /** Optional well-known channel designation (from storage) */
    isWellKnown:  wellKnownChannelSchema.optional(),
    /** ISO 8601 timestamp when the channel was first discovered */
    discoveredAt: z.iso.datetime(),
    /** ISO 8601 timestamp when the channel was last seen active */
    lastSeenAt:   z.iso.datetime(),
    /** ISO 8601 timestamp when the metadata was last updated */
    updatedAt:    z.iso.datetime(),
});

export type ChannelMetadata = z.infer<typeof channelMetadataSchema>;

/**
 * Creates a validated ChannelMetadata object from unknown data.
 * @throws {z.ZodError} If the data is invalid
 */
export function createChannelMetadata(data: unknown): ChannelMetadata {
    return channelMetadataSchema.parse(data);
}

/**
 * Type guard to check if a value is a valid ChannelMetadata.
 */
export function isChannelMetadata(value: unknown): value is ChannelMetadata {
    const result = channelMetadataSchema.safeParse(value);
    return result.success;
}
