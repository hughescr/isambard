import { describe, it, expect, beforeEach, mock, type Mock, afterEach } from 'bun:test';
import type { Client, Guild, GuildChannel } from 'discord.js';
import _ from 'lodash';
import {
    discoverAllChannels,
    setupChannelEventHandlers
} from '@/integrations/discord/channel-registry/discovery';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

describe('discovery', () => {
    let mockManager: ChannelRegistryManager;
    let mockClient: Client;
    let mockGuild: Guild;

    beforeEach(() => {
        // Mock manager
        mockManager = {
            getChannel:    mock(_.constant(Promise.resolve(null))),
            upsertChannel: mock(_.noop),
            deleteChannel: mock(_.noop),
        } as unknown as ChannelRegistryManager;

        // Mock guild
        mockGuild = {
            id:       'guild-123',
            channels: {
                fetch: mock(async () => new Map()),
            },
        } as unknown as Guild;

        // Mock client
        mockClient = {
            guilds: {
                cache: new Map(),
            },
            on: mock(_.noop),
        } as unknown as Client;
    });

    afterEach(() => {
        // Clear all mocks
        (mockManager.getChannel as Mock<() => Promise<ChannelMetadata | null>>).mockClear();
        (mockManager.upsertChannel as Mock<(metadata: ChannelMetadata) => Promise<void>>).mockClear();
        (mockManager.deleteChannel as Mock<(channelId: string) => Promise<void>>).mockClear();
    });

    describe('discoverAllChannels', () => {
        it('should return empty result when no guilds', async () => {
            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result).toEqual({
                discovered: 0,
                updated:    0,
                errors:     [],
            });
        });

        it('should discover channels from single guild', async () => {
            // Create mock text channel
            const mockChannel = {
                id:   'channel-1',
                name: 'general',
                send: mock(_.noop), // Makes it text-based
            } as unknown as GuildChannel;

            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('channel-1', mockChannel);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(1);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);
        });

        it('should update channels already in registry', async () => {
            const mockChannel = {
                id:   'channel-1',
                name: 'general-renamed',
                send: mock(_.noop),
            } as unknown as GuildChannel;

            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('channel-1', mockChannel);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            // Mock existing channel with old name
            (mockManager.getChannel as Mock<() => Promise<ChannelMetadata | null>>).mockResolvedValue({
                channelId:    createChannelId('channel-1'),
                guildId:      createGuildId('guild-123'),
                channelName:  'general',
                isMuted:      false,
                discoveredAt: '2025-01-01T00:00:00.000Z',
                lastSeenAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:    '2025-01-01T00:00:00.000Z',
            });

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(0);
            expect(result.updated).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

            // Verify the updated metadata
            const call = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0];
            const metadata = call?.[0] as ChannelMetadata;

            expect(metadata.channelName).toBe('general-renamed');
            expect(metadata.isMuted).toBe(false);
            expect(metadata.discoveredAt).toBe('2025-01-01T00:00:00.000Z');
            expect(metadata.lastSeenAt).not.toBe('2025-01-01T00:00:00.000Z');
            expect(metadata.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');
        });

        it('should preserve user settings when updating channels', async () => {
            const mockChannel = {
                id:   'channel-1',
                name: 'general-renamed',
                send: mock(_.noop),
            } as unknown as GuildChannel;

            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('channel-1', mockChannel);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            // Mock existing channel with user settings
            (mockManager.getChannel as Mock<() => Promise<ChannelMetadata | null>>).mockResolvedValue({
                channelId:    createChannelId('channel-1'),
                guildId:      createGuildId('guild-123'),
                channelName:  'general',
                isMuted:      true,  // User muted this channel
                isWellKnown:  'general' as const,  // Admin marked as well-known
                discoveredAt: '2025-01-01T00:00:00.000Z',
                lastSeenAt:   '2025-01-01T00:00:00.000Z',
                updatedAt:    '2025-01-01T00:00:00.000Z',
            });

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(0);
            expect(result.updated).toBe(1);

            // Verify user settings are preserved
            const call = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0];
            const metadata = call?.[0] as ChannelMetadata;

            expect(metadata.channelName).toBe('general-renamed');  // Updated from Discord
            expect(metadata.isMuted).toBe(true);  // Preserved user setting
            expect(metadata.isWellKnown).toBe('general');  // Preserved admin setting
            expect(metadata.discoveredAt).toBe('2025-01-01T00:00:00.000Z');  // Preserved
            expect(metadata.lastSeenAt).not.toBe('2025-01-01T00:00:00.000Z');  // Updated
            expect(metadata.updatedAt).not.toBe('2025-01-01T00:00:00.000Z');  // Updated
        });

        it('should skip non-text channels', async () => {
            // Category channel (no send method)
            const mockCategory = {
                id:   'category-1',
                name: 'category',
                type: 4, // CategoryChannel type
            } as unknown as GuildChannel;

            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('category-1', mockCategory);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(0);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(mockManager.upsertChannel).not.toHaveBeenCalled();
        });

        it('should skip null channels', async () => {
            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('channel-1', null);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(0);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should handle multiple guilds', async () => {
            const mockGuild1 = {
                id:       'guild-1',
                channels: {
                    fetch: mock(async () => {
                        const map = new Map();
                        map.set('channel-1', {
                            id:   'channel-1',
                            name: 'general',
                            send: mock(_.noop),
                        });
                        return map;
                    }),
                },
            } as unknown as Guild;

            const mockGuild2 = {
                id:       'guild-2',
                channels: {
                    fetch: mock(async () => {
                        const map = new Map();
                        map.set('channel-2', {
                            id:   'channel-2',
                            name: 'announcements',
                            send: mock(_.noop),
                        });
                        return map;
                    }),
                },
            } as unknown as Guild;

            mockClient.guilds.cache.set('guild-1', mockGuild1);
            mockClient.guilds.cache.set('guild-2', mockGuild2);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(2);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(2);
        });

        it('should capture errors from guild discovery', async () => {
            mockGuild.channels.fetch = mock(async () => {
                throw new Error('Network error');
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.discovered).toBe(0);
            expect(result.updated).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toEqual({
                guildId: 'guild-123',
                error:   'Network error',
            });
        });

        it('should handle non-Error exceptions', async () => {
            mockGuild.channels.fetch = mock(async () => {
                throw 'String error';
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            const result = await discoverAllChannels(mockClient, mockManager);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toEqual({
                guildId: 'guild-123',
                error:   'String error',
            });
        });

        it('should create correct channel metadata', async () => {
            const mockChannel = {
                id:   'channel-1',
                name: 'general',
                send: mock(_.noop),
            } as unknown as GuildChannel;

            mockGuild.channels.fetch = mock(async () => {
                const map = new Map();
                map.set('channel-1', mockChannel);
                return map;
            }) as unknown as typeof mockGuild.channels.fetch;

            mockClient.guilds.cache.set('guild-123', mockGuild);

            await discoverAllChannels(mockClient, mockManager);

            expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);
            const call = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0];
            const metadata = call?.[0] as ChannelMetadata;

            expect(metadata.channelId).toBe(createChannelId('channel-1'));
            expect(metadata.guildId).toBe(createGuildId('guild-123'));
            expect(metadata.channelName).toBe('general');
            expect(metadata.isMuted).toBe(false);
            expect(metadata.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(metadata.lastSeenAt).toBe(metadata.discoveredAt);
            expect(metadata.updatedAt).toBe(metadata.discoveredAt);
        });
    });

    describe('setupChannelEventHandlers', () => {
        it('should register event handlers on client', () => {
            setupChannelEventHandlers(mockClient, mockManager);

            expect(mockClient.on).toHaveBeenCalledTimes(3);
            expect(mockClient.on).toHaveBeenCalledWith('channelCreate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('channelUpdate', expect.any(Function));
            expect(mockClient.on).toHaveBeenCalledWith('channelDelete', expect.any(Function));
        });

        describe('channelCreate handler', () => {
            it('should upsert new text channel', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelCreate'])?.[1];

                const mockChannel = {
                    id:    'channel-1',
                    name:  'new-channel',
                    guild: mockGuild,
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

                const metadata = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0]?.[0] as ChannelMetadata;
                expect(metadata.channelId).toBe(createChannelId('channel-1'));
                expect(metadata.channelName).toBe('new-channel');
            });

            it('should ignore channels without guild', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelCreate'])?.[1];

                const mockChannel = {
                    id:   'channel-1',
                    name: 'dm-channel',
                } as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.upsertChannel).not.toHaveBeenCalled();
            });

            it('should ignore channels with null guild', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelCreate'])?.[1];

                const mockChannel = {
                    id:    'channel-1',
                    name:  'dm-channel',
                    guild: null, // guild property exists but is null
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.upsertChannel).not.toHaveBeenCalled();
            });

            it('should ignore non-text channels', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelCreate'])?.[1];

                const mockChannel = {
                    id:    'category-1',
                    name:  'category',
                    guild: mockGuild,
                    type:  4,
                } as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.upsertChannel).not.toHaveBeenCalled();
            });
        });

        describe('channelUpdate handler', () => {
            it('should update existing channel name', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelUpdate'])?.[1];

                const oldChannel = {
                    id:    'channel-1',
                    name:  'old-name',
                    guild: mockGuild,
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                const newChannel = {
                    id:    'channel-1',
                    name:  'new-name',
                    guild: mockGuild,
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                const existingMetadata: ChannelMetadata = {
                    channelId:    createChannelId('channel-1'),
                    guildId:      createGuildId('guild-123'),
                    channelName:  'old-name',
                    isMuted:      false,
                    discoveredAt: '2025-01-01T00:00:00.000Z',
                    lastSeenAt:   '2025-01-01T00:00:00.000Z',
                    updatedAt:    '2025-01-01T00:00:00.000Z',
                };

                (mockManager.getChannel as ReturnType<typeof mock>).mockResolvedValue(existingMetadata);

                await handler(oldChannel, newChannel);

                expect(mockManager.upsertChannel).toHaveBeenCalledTimes(1);

                const metadata = (mockManager.upsertChannel as ReturnType<typeof mock>).mock.calls[0]?.[0] as ChannelMetadata;
                expect(metadata.channelName).toBe('new-name');
                expect(metadata.updatedAt).not.toBe(existingMetadata.updatedAt);
            });

            it('should ignore updates to non-existing channels', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelUpdate'])?.[1];

                const oldChannel = {
                    id:    'channel-1',
                    name:  'old-name',
                    guild: mockGuild,
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                const newChannel = {
                    id:    'channel-1',
                    name:  'new-name',
                    guild: mockGuild,
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                (mockManager.getChannel as Mock<() => Promise<ChannelMetadata | null>>).mockResolvedValue(null);

                await handler(oldChannel, newChannel);

                expect(mockManager.upsertChannel).not.toHaveBeenCalled();
            });

            it('should ignore channels without guild', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelUpdate'])?.[1];

                const oldChannel = {
                    id:   'channel-1',
                    name: 'old-name',
                } as unknown as GuildChannel;

                const newChannel = {
                    id:   'channel-1',
                    name: 'new-name',
                } as unknown as GuildChannel;

                await handler(oldChannel, newChannel);

                expect(mockManager.getChannel).not.toHaveBeenCalled();
            });

            it('should ignore channels with null guild', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelUpdate'])?.[1];

                const oldChannel = {
                    id:    'channel-1',
                    name:  'old-name',
                    guild: null, // guild property exists but is null
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                const newChannel = {
                    id:    'channel-1',
                    name:  'new-name',
                    guild: null, // guild property exists but is null
                    send:  mock(_.noop),
                } as unknown as GuildChannel;

                await handler(oldChannel, newChannel);

                expect(mockManager.getChannel).not.toHaveBeenCalled();
            });

            it('should ignore non-text channels', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelUpdate'])?.[1];

                const oldChannel = {
                    id:    'category-1',
                    name:  'old-category',
                    guild: mockGuild,
                    type:  4,
                } as unknown as GuildChannel;

                const newChannel = {
                    id:    'category-1',
                    name:  'new-category',
                    guild: mockGuild,
                    type:  4,
                } as unknown as GuildChannel;

                await handler(oldChannel, newChannel);

                expect(mockManager.getChannel).not.toHaveBeenCalled();
            });
        });

        describe('channelDelete handler', () => {
            it('should delete channel from registry', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelDelete'])?.[1];

                const mockChannel = {
                    id: 'channel-1',
                } as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.deleteChannel).toHaveBeenCalledTimes(1);
                expect(mockManager.deleteChannel).toHaveBeenCalledWith(createChannelId('channel-1'));
            });

            it('should ignore channels without id', async () => {
                setupChannelEventHandlers(mockClient, mockManager);

                const handler = _.find((mockClient.on as ReturnType<typeof mock>).mock.calls, ['0', 'channelDelete'])?.[1];

                const mockChannel = {} as unknown as GuildChannel;

                await handler(mockChannel);

                expect(mockManager.deleteChannel).not.toHaveBeenCalled();
            });
        });
    });
});
