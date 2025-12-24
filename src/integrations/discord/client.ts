import { Client, GatewayIntentBits } from 'discord.js';
import type { DiscordConfig } from '@/config/schemas';

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
 *
 * @param config - Discord configuration including bot token and monitored channels
 * @returns Configured Discord Client (not logged in)
 */
export function createDiscordClient(_config: DiscordConfig): Client {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });

    return client;
}
