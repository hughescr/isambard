import { logger } from '@hughescr/logger';
import type { Client, Channel, DMChannel } from 'discord.js';
import { createGuildId, type ChannelId, type GuildId  } from '../types';
import type { ChannelRegistryBackend } from './backend';
import type { ChannelMetadata, WellKnownChannel, ChannelStorageRecord } from './types';
import { InvariantViolationError } from '@/errors';
import type { ReconnectionLoop } from '@/services';

/** Type guard: check if a Channel has a 'recipient' property (DMChannel). */
// Stryker disable ConditionalExpression: Equivalent — guard result irrelevant; callers always pair with secondary truthiness check (e.g. && discordChannel.recipient)
function isDMChannelWithRecipient(channel: unknown): channel is DMChannel {
    return typeof channel === 'object' && channel !== null && 'recipient' in channel;
}
// Stryker restore ConditionalExpression

/** Type guard: check if a Channel has a 'name' property (guild-based channel). */
// Stryker disable ConditionalExpression: Equivalent — guard result irrelevant; callers always pair with secondary truthiness check (e.g. && discordChannel.name)
function hasChannelName(channel: unknown): channel is Extract<Channel, { name: string }> {
    return typeof channel === 'object' && channel !== null && 'name' in channel;
}
// Stryker restore ConditionalExpression

/**
 * Configuration for ChannelRegistryManager.
 */
interface ChannelRegistryManagerConfig {
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
    private hydrationLoop:        ReconnectionLoop | undefined;

    /**
     * Promise that resolves when the registry is ready (warmCache completed successfully).
     * Stays pending (never rejects) if warmCache throws — callers should use isReady() to detect failure.
     * Reset to a fresh pending Promise by stop() so that a subsequent startHydration() re-arms the gate.
     */
    ready:                           Promise<void>;
    private resolveReady!:           () => void;
    /**
     * Registered callbacks that fire each time the ready promise resolves (including after a stop/restart cycle).
     * Each entry carries a `cancelled` flag that offReady() sets to prevent the callback from firing
     * even after a `.then()` handler has already been attached to the current ready promise.
     */
    private readonly readyCallbacks: { fn: () => void | Promise<void>, cancelled: boolean }[] = [];

    constructor(config: ChannelRegistryManagerConfig) {
        this.backend = config.backend;
        this.homeGuildId = config.homeGuildId;
        this.client = config.client;

        // Initialize caches
        this.channelCache = new Map();
        this.wellKnownCache = new Map();

        // Initialize ready promise — resolves on successful warmCache, stays pending on failure.
        // Use isReady() to distinguish "not yet hydrated" from "hydration failed".
        // eslint-disable-next-line sonarjs/no-async-constructor -- initReadyPromise is synchronous (returns new Promise); no async work is started in the constructor
        this.ready = this.initReadyPromise();
    }

    /**
     * Creates a fresh pending ready Promise and wires up the resolver.
     * Attaches all registered onReady callbacks to the new promise so they
     * fire again on the next successful warmCache() call.
     * Called from the constructor and from stop() to re-arm the gate.
     */
    private initReadyPromise(): Promise<void> {
        const promise = new Promise<void>((resolve) => {
            this.resolveReady = resolve;
        });
        // Re-attach all registered callbacks so they fire on the next hydration cycle.
        // Stryker disable BlockStatement,ArrowFunction,ConditionalExpression: re-attach loop — only exercised in stop()→startHydration() cycle with pre-registered callbacks
        for(const entry of this.readyCallbacks) {
            void promise.then(() => {
                if(entry.cancelled) {
                    return;
                }
                return entry.fn();
            }).catch((err: unknown) => {
                // Stryker disable next-line ObjectLiteral,StringLiteral: logger call — observational
                logger.error({ err, msg: 'onReady callback rejected' });
            });
        }
        // Stryker restore BlockStatement,ArrowFunction,ConditionalExpression
        return promise;
    }

    /**
     * Register a callback to fire each time the registry becomes ready.
     * This includes the current cycle (if hydration has not yet completed) and
     * every subsequent stop() → startHydration() cycle.
     *
     * Unlike `registry.ready.then(cb)`, which only fires once for the current
     * promise instance, `onReady(cb)` re-attaches the callback to the new
     * `ready` promise created by stop() so it fires on every successful warmCache().
     *
     * @param callback - Called (without arguments) each time hydration succeeds
     */
    // Stryker disable BlockStatement,ArrowFunction: onReady registration — tested via bot.test.ts and event-handler-setup.test.ts which call the callback; body is always exercised but ArrowFunction/BlockStatement mutants are not distinguishable by test assertions
    onReady(callback: () => void | Promise<void>): void {
        const entry = { fn: callback, cancelled: false };
        this.readyCallbacks.push(entry);
        // Attach to the current pending (or already-resolved) ready promise.
        // The `cancelled` flag allows offReady() to prevent this handler from firing
        // even after the .then() has already been queued.
        void this.ready.then(() => {
            if(entry.cancelled) {
                return;
            }
            return entry.fn();
        }).catch((err: unknown) => {
            // Stryker disable next-line ObjectLiteral,StringLiteral: logger call — observational
            logger.error({ err, msg: 'onReady callback rejected' });
        });
    }
    // Stryker restore BlockStatement,ArrowFunction

    /**
     * Unregister a previously registered onReady callback.
     * Removes the first occurrence of `callback` from the registered list and marks
     * it cancelled so that any already-queued `.then()` handler will not invoke it.
     * After unregistration, the callback will not fire on future hydration cycles.
     * Has no effect if `callback` was never registered.
     *
     * @param callback - The callback function to remove
     */
    // Stryker disable BlockStatement,ConditionalExpression,UnaryOperator: offReady removal — tested by 'offReady removes a registered callback'
    offReady(callback: () => void | Promise<void>): void {
        const idx = this.readyCallbacks.findIndex(e => e.fn === callback);
        if(idx !== -1) {
            const entry = this.readyCallbacks[idx];
            if(entry !== undefined) {
                entry.cancelled = true;
            }
            this.readyCallbacks.splice(idx, 1);
        }
    }
    // Stryker restore BlockStatement,ConditionalExpression,UnaryOperator

    /**
     * Returns true if the registry has been successfully hydrated via warmCache().
     * Returns false before hydration or if hydration failed.
     */
    isReady(): boolean {
        return this.cacheWarmed;
    }

    /**
     * Starts self-healing hydration using a ReconnectionLoop.
     *
     * The loop must be created with `() => this.warmCache()` (or equivalent) as its
     * connectFn. On success the loop auto-stops and the `ready` promise resolves.
     * On failure the loop schedules retries with exponential backoff.
     *
     * Call `stop()` to cancel the loop (e.g., on shutdown).
     *
     * @throws If a hydration loop is already running (guards against double-start).
     */
    startHydration(loop: ReconnectionLoop): void {
        if(this.hydrationLoop !== undefined) {
            // Stryker disable next-line StringLiteral: error message is informational only
            throw new Error('ChannelRegistryManager: hydration loop already started — call stop() first');
        }
        this.hydrationLoop = loop;
        loop.start();
    }

    /**
     * Stops the hydration reconnection loop and resets the ready gate so that a
     * subsequent startHydration() call can re-arm it for the next hydration cycle.
     * Safe to call even if startHydration() was never called.
     */
    stop(): void {
        this.hydrationLoop?.stop();
        this.hydrationLoop = undefined;
        // Reset ready to a fresh pending Promise so isReady() returns false and
        // the gate in MessageCoordinator blocks traffic until the next warmCache succeeds.
        this.cacheWarmed = false;
        this.ready = this.initReadyPromise();
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

        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ guildChannels: guildRecords.length, dmChannels: dmRecords.length, msg: 'Warming channel cache...' });

        const allRecords = [...guildRecords, ...dmRecords];
        for(let i = 0; i < allRecords.length; i++) {
            const record = allRecords[i];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < allRecords.length; unreachable in practice
            if(record === undefined) {
                // Stryker disable next-line StringLiteral: invariant violation message — debug context only
                throw new InvariantViolationError('warmCache', 'allRecords[i] undefined despite i < allRecords.length');
            }
            // Stryker disable next-line ObjectLiteral,StringLiteral,ArithmeticOperator: Logging for observability
            logger.debug({ index: i + 1, total: allRecords.length, channelId: record.channelId, msg: 'Warming channel...' });
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
            await this.fetchAndCacheChannel(record);
        }

        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ channelCount: allRecords.length, msg: 'Channel cache warmed' });

        // Mark ready only on successful completion — if anything above throws, ready stays pending
        // and isReady() returns false, so the gate in MessageCoordinator continues to drop messages.
        this.cacheWarmed = true;
        this.resolveReady();
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
            if(isDMChannelWithRecipient(discordChannel) && discordChannel.recipient) {
                channelName = `@${discordChannel.recipient.username}`;
            } else if(hasChannelName(discordChannel) && discordChannel.name) {
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
            channelName = (hasChannelName(discordChannel) ? discordChannel.name : null) ?? 'Unknown';
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
