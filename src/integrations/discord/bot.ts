import type { Client, TextChannel } from 'discord.js';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, UserId, ChannelId, GuildId } from './types';
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
import { splitMessage } from './messages';
import { createDiscordRateLimiter, type DiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';
import { createQuestionRegistry, type QuestionRegistry } from '@/agent/question-registry';
import { createAnswerClassifier, classifyWithHaiku } from '@/agent/answer-classifier';
import { createInteractionHandler } from './interactions';
import { fetchImages, saveNonImageAttachment, isSupportedImageType, formatBytes, addAttachmentInfoToContexts } from './attachments';
import type { FetchedImage } from './attachments/types';
import type { InboxManager } from './inbox';
import { formatTimeSince, getTimeOfDay } from '@/utils/time';
import {
    createCatchUpSessionRunner,
    type CatchUpStateManager,
    type CatchUpSessionRunner,
    type CatchUpCompletionSignal,
    type CatchUpInProgressSignal
} from './catchup';

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
 * Populates channel metadata cache for better display names.
 * Fetches channel details from Discord and updates the inbox manager.
 *
 * @param client - Discord client for fetching channels
 * @param inboxManager - Inbox manager to update with metadata
 * @param channelIds - Channel IDs to fetch metadata for
 */
// Stryker disable all: Integration function with external dependencies - tested via bot integration tests
async function populateChannelMetadata(
    client: Client,
    inboxManager: InboxManager,
    channelIds: string[]
): Promise<void> {
    logger.debug({
        channelIds: channelIds,
        msg:        'Starting channel metadata population'
    });

    for(const channelId of channelIds) {
        try {
            const channel = await client.channels.fetch(channelId);

            logger.debug({
                channelId,
                channelFound: !!channel,
                channelType:  channel?.type,
                msg:          'Fetched channel for metadata'
            });

            if(channel) {
                logger.debug({
                    channelId,
                    isDMBased: channel.isDMBased(),
                    hasGuild:  'guild' in channel && !!channel.guild,
                    type:      channel.type,
                    msg:       'Processing channel type'
                });
                // Determine guild ID and name based on channel type
                let guildId: GuildId | 'DM' = 'DM';
                let channelName = channelId;

                // Check if this is a guild-based channel (has a guild property)
                if('guild' in channel && channel.guild) {
                    guildId = channel.guild.id as GuildId;
                    channelName = 'name' in channel && _.isString(channel.name)
                        ? channel.name
                        : channelId;
                } else if(channel.isDMBased()) {
                    // DM channel - try to get recipient name for better display
                    if('recipient' in channel && channel.recipient) {
                        // Single-user DM - use recipient's display name
                        const recipient = channel.recipient;
                        channelName = `DM with ${recipient.displayName ?? recipient.username}`;
                    } else {
                        // Group DM or unknown - fall back to generic name
                        channelName = 'DM';
                    }
                }

                // Update metadata cache (for display names)
                inboxManager.updateChannelMetadata(
                    channelId as ChannelId,
                    channelName,
                    guildId
                );
            } else {
                logger.warn({
                    channelId,
                    msg: 'Channel not found or not accessible'
                });
            }
        } catch (error) {
            logger.warn({
                channelId,
                error: _.isError(error) ? error.message : String(error),
            }, 'Failed to fetch channel for metadata');
        }
    }
}
// Stryker restore all

/**
 * Builds catch-up synopsis context from inbox state.
 *
 * @param inboxManager - Inbox manager with unread messages
 * @param memoryBackend - Memory backend for loading completion signal
 * @returns Promise resolving to catch-up synopsis context
 */
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
    userMessage: string
): ReturnType<typeof createStreamEventHandler> | undefined {
    if(!presenceManager) {
        return undefined;
    }

    return createStreamEventHandler({
        presenceManager,
        dynamicStatusGenerator,
        logger,
        userMessage,
    });
}

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
     * Optional catch-up state manager for tracking catch-up session state.
     * If provided along with inboxManager, agent, and memoryBackend, enables catch-up mode.
     */
    catchUpStateManager?: CatchUpStateManager
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
    const { config, onMessage, identityContext, agent, client: providedClient, inboxManager, memoryBackend, catchUpStateManager } = options;
    const client: Client = providedClient ?? createDiscordClient(config);
    let presenceManager: PresenceManager | undefined;
    let coordinator: MessageCoordinator | undefined;
    let rateLimiter: DiscordRateLimiter | undefined;
    let catchUpSessionRunner: CatchUpSessionRunner | undefined;
    // Use provided registry or create a new one
    const questionRegistry: QuestionRegistry = options.questionRegistry ?? createQuestionRegistry();

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

    // Register clientReady handler for logging
    client.on('clientReady', createReadyHandler());

    // Register clientReady handler for messageCreate setup
    // This runs after the client is authenticated and ready
    client.on('clientReady', (readyClient: Client): void => {
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

            // If no inbox manager, transition to idle immediately
            // (otherwise, idle transition happens after catch-up check in inbox init)
            if(!inboxManager) {
                void presenceManager.updatePhase({ type: 'idle', since: new Date() });
            }
        }

        // Create catch-up session runner if all dependencies available (must be created before inbox init)
        if(inboxManager && agent && memoryBackend && catchUpStateManager) {
            // Create session runner
            catchUpSessionRunner = createCatchUpSessionRunner({
                stateManager:           catchUpStateManager,
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
                        userMessage
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
                    presenceManager?.setCatchUpMode('none');
                },
            });
        }

        // Initialize inbox on startup and then check for catch-up
        if(inboxManager) {
            // Capture runner reference for closure safety
            const runner = catchUpSessionRunner;

            (async () => {
                try {
                    // Set bot user ID for filtering bot messages from inbox
                    inboxManager.setBotUserId(readyClient.user!.id);

                    // Populate channel metadata cache for better display names
                    await populateChannelMetadata(readyClient, inboxManager, config.monitoredChannelIds);

                    // Load unread messages (automatically initializes checkpoints for monitored channels)
                    const count = await inboxManager.loadUnread();
                    if(count > 0) {
                        logger.info({
                            unreadCount: count,
                            msg:         `Inbox loaded with ${count} unread messages`,
                        });
                    }

                    // NOW check if catch-up should start (after inbox is loaded)
                    if(runner) {
                        const shouldStart = await runner.shouldStartCatchUp();
                        if(shouldStart) {
                            logger.info({ msg: 'Starting catch-up mode' });

                            // Build catch-up context for rich status generation
                            const catchUpContext = await buildCatchUpContext(inboxManager, memoryBackend!);

                            // Update presence to show catching up with rich context
                            presenceManager?.setCatchUpMode('catching_up', catchUpContext);
                            await runner.startCatchUp();
                        } else {
                            // Not doing catch-up, transition to idle mode
                            void presenceManager?.updatePhase({ type: 'idle', since: new Date() });
                        }
                    } else {
                        // No catch-up system, transition to idle after startup
                        void presenceManager?.updatePhase({ type: 'idle', since: new Date() });
                    }
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

        // Create message coordinator if agent is provided
        if(agent) {
            coordinator = createMessageCoordinator({
                debounceMs: 250,
                onResponse: async (result, discordMessage) => {
                    // Only send response if we have both a response and a message to reply to
                    if(result.response && discordMessage) {
                        const chunks = splitMessage(result.response);

                        try {
                            // Capture rate limiter reference for safe closure access
                            const limiter = rateLimiter!;

                            // First chunk uses reply() to thread the response
                            await withDiscordRetry(
                                () => limiter.replyToMessage(discordMessage, chunks[0]),
                                'replyToMessage'
                            );
                            logger.info({ messageId: discordMessage.id, chunkIndex: 0, totalChunks: chunks.length, msg: 'Reply sent successfully' });

                            // Subsequent chunks use channel.send() to continue the conversation
                            const channel = discordMessage.channel as TextChannel;
                            for(let i = 1; i < chunks.length; i++) {
                                await withDiscordRetry(
                                    () => limiter.sendToChannel(channel, chunks[i]),
                                    'sendToChannel'
                                );
                                logger.info({ messageId: discordMessage.id, chunkIndex: i, totalChunks: chunks.length, msg: 'Continuation sent successfully' });
                            }
                        } catch (replyError) {
                            const err = _.isError(replyError) ? replyError : new Error(String(replyError));
                            logger.error({ error: err, messageId: discordMessage.id, msg: `Failed to reply to message ${discordMessage.id}: ${err.message}` });
                        }
                    }

                    // Resume catch-up if we were interrupted
                    if(catchUpStateManager?.getState() === 'catching_up_interrupted' && catchUpSessionRunner) {
                        logger.info({ msg: 'Resuming catch-up after interruption' });
                        // Update presence back to catching_up
                        presenceManager?.setCatchUpMode('catching_up');
                        // Resume catch-up (async, don't await)
                        void catchUpSessionRunner.resumeAfterInterruption().catch((error) => {
                            const errorMsg = _.isError(error) ? error.message : String(error);
                            logger.error({ error: errorMsg, msg: 'Failed to resume catch-up after interruption' });
                            // Reset presence on failure
                            presenceManager?.setCatchUpMode('none');
                        });
                    }
                },
            });

            // Helper to update presence when starting to process a user message
            const updatePresenceForMessageStart = (): void => {
                if(catchUpStateManager?.getState() === 'idle') {
                    presenceManager?.setCatchUpMode('processing_message');
                }
            };

            // Helper to complete presence updates after message processing
            const completePresenceForMessage = (
                streamEventHandler: ReturnType<typeof createPresenceStreamHandler> | undefined
            ): void => {
                // Transition to idle after completion, but NOT if we're in catch-up interrupted state
                // (the resumed catch-up session will handle presence updates)
                const currentState = catchUpStateManager?.getState();
                if(streamEventHandler && currentState !== 'catching_up_interrupted') {
                    streamEventHandler.complete();
                }

                // Reset presence mode back to none if we were in processing_message mode
                if(currentState === 'idle') {
                    presenceManager?.setCatchUpMode('none');
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
                        userMessage
                    );

                    // Call chatBatch with presence updates and images
                    const result = await agent.chatBatch(modifiedContexts, {
                        sessionId,
                        resumeContext: resumeContext ?? undefined,
                        abortController,
                        onStreamEvent: streamEventHandler?.onStreamEvent,
                        images:        images.length > 0 ? images : undefined,
                    });

                    // Complete presence updates after processing
                    completePresenceForMessage(streamEventHandler);

                    return result;
                } finally {
                    // Clear context after processing
                    clearConversationContext();
                }
            });
        }

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- messageCreate handler is async
        client.on('messageCreate', createMessageHandler({
            monitoredChannelIds: config.monitoredChannelIds as ChannelId[],
            botUserId:           readyClient.user!.id as UserId,
            onMessage,
            presenceManager,
            agent,
            dynamicStatusGenerator,
            addRecentMessage,
            coordinator,
            questionRegistry,
            answerClassifier,
            inboxManager,
            catchUpStateManager,
            catchUpSessionRunner,
        }));
    });

    return {
        async start(): Promise<void> {
            // Login errors propagate to caller (as per user decision)
            await client.login(config.botToken);
        },

        async stop(): Promise<void> {
            // Abort any running catch-up session FIRST to prevent race conditions
            if(catchUpSessionRunner) {
                const controller = catchUpSessionRunner.getAbortController();
                if(controller) {
                    controller.abort();
                }
            }
            // Stop coordinator if it exists
            if(coordinator) {
                coordinator.stop();
            }
            // Stop question registry (always exists now)
            questionRegistry.stop();
            // Stop presence manager if it exists
            if(presenceManager) {
                presenceManager.stop();
            }
            // Stop rate limiter if it exists
            if(rateLimiter) {
                rateLimiter.stop();
            }
            // destroy() is sufficient for cleanup (as per user decision)
            await client.destroy();
        },
    };
}
