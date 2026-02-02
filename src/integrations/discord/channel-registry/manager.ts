import _ from 'lodash';
import type { Client } from 'discord.js';
import type { ChannelRegistryBackend } from './backend';
import type { ChannelMetadata, WellKnownChannel } from './types';
import type { ChannelId, GuildId } from '../types';

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
     * Fetches channel info from Discord API for each stored record.
     * Should be called on startup for optimal performance.
     */
    async warmCache(): Promise<void> {
        const storedRecords = await this.backend.getAllChannels();

        for(const record of storedRecords) {
            // Stryker disable BlockStatement: Defensive error handling for Discord API failures
            // Fetch channel info from Discord API
            try {
                const discordChannel = await this.client.channels.fetch(record.channelId);
                if(!discordChannel) {
                    // Channel was deleted on Discord, skip it
                    continue;
                }

                // Merge Discord API data with stored data
                const now = new Date().toISOString();
                const metadata: ChannelMetadata = {
                    channelId:    record.channelId,
                    guildId:      record.guildId,
                    // Stryker disable next-line StringLiteral: Defensive fallback for malformed Discord channel objects
                    channelName:  ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown',
                    isMuted:      record.isMuted,
                    isWellKnown:  record.isWellKnown,
                    discoveredAt: record.createdAt,
                    lastSeenAt:   now,
                    updatedAt:    record.updatedAt,
                };

                this.addToCache(metadata);
            } catch{
                // Discord API failure - channel might be deleted or inaccessible
                // Skip this channel and continue
                continue;
            }
            // Stryker restore BlockStatement
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
            const discordChannel = await this.client.channels.fetch(channelId);
            if(!discordChannel) {
                // Channel was deleted on Discord
                return null;
            }

            // Merge Discord API data with stored data
            const now = new Date().toISOString();
            const metadata: ChannelMetadata = {
                channelId:    storedRecord.channelId,
                guildId:      storedRecord.guildId,
                // Stryker disable next-line StringLiteral: Defensive fallback for malformed Discord channel objects
                channelName:  ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown',
                isMuted:      storedRecord.isMuted,
                isWellKnown:  storedRecord.isWellKnown,
                discoveredAt: storedRecord.createdAt,
                lastSeenAt:   now,
                updatedAt:    storedRecord.updatedAt,
            };

            this.addToCache(metadata);
            return metadata;
        } catch{
            // Discord API failure - channel might be deleted or inaccessible
            // Return null rather than crashing
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
            // Stryker disable BlockStatement: Defensive error handling for Discord API failures
            try {
                const discordChannel = await this.client.channels.fetch(record.channelId);
                if(!discordChannel) {
                    // Channel was deleted on Discord, skip it
                    continue;
                }

                // Merge Discord API data with stored data
                const now = new Date().toISOString();
                const metadata: ChannelMetadata = {
                    channelId:    record.channelId,
                    guildId:      record.guildId,
                    // Stryker disable next-line StringLiteral: Defensive fallback for malformed Discord channel objects
                    channelName:  ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown',
                    isMuted:      record.isMuted,
                    isWellKnown:  record.isWellKnown,
                    discoveredAt: record.createdAt,
                    lastSeenAt:   now,
                    updatedAt:    record.updatedAt,
                };

                this.addToCache(metadata);
                results.push(metadata);
            } catch{
                // Discord API failure - skip this channel
                continue;
            }
            // Stryker restore BlockStatement
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
        const storedRecords = await this.backend.getAllChannels();
        const results: ChannelMetadata[] = [];

        // Fetch channel info from Discord for each record
        for(const record of storedRecords) {
            // Stryker disable BlockStatement: Defensive error handling for Discord API failures
            try {
                const discordChannel = await this.client.channels.fetch(record.channelId);
                if(!discordChannel) {
                    // Channel was deleted on Discord, skip it
                    continue;
                }

                // Merge Discord API data with stored data
                const now = new Date().toISOString();
                const metadata: ChannelMetadata = {
                    channelId:    record.channelId,
                    guildId:      record.guildId,
                    // Stryker disable next-line StringLiteral: Defensive fallback for malformed Discord channel objects
                    channelName:  ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown',
                    isMuted:      record.isMuted,
                    isWellKnown:  record.isWellKnown,
                    discoveredAt: record.createdAt,
                    lastSeenAt:   now,
                    updatedAt:    record.updatedAt,
                };

                this.addToCache(metadata);

                // Only include unmuted channels
                if(!metadata.isMuted) {
                    results.push(metadata);
                }
            } catch{
                // Discord API failure - skip this channel
                continue;
            }
            // Stryker restore BlockStatement
        }

        return results;
    }

    /**
     * Get all channels from the cache (both muted and unmuted).
     * @returns Array of all channel metadata in the cache
     */
    getAllChannels(): ChannelMetadata[] {
        return Array.from(this.channelCache.values());
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
            const discordChannel = await this.client.channels.fetch(storedRecord.channelId);
            if(!discordChannel) {
                // Channel was deleted on Discord
                return null;
            }

            // Merge Discord API data with stored data
            const now = new Date().toISOString();
            const metadata: ChannelMetadata = {
                channelId:    storedRecord.channelId,
                guildId:      storedRecord.guildId,
                // Stryker disable next-line StringLiteral: Defensive fallback for malformed Discord channel objects
                channelName:  ('name' in discordChannel ? discordChannel.name : null) ?? 'Unknown',
                isMuted:      storedRecord.isMuted,
                isWellKnown:  storedRecord.isWellKnown,
                discoveredAt: storedRecord.createdAt,
                lastSeenAt:   now,
                updatedAt:    storedRecord.updatedAt,
            };

            this.addToCache(metadata);
            return metadata;
        } catch{
            // Discord API failure - channel might be deleted or inaccessible
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

        // Track well-known channels
        if(channel.isWellKnown) {
            this.wellKnownCache.set(channel.isWellKnown, channel.channelId);
        }
    }
}
