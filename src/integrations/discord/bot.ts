import type { Client } from 'discord.js';
import { ActivityType } from 'discord.js';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
import type { ClaudeAgent } from '@/agent/agent';
import { createDiscordClient } from './client';
import { createReadyHandler, createErrorHandler, createMessageHandler } from './handlers';
import {
    createActiveStatusGenerator,
    createDynamicStatusGenerator,
    createIdleStatusGenerator,
    createPresenceManager,
    type PresenceManager
} from './presence';

/**
 * Options for configuring the Discord bot.
 */
export interface DiscordBotOptions {
    /**
     * Discord configuration including bot token and monitored channels.
     */
    config: DiscordConfig

    /**
     * Callback function invoked when a relevant message is received.
     * Should return a string to reply, or null to not reply.
     */
    onMessage: (context: DiscordMessageContext) => Promise<string | null>

    /**
     * Optional identity context for personalizing idle status messages.
     * Used for generating creative idle status messages.
     */
    identityContext?: string

    /**
     * Claude agent instance for status middleware integration.
     */
    agent?: ClaudeAgent

    /**
     * Optional pre-created Discord client.
     * If provided, this client will be used instead of creating a new one.
     * Useful when the client needs to be shared with other components.
     */
    client?: Client
}

/**
 * Discord bot interface with lifecycle methods.
 */
export interface DiscordBot {
    /**
     * Starts the bot by logging into Discord.
     * Errors during login propagate to the caller.
     */
    start(): Promise<void>

    /**
     * Stops the bot by destroying the Discord client connection.
     */
    stop(): Promise<void>
}

/**
 * Creates a Discord bot with the specified configuration and message handler.
 *
 * The bot orchestrates the Discord client lifecycle and event handling:
 * 1. Creates a Discord client with required intents
 * 2. Registers error handler for Discord client errors
 * 3. Registers ready handler for logging bot startup
 * 4. Registers ready handler for setting up messageCreate handler
 * 5. Provides start/stop methods for lifecycle management
 *
 * The bot follows the factory function pattern used throughout the Discord integration.
 * Event handlers are registered during bot creation, but the client is not logged in
 * until start() is called.
 *
 * Error handling:
 * - Login errors propagate to the caller (let caller handle authentication failures)
 * - Message processing errors are logged but don't crash the bot
 * - Client errors are logged via the error handler
 *
 * @param options - Bot configuration and message callback
 * @returns Discord bot with start/stop methods
 *
 * @example
 * ```typescript
 * const bot = createDiscordBot({
 *   config: {
 *     botToken: process.env.DISCORD_BOT_TOKEN,
 *     applicationId: process.env.DISCORD_APP_ID,
 *     monitoredChannelIds: ['123456789', '987654321']
 *   },
 *   onMessage: async (context) => {
 *     console.log(`Message from ${context.userId}: ${context.content}`);
 *     return `You said: ${context.content}`;
 *   }
 * });
 *
 * await bot.start();
 * // Bot is now running
 * await bot.stop();
 * ```
 */
export function createDiscordBot(options: DiscordBotOptions): DiscordBot {
    const { config, onMessage, identityContext, agent, client: providedClient } = options;
    const client: Client = providedClient ?? createDiscordClient(config);
    let presenceManager: PresenceManager | undefined;

    // Register error handler for Discord client errors
    client.on('error', createErrorHandler());

    // Register clientReady handler for logging
    client.on('clientReady', createReadyHandler());

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready
    client.on('clientReady', (readyClient: Client): void => {
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        // Create presence manager if optional deps provided
        if(identityContext && config.presence) {
            const activeStatusGenerator = createActiveStatusGenerator({
                activityType: ActivityType.Custom,
                logger,
            });

            const idleStatusGenerator = createIdleStatusGenerator({
                logger,
                activityType: ActivityType.Custom,
                identityContext,
            });

            presenceManager = createPresenceManager({
                discordClient: readyClient,
                config:        config.presence,
                activeStatusGenerator,
                idleStatusGenerator,
                logger,
            });

            presenceManager.start();
        }

        // Create dynamic status generator if identityContext is provided
        const dynamicStatusGenerator = identityContext
            ? createDynamicStatusGenerator({ identityContext })
            : undefined;

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- messageCreate handler is async
        client.on('messageCreate', createMessageHandler({
            monitoredChannelIds: config.monitoredChannelIds as ChannelId[],
            botUserId:           readyClient.user!.id as UserId,
            onMessage,
            presenceManager,
            agent,
            dynamicStatusGenerator,
        }));
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        async stop(): Promise<void> {
            // Stop presence manager if it exists
            if(presenceManager) {
                presenceManager.stop();
            }
            // destroy() is sufficient for cleanup (as per user decision)
            await client.destroy();
        },
    };
}
