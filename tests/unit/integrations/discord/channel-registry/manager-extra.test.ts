/* eslint-disable @typescript-eslint/unbound-method -- Test mocks use expect().toHaveBeenCalled() on mock methods */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import type { Client } from 'discord.js';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '@/integrations/discord/types';

describe('ChannelRegistryManager - Additional Mutation Tests', () => {
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
        client.channels.fetch = mock((channelId: string) => {
            // eslint-disable-next-line lodash/matches-prop-shorthand -- Branded types require explicit comparison
            const channel = _.find(channels, (ch: ChannelMetadata) => ch.channelId === channelId);
            if(channel) {
                return Promise.resolve({ id: channelId, name: channel.channelName } as unknown as import('discord.js').Channel);
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
                    } as unknown as import('discord.js').Channel);
                }) as unknown as Client['channels']['fetch'],
            },
        } as unknown as Client;

        manager = new ChannelRegistryManager({
            backend:     backend,
            homeGuildId: homeGuildId,
            client:      client,
        });
    });

    describe('well-known channel tracking', () => {
        it('should track well-known channels during warmCache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord({ isWellKnown: 'general' })]));

            await manager.warmCache();

            // Should be findable by well-known type
            const result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(wellKnown.channelId);
            expect(backend.getWellKnownChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should track well-known channels during upsert', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'catch-up' });
            await manager.upsertChannel(wellKnown);

            // Should be findable by well-known type
            const result = await manager.getWellKnownChannel('catch-up');
            expect(result?.channelId).toBe(wellKnown.channelId);
            expect(backend.getWellKnownChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should handle non-well-known channels', async () => {
            const regular = createMockChannel({ isWellKnown: undefined });
            await manager.upsertChannel(regular);

            // Should not crash, just not be in well-known cache
            backend.getWellKnownChannel = mock(() => Promise.resolve(null));
            const result = await manager.getWellKnownChannel('general');
            expect(result).toBeNull();
        });

        it('should not remove well-known status for non-well-known channels during invalidation', async () => {
            const regular = createMockChannel({ channelId: createChannelId('regular'), isWellKnown: undefined });
            const wellKnown = createMockChannel({ channelId: createChannelId('well-known'), isWellKnown: 'general' });

            await manager.upsertChannel(regular);
            await manager.upsertChannel(wellKnown);

            // Verify well-known is tracked
            let result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(wellKnown.channelId);

            // Invalidate regular channel (should not affect well-known cache)
            manager.invalidateCache(regular.channelId);

            // Well-known should still be findable
            result = await manager.getWellKnownChannel('general');
            expect(result?.channelId).toBe(wellKnown.channelId);
        });
    });

    describe('cache state transitions', () => {
        it('should transition from cold to warmed cache', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });

            // Cache is cold - should use backend
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel)]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Warm the cache - warmCache now also uses getChannelsByGuild
            await manager.warmCache();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2); // warmCache also calls it

            // Now should use cache
            await manager.getChannelsByGuild(homeGuildId);
            // Backend should NOT be called again
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(2); // Still only 2 calls
        });

        it('should transition from warmed to cold cache', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel)]));
            await manager.warmCache();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Cache is warmed - uses cache for getChannelsByGuild
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1); // Still only 1 from warmCache

            // Clear cache
            manager.clearCache();

            // Now should use backend
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel)]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('empty loop cases', () => {
        it('should handle empty warmCache', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));

            await manager.warmCache();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Cache should be warmed even with no channels
            const results = await manager.getChannelsByGuild(homeGuildId);
            expect(results).toHaveLength(0);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1); // Still only 1 from warmCache
        });

        it('should handle empty backend result in getChannelsByGuild', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(0);
        });

        it('should handle empty backend result in getUnmutedChannels', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(0);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
        });

        it('should verify empty for loops do work when not empty', async () => {
            // Verify getChannelsByGuild backend fallback loop actually adds to cache
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), guildId: homeGuildId });

            mockDiscordChannels([channel1, channel2]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel1), createMockStorageRecord(channel2)]));

            await manager.getChannelsByGuild(homeGuildId);

            // Verify channels were cached by checking cache hit
            const cached1 = await manager.getChannel(channel1.channelId);
            expect(cached1?.channelId).toBe(channel1.channelId);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should verify getUnmutedChannels backend fallback loop works', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), isMuted: false });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), isMuted: true });

            mockDiscordChannels([channel1, channel2]);
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel1), createMockStorageRecord(channel2)]));

            const results = await manager.getUnmutedChannels();

            // Verify both were cached
            const cached1 = await manager.getChannel(channel1.channelId);
            const cached2 = await manager.getChannel(channel2.channelId);
            expect(cached1?.channelId).toBe(channel1.channelId);
            expect(cached2?.channelId).toBe(channel2.channelId);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hits

            // Verify correct filtering
            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel1.channelId);
            expect(results[0].isMuted).toBe(false);
        });
    });

    describe('conditional expression mutations', () => {
        it('should test clearCache sets cacheWarmed to exactly false', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel)]));
            await manager.warmCache();
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Cache is warmed - getChannelsByGuild uses cache
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1); // Still 1, used cache

            manager.clearCache();

            // If cacheWarmed was set to true instead of false, this would fail
            backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(channel)]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalled();
        });
    });

    describe('mutation-killing tests for surviving mutants', () => {
        describe('internal state mutation killing tests', () => {
            it('removes wellKnownCache entry on invalidate', async () => {
                const wk = createMockChannel({ isWellKnown: 'general' });
                await manager.upsertChannel(wk);

                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- access internal cache for mutation testing
                const cache = (manager as any).wellKnownCache as Map<string, string>;
                expect(cache.has('general')).toBe(true);

                manager.invalidateCache(wk.channelId);

                expect(cache.has('general')).toBe(false);
            });
        });

        describe('Line 196: getUnmutedChannels cache-warmed block', () => {
            it('should use cache when warmed and NOT call backend', async () => {
                const unmuted1 = createMockChannel({ channelId: createChannelId('unmuted-1'), isMuted: false });
                const muted = createMockChannel({ channelId: createChannelId('muted'), isMuted: true });

                mockDiscordChannels([unmuted1, muted]);
                backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(unmuted1), createMockStorageRecord(muted)]));
                await manager.warmCache();
                expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

                // Reset the mock to verify backend is NOT called again
                backend.getChannelsByGuild = mock(() => Promise.resolve([createMockStorageRecord(unmuted1), createMockStorageRecord(muted)]));

                // Kills mutant: if(this.cacheWarmed) BlockStatement -> {}
                // If block was empty, backend would be called
                const results = await manager.getUnmutedChannels();

                expect(results).toHaveLength(1);
                expect(_.map(results, 'channelId')).toContain(unmuted1.channelId);
                // Backend should NOT be called (proves cache block executed)
                expect(backend.getChannelsByGuild).not.toHaveBeenCalled();
            });
        });

        describe('Line 303: shouldProcess isDM conditional', () => {
            it('should return true for DM even with muted channel', async () => {
                const mutedChannel = createMockChannel({ isMuted: true });
                await manager.upsertChannel(mutedChannel);

                // Kills mutant: if(isDM) -> false
                // DM should process even though channel is muted
                const result = manager.shouldProcess(
                    mutedChannel.channelId,
                    true,  // isDM
                    false,
                    false
                );

                expect(result).toBe(true);
            });

            it('should return false for non-DM muted channel without overrides', async () => {
                const mutedChannel = createMockChannel({ isMuted: true });
                await manager.upsertChannel(mutedChannel);

                // Proves the negative case - isDM=false should check mute state
                const result = manager.shouldProcess(
                    mutedChannel.channelId,
                    false, // isDM=false
                    false,
                    false
                );

                expect(result).toBe(false);
            });
        });
    });
});
