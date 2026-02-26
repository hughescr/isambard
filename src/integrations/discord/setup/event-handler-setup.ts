import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import _ from 'lodash';
import type { CatchUpSessionRunner } from '../catchup';
import {
    type ChannelRegistryManager,
    discoverAllChannels,
    setupChannelEventHandlers,
    type DMTracker,
    type ResponseRouter
} from '../channel-registry';
import { createMessageHandler } from '../handlers';
import type { InboxManager } from '../inbox';
import type { MessageCoordinator } from '../message-coordinator';
import type { DiscordRateLimiter } from '../rate-limiter';
import type { BotStateManager } from '../state';
import { createUserId, createChannelId, createGuildId } from '../types';
import { type AnswerClassifier, type QuestionRegistry, type PerchSessionRunner  } from '@/agent';
import { safeAsyncHandler } from '@/utils';

/**
 * Initializes the channel registry by warming cache, discovering channels, and setting up event handlers.
 *
 * @param client - Discord client (must be ready)
 * @param channelRegistry - Channel registry manager
 * @param responseRouter - Response router for sending notifications
 * @param rateLimiter - Rate limiter for Discord API calls (optional, created after this function)
 * @returns Promise that resolves when initialization is complete
 */
export async function initializeChannelRegistry(
    client: Client,
    channelRegistry: ChannelRegistryManager,
    responseRouter: ResponseRouter,
    rateLimiter?: DiscordRateLimiter
): Promise<void> {
    try {
        // Warm cache from DynamoDB
        await channelRegistry.warmCache();

        // Discover all channels the bot can see
        const discoveryResult = await discoverAllChannels(client, channelRegistry);
        // Stryker disable all: Logging for observability
        logger.info({
            discovered: discoveryResult.discovered,
            updated:    discoveryResult.updated,
            errors:     discoveryResult.errors.length,
            msg:        `Channel discovery completed: ${discoveryResult.discovered} new, ${discoveryResult.updated} updated`,
        });
        // Stryker restore all

        // Set up event handlers for channel changes
        setupChannelEventHandlers(client, channelRegistry);
    } catch (error) {
        const errorMsg = _.isError(error) ? error.message : String(error);
        logger.error({
            error: errorMsg,
            msg:   'Failed to initialize channel registry on startup',
        });
        // Continue anyway - handlers will work but channel data may be incomplete (fail-open)

        // Send urgent notification to owner via fallback channel
        if(rateLimiter) {
            try {
                const notificationContent = `⚠️ **Channel Registry Error**: Failed to load channel mute settings. I'm currently responding to ALL channels until this is resolved. Error: ${errorMsg}`;

                // Route to fallback channel for startup errors
                const routing = await responseRouter.routeResponse(
                    'processing_message', // Use processing_message as the session type
                    notificationContent,
                    'synthetic-channel' as import('../types').ChannelId // Will trigger fallback routing
                );

                // Stryker disable next-line all: Defensive guard - routing always has shouldSend=true and targetChannelId set for error notifications
                if(routing.shouldSend && routing.targetChannelId) {
                    // Fetch the target channel and send directly
                    const targetChannel = await client.channels.fetch(routing.targetChannelId);
                    // Stryker disable next-line all: Defensive guard - validated in response-sender.test.ts for normal flow
                    if(targetChannel && 'send' in targetChannel) {
                        await rateLimiter.sendToChannel(targetChannel as import('discord.js').TextChannel, routing.content);
                        // Stryker disable all: Logging for observability
                        logger.info({
                            targetChannelId: routing.targetChannelId,
                            msg:             'Channel registry error notification sent to fallback channel',
                        });
                        // Stryker restore all
                    }
                }
            } catch (notificationError) {
                const notificationErrorMsg = _.isError(notificationError) ? notificationError.message : String(notificationError);
                logger.error({
                    error: notificationErrorMsg,
                    msg:   'Failed to send channel registry error notification to owner',
                });
                // Continue - notification is best-effort
            }
        }
    }
}

/**
 * Parameters for setting up message processing.
 */
export interface SetupMessageProcessingParams {
    client:               Client
    readyClient:          Client
    channelRegistry:      ChannelRegistryManager
    addRecentMessage:     (content: string, author: 'user' | 'izzy') => void
    coordinator:          MessageCoordinator
    questionRegistry:     QuestionRegistry
    answerClassifier:     AnswerClassifier
    inboxManager:         InboxManager | undefined
    catchUpSessionRunner: CatchUpSessionRunner | undefined
    botStateManager:      BotStateManager
    perchSessionRunner:   PerchSessionRunner | undefined
    dmTracker:            DMTracker
}

/**
 * Sets up message processing by registering the messageCreate handler.
 *
 * @param params - Configuration for message processing
 */
export function setupMessageProcessing(params: SetupMessageProcessingParams): void {
    const {
        client,
        readyClient,
        channelRegistry,
        addRecentMessage,
        coordinator,
        questionRegistry,
        answerClassifier,
        inboxManager,
        catchUpSessionRunner,
        botStateManager,
        perchSessionRunner,
        dmTracker,
    } = params;

    // Register message handler AFTER channel registry is initialized
    // This ensures channelRegistry.shouldProcess() has data to work with
    client.on('messageCreate', safeAsyncHandler(createMessageHandler({
        botUserId: createUserId(readyClient.user!.id),
        channelRegistry,
        addRecentMessage,
        coordinator,
        questionRegistry,
        answerClassifier,
        inboxManager,
        catchUpSessionRunner,
        botStateManager,
        perchSessionRunner,
        dmTracker,
    }), logger, 'messageCreate handler'));
}

/**
 * Sets up channel cleanup event handlers for the Discord client.
 *
 * @param params - Configuration for channel cleanup
 */
export function setupChannelCleanupHandlers(params: {
    client:          Client
    coordinator:     MessageCoordinator | undefined
    channelRegistry: ChannelRegistryManager
}): void {
    const { client, coordinator, channelRegistry } = params;

    // Register channel cleanup event handlers (if coordinator exists)
    // channelDelete: Clean up coordinator state when a channel is deleted
    client.on('channelDelete', (channel) => {
        if(!('id' in channel)) {
            return;
        }

        const channelId = createChannelId(channel.id);
        if(coordinator) {
            coordinator.removeChannel(channelId);
        }
    });

    // guildDelete: Clean up coordinator state for all channels in a guild when bot leaves
    client.on('guildDelete', safeAsyncHandler(async (guild) => {
        if(!coordinator) {
            return;
        }

        const guildId = createGuildId(guild.id);
        // Get all channel IDs for this guild from the channel registry
        const allChannels = channelRegistry.getAllChannels();
        const guildChannelIds = _(allChannels)
            .filter(['guildId', guildId])
            .map('channelId')
            .value();

        coordinator.removeGuildChannels(guildChannelIds);
    }, logger, 'guildDelete handler'));
}
