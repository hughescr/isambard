import _ from 'lodash';
import type { ChannelRegistryBackend } from './backend';
import type { ChannelMetadata, WellKnownChannel, ChannelReference } from './types';
import type { ChannelId, GuildId, UserId } from '../types';

/**
 * Configuration for ChannelRegistryManager.
 */
export interface ChannelRegistryManagerConfig {
    /** Backend for DynamoDB operations */
    backend:     ChannelRegistryBackend
    /** Home guild ID for proactive sessions */
    homeGuildId: GuildId
}

/**
 * Channel registry manager with in-memory caching.
 * Provides fast channel lookups and filtering logic for message processing.
 *
 * Cache strategy:
 * - warmCache(): Load all channels from DynamoDB on startup
 * - Cache-first reads: Check cache before DynamoDB
 * - Write-through: Update both cache and DynamoDB
 * - Name index: Maintained for fast name resolution
 */
export class ChannelRegistryManager {
    // In-memory caches
    private readonly channelCache:   Map<ChannelId, ChannelMetadata>;
    private readonly nameIndex:      Map<string, ChannelId[]>;  // channelName → [channelIds]
    private readonly dmUserMap:      Map<UserId, ChannelId>;    // userId → dmChannelId
    private readonly wellKnownCache: Map<WellKnownChannel, ChannelId>; // wellKnownType → channelId

    private readonly backend:     ChannelRegistryBackend;
    private readonly homeGuildId: GuildId;
    private cacheWarmed           = false;

    constructor(config: ChannelRegistryManagerConfig) {
        this.backend = config.backend;
        this.homeGuildId = config.homeGuildId;

        // Initialize caches
        this.channelCache = new Map();
        this.nameIndex = new Map();
        this.dmUserMap = new Map();
        this.wellKnownCache = new Map();
    }

    /**
     * Load all channels from DynamoDB into cache.
     * Should be called on startup for optimal performance.
     */
    async warmCache(): Promise<void> {
        const channels = await this.backend.getAllChannels();

        for(const channel of channels) {
            this.addToCache(channel);
        }

        this.cacheWarmed = true;
    }

    /**
     * Remove a single channel from cache.
     * Use when a channel is deleted or needs to be refreshed from backend.
     */
    invalidateCache(channelId: ChannelId): void {
        const channel = this.channelCache.get(channelId);
        if(!channel) {
            return;
        }

        // Remove from channel cache
        this.channelCache.delete(channelId);

        // Remove from name index
        this.removeFromNameIndex(channel);

        // Remove from DM map if applicable
        if(channel.guildId === 'DM') {
            // Find and remove from dmUserMap
            for(const [userId, dmChannelId] of this.dmUserMap.entries()) {
                if(dmChannelId === channelId) {
                    this.dmUserMap.delete(userId);
                    break;
                }
            }
        }

        // Remove from well-known cache if applicable
        if(channel.isWellKnown) {
            this.wellKnownCache.delete(channel.isWellKnown);
        }
    }

    /**
     * Clear entire cache.
     * Use for cache reset or during testing.
     */
    clearCache(): void {
        this.channelCache.clear();
        this.nameIndex.clear();
        this.dmUserMap.clear();
        this.wellKnownCache.clear();
        this.cacheWarmed = false;
    }

    /**
     * Get a channel by ID.
     * Cache-first with backend fallback.
     */
    async getChannel(channelId: ChannelId): Promise<ChannelMetadata | null> {
        // Check cache first
        const cached = this.channelCache.get(channelId);
        if(cached) {
            return cached;
        }

        // Fallback to backend
        const channel = await this.backend.getChannel(channelId);
        if(channel) {
            this.addToCache(channel);
        }

        return channel;
    }

    /**
     * Upsert a channel (create or update).
     * Write-through to both cache and backend.
     */
    async upsertChannel(metadata: ChannelMetadata): Promise<void> {
        // Remove old cache entry if it exists (to handle name changes)
        const existing = this.channelCache.get(metadata.channelId);
        if(existing) {
            this.removeFromNameIndex(existing);
            if(existing.isWellKnown) {
                this.wellKnownCache.delete(existing.isWellKnown);
            }
        }

        // Update backend
        await this.backend.upsertChannel(metadata);

        // Update cache
        this.addToCache(metadata);

        // Mark cache as warmed since we're actively managing it
        this.cacheWarmed = true;
    }

    /**
     * Delete a channel.
     * Removes from both cache and backend.
     */
    async deleteChannel(channelId: ChannelId): Promise<void> {
        // Remove from cache
        this.invalidateCache(channelId);

        // Remove from backend
        await this.backend.deleteChannel(channelId);
    }

    /**
     * Get all channels in a guild.
     * Cache-first with backend fallback.
     */
    async getChannelsByGuild(guildId: GuildId): Promise<ChannelMetadata[]> {
        // If cache is warmed, filter from cache
        if(this.cacheWarmed) {
            const results: ChannelMetadata[] = [];
            for(const channel of this.channelCache.values()) {
                if(channel.guildId === guildId) {
                    results.push(channel);
                }
            }
            return results;
        }

        // Fallback to backend
        const channels = await this.backend.getChannelsByGuild(guildId);

        // Cache results
        for(const channel of channels) {
            this.addToCache(channel);
        }

        return channels;
    }

    /**
     * Get all unmuted channels.
     * Cache-first with backend fallback.
     */
    async getUnmutedChannels(): Promise<ChannelMetadata[]> {
        // If cache is warmed, filter from cache
        if(this.cacheWarmed) {
            const results: ChannelMetadata[] = [];
            for(const channel of this.channelCache.values()) {
                if(!channel.isMuted) {
                    results.push(channel);
                }
            }
            return results;
        }

        // Fallback to backend
        const channels = await this.backend.getAllChannels();

        // Cache results
        for(const channel of channels) {
            this.addToCache(channel);
        }

        // Filter unmuted
        return _.filter(channels, channel => !channel.isMuted);
    }

    /**
     * Get a well-known channel by type.
     * Cache-first with backend fallback.
     */
    async getWellKnownChannel(type: WellKnownChannel): Promise<ChannelMetadata | null> {
        // Check well-known cache first
        const channelId = this.wellKnownCache.get(type);
        if(channelId) {
            const channel = this.channelCache.get(channelId);
            if(channel) {
                return channel;
            }
        }

        // Fallback to backend
        const channel = await this.backend.getWellKnownChannel(type);
        if(channel) {
            this.addToCache(channel);
        }

        return channel;
    }

    /**
     * Resolve channels by name.
     * Returns multiple matches for disambiguation.
     * Cache-first with backend fallback.
     */
    async resolveByName(channelName: string, contextGuildId?: GuildId): Promise<ChannelReference[]> {
        // If cache is warmed, resolve from cache
        if(this.cacheWarmed) {
            const channelIds = this.nameIndex.get(channelName) ?? [];
            const results: ChannelReference[] = [];

            for(const channelId of channelIds) {
                const channel = this.channelCache.get(channelId);
                if(!channel) {
                    continue;
                }

                // Filter by guild context if provided
                if(contextGuildId && channel.guildId !== contextGuildId) {
                    continue;
                }

                results.push({
                    channelName: channel.channelName,
                    guildName:   undefined, // Would need guild registry to populate
                    channelId:   channel.channelId,
                    guildId:     channel.guildId,
                });
            }

            return results;
        }

        // Fallback to backend
        const channels = await this.backend.getChannelByName(channelName, contextGuildId);

        // Cache results
        for(const channel of channels) {
            this.addToCache(channel);
        }

        // Convert to ChannelReference
        return _.map(channels, channel => ({
            channelName: channel.channelName,
            guildName:   undefined,
            channelId:   channel.channelId,
            guildId:     channel.guildId,
        }));
    }

    /**
     * The core filtering logic - determines if a message should be processed.
     *
     * Override conditions (always process):
     * - DM channels
     * - Mentions
     * - Replies to bot
     *
     * Otherwise, check mute state from cache.
     */
    shouldProcess(channelId: ChannelId, isDM: boolean, isMention: boolean, isReplyToBot: boolean): boolean {
        // Override conditions - always process
        if(isDM) {
            return true;
        }
        if(isMention) {
            return true;
        }
        if(isReplyToBot) {
            return true;
        }

        // Check mute state from cache
        const channel = this.channelCache.get(channelId);
        if(!channel) {
            // Unknown channel - process it (will be discovered)
            return true;
        }

        // Muted channels are not processed (unless override)
        return !channel.isMuted;
    }

    /**
     * Track a DM channel for a user.
     * Called when a DM channel is discovered or updated.
     */
    trackDM(userId: UserId, channelId: ChannelId): void {
        this.dmUserMap.set(userId, channelId);
    }

    /**
     * Get the DM channel ID for a user.
     * Returns undefined if no DM channel is tracked.
     */
    getDMChannel(userId: UserId): ChannelId | undefined {
        return this.dmUserMap.get(userId);
    }

    /**
     * Mute a channel.
     * Updates both cache and backend.
     */
    async muteChannel(channelId: ChannelId): Promise<void> {
        // Update backend
        await this.backend.muteChannel(channelId);

        // Update cache
        const channel = this.channelCache.get(channelId);
        if(channel) {
            channel.isMuted = true;
        }
    }

    /**
     * Unmute a channel.
     * Updates both cache and backend.
     */
    async unmuteChannel(channelId: ChannelId): Promise<void> {
        // Update backend
        await this.backend.unmuteChannel(channelId);

        // Update cache
        const channel = this.channelCache.get(channelId);
        if(channel) {
            channel.isMuted = false;
        }
    }

    /**
     * Mark a channel as well-known (admin operation).
     * Updates both cache and backend.
     */
    async markAsWellKnown(channelId: ChannelId, type: WellKnownChannel): Promise<void> {
        // Update backend
        await this.backend.markAsWellKnown(channelId, type);

        // Update cache
        const channel = this.channelCache.get(channelId);
        if(channel) {
            channel.isWellKnown = type;
            this.wellKnownCache.set(type, channelId);
        }
    }

    /**
     * Get the home guild ID.
     */
    get homeGuild(): GuildId {
        return this.homeGuildId;
    }

    /**
     * Add a channel to all caches.
     * Private helper method for cache management.
     */
    private addToCache(channel: ChannelMetadata): void {
        // Add to channel cache
        this.channelCache.set(channel.channelId, channel);

        // Add to name index
        this.addToNameIndex(channel);

        // Track DM channels
        if(channel.guildId === 'DM') {
            // Channel name for DMs is the userId
            this.dmUserMap.set(channel.channelName as UserId, channel.channelId);
        }

        // Track well-known channels
        if(channel.isWellKnown) {
            this.wellKnownCache.set(channel.isWellKnown, channel.channelId);
        }
    }

    /**
     * Add a channel to the name index.
     * Private helper method.
     */
    private addToNameIndex(channel: ChannelMetadata): void {
        const channelIds = this.nameIndex.get(channel.channelName) ?? [];
        if(!channelIds.includes(channel.channelId)) {
            channelIds.push(channel.channelId);
            this.nameIndex.set(channel.channelName, channelIds);
        }
    }

    /**
     * Remove a channel from the name index.
     * Private helper method.
     */
    private removeFromNameIndex(channel: ChannelMetadata): void {
        const channelIds = this.nameIndex.get(channel.channelName);
        if(channelIds) {
            const index = channelIds.indexOf(channel.channelId);
            if(index !== -1) {
                channelIds.splice(index, 1);
            }
            if(channelIds.length === 0) {
                this.nameIndex.delete(channel.channelName);
            }
        }
    }
}
