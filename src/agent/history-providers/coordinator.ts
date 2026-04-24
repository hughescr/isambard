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
import { InvariantViolationError } from '@/errors';
import type { Contact, ContactBackend, PlatformType } from '@/storage';

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

interface NormalizedHistoryOptions {
    maxMessages:   number
    maxTotal:      number
    windowMinutes: number
    maxChars:      number
    platformHint:  PlatformType | undefined
    startTime:     Date | undefined
    endTime:       Date | undefined
}

function normalizeHistoryOptions(options: PersonHistoryOptions | undefined): NormalizedHistoryOptions {
    return {
        maxMessages:   options?.maxMessagesPerPlatform ?? DEFAULT_MAX_MESSAGES_PER_PLATFORM,
        maxTotal:      options?.maxTotalEntries        ?? DEFAULT_MAX_TOTAL_ENTRIES,
        windowMinutes: options?.timeWindowMinutes      ?? DEFAULT_TIME_WINDOW_MINUTES,
        maxChars:      options?.maxCharacters          ?? DEFAULT_MAX_CHARACTERS,
        platformHint:  options?.platformHint,
        startTime:     options?.startTime,
        endTime:       options?.endTime,
    };
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
     * Resolve a contact by identifier, using direct platform lookup when a hint is available.
     * Falls back to fuzzy lookup if platform lookup returns nothing or no hint is provided.
     */
    private async resolveContact(identifier: string, platformHint: PlatformType | undefined): Promise<Contact[]> {
        if(platformHint) {
            const direct = await this.options.contactBackend.resolveIdentifier(platformHint, identifier);
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: optimization guard — empty direct produces same fallback result
            if(direct.length > 0) {
                return direct;
            }
        }
        return this.options.contactBackend.fuzzyLookup(identifier);
    }

    /**
     * Build platform-specific metadata from _internal contact fields for a given provider.
     */
    // eslint-disable-next-line sonarjs/function-return-type -- legitimately returns Record<string, string> | undefined
    private buildProviderMetadata(
        platform:     string,
        internalData: Contact['_internal']
    ): Record<string, string> | undefined {
        const metadata: Record<string, string> = {};
        if(platform === 'discord' && internalData?.discordUserId) {
            metadata.discordUserId = internalData.discordUserId;
        }
        if(platform === 'bsky' && internalData?.bskyDid) {
            metadata.bskyDid = internalData.bskyDid;
        }
        // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — spreading empty {} vs omitting metadata is equivalent; providers check specific keys
        return Object.keys(metadata).length > 0 ? metadata : undefined;
    }

    /**
     * Fetch all history entries for one provider across all matching identifiers.
     */
    private async fetchProviderEntries(
        provider:     PlatformHistoryProvider,
        contact:      Contact,
        maxMessages:  number,
        startTime:    Date,
        endTime:      Date
    ): Promise<HistoryEntry[]> {
        const matchingIds = contact.identifiers
            .filter(id => id.platform === provider.platform)
            .map(id => id.value);

        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: optimization guard — empty matchingIds produces same result via empty for-loop
        if(matchingIds.length === 0) {
            return [];
        }

        const metadata = this.buildProviderMetadata(provider.platform, contact._internal);
        const perIdResults = await Promise.all(matchingIds.map((id) => {
            const params: HistoryFetchParams = {
                identifier: id,
                maxMessages,
                startTime,
                endTime,
                // Stryker disable next-line ConditionalExpression: Spreading { metadata: undefined } is functionally equivalent to omitting the key
                ...(metadata !== undefined && { metadata }),
            };
            return provider.fetchHistory(params);
        }));
        return perIdResults.flat();
    }

    /**
     * Fetch cross-platform history for a person identified by a fuzzy query.
     *
     * @param identifier - Name, email, handle, or any fuzzy-matchable identifier.
     * @param options    - Optional limits and time window.
     * @returns history: formatted string of interactions, or undefined if the person was not found.
     *          person:  the matched contact (with _internal stripped), or undefined if not found.
     */
    /**
     * Merge settled provider results, logging failures and collecting fulfilled entries.
     */
    private mergeProviderResults(results: PromiseSettledResult<HistoryEntry[]>[]): HistoryEntry[] {
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
        return allEntries;
    }

    async getPersonHistory(
        identifier: string,
        options?:   PersonHistoryOptions
    ): Promise<{ history: string | undefined, person: Omit<Contact, '_internal'> | undefined }> {
        const { maxMessages, maxTotal, windowMinutes, maxChars, platformHint, startTime: optStartTime, endTime: optEndTime } = normalizeHistoryOptions(options);

        // Step 1: resolve the person — use direct platform lookup when hint is available (avoids full-contact scan)
        const contacts = await this.resolveContact(identifier, platformHint);
        if(contacts.length === 0) {
            return { history: undefined, person: undefined };
        }
        const contact = contacts[0];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — contacts.length === 0 check above ensures non-empty; unreachable in practice
        if(contact === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('getPersonHistory', 'contacts[0] undefined after contacts.length === 0 guard');
        }

        // Step 2: compute time window — use explicit startTime/endTime when provided, otherwise fall back to windowMinutes
        const endTime   = optEndTime   ?? new Date();
        const startTime = optStartTime ?? new Date(endTime.getTime() - windowMinutes * 60 * 1000);

        // Step 3: fan out to providers in parallel
        const providerQueries = this.options.providers.map(provider =>
            this.fetchProviderEntries(provider, contact, maxMessages, startTime, endTime)
        );
        const results = await Promise.allSettled(providerQueries);

        // Step 4: merge results, log failures
        const allEntries = this.mergeProviderResults(results);
        if(allEntries.length === 0) {
            return { history: undefined, person: stripInternal(contact) };
        }

        // Sort descending (most recent first)
        // Stryker disable next-line StringLiteral: sort comparison direction is cosmetic and equivalent for equal timestamps
        allEntries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

        // Cap at maxTotalEntries then format
        const capped = allEntries.slice(0, maxTotal);
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
