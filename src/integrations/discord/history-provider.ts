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
 * Minimal typed shape of a raw Discord message from MCPMessageSearchService.
 * All fields optional — access is guarded with `??` in conversion helpers.
 */
interface RawDiscordMessage {
    id?:        string
    timestamp?: string
    author?:    { id?: string, displayName?: string, username?: string }
    content?:   string
}

interface SearchedMessage {
    id:      string
    message: RawDiscordMessage
}

/**
 * Search one channel, retaining messages collected before a malformed response fails.
 * Logs a warning on error without discarding the valid prefix.
 */
async function searchChannel(
    searchService: MCPMessageSearchService,
    channelId:     string,
    query:         string,
    startTime:     Date | undefined,
    endTime:       Date | undefined,
    limit:         number | undefined
): Promise<SearchedMessage[]> {
    const messages: SearchedMessage[] = [];
    try {
        const result = await searchService.searchMessages({ channelId, query, startTime, endTime, limit });
        for(const msg of result.messages as RawDiscordMessage[]) {
            const id = msg.id;
            if(id) {
                // Stryker disable next-line llm: id is truthy under the enclosing guard, so adding a fallback is behaviorally identical.
                messages.push({ id, message: msg });
            }
        }
    } catch (err) {
        logger.warn({ err, channelId }, 'DiscordHistoryProvider: channel search failed');
    }
    return messages;
}

/** Merge in channel order so the first DM or guild occurrence wins each message ID. */
function appendUnseen(messages: SearchedMessage[], seenIds: Set<string>, out: RawDiscordMessage[]): void {
    for(const { id, message } of messages) {
        if(!seenIds.has(id)) {
            seenIds.add(id);
            out.push(message);
        }
    }
}

/**
 * Convert a raw message object from the search service to a HistoryEntry.
 */
function toHistoryEntry(msg: RawDiscordMessage, botUserId: string): HistoryEntry {
    // Stryker disable next-line NumberLiteralValue: MCPMessageSearchService requires timestamp and the production fetcher constructs it with createdAt.toISOString().
    const timestamp  = msg.timestamp ?? new Date(0).toISOString();
    const author     = msg.author;
    const rawContent = msg.content ?? '';
    // `slice(0, limit)` preserves shorter strings and bounds longer ones, so one operation
    // expresses the runtime contract without a redundant boundary branch.
    const content    = rawContent.slice(0, MAX_CONTENT_LENGTH);
    const authorName = author?.displayName ?? author?.username ?? 'unknown';
    let direction: 'inbound' | 'outbound' | 'mutual';
    if(!botUserId) {
        direction = 'mutual';
    } else if(author?.id === botUserId) {
        direction = 'outbound';
    } else {
        direction = 'inbound';
    }

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
        const allMessages: RawDiscordMessage[] = [];

        // Step 1: search DM channel if dmTracker provided and metadata has discordUserId
        if(this.dmTracker && metadata?.discordUserId) {
            const dmChannelId = await this.dmTracker.getOrCreateDMByUsername(identifier);
            if(dmChannelId) {
                const dmMessages = await searchChannel(this.searchService, dmChannelId, identifier, startTime, endTime, maxMessages);
                appendUnseen(dmMessages, seenIds, allMessages);
            }
        }

        // Step 2: search up to MAX_CHANNELS unmuted guild channels
        const unmutedChannels  = await this.channelRegistry.getUnmutedChannels();
        // Slicing preserves the channel content for fewer than MAX_CHANNELS runtime entries.
        const channelsToSearch = unmutedChannels.slice(0, MAX_CHANNELS);

        const guildResults = await Promise.all(channelsToSearch.map(channel =>
            searchChannel(this.searchService, channel.channelId, identifier, startTime, endTime, maxMessages)));
        for(const channelMessages of guildResults) {
            appendUnseen(channelMessages, seenIds, allMessages);
        }

        // Step 3: convert to HistoryEntry[]
        return allMessages.map(msg => toHistoryEntry(msg, this.botUserId));
    }
}
