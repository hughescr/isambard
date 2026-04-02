import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Client, Channel } from 'discord.js';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

describe('ChannelRegistryManager', () => {
    let backend: ChannelRegistryBackend;
    let client: Client;
    let manager: ChannelRegistryManager;
    const homeGuildId = createGuildId('home-guild');

    const createMockChannel = (overrides: Partial<ChannelMetadata> = {}): ChannelMetadata => ({
        channelId:    createChannelId('channel-1'),
        guildId:      homeGuildId,
        channelName:  'general',
        isMuted:      false,
        discoveredAt: '2024-01-01T00:00:00.000Z',
        lastSeenAt:   '2024-01-01T00:00:00.000Z',
        updatedAt:    '2024-01-01T00:00:00.000Z',
        ...overrides,
    });

    const createMockStorageRecord = (overrides: Partial<ChannelMetadata> = {}) => {
        const metadata = createMockChannel(overrides);
        return {
            channelId:   metadata.channelId,
            guildId:     metadata.guildId,
            isMuted:     metadata.isMuted,
            isWellKnown: metadata.isWellKnown,
            createdAt:   metadata.discoveredAt,
            updatedAt:   metadata.updatedAt,
        };
    };

    // Helper to set up Discord client mock for specific channels
    const mockDiscordChannels = (channels: ChannelMetadata[]) => {
        client.channels.fetch = mock((channelId: string): Promise<Channel | null> => {
            const channel = channels.find((ch: ChannelMetadata) => ch.channelId === channelId);
            if(channel) {
                return Promise.resolve({ id: channelId, name: channel.channelName } as unknown as Channel);
            }
            return Promise.resolve(null);
        }) as unknown as Client['channels']['fetch'];
    };

    beforeEach(() => {
        // Create mock backend
        backend = {
            getAllChannels:      mock(() => Promise.resolve([])),
            getChannel:          mock(() => Promise.resolve(null)),
            upsertChannel:       mock(() => Promise.resolve()),
            deleteChannel:       mock(() => Promise.resolve()),
            getChannelsByGuild:  mock(() => Promise.resolve([])),
            getWellKnownChannel: mock(() => Promise.resolve(null)),
            muteChannel:         mock(() => Promise.resolve()),
            unmuteChannel:       mock(() => Promise.resolve()),
            markAsWellKnown:     mock(() => Promise.resolve()),
            unmarkAsWellKnown:   mock(() => Promise.resolve()),
        } as unknown as ChannelRegistryBackend;

        // Create mock Discord client
        client = {
            channels: {
                cache: new Map(),
                fetch: mock((channelId: string) => {
                    // Default: return a mock channel with the ID as the name
                    return Promise.resolve({
                        id:   channelId,
                        name: `channel-${channelId}`,
                    } as unknown as Channel);
                }) as unknown as Client['channels']['fetch'],
            },
        } as unknown as Client;

        manager = new ChannelRegistryManager({
            backend,
            homeGuildId,
            client,
        });
    });

    describe('constructor', () => {
        it('should initialize with empty caches', () => {
            expect(manager).toBeDefined();
            expect(manager.homeGuild).toBe(homeGuildId);
        });
    });

    describe('warmCache', () => {
        it('should load all channels from backend into cache', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general' });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'random' });

            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: channel1.channelId }),
                createMockStorageRecord({ channelId: channel2.channelId }),
            ]));

            // Mock Discord client to return channel names
            mockDiscordChannels([channel1, channel2]);

            await manager.warmCache();

            // warmCache calls getChannelsByGuild twice: once for homeGuildId, once for DM channels
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(createGuildId('DM'));

            // Verify cache is populated by checking cache-first reads
            const cached1 = await manager.getChannel(channel1.channelId);
            const cached2 = await manager.getChannel(channel2.channelId);

            expect(cached1?.channelName).toBe('general');
            expect(cached2?.channelName).toBe('random');
            // Backend should not have been called again (cache hit)
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should build name index during cache warming', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general', guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general', guildId: createGuildId('other-guild') });

            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId }),
                createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId }),
            ]));

            // Mock Discord client to return channel names
            client.channels.fetch = mock((channelId: string): Promise<Channel | null> => {
                if(channelId === channel1.channelId || channelId === channel2.channelId) {
                    return Promise.resolve({ id: channelId, name: 'general' } as unknown as Channel);
                }
                return Promise.resolve(null);
            }) as unknown as typeof client.channels.fetch;

            await manager.warmCache();

            // warmCache queries both homeGuildId and DM
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(createGuildId('DM'));
        });

        it('should handle empty backend', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));

            await manager.warmCache();

            // warmCache queries both homeGuildId and DM
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(createGuildId('DM'));
        });

        it('should load DM channels into cache', async () => {
            const dmChannel = createMockChannel({
                channelId:   createChannelId('dm-123'),
                guildId:     'DM' as const,
                channelName: 'DM - testuser',
            });

            // Return DM channel only when queried for 'DM' guild
            backend.getChannelsByGuild = mock((guildId: string) => {
                if(guildId === 'DM') {
                    return Promise.resolve([createMockStorageRecord({ channelId: dmChannel.channelId, guildId: 'DM' as const })]);
                }
                return Promise.resolve([]);
            });

            // Mock Discord client to return DM channel
            client.channels.fetch = mock((channelId: string): Promise<Channel | null> => {
                if(channelId === dmChannel.channelId) {
                    return Promise.resolve({ id: channelId, name: 'DM - testuser' } as unknown as Channel);
                }
                return Promise.resolve(null);
            }) as unknown as typeof client.channels.fetch;

            await manager.warmCache();

            // DM channel should be in cache
            const cached = await manager.getChannel(dmChannel.channelId);
            expect(cached?.channelId).toBe(dmChannel.channelId);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should only mark cache as warmed after successful completion', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            const storageRecords = [
                createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown }),
                createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId, isMuted: channel2.isMuted, isWellKnown: channel2.isWellKnown }),
            ];
            backend.getChannelsByGuild = mock(() => Promise.resolve(storageRecords));

            // Before warmCache, getChannelsByGuild should fallback to backend
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // warmCache calls getChannelsByGuild twice (homeGuildId + DM)
            await manager.warmCache();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(3);

            // After warmCache completes, subsequent getChannelsByGuild calls use cache (no additional backend calls)
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(3);
        });
    });

    describe('invalidateCache', () => {
        it('should remove single channel from cache', async () => {
            const channel = createMockChannel();
            mockDiscordChannels([channel]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            // Verify channel is in cache
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.channelId).toBe(channel.channelId);
            expect(cached?.channelName).toBe(channel.channelName);
            expect(backend.getChannel).not.toHaveBeenCalled();

            // Invalidate cache
            manager.invalidateCache(channel.channelId);

            // Now should fallback to backend
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should remove channel from name index', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            mockDiscordChannels([channel]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            // Invalidate cache
            manager.invalidateCache(channel.channelId);

            // Verify channel is removed from cache
            const cachedChannel = await manager.getChannel(channel.channelId);
            expect(cachedChannel).toBeNull();
        });

        it('should handle invalidating non-DM channel (guildId check)', async () => {
            const guildChannel = createMockChannel({ guildId: homeGuildId, channelName: 'general' });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: guildChannel.channelId, guildId: guildChannel.guildId, isMuted: guildChannel.isMuted })]));
            await manager.warmCache();

            // Invalidate cache
            manager.invalidateCache(guildChannel.channelId);

            // Verify removed from cache
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: guildChannel.channelId, guildId: guildChannel.guildId, isMuted: guildChannel.isMuted })));
            await manager.getChannel(guildChannel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should remove well-known channel from well-known cache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            mockDiscordChannels([wellKnown]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: wellKnown.channelId, guildId: wellKnown.guildId, isMuted: wellKnown.isMuted, isWellKnown: wellKnown.isWellKnown })]));
            await manager.warmCache();

            // Verify well-known is cached
            const result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(wellKnown.channelId);
            expect(result?.isWellKnown).toBe('general');

            // Invalidate cache
            manager.invalidateCache(wellKnown.channelId);

            // Well-known should fallback to backend
            backend.getWellKnownChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: wellKnown.channelId, guildId: wellKnown.guildId, isMuted: wellKnown.isMuted, isWellKnown: wellKnown.isWellKnown })));
            await manager.getWellKnownChannel('general');
            expect(backend.getWellKnownChannel).toHaveBeenCalledTimes(1);
        });

        it('should handle invalidating channel not in cache (early return)', () => {
            const nonExistentId = createChannelId('nonexistent');

            // Should not throw
            expect(() => manager.invalidateCache(nonExistentId)).not.toThrow();
        });
    });

    describe('clearCache', () => {
        it('should clear entire cache', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1') });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2') });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown }), createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId, isMuted: channel2.isMuted, isWellKnown: channel2.isWellKnown })]));
            await manager.warmCache();

            manager.clearCache();

            // All reads should fallback to backend
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown })));
            await manager.getChannel(channel1.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should mark cache as not warmed', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            const storageRecord = createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown });
            backend.getChannelsByGuild = mock(() => Promise.resolve([storageRecord]));
            await manager.warmCache();
            // warmCache calls getChannelsByGuild twice (homeGuildId + DM)
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);

            // Verify cache is warmed (uses cache for guild query, no additional backend calls)
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);

            // Clear cache
            manager.clearCache();

            // Now should fallback to backend (cache not warmed)
            backend.getChannelsByGuild = mock(() => Promise.resolve([storageRecord]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('getChannel', () => {
        it('should return from cache if available', async () => {
            const channel = createMockChannel();
            mockDiscordChannels([channel]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            const result = await manager.getChannel(channel.channelId);

            expect(result?.channelId).toBe(channel.channelId);
            expect(result?.channelName).toBe(channel.channelName);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should fallback to backend if not in cache', async () => {
            const channel = createMockChannel();
            mockDiscordChannels([channel]);
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));

            const result = await manager.getChannel(channel.channelId);

            expect(result?.channelId).toBe(channel.channelId);
            expect(result?.channelName).toBe(channel.channelName);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
            expect(backend.getChannel).toHaveBeenCalledWith(channel.channelId);
        });

        it('should cache backend result for future reads', async () => {
            const channel = createMockChannel();
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));

            // First read - cache miss
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);

            // Second read - cache hit
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1); // Still only called once
        });

        it('should return null if channel not found', async () => {
            backend.getChannel = mock(() => Promise.resolve(null));

            const result = await manager.getChannel(createChannelId('nonexistent'));

            expect(result).toBeNull();
        });

        it('should use @Unknown name for DM channel with non-object Discord channel (type guard — non-object)', async () => {
            // Mock Discord fetch to return a primitive string — exercises isDMChannelWithRecipient
            // and hasChannelName type guards with a non-object value
            const dmChannelId = createChannelId('dm-999');
            backend.getChannel = mock(() => Promise.resolve({
                channelId:   dmChannelId,
                guildId:     'DM' as const,
                isMuted:     false,
                isWellKnown: undefined,
                createdAt:   '2024-01-01T00:00:00.000Z',
                updatedAt:   '2024-01-01T00:00:00.000Z',
            }));
            // Return a truthy non-object (string) from Discord fetch — type guards must not throw
            // client.channels.cache is already an empty Map from beforeEach, so fetch will be called
            client.channels.fetch = mock((): Promise<Channel | null> => Promise.resolve('truthy-non-object' as unknown as Channel));

            const result = await manager.getChannel(dmChannelId);

            // isDMChannelWithRecipient('truthy-non-object') → false (not an object)
            // hasChannelName('truthy-non-object') → false (not an object)
            // Falls through to default '@Unknown'
            expect(result?.channelName).toBe('@Unknown');
        });
    });

    describe('upsertChannel', () => {
        it('should update both cache and backend', async () => {
            const channel = createMockChannel();

            await manager.upsertChannel(channel);

            expect(backend.upsertChannel).toHaveBeenCalledTimes(1);
            // Manager converts ChannelMetadata to ChannelStorageRecord for backend
            expect(backend.upsertChannel).toHaveBeenCalledWith({
                channelId:   channel.channelId,
                guildId:     channel.guildId,
                isMuted:     channel.isMuted,
                isWellKnown: channel.isWellKnown,
                createdAt:   channel.discoveredAt,
                updatedAt:   channel.updatedAt,
            });

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.channelId).toBe(channel.channelId);
            expect(cached?.channelName).toBe(channel.channelName);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should update name index on upsert', async () => {
            const channel = createMockChannel({ channelName: 'general' });

            await manager.upsertChannel(channel);

            // Warm cache
            await manager.warmCache();

            // Verify channel is in cache
            const cachedChannel = await manager.getChannel(channel.channelId);
            expect(cachedChannel).not.toBeNull();
            expect(cachedChannel?.channelId).toBe(channel.channelId);
        });

        it('should handle channel name change in cache', async () => {
            const channel = createMockChannel({ channelName: 'old-name' });
            await manager.upsertChannel(channel);

            // Warm cache
            await manager.warmCache();

            // Update channel with new name
            const updated = { ...channel, channelName: 'new-name' };
            await manager.upsertChannel(updated);

            // Verify channel has new name in cache
            const cachedChannel = await manager.getChannel(channel.channelId);
            expect(cachedChannel?.channelName).toBe('new-name');
        });

        it('should remove old well-known status when updating channel', async () => {
            const channel = createMockChannel({ isWellKnown: 'general' });
            await manager.upsertChannel(channel);

            // Verify well-known is cached
            let result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(channel.channelId);

            // Update to different well-known type
            const updated = { ...channel, isWellKnown: 'catch-up' as const };
            await manager.upsertChannel(updated);

            // Old well-known should not resolve (fallback to backend which returns null)
            backend.getWellKnownChannel = mock(() => Promise.resolve(null));
            result = await manager.getWellKnownChannel('general');
            expect(result).toBeNull();

            // New well-known should resolve
            result = await manager.getWellKnownChannel('catch-up');
            expect(result?.channelId).toBe(channel.channelId);
        });

        it('should NOT mark cache as warmed after upsert (only warmCache() sets this)', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });

            // Upsert without warming cache first
            await manager.upsertChannel(channel);

            // Should fallback to backend (cache not warmed, even though channel is cached)
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            const results = await manager.getChannelsByGuild(homeGuildId);
            expect(results).toHaveLength(1);
            // Since cache is not marked as warmed, it should have called the backend
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('deleteChannel', () => {
        it('should remove from cache and backend', async () => {
            const channel = createMockChannel();
            await manager.upsertChannel(channel);

            await manager.deleteChannel(channel.channelId);

            expect(backend.deleteChannel).toHaveBeenCalledTimes(1);
            expect(backend.deleteChannel).toHaveBeenCalledWith(channel.channelId);

            // Verify removed from cache
            backend.getChannel = mock(() => Promise.resolve(null));
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalled(); // Cache miss
        });

        it('should remove from name index', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            await manager.upsertChannel(channel);

            // Warm cache
            await manager.warmCache();

            await manager.deleteChannel(channel.channelId);

            // Verify channel is removed from cache
            const cachedChannel = await manager.getChannel(channel.channelId);
            expect(cachedChannel).toBeNull();
        });
    });

    describe('getChannelsByGuild', () => {
        it('should return channels from cache if available', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });
            const channel3 = createMockChannel({ channelId: createChannelId('channel-3'), guildId: createGuildId('other-guild') });

            mockDiscordChannels([channel1, channel2, channel3]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown }), createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId, isMuted: channel2.isMuted, isWellKnown: channel2.isWellKnown }), createMockStorageRecord({ channelId: channel3.channelId, guildId: channel3.guildId, isMuted: channel3.isMuted, isWellKnown: channel3.isWellKnown })]));
            await manager.warmCache();
            // warmCache calls getChannelsByGuild twice (homeGuildId + DM)
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(2);
            expect(results.map(r => r.channelId)).toContain(channel1.channelId);
            expect(results.map(r => r.channelId)).toContain(channel2.channelId);
            // Cache should be used - no additional backend calls
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2);
        });

        it('should fallback to backend if cache is cold', async () => {
            const channel1 = createMockChannel({ guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown }), createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId, isMuted: channel2.isMuted, isWellKnown: channel2.isWellKnown })]));

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(2);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
        });

        it('should cache results from backend fallback', async () => {
            const channel1 = createMockChannel({ guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            mockDiscordChannels([channel1, channel2]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel1.channelId, guildId: channel1.guildId, isMuted: channel1.isMuted, isWellKnown: channel1.isWellKnown }), createMockStorageRecord({ channelId: channel2.channelId, guildId: channel2.guildId, isMuted: channel2.isMuted, isWellKnown: channel2.isWellKnown })]));

            // First call - cache miss
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Channels should now be cached
            const cached1 = await manager.getChannel(channel1.channelId);
            expect(cached1?.channelId).toBe(channel1.channelId);
            expect(cached1?.channelName).toBe(channel1.channelName);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should return empty array for unknown guild', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));
            await manager.warmCache();

            const results = await manager.getChannelsByGuild(createGuildId('unknown-guild'));

            expect(results).toHaveLength(0);
        });
    });

    describe('getUnmutedChannels', () => {
        it('should return only unmuted channels from cache', async () => {
            const unmuted1 = createMockChannel({ channelId: createChannelId('unmuted-1'), isMuted: false });
            const muted = createMockChannel({ channelId: createChannelId('muted'), isMuted: true });
            const unmuted2 = createMockChannel({ channelId: createChannelId('unmuted-2'), isMuted: false });

            mockDiscordChannels([unmuted1, muted, unmuted2]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: unmuted1.channelId, guildId: unmuted1.guildId, isMuted: unmuted1.isMuted, isWellKnown: unmuted1.isWellKnown }), createMockStorageRecord({ channelId: muted.channelId, guildId: muted.guildId, isMuted: muted.isMuted, isWellKnown: muted.isWellKnown }), createMockStorageRecord({ channelId: unmuted2.channelId, guildId: unmuted2.guildId, isMuted: unmuted2.isMuted, isWellKnown: unmuted2.isWellKnown })]));
            await manager.warmCache();

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(2);
            expect(results.map(r => r.channelId)).toContain(unmuted1.channelId);
            expect(results.map(r => r.channelId)).toContain(unmuted2.channelId);
            expect(results.map(r => r.channelId)).not.toContain(muted.channelId);
        });

        it('should fallback to backend if cache is cold', async () => {
            const unmuted = createMockChannel({ isMuted: false });

            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: unmuted.channelId, guildId: unmuted.guildId, isMuted: unmuted.isMuted, isWellKnown: unmuted.isWellKnown })]));

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
        });

        it('should cache results from backend fallback', async () => {
            const unmuted = createMockChannel({ isMuted: false });
            const muted = createMockChannel({ channelId: createChannelId('muted'), isMuted: true });

            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: unmuted.channelId, guildId: unmuted.guildId, isMuted: unmuted.isMuted }),
                createMockStorageRecord({ channelId: muted.channelId, guildId: muted.guildId, isMuted: muted.isMuted }),
            ]));

            // First call - cache miss
            await manager.getUnmutedChannels();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);

            // Both channels should now be cached
            const cachedUnmuted = await manager.getChannel(unmuted.channelId);
            const cachedMuted = await manager.getChannel(muted.channelId);
            expect(cachedUnmuted?.channelId).toBe(unmuted.channelId);
            expect(cachedUnmuted?.isMuted).toBe(false);
            expect(cachedMuted?.channelId).toBe(muted.channelId);
            expect(cachedMuted?.isMuted).toBe(true);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should return empty array if all channels are muted', async () => {
            const muted1 = createMockChannel({ channelId: createChannelId('muted-1'), isMuted: true });
            const muted2 = createMockChannel({ channelId: createChannelId('muted-2'), isMuted: true });

            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: muted1.channelId, guildId: muted1.guildId, isMuted: muted1.isMuted }),
                createMockStorageRecord({ channelId: muted2.channelId, guildId: muted2.guildId, isMuted: muted2.isMuted }),
            ]));
            await manager.warmCache();

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(0);
        });
    });

    describe('getWellKnownChannel', () => {
        it('should return from cache if available', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });

            mockDiscordChannels([wellKnown]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: wellKnown.channelId, guildId: wellKnown.guildId, isMuted: wellKnown.isMuted, isWellKnown: wellKnown.isWellKnown }),
            ]));
            await manager.warmCache();

            const result = await manager.getWellKnownChannel('general');

            expect(result?.channelId).toBe(wellKnown.channelId);
            expect(result?.channelName).toBe(wellKnown.channelName);
            expect(result?.isWellKnown).toBe('general');
            expect(backend.getWellKnownChannel).not.toHaveBeenCalled();
        });

        it('should fallback to backend if not in cache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            mockDiscordChannels([wellKnown]);
            backend.getWellKnownChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: wellKnown.channelId, guildId: wellKnown.guildId, isMuted: wellKnown.isMuted, isWellKnown: wellKnown.isWellKnown })));

            const result = await manager.getWellKnownChannel('general');

            expect(result?.channelId).toBe(wellKnown.channelId);
            expect(result?.channelName).toBe(wellKnown.channelName);
            expect(result?.isWellKnown).toBe('general');
            expect(backend.getWellKnownChannel).toHaveBeenCalledTimes(1);
            expect(backend.getWellKnownChannel).toHaveBeenCalledWith('general');
        });

        it('should cache backend result', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getWellKnownChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: wellKnown.channelId, guildId: wellKnown.guildId, isMuted: wellKnown.isMuted, isWellKnown: wellKnown.isWellKnown })));

            await manager.getWellKnownChannel('general');
            await manager.getWellKnownChannel('general');

            expect(backend.getWellKnownChannel).toHaveBeenCalledTimes(1);
        });

        it('should return null if not found', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));
            await manager.warmCache();

            const result = await manager.getWellKnownChannel('general');

            expect(result).toBeNull();
        });
    });

    describe('getAllChannels', () => {
        it('should return all channels from cache', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general' });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'random' });

            backend.getChannelsByGuild = mock(() => Promise.resolve([
                createMockStorageRecord({ channelId: channel1.channelId }),
                createMockStorageRecord({ channelId: channel2.channelId }),
            ]));
            mockDiscordChannels([channel1, channel2]);

            await manager.warmCache();

            const result = manager.getAllChannels();

            expect(result).toHaveLength(2);
            const channelIds = result.map(r => r.channelId);
            expect(channelIds).toContain(channel1.channelId);
            expect(channelIds).toContain(channel2.channelId);
        });

        it('should return empty array when cache is empty', () => {
            const result = manager.getAllChannels();

            expect(result).toEqual([]);
        });
    });

    describe('shouldProcess', () => {
        it('should always process DM channels', () => {
            const result = manager.shouldProcess(
                createChannelId('dm-channel'),
                true,  // isDM
                false, // isMention
                false  // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should always process mentions', () => {
            const result = manager.shouldProcess(
                createChannelId('channel'),
                false, // isDM
                true,  // isMention
                false  // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should always process replies to bot', () => {
            const result = manager.shouldProcess(
                createChannelId('channel'),
                false, // isDM
                false, // isMention
                true   // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should process unknown channels (not in cache)', () => {
            const result = manager.shouldProcess(
                createChannelId('unknown-channel'),
                false, // isDM
                false, // isMention
                false  // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should process unmuted channels from cache', async () => {
            const channel = createMockChannel({ isMuted: false });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            const result = manager.shouldProcess(
                channel.channelId,
                false, // isDM
                false, // isMention
                false  // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should NOT process muted channels (without overrides)', async () => {
            const channel = createMockChannel({ isMuted: true });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            const result = manager.shouldProcess(
                channel.channelId,
                false, // isDM
                false, // isMention
                false  // isReplyToBot
            );

            expect(result).toBe(false);
        });

        it('should process muted channels with mention override', async () => {
            const channel = createMockChannel({ isMuted: true });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            const result = manager.shouldProcess(
                channel.channelId,
                false, // isDM
                true,  // isMention - OVERRIDE
                false  // isReplyToBot
            );

            expect(result).toBe(true);
        });

        it('should process muted channels with reply override', async () => {
            const channel = createMockChannel({ isMuted: true });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })]));
            await manager.warmCache();

            const result = manager.shouldProcess(
                channel.channelId,
                false, // isDM
                false, // isMention
                true   // isReplyToBot - OVERRIDE
            );

            expect(result).toBe(true);
        });
    });

    describe('muteChannel', () => {
        it('should update cache and backend', async () => {
            const channel = createMockChannel({ isMuted: false });
            await manager.upsertChannel(channel);

            await manager.muteChannel(channel.channelId);

            expect(backend.muteChannel).toHaveBeenCalledTimes(1);
            expect(backend.muteChannel).toHaveBeenCalledWith(channel.channelId);

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isMuted).toBe(true);
        });

        it('should affect shouldProcess', async () => {
            const channel = createMockChannel({ isMuted: false });
            await manager.upsertChannel(channel);

            // Should process before muting
            let result = manager.shouldProcess(channel.channelId, false, false, false);
            expect(result).toBe(true);

            // Mute channel
            await manager.muteChannel(channel.channelId);

            // Should NOT process after muting
            result = manager.shouldProcess(channel.channelId, false, false, false);
            expect(result).toBe(false);
        });

        it('should invalidate cache when backend fails', async () => {
            const channel = createMockChannel({ isMuted: false });
            await manager.upsertChannel(channel);

            // Verify channel is in cache
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isMuted).toBe(false);

            // Make backend fail
            const error = new Error('Backend failure');
            backend.muteChannel = mock(() => Promise.reject(error));

            // Attempt to mute should fail and invalidate cache
            expect(manager.muteChannel(channel.channelId)).rejects.toThrow('Backend failure');

            // Verify cache was invalidated by checking for backend fallback
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should re-throw error after cache invalidation', async () => {
            const channel = createMockChannel({ isMuted: false });
            await manager.upsertChannel(channel);

            // Make backend fail
            const error = new Error('DynamoDB timeout');
            backend.muteChannel = mock(() => Promise.reject(error));

            // Error should be re-thrown
            expect(manager.muteChannel(channel.channelId)).rejects.toThrow('DynamoDB timeout');
        });

        it('should ensure next getChannel() fetches fresh data after error', async () => {
            const channel = createMockChannel({ isMuted: false });
            await manager.upsertChannel(channel);

            // Make backend fail for mute
            backend.muteChannel = mock(() => Promise.reject(new Error('Timeout')));

            // Attempt to mute fails
            expect(manager.muteChannel(channel.channelId)).rejects.toThrow('Timeout');

            // Next getChannel should fetch from backend (cache invalidated)
            const freshChannelRecord = createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: false }); // Still unmuted in DynamoDB
            backend.getChannel = mock(() => Promise.resolve(freshChannelRecord));
            const result = await manager.getChannel(channel.channelId);

            expect(result?.isMuted).toBe(false); // Fresh data from DynamoDB
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });
    });

    describe('unmuteChannel', () => {
        it('should update cache and backend', async () => {
            const channel = createMockChannel({ isMuted: true });
            await manager.upsertChannel(channel);

            await manager.unmuteChannel(channel.channelId);

            expect(backend.unmuteChannel).toHaveBeenCalledTimes(1);
            expect(backend.unmuteChannel).toHaveBeenCalledWith(channel.channelId);

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isMuted).toBe(false);
        });

        it('should affect shouldProcess', async () => {
            const channel = createMockChannel({ isMuted: true });
            await manager.upsertChannel(channel);

            // Should NOT process before unmuting
            let result = manager.shouldProcess(channel.channelId, false, false, false);
            expect(result).toBe(false);

            // Unmute channel
            await manager.unmuteChannel(channel.channelId);

            // Should process after unmuting
            result = manager.shouldProcess(channel.channelId, false, false, false);
            expect(result).toBe(true);
        });

        it('should invalidate cache when backend fails', async () => {
            const channel = createMockChannel({ isMuted: true });
            await manager.upsertChannel(channel);

            // Verify channel is in cache
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isMuted).toBe(true);

            // Make backend fail
            const error = new Error('Backend failure');
            backend.unmuteChannel = mock(() => Promise.reject(error));

            // Attempt to unmute should fail and invalidate cache
            expect(manager.unmuteChannel(channel.channelId)).rejects.toThrow('Backend failure');

            // Verify cache was invalidated by checking for backend fallback
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should re-throw error after cache invalidation', async () => {
            const channel = createMockChannel({ isMuted: true });
            await manager.upsertChannel(channel);

            // Make backend fail
            const error = new Error('DynamoDB timeout');
            backend.unmuteChannel = mock(() => Promise.reject(error));

            // Error should be re-thrown
            expect(manager.unmuteChannel(channel.channelId)).rejects.toThrow('DynamoDB timeout');
        });

        it('should ensure next getChannel() fetches fresh data after error', async () => {
            const channel = createMockChannel({ isMuted: true });
            await manager.upsertChannel(channel);

            // Make backend fail for unmute
            backend.unmuteChannel = mock(() => Promise.reject(new Error('Timeout')));

            // Attempt to unmute fails
            expect(manager.unmuteChannel(channel.channelId)).rejects.toThrow('Timeout');

            // Next getChannel should fetch from backend (cache invalidated)
            const freshChannelRecord = createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: true }); // Still muted in DynamoDB
            backend.getChannel = mock(() => Promise.resolve(freshChannelRecord));
            const result = await manager.getChannel(channel.channelId);

            expect(result?.isMuted).toBe(true); // Fresh data from DynamoDB
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });
    });

    describe('markAsWellKnown', () => {
        it('should update cache and backend', async () => {
            const channel = createMockChannel();
            await manager.upsertChannel(channel);

            await manager.markAsWellKnown(channel.channelId, 'general');

            expect(backend.markAsWellKnown).toHaveBeenCalledTimes(1);
            expect(backend.markAsWellKnown).toHaveBeenCalledWith(channel.channelId, 'general');

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isWellKnown).toBe('general');
        });

        it('should make channel findable by well-known type', async () => {
            const channel = createMockChannel();
            await manager.upsertChannel(channel);

            await manager.markAsWellKnown(channel.channelId, 'general');

            const result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(channel.channelId);
        });
    });

    describe('unmarkAsWellKnown', () => {
        it('should successfully unmark a well-known channel', async () => {
            const channel = createMockChannel({ isWellKnown: 'general' });
            await manager.upsertChannel(channel);

            // Mock the backend method
            backend.unmarkAsWellKnown = mock(() => Promise.resolve());

            await manager.unmarkAsWellKnown(channel.channelId);

            expect(backend.unmarkAsWellKnown).toHaveBeenCalledTimes(1);
            expect(backend.unmarkAsWellKnown).toHaveBeenCalledWith(channel.channelId);

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isWellKnown).toBeUndefined();
        });

        it('should clear well-known cache when unmarking', async () => {
            const channel = createMockChannel({ isWellKnown: 'general' });
            await manager.upsertChannel(channel);

            // Mock the backend method
            backend.unmarkAsWellKnown = mock(() => Promise.resolve());

            await manager.unmarkAsWellKnown(channel.channelId);

            // Well-known lookup should now return null
            backend.getWellKnownChannel = mock(() => Promise.resolve(null));
            const result = await manager.getWellKnownChannel('general');
            expect(result).toBeNull();
        });

        it('should handle channel not in cache', async () => {
            const channelId = createChannelId('not-cached');

            // Mock the backend method
            backend.unmarkAsWellKnown = mock(() => Promise.resolve());

            // Should not throw even if channel is not in cache
            await manager.unmarkAsWellKnown(channelId);

            expect(backend.unmarkAsWellKnown).toHaveBeenCalledTimes(1);
            expect(backend.unmarkAsWellKnown).toHaveBeenCalledWith(channelId);
        });

        it('should handle channel that was not well-known', async () => {
            const channel = createMockChannel({ isWellKnown: undefined });
            await manager.upsertChannel(channel);

            // Mock the backend method
            backend.unmarkAsWellKnown = mock(() => Promise.resolve());

            // Should succeed without error
            await manager.unmarkAsWellKnown(channel.channelId);

            expect(backend.unmarkAsWellKnown).toHaveBeenCalledTimes(1);

            // Verify cache still updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isWellKnown).toBeUndefined();
        });

        it('should invalidate cache when backend fails', async () => {
            const channel = createMockChannel({ isWellKnown: 'general' });
            await manager.upsertChannel(channel);

            // Verify channel is in cache
            const cached = await manager.getChannel(channel.channelId);
            expect(cached?.isWellKnown).toBe('general');

            // Make backend fail
            const error = new Error('Backend failure');
            backend.unmarkAsWellKnown = mock(() => Promise.reject(error));

            // Attempt to unmark should fail and invalidate cache
            expect(manager.unmarkAsWellKnown(channel.channelId)).rejects.toThrow('Backend failure');

            // Verify cache was invalidated by checking for backend fallback
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({ channelId: channel.channelId, guildId: channel.guildId, isMuted: channel.isMuted, isWellKnown: channel.isWellKnown })));
            await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should re-throw error after cache invalidation', async () => {
            const channel = createMockChannel({ isWellKnown: 'general' });
            await manager.upsertChannel(channel);

            // Make backend fail
            const error = new Error('DynamoDB timeout');
            backend.unmarkAsWellKnown = mock(() => Promise.reject(error));

            // Error should be re-thrown
            expect(manager.unmarkAsWellKnown(channel.channelId)).rejects.toThrow('DynamoDB timeout');
        });
    });

    describe('homeGuild getter', () => {
        it('should return home guild ID', () => {
            expect(manager.homeGuild).toBe(homeGuildId);
        });
    });

    describe('buildChannelMetadata fallback', () => {
        it('should use "Unknown" fallback when Discord channel has no name property', async () => {
            const channel = createMockChannel();

            // Mock backend to return a stored record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: channel.channelId,
                guildId:   channel.guildId,
                isMuted:   channel.isMuted
            })));

            // Mock Discord client to return a channel WITHOUT a name property (e.g., DMChannel)
            client.channels.fetch = mock(() => Promise.resolve({
                id: channel.channelId,
                // No 'name' property at all
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            // Fetch channel - should trigger buildChannelMetadata with no-name channel
            const result = await manager.getChannel(channel.channelId);

            // Should fall back to 'Unknown'
            expect(result?.channelName).toBe('Unknown');
        });

        it('should use "Unknown" fallback when Discord channel name is null', async () => {
            const channel = createMockChannel();

            // Mock backend to return a stored record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: channel.channelId,
                guildId:   channel.guildId,
                isMuted:   channel.isMuted
            })));

            // Mock Discord client to return a channel with null name
            client.channels.fetch = mock(() => Promise.resolve({
                id:   channel.channelId,
                name: null, // Explicitly null
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            // Fetch channel - should trigger buildChannelMetadata with null name
            const result = await manager.getChannel(channel.channelId);

            // Should fall back to 'Unknown'
            expect(result?.channelName).toBe('Unknown');
        });
    });

    describe('DM channel name formatting', () => {
        it('should format DM channel name using recipient username', async () => {
            const dmChannelId = createChannelId('dm-channel-1');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with recipient
            client.channels.fetch = mock(() => Promise.resolve({
                id:        dmChannelId,
                recipient: { username: 'testuser' },
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should format as @username
            expect(result?.channelName).toBe('@testuser');
        });

        it('should convert "DM - username" format to @username', async () => {
            const dmChannelId = createChannelId('dm-channel-2');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with old format name
            client.channels.fetch = mock(() => Promise.resolve({
                id:   dmChannelId,
                name: 'DM - olduser',
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should convert to @username format
            expect(result?.channelName).toBe('@olduser');
        });

        it('should preserve @username format if already present', async () => {
            const dmChannelId = createChannelId('dm-channel-3');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with @username format
            client.channels.fetch = mock(() => Promise.resolve({
                id:   dmChannelId,
                name: '@existinguser',
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should preserve @username format
            expect(result?.channelName).toBe('@existinguser');
        });

        it('should add @ prefix to plain name in DM channel', async () => {
            const dmChannelId = createChannelId('dm-channel-4');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with plain name
            client.channels.fetch = mock(() => Promise.resolve({
                id:   dmChannelId,
                name: 'plainuser',
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should add @ prefix
            expect(result?.channelName).toBe('@plainuser');
        });

        it('should fallback to @Unknown when DM channel has no recipient or name', async () => {
            const dmChannelId = createChannelId('dm-channel-5');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with no recipient or name
            client.channels.fetch = mock(() => Promise.resolve({
                id: dmChannelId,
                // No recipient or name
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should fall back to @Unknown
            expect(result?.channelName).toBe('@Unknown');
        });

        it('should use recipient over name when both are present', async () => {
            const dmChannelId = createChannelId('dm-channel-6');

            // Mock backend to return a DM channel record
            backend.getChannel = mock(() => Promise.resolve(createMockStorageRecord({
                channelId: dmChannelId,
                guildId:   'DM' as const,
                isMuted:   false
            })));

            // Mock Discord client to return a DM channel with both recipient and name
            client.channels.fetch = mock(() => Promise.resolve({
                id:        dmChannelId,
                recipient: { username: 'recipient-user' },
                name:      'DM - old-user',
            } as unknown as Channel)) as unknown as typeof client.channels.fetch;

            const result = await manager.getChannel(dmChannelId);

            // Should prefer recipient username
            expect(result?.channelName).toBe('@recipient-user');
        });
    });
});
