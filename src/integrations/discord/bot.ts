import type { Client } from 'discord.js';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, UserId } from './types';
import type { ClaudeAgent } from '@/agent/agent';
import { setConversationContext, clearConversationContext } from '@/agent';
import { createDiscordClient } from './client';
import { createReadyHandler, createErrorHandler, createMessageHandler } from './handlers';
import {
    createActiveStatusGenerator,
    createDynamicStatusGenerator,
    createIdleStatusGenerator,
    createPresenceManager,
    createStreamEventHandler,
    type PresenceManager,
    type CatchUpSynopsisContext
} from './presence';
import { createMessageCoordinator, type MessageCoordinator } from './message-coordinator';
import { createDiscordRateLimiter, type DiscordRateLimiter } from './rate-limiter';
import { createQuestionRegistry, type QuestionRegistry } from '@/agent/question-registry';
import { createAnswerClassifier, classifyWithHaiku } from '@/agent/answer-classifier';
import { createInteractionHandler } from './interactions';
import { fetchImages, saveNonImageAttachment, isSupportedImageType, formatBytes, addAttachmentInfoToContexts } from './attachments';
import type { FetchedImage } from './attachments/types';
import type { InboxManager } from './inbox';
import { formatTimeSince, getTimeOfDay } from '@/utils/time';
import {
    createCatchUpSessionRunner,
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from './catchup';
import {
    createBotStateManager,
    type BotStateManager,
    type StateChange
} from './state';
import {
    createPerchScheduler,
    createPerchSessionRunner,
    type PerchScheduler,
    type PerchSessionRunner,
    type PerchConfig
} from '@/agent/perch';
import { discoverAllChannels, setupChannelEventHandlers, DMTracker, ResponseRouter, type ChannelRegistryManager } from './channel-registry';
import { sendResponse } from './response-sender';

/**
 * Global state for Discord client to survive Bun hot reload.
 * During hot reload, the module is re-executed but global state persists.
 * This allows us to reuse the existing client and remove old event handlers
 * before registering new ones, preventing duplicate handler registration.
 */
declare global {

    var __discordClient: Client | undefined;
}

/**
 * Result of processing Discord message attachments
 */
interface ProcessedAttachments {
    /** Fetched image attachments ready for Claude */
    images:           FetchedImage[]
    /** Text descriptions of saved non-image attachments */
    contentAdditions: string[]
}

/**
 * Builds catch-up synopsis context from inbox state.
 *
 * @param inboxManager - Inbox manager with unread messages
 * @param memoryBackend - Memory backend for loading completion signal
 * @returns Promise resolving to catch-up synopsis context
 */
// Stryker disable all: Context building with lodash chains and object literals for catch-up status - tested via integration
async function buildCatchUpContext(
    inboxManager: InboxManager,
    memoryBackend: {
        loadCompletionSignal: () => Promise<CatchUpCompletionSignal | null>
    }
): Promise<CatchUpSynopsisContext> {
    const overview = inboxManager.getUnreadOverview();
    const allMessages = _.flatMap(
        overview.channels,
        ch => inboxManager.getChannelMessages(ch.channelId)
    );
    const topAuthors = _(allMessages)
        .map('author')
        .countBy()
        .toPairs()
        .orderBy([1], ['desc'])
        .take(3)
        .map(([author]) => author)
        .value();

    // Get time since last active from completion signal
    const completionSignal = await memoryBackend.loadCompletionSignal();
    const lastActiveTime = completionSignal?.completedAt
        ? new Date(completionSignal.completedAt)
        : new Date(Date.now() - 24 * 60 * 60 * 1000); // Default to 24h ago

    return {
        totalUnread:         overview.totalUnread,
        channelCount:        overview.channels.length,
        channelNames:        _.map(overview.channels, 'channelName'),
        topAuthors,
        timeSinceLastActive: formatTimeSince(lastActiveTime),
        timeOfDay:           getTimeOfDay(new Date()),
        dayOfWeek:           new Date().toLocaleDateString('en-US', { weekday: 'long' }),
    };
}
// Stryker restore all

/**
 * Processes all attachments from Discord contexts.
 * Images are fetched and prepared for Claude's vision API.
 * Non-image files are saved to the scratch directory and referenced in text.
 *
 * @param contexts - Discord message contexts containing attachments
 * @returns Processed images and content additions for message text
 */
// Stryker disable all: Integration function with external dependencies - tested via bot integration tests
async function processAttachments(contexts: DiscordMessageContext[]): Promise<ProcessedAttachments> {
    const allAttachments = contexts.flatMap(ctx => ctx.attachments ?? []);
    let images: FetchedImage[] = [];
    const contentAdditions: string[] = [];

    if(allAttachments.length > 0) {
        // Fetch images
        const imageAttachments = _.filter(allAttachments, att => isSupportedImageType(att.contentType));
        if(imageAttachments.length > 0) {
            const result = await fetchImages(imageAttachments);
            images = result.images;
            // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
            logger.info({
                totalAttachments: imageAttachments.length,
                fetchedImages:    images.length,
                failedImages:     result.failures.length,
                msg:              `Fetched ${images.length} images from ${imageAttachments.length} image attachments (${result.failures.length} failed)`,
            });

            // Log failures
            for(const failure of result.failures) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                logger.warn({
                    filename:    failure.filename,
                    contentType: failure.contentType,
                    size:        failure.size,
                    error:       failure.error,
                    msg:         `Failed to fetch image: ${failure.filename}`,
                });
                contentAdditions.push(
                    `[Image fetch failed: ${failure.filename} - ${failure.error}]`
                );
            }
        }

        // Save non-image attachments to scratch directory
        const nonImageAttachments = _.filter(allAttachments, att => !isSupportedImageType(att.contentType));
        if(nonImageAttachments.length > 0) {
            const scratchDir = process.cwd();
            const messageId = contexts[0]?.messageId ?? 'unknown';

            for(const attachment of nonImageAttachments) {
                const stored = await saveNonImageAttachment(attachment, scratchDir, messageId);
                if(stored) {
                    contentAdditions.push(
                        `[Attached file: ${stored.localPath} (${stored.contentType}, ${formatBytes(stored.size)})]`
                    );
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                    logger.info({
                        filename:    stored.originalFilename,
                        localPath:   stored.localPath,
                        contentType: stored.contentType,
                        size:        stored.size,
                        msg:         `Saved non-image attachment: ${stored.originalFilename}`,
                    });
                } else {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                    logger.warn({
                        filename:    attachment.filename,
                        contentType: attachment.contentType,
                        msg:         `Failed to save non-image attachment: ${attachment.filename}`,
                    });
                }
            }
        }
    }

    return { images, contentAdditions };
}
// Stryker restore all

/**
 * Creates a stream event handler for presence updates during agent processing.
 * Returns undefined if presence manager is not available.
 *
 * @param presenceManager - Manager for Discord presence updates
 * @param dynamicStatusGenerator - Optional generator for context-aware status messages
 * @param userMessage - User's message content for synopsis generation
 * @returns Stream event handler or undefined
 */
function createPresenceStreamHandler(
    presenceManager: PresenceManager | undefined,
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined,
    userMessage: string,
    botStateManager: BotStateManager
): ReturnType<typeof createStreamEventHandler> | undefined {
    if(!presenceManager) {
        return undefined;
    }

    return createStreamEventHandler({
        presenceManager,
        dynamicStatusGenerator,
        logger,
        userMessage,
        botStateManager,
    });
}

/**
 * Options for configuring the Discord bot.
 */
/**
 * Initializes the channel registry by warming cache, discovering channels, and setting up event handlers.
 *
 * @param client - Discord client (must be ready)
 * @param channelRegistry - Channel registry manager
 * @param responseRouter - Response router for sending notifications
 * @param botStateManager - Bot state manager for determining session type
 * @param rateLimiter - Rate limiter for Discord API calls (optional, created after this function)
 * @returns Promise that resolves when initialization is complete
 */
async function initializeChannelRegistry(
    client: Client,
    channelRegistry: ChannelRegistryManager,
    responseRouter: ResponseRouter,
    botStateManager: BotStateManager,
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
                    'synthetic-channel' as import('./types').ChannelId // Will trigger fallback routing
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
interface SetupMessageProcessingParams {
    client:                 Client
    readyClient:            Client
    channelRegistry:        ChannelRegistryManager
    onMessage:              (context: DiscordMessageContext) => Promise<string | null>
    presenceManager:        PresenceManager | undefined
    agent:                  ClaudeAgent | undefined
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined
    addRecentMessage:       (content: string) => void
    coordinator:            MessageCoordinator | undefined
    questionRegistry:       QuestionRegistry
    answerClassifier:       ReturnType<typeof createAnswerClassifier>
    inboxManager:           InboxManager | undefined
    catchUpSessionRunner:   CatchUpSessionRunner | undefined
    botStateManager:        BotStateManager
    perchSessionRunner:     PerchSessionRunner | undefined
    dmTracker:              DMTracker
    responseRouter:         ResponseRouter
}

/**
 * Sets up message processing by registering the messageCreate handler.
 *
 * @param params - Configuration for message processing
 */
function setupMessageProcessing(params: SetupMessageProcessingParams): void {
    const {
        client,
        readyClient,
        channelRegistry,
        onMessage,
        presenceManager,
        agent,
        dynamicStatusGenerator,
        addRecentMessage,
        coordinator,
        questionRegistry,
        answerClassifier,
        inboxManager,
        catchUpSessionRunner,
        botStateManager,
        perchSessionRunner,
        dmTracker,
        responseRouter,
    } = params;

    // Register message handler AFTER channel registry is initialized
    // This ensures channelRegistry.shouldProcess() has data to work with
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- messageCreate handler is async
    client.on('messageCreate', createMessageHandler({
        botUserId: readyClient.user!.id as UserId,
        channelRegistry,
        onMessage,
        presenceManager,
        agent,
        dynamicStatusGenerator,
        addRecentMessage,
        coordinator,
        questionRegistry,
        answerClassifier,
        inboxManager,
        catchUpSessionRunner,
        botStateManager,
        perchSessionRunner,
        dmTracker,
        responseRouter,
    }));
}

/**
 * Parameters for setting up inbox and catch-up functionality.
 */
interface SetupInboxParams {
    inboxManager:         InboxManager
    readyClient:          Client
    botStateManager:      BotStateManager
    catchUpSessionRunner: CatchUpSessionRunner | undefined
    presenceManager:      PresenceManager | undefined
    memoryBackend:        {
        loadCompletionSignal: () => Promise<CatchUpCompletionSignal | null>
    }
    perchConfig: PerchConfig | undefined
}

/**
 * Sets up inbox and catch-up functionality.
 * Initializes inbox, loads unread messages, and starts catch-up if needed.
 *
 * @param params - Configuration for inbox setup
 */
function setupInboxAndCatchUp(params: SetupInboxParams): void {
    const {
        inboxManager,
        readyClient,
        botStateManager,
        catchUpSessionRunner,
        presenceManager,
        memoryBackend,
        perchConfig,
    } = params;

    // Capture runner reference for closure safety
    const runner = catchUpSessionRunner;

    (async () => {
        try {
            // Start unified state manager
            botStateManager.start();

            // Set bot user ID for filtering bot messages from inbox
            inboxManager.setBotUserId(readyClient.user!.id);

            // Load unread messages (automatically initializes checkpoints for monitored channels)
            const count = await inboxManager.loadUnread();
            if(count > 0) {
                logger.info({
                    unreadCount: count,
                    msg:         `Inbox loaded with ${count} unread messages`,
                });
            }

            // NOW check if catch-up should start (after inbox is loaded)
            // Skip if perch test mode triggerOnStartup is enabled (perch handles everything)
            if(runner && !perchConfig?.testMode?.triggerOnStartup) {
                const shouldStart = await runner.shouldStartCatchUp();
                if(shouldStart) {
                    logger.info({ msg: 'Starting catch-up mode' });

                    // Build catch-up context for rich status generation
                    const catchUpContext = await buildCatchUpContext(inboxManager, memoryBackend);

                    // Update presence to show catching up with rich context
                    presenceManager?.transitionPresenceDisplayMode('catching_up', catchUpContext);
                    await runner.startCatchUp();
                } else {
                    // Not doing catch-up, transition to idle mode
                    void presenceManager?.updatePhase({ type: 'idle', since: new Date() });
                }
            } else if(!perchConfig?.testMode?.triggerOnStartup) {
                // No catch-up system and not in perch test mode, transition to idle after startup
                void presenceManager?.updatePhase({ type: 'idle', since: new Date() });
            }
            // If triggerOnStartup is enabled, perch scheduler handles presence - no action needed here
        } catch (error) {
            const errorMsg = _.isError(error) ? error.message : String(error);
            logger.warn({
                error: errorMsg,
                msg:   'Failed to load inbox on startup',
            });
        }
    })().catch((error) => {
        const errorMsg = _.isError(error) ? error.message : String(error);
        logger.error({
            error: errorMsg,
            msg:   'Unhandled error in inbox initialization',
        });
    });
}

/**
 * Parameters for setting up coordinator integration.
 */
interface SetupCoordinatorParams {
    agent:                  ClaudeAgent
    presenceManager:        PresenceManager | undefined
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined
    botStateManager:        BotStateManager
    catchUpSessionRunner:   CatchUpSessionRunner | undefined
    perchSessionRunner:     PerchSessionRunner | undefined
    responseRouter:         ResponseRouter
    rateLimiter:            DiscordRateLimiter
    readyClient:            Client
    channelRegistry:        ChannelRegistryManager
}

/**
 * Sets up the message coordinator integration with the agent.
 * Configures the processor to handle message contexts and call the agent.
 *
 * @param params - Configuration for coordinator setup
 * @returns Configured message coordinator
 */
function setupCoordinatorIntegration(params: SetupCoordinatorParams): MessageCoordinator {
    const {
        agent,
        presenceManager,
        dynamicStatusGenerator,
        botStateManager,
        catchUpSessionRunner,
        perchSessionRunner,
        responseRouter,
        rateLimiter,
        readyClient,
    } = params;

    const coordinator = createMessageCoordinator({
        debounceMs: 250,
        onResponse: async (result, discordMessage) => {
            // Only send response if we have both a response and a message to reply to
            if(result.response && discordMessage) {
                // Capture rate limiter reference for safe closure access
                const limiter = rateLimiter;

                await sendResponse({
                    responseRouter,
                    botStateManager,
                    response:           result.response,
                    message:            discordMessage,
                    rateLimiter:        limiter,
                    client:             readyClient,
                    useFallbackOnError: false,
                });
            }

            // Resume catch-up if we were interrupted
            if(botStateManager.getMode() === 'catching_up' && botStateManager.isInterrupted() && catchUpSessionRunner) {
                logger.info({ msg: 'Resuming catch-up after interruption' });
                // Update presence back to catching_up
                presenceManager?.transitionPresenceDisplayMode('catching_up');
                // Resume catch-up (async, don't await)
                void catchUpSessionRunner.resumeAfterInterruption().catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume catch-up after interruption' });
                    // Reset presence on failure
                    presenceManager?.transitionPresenceDisplayMode('none');
                });
            }

            // Resume perch if we were interrupted
            if(botStateManager.getMode() === 'perching' && botStateManager.isInterrupted() && perchSessionRunner) {
                logger.info({ msg: 'Resuming perch after interruption' });
                presenceManager?.transitionPresenceDisplayMode('perching');
                void perchSessionRunner.resumeAfterInterruption().catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume perch after interruption' });
                    presenceManager?.transitionPresenceDisplayMode('none');
                });
            }
        },
    });

    // Helper to update presence when starting to process a user message
    const updatePresenceForMessageStart = (): void => {
        if(botStateManager.getMode() === 'idle') {
            presenceManager?.transitionPresenceDisplayMode('processing_message');
        }
    };

    // Helper to complete presence updates after message processing
    const completePresenceForMessage = (
        streamEventHandler: ReturnType<typeof createPresenceStreamHandler> | undefined
    ): void => {
        // Transition to idle after completion, but NOT if we're in catch-up interrupted state
        // (the resumed catch-up session will handle presence updates)
        const currentMode = botStateManager.getMode();
        const isInterrupted = botStateManager.isInterrupted();
        if(streamEventHandler && !(currentMode === 'catching_up' && isInterrupted)) {
            streamEventHandler.complete();
        }

        // Reset presence mode back to none if we were in idle mode
        if(currentMode === 'idle') {
            presenceManager?.transitionPresenceDisplayMode('none');
        }

        // Transition state manager to idle when message processing completes
        // (unless we're in catch-up interrupted state)
        if(currentMode === 'processing_message' && !isInterrupted) {
            botStateManager.goIdle();
        }
    };

    // Set the processor to call agent.chatBatch
    coordinator.setProcessor(async (contexts, resumeContext, sessionId, abortSignal) => {
        // Update presence to show processing message if not in catch-up mode
        updatePresenceForMessageStart();

        // Set conversation context for MCP tools
        setConversationContext({
            currentUserId:    contexts[0]?.userId,
            currentChannelId: contexts[0]?.channelId,
        });

        try {
            // Create abort controller from signal
            const abortController = new AbortController();
            abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Process attachments from all contexts
            const { images, contentAdditions } = await processAttachments(contexts);

            // Modify contexts to include attachment file paths in content
            const modifiedContexts = addAttachmentInfoToContexts(contexts, contentAdditions);

            // Extract user message from first context for synopsis generation
            const userMessage = contexts[0]?.content ?? '';

            // Create stream event handler for presence updates if presenceManager available
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                userMessage,
                botStateManager
            );

            // Get unmuted channels and format for system prompt
            const registry = params.channelRegistry;
            const client = params.readyClient;
            const unmutedChannels = await registry.getUnmutedChannels();
            const channelList = _.map(unmutedChannels, (channel: import('./channel-registry/types').ChannelMetadata) => {
                // Get guild name for disambiguation
                let guildName: string | undefined;
                if(channel.guildId !== 'DM') {
                    try {
                        const guild = client.guilds.cache.get(channel.guildId);
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

            // Call chatBatch with presence updates, images, and channel context
            const result = await agent.chatBatch(modifiedContexts, {
                sessionId,
                resumeContext: resumeContext ?? undefined,
                abortController,
                onStreamEvent: streamEventHandler?.onStreamEvent,
                images:        images.length > 0 ? images : undefined,
                channelList,
            });

            // Complete presence updates after processing
            completePresenceForMessage(streamEventHandler);

            return result;
        } finally {
            // Clear context after processing
            clearConversationContext();
        }
    });

    return coordinator;
}

/**
 * Parameters for setting up catch-up session runner.
 */
interface SetupCatchUpRunnerParams {
    inboxManager:  InboxManager
    agent:         ClaudeAgent
    memoryBackend:          {
        storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
        loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
        storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
        loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
        deleteInProgressSignal: () => Promise<void>
    }
    botStateManager:        BotStateManager
    presenceManager:        PresenceManager | undefined
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined
}

/**
 * Creates and configures the catch-up session runner.
 *
 * @param params - Configuration for catch-up setup
 * @returns Configured catch-up session runner
 */
function setupCatchUpSessionRunner(params: SetupCatchUpRunnerParams): CatchUpSessionRunner {
    const {
        inboxManager,
        agent,
        memoryBackend,
        botStateManager,
        presenceManager,
        dynamicStatusGenerator,
    } = params;

    return createCatchUpSessionRunner({
        stateManager:           botStateManager,
        inboxManager,
        storeCompletionSignal:  memoryBackend.storeCompletionSignal,
        loadCompletionSignal:   memoryBackend.loadCompletionSignal,
        storeInProgressSignal:  memoryBackend.storeInProgressSignal,
        loadInProgressSignal:   memoryBackend.loadInProgressSignal,
        deleteInProgressSignal: memoryBackend.deleteInProgressSignal,
        resolveChannelName:     channelId => inboxManager.getChannelName(channelId),
        runAgentSession:        async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Build dynamic user message from status context
            const statusContext = runOptions.statusContext;
            const userMessage = statusContext
                ? `Processing ${statusContext.totalUnread} messages from ${statusContext.topAuthors.join(', ')} in ${statusContext.channelNames.join(', ')}`
                : 'Catching up on messages...';

            // Create stream event handler for presence updates during catch-up
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                userMessage,
                botStateManager
            );

            // Call agent.chatBatch with specialMode: 'catchup' and the catch-up prompt
            const result = await agent.chatBatch([], {
                specialMode:   'catchup',
                abortController,
                sessionId:     runOptions.sessionId,
                catchUpPrompt: runOptions.prompt,
                onStreamEvent: streamEventHandler?.onStreamEvent,
            });

            // Transition to idle after completion
            if(streamEventHandler) {
                streamEventHandler.complete();
            }

            return {
                completed: !result.wasInterrupted,
                sessionId: result.sessionId,
            };
        },
        onCatchUpComplete: () => {
            // Reset presence mode when catch-up completes
            presenceManager?.transitionPresenceDisplayMode('none');
        },
    });
}

/**
 * Parameters for setting up perch scheduler and runner.
 */
interface SetupPerchParams {
    agent:                  ClaudeAgent
    perchConfig:            PerchConfig
    botStateManager:        BotStateManager
    presenceManager:        PresenceManager | undefined
    dynamicStatusGenerator: ReturnType<typeof createDynamicStatusGenerator> | undefined
}

/**
 * Creates and configures the perch session runner and scheduler.
 *
 * @param params - Configuration for perch setup
 * @returns Object containing configured perch session runner and scheduler
 */
function setupPerchSessionRunnerAndScheduler(params: SetupPerchParams): {
    runner:    PerchSessionRunner
    scheduler: PerchScheduler
} {
    const {
        agent,
        perchConfig,
        botStateManager,
        presenceManager,
        dynamicStatusGenerator,
    } = params;

    const runner = createPerchSessionRunner({
        stateManager:    botStateManager,
        logger,
        config:          perchConfig,
        runAgentSession: async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Create stream event handler for presence updates during perch
            const streamEventHandler = createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                `Perch time: ${runOptions.slot}`,
                botStateManager
            );

            // Call agent.chatBatch with specialMode: 'perching' and the perch prompt
            const result = await agent.chatBatch([], {
                specialMode:   'perching',
                abortController,
                perchPrompt:   runOptions.prompt,
                onStreamEvent: streamEventHandler?.onStreamEvent,
            });

            // Complete presence updates
            if(streamEventHandler) {
                streamEventHandler.complete();
            }

            return {
                completed: !result.wasInterrupted,
                sessionId: result.sessionId,
            };
        },
    });

    const scheduler = createPerchScheduler({
        stateManager:   botStateManager,
        logger,
        config:         perchConfig,
        onPerchTrigger: (slot) => {
            if(runner) {
                void runner.startPerch(slot).catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.error({ error: errorMsg, slot, msg: 'Failed to start perch session' });
                });
            }
        },
    });

    // Start the perch scheduler
    scheduler.start();
    logger.info({ msg: 'Perch scheduler initialized and started' });

    return { runner, scheduler };
}

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

    /**
     * Optional question registry for interactive question/answer flows.
     * If not provided, a new registry will be created internally.
     * Pass this to share the registry with the Discord MCP server.
     */
    questionRegistry?: QuestionRegistry

    /**
     * Optional inbox manager for tracking unread messages and channel activity.
     * If provided, enables inbox functionality for the bot.
     */
    inboxManager?: InboxManager

    /**
     * Optional memory backend for storing catch-up state (completion/inProgress signals).
     * If provided along with agent and inboxManager, enables catch-up mode.
     */
    memoryBackend?: {
        /** Store catch-up completion signal */
        storeCompletionSignal:  (signal: CatchUpCompletionSignal) => Promise<void>
        /** Load catch-up completion signal */
        loadCompletionSignal:   () => Promise<CatchUpCompletionSignal | null>
        /** Store catch-up in-progress signal */
        storeInProgressSignal:  (signal: CatchUpInProgressSignal) => Promise<void>
        /** Load catch-up in-progress signal */
        loadInProgressSignal:   () => Promise<CatchUpInProgressSignal | null>
        /** Delete catch-up in-progress signal */
        deleteInProgressSignal: () => Promise<void>
    }

    /**
     * Optional bot state manager.
     * If provided, this will be used instead of creating a new one.
     * Useful when the state manager needs to be shared with other components.
     */
    botStateManager?: BotStateManager

    /**
     * Channel registry for dynamic channel management.
     * Required for message filtering and channel discovery.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Optional perch time configuration.
     * If provided along with agent, enables autonomous perch time.
     */
    perchConfig?: PerchConfig
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

    /**
     * For testing - expose internal state manager (Phase 2).
     * @internal
     */
    _botStateManager?: BotStateManager
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
 *     homeGuildId: '...'
 *   },
 *   channelRegistry: myChannelRegistry,
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
    const { config, onMessage, identityContext, agent, client: providedClient, inboxManager, memoryBackend, botStateManager: providedBotStateManager, channelRegistry } = options;

    // Hot reload protection: Reuse existing client if available in global state
    // During Bun hot reload, the module is re-executed but global state persists.
    // This prevents duplicate event handler registration.
    let client: Client;
    if(providedClient) {
        // Use provided client (testing or external management)
        client = providedClient;
    } else if(globalThis.__discordClient) {
        // Reuse existing client from hot reload
        client = globalThis.__discordClient;
        // Remove all existing listeners before re-registering
        // This is critical to prevent duplicate handlers during hot reload
        client.removeAllListeners();
    } else {
        // First initialization - create new client
        client = createDiscordClient(config);
        // Store in global state for hot reload survival
        globalThis.__discordClient = client;
    }

    let presenceManager: PresenceManager | undefined;
    let coordinator: MessageCoordinator | undefined;
    let rateLimiter: DiscordRateLimiter | undefined;
    let catchUpSessionRunner: CatchUpSessionRunner | undefined;
    let perchScheduler: PerchScheduler | undefined;
    let perchSessionRunner: PerchSessionRunner | undefined;
    // Use provided registry or create a new one
    const questionRegistry: QuestionRegistry = options.questionRegistry ?? createQuestionRegistry();

    // Capture unsubscribe functions for cleanup
    let unsubscribeModeTransition: (() => void) | undefined;
    let unsubscribeActivityPhase: (() => void) | undefined;

    // Use provided bot state manager or create a new one
    const botStateManager: BotStateManager = providedBotStateManager ?? createBotStateManager({
        logger,
        updateThrottleMs: config.presence?.updateThrottleMs,
    });

    // Register error handler for Discord client errors
    // Stryker disable next-line StringLiteral: Discord.js event name
    client.on('error', createErrorHandler());

    // Register rate limit handler for logging (if rest client is available)
    // Stryker disable next-line ConditionalExpression,BlockStatement: client.rest always exists on Discord.js Client; rate limit logging is observational
    if(client.rest) {
        // Stryker disable all: Rate limit logging is observational only
        // Stryker disable next-line StringLiteral: Event name constant
        client.rest.on('rateLimited', (info) => {
            // Stryker disable next-line ObjectLiteral,StringLiteral: Logger warn object for observability
            logger.warn({
                route:      info.route,
                limit:      info.limit,
                retryAfter: info.retryAfter,
                global:     info.global,
                msg:        'Discord rate limit hit, auto-retrying',
            });
        });
        // Stryker restore all
    }

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready
    // Use .once() to ensure this setup only runs once, even on reconnects
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- clientReady handler must be async; needs refactoring to reduce complexity
    client.once('clientReady', async (readyClient: Client): Promise<void> => {
        // Log that the bot is ready (preserving functionality from removed logging handler)
        createReadyHandler()(readyClient);
        // At this point, readyClient.user is guaranteed to be non-null
        // because the 'clientReady' event only fires after successful authentication

        // Track recent messages for context-aware idle status generation
        const MAX_RECENT_MESSAGES = 5;
        const recentMessages: string[] = [];

        const addRecentMessage = (content: string): void => {
            recentMessages.push(content.slice(0, 200)); // Truncate long messages
            if(recentMessages.length > MAX_RECENT_MESSAGES) {
                recentMessages.shift();
            }
        };

        // Create rate limiter for Discord message sending
        rateLimiter = createDiscordRateLimiter({
            globalConcurrency: 5,
            logger,
        });

        // Create answer classifier with Haiku for ambiguous messages
        const answerClassifier = createAnswerClassifier({
            classifyWithLLM: classifyWithHaiku,
        });

        // Create interaction handler for button clicks
        const interactionHandler = createInteractionHandler({
            questionRegistry,
        });

        // Register interaction handler for button clicks
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- interactionCreate handler is async
        client.on('interactionCreate', async (interaction) => {
            if(interaction.isButton()) {
                await interactionHandler.handleButtonInteraction(interaction);
            }
        });

        // Create dynamic status generator if identityContext is provided
        // IMPORTANT: Must create before presence manager, catch-up session runner, and coordinator
        const dynamicStatusGenerator = identityContext
            ? createDynamicStatusGenerator({ identityContext })
            : undefined;

        // Create presence manager if optional deps provided
        // IMPORTANT: Must create before coordinator.setProcessor so it's available in onStreamEvent
        if(identityContext && config.presence) {
            const activeStatusGenerator = createActiveStatusGenerator({
                activityType: ActivityType.Custom,
                logger,
            });

            const idleStatusGenerator = createIdleStatusGenerator({
                logger,
                activityType:     ActivityType.Custom,
                identityContext,
                getRecentContext: async () => {
                    if(recentMessages.length === 0) {
                        return undefined;
                    }
                    return recentMessages.join('\n• ');
                },
            });

            presenceManager = createPresenceManager({
                discordClient: readyClient,
                config:        config.presence,
                activeStatusGenerator,
                idleStatusGenerator,
                dynamicStatusGenerator,
                logger,
            });

            presenceManager.start();

            // Bridge: Sync BotStateManager → PresenceManager
            /**
             * Set up idempotent subscription using `??=` (nullish coalescing assignment).
             *
             * The `??=` operator only assigns if the variable is null or undefined, ensuring
             * this subscription is created exactly once even if this handler runs multiple times
             * (e.g., on Discord reconnects).
             *
             * Problem solved: Without idempotency, each Discord reconnect would create duplicate
             * subscriptions, causing the same event to fire multiple times and create memory leaks.
             *
             * Cleanup: The unsubscribe functions are called in stop() to properly clean up
             * all subscriptions when the bot shuts down.
             */
            unsubscribeModeTransition ??= botStateManager.subscribe((change: StateChange) => {
                // Sync mode changes to presence manager
                if(change.changeType === 'mode_transition') {
                    const mode = change.newState.mode;
                    const interrupted = change.newState.interrupted;

                    // Map BotState mode to PresenceDisplayMode for presence
                    if(mode === 'idle') {
                        presenceManager!.transitionPresenceDisplayMode('none');
                        // Explicitly transition presence to idle phase
                        void presenceManager!.updatePhase({ type: 'idle', since: new Date() });
                    } else if(mode === 'catching_up') {
                        presenceManager!.transitionPresenceDisplayMode(interrupted ? 'catching_up_interrupted' : 'catching_up');
                    } else if(mode === 'processing_message') {
                        presenceManager!.transitionPresenceDisplayMode('processing_message');
                    } else if(mode === 'perching') {
                        presenceManager!.transitionPresenceDisplayMode(interrupted ? 'perching_interrupted' : 'perching');
                    }
                }

                // Sync interrupted flag changes
                if(change.changeType === 'interrupted') {
                    const mode = change.newState.mode;
                    const interrupted = change.newState.interrupted;
                    if(mode === 'catching_up') {
                        presenceManager!.transitionPresenceDisplayMode(interrupted ? 'catching_up_interrupted' : 'catching_up');
                    } else if(mode === 'perching') {
                        presenceManager!.transitionPresenceDisplayMode(interrupted ? 'perching_interrupted' : 'perching');
                    }
                }
            });

            // Bridge: Sync activity phases to presence manager
            /**
             * Set up idempotent subscription using `??=` (nullish coalescing assignment).
             *
             * The `??=` operator only assigns if the variable is null or undefined, ensuring
             * this subscription is created exactly once even if this handler runs multiple times
             * (e.g., on Discord reconnects).
             *
             * Problem solved: Without idempotency, each Discord reconnect would create duplicate
             * subscriptions, causing the same event to fire multiple times and create memory leaks.
             *
             * Cleanup: The unsubscribe functions are called in stop() to properly clean up
             * all subscriptions when the bot shuts down.
             *
             * Note: Check throttle BEFORE calling presenceManager.updatePhase() to ensure single throttle gate.
             */
            unsubscribeActivityPhase ??= botStateManager.subscribe((change: StateChange) => {
                if(change.changeType === 'activity_phase' && presenceManager) {
                    const phase = change.newState.activityPhase;
                    if(phase) {
                        // Throttle active phase updates to avoid Discord rate limits
                        if(botStateManager.shouldUpdatePresence()) {
                            void presenceManager.updatePhase(phase);
                            botStateManager.recordPresenceUpdate();
                        }
                    } else {
                        // Idle transitions intentionally bypass throttling:
                        // - End of work should show immediately to users
                        // - Prevents "stuck" active status after processing completes
                        // - Idle is a stable state, not a rapid-fire event
                        if(change.newState.mode === 'idle') {
                            void presenceManager.updatePhase({ type: 'idle', since: new Date() });
                            botStateManager.recordPresenceUpdate();
                        }
                    }
                }
            });

            // If no inbox manager, transition to idle immediately
            // (otherwise, idle transition happens after catch-up check in inbox init)
            if(!inboxManager) {
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
            }
        }

        // Create catch-up session runner if all dependencies available (must be created before inbox init)
        if(inboxManager && agent && memoryBackend) {
            catchUpSessionRunner = setupCatchUpSessionRunner({
                inboxManager,
                agent,
                memoryBackend,
                botStateManager,
                presenceManager,
                dynamicStatusGenerator,
            });
        }

        // Create perch session runner and scheduler if config provided
        if(agent && options.perchConfig?.enabled) {
            const perchSetup = setupPerchSessionRunnerAndScheduler({
                agent,
                perchConfig: options.perchConfig,
                botStateManager,
                presenceManager,
                dynamicStatusGenerator,
            });
            perchSessionRunner = perchSetup.runner;
            perchScheduler = perchSetup.scheduler;
        }

        // Create DMTracker and ResponseRouter (after client is ready)
        const dmTracker = new DMTracker(channelRegistry, readyClient);
        const responseRouter = new ResponseRouter({
            manager: channelRegistry,
        });

        // Initialize channel registry BEFORE setting up message handlers
        // Pass rateLimiter for error notification (may be undefined if not created yet)
        await initializeChannelRegistry(readyClient, channelRegistry, responseRouter, botStateManager, rateLimiter);

        // Register message handler AFTER channel registry is initialized
        setupMessageProcessing({
            client,
            readyClient,
            channelRegistry,
            onMessage,
            presenceManager,
            agent,
            dynamicStatusGenerator,
            addRecentMessage,
            coordinator,
            questionRegistry,
            answerClassifier,
            inboxManager,
            catchUpSessionRunner,
            botStateManager,
            perchSessionRunner,
            dmTracker,
            responseRouter,
        });

        // Initialize inbox on startup and then check for catch-up
        if(inboxManager) {
            setupInboxAndCatchUp({
                inboxManager,
                readyClient,
                botStateManager,
                catchUpSessionRunner,
                presenceManager,
                memoryBackend: memoryBackend!,
                perchConfig:   options.perchConfig,
            });
        }

        // Create message coordinator if agent is provided
        if(agent) {
            coordinator = setupCoordinatorIntegration({
                agent,
                presenceManager,
                dynamicStatusGenerator,
                botStateManager,
                catchUpSessionRunner,
                perchSessionRunner,
                responseRouter,
                rateLimiter: rateLimiter,
                readyClient,
                channelRegistry,
            });
        }
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        async stop(): Promise<void> {
            // Stop coordinator if it exists
            if(coordinator) {
                coordinator.stop();
            }
            // Stop question registry (always exists now)
            questionRegistry.stop();
            // Unsubscribe from botStateManager subscriptions
            if(unsubscribeModeTransition) {
                unsubscribeModeTransition();
            }
            if(unsubscribeActivityPhase) {
                unsubscribeActivityPhase();
            }
            // Stop unified state manager BEFORE stopping schedulers
            // This ensures state manager rejects new sessions even if scheduler callbacks fire
            botStateManager.stop();
            // NOW safe to stop schedulers and abort sessions
            // Abort any running catch-up session
            if(catchUpSessionRunner) {
                const controller = catchUpSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // Stop perch scheduler if it exists
            if(perchScheduler) {
                perchScheduler.stop();
            }
            // Abort any running perch session
            if(perchSessionRunner) {
                const controller = perchSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // Stop presence manager if it exists
            if(presenceManager) {
                presenceManager.stop();
            }
            // Stop rate limiter if it exists
            if(rateLimiter) {
                rateLimiter.stop();
            }
            // Remove all listeners before destroy to prevent memory leaks
            client.removeAllListeners();
            // destroy() is sufficient for cleanup (as per user decision)
            await client.destroy();
            // Clear global state to allow fresh initialization if needed
            // Only clear if this is the global client (not a provided client)
            if(!providedClient && globalThis.__discordClient === client) {
                globalThis.__discordClient = undefined;
            }
        },

        // For testing - expose internal state manager (Phase 2)
        _botStateManager: botStateManager,
    };
}
