import { logger } from '@hughescr/logger';
import type { Client, Guild, GuildChannel } from 'discord.js';
import { createChannelId, createGuildId } from '../types';
import type { ChannelRegistryManager } from './manager';
import type { ChannelMetadata } from './types';

// Note: We only discover channels, not threads. Threads inherit mute state from their parent channel.

/**
 * Tracks which Discord clients have already had channel event handlers registered.
 * Used by setupChannelEventHandlers() to guarantee idempotency — calling the
 * function a second time with the same client is a no-op.
 *
 * NOTE: Module-level singleton. Assumes one Client instance per process lifetime.
 * If the Client is ever reconstructed (e.g., token refresh), setupChannelEventHandlers
 * on the new client will correctly register; setup on the OLD client (now GC'd) will
 * not silently no-op because WeakSet entries are GC'd with the client. The risk is only
 * if a *different* Client object is reused for the same logical role — currently unsupported.
 */
// Stryker disable next-line ObjectLiteral: WeakSet construction is a module-level singleton — no testable variation
const registeredClients = new WeakSet<Client>();

/** Type guard: check if a channel has a 'guild' property (GuildChannel-like). */
function hasGuild(channel: unknown): channel is GuildChannel {
    return typeof channel === 'object' && channel !== null && 'guild' in channel;
}

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

    const guildCount = client.guilds.cache.size;
    const startMs = Date.now();

    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
    logger.info({ guildCount, msg: 'Discovering channels across guilds...' });

    // Create promises for discovering channels in each guild (parallel execution)
    const guildPromises = [...client.guilds.cache.entries()].map(async ([guildId, guild]) => {
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
                error:      error instanceof Error ? error.message : String(error),
            };
        }
    });

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

    // Stryker disable next-line ObjectLiteral,StringLiteral,ArithmeticOperator: Logging for observability
    logger.info({ discovered: result.discovered, updated: result.updated, elapsedMs: Date.now() - startMs, msg: 'Channel discovery complete' });

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
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API per channel
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
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB write per channel
            await manager.upsertChannel(updatedMetadata);
            updated++;
            continue;
        }

        // Create metadata and upsert
        const metadata = createChannelMetadata(channel, guild);
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited DynamoDB write per channel
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
 * Idempotent: subsequent calls with the same client instance are no-ops.
 * Safe to call from onReady callbacks that fire on reconnect.
 */
export function setupChannelEventHandlers(
    client: Client,
    manager: ChannelRegistryManager
): void {
    // Stryker disable next-line ConditionalExpression,BlockStatement: idempotency guard — second call must not re-register handlers; tested by 'calling twice registers handlers only once'
    if(registeredClients.has(client)) {
        return;
    }
    registeredClients.add(client);

    // Channel created
    client.on('channelCreate', (channel) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: channel.guild typed non-nullable but DM/unknown channels may lack guild at runtime
        if(!hasGuild(channel) || !channel.guild) {
            return;
        }
        if(!isTextBasedChannel(channel)) {
            return;
        }

        const metadata = createChannelMetadata(channel, channel.guild);
        void manager.upsertChannel(metadata);
    });

    // Channel updated (name change, etc.)
    client.on('channelUpdate', (_oldChannel, newChannel) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: newChannel.guild typed non-nullable but DM/unknown channels may lack guild at runtime
        if(!hasGuild(newChannel) || !newChannel.guild) {
            return;
        }
        if(!isTextBasedChannel(newChannel)) {
            return;
        }

        const channelId = createChannelId(newChannel.id);
        void manager.getChannel(channelId).then(

            (existing) => {
                if(existing) {
                    // Update name if changed
                    return manager.upsertChannel({
                        ...existing,
                        channelName: (newChannel as GuildChannel).name,
                        updatedAt:   new Date().toISOString(),
                    });
                }
                return undefined;
            }
        );
    });

    // Channel deleted
    client.on('channelDelete', (channel) => {
        if(!('id' in (channel as object))) {
            return;
        }

        const channelId = createChannelId(channel.id);
        void manager.deleteChannel(channelId);
    });
}
