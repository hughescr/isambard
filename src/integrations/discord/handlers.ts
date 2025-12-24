import type { Client, Message } from 'discord.js';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
import { createGuildId, createChannelId, createUserId } from './types';

/**
 * Creates a handler for the Discord 'ready' event.
 *
 * The handler logs when the bot successfully connects to Discord.
 *
 * @returns Event handler function for the 'ready' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('ready', createReadyHandler());
 * ```
 */
export function createReadyHandler(): (client: Client) => void {
    return (client: Client) => {
        if(client.user) {
            // eslint-disable-next-line no-console -- Bot startup logging
            console.log(`Discord bot ready: Logged in as ${client.user.tag}`);
        } else {
            // eslint-disable-next-line no-console -- Bot startup logging
            console.log('Discord bot ready: Logged in (user not available)');
        }
    };
}

/**
 * Creates a handler for the Discord 'error' event.
 *
 * The handler logs Discord client errors for debugging and monitoring.
 *
 * @returns Event handler function for the 'error' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('error', createErrorHandler());
 * ```
 */
export function createErrorHandler(): (error: Error) => void {
    return (error: Error) => {
        // eslint-disable-next-line no-console -- Error logging
        console.error(`Discord client error: ${error.message}`, error);
    };
}

/**
 * Options for configuring the message handler.
 */
export interface MessageHandlerOptions {
    /**
     * List of channel IDs to monitor for messages.
     * Messages in these channels will trigger the onMessage callback.
     */
    monitoredChannelIds: ChannelId[]

    /**
     * The bot's user ID (used to detect @mentions and ignore own messages).
     */
    botUserId: UserId

    /**
     * Callback function invoked when a relevant message is received.
     * Should return a string to reply, or null to not reply.
     */
    onMessage: (context: DiscordMessageContext) => Promise<string | null>
}

/**
 * Creates a handler for the Discord 'messageCreate' event.
 *
 * The handler processes messages based on the following rules:
 * - Ignores all bot messages (including its own)
 * - Responds to:
 *   1. Direct messages (DMs)
 *   2. Messages that @mention the bot
 *   3. Messages in monitored channels
 *
 * When a message matches these criteria:
 * 1. Converts the Discord.js Message to DiscordMessageContext
 * 2. Calls the onMessage callback with the context
 * 3. If callback returns a non-null string, replies to the message
 *
 * Errors in the callback or reply are logged but do not crash the handler.
 *
 * @param options - Configuration for the message handler
 * @returns Event handler function for the 'messageCreate' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('messageCreate', createMessageHandler({
 *   monitoredChannelIds: [channelId1, channelId2],
 *   botUserId: myBotUserId,
 *   onMessage: async (context) => {
 *     // Process message and optionally return a reply
 *     return `You said: ${context.content}`;
 *   }
 * }));
 * ```
 */
export function createMessageHandler(options: MessageHandlerOptions): (message: Message) => Promise<void> {
    const { monitoredChannelIds, botUserId, onMessage } = options;

    return async (message: Message) => {
        // Ignore bot messages
        if(message.author.bot) {
            return;
        }

        // Ignore messages from the bot itself
        if(message.author.id === botUserId) {
            return;
        }

        // Determine if we should respond to this message
        const isDM = !message.guild; // DM channels have no guild
        const isMention = message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
        const isMonitoredChannel = monitoredChannelIds.includes(message.channel.id as ChannelId);

        const shouldRespond = isDM || isMention || isMonitoredChannel;

        if(!shouldRespond) {
            return;
        }

        // Convert Discord.js Message to DiscordMessageContext
        const context: DiscordMessageContext = {
            guildId:   createGuildId(message.guild?.id ?? 'DM'),
            channelId: createChannelId(message.channel.id),
            userId:    createUserId(message.author.id),
            messageId: message.id,
            content:   message.content,
            timestamp: message.createdAt.toISOString(),
        };

        try {
            // Call the onMessage callback
            const reply = await onMessage(context);

            // Reply if callback returned a string
            if(reply !== null) {
                try {
                    await message.reply(reply);
                } catch (replyError) {
                    // eslint-disable-next-line lodash/prefer-lodash-typecheck -- Error type guard
                    const errorMessage = replyError instanceof Error ? replyError.message : String(replyError);
                    // eslint-disable-next-line no-console -- Error logging
                    console.error(`Failed to reply to message ${message.id}: ${errorMessage}`, replyError);
                }
            }
        } catch (error) {
            // eslint-disable-next-line lodash/prefer-lodash-typecheck -- Error type guard
            const errorMessage = error instanceof Error ? error.message : String(error);
            // eslint-disable-next-line no-console -- Error logging
            console.error(`Error processing message ${message.id}: ${errorMessage}`, error);
        }
    };
}
