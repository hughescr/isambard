/**
 * Tests for DiscordHistoryProvider
 *
 * Verifies that:
 * - Fetches from DM channel when the scope carries a discordUserId
 * - Fetches from unmuted channels with person's name as query
 * - Caps at 3 channels, marking the result truncated when more are unmuted
 * - Deduplicates messages by ID across channels
 * - Converts messages to HistoryEntry format correctly
 * - Sets direction based on author (bot vs user)
 * - Truncates long message content
 * - Reports per-channel failures: partial when some channels fail, unavailable when all do
 * - Isolates DM lookup and channel listing failures so the other source still contributes
 * - Reports complete coverage with no entries when no channels found or no messages match
 * - Reports truncation when a channel search hit its fetch cap or overflowed
 * - Passes startTime/endTime to search
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { MCPMessageSearchService, DiscordMcpChannelRegistry, MCPDMTracker, DiscordMcpChannelInfo, ChannelId, HistoryFetchParams } from '@/agent';
import { DiscordHistoryProvider } from '@/integrations/discord/history-provider';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const BOT_USER_ID = 'bot-123';
const CHANNEL_1_ID = 'channel-1' as ChannelId;
const CHANNEL_2_ID = 'channel-2' as ChannelId;
const CHANNEL_3_ID = 'channel-3' as ChannelId;
const CHANNEL_4_ID = 'channel-4' as ChannelId;
const DM_CHANNEL_ID = 'dm-channel-1' as ChannelId;

const UNMUTED_CHANNELS: DiscordMcpChannelInfo[] = [
    { channelId: CHANNEL_1_ID, channelName: 'general',  guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_2_ID, channelName: 'random',   guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_3_ID, channelName: 'projects', guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_4_ID, channelName: 'fourth',   guildId: 'guild-1', isMuted: false },
];

const DISCORD_SCOPE: HistoryFetchParams['scope'] = { platform: 'discord', discordUserId: 'user-123' };

function makeMessage(id: string, authorId: string, authorName: string, content: string, timestamp: string) {
    return {
        id,
        author: { id: authorId, displayName: authorName, username: authorName },
        content,
        timestamp,
    };
}

/** A search-service response page with complete coverage and no overflow unless overridden. */
function page(messages: unknown[], overrides: Record<string, unknown> = {}) {
    return {
        messages,
        metadata: { coverage: 'complete' as const, fetched: messages.length, matchedInFetched: messages.length },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockSearchService(): {
    searchMessages:    ReturnType<typeof mock>
    getRecentMessages: ReturnType<typeof mock>
    getMessageById:    ReturnType<typeof mock>
    getMessagesById:   ReturnType<typeof mock>
} & MCPMessageSearchService {
    return {
        searchMessages:    mock(async () => ({ messages: [], metadata: { coverage: 'complete' as const, fetched: 0, matchedInFetched: 0 } })),
        getRecentMessages: mock(async () => ({ messages: [], metadata: { coverage: 'complete' as const, fetched: 0, matchedInFetched: 0 } })),
        getMessageById:    mock(async () => null),
        getMessagesById:   mock(async () => []),
    };
}

function createMockChannelRegistry(): {
    getUnmutedChannels: ReturnType<typeof mock>
    resolveChannelId:   ReturnType<typeof mock>
    muteChannel:        ReturnType<typeof mock>
    unmuteChannel:      ReturnType<typeof mock>
    getAllChannels:     ReturnType<typeof mock>
} & DiscordMcpChannelRegistry {
    return {
        getUnmutedChannels: mock(async (): Promise<DiscordMcpChannelInfo[]> => []),
        resolveChannelId:   mock(() => CHANNEL_1_ID),
        muteChannel:        mock(async () => {}),
        unmuteChannel:      mock(async () => {}),
        getAllChannels:     mock((): DiscordMcpChannelInfo[] => []),
    };
}

function createMockDMTracker(): {
    getOrCreateDMByUsername: ReturnType<typeof mock>
} & MCPDMTracker {
    return {
        getOrCreateDMByUsername: mock(async (): Promise<ChannelId | null> => null),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordHistoryProvider', () => {
    let searchService: ReturnType<typeof createMockSearchService>;
    let channelRegistry: ReturnType<typeof createMockChannelRegistry>;
    let dmTracker: ReturnType<typeof createMockDMTracker>;
    let provider: DiscordHistoryProvider;

    beforeEach(() => {
        searchService   = createMockSearchService();
        channelRegistry = createMockChannelRegistry();
        dmTracker       = createMockDMTracker();
        provider        = new DiscordHistoryProvider(searchService, channelRegistry, BOT_USER_ID, dmTracker);
        mockLogger.warn.mockReset();
    });

    test('has platform = "discord"', () => {
        expect(provider.platform).toBe('discord');
    });

    describe('fetchHistory', () => {
        test('reports complete coverage with no entries when no channels found', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue([]);

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toEqual({ platform: 'discord', entries: [], coverage: 'complete', truncated: false, failures: [] });
        });

        test('reports complete coverage with no entries when no messages match', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toEqual({ platform: 'discord', entries: [], coverage: 'complete', truncated: false, failures: [] });
        });

        test('fetches from unmuted channels with identifier as query', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            searchService.searchMessages.mockResolvedValue(page([]));

            await provider.fetchHistory({ identifier: 'Alice' });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(2);
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: CHANNEL_1_ID, query: 'Alice' })
            );
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: CHANNEL_2_ID, query: 'Alice' })
            );
        });

        test('caps channel search at 3 channels and marks the result truncated when more unmuted channels exist', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS); // 4 channels
            searchService.searchMessages.mockResolvedValue(page([]));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(3);
            expect(searchService.searchMessages).not.toHaveBeenCalledWith(expect.objectContaining({ channelId: CHANNEL_4_ID }));
            expect(result).toEqual({ platform: 'discord', entries: [], coverage: 'complete', truncated: true, failures: [] });
        });

        test('does not mark the result truncated when exactly 3 unmuted channels exist', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 3));
            searchService.searchMessages.mockResolvedValue(page([]));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(3);
            expect(result).toEqual({ platform: 'discord', entries: [], coverage: 'complete', truncated: false, failures: [] });
        });

        test('keeps guild channel results and reports a dm failure when the DM channel lookup throws', async () => {
            const error = new Error('dm lookup down');
            dmTracker.getOrCreateDMByUsername.mockRejectedValue(error);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([makeMessage('g-1', 'user-1', 'Alice', 'guild hi', '2026-01-01T10:00:00.000Z')]));

            const result = await provider.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
            expect(result).toEqual({
                platform:  'discord',
                entries:   [{ platform: 'discord', timestamp: '2026-01-01T10:00:00.000Z', summary: 'Alice: guild hi', direction: 'inbound' }],
                coverage:  'partial',
                truncated: false,
                failures:  [{ source: 'dm', category: 'transient', error }],
            });
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: error }, 'DiscordHistoryProvider: DM channel lookup failed');
        });

        test('keeps DM results and reports a guild-channels failure when the unmuted channel listing throws', async () => {
            const error = new Error('registry down');
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockRejectedValue(error);
            searchService.searchMessages.mockResolvedValue(page([makeMessage('dm-1', 'user-1', 'Alice', 'dm hi', '2026-01-01T10:00:00.000Z')]));

            const result = await provider.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
            expect(result).toEqual({
                platform:  'discord',
                entries:   [{ platform: 'discord', timestamp: '2026-01-01T10:00:00.000Z', summary: 'Alice: dm hi', direction: 'inbound' }],
                coverage:  'partial',
                truncated: false,
                failures:  [{ source: 'guild-channels', category: 'transient', error }],
            });
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith({ err: error }, 'DiscordHistoryProvider: unmuted channel listing failed');
        });

        test('reports unavailable coverage when the unmuted channel listing throws and no DM is searched', async () => {
            const error = new Error('registry down');
            channelRegistry.getUnmutedChannels.mockRejectedValue(error);

            const result = await provider.fetchHistory({ identifier: 'alice' });

            expect(searchService.searchMessages).not.toHaveBeenCalled();
            expect(result).toEqual({
                platform:  'discord',
                entries:   [],
                coverage:  'unavailable',
                truncated: false,
                failures:  [{ source: 'guild-channels', category: 'transient', error }],
            });
        });

        test('reports unavailable coverage with both failures when the DM lookup and channel listing both throw', async () => {
            const dmError = new Error('dm lookup down');
            const listError = new Error('registry down');
            dmTracker.getOrCreateDMByUsername.mockRejectedValue(dmError);
            channelRegistry.getUnmutedChannels.mockRejectedValue(listError);

            const result = await provider.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            expect(result.coverage).toBe('unavailable');
            expect(result.failures).toEqual([
                { source: 'dm', category: 'transient', error: dmError },
                { source: 'guild-channels', category: 'transient', error: listError },
            ]);
        });

        test('converts messages to HistoryEntry format with inbound direction for non-bot', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello there', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                platform:  'discord',
                timestamp: '2026-01-01T10:00:00.000Z',
                summary:   'Alice: Hello there',
                direction: 'inbound',
            });
        });

        test('sets direction to outbound when author is bot', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = makeMessage('msg-1', BOT_USER_ID, 'Isambard', 'I respond here', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.direction).toBe('outbound');
        });

        test('sets direction to mutual when botUserId is empty (pre-login construction)', async () => {
            // Constructed before Discord login — botUserId will be empty string
            const earlyProvider = new DiscordHistoryProvider(searchService, channelRegistry, '');
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await earlyProvider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.direction).toBe('mutual');
        });

        test('truncates long message content to ~200 chars', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const longContent = 'A'.repeat(300);
            const msg = makeMessage('msg-1', 'user-123', 'Alice', longContent, '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary.length).toBeLessThanOrEqual(215); // "Alice: " + 200 chars
            expect(result[0]?.summary).toContain('Alice: ');
        });

        test('deduplicates messages by ID across channels', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            // Same message returned from 2 channels — should appear only once
            expect(result).toHaveLength(1);
        });

        test('searches guild channels concurrently but merges out-of-order replies in channel order', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 3));
            const first  = Promise.withResolvers<ReturnType<typeof page>>();
            const second = Promise.withResolvers<ReturnType<typeof page>>();
            const third  = Promise.withResolvers<ReturnType<typeof page>>();
            searchService.searchMessages.mockImplementation(({ channelId }: { channelId: string }) => {
                if(channelId === CHANNEL_1_ID) {
                    return first.promise;
                }
                if(channelId === CHANNEL_2_ID) {
                    return second.promise;
                }
                return third.promise;
            });

            const historyPromise = provider.fetchHistory({ identifier: 'Alice' });
            await Bun.sleep(1);
            const admittedSearches = searchService.searchMessages.mock.calls.length;

            // Resolve in reverse order; the channel-1 copy must still win the duplicate ID.
            third.resolve(page([makeMessage('third', 'user-3', 'C', 'last', '2026-01-01T12:00:00.000Z')]));
            second.resolve(page([
                makeMessage('shared', 'user-2', 'B', 'wrong copy', '2026-01-01T11:00:00.000Z'),
                makeMessage('second', 'user-2', 'B', 'middle', '2026-01-01T11:01:00.000Z'),
            ]));
            first.resolve(page([makeMessage('shared', 'user-1', 'A', 'winning copy', '2026-01-01T10:00:00.000Z')]));

            const { entries: result } = await historyPromise;
            expect(admittedSearches).toBe(3);
            expect(result.map(entry => entry.summary)).toEqual([
                'A: winning copy',
                'B: middle',
                'C: last',
            ]);
        });

        test('reports partial coverage with one failure when one of three channels throws', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 3));
            const msg = makeMessage('msg-ok', 'user-123', 'Alice', 'Hi', '2026-01-01T10:00:00.000Z');
            const error = new Error('timeout');
            searchService.searchMessages
                .mockResolvedValueOnce(page([msg]))     // channel 1 OK
                .mockRejectedValueOnce(error)           // channel 2 fails
                .mockResolvedValueOnce(page([]));       // channel 3 OK

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result.entries).toHaveLength(1);
            expect(result.coverage).toBe('partial');
            expect(result.failures).toEqual([{ source: `channel:${CHANNEL_2_ID}`, category: 'transient', error }]);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(
                { err: error, channelId: CHANNEL_2_ID },
                'DiscordHistoryProvider: channel search failed'
            );
        });

        test('reports unavailable coverage when every attempted channel search throws', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            searchService.searchMessages.mockRejectedValue(new Error('offline'));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result.entries).toEqual([]);
            expect(result.coverage).toBe('unavailable');
            expect(result.truncated).toBe(false);
            expect(result.failures.map(failure => failure.source)).toEqual([`channel:${CHANNEL_1_ID}`, `channel:${CHANNEL_2_ID}`]);
        });

        test('labels a failed DM search with the dm source rather than its channel ID', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages
                .mockRejectedValueOnce(new Error('dm closed'))
                .mockResolvedValueOnce(page([]));

            const result = await provider.fetchHistory({ identifier: 'Alice', scope: DISCORD_SCOPE });

            expect(result.coverage).toBe('partial');
            expect(result.failures.map(failure => failure.source)).toEqual(['dm']);
        });

        test('keeps DM precedence and good guild results when another guild search fails', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 3));
            searchService.searchMessages.mockImplementation(async ({ channelId }: { channelId: string }) => {
                if(channelId === DM_CHANNEL_ID) {
                    return page([makeMessage('shared', 'user-1', 'DM', 'wins', '2026-01-01T10:00:00.000Z')]);
                }
                if(channelId === CHANNEL_1_ID) {
                    return page([
                        makeMessage('shared', 'user-1', 'Guild', 'loses', '2026-01-01T11:00:00.000Z'),
                        makeMessage('guild-1', 'user-1', 'Guild', 'good', '2026-01-01T11:01:00.000Z'),
                    ]);
                }
                if(channelId === CHANNEL_2_ID) {
                    throw new Error('timeout');
                }
                return page([makeMessage('guild-3', 'user-3', 'Third', 'good', '2026-01-01T12:00:00.000Z')]);
            });

            const result = await provider.fetchHistory({ identifier: 'Alice', scope: { platform: 'discord', discordUserId: 'user-1' } });

            expect(result.entries.map(entry => entry.summary)).toEqual(['DM: wins', 'Guild: good', 'Third: good']);
            expect(result.coverage).toBe('partial');
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: CHANNEL_2_ID }), expect.any(String));
        });

        test('keeps messages collected before a malformed response entry fails', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            const first = makeMessage('first', 'user-1', 'A', 'kept', '2026-01-01T10:00:00.000Z');
            const second = makeMessage('second', 'user-2', 'B', 'also kept', '2026-01-01T11:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce(page([first, null]))
                .mockResolvedValueOnce(page([second]));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result.entries.map(entry => entry.summary)).toEqual(['A: kept', 'B: also kept']);
            expect(result.coverage).toBe('partial');
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: CHANNEL_1_ID }), expect.any(String));
        });

        test('marks the result truncated when a channel search reached its fetch limit', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            searchService.searchMessages
                .mockResolvedValueOnce(page([]))
                .mockResolvedValueOnce(page([], { metadata: { coverage: 'limitReached', fetched: 500, matchedInFetched: 0 } }));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result.truncated).toBe(true);
            expect(result.coverage).toBe('complete');
        });

        test('marks the result truncated when a channel search returned only a page of its matches', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValueOnce(page([], { overflow: { mode: 'count-only', count: 4 } }));

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result.truncated).toBe(true);
        });

        test('passes startTime and endTime to search', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));
            const startTime = new Date('2026-01-01T00:00:00.000Z');
            const endTime   = new Date('2026-01-02T00:00:00.000Z');

            await provider.fetchHistory({ identifier: 'Alice', startTime, endTime });

            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ startTime, endTime })
            );
        });

        test('passes maxMessages limit to search', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));

            await provider.fetchHistory({ identifier: 'Alice', maxMessages: 5 });

            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 5 })
            );
        });

        test('fetches from DM channel when the scope carries a discordUserId', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const dmMsg      = makeMessage('dm-1', 'user-123', 'Alice', 'DM message', '2026-01-01T10:00:00.000Z');
            const chanMsg    = makeMessage('ch-1', 'user-123', 'Alice', 'Channel msg', '2026-01-01T09:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce(page([dmMsg]))  // DM channel
                .mockResolvedValueOnce(page([chanMsg])); // regular channel

            const result = await provider.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            expect(dmTracker.getOrCreateDMByUsername).toHaveBeenCalledWith('alice');
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: DM_CHANNEL_ID })
            );
            expect(result.entries).toHaveLength(2);
            expect(result.coverage).toBe('complete');
        });

        test('skips the DM lookup when no Discord scope is given even with a dmTracker', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));

            await provider.fetchHistory({ identifier: 'alice' });

            expect(dmTracker.getOrCreateDMByUsername).not.toHaveBeenCalled();
            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('skips DM lookup when no dmTracker provided', async () => {
            const providerNoDM = new DiscordHistoryProvider(searchService, channelRegistry, BOT_USER_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));

            await providerNoDM.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            // Only channel searches, no DM lookup
            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('skips DM search when getOrCreateDMByUsername returns null', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(null);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));

            await provider.fetchHistory({ identifier: 'alice', scope: DISCORD_SCOPE });

            // Only 1 channel search, no DM search
            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('merges results from multiple channels', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            const msg1 = makeMessage('msg-1', 'user-123', 'Alice', 'Hello ch1', '2026-01-01T10:00:00.000Z');
            const msg2 = makeMessage('msg-2', 'user-456', 'Bob',   'Hello ch2', '2026-01-01T11:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce(page([msg1]))
                .mockResolvedValueOnce(page([msg2]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toHaveLength(2);
        });

        test('uses displayName from author when available', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                author:    { id: 'user-123', displayName: 'Alice Wonderland', username: 'alice_w' },
                content:   'Hello',
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('Alice Wonderland: Hello');
        });

        test('falls back to username when displayName not available', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                author:    { id: 'user-123', username: 'alice_w' },
                content:   'Hello',
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('alice_w: Hello');
        });

        test('uses "unknown" when author is undefined', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                content:   'Hello',
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('unknown: Hello');
        });

        test('handles missing content gracefully', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                author:    { id: 'user-123', username: 'alice_w' },
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('alice_w: ');
        });

        test('does not truncate content at exactly MAX_CONTENT_LENGTH chars', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const exactContent = 'B'.repeat(200);
            const msg = makeMessage('msg-1', 'user-123', 'Alice', exactContent, '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            // 200 chars should not be truncated (only > 200 triggers truncation)
            expect(result[0]?.summary).toBe(`Alice: ${exactContent}`);
        });

        test('truncates content longer than MAX_CONTENT_LENGTH down to exactly 200 chars', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const overContent = 'C'.repeat(201);
            const msg = makeMessage('msg-1', 'user-123', 'Alice', overContent, '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            // 201-char content must be cut to exactly 200 chars, not 201.
            expect(result[0]?.summary).toBe(`Alice: ${'C'.repeat(200)}`);
        });

        test('preserves within-channel message order (push, not unshift)', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg1 = makeMessage('order-1', 'user-1', 'A', 'first', '2026-01-01T10:00:00.000Z');
            const msg2 = makeMessage('order-2', 'user-2', 'B', 'second', '2026-01-01T11:00:00.000Z');
            const msg3 = makeMessage('order-3', 'user-3', 'C', 'third', '2026-01-01T12:00:00.000Z');
            searchService.searchMessages.mockResolvedValue(page([msg1, msg2, msg3]));

            const { entries: result } = await provider.fetchHistory({ identifier: 'Alice' });

            // A single channel returning multiple messages must keep the service's own
            // order; unshift would reverse it to [C, B, A].
            expect(result.map(entry => entry.summary)).toEqual(['A: first', 'B: second', 'C: third']);
        });

        test('passes startTime and endTime to the DM channel search without swapping them', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue([]);
            searchService.searchMessages.mockResolvedValue(page([]));
            const startTime = new Date('2026-01-01T00:00:00.000Z');
            const endTime   = new Date('2026-01-02T00:00:00.000Z');

            await provider.fetchHistory({
                identifier: 'alice',
                scope:      DISCORD_SCOPE,
                startTime,
                endTime,
            });

            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: DM_CHANNEL_ID, startTime, endTime })
            );
        });

        test('omits limit rather than defaulting it to 0 when maxMessages is not provided', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue(page([]));

            await provider.fetchHistory({ identifier: 'Alice' });

            const call = searchService.searchMessages.mock.calls[0]?.[0] as { limit?: number };
            expect(call.limit).toBeUndefined();
        });
    });
});
