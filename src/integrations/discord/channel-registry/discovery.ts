import type { Client, Guild, GuildChannel } from 'discord.js';
import type { ChannelRegistryManager } from './manager';
import type { ChannelMetadata } from './types';
import { createChannelId, createGuildId } from '../types';

export interface DiscoveryResult {
    /** Number of channels discovered */
    discovered: number
    /** Number of channels skipped (already in registry) */
    skipped:    number
    /** Errors encountered during discovery */
    errors:     { guildId: string, error: string }[]
}

/**
 * Discovers all channels from a Discord client and populates the registry.
 */
export async function discoverAllChannels(
    client: Client,
    manager: ChannelRegistryManager
): Promise<DiscoveryResult> {
    const result: DiscoveryResult = {
        discovered: 0,
        skipped:    0,
        errors:     [],
    };

    // Iterate through all guilds the bot is in
    for(const [guildId, guild] of client.guilds.cache) {
        try {
            const guildResult = await discoverGuildChannels(guild, manager);
            result.discovered += guildResult.discovered;
            result.skipped += guildResult.skipped;
        } catch (error: unknown) {
            result.errors.push({
                guildId,
                error: (error as Error).message ?? String(error),
            });
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
): Promise<{ discovered: number, skipped: number }> {
    let discovered = 0;
    let skipped = 0;

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
            skipped++;
            continue;
        }

        // Create metadata and upsert
        const metadata = createChannelMetadata(channel, guild);
        await manager.upsertChannel(metadata);
        discovered++;
    }

    return { discovered, skipped };
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
