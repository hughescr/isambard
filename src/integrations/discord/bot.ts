import type { Client, TextChannel } from 'discord.js';
import { ActivityType } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
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
    type PresenceManager
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
    let coordinator: MessageCoordinator | undefined;
    let rateLimiter: DiscordRateLimiter | undefined;
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
                logger,
            });

            presenceManager.start();
        }

        // Create dynamic status generator if identityContext is provided
        // IMPORTANT: Must create before coordinator.setProcessor so it's available in onStreamEvent
        const dynamicStatusGenerator = identityContext
            ? createDynamicStatusGenerator({ identityContext })
            : undefined;

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
                },
            });

            // Set the processor to call agent.chatBatch
            coordinator.setProcessor(async (contexts, resumeContext, sessionId, abortSignal) => {
                // Set conversation context for MCP tools
                setConversationContext({
                    currentUserId:    contexts[0]?.userId,
                    currentChannelId: contexts[0]?.channelId,
                });

                try {
                    // Create abort controller from signal
                    const abortController = new AbortController();
                    abortSignal.addEventListener('abort', () => abortController.abort());

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

                    // Transition to idle after completion
                    if(streamEventHandler) {
                        streamEventHandler.complete();
                    }

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
        }));
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
