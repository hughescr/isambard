import { logger } from '@hughescr/logger';
import type { HistoryEntry, HistoryFetchParams, MCPChannelRegistry, MCPDMTracker, MCPMessageSearchService, PlatformHistoryProvider } from '@/agent';

/**
 * Maximum number of unmuted channels to search for history.
 * Capped to limit API calls.
 */
const MAX_CHANNELS = 3;

/**
 * Maximum characters per message content (excluding author name prefix).
 * Keeps entries compact for context injection.
 */
const MAX_CONTENT_LENGTH = 200;

/**
 * Search a single channel and collect messages into the accumulator.
 * Skips messages already seen (dedup by ID). Logs a warning on error.
 */
async function searchChannelInto(
    searchService: MCPMessageSearchService,
    channelId:     string,
    query:         string,
    startTime:     Date | undefined,
    endTime:       Date | undefined,
    limit:         number | undefined,
    seenIds:       Set<string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- message objects are platform-specific; typed at conversion boundary
    out:           any[]
): Promise<void> {
    try {
        const result = await searchService.searchMessages({ channelId, query, startTime, endTime, limit });
        for(const msg of result.messages) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
            const id = msg.id as string | undefined;
            if(id && !seenIds.has(id)) {
                seenIds.add(id);
                out.push(msg);
            }
        }
    } catch (err) {
        // Stryker disable next-line ObjectLiteral,StringLiteral: log call structure and message text are informational only
        logger.warn({ err, channelId }, 'DiscordHistoryProvider: channel search failed');
    }
}

/**
 * Convert a raw message object from the search service to a HistoryEntry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- message objects are generic platform records per MCPMessageSearchService contract
function toHistoryEntry(msg: any, botUserId: string): HistoryEntry {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
    const timestamp  = (msg.timestamp as string | undefined) ?? new Date(0).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
    const author     = msg.author as { id?: string, displayName?: string, username?: string } | undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- message objects are passed through as-is from the search service
    const rawContent = (msg.content as string | undefined) ?? '';
    // Stryker disable next-line ConditionalExpression,EqualityOperator: true mutant always truncates but slice(0,200) of 200-char string is identical; >= equivalent since slice(0,N) of length-N string returns same value
    const content    = rawContent.length > MAX_CONTENT_LENGTH
        ? rawContent.slice(0, MAX_CONTENT_LENGTH)
        : rawContent;
    const authorName = author?.displayName ?? author?.username ?? 'unknown';
    // Stryker disable next-line ConditionalExpression,EqualityOperator: author ID comparison — determines direction from bot perspective; empty botUserId means pre-login construction, direction unknown
    let direction: 'inbound' | 'outbound' | 'mutual';
    if(!botUserId) {
        direction = 'mutual';
    } else if(author?.id === botUserId) {
        direction = 'outbound';
    } else {
        direction = 'inbound';
    }

    // Stryker disable next-line StringLiteral: summary format is cosmetic — tested indirectly via content
    return { platform: 'discord', timestamp, summary: `${authorName}: ${content}`, direction };
}

/**
 * Discord-specific history provider.
 *
 * Fetches recent messages involving a person from:
 * - DM channel (when discordUserId metadata is provided and dmTracker is configured)
 * - Up to 3 unmuted guild channels (using person's identifier as search query)
 *
 * Results are deduplicated by message ID before returning.
 */
export class DiscordHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'discord';

    constructor(
        private readonly searchService:   MCPMessageSearchService,
        private readonly channelRegistry: MCPChannelRegistry,
        private readonly botUserId:       string,
        private readonly dmTracker?:      MCPDMTracker
    ) {}

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryEntry[]> {
        const { identifier, maxMessages, startTime, endTime, metadata } = params;

        const seenIds = new Set<string>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- message objects are platform-specific; typed at conversion boundary
        const allMessages: any[] = [];

        // Step 1: search DM channel if dmTracker provided and metadata has discordUserId
        if(this.dmTracker && metadata?.discordUserId) {
            const dmChannelId = await this.dmTracker.getOrCreateDMByUsername(identifier);
            if(dmChannelId) {
                await searchChannelInto(this.searchService, dmChannelId, identifier, startTime, endTime, maxMessages, seenIds, allMessages);
            }
        }

        // Step 2: search up to MAX_CHANNELS unmuted guild channels
        const unmutedChannels  = await this.channelRegistry.getUnmutedChannels();
        // Stryker disable next-line ConditionalExpression,EqualityOperator: optimization guard — slice(0, MAX_CHANNELS) on shorter array returns same result
        const channelsToSearch = unmutedChannels.length > MAX_CHANNELS
            ? unmutedChannels.slice(0, MAX_CHANNELS)
            : unmutedChannels;

        for(const channel of channelsToSearch) {
            // eslint-disable-next-line no-await-in-loop -- must stay sequential: seenIds Set is mutated inside searchChannelInto for cross-channel deduplication; parallel calls would race on shared state
            await searchChannelInto(this.searchService, channel.channelId, identifier, startTime, endTime, maxMessages, seenIds, allMessages);
        }

        // Step 3: convert to HistoryEntry[]
        return allMessages.map(msg => toHistoryEntry(msg, this.botUserId));
    }
}
