import { logger } from '@hughescr/logger';
import type { Client, TextChannel } from 'discord.js';
import { chain } from 'lodash-es';
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
import { createReconnectionLoop, type ServiceHealthRegistry } from '@/services';
import { safeAsyncHandler } from '@/utils';

// Operator notifications for registry errors have no associated origin channel.
// We call responseRouter.routeToFallback() directly so the notification is
// delivered to the configured fallback channel without needing a real ChannelId.

// ---------------------------------------------------------------------------
// No-op health registry stub (used when no registry is provided)
// ---------------------------------------------------------------------------

// Stryker disable all: no-op stub — behaviour is definitionally absent
function noopUnsubscribe(): void { /* no-op */ }
const NOOP_HEALTH_REGISTRY: ServiceHealthRegistry = {
    getState:           () => 'disabled',
    getEntry:           () => ({ state: 'disabled', epoch: 0, failureCount: 0 }),
    getAll:             () => ({} as ReturnType<ServiceHealthRegistry['getAll']>),
    isAvailable:        () => false,
    isWriteAvailable:   () => false,
    sendEvent:          () => undefined,
    subscribe:          () => noopUnsubscribe,
    buildStatusSummary: () => undefined,
    stop:               () => undefined,
};
// Stryker restore all

/**
 * Sends an urgent error notification to the owner via the fallback channel.
 */
async function sendRegistryErrorNotification(
    client: Client,
    responseRouter: ResponseRouter,
    rateLimiter: DiscordRateLimiter,
    errorMsg: string
): Promise<void> {
    try {
        // Notification content must include the error message so the operator can diagnose the failure.
        const notificationContent = `⚠️ **Channel Registry Error**: Failed to load channel mute settings. I'm currently responding to ALL channels until this is resolved. Error: ${errorMsg}`;

        // Route to fallback channel for startup errors — no origin channel exists here.
        const routing = await responseRouter.routeToFallback(notificationContent);

        // Stryker disable next-line all: Defensive guard - routing always has shouldSend=true and targetChannelId set for error notifications
        if(routing.shouldSend && routing.targetChannelId) {
            // Fetch the target channel and send directly
            const targetChannel = await client.channels.fetch(routing.targetChannelId);
            // Stryker disable next-line all: Defensive guard - validated in response-sender.test.ts for normal flow
            if(targetChannel && 'send' in (targetChannel as object)) {
                await rateLimiter.sendToChannel(targetChannel as TextChannel, routing.content);
                // Stryker disable all: Logging for observability
                logger.info({
                    targetChannelId: routing.targetChannelId,
                    msg:             'Channel registry error notification sent to fallback channel',
                });
                // Stryker restore all
            }
        }
    } catch (notificationError) {
        const notificationErrorMsg = notificationError instanceof Error ? notificationError.message : String(notificationError);
        logger.error({
            error: notificationErrorMsg,
            msg:   'Failed to send channel registry error notification to owner',
        });
        // Continue - notification is best-effort
    }
}

/**
 * Initializes the channel registry by starting self-healing hydration via a ReconnectionLoop,
 * then (once the registry is ready) discovering channels and setting up event handlers.
 *
 * @param client - Discord client (must be ready)
 * @param channelRegistry - Channel registry manager
 * @param responseRouter - Response router for sending notifications
 * @param rateLimiter - Rate limiter for Discord API calls (optional)
 * @param healthRegistry - Service health registry for tracking connectivity (optional)
 */
/** Number of consecutive warmCache() failures before a one-time operator notification is sent. */
const HYDRATION_NOTIFY_THRESHOLD = 3;

export function initializeChannelRegistry(
    client: Client,
    channelRegistry: ChannelRegistryManager,
    responseRouter: ResponseRouter,
    rateLimiter?: DiscordRateLimiter,
    healthRegistry?: ServiceHealthRegistry
): void {
    const registry = healthRegistry ?? NOOP_HEALTH_REGISTRY;

    // Register the channel-registry service with the health registry so it
    // appears in status summaries and transitions correctly through the state machine.
    registry.sendEvent('discord-channel-registry', 'CONFIGURE');

    // Warn at startup if no rateLimiter is provided — hydration failures won't surface to operators.
    if(!rateLimiter) {
        logger.warn({ msg: 'Channel registry hydration failures will not surface to operator — no rate limiter configured' });
    }

    // Count consecutive warmCache() failures so we can notify the operator after
    // HYDRATION_NOTIFY_THRESHOLD failures without spamming on every retry.
    //
    // NOTE: These closure variables are scoped to this loop's lifetime and assume
    // initializeChannelRegistry() is called exactly once per process. A second call
    // would create an independent closure with fresh counters — no cross-loop sharing.
    let consecutiveFailureCount = 0;
    let notificationSent        = false;

    const loop = createReconnectionLoop({
        service:   'discord-channel-registry',
        registry,
        connectFn: async () => {
            try {
                await channelRegistry.warmCache();
                consecutiveFailureCount = 0; // Reset on success
                notificationSent = false;    // Allow re-notification if failures resume later
            } catch (err: unknown) {
                consecutiveFailureCount += 1;

                if(consecutiveFailureCount >= HYDRATION_NOTIFY_THRESHOLD && !notificationSent && rateLimiter) {
                    notificationSent = true;
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    void sendRegistryErrorNotification(client, responseRouter, rateLimiter, errorMsg);
                }

                throw err;
            }
        },
    });

    channelRegistry.startHydration(loop);

    // After the registry is ready (and on every subsequent stop/restart cycle),
    // discover channels and wire up event handlers.
    // onReady() re-attaches this callback each time a new ready promise is created
    // so that a stop() → startHydration() cycle correctly re-fires discovery.
    channelRegistry.onReady(async () => {
        try {
            const discoveryResult = await discoverAllChannels(client, channelRegistry);
            // Stryker disable all: Logging for observability
            logger.info({
                discovered: discoveryResult.discovered,
                updated:    discoveryResult.updated,
                errors:     discoveryResult.errors.length,
                msg:        `Channel discovery completed: ${discoveryResult.discovered} new, ${discoveryResult.updated} updated`,
            });
            // Stryker restore all
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error({
                error: errorMsg,
                msg:   'Channel discovery failed after registry hydration',
            });

            // Send urgent notification to owner via fallback channel
            if(rateLimiter) {
                await sendRegistryErrorNotification(client, responseRouter, rateLimiter, errorMsg);
            }
        }

        // Set up event handlers for channel changes regardless of discovery outcome
        setupChannelEventHandlers(client, channelRegistry);
    });
}

/**
 * Parameters for setting up message processing.
 */
interface SetupMessageProcessingParams {
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
    // Stryker disable StringLiteral: Handler context name is logging configuration
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
    // Stryker restore StringLiteral
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
        const channelUnknown: unknown = channel;
        if(!(typeof channelUnknown === 'object' && channelUnknown !== null && 'id' in channelUnknown)) {
            return;
        }

        const channelId = createChannelId(channel.id);
        if(coordinator) {
            coordinator.removeChannel(channelId);
        }
    });

    // guildDelete: Clean up coordinator state for all channels in a guild when bot leaves
    // Stryker disable StringLiteral: Handler context name is logging configuration
    client.on('guildDelete', safeAsyncHandler(async (guild) => {
        if(!coordinator) {
            return;
        }

        const guildId = createGuildId(guild.id);
        // Get all channel IDs for this guild from the channel registry
        const allChannels = channelRegistry.getAllChannels();
        const guildChannelIds = chain(allChannels).filter(['guildId', guildId]).map('channelId').value();

        coordinator.removeGuildChannels(guildChannelIds);
    }, logger, 'guildDelete handler'));
    // Stryker restore StringLiteral
}
