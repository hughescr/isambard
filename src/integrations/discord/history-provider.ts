import { logger } from '@hughescr/logger';
import type { ChannelId, DiscordMcpChannelInfo, HistoryEntry, HistoryFetchFailure, HistoryFetchParams, HistoryFetchResult, DiscordMcpChannelRegistry, MCPDMTracker, MCPMessageSearchService, PlatformHistoryProvider } from '@/agent';

/**
 * Maximum number of unmuted channels to search for history.
 * Capped to limit API calls.
 */
const MAX_CHANNELS = 3;

/** Failure source label for the person's DM channel (its channel ID is not surfaced). */
const DM_SOURCE = 'dm';

/** Failure source label for the unmuted guild channel listing. */
const GUILD_CHANNELS_SOURCE = 'guild-channels';

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

/** One channel search: the messages read, whether more matched, and the failure if it threw. */
interface ChannelSearch {
    messages:  SearchedMessage[]
    truncated: boolean
    failure:   HistoryFetchFailure | undefined
}

/**
 * Search one channel, retaining messages collected before a malformed response fails.
 * A thrown search is logged and reported as this channel's failure without discarding
 * the valid prefix. `truncated` is set when the search hit its fetch cap or returned
 * only a page of the matches.
 */
async function searchChannel(
    searchService: MCPMessageSearchService,
    channelId:     string,
    source:        string,
    query:         string,
    startTime:     Date | undefined,
    endTime:       Date | undefined,
    limit:         number | undefined
): Promise<ChannelSearch> {
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
        const truncated = result.metadata.coverage === 'limitReached' || result.overflow !== undefined;
        return { messages, truncated, failure: undefined };
    } catch (err) {
        logger.warn({ err, channelId }, 'DiscordHistoryProvider: channel search failed');
        return { messages, truncated: false, failure: { source, category: 'transient', error: err } };
    }
}

/** Search one channel under the caller's query, window and limit, labelling any failure with `source`. */
type SearchOne = (channelId: ChannelId, source: string) => Promise<ChannelSearch>;

/** A source whose channel lookup threw before any search: no messages, one transient failure. */
function lookupFailure(source: string, err: unknown): ChannelSearch {
    return { messages: [], truncated: false, failure: { source, category: 'transient', error: err } };
}

/**
 * Search the person's DM channel. A lookup that throws becomes a `dm` failure so the
 * guild channels are still searched; a lookup that finds no DM channel searches nothing.
 */
async function searchDM(dmTracker: MCPDMTracker, identifier: string, search: SearchOne): Promise<ChannelSearch[]> {
    let dmChannelId: ChannelId | null;
    try {
        dmChannelId = await dmTracker.getOrCreateDMByUsername(identifier);
    } catch (err) {
        logger.warn({ err }, 'DiscordHistoryProvider: DM channel lookup failed');
        return [lookupFailure(DM_SOURCE, err)];
    }
    return dmChannelId ? [await search(dmChannelId, DM_SOURCE)] : [];
}

/**
 * Coverage across the attempted channel searches: complete when none failed,
 * unavailable when every attempted search failed, partial otherwise. With no
 * channel to search there is nothing unobserved, so that is complete.
 */
function channelCoverage(attempts: number, failures: number): HistoryFetchResult['coverage'] {
    if(failures === 0) {
        return 'complete';
    }
    return failures === attempts ? 'unavailable' : 'partial';
}

/** Merge in channel order so the first DM or guild occurrence wins each message ID. */
function appendUnseen(searches: ChannelSearch[]): RawDiscordMessage[] {
    const seenIds = new Set<string>();
    const out: RawDiscordMessage[] = [];
    for(const { id, message } of searches.flatMap(search => search.messages)) {
        if(!seenIds.has(id)) {
            seenIds.add(id);
            out.push(message);
        }
    }
    return out;
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
 * - DM channel (when the scope carries a discordUserId and dmTracker is configured)
 * - Up to 3 unmuted guild channels (using person's identifier as search query);
 *   when more are unmuted, the unsearched ones mark the result truncated
 *
 * Results are deduplicated by message ID before returning. Each failed DM lookup,
 * channel listing or channel search is reported as a failure without discarding the
 * other sources; coverage is partial when some sources were read and unavailable
 * when none were.
 */
export class DiscordHistoryProvider implements PlatformHistoryProvider {
    readonly platform = 'discord';

    constructor(
        private readonly searchService:   MCPMessageSearchService,
        private readonly channelRegistry: DiscordMcpChannelRegistry,
        private readonly botUserId:       string,
        private readonly dmTracker?:      MCPDMTracker
    ) {}

    async fetchHistory(params: HistoryFetchParams): Promise<HistoryFetchResult> {
        const { identifier, maxMessages, startTime, endTime, scope } = params;
        const search: SearchOne = async (channelId, source) =>
            searchChannel(this.searchService, channelId, source, identifier, startTime, endTime, maxMessages);
        const searches: ChannelSearch[] = [];

        // Step 1: search DM channel if dmTracker provided and the scope names a Discord user
        if(this.dmTracker && scope?.platform === 'discord') {
            searches.push(...await searchDM(this.dmTracker, identifier, search));
        }

        // Step 2: search up to MAX_CHANNELS unmuted guild channels
        const guild = await this.searchGuildChannels(search);
        searches.push(...guild.searches);

        // Step 3: convert to HistoryEntry[] and report per-source coverage
        const failures = searches.flatMap(channelSearch => channelSearch.failure ?? []);
        return {
            platform:  'discord',
            entries:   appendUnseen(searches).map(msg => toHistoryEntry(msg, this.botUserId)),
            coverage:  channelCoverage(searches.length, failures.length),
            truncated: guild.channelsSkipped || searches.some(channelSearch => channelSearch.truncated),
            failures,
        };
    }

    /**
     * Search the first MAX_CHANNELS unmuted guild channels concurrently. A listing that
     * throws becomes one `guild-channels` failure; channels left out by the cap are
     * reported as `channelsSkipped` so the result is marked truncated.
     */
    private async searchGuildChannels(search: SearchOne): Promise<{ searches: ChannelSearch[], channelsSkipped: boolean }> {
        let unmutedChannels: DiscordMcpChannelInfo[];
        try {
            unmutedChannels = await this.channelRegistry.getUnmutedChannels();
        } catch (err) {
            logger.warn({ err }, 'DiscordHistoryProvider: unmuted channel listing failed');
            return { searches: [lookupFailure(GUILD_CHANNELS_SOURCE, err)], channelsSkipped: false };
        }
        // Slicing preserves the channel content for fewer than MAX_CHANNELS runtime entries.
        const channelsToSearch = unmutedChannels.slice(0, MAX_CHANNELS);
        const searches = await Promise.all(channelsToSearch.map(async channel =>
            search(channel.channelId, `channel:${channel.channelId}`)));
        return { searches, channelsSkipped: unmutedChannels.length > MAX_CHANNELS };
    }
}
