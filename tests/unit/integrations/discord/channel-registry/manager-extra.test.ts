/* eslint-disable @typescript-eslint/unbound-method -- Test mocks use expect().toHaveBeenCalled() on mock methods */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import type { ChannelMetadata } from '@/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId, createUserId } from '@/integrations/discord/types';
import type { UserId } from '@/integrations/discord/types';

describe('ChannelRegistryManager - Additional Mutation Tests', () => {
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

    describe('name index operations', () => {
        it('should not duplicate channel IDs in name index', async () => {
            const channel = createMockChannel({ channelName: 'general' });

            // Upsert same channel multiple times
            await manager.upsertChannel(channel);
            await manager.upsertChannel(channel);
            await manager.upsertChannel(channel);

            // Should only appear once in results
            const results = await manager.resolveByName('general');
            expect(results).toHaveLength(1);
        });

        it('should handle multiple channels with same name', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general', guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general', guildId: createGuildId('guild-2') });
            const channel3 = createMockChannel({ channelId: createChannelId('channel-3'), channelName: 'general', guildId: createGuildId('guild-3') });

            await manager.upsertChannel(channel1);
            await manager.upsertChannel(channel2);
            await manager.upsertChannel(channel3);

            const results = await manager.resolveByName('general');
            expect(results).toHaveLength(3);
        });

        it('should remove last channel from name index and clean up entry', async () => {
            const channel = createMockChannel({ channelName: 'unique-name' });
            await manager.upsertChannel(channel);

            // Verify name resolution works
            let results = await manager.resolveByName('unique-name');
            expect(results).toHaveLength(1);

            // Delete the channel
            await manager.deleteChannel(channel.channelId);

            // Name should no longer resolve
            results = await manager.resolveByName('unique-name');
            expect(results).toHaveLength(0);
        });

        it('should remove one channel from name index with multiple entries', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('channel-1'), channelName: 'general' });
            const channel2 = createMockChannel({ channelId: createChannelId('channel-2'), channelName: 'general' });

            await manager.upsertChannel(channel1);
            await manager.upsertChannel(channel2);

            // Both should be found
            let results = await manager.resolveByName('general');
            expect(results).toHaveLength(2);

            // Delete one
            await manager.deleteChannel(channel1.channelId);

            // Only one should remain
            results = await manager.resolveByName('general');
            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel2.channelId);
        });

        it('should handle channel not in name index during removal', async () => {
            const channel = createMockChannel({ channelName: 'general' });
            await manager.upsertChannel(channel);

            // Manually invalidate to remove from name index
            manager.invalidateCache(channel.channelId);

            // Try to delete again - should not crash
            expect(() => manager.invalidateCache(channel.channelId)).not.toThrow();
        });
    });

    describe('DM tracking edge cases', () => {
        it('should handle non-DM channel in addToCache', async () => {
            const guildChannel = createMockChannel({ guildId: homeGuildId });
            await manager.upsertChannel(guildChannel);

            // Should NOT be in DM map
            const dmChannelId = manager.getDMChannel(guildChannel.channelName as UserId);
            expect(dmChannelId).toBeUndefined();
        });

        it('should handle DM channel in addToCache', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ guildId: 'DM', channelName: userId });
            await manager.upsertChannel(dmChannel);

            // SHOULD be in DM map
            const dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);
        });

        it('should not remove non-DM from DM map during invalidation', async () => {
            const userId = createUserId('user-123');
            const dmChannel = createMockChannel({ channelId: createChannelId('dm'), guildId: 'DM', channelName: userId });
            await manager.upsertChannel(dmChannel);

            // Add a regular guild channel
            const guildChannel = createMockChannel({ channelId: createChannelId('guild'), guildId: homeGuildId });
            await manager.upsertChannel(guildChannel);

            // DM should be tracked
            let dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);

            // Invalidate guild channel (should not affect DM map)
            manager.invalidateCache(guildChannel.channelId);

            // DM should still be tracked
            dmChannelId = manager.getDMChannel(userId);
            expect(dmChannelId).toBe(dmChannel.channelId);
        });

        it('should skip non-matching DM channels during invalidation loop', async () => {
            const user1 = createUserId('user-1');
            const user2 = createUserId('user-2');
            const dmChannel1 = createMockChannel({ channelId: createChannelId('dm-1'), guildId: 'DM', channelName: user1 });
            const dmChannel2 = createMockChannel({ channelId: createChannelId('dm-2'), guildId: 'DM', channelName: user2 });

            await manager.upsertChannel(dmChannel1);
            await manager.upsertChannel(dmChannel2);

            // Both should be tracked
            expect(manager.getDMChannel(user1)).toBe(dmChannel1.channelId);
            expect(manager.getDMChannel(user2)).toBe(dmChannel2.channelId);

            // Invalidate first DM
            manager.invalidateCache(dmChannel1.channelId);

            // First should be gone, second should remain
            expect(manager.getDMChannel(user1)).toBeUndefined();
            expect(manager.getDMChannel(user2)).toBe(dmChannel2.channelId);
        });
    });

    describe('well-known channel tracking', () => {
        it('should track well-known channels during warmCache', async () => {
            const wellKnown = createMockChannel({ isWellKnown: 'general' });
            backend.getAllChannels = mock(() => Promise.resolve([wellKnown]));

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
            backend.getChannelsByGuild = mock(() => Promise.resolve([channel]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);

            // Warm the cache
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Now should use cache
            await manager.getChannelsByGuild(homeGuildId);
            // Backend should NOT be called again
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1); // Still only 1 call
        });

        it('should transition from warmed to cold cache', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Cache is warmed - uses cache
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled();

            // Clear cache
            manager.clearCache();

            // Now should use backend
            backend.getChannelsByGuild = mock(() => Promise.resolve([channel]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalledTimes(1);
        });
    });

    describe('empty loop cases', () => {
        it('should handle empty warmCache', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));

            await manager.warmCache();

            // Cache should be warmed even with no channels
            const results = await manager.getChannelsByGuild(homeGuildId);
            expect(results).toHaveLength(0);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled(); // Uses cache
        });

        it('should handle empty backend result in getChannelsByGuild', async () => {
            backend.getChannelsByGuild = mock(() => Promise.resolve([]));

            const results = await manager.getChannelsByGuild(homeGuildId);

            expect(results).toHaveLength(0);
        });

        it('should handle empty backend result in getUnmutedChannels', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));

            const results = await manager.getUnmutedChannels();

            expect(results).toHaveLength(0);
        });

        it('should handle empty backend result in resolveByName', async () => {
            backend.getChannelByName = mock(() => Promise.resolve([]));

            const results = await manager.resolveByName('nonexistent');

            expect(results).toHaveLength(0);
        });

        it('should handle empty name index lookup', async () => {
            backend.getAllChannels = mock(() => Promise.resolve([]));
            await manager.warmCache();

            // Name index will be empty
            const results = await manager.resolveByName('nonexistent');

            expect(results).toHaveLength(0);
        });

        it('should verify empty for loops do work when not empty', async () => {
            // Verify getChannelsByGuild backend fallback loop actually adds to cache
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), guildId: homeGuildId });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), guildId: homeGuildId });

            backend.getChannelsByGuild = mock(() => Promise.resolve([channel1, channel2]));

            await manager.getChannelsByGuild(homeGuildId);

            // Verify channels were cached by checking cache hit
            const cached1 = await manager.getChannel(channel1.channelId);
            expect(cached1).toEqual(channel1);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hit
        });

        it('should verify getUnmutedChannels backend fallback loop works', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), isMuted: false });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), isMuted: true });

            backend.getAllChannels = mock(() => Promise.resolve([channel1, channel2]));

            const results = await manager.getUnmutedChannels();

            // Verify both were cached
            const cached1 = await manager.getChannel(channel1.channelId);
            const cached2 = await manager.getChannel(channel2.channelId);
            expect(cached1).toEqual(channel1);
            expect(cached2).toEqual(channel2);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hits

            // Verify correct filtering
            expect(results).toHaveLength(1);
            expect(results[0]).toEqual(channel1);
        });

        it('should verify resolveByName backend fallback loop works', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), channelName: 'general' });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), channelName: 'general' });

            backend.getChannelByName = mock(() => Promise.resolve([channel1, channel2]));

            await manager.resolveByName('general');

            // Verify both were cached
            const cached1 = await manager.getChannel(channel1.channelId);
            const cached2 = await manager.getChannel(channel2.channelId);
            expect(cached1).toEqual(channel1);
            expect(cached2).toEqual(channel2);
            expect(backend.getChannel).not.toHaveBeenCalled(); // Cache hits
        });
    });

    describe('conditional expression mutations', () => {
        it('should test clearCache sets cacheWarmed to exactly false', async () => {
            const channel = createMockChannel({ guildId: homeGuildId });
            backend.getAllChannels = mock(() => Promise.resolve([channel]));
            await manager.warmCache();

            // Cache is warmed
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).not.toHaveBeenCalled();

            manager.clearCache();

            // If cacheWarmed was set to true instead of false, this would fail
            backend.getChannelsByGuild = mock(() => Promise.resolve([channel]));
            await manager.getChannelsByGuild(homeGuildId);
            expect(backend.getChannelsByGuild).toHaveBeenCalled();
        });

        it('should test that !channelIds.includes checks correctly', async () => {
            const channel = createMockChannel({ channelName: 'general' });

            // First upsert
            await manager.upsertChannel(channel);

            // Second upsert of same channel - should not duplicate
            await manager.upsertChannel(channel);

            const results = await manager.resolveByName('general');
            expect(results).toHaveLength(1); // If includes check was inverted, would have 2
        });

        it('should test that index !== -1 check works correctly', async () => {
            const channel1 = createMockChannel({ channelId: createChannelId('ch1'), channelName: 'test' });
            const channel2 = createMockChannel({ channelId: createChannelId('ch2'), channelName: 'test' });

            await manager.upsertChannel(channel1);
            await manager.upsertChannel(channel2);

            // Both in index
            let results = await manager.resolveByName('test');
            expect(results).toHaveLength(2);

            // Remove one
            await manager.deleteChannel(channel1.channelId);

            // If index !== -1 was mutated to true, splice would happen on -1
            results = await manager.resolveByName('test');
            expect(results).toHaveLength(1);
            expect(results[0].channelId).toBe(channel2.channelId);
        });

        it('should test that channelIds.length === 0 check works correctly', async () => {
            const channel = createMockChannel({ channelName: 'unique' });

            await manager.upsertChannel(channel);

            // Delete it
            await manager.deleteChannel(channel.channelId);

            // If length === 0 was mutated to true, entry would be deleted even when not empty
            const results = await manager.resolveByName('unique');
            expect(results).toHaveLength(0);
        });
    });

    describe('mutation-killing tests for surviving mutants', () => {
        describe('Line 79: invalidateCache DM check', () => {
            it('should NOT modify dmUserMap when invalidating non-DM channel', async () => {
                const userId = createUserId('user-123');
                const dmChannel = createMockChannel({ channelId: createChannelId('dm'), guildId: 'DM', channelName: userId });
                const guildChannel = createMockChannel({ channelId: createChannelId('guild'), guildId: homeGuildId });

                await manager.upsertChannel(dmChannel);
                await manager.upsertChannel(guildChannel);

                // DM should be tracked
                expect(manager.getDMChannel(userId)).toBe(dmChannel.channelId);

                // Invalidate guild channel - this should NOT affect DM map
                // Kills mutant: if(channel.guildId === 'DM') -> true
                manager.invalidateCache(guildChannel.channelId);

                // DM should still be tracked (proves DM check is working)
                expect(manager.getDMChannel(userId)).toBe(dmChannel.channelId);
            });
        });

        describe('Line 82: invalidateCache dmChannelId match check', () => {
            it('should NOT delete from dmUserMap when channelIds do not match', async () => {
                const user1 = createUserId('user-1');
                const user2 = createUserId('user-2');
                const dmChannel1 = createMockChannel({ channelId: createChannelId('dm-1'), guildId: 'DM', channelName: user1 });
                const dmChannel2 = createMockChannel({ channelId: createChannelId('dm-2'), guildId: 'DM', channelName: user2 });

                await manager.upsertChannel(dmChannel1);
                await manager.upsertChannel(dmChannel2);

                // Both should be tracked
                expect(manager.getDMChannel(user1)).toBe(dmChannel1.channelId);
                expect(manager.getDMChannel(user2)).toBe(dmChannel2.channelId);

                // Invalidate first DM - should only remove first entry
                // Kills mutant: if(dmChannelId === channelId) -> true
                manager.invalidateCache(dmChannel1.channelId);

                // First should be removed, second should remain
                expect(manager.getDMChannel(user1)).toBeUndefined();
                expect(manager.getDMChannel(user2)).toBe(dmChannel2.channelId);
            });

            it('should iterate through dmUserMap and only delete matching channelId', async () => {
                // Create 3 DM channels to ensure we test loop iteration
                const user1 = createUserId('user-1');
                const user2 = createUserId('user-2');
                const user3 = createUserId('user-3');
                const dmChannel1 = createMockChannel({ channelId: createChannelId('dm-1'), guildId: 'DM', channelName: user1 });
                const dmChannel2 = createMockChannel({ channelId: createChannelId('dm-2'), guildId: 'DM', channelName: user2 });
                const dmChannel3 = createMockChannel({ channelId: createChannelId('dm-3'), guildId: 'DM', channelName: user3 });

                await manager.upsertChannel(dmChannel1);
                await manager.upsertChannel(dmChannel2);
                await manager.upsertChannel(dmChannel3);

                // All three should be tracked
                expect(manager.getDMChannel(user1)).toBe(dmChannel1.channelId);
                expect(manager.getDMChannel(user2)).toBe(dmChannel2.channelId);
                expect(manager.getDMChannel(user3)).toBe(dmChannel3.channelId);

                // Invalidate middle DM - loop must iterate to find it
                // If mutant (dmChannelId === channelId) -> true, it would delete first entry
                manager.invalidateCache(dmChannel2.channelId);

                // First and third should remain, second should be removed
                expect(manager.getDMChannel(user1)).toBe(dmChannel1.channelId);
                expect(manager.getDMChannel(user2)).toBeUndefined();
                expect(manager.getDMChannel(user3)).toBe(dmChannel3.channelId);
            });
        });

        describe('Line 196: getUnmutedChannels cache-warmed block', () => {
            it('should use cache when warmed and NOT call backend', async () => {
                const unmuted1 = createMockChannel({ channelId: createChannelId('unmuted-1'), isMuted: false });
                const muted = createMockChannel({ channelId: createChannelId('muted'), isMuted: true });

                backend.getAllChannels = mock(() => Promise.resolve([unmuted1, muted]));
                await manager.warmCache();

                // Reset the mock to verify backend is NOT called
                backend.getAllChannels = mock(() => Promise.resolve([unmuted1, muted]));

                // Kills mutant: if(this.cacheWarmed) BlockStatement -> {}
                // If block was empty, backend would be called
                const results = await manager.getUnmutedChannels();

                expect(results).toHaveLength(1);
                expect(results).toContainEqual(unmuted1);
                // Backend should NOT be called (proves cache block executed)
                expect(backend.getAllChannels).not.toHaveBeenCalled();
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

        describe('Line 436: removeFromNameIndex index check', () => {
            it('should splice when channel IS in the index', async () => {
                const channel1 = createMockChannel({ channelId: createChannelId('ch1'), channelName: 'shared' });
                const channel2 = createMockChannel({ channelId: createChannelId('ch2'), channelName: 'shared' });

                await manager.upsertChannel(channel1);
                await manager.upsertChannel(channel2);

                // Both should be in index
                let results = await manager.resolveByName('shared');
                expect(results).toHaveLength(2);

                // Delete one - kills mutant: if(index !== -1) UnaryOperator -1 to +1
                await manager.deleteChannel(channel1.channelId);

                // Only one should remain (proves splice happened)
                results = await manager.resolveByName('shared');
                expect(results).toHaveLength(1);
                expect(results[0].channelId).toBe(channel2.channelId);
            });

            it('should handle channel NOT in index gracefully', async () => {
                const channel = createMockChannel({ channelName: 'test' });
                await manager.upsertChannel(channel);

                // Manually corrupt state - remove from cache
                manager.invalidateCache(channel.channelId);

                // Try to invalidate again - channel not in cache, not in index
                // Should not crash (proves index !== -1 check works)
                expect(() => manager.invalidateCache(channel.channelId)).not.toThrow();
            });
        });

        describe('Line 439: removeFromNameIndex length check', () => {
            it('should delete name index entry when length becomes 0', async () => {
                const channel = createMockChannel({ channelName: 'last-one' });
                await manager.upsertChannel(channel);

                // Verify it exists
                let results = await manager.resolveByName('last-one');
                expect(results).toHaveLength(1);

                // Delete the channel - kills mutant: if(channelIds.length === 0) -> false
                await manager.deleteChannel(channel.channelId);

                // Entry should be completely removed from name index
                results = await manager.resolveByName('last-one');
                expect(results).toHaveLength(0);
            });

            it('should NOT delete name index entry when length is NOT 0', async () => {
                const channel1 = createMockChannel({ channelId: createChannelId('ch1'), channelName: 'shared' });
                const channel2 = createMockChannel({ channelId: createChannelId('ch2'), channelName: 'shared' });

                await manager.upsertChannel(channel1);
                await manager.upsertChannel(channel2);

                // Delete one channel
                await manager.deleteChannel(channel1.channelId);

                // Name should still resolve (proves entry NOT deleted when length > 0)
                const results = await manager.resolveByName('shared');
                expect(results).toHaveLength(1);
                expect(results[0].channelId).toBe(channel2.channelId);
            });
        });
    });
});
