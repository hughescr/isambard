import type { Client, Message } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
import type { PresenceManager } from './presence';
import type { ClaudeAgent } from '@/agent/agent';
import { createGuildId, createChannelId, createUserId } from './types';
import { createStatusMiddleware } from './presence';

/**
 * Creates a handler for the Discord 'clientReady' event.
 *
 * The handler logs when the bot successfully connects to Discord.
 *
 * @returns Event handler function for the 'clientReady' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * client.on('clientReady', createReadyHandler());
 * ```
 */
export function createReadyHandler(): (client: Client) => void {
    return (client: Client) => {
        if(client.user) {
            logger.info(`Discord bot ready: Logged in as ${client.user.tag}`);
        } else {
            logger.info('Discord bot ready: Logged in (user not available)');
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
        // Use object spread to satisfy logger typing while maintaining structured logging
        logger.error({ error, msg: `Discord client error: ${error.message}` });
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

    /**
     * Optional presence manager for status updates during message processing.
     */
    presenceManager?: PresenceManager

    /**
     * Optional Claude agent for status middleware integration.
     */
    agent?: ClaudeAgent
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
    const { monitoredChannelIds, botUserId, onMessage, presenceManager, agent } = options;

    // Create status middleware if both presenceManager and agent are provided
    const statusMiddleware = presenceManager && agent
        ? createStatusMiddleware({
            presenceManager,
            agent,
            logger,
        })
        : null;

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
            // Use status middleware if available, otherwise call onMessage directly
            // Discord.js channels implement sendTyping() for typing indicator support
            const channel = message.channel as { sendTyping(): Promise<void> };
            const reply = statusMiddleware
                ? await statusMiddleware(context, channel)
                : await onMessage(context);

            // Reply if callback returned a string
            if(reply !== null) {
                try {
                    await message.reply(reply);
                } catch (replyError) {
                    const err = _.isError(replyError) ? replyError : new Error(String(replyError));
                    // Use object spread to satisfy logger typing while maintaining structured logging
                    logger.error({ error: err, messageId: message.id, msg: `Failed to reply to message ${message.id}: ${err.message}` });
                }
            }
        } catch (error) {
            const err = _.isError(error) ? error : new Error(String(error));
            // Use object spread to satisfy logger typing while maintaining structured logging
            logger.error({ error: err, messageId: message.id, msg: `Error processing message ${message.id}: ${err.message}` });
        }
    };
}
