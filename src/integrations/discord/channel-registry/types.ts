import { z } from 'zod';
import { channelIdSchema, guildIdSchema } from '../types';

/**
 * Well-known channel types that have special meaning in the system.
 */
export const wellKnownChannelSchema = z.enum(['general', 'catch-up', 'perch-time']);

export type WellKnownChannel = z.infer<typeof wellKnownChannelSchema>;

/**
 * Array of all well-known channel types.
 */
export const WELL_KNOWN_CHANNELS: readonly WellKnownChannel[] = [
    'general',
    'catch-up',
    'perch-time',
] as const;

/**
 * Channel metadata schema for tracking channel information.
 * Includes mute state, well-known designations, and discovery timestamps.
 */
export const channelMetadataSchema = z.object({
    /** Discord channel ID */
    channelId:    channelIdSchema,
    /** Guild ID or 'DM' for direct messages */
    guildId:      z.union([guildIdSchema, z.literal('DM')]),
    /** Human-readable channel name */
    channelName:  z.string().min(1),
    /** Whether the channel is muted (defaults to false) */
    isMuted:      z.boolean().default(false),
    /** Optional well-known channel designation */
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
 * Channel reference schema for disambiguating channels with the same name.
 * Includes optional guild name for display purposes.
 */
export const channelReferenceSchema = z.object({
    /** Human-readable channel name */
    channelName: z.string().min(1),
    /** Optional guild name for disambiguation */
    guildName:   z.string().optional(),
    /** Discord channel ID */
    channelId:   channelIdSchema,
    /** Guild ID or 'DM' for direct messages */
    guildId:     z.union([guildIdSchema, z.literal('DM')]),
});

export type ChannelReference = z.infer<typeof channelReferenceSchema>;

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
