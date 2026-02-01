/* eslint-disable @typescript-eslint/unbound-method -- Test mocks use expect().toHaveBeenCalled() on mock methods */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';
import type { GuildId } from '@/integrations/discord/types';

describe('ChannelRegistryManager', () => {
    let backend: ChannelRegistryBackend;
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

    beforeEach(() => {
        // Create mock backend
        backend = {
            getAllChannels:      mock(() => Promise.resolve([])),
            getChannel:          mock(() => Promise.resolve(null)),
            upsertChannel:       mock(() => Promise.resolve()),
            deleteChannel:       mock(() => Promise.resolve()),
            getChannelsByGuild:  mock(() => Promise.resolve([])),
            getChannelByName:    mock(() => Promise.resolve([])),
            getWellKnownChannel: mock(() => Promise.resolve(null)),
            muteChannel:         mock(() => Promise.resolve()),
            unmuteChannel:       mock(() => Promise.resolve()),
            markAsWellKnown:     mock(() => Promise.resolve()),
        } as unknown as ChannelRegistryBackend;

        manager = new ChannelRegistryManager({
            backend:     backend,
            homeGuildId: homeGuildId,
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

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));

            await manager.warmCache();

            expect(backend.getAllChannels).toHaveBeenCalledTimes(1);

            // Verify cache is populated by checking cache-first reads
            const cached1 = await manager.getChannel(channel1.channelId);
            const cached2 = await manager.getChannel(channel2.channelId);

            expect(cached1).toEqual(channel1);
            expect(cached2).toEqual(channel2);
            // Backend should not have been called again (cache hit)
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should build name index during cache warming', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general', guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general', guildId: createGuildId('other-guild') });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));

            await manager.warmCache();

            // Name index should allow fast name resolution
            const results = await manager.resolveByName('general');
            expect(results).toHaveLength(2);
        });

        it('should track DM channels during cache warming', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ channelId: createChannelId('dm-channel'), guildId: 'DM', channelName: userId });

            backend.getAllChannels = mock(() => Promise.resolve([dmChannel]));

            await manager.warmCache();

            // DM should be tracked
            const dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);
        });

        it('should handle empty backend', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));

            await manager.warmCache();

            expect(backend.getAllChannels).toHaveBeenCalledTimes(1);
        });

        it('should only mark cache as warmed after successful completion', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));

            // Before warmCache, should fallback to backend
            backend.getChannelsByGuild = mock(() => Promise.resolve([channel1, channel2]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // After warmCache completes, should use cache
            await manager.warmCache();
            await manager.getChannelsByGuild(homeGuildId);
            // Still only 1 call to backend (cache is now used)
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('invalidateCache', () => {
        it('should remove single channel from cache', async () => {
            const channel = createMockChannel();
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Verify channel is in cache
            let cached = await manager.getChannel(channel.channelId);
            expect(cached).toEqual(channel);
            expect(backend.getChannel).not.toHaveBeenCalled();

            // Invalidate cache
            manager.invalidateCache(channel.channelId);

            // Now should fallback to backend
            backend.getChannel = mock(() => Promise.resolve(channel));
            cached = await manager.getChannel(channel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should remove channel from name index', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Verify name resolution works
            let results = await manager.resolveByName('general');
            expect(results).toHaveLength(1);

            // Invalidate cache
            manager.invalidateCache(channel.channelId);

            // Name resolution should return empty (cache is still warmed, just doesn't have the channel)
            results = await manager.resolveByName('general');
            expect(results).toHaveLength(0);

            // Backend should NOT be called since cache is still authoritative
            expect(backend.getChannelByName).not.toHaveBeenCalled();
        });

        it('should remove DM from tracking map', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ channelId: createChannelId('dm-channel'), guildId: 'DM', channelName: userId });
            backend.getAllChannels = mock(() => Promise.resolve([dmChannel]));
            await manager.warmCache();

            // Verify DM is tracked
            let dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);

            // Invalidate cache
            manager.invalidateCache(dmChannel.channelId);

            // DM should no longer be tracked
            dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBeUndefined();
        });

        it('should handle invalidating non-DM channel (guildId check)', async () => {
            const guildChannel = createMockChannel({ guildId: homeGuildId, channelName: 'general' });
            backend.getAllChannels = mock(() => Promise.resolve([guildChannel]));
            await manager.warmCache();

            // Invalidate cache
            manager.invalidateCache(guildChannel.channelId);

            // Verify removed from cache
            backend.getChannel = mock(() => Promise.resolve(guildChannel));
            await manager.getChannel(guildChannel.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should remove well-known channel from well-known cache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getAllChannels = mock(() => Promise.resolve([wellKnown]));
            await manager.warmCache();

            // Verify well-known is cached
            let result = await manager.getWellKnownChannel('general');
            expect(result).toEqual(wellKnown);

            // Invalidate cache
            manager.invalidateCache(wellKnown.channelId);

            // Well-known should fallback to backend
            backend.getWellKnownChannel = mock(() => Promise.resolve(wellKnown));
            result = await manager.getWellKnownChannel('general');
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
            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));
            await manager.warmCache();

            manager.clearCache();

            // All reads should fallback to backend
            backend.getChannel = mock(() => Promise.resolve(channel1));
            await manager.getChannel(channel1.channelId);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
        });

        it('should mark cache as not warmed', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Verify cache is warmed (uses cache for guild query)
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled();

            // Clear cache
            manager.clearCache();

            // Now should fallback to backend (cache not warmed)
            backend.getChannelsByGuild = mock(() => Promise.resolve([channel]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('getChannel', () => {
        it('should return from cache if available', async () => {
            const channel = createMockChannel();
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            const result = await manager.getChannel(channel.channelId);

            expect(result).toEqual(channel);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should fallback to backend if not in cache', async () => {
            const channel = createMockChannel();
            backend.getChannel = mock(() => Promise.resolve(channel));

            const result = await manager.getChannel(channel.channelId);

            expect(result).toEqual(channel);
            expect(backend.getChannel).toHaveBeenCalledTimes(1);
            expect(backend.getChannel).toHaveBeenCalledWith(channel.channelId);
        });

        it('should cache backend result for future reads', async () => {
            const channel = createMockChannel();
            backend.getChannel = mock(() => Promise.resolve(channel));

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
    });

    describe('upsertChannel', () => {
        it('should update both cache and backend', async () => {
            const channel = createMockChannel();

            await manager.upsertChannel(channel);

            expect(backend.upsertChannel).toHaveBeenCalledTimes(1);
            expect(backend.upsertChannel).toHaveBeenCalledWith(channel);

            // Verify cache was updated
            const cached = await manager.getChannel(channel.channelId);
            expect(cached).toEqual(channel);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should update name index on upsert', async () => {
            const channel = createMockChannel({ channelName: 'general' });

            await manager.upsertChannel(channel);

            // Name resolution should work without backend call
            const results = await manager.resolveByName('general', channel.guildId as GuildId);
            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel.channelId);
        });

        it('should track DM channels on upsert', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ channelId: createChannelId('dm-channel'), guildId: 'DM', channelName: userId });

            await manager.upsertChannel(dmChannel);

            const dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);
        });

        it('should handle channel name change in cache', async () => {
            const channel = createMockChannel({ channelName: 'old-name' });
            await manager.upsertChannel(channel);

            // Update channel with new name
            const updated = { ...channel, channelName: 'new-name' };
            await manager.upsertChannel(updated);

            // Old name should not resolve
            backend.getChannelByName = mock(() => Promise.resolve([]));
            const oldResults = await manager.resolveByName('old-name', channel.guildId as GuildId);
            expect(oldResults).toHaveLength(0);

            // New name should resolve
            const newResults = await manager.resolveByName('new-name', channel.guildId as GuildId);
            expect(newResults).toHaveLength(1);
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

        it('should mark cache as warmed after upsert', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });

            // Upsert without warming cache first
            await manager.upsertChannel(channel);

            // Should now use cache (not fallback to backend)
            const results = await manager.getChannelsByGuild(homeGuildId);
            expect(results).toHaveLength(1);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled();
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

            await manager.deleteChannel(channel.channelId);

            // Name resolution should not find it in cache
            backend.getChannelByName = mock(() => Promise.resolve([]));
            const results = await manager.resolveByName('general', channel.guildId as GuildId);
            expect(results).toHaveLength(0);
        });

        it('should remove DM tracking', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ channelId: createChannelId('dm-channel'), guildId: 'DM', channelName: userId });
            await manager.upsertChannel(dmChannel);

            await manager.deleteChannel(dmChannel.channelId);

            const dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBeUndefined();
        });
    });

    describe('getChannelsByGuild', () => {
        it('should return channels from cache if available', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });
            const channel3 = createMockChannel({ channelId: createChannelId('channel-3'), guildId: createGuildId('other-guild') });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2, channel3]));
            await manager.warmCache();

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(2);
            expect(results).toContainEqual(channel1);
            expect(results).toContainEqual(channel2);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled();
        });

        it('should fallback to backend if cache is cold', async () => {
            const channel1 = createMockChannel({ guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            backend.getChannelsByGuild = mock(() => Promise.resolve([channel1, channel2]));

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(2);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
            expect(backend.getChannelsByGuild).toHaveBeenCalledWith(homeGuildId);
        });

        it('should cache results from backend fallback', async () => {
            const channel1 = createMockChannel({ guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), guildId: homeGuildId });

            backend.getChannelsByGuild = mock(() => Promise.resolve([channel1, channel2]));

            // First call - cache miss
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Channels should now be cached
            const cached1 = await manager.getChannel(channel1.channelId);
            expect(cached1).toEqual(channel1);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should return empty array for unknown guild', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));
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

            backend.getAllChannels = mock(() => Promise.resolve([unmuted1, muted, unmuted2]));
            await manager.warmCache();

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(2);
            expect(results).toContainEqual(unmuted1);
            expect(results).toContainEqual(unmuted2);
            expect(results).not.toContainEqual(muted);
        });

        it('should fallback to backend if cache is cold', async () => {
            const unmuted = createMockChannel({ isMuted: false });

            backend.getAllChannels = mock(() => Promise.resolve([unmuted]));

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(1);
            expect(backend.getAllChannels).toHaveBeenCalledTimes(1);
        });

        it('should cache results from backend fallback', async () => {
            const unmuted = createMockChannel({ isMuted: false });
            const muted = createMockChannel({ channelId: createChannelId('muted'), isMuted: true });

            backend.getAllChannels = mock(() => Promise.resolve([unmuted, muted]));

            // First call - cache miss
            await manager.getUnmutedChannels();
            expect(backend.getAllChannels).toHaveBeenCalledTimes(1);

            // Both channels should now be cached
            const cachedUnmuted = await manager.getChannel(unmuted.channelId);
            const cachedMuted = await manager.getChannel(muted.channelId);
            expect(cachedUnmuted).toEqual(unmuted);
            expect(cachedMuted).toEqual(muted);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should return empty array if all channels are muted', async () => {
            const muted1 = createMockChannel({ channelId: createChannelId('muted-1'), isMuted: true });
            const muted2 = createMockChannel({ channelId: createChannelId('muted-2'), isMuted: true });

            backend.getAllChannels = mock(() => Promise.resolve([muted1, muted2]));
            await manager.warmCache();

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(0);
        });
    });

    describe('getWellKnownChannel', () => {
        it('should return from cache if available', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });

            backend.getAllChannels = mock(() => Promise.resolve([wellKnown]));
            await manager.warmCache();

            const result = await manager.getWellKnownChannel('general');

            expect(result).toEqual(wellKnown);
            expect(backend.getWellKnownChannel).not.toHaveBeenCalled();
        });

        it('should fallback to backend if not in cache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getWellKnownChannel = mock(() => Promise.resolve(wellKnown));

            const result = await manager.getWellKnownChannel('general');

            expect(result).toEqual(wellKnown);
            expect(backend.getWellKnownChannel).toHaveBeenCalledTimes(1);
            expect(backend.getWellKnownChannel).toHaveBeenCalledWith('general');
        });

        it('should cache backend result', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getWellKnownChannel = mock(() => Promise.resolve(wellKnown));

            await manager.getWellKnownChannel('general');
            await manager.getWellKnownChannel('general');

            expect(backend.getWellKnownChannel).toHaveBeenCalledTimes(1);
        });

        it('should return null if not found', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));
            await manager.warmCache();

            const result = await manager.getWellKnownChannel('general');

            expect(result).toBeNull();
        });
    });

    describe('resolveByName', () => {
        it('should resolve from cache with guild context', async () => {
            const channel = createMockChannel({ channelName: 'general', guildId: homeGuildId });

            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            const results = await manager.resolveByName('general', homeGuildId);

            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel.channelId);
            expect(results[0].channelName).toBe('general');
            expect(backend.getChannelByName).not.toHaveBeenCalled();
        });

        it('should resolve multiple matches for disambiguation', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general', guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general', guildId: createGuildId('other-guild') });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));
            await manager.warmCache();

            const results = await manager.resolveByName('general');

            expect(results).toHaveLength(2);
        });

        it('should fallback to backend if cache is cold', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            backend.getChannelByName = mock(() => Promise.resolve([channel]));

            const results = await manager.resolveByName('general', homeGuildId);

            expect(results).toHaveLength(1);
            expect(backend.getChannelByName).toHaveBeenCalledTimes(1);
            expect(backend.getChannelByName).toHaveBeenCalledWith('general', homeGuildId);
        });

        it('should cache results from backend fallback', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            backend.getChannelByName = mock(() => Promise.resolve([channel]));

            // First call - cache miss
            await manager.resolveByName('general');
            expect(backend.getChannelByName).toHaveBeenCalledTimes(1);

            // Channel should now be cached
            const cached = await manager.getChannel(channel.channelId);
            expect(cached).toEqual(channel);
            expect(backend.getChannel).not.toHaveBeenCalled();
        });

        it('should return empty array for unknown channel name', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));
            await manager.warmCache();

            const results = await manager.resolveByName('nonexistent');

            expect(results).toHaveLength(0);
        });

        it('should filter by guild context when provided', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general', guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general', guildId: createGuildId('other-guild') });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));
            await manager.warmCache();

            const results = await manager.resolveByName('general', homeGuildId);

            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel1.channelId);
        });

        it('should handle missing channel in name index (cache inconsistency)', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            await manager.upsertChannel(channel);

            // Manually corrupt cache state by removing channel but leaving name index
            manager.invalidateCache(channel.channelId);
            // Force re-add to name index
            await manager.upsertChannel(channel);
            // Remove just from channel cache (simulate inconsistency)
            manager.invalidateCache(channel.channelId);

            // This should handle the missing channel gracefully
            const results = await manager.resolveByName('general');
            expect(results).toHaveLength(0); // Channel not in cache
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
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
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
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
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
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
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
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
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

    describe('trackDM', () => {
        it('should track DM channel for user', () => {
            const userId = createUserId('user-123');
            const channelId = createChannelId('dm-channel');

            manager.trackDM(userId, channelId);

            const result = manager.getDMChannel(userId);
            expect(result).toBe(channelId);
        });

        it('should update existing DM tracking', () => {
            const userId = createUserId('user-123');
            const oldChannelId = createChannelId('old-dm-channel');
            const newChannelId = createChannelId('new-dm-channel');

            manager.trackDM(userId, oldChannelId);
            manager.trackDM(userId, newChannelId);

            const result = manager.getDMChannel(userId);
            expect(result).toBe(newChannelId);
        });
    });

    describe('getDMChannel', () => {
        it('should return channel ID for tracked user', () => {
            const userId = createUserId('user-123');
            const channelId = createChannelId('dm-channel');

            manager.trackDM(userId, channelId);

            const result = manager.getDMChannel(userId);
            expect(result).toBe(channelId);
        });

        it('should return undefined for untracked user', () => {
            const result = manager.getDMChannel(createUserId('unknown-user'));
            expect(result).toBeUndefined();
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

    describe('homeGuild getter', () => {
        it('should return home guild ID', () => {
            expect(manager.homeGuild).toBe(homeGuildId);
        });
    });
});
