import { z } from 'zod';
import type { ServiceErrorCategory } from '@/services';
import type { Contact, PlatformType } from '@/storage';

/**
 * Direction of a history interaction.
 * - 'inbound':  received from the person
 * - 'outbound': sent to the person
 * - 'mutual':   mutual interaction (e.g. a reaction, or a shared thread)
 */
const directionSchema = z.enum(['inbound', 'outbound', 'mutual']);

/**
 * The set of known history platforms. Adding a new platform here will
 * cause compile errors in the coordinator's platformLabel and buildHistoryScope
 * switches until they are updated.
 */
const knownPlatformSchema = z.enum(['discord', 'email', 'bsky']);

/** Literal union of all known history platform identifiers. */
export type KnownPlatform = z.infer<typeof knownPlatformSchema>;

/**
 * A single history interaction entry across any platform.
 */
export const historyEntrySchema = z.object({
    platform:  knownPlatformSchema,
    timestamp: z.iso.datetime(),
    summary:   z.string().min(1),
    direction: directionSchema,
});

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * Every known history platform, in canonical order. The coordinator derives
 * `coverage.notConfigured` from this list minus the registered providers.
 */
export const KNOWN_HISTORY_PLATFORMS: readonly KnownPlatform[] = knownPlatformSchema.options;

/**
 * Discord scope: the contact has a known Discord user, so the provider also
 * searches the direct-message channel in addition to the guild channels.
 */
export interface DiscordHistoryScope {
    platform:      'discord'
    discordUserId: string
}

/**
 * Bluesky scope: which Bluesky source the provider reads.
 * - `author-feed`:         the person's public posts.
 * - `direct-conversation`: the DM conversation containing `participantDid`.
 *
 * There is no self-DID field: nothing produces one, so DM entries are
 * reported with `'mutual'` direction rather than guessing inbound/outbound.
 */
export type BskyHistoryQuery
    = | { platform: 'bsky', kind: 'author-feed' }
      | { platform: 'bsky', kind: 'direct-conversation', participantDid: string };

/** Typed per-platform history scope; email needs none. */
export type HistoryScope = DiscordHistoryScope | BskyHistoryQuery;

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
    /** Platform-specific scope built by the coordinator from the contact's internal fields. */
    scope?:       HistoryScope
}

/**
 * Why a history source could not be read. Reuses the service-health
 * vocabulary; `'transient'` marks a backend call that threw.
 */
export type HistoryFailureCategory = ServiceErrorCategory | 'transient';

/**
 * One history source (a mailbox search, a Discord channel, a Bluesky feed)
 * that could not be read. `error` is internal diagnostic detail and must
 * never reach the model.
 */
export interface HistoryFetchFailure {
    /** Non-sensitive label of the source that failed, e.g. `wildduck-search` or `channel:123`. */
    source:   string
    category: HistoryFailureCategory
    error?:   unknown
}

/**
 * How much of a platform a provider observed:
 * - `complete`:    every attempted source was read (zero entries means no matches there, unless `truncated`).
 * - `partial`:     some sources were read and some failed.
 * - `unavailable`: no source could be read.
 */
export type HistoryFetchCoverage = 'complete' | 'partial' | 'unavailable';

/**
 * The outcome of one provider fetch. Providers never swallow a backend error
 * into an empty list: a failure is reported in `failures` and `coverage`.
 */
export interface HistoryFetchResult {
    platform:  KnownPlatform
    entries:   HistoryEntry[]
    coverage:  HistoryFetchCoverage
    /**
     * True when the observation was bounded, so more matching entries may exist than were
     * returned: a fetch cap, a page of the matches, or sources left unsearched by a cap.
     */
    truncated: boolean
    failures:  HistoryFetchFailure[]
}

/**
 * Interface for platform-specific history providers.
 * Each platform (Discord, email, Bluesky, etc.) implements this interface.
 */
export interface PlatformHistoryProvider {
    /** Platform identifier — must be one of the known platforms. */
    readonly platform: KnownPlatform
    /** Fetch history for a given identifier within the specified time window. */
    fetchHistory(params: HistoryFetchParams): Promise<HistoryFetchResult>
}

/** A platform failure as reported to callers: the category, never the raw error. */
export interface PersonHistoryFailure {
    platform: KnownPlatform
    source:   string
    category: HistoryFailureCategory
}

/**
 * Which platforms a person-history observation consulted and how well.
 * - `queried`:       providers that were actually called (a platform may also appear in `partial` or `unavailable`).
 * - `unavailable`:   registered, applicable platforms that could not be read — every search failed, or the
 *                    service was already known to be down so no search was issued (such platforms are not `queried`).
 * - `partial`:       queried platforms where some sources failed.
 * - `notConfigured`: known platforms with no registered provider.
 * - `notApplicable`: registered platforms the contact has no identifier on (never queried).
 * - `truncated`:     some matching entries were or may have been left out (a provider limit or source cap,
 *                    `maxTotalEntries` or `maxCharacters`).
 * - `failures`:      each failed source with its category.
 */
export interface PersonHistoryCoverage {
    queried:       KnownPlatform[]
    unavailable:   KnownPlatform[]
    partial:       KnownPlatform[]
    notConfigured: KnownPlatform[]
    notApplicable: KnownPlatform[]
    truncated:     boolean
    failures:      PersonHistoryFailure[]
}

/**
 * Result of `PersonHistoryCoordinator.getPersonHistory`. `history` is undefined
 * when no entries were observed; `coverage` says whether that means "nothing
 * there" or "could not look".
 */
export type PersonHistoryResult
    = | { kind: 'contact_not_found' }
      | { kind: 'observed', person: Omit<Contact, '_internal'>, history: string | undefined, coverage: PersonHistoryCoverage };

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
    /**
     * Platforms already known to be down (from service health), with the reason.
     * Their providers are not called; they are reported as unavailable instead.
     */
    unavailablePlatforms?:   Partial<Record<KnownPlatform, ServiceErrorCategory>>
}

// Default values for PersonHistoryOptions
export const DEFAULT_MAX_MESSAGES_PER_PLATFORM = 10;
export const DEFAULT_MAX_TOTAL_ENTRIES = 30;
export const DEFAULT_TIME_WINDOW_MINUTES = 120;
export const DEFAULT_MAX_CHARACTERS = 12_000;
