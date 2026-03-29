/**
 * Tests for DiscordHistoryProvider
 *
 * Verifies that:
 * - Fetches from DM channel when discordUserId metadata provided
 * - Fetches from unmuted channels with person's name as query
 * - Caps at 3 channels
 * - Deduplicates messages by ID across channels
 * - Converts messages to HistoryEntry format correctly
 * - Sets direction based on author (bot vs user)
 * - Truncates long message content
 * - Handles search errors gracefully (one channel fails, others succeed)
 * - Returns empty array when no channels found
 * - Returns empty array when no messages match
 * - Passes startTime/endTime to search
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { mockLogger } from '../../../setup';
import type { MCPMessageSearchService, MCPChannelRegistry, MCPDMTracker, MCPChannelInfo, ChannelId } from '@/agent';
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

const UNMUTED_CHANNELS: MCPChannelInfo[] = [
    { channelId: CHANNEL_1_ID, channelName: 'general',  guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_2_ID, channelName: 'random',   guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_3_ID, channelName: 'projects', guildId: 'guild-1', isMuted: false },
    { channelId: CHANNEL_4_ID, channelName: 'fourth',   guildId: 'guild-1', isMuted: false },
];

function makeMessage(id: string, authorId: string, authorName: string, content: string, timestamp: string) {
    return {
        id,
        author:    { id: authorId, displayName: authorName, username: authorName }, // eslint-disable-line @stylistic/key-spacing -- aligned with surrounding shorthand keys
        content,
        timestamp,
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
        searchMessages:    mock(async () => ({ messages: [] })),
        getRecentMessages: mock(async () => ({ messages: [] })),
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
} & MCPChannelRegistry {
    return {
        getUnmutedChannels: mock(async (): Promise<MCPChannelInfo[]> => []),
        resolveChannelId:   mock(() => CHANNEL_1_ID),
        muteChannel:        mock(async () => {}),
        unmuteChannel:      mock(async () => {}),
        getAllChannels:     mock((): MCPChannelInfo[] => []),
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
        test('returns empty array when no channels found', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue([]);

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toEqual([]);
        });

        test('returns empty array when no messages match', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toEqual([]);
        });

        test('fetches from unmuted channels with identifier as query', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            await provider.fetchHistory({ identifier: 'Alice' });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(2);
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: CHANNEL_1_ID, query: 'Alice' })
            );
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: CHANNEL_2_ID, query: 'Alice' })
            );
        });

        test('caps channel search at 3 channels even when more unmuted channels exist', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS); // 4 channels
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            await provider.fetchHistory({ identifier: 'Alice' });

            expect(searchService.searchMessages).toHaveBeenCalledTimes(3);
        });

        test('converts messages to HistoryEntry format with inbound direction for non-bot', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello there', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

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
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.direction).toBe('outbound');
        });

        test('sets direction to mutual when botUserId is empty (pre-login construction)', async () => {
            // Constructed before Discord login — botUserId will be empty string
            const earlyProvider = new DiscordHistoryProvider(searchService, channelRegistry, '');
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await earlyProvider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.direction).toBe('mutual');
        });

        test('truncates long message content to ~200 chars', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const longContent = 'A'.repeat(300);
            const msg = makeMessage('msg-1', 'user-123', 'Alice', longContent, '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary.length).toBeLessThanOrEqual(215); // "Alice: " + 200 chars
            expect(result[0]?.summary).toContain('Alice: ');
        });

        test('deduplicates messages by ID across channels', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            const msg = makeMessage('msg-1', 'user-123', 'Alice', 'Hello', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            // Same message returned from 2 channels — should appear only once
            expect(result).toHaveLength(1);
        });

        test('handles search errors gracefully — one channel fails, others succeed', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 3));
            const msg = makeMessage('msg-ok', 'user-123', 'Alice', 'Hi', '2026-01-01T10:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce({ messages: [msg] })      // channel 1 OK
                .mockRejectedValueOnce(new Error('timeout'))     // channel 2 fails
                .mockResolvedValueOnce({ messages: [] });         // channel 3 OK

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result).toHaveLength(1);
            expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        });

        test('passes startTime and endTime to search', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue({ messages: [] });
            const startTime = new Date('2026-01-01T00:00:00.000Z');
            const endTime   = new Date('2026-01-02T00:00:00.000Z');

            await provider.fetchHistory({ identifier: 'Alice', startTime, endTime });

            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ startTime, endTime })
            );
        });

        test('passes maxMessages limit to search', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            await provider.fetchHistory({ identifier: 'Alice', maxMessages: 5 });

            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 5 })
            );
        });

        test('fetches from DM channel when discordUserId metadata provided', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(DM_CHANNEL_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const dmMsg      = makeMessage('dm-1', 'user-123', 'Alice', 'DM message', '2026-01-01T10:00:00.000Z');
            const chanMsg    = makeMessage('ch-1', 'user-123', 'Alice', 'Channel msg', '2026-01-01T09:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce({ messages: [dmMsg] })  // DM channel
                .mockResolvedValueOnce({ messages: [chanMsg] }); // regular channel

            const result = await provider.fetchHistory({
                identifier: 'alice',
                metadata:   { discordUserId: 'user-123' },
            });

            expect(dmTracker.getOrCreateDMByUsername).toHaveBeenCalledWith('alice');
            expect(searchService.searchMessages).toHaveBeenCalledWith(
                expect.objectContaining({ channelId: DM_CHANNEL_ID })
            );
            expect(result).toHaveLength(2);
        });

        test('skips DM lookup when no dmTracker provided', async () => {
            const providerNoDM = new DiscordHistoryProvider(searchService, channelRegistry, BOT_USER_ID);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            await providerNoDM.fetchHistory({
                identifier: 'alice',
                metadata:   { discordUserId: 'user-123' },
            });

            // Only channel searches, no DM lookup
            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('skips DM search when getOrCreateDMByUsername returns null', async () => {
            dmTracker.getOrCreateDMByUsername.mockResolvedValue(null);
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            searchService.searchMessages.mockResolvedValue({ messages: [] });

            await provider.fetchHistory({
                identifier: 'alice',
                metadata:   { discordUserId: 'user-123' },
            });

            // Only 1 channel search, no DM search
            expect(searchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('merges results from multiple channels', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 2));
            const msg1 = makeMessage('msg-1', 'user-123', 'Alice', 'Hello ch1', '2026-01-01T10:00:00.000Z');
            const msg2 = makeMessage('msg-2', 'user-456', 'Bob',   'Hello ch2', '2026-01-01T11:00:00.000Z');
            searchService.searchMessages
                .mockResolvedValueOnce({ messages: [msg1] })
                .mockResolvedValueOnce({ messages: [msg2] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

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
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

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
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('alice_w: Hello');
        });

        test('uses "unknown" when author is undefined', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                content:   'Hello',
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('unknown: Hello');
        });

        test('handles missing content gracefully', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const msg = {
                id:        'msg-1',
                author:    { id: 'user-123', username: 'alice_w' },
                timestamp: '2026-01-01T10:00:00.000Z',
            };
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            expect(result[0]?.summary).toBe('alice_w: ');
        });

        test('does not truncate content at exactly MAX_CONTENT_LENGTH chars', async () => {
            channelRegistry.getUnmutedChannels.mockResolvedValue(UNMUTED_CHANNELS.slice(0, 1));
            const exactContent = 'B'.repeat(200);
            const msg = makeMessage('msg-1', 'user-123', 'Alice', exactContent, '2026-01-01T10:00:00.000Z');
            searchService.searchMessages.mockResolvedValue({ messages: [msg] });

            const result = await provider.fetchHistory({ identifier: 'Alice' });

            // 200 chars should not be truncated (only > 200 triggers truncation)
            expect(result[0]?.summary).toBe(`Alice: ${exactContent}`);
        });
    });
});
