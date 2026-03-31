import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { mockLogger } from '../../../../setup';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';

describe('InboxManager', () => {
    let mockCheckpointManager: CheckpointManager;
    let mockMessageSearchService: MessageSearchService;
    let mockChannelRegistry: ChannelRegistryManager;
    let manager: InboxManager;

    const channelId = createChannelId('123456789');
    const guildId = createGuildId('987654321');
    const nowIso = '2025-01-25T12:00:00.000Z';

    beforeEach(() => {
        // Use fake timers with a fixed system time for deterministic tests
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-25T12:00:00.000Z'));

        // Clear logger mocks
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();

        mockCheckpointManager = {
            load:                mock(async () => undefined),
            save:                mock(async () => { /* intentionally empty */ }),
            initializeIfMissing: mock(async () => ({
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: nowIso,
                updatedAt:  nowIso,
            })),
            updateLastSeen: mock(async () => ({
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: nowIso,
                updatedAt:  nowIso,
            })),
            listAll: mock(async () => []),
        } as unknown as CheckpointManager;

        mockMessageSearchService = {
            searchMessages: mock(async () => ({
                messages: [],
                metadata: {
                    totalFound: 0,
                    timeRange:  {
                        start: new Date().toISOString(),
                        end:   new Date().toISOString(),
                    },
                },
            })),
        } as unknown as MessageSearchService;

        mockChannelRegistry = {
            getUnmutedChannels: mock(async () => []),  // Empty by default, tests will populate as needed
        } as unknown as ChannelRegistryManager;

        manager = new InboxManager({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockMessageSearchService,
            channelRegistry:      mockChannelRegistry,
        });
    });

    afterEach(() => {
        // Restore real timers after each test
        jest.useRealTimers();
    });

    describe('updateChannelMetadata', () => {
        test('should update channel metadata cache', () => {
            manager.updateChannelMetadata(channelId, 'general', guildId);

            // Verify metadata is cached by checking getChannelName
            expect(manager.getChannelName(channelId)).toBe('general');
        });

        test('should handle DM channel', () => {
            manager.updateChannelMetadata(channelId, 'DM with User', 'DM');

            expect(manager.getChannelName(channelId)).toBe('DM with User');
        });

        test('should allow updating multiple channels', () => {
            const channel1Id = createChannelId('111111111');
            const channel2Id = createChannelId('222222222');

            manager.updateChannelMetadata(channel1Id, 'general', createGuildId('999999999'));
            manager.updateChannelMetadata(channel2Id, 'random', createGuildId('888888888'));

            expect(manager.getChannelName(channel1Id)).toBe('general');
            expect(manager.getChannelName(channel2Id)).toBe('random');
        });

        test('should overwrite existing metadata', () => {
            manager.updateChannelMetadata(channelId, 'old-name', guildId);
            manager.updateChannelMetadata(channelId, 'new-name', guildId);

            expect(manager.getChannelName(channelId)).toBe('new-name');
        });
    });

    describe('loadUnread', () => {
        test('should return zero when no unmuted channels', async () => {
            // Manager has empty channelRegistry from beforeEach
            const total = await manager.loadUnread();

            expect(total).toBe(0);
        });

        test('should skip channels with gap smaller than minGapDurationMs', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago (less than 10s default)
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);

            const total = await managerWithChannel.loadUnread();

            expect(total).toBe(0);
            expect(mockMessageSearchService.searchMessages).not.toHaveBeenCalled();
        });

        test('should load messages for channels with sufficient gap', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            const total = await managerWithChannel.loadUnread();

            expect(total).toBe(1);
            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('should limit catch-up age to maxCatchUpAgeDays', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: [],
                metadata: {
                    totalFound: 0,
                    timeRange:  {
                        start: new Date().toISOString(),
                        end:   new Date().toISOString(),
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(1);
            const call = (mockMessageSearchService.searchMessages as ReturnType<typeof mock>).mock.calls[0][0] as { startTime: Date, limit: number };

            // Check that startTime is not 30 days ago, but limited to maxCatchUpAgeDays (7 days)
            // With fake timers, this is deterministic
            const startTime = new Date(call.startTime);
            const expectedStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            expect(startTime.getTime()).toBe(expectedStart.getTime());
        });

        test('should respect maxCatchUpMessages limit', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);

            await managerWithChannel.loadUnread();

            const call = (mockMessageSearchService.searchMessages as ReturnType<typeof mock>).mock.calls[0][0] as { limit: number };
            expect(call.limit).toBe(100); // Default maxCatchUpMessages
        });

        test('should use channel name from registry', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: 'general',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            const messages = managerWithChannel.getChannelMessages(channelId);
            expect(messages[0].channelName).toBe('general');
        });

        test('should use channel name from registry metadata', async () => {
            // Create mock registry with channel metadata
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#registered-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            const messages = managerWithChannel.getChannelMessages(channelId);
            expect(messages[0].channelName).toBe('#registered-channel');
        });

        test('should continue processing channels despite errors', async () => {
            const channel1Id = createChannelId('111111111');
            const channel2Id = createChannelId('222222222');

            // Create mock registry with two unmuted channels
            const mockRegistryWithChannels = {
                getUnmutedChannels: mock(async () => [
                    { channelId: channel1Id, channelName: '#channel-1', guildId, isMuted: false },
                    { channelId: channel2Id, channelName: '#channel-2', guildId, isMuted: false },
                ]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannels = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannels,
            });

            const checkpoint1: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  channel1Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const checkpoint2: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  channel2Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '333',
                    channelId:   channel2Id,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'bob', displayName: 'Bob' },
                    content:     'Success',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            // Mock load to return checkpoints for each channel
            mockCheckpointManager.load = mock(async (id) => {
                if(id === channel1Id) {
                    return checkpoint1;
                }
                if(id === channel2Id) {
                    return checkpoint2;
                }
                return undefined;
            });

            // First call throws error, second succeeds
            let searchCallCount = 0;
            mockMessageSearchService.searchMessages = mock(async () => {
                searchCallCount++;
                if(searchCallCount === 1) {
                    throw new Error('Network error');
                }
                return {
                    messages: mockMessages,
                    metadata: {
                        totalFound: mockMessages.length,
                        timeRange:  {
                            start: mockMessages[0].timestamp,
                            end:   mockMessages[0].timestamp,
                        },
                    },
                };
            });

            const total = await managerWithChannels.loadUnread();

            expect(total).toBe(1);
            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(2);
        });

        test('should log summary with success and fail counts', async () => {
            const channel1Id = createChannelId('111111111');
            const channel2Id = createChannelId('222222222');

            // Create mock registry with two unmuted channels
            const mockRegistryWithChannels = {
                getUnmutedChannels: mock(async () => [
                    { channelId: channel1Id, channelName: '#channel-1', guildId, isMuted: false },
                    { channelId: channel2Id, channelName: '#channel-2', guildId, isMuted: false },
                ]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannels = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannels,
            });

            const checkpoint1: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  channel1Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const checkpoint2: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  channel2Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            // Mock load to return checkpoints for each channel
            mockCheckpointManager.load = mock(async (id) => {
                if(id === channel1Id) {
                    return checkpoint1;
                }
                if(id === channel2Id) {
                    return checkpoint2;
                }
                return undefined;
            });

            // First call throws error, second succeeds
            let searchCallCount = 0;
            mockMessageSearchService.searchMessages = mock(async () => {
                searchCallCount++;
                if(searchCallCount === 1) {
                    throw new Error('Network error');
                }
                return {
                    messages: [],
                    metadata: {
                        totalFound: 0,
                        timeRange:  {
                            start: nowIso,
                            end:   nowIso,
                        },
                    },
                };
            });

            const total = await managerWithChannels.loadUnread();

            // Verify that loadUnread completes successfully despite one channel failing
            expect(total).toBe(0); // No messages loaded since both channels had empty results
            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(2);

            // Verify the summary log message contains correct counts
            // Look for the log call with successCount and failCount
            const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls as unknown[][];
            const summaryLogCall = infoCalls.find((call: unknown[]) => typeof call[0] === 'object' && call[0] !== null && 'successCount' in (call[0] as Record<string, unknown>) && 'failCount' in (call[0] as Record<string, unknown>));

            expect(summaryLogCall).toBeDefined();
            const summaryArg = summaryLogCall![0] as Record<string, unknown>;
            expect(summaryArg.successCount).toBe(1);
            expect(summaryArg.failCount).toBe(1);
        });

        test('should filter out bot messages when botUserId is set via setBotUserId', async () => {
            const botUserId = createUserId('bot-user-999');

            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Set bot user ID after construction (like the real bot does after clientReady)
            managerWithChannel.setBotUserId(botUserId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            // Return three messages: one from a user, one from the bot, one from another user
            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello from Alice',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: botUserId, username: 'bot', displayName: 'Bot' },
                    content:     'Response from bot',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '333',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Hello from Bob',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[2].timestamp,
                    },
                },
            }));

            const total = await managerWithChannel.loadUnread();

            // Only the 2 non-bot messages should be loaded
            expect(total).toBe(2);

            const messages = managerWithChannel.getChannelMessages(channelId);
            expect(messages).toHaveLength(2);

            // Non-bot messages are present
            expect(messages.find(m => m.id === '111')).toBeDefined();
            expect(messages.find(m => m.id === '333')).toBeDefined();

            // Bot message is filtered out
            expect(messages.find(m => m.id === '222')).toBeUndefined();
        });

        test('should not filter any messages when botUserId is not set', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            // Manager created without botUserId
            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello from Alice',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('some-bot'), username: 'bot', displayName: 'Bot' },
                    content:     'Could be a bot message',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            const total = await managerWithChannel.loadUnread();

            // All messages kept when no botUserId is set
            expect(total).toBe(2);
        });

        test('should log starting message with channel count', async () => {
            const channel1Id = createChannelId('111111111');
            const channel2Id = createChannelId('222222222');
            const channel3Id = createChannelId('333333333');

            const mockRegistryWithChannels = {
                getUnmutedChannels: mock(async () => [
                    { channelId: channel1Id, channelName: '#channel-1', guildId, isMuted: false },
                    { channelId: channel2Id, channelName: '#channel-2', guildId, isMuted: false },
                    { channelId: channel3Id, channelName: '#channel-3', guildId, isMuted: false },
                ]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannels = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannels,
            });

            await managerWithChannels.loadUnread();

            const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls as unknown[][];
            const startLogCall = infoCalls.find((call: unknown[]) => {
                const arg = call[0];
                if(typeof arg !== 'object' || arg === null) {
                    return false;
                }
                const rec = arg as Record<string, unknown>;
                return 'channelCount' in rec && rec.msg === 'Loading unread messages...';
            });

            expect(startLogCall).toBeDefined();
            const startArg = startLogCall![0] as Record<string, unknown>;
            expect(startArg.channelCount).toBe(3);
        });

        test('should log per-channel debug progress', async () => {
            const channel1Id = createChannelId('111111111');
            const channel2Id = createChannelId('222222222');

            const mockRegistryWithChannels = {
                getUnmutedChannels: mock(async () => [
                    { channelId: channel1Id, channelName: '#channel-1', guildId, isMuted: false },
                    { channelId: channel2Id, channelName: '#channel-2', guildId, isMuted: false },
                ]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannels = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannels,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  channel1Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 5000).toISOString(), // gap too small — skipped
                updatedAt:  nowIso,
            };
            mockCheckpointManager.load = mock(async () => checkpoint);

            await managerWithChannels.loadUnread();

            const debugCalls = (mockLogger.debug as ReturnType<typeof mock>).mock.calls as unknown[][];
            const perChannelCalls = debugCalls.filter((call: unknown[]) => {
                const arg = call[0];
                if(typeof arg !== 'object' || arg === null) {
                    return false;
                }
                const rec = arg as Record<string, unknown>;
                return 'index' in rec && 'total' in rec && rec.msg === 'Loading channel...';
            });

            expect(perChannelCalls).toHaveLength(2);
            const first = perChannelCalls[0][0] as Record<string, unknown>;
            expect(first.index).toBe(1);
            expect(first.total).toBe(2);
            expect(first.channelName).toBe('#channel-1');
        });

        test('should log completion summary with elapsed time', async () => {
            const channel1Id = createChannelId('111111111');

            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [
                    { channelId: channel1Id, channelName: '#channel-1', guildId, isMuted: false },
                ]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Give it a checkpoint with a sufficient gap so the channel fully processes (hits successCount++)
            mockCheckpointManager.load = mock(async () => ({
                service:    'discord' as const,
                channelId:  channel1Id,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
                updatedAt:  nowIso,
            }));

            await managerWithChannel.loadUnread();

            const infoCalls = (mockLogger.info as ReturnType<typeof mock>).mock.calls as unknown[][];
            const summaryCall = infoCalls.find((call: unknown[]) => {
                const arg = call[0];
                if(typeof arg !== 'object' || arg === null) {
                    return false;
                }
                const rec = arg as Record<string, unknown>;
                return 'elapsedMs' in rec && 'successCount' in rec && 'failCount' in rec;
            });

            expect(summaryCall).toBeDefined();
            const summaryArg = summaryCall![0] as Record<string, unknown>;
            expect(typeof summaryArg.elapsedMs).toBe('number');
            expect(summaryArg.successCount).toBe(1);
            expect(summaryArg.failCount).toBe(0);
        });

        test('should handle empty message results', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: [],
                metadata: {
                    totalFound: 0,
                    timeRange:  {
                        start: new Date().toISOString(),
                        end:   new Date().toISOString(),
                    },
                },
            }));

            const total = await managerWithChannel.loadUnread();

            expect(total).toBe(0);
        });
    });

    describe('getUnreadOverview', () => {
        test('should return empty overview when no unread messages', () => {
            const overview = manager.getUnreadOverview();

            expect(overview.totalUnread).toBe(0);
            expect(overview.channels).toEqual([]);
        });

        test('should return correct overview with unread messages', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: 'general',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Update metadata cache with channel name for getUnreadOverview
            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            // Load some messages
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            const overview = managerWithChannel.getUnreadOverview();

            expect(overview.totalUnread).toBe(1);
            expect(overview.channels).toHaveLength(1);
            expect(overview.channels[0].channelId).toBe(channelId);
            expect(overview.channels[0].channelName).toBe('general');
            expect(overview.channels[0].messageCount).toBe(1);
        });

        test('should exclude channels with all messages marked as read', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();
            await managerWithChannel.markChannelRead(channelId);

            const overview = managerWithChannel.getUnreadOverview();

            expect(overview.totalUnread).toBe(0);
            expect(overview.channels).toEqual([]);
        });
    });

    describe('getChannelMessages', () => {
        test('should return empty array for unknown channel', () => {
            const messages = manager.getChannelMessages(channelId);

            expect(messages).toEqual([]);
        });

        test('should return unread messages only', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();
            await managerWithChannel.markAsRead(channelId, ['111']);

            const messages = managerWithChannel.getChannelMessages(channelId);

            expect(messages).toHaveLength(1);
            expect(messages[0].id).toBe('222');
        });
    });

    describe('getMessage', () => {
        test('should return undefined for unknown channel', () => {
            const message = manager.getMessage(channelId, '111');

            expect(message).toBeUndefined();
        });

        test('should return undefined for unknown message', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);
            await managerWithChannel.loadUnread();

            const message = managerWithChannel.getMessage(channelId, '999');

            expect(message).toBeUndefined();
        });

        test('should return message by ID', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            const message = managerWithChannel.getMessage(channelId, '111');

            expect(message).toBeDefined();
            expect(message?.id).toBe('111');
            expect(message?.author).toBe('Alice');
        });
    });

    describe('markAsRead', () => {
        test('should do nothing for unknown channel', async () => {
            await manager.markAsRead(channelId, ['111']);

            expect(mockCheckpointManager.updateLastSeen).not.toHaveBeenCalled();
        });

        test('should mark messages as read and update checkpoint', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Update metadata
            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            await managerWithChannel.markAsRead(channelId, ['111']);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:00:00.000Z',
                '111'
            );

            const messages = managerWithChannel.getChannelMessages(channelId);
            expect(messages).toHaveLength(0);
        });

        test('should update checkpoint to latest marked message', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Update metadata
            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            await managerWithChannel.markAsRead(channelId, ['111', '222']);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:05:00.000Z',
                '222'
            );
        });

        test('should update checkpoint to highest-timestamp message when messages arrive in reverse chronological order', async () => {
            // This test kills the ConditionalExpression → true mutant on the latestTimestamp comparison.
            // With mutant → true, the LAST iterated message wins (second in array, earlier timestamp).
            // Messages here are in REVERSE order: newer first (222), older second (111).
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            // Messages in REVERSE chronological order: newer first
            const mockMessages = [
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second (newer)',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First (older)',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[1].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            // Mark both messages as read
            await managerWithChannel.markAsRead(channelId, ['111', '222']);

            // Should use the HIGHEST timestamp (222 at 10:05), not the last iterated (111 at 10:00)
            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:05:00.000Z',
                '222'
            );
        });

        test('should handle marking non-existent messages', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
            await manager.loadUnread();

            await manager.markAsRead(channelId, ['999']);

            expect(mockCheckpointManager.updateLastSeen).not.toHaveBeenCalled();
        });
    });

    describe('markChannelRead', () => {
        test('should do nothing for unknown channel', async () => {
            await manager.markChannelRead(channelId);

            expect(mockCheckpointManager.updateLastSeen).not.toHaveBeenCalled();
        });

        test('should do nothing for channel with no messages', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.load = mock(async () => checkpoint);
            await managerWithChannel.loadUnread();

            await managerWithChannel.markChannelRead(channelId);

            expect(mockCheckpointManager.updateLastSeen).not.toHaveBeenCalled();
        });

        test('should mark all messages as read', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            // Update metadata
            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            await managerWithChannel.markChannelRead(channelId);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:05:00.000Z',
                '222'
            );

            const messages = managerWithChannel.getChannelMessages(channelId);
            expect(messages).toHaveLength(0);
        });

        test('should use highest-timestamp message as checkpoint when messages arrive in reverse chronological order', async () => {
            // This test kills the ConditionalExpression → true mutant on the latestMessage comparison.
            // With mutant → true, the LAST iterated message wins (second in array, earlier timestamp).
            // Messages here are in REVERSE order: newer first (222), older second (111).
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            managerWithChannel.updateChannelMetadata(channelId, 'general', guildId);

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            // Messages in REVERSE chronological order: newer first
            const mockMessages = [
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second (newer)',
                    timestamp:   '2025-01-24T10:05:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First (older)',
                    timestamp:   '2025-01-24T10:00:00.000Z',
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[1].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();
            await managerWithChannel.markChannelRead(channelId);

            // Should use the HIGHEST timestamp (222 at 10:05), not the last iterated (111 at 10:00)
            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:05:00.000Z',
                '222'
            );
        });
    });

    describe('recordActivity', () => {
        test('should update checkpoint', async () => {
            await manager.recordActivity(channelId, guildId, '111', nowIso);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                nowIso,
                '111'
            );
        });

        test('should handle DM guild ID', async () => {
            await manager.recordActivity(channelId, 'DM', '111', nowIso);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                'DM',
                nowIso,
                '111'
            );
        });
    });

    describe('totalUnread getter', () => {
        test('should return zero when no messages', () => {
            expect(manager.totalUnread).toBe(0);
        });

        test('should return correct count with unread messages', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            expect(managerWithChannel.totalUnread).toBe(2);
        });

        test('should exclude read messages from count', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'First',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
                {
                    id:          '222',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user2'), username: 'bob', displayName: 'Bob' },
                    content:     'Second',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[1].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();
            await managerWithChannel.markAsRead(channelId, ['111']);

            expect(managerWithChannel.totalUnread).toBe(1);
        });
    });

    describe('hasUnread getter', () => {
        test('should return false when no messages', () => {
            expect(manager.hasUnread).toBe(false);
        });

        test('should return true with unread messages', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();

            expect(managerWithChannel.hasUnread).toBe(true);
        });

        test('should return false after marking all as read', async () => {
            // Create mock registry with one unmuted channel
            const mockRegistryWithChannel = {
                getUnmutedChannels: mock(async () => [{
                    channelId,
                    channelName: '#test-channel',
                    guildId,
                    isMuted:     false,
                }]),
            } as unknown as ChannelRegistryManager;

            const managerWithChannel = new InboxManager({
                checkpointManager:    mockCheckpointManager,
                messageSearchService: mockMessageSearchService,
                channelRegistry:      mockRegistryWithChannel,
            });

            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '111',
                    channelId,
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'alice', displayName: 'Alice' },
                    content:     'Hello',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.load = mock(async () => checkpoint);
            mockMessageSearchService.searchMessages = mock(async () => ({
                messages: mockMessages,
                metadata: {
                    totalFound: mockMessages.length,
                    timeRange:  {
                        start: mockMessages[0].timestamp,
                        end:   mockMessages[0].timestamp,
                    },
                },
            }));

            await managerWithChannel.loadUnread();
            await managerWithChannel.markChannelRead(channelId);

            expect(managerWithChannel.hasUnread).toBe(false);
        });
    });
});
