import type { Client, Guild, GuildChannel } from 'discord.js';
import _ from 'lodash';
import { createChannelId, createGuildId } from '../types';
import type { ChannelRegistryManager } from './manager';
import type { ChannelMetadata } from './types';

// Note: We only discover channels, not threads. Threads inherit mute state from their parent channel.

export interface DiscoveryResult {
    /** Number of channels discovered (newly added) */
    discovered: number
    /** Number of channels updated (metadata refreshed) */
    updated:    number
    /** Errors encountered during discovery */
    errors:     { guildId: string, error: string }[]
}

/**
 * Discovers all channels from a Discord client and populates the registry.
 * Processes guilds in parallel for better performance.
 */
export async function discoverAllChannels(
    client: Client,
    manager: ChannelRegistryManager
): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
        discovered: 0,
        updated:    0,
        errors:     [],
    };

    // Create promises for discovering channels in each guild (parallel execution)
    const guildPromises = _.map(
        [...client.guilds.cache.entries()],
        async ([guildId, guild]) => {
            try {
                const guildResult = await discoverGuildChannels(guild, manager);
                return {
                    discovered: guildResult.discovered,
                    updated:    guildResult.updated,
                    guildId,
                };
            } catch (error: unknown) {
                // Log error but don't fail the whole discovery
                return {
                    discovered: 0,
                    updated:    0,
                    guildId,
                    error:      _.isError(error) ? error.message : String(error),
                };
            }
        }
    );

    // Execute all guild discoveries in parallel
    const results = await Promise.allSettled(guildPromises);

    // Aggregate results
    for(const settledResult of results) {
        // All promises are fulfilled because try-catch in async callback handles all errors
        if(settledResult.status === 'fulfilled') {
            const value = settledResult.value;
            result.discovered += value.discovered;
            result.updated += value.updated;
            if(value.error) {
                result.errors.push({
                    guildId: value.guildId,
                    error:   value.error,
                });
            }
        }
    }

    return result;
}

/**
 * Discovers all channels in a single guild.
 */
async function discoverGuildChannels(
    guild: Guild,
    manager: ChannelRegistryManager
): Promise<{ discovered: number, updated: number }> {
    let discovered = 0;
    let updated = 0;

    // Fetch all channels (ensures cache is populated)
    const channels = await guild.channels.fetch();

    for(const [channelId, channel] of channels) {
        if(!channel) {
            continue;
        }

        // Skip categories and non-text channels
        if(!isTextBasedChannel(channel)) {
            continue;
        }

        // Check if already in registry
        const existing = await manager.getChannel(createChannelId(channelId));
        if(existing) {
            // Update existing channel: merge Discord metadata while preserving user settings
            const now = new Date().toISOString();
            const updatedMetadata: ChannelMetadata = {
                ...existing,
                channelName: channel.name,      // Update from Discord (may have been renamed)
                lastSeenAt:  now,                // Update last seen timestamp
                updatedAt:   now,                // Update modification timestamp
                // Preserve user settings: isMuted, isWellKnown, discoveredAt
            };
            await manager.upsertChannel(updatedMetadata);
            updated++;
            continue;
        }

        // Create metadata and upsert
        const metadata = createChannelMetadata(channel, guild);
        await manager.upsertChannel(metadata);
        discovered++;
    }

    return { discovered, updated };
}

/**
 * Checks if a channel is text-based (can receive messages).
 */
function isTextBasedChannel(channel: GuildChannel): boolean {
    // TextChannel, NewsChannel, ThreadChannel, VoiceChannel (has text), etc.
    return 'send' in channel;
}

/**
 * Creates channel metadata from a Discord channel.
 */
function createChannelMetadata(channel: GuildChannel, guild: Guild): ChannelMetadata {
    const now = new Date().toISOString();

    return {
        channelId:    createChannelId(channel.id),
        guildId:      createGuildId(guild.id),
        channelName:  channel.name,
        isMuted:      false,  // Default: unmuted
        discoveredAt: now,
        lastSeenAt:   now,
        updatedAt:    now,
    };
}

/**
 * Sets up event handlers for channel create/update/delete.
 * Call this once on bot startup to keep registry in sync.
 */
export function setupChannelEventHandlers(
    client: Client,
    manager: ChannelRegistryManager
): void {
    // Channel created
    client.on('channelCreate', (channel) => {
        if(!('guild' in channel) || !channel.guild) {
            return;
        }
        if(!isTextBasedChannel(channel as GuildChannel)) {
            return;
        }

        const metadata = createChannelMetadata(channel as GuildChannel, channel.guild);
        void manager.upsertChannel(metadata);
    });

    // Channel updated (name change, etc.)
    client.on('channelUpdate', (_oldChannel, newChannel) => {
        if(!('guild' in newChannel) || !newChannel.guild) {
            return;
        }
        if(!isTextBasedChannel(newChannel as GuildChannel)) {
            return;
        }

        const channelId = createChannelId(newChannel.id);
        void manager.getChannel(channelId).then((existing) => {
            if(existing) {
                // Update name if changed
                return manager.upsertChannel({
                    ...existing,
                    channelName: (newChannel as GuildChannel).name,
                    updatedAt:   new Date().toISOString(),
                });
            }
            return undefined;
        });
    });

    // Channel deleted
    client.on('channelDelete', (channel) => {
        if(!('id' in channel)) {
            return;
        }

        const channelId = createChannelId(channel.id);
        void manager.deleteChannel(channelId);
    });
}
