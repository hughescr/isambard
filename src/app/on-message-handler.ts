import _ from 'lodash';
import type { Client } from 'discord.js';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry';
import type { DiscordMessageContext } from '@/integrations/discord/types';
import type { ClaudeAgent } from '@/agent/agent';

/**
 * Options for creating the onMessage handler.
 */
export interface OnMessageHandlerOptions {
    /** Claude agent for processing messages */
    agent:            ClaudeAgent
    /** Channel registry for looking up unmuted channels */
    channelRegistry?: ChannelRegistryManager
    /** Discord client for resolving guild names */
    discordClient?:   Client
}

/**
 * Creates the onMessage callback for the Discord bot.
 *
 * The handler:
 * 1. Fetches unmuted channels from the channel registry (if available)
 * 2. Formats channel names with guild names and well-known type annotations
 * 3. Passes the message context to the Claude agent with the channel list
 *
 * @param options - Handler dependencies
 * @returns Async callback matching the DiscordBot onMessage signature
 */
export function createOnMessageHandler(options: OnMessageHandlerOptions): (context: DiscordMessageContext) => Promise<string | null> {
    const { agent, channelRegistry, discordClient } = options;

    return async (context: DiscordMessageContext): Promise<string | null> => {
        // Build channelList if channelRegistry is available
        let channelList: string[] | undefined;
        if(channelRegistry) {
            const unmutedChannels = await channelRegistry.getUnmutedChannels();
            channelList = _.map(unmutedChannels, (channel) => {
                // Get guild name for disambiguation
                let guildName: string | undefined;
                if(channel.guildId !== 'DM') {
                    try {
                        const guild = discordClient?.guilds.cache.get(channel.guildId);
                        guildName = guild?.name;
                    } catch{
                        // Guild not in cache, skip guild name
                    }
                }

                // Format: "channelName (guildName) [well-known: type]" or "channelName [well-known: type]"
                let formatted = channel.channelName;
                if(guildName) {
                    formatted += ` (${guildName})`;
                }
                if(channel.isWellKnown) {
                    formatted += ` [well-known: ${channel.isWellKnown}]`;
                }
                return formatted;
            });
        }

        const result = await agent.handleInput([context], { channelList });
        return result.response;
    };
}
