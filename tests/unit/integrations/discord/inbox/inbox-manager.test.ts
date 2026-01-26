/* eslint-disable @typescript-eslint/unbound-method -- Test file uses mocks extensively */
import { describe, test, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { InboxManager } from '@/integrations/discord/inbox/inbox-manager';
import type { CheckpointManager } from '@/integrations/discord/inbox/checkpoint-manager';
import type { MessageSearchService } from '@/integrations/discord/message-history/search';
import type { DiscordChannelCheckpoint } from '@/integrations/discord/inbox/types';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';

describe.concurrent('InboxManager', () => {
    let mockCheckpointManager: CheckpointManager;
    let mockMessageSearchService: MessageSearchService;
    let manager: InboxManager;

    const channelId = createChannelId('123456789');
    const guildId = createGuildId('987654321');
    const nowIso = '2025-01-25T12:00:00.000Z';

    beforeEach(() => {
        // Use fake timers with a fixed system time for deterministic tests
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-25T12:00:00.000Z'));
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

        manager = new InboxManager({
            checkpointManager:    mockCheckpointManager,
            messageSearchService: mockMessageSearchService,
        });
    });

    afterEach(() => {
        // Restore real timers after each test
        jest.useRealTimers();
    });

    describe('trackChannel', () => {
        test('should register channel for tracking', async () => {
            const channel = {
                channelId,
                channelName: 'general',
                guildId,
            };

            await manager.trackChannel(channel);

            expect(mockCheckpointManager.initializeIfMissing).toHaveBeenCalledTimes(1);
            expect(mockCheckpointManager.initializeIfMissing).toHaveBeenCalledWith(channelId, guildId);
        });

        test('should handle DM channel', async () => {
            const dmChannel = {
                channelId,
                channelName: 'DM with User',
                guildId:     'DM' as const,
            };

            await manager.trackChannel(dmChannel);

            expect(mockCheckpointManager.initializeIfMissing).toHaveBeenCalledWith(channelId, 'DM');
        });

        test('should allow tracking multiple channels', async () => {
            const channel1 = {
                channelId:   createChannelId('111111111'),
                channelName: 'general',
                guildId:     createGuildId('999999999'),
            };

            const channel2 = {
                channelId:   createChannelId('222222222'),
                channelName: 'random',
                guildId:     createGuildId('888888888'),
            };

            await manager.trackChannel(channel1);
            await manager.trackChannel(channel2);

            expect(mockCheckpointManager.initializeIfMissing).toHaveBeenCalledTimes(2);
        });
    });

    describe('loadUnread', () => {
        test('should return zero when no checkpoints exist', async () => {
            mockCheckpointManager.listAll = mock(async () => []);

            const total = await manager.loadUnread();

            expect(total).toBe(0);
        });

        test('should skip channels with gap smaller than minGapDurationMs', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);

            const total = await manager.loadUnread();

            expect(total).toBe(0);
            expect(mockMessageSearchService.searchMessages).not.toHaveBeenCalled();
        });

        test('should load messages for channels with sufficient gap', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            const total = await manager.loadUnread();

            expect(total).toBe(1);
            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(1);
        });

        test('should limit catch-up age to maxCatchUpAgeDays', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock internals
            const call = (mockMessageSearchService.searchMessages as any).mock.calls[0][0] as { startTime: Date, limit: number };

            // Check that startTime is not 30 days ago, but limited to maxCatchUpAgeDays (7 days)
            // With fake timers, this is deterministic
            const startTime = new Date(call.startTime);
            const expectedStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            expect(startTime.getTime()).toBe(expectedStart.getTime());
        });

        test('should respect maxCatchUpMessages limit', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);

            await manager.loadUnread();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Accessing mock internals
            const call = (mockMessageSearchService.searchMessages as any).mock.calls[0][0] as { limit: number };
            expect(call.limit).toBe(100); // Default maxCatchUpMessages
        });

        test('should use tracked channel name if available', async () => {
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

            // Track channel with name
            await manager.trackChannel({
                channelId,
                channelName: 'general',
                guildId,
            });

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            const messages = manager.getChannelMessages(channelId);
            expect(messages[0].channelName).toBe('general');
        });

        test('should use channelId as fallback name if not tracked', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            const messages = manager.getChannelMessages(channelId);
            expect(messages[0].channelName).toBe(channelId);
        });

        test('should continue processing channels despite errors', async () => {
            const checkpoint1: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('111111111'),
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const checkpoint2: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId:  createChannelId('222222222'),
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            const mockMessages = [
                {
                    id:          '333',
                    channelId:   createChannelId('222222222'),
                    guildId:     null,
                    author:      { id: createUserId('user1'), username: 'bob', displayName: 'Bob' },
                    content:     'Success',
                    timestamp:   nowIso,
                    attachments: [],
                    embeds:      [],
                    reactions:   [],
                },
            ];

            mockCheckpointManager.listAll = mock(async () => [checkpoint1, checkpoint2]);

            let callCount = 0;
            mockMessageSearchService.searchMessages = mock(async () => {
                callCount++;
                if(callCount === 1) {
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

            const total = await manager.loadUnread();

            expect(total).toBe(1);
            expect(mockMessageSearchService.searchMessages).toHaveBeenCalledTimes(2);
        });

        test('should handle empty message results', async () => {
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            const total = await manager.loadUnread();

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

            await manager.trackChannel({
                channelId,
                channelName: 'general',
                guildId,
            });

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            const overview = manager.getUnreadOverview();

            expect(overview.totalUnread).toBe(1);
            expect(overview.channels).toHaveLength(1);
            expect(overview.channels[0].channelId).toBe(channelId);
            expect(overview.channels[0].channelName).toBe('general');
            expect(overview.channels[0].messageCount).toBe(1);
        });

        test('should exclude channels with all messages marked as read', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();
            await manager.markChannelRead(channelId);

            const overview = manager.getUnreadOverview();

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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();
            await manager.markAsRead(channelId, ['111']);

            const messages = manager.getChannelMessages(channelId);

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
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
            await manager.loadUnread();

            const message = manager.getMessage(channelId, '999');

            expect(message).toBeUndefined();
        });

        test('should return message by ID', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            const message = manager.getMessage(channelId, '111');

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

            await manager.trackChannel({
                channelId,
                channelName: 'general',
                guildId,
            });

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            await manager.markAsRead(channelId, ['111']);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:00:00.000Z',
                '111'
            );

            const messages = manager.getChannelMessages(channelId);
            expect(messages).toHaveLength(0);
        });

        test('should update checkpoint to latest marked message', async () => {
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

            await manager.trackChannel({
                channelId,
                channelName: 'general',
                guildId,
            });

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            await manager.markAsRead(channelId, ['111', '222']);

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
            const checkpoint: DiscordChannelCheckpoint = {
                service:    'discord',
                channelId,
                guildId,
                lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                updatedAt:  nowIso,
            };

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
            await manager.loadUnread();

            await manager.markChannelRead(channelId);

            expect(mockCheckpointManager.updateLastSeen).not.toHaveBeenCalled();
        });

        test('should mark all messages as read', async () => {
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

            await manager.trackChannel({
                channelId,
                channelName: 'general',
                guildId,
            });

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            await manager.markChannelRead(channelId);

            expect(mockCheckpointManager.updateLastSeen).toHaveBeenCalledWith(
                channelId,
                guildId,
                '2025-01-24T10:05:00.000Z',
                '222'
            );

            const messages = manager.getChannelMessages(channelId);
            expect(messages).toHaveLength(0);
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            expect(manager.totalUnread).toBe(2);
        });

        test('should exclude read messages from count', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();
            await manager.markAsRead(channelId, ['111']);

            expect(manager.totalUnread).toBe(1);
        });
    });

    describe('hasUnread getter', () => {
        test('should return false when no messages', () => {
            expect(manager.hasUnread).toBe(false);
        });

        test('should return true with unread messages', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();

            expect(manager.hasUnread).toBe(true);
        });

        test('should return false after marking all as read', async () => {
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

            mockCheckpointManager.listAll = mock(async () => [checkpoint]);
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

            await manager.loadUnread();
            await manager.markChannelRead(channelId);

            expect(manager.hasUnread).toBe(false);
        });
    });
});
