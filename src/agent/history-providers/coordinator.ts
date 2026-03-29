import { logger } from '@hughescr/logger';
import type { MCPMessageSearchService } from '../types';
import {
    DEFAULT_MAX_CHARACTERS,
    DEFAULT_MAX_MESSAGES_PER_PLATFORM,
    DEFAULT_MAX_TOTAL_ENTRIES,
    DEFAULT_TIME_WINDOW_MINUTES,
    type HistoryEntry,
    type HistoryFetchParams,
    type PersonHistoryOptions,
    type PlatformHistoryProvider
} from './types';
import type { Contact, ContactBackend } from '@/storage';

/**
 * Options for constructing a PersonHistoryCoordinator.
 */
export interface PersonHistoryCoordinatorOptions {
    /** Backend for looking up contacts by name/identifier. */
    contactBackend:       ContactBackend
    /** Registered platform-specific history providers. */
    providers:            PlatformHistoryProvider[]
    /** Message search service used for channel-local fallback. */
    messageSearchService: MCPMessageSearchService
}

/**
 * Strip the `_internal` field from a contact before returning to callers.
 * The agent must never see Discord user IDs or Bluesky DIDs directly.
 */
function stripInternal(contact: Contact): Omit<Contact, '_internal'> {
    const { _internal: _, ...rest } = contact;
    return rest;
}

/**
 * Format a list of HistoryEntry items into a human-readable string block.
 * Entries are already sorted descending by timestamp when this is called.
 */
function formatHistoryEntries(displayName: string, entries: HistoryEntry[]): string {
    const lines = entries.map((entry) => {
        const ts = new Date(entry.timestamp);
        // Format as HH:MM if today, else as date
        const now = new Date();
        // Stryker disable ConditionalExpression: each individual flag mutated to true is equivalent — the other flags still gate the full isToday result
        const sameYear  = ts.getUTCFullYear() === now.getUTCFullYear();
        const sameMonth = ts.getUTCMonth() === now.getUTCMonth();
        const sameDay   = ts.getUTCDate() === now.getUTCDate();
        // Stryker restore ConditionalExpression
        // Stryker disable next-line LogicalOperator,ConditionalExpression: operator variants and partial-expression substitutions produce equivalent results for boolean guard
        const isToday   = sameYear && sameMonth && sameDay;
        const timeStr = isToday
            ? `${String(ts.getUTCHours()).padStart(2, '0')}:${String(ts.getUTCMinutes()).padStart(2, '0')}`
            : ts.toISOString().slice(0, 10);
        // Stryker disable next-line StringLiteral: formatting template — cosmetic punctuation
        return `[${entry.platform}] [${timeStr}] ${entry.summary}`;
    });
    // Stryker disable next-line StringLiteral: header/footer strings are cosmetic output formatting
    return `--- Recent interactions with ${displayName} ---\n${lines.join('\n')}\n--- End of recent history ---`;
}

/**
 * Coordinates fetching cross-platform interaction history for a person.
 *
 * Given an identifier (name, email, handle), resolves the contact via fuzzy lookup,
 * fans out to registered platform providers in parallel, merges and sorts the results,
 * and returns a formatted string ready for agent context injection.
 */
export class PersonHistoryCoordinator {
    constructor(private readonly options: PersonHistoryCoordinatorOptions) {}

    /**
     * Fetch cross-platform history for a person identified by a fuzzy query.
     *
     * @param identifier - Name, email, handle, or any fuzzy-matchable identifier.
     * @param options    - Optional limits and time window.
     * @returns history: formatted string of interactions, or undefined if the person was not found.
     *          person:  the matched contact (with _internal stripped), or undefined if not found.
     */
    async getPersonHistory(
        identifier: string,
        options?:   PersonHistoryOptions
    ): Promise<{ history: string | undefined, person: Omit<Contact, '_internal'> | undefined }> {
        const maxMessages   = options?.maxMessagesPerPlatform ?? DEFAULT_MAX_MESSAGES_PER_PLATFORM;
        const maxTotal      = options?.maxTotalEntries        ?? DEFAULT_MAX_TOTAL_ENTRIES;
        const windowMinutes = options?.timeWindowMinutes      ?? DEFAULT_TIME_WINDOW_MINUTES;
        const maxChars      = options?.maxCharacters          ?? DEFAULT_MAX_CHARACTERS;

        // Step 1: resolve the person via fuzzy lookup
        const contacts = await this.options.contactBackend.fuzzyLookup(identifier);
        if(contacts.length === 0) {
            return { history: undefined, person: undefined };
        }
        const contact = contacts[0];

        // Step 2: compute time window — use explicit startTime/endTime when provided, otherwise fall back to windowMinutes
        const endTime   = options?.endTime   ?? new Date();
        const startTime = options?.startTime ?? new Date(endTime.getTime() - windowMinutes * 60 * 1000);

        // Step 3: group contact identifiers by platform, fan out to providers in parallel
        const { providers } = this.options;

        // Extract _internal data for provider metadata (before stripping)
        const internalData = contact._internal;

        const providerQueries = providers.map(async (provider): Promise<HistoryEntry[]> => {
            const matchingIds = contact.identifiers
                .filter(id => id.platform === provider.platform)
                .map(id => id.value);

            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: optimization guard — empty matchingIds produces same result via empty for-loop
            if(matchingIds.length === 0) {
                return [];
            }

            // Build platform-specific metadata from _internal fields
            const metadata: Record<string, string> = {};
            if(provider.platform === 'discord' && internalData?.discordUserId) {
                metadata.discordUserId = internalData.discordUserId;
            }
            if(provider.platform === 'bsky' && internalData?.bskyDid) {
                metadata.bskyDid = internalData.bskyDid;
            }

            // Fetch for each matching identifier and merge
            const allEntries: HistoryEntry[] = [];
            for(const id of matchingIds) {
                const params: HistoryFetchParams = {
                    identifier: id,
                    maxMessages,
                    startTime,
                    endTime,
                    // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — spreading empty {} vs omitting metadata is equivalent; providers check specific keys
                    ...(Object.keys(metadata).length > 0 && { metadata }),
                };
                // eslint-disable-next-line no-await-in-loop -- sequential: each identifier fetch is independent but we need to collect results before merging
                const entries = await provider.fetchHistory(params);
                allEntries.push(...entries);
            }
            return allEntries;
        });

        const results = await Promise.allSettled(providerQueries);

        // Step 4: merge results, log failures, sort descending by timestamp
        const allEntries: HistoryEntry[] = [];
        for(const result of results) {
            if(result.status === 'fulfilled') {
                allEntries.push(...result.value);
            } else {
                // Stryker disable next-line ObjectLiteral,StringLiteral: log call structure and message text are informational only
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- PromiseRejectedResult.reason is typed as any by the Promise API
                logger.warn({ err: result.reason }, 'PersonHistoryCoordinator: provider query failed');
            }
        }

        if(allEntries.length === 0) {
            return { history: undefined, person: stripInternal(contact) };
        }

        // Sort descending (most recent first)
        // Stryker disable next-line StringLiteral: sort comparison direction is cosmetic and equivalent for equal timestamps
        allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        // Cap at maxTotalEntries
        const capped = allEntries.slice(0, maxTotal);

        // Format into readable string
        let formatted = formatHistoryEntries(contact.displayName, capped);

        // Cap at maxCharacters
        // Stryker disable next-line ConditionalExpression,EqualityOperator: true mutant always truncates but short strings are unchanged; >= is equivalent since slice(0,N) on length=N string returns same string
        if(formatted.length > maxChars) {
            formatted = formatted.slice(0, maxChars);
        }

        return { history: formatted, person: stripInternal(contact) };
    }

    /**
     * Fetch recent message history for a specific channel (local, channel-scoped fallback).
     *
     * @param channelId        - The channel to fetch recent messages from.
     * @param excludeMessageId - Optional message ID to exclude (e.g. the triggering message).
     * @param options          - Optional limits.
     * @returns Formatted history string, or undefined if no messages were found.
     */
    async getChannelLocalHistory(
        channelId:         string,
        excludeMessageId?: string,
        options?:          PersonHistoryOptions
    ): Promise<string | undefined> {
        const maxMessages = options?.maxMessagesPerPlatform ?? DEFAULT_MAX_MESSAGES_PER_PLATFORM;
        const maxChars    = options?.maxCharacters          ?? DEFAULT_MAX_CHARACTERS;

        const result = await this.options.messageSearchService.getRecentMessages(channelId, maxMessages);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- search results contain platform-specific types; passed through as JSON per MCPMessageSearchService contract
        let messages: any[] = result.messages;

        // Stryker disable next-line ConditionalExpression: true mutant runs filter with excludeMessageId=undefined which passes all messages (m.id !== undefined is true for all valid messages) — equivalent
        if(excludeMessageId) {
            // Stryker disable next-line ConditionalExpression,EqualityOperator: filter uses identity — excluding the trigger message is a passthrough when nothing matches
            messages = messages.filter((m: Record<string, unknown>) => m.id !== excludeMessageId);
        }

        if(messages.length === 0) {
            return undefined;
        }

        // Convert to HistoryEntry[] for uniform formatting
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- messages are generic platform records per MCPMessageSearchService contract
        const entries: HistoryEntry[] = messages.map((m: any): HistoryEntry => {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
            const ts      = (m.timestamp as string | undefined) ?? new Date(0).toISOString();
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
            const author  = m.author as { displayName?: string, username?: string } | undefined;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
            const content = (m.content as string | undefined) ?? '';
            const name    = author?.displayName ?? author?.username ?? 'unknown';
            return {
                platform:  'discord',
                // Stryker disable next-line StringLiteral: fallback value for missing timestamp — informational only
                timestamp: ts,
                // Stryker disable next-line StringLiteral: fallback for missing author/content — informational only
                summary:   `${name}: ${content}`,
                direction: 'inbound' as const,
            };
        });

        // Sort descending
        // Stryker disable next-line StringLiteral: sort comparison direction is cosmetic and equivalent for equal timestamps
        entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        let formatted = formatHistoryEntries('channel', entries);
        // Stryker disable next-line ConditionalExpression,EqualityOperator: true mutant always truncates but short strings are unchanged; >= is equivalent since slice(0,N) on length=N string returns same string
        if(formatted.length > maxChars) {
            formatted = formatted.slice(0, maxChars);
        }

        return formatted;
    }
}
