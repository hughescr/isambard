import { logger } from '@hughescr/logger';
import type { Client, Channel } from 'discord.js';
import { createGuildId, type ChannelId, type GuildId  } from '../types';
import type { ChannelRegistryBackend } from './backend';
import type { ChannelMetadata, WellKnownChannel, ChannelStorageRecord } from './types';

/**
 * Configuration for ChannelRegistryManager.
 */
export interface ChannelRegistryManagerConfig {
    /** Backend for DynamoDB operations */
    backend:     ChannelRegistryBackend
    /** Home guild ID for proactive sessions */
    homeGuildId: GuildId
    /** Discord client for fetching channel info from Discord API */
    client:      Client
}

/**
 * Channel registry manager with in-memory caching.
 * Provides fast channel lookups and filtering logic for message processing.
 *
 * Cache strategy:
 * - warmCache(): Load all channels from DynamoDB on startup
 * - Cache-first reads: Check cache before DynamoDB
 * - Write-through: Update both cache and DynamoDB
 */
export class ChannelRegistryManager {
    // In-memory caches
    private readonly channelCache:   Map<ChannelId, ChannelMetadata>;
    private readonly wellKnownCache: Map<WellKnownChannel, ChannelId>; // wellKnownType → channelId

    private readonly backend:     ChannelRegistryBackend;
    private readonly homeGuildId: GuildId;
    private readonly client:      Client;
    private cacheWarmed           = false;

    constructor(config: ChannelRegistryManagerConfig) {
        this.backend = config.backend;
        this.homeGuildId = config.homeGuildId;
        this.client = config.client;

        // Initialize caches
        this.channelCache = new Map();
        this.wellKnownCache = new Map();
    }

    /**
     * Load all channels from DynamoDB into cache.
     * Fetches both home guild channels and DM channels in parallel.
     * Fetches channel info from Discord API for each stored record.
     * Should be called on startup for optimal performance.
     */
    async warmCache(): Promise<void> {
        const dmGuildId = createGuildId('DM');
        const [guildRecords, dmRecords] = await Promise.all([
            this.backend.getChannelsByGuild(this.homeGuildId),
            this.backend.getChannelsByGuild(dmGuildId),
        ]);

        for(const record of [...guildRecords, ...dmRecords]) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
            await this.fetchAndCacheChannel(record);
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
        this.wellKnownCache.clear();
        this.cacheWarmed = false;
    }

    /**
     * Get a channel by ID.
     * Cache-first with backend fallback.
     * Fetches channel info from Discord API and merges with stored data.
     */
    async getChannel(channelId: ChannelId): Promise<ChannelMetadata | null> {
        // Check cache first
        const cached = this.channelCache.get(channelId);
        if(cached) {
            return cached;
        }

        // Fallback to backend for stored data (mute/well-known)
        const storedRecord = await this.backend.getChannel(channelId);
        if(!storedRecord) {
            return null;
        }

        // Fetch channel info from Discord API
        try {
            const discordChannel = await this.fetchDiscordChannel(channelId);
            if(!discordChannel) {
                // Channel was deleted on Discord
                // Stryker disable next-line all: Logging for observability
                logger.warn({ channelId, msg: 'Channel not found on Discord (possibly deleted)' });
                return null;
            }

            // Merge Discord API data with stored data
            const metadata = this.buildChannelMetadata(storedRecord, discordChannel);

            this.addToCache(metadata);
            return metadata;
        } catch (error) {
            // Discord API failure - channel might be deleted or inaccessible
            const errorMsg = error instanceof Error ? error.message : String(error);
            // Stryker disable next-line all: Logging for observability
            logger.warn({ channelId, error: errorMsg, msg: 'Failed to fetch channel from Discord API' });
            return null;
        }
    }

    /**
     * Upsert a channel (create or update).
     * Write-through to both cache and backend.
     */
    async upsertChannel(metadata: ChannelMetadata): Promise<void> {
        // Remove old cache entry if it exists (to handle well-known changes)
        const existing = this.channelCache.get(metadata.channelId);
        if(existing?.isWellKnown) {
            this.wellKnownCache.delete(existing.isWellKnown);
        }

        // Convert runtime metadata to storage record (strip Discord API fields)
        const storageRecord = {
            channelId:   metadata.channelId,
            guildId:     metadata.guildId,
            isMuted:     metadata.isMuted,
            isWellKnown: metadata.isWellKnown,
            createdAt:   metadata.discoveredAt, // discoveredAt becomes createdAt in storage
            updatedAt:   metadata.updatedAt,
        };

        // Update backend
        await this.backend.upsertChannel(storageRecord);

        // Update cache
        this.addToCache(metadata);
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
     * Fetches channel info from Discord API for uncached channels.
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
        const storedRecords = await this.backend.getChannelsByGuild(guildId);
        const results: ChannelMetadata[] = [];

        // Fetch channel info from Discord for each record
        for(const record of storedRecords) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
            const metadata = await this.fetchAndCacheChannel(record);
            if(metadata) {
                results.push(metadata);
            }
        }

        return results;
    }

    /**
     * Get all unmuted channels.
     * Cache-first with backend fallback.
     * Fetches channel info from Discord API for uncached channels.
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
        const storedRecords = await this.backend.getChannelsByGuild(this.homeGuildId);
        const results: ChannelMetadata[] = [];

        // Fetch channel info from Discord for each record
        for(const record of storedRecords) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
            const metadata = await this.fetchAndCacheChannel(record);
            // Only include unmuted channels
            if(metadata && !metadata.isMuted) {
                results.push(metadata);
            }
        }

        return results;
    }

    /**
     * Get all channels from the cache (both muted and unmuted).
     * @returns Array of all channel metadata in the cache
     */
    getAllChannels(): ChannelMetadata[] {
        return [...this.channelCache.values()];
    }

    /**
     * Get a well-known channel by type.
     * Cache-first with backend fallback.
     * Fetches channel info from Discord API for uncached channels.
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

        // Fallback to backend for stored data
        const storedRecord = await this.backend.getWellKnownChannel(type);
        if(!storedRecord) {
            return null;
        }

        // Fetch channel info from Discord API
        try {
            const discordChannel = await this.fetchDiscordChannel(storedRecord.channelId);
            if(!discordChannel) {
                // Channel was deleted on Discord
                // Stryker disable next-line all: Logging for observability
                logger.warn({ channelId: storedRecord.channelId, wellKnownType: type, msg: 'Well-known channel not found on Discord (possibly deleted)' });
                return null;
            }

            // Merge Discord API data with stored data
            const metadata = this.buildChannelMetadata(storedRecord, discordChannel);

            this.addToCache(metadata);
            return metadata;
        } catch (error) {
            // Discord API failure - channel might be deleted or inaccessible
            const errorMsg = error instanceof Error ? error.message : String(error);
            // Stryker disable next-line all: Logging for observability
            logger.warn({ channelId: storedRecord.channelId, wellKnownType: type, error: errorMsg, msg: 'Failed to fetch well-known channel from Discord API' });
            return null;
        }
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
     * Mute a channel.
     * Updates both cache and backend.
     * If backend update fails, cache is invalidated to prevent inconsistency.
     */
    async muteChannel(channelId: ChannelId): Promise<void> {
        try {
            // Update backend
            await this.backend.muteChannel(channelId);

            // Update cache only on success
            const channel = this.channelCache.get(channelId);
            if(channel) {
                // Intentional mutation - mute state is global and should propagate immediately to all references.
                channel.isMuted = true;
                channel.updatedAt = new Date().toISOString();
            }
        } catch (error) {
            // Invalidate cache to prevent stale data
            this.invalidateCache(channelId);
            // Re-throw to inform caller of failure
            throw error;
        }
    }

    /**
     * Unmute a channel.
     * Updates both cache and backend.
     * If backend update fails, cache is invalidated to prevent inconsistency.
     */
    async unmuteChannel(channelId: ChannelId): Promise<void> {
        try {
            // Update backend
            await this.backend.unmuteChannel(channelId);

            // Update cache only on success
            const channel = this.channelCache.get(channelId);
            if(channel) {
                // Intentional mutation - mute state is global and should propagate immediately to all references.
                channel.isMuted = false;
                channel.updatedAt = new Date().toISOString();
            }
        } catch (error) {
            // Invalidate cache to prevent stale data
            this.invalidateCache(channelId);
            // Re-throw to inform caller of failure
            throw error;
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
     * Remove well-known designation from a channel (admin operation).
     * Updates both cache and backend.
     * If backend update fails, cache is invalidated to prevent inconsistency.
     */
    async unmarkAsWellKnown(channelId: ChannelId): Promise<void> {
        try {
            // Update backend
            await this.backend.unmarkAsWellKnown(channelId);

            // Update cache only on success
            const channel = this.channelCache.get(channelId);
            if(channel) {
                // Remove from well-known cache if it was well-known
                if(channel.isWellKnown) {
                    this.wellKnownCache.delete(channel.isWellKnown);
                }
                // Remove well-known designation
                channel.isWellKnown = undefined;
                channel.updatedAt = new Date().toISOString();
            }
        } catch (error) {
            // Invalidate cache to prevent stale data
            this.invalidateCache(channelId);
            // Re-throw to inform caller of failure
            throw error;
        }
    }

    /**
     * Get the home guild ID.
     */
    get homeGuild(): GuildId {
        return this.homeGuildId;
    }

    /**
     * Build ChannelMetadata from storage record and Discord channel data.
     * Private helper method to reduce duplication across methods.
     */
    private buildChannelMetadata(
        record: ChannelStorageRecord,
        discordChannel: Channel
    ): ChannelMetadata {
        let channelName: string;

        // For DM channels, format as @username
        if(record.guildId === 'DM') {
            // Try to get username from Discord DMChannel recipient
            if('recipient' in discordChannel && discordChannel.recipient) {
                channelName = `@${discordChannel.recipient.username}`;
            } else if('name' in discordChannel && discordChannel.name) {
                // Fallback: if already in "DM - username" format, convert to @username
                if(discordChannel.name.startsWith('DM - ')) {
                    channelName = `@${discordChannel.name.slice(5)}`;
                } else if(discordChannel.name.startsWith('@')) {
                    // Already in @username format
                    channelName = discordChannel.name;
                } else {
                    channelName = `@${discordChannel.name}`;
                }
            } else {
                channelName = '@Unknown';
            }
        } else {
            // Regular channels - use existing logic
            channelName = ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown';
        }

        return {
            channelId:    record.channelId,
            guildId:      record.guildId,
            channelName,
            isMuted:      record.isMuted,
            isWellKnown:  record.isWellKnown,
            discoveredAt: record.createdAt,
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    record.updatedAt,
        };
    }

    /**
     * Add a channel to all caches.
     * Private helper method for cache management.
     */
    private addToCache(channel: ChannelMetadata): void {
        // Add to channel cache
        this.channelCache.set(channel.channelId, channel);

        // Track well-known channels
        if(channel.isWellKnown) {
            this.wellKnownCache.set(channel.isWellKnown, channel.channelId);
        }
    }

    /**
     * Fetches a Discord channel by ID.
     * Checks cache first, then fetches from Discord API if not cached.
     * @param channelId - The channel ID to fetch
     * @returns The Discord channel or null if not found
     */
    private async fetchDiscordChannel(channelId: ChannelId): Promise<Channel | null> {
        return this.client.channels.cache.get(channelId)
          ?? await this.client.channels.fetch(channelId);
    }

    /**
     * Fetch Discord channel data and cache it.
     * Returns null if channel is not found or inaccessible.
     * Logs warnings for skipped channels.
     */
    private async fetchAndCacheChannel(record: ChannelStorageRecord): Promise<ChannelMetadata | null> {
        try {
            const discordChannel = await this.fetchDiscordChannel(record.channelId);
            if(!discordChannel) {
                // Stryker disable next-line all: Logging for observability
                logger.warn({ channelId: record.channelId, msg: 'Skipping channel: not found on Discord (possibly deleted)' });
                return null;
            }

            const metadata = this.buildChannelMetadata(record, discordChannel);
            this.addToCache(metadata);
            return metadata;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            // Stryker disable next-line all: Logging for observability
            logger.warn({ channelId: record.channelId, error: errorMsg, msg: 'Skipping channel: Discord API error' });
            return null;
        }
    }
}
