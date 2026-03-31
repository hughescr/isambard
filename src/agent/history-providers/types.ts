import { z } from 'zod';
import type { PlatformType } from '@/storage';

/**
 * Direction of a history interaction.
 * - 'inbound':  received from the person
 * - 'outbound': sent to the person
 * - 'mutual':   mutual interaction (e.g. a reaction, or a shared thread)
 */
// Stryker disable all: Enum values are static definitions
const directionSchema = z.enum(['inbound', 'outbound', 'mutual']);
// Stryker restore all

type Direction = z.infer<typeof directionSchema>;

/**
 * A single history interaction entry across any platform.
 */
// Stryker disable MethodExpression: .min(1) constraints are schema configuration, not logic under test
export const historyEntrySchema = z.object({
    platform:  z.string().min(1),
    timestamp: z.iso.datetime(),
    summary:   z.string().min(1),
    direction: directionSchema,
});
// Stryker restore MethodExpression

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * Parameters passed to a PlatformHistoryProvider when fetching history.
 */
export interface HistoryFetchParams {
    /** Platform-specific identifier (email address, Discord username, Bluesky handle, etc.) */
    identifier:   string
    /** Maximum number of messages to return. Defaults to 10. */
    maxMessages?: number
    /** Start of the time window. */
    startTime?:   Date
    /** End of the time window. */
    endTime?:     Date
    /** Platform-specific extras (channelId, convoId, etc.) */
    metadata?:    Record<string, string>
}

/**
 * Interface for platform-specific history providers.
 * Each platform (Discord, email, Bluesky, etc.) implements this interface.
 */
export interface PlatformHistoryProvider {
    /** Platform identifier string (e.g. 'discord', 'email', 'bsky') */
    readonly platform: string
    /** Fetch history for a given identifier within the specified time window. */
    fetchHistory(params: HistoryFetchParams): Promise<HistoryEntry[]>
}

/**
 * Options for the PersonHistoryCoordinator methods.
 */
export interface PersonHistoryOptions {
    /** Maximum messages to fetch per platform. Defaults to 10 (auto) or 20 (MCP tool). */
    maxMessagesPerPlatform?: number
    /** Maximum total entries in the merged result. Defaults to 30 (auto) or 50 (MCP tool). */
    maxTotalEntries?:        number
    /** Time window in minutes looking back from endTime. Used when startTime/endTime not provided. Defaults to 120 (auto) or 10080/7d (MCP tool). */
    timeWindowMinutes?:      number
    /** Maximum characters in the formatted output. Defaults to 12000 (~3000 tokens). */
    maxCharacters?:          number
    /** Absolute start of the time window. Overrides timeWindowMinutes when provided. */
    startTime?:              Date
    /** Absolute end of the time window. Defaults to now when not provided. */
    endTime?:                Date
    /** Optional platform hint for direct identifier resolution (avoids fuzzy scan). */
    platformHint?:           PlatformType
}

// Default values for PersonHistoryOptions
export const DEFAULT_MAX_MESSAGES_PER_PLATFORM = 10;
export const DEFAULT_MAX_TOTAL_ENTRIES = 30;
export const DEFAULT_TIME_WINDOW_MINUTES = 120;
export const DEFAULT_MAX_CHARACTERS = 12_000;
