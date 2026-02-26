import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { DiscordConfig } from '@/config';

/**
 * Creates a Discord client with the required intents for message processing.
 *
 * The client is configured but NOT logged in. The caller is responsible for
 * calling client.login(config.botToken) when ready to connect.
 *
 * Required intents:
 * - Guilds: Access to guild information
 * - GuildMessages: Receive message events in guilds
 * - MessageContent: Access to message content (privileged intent)
 * - DirectMessages: Receive message events in DMs
 * - GuildMessageReactions: Receive reaction events in guilds
 * - DirectMessageReactions: Receive reaction events in DMs
 * - GuildPresences: Access to user presence information (privileged intent)
 *
 * Required partials:
 * - Channel: Required for DM events in discord.js v14, since DM channels
 *   are not cached by default and would otherwise be unavailable
 *
 * @param _config - Discord configuration including bot token and monitored channels
 * @returns Configured Discord Client (not logged in)
 */
export function createDiscordClient(_config: DiscordConfig): Client {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.DirectMessageReactions,
            GatewayIntentBits.GuildPresences,
        ],
        partials: [Partials.Channel],
    });
}
