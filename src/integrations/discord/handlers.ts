import type { Client, Message, TextChannel } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
import type { PresenceManager } from './presence';
import type { DynamicStatusGenerator } from './presence/status-generator-dynamic';
import type { ClaudeAgent } from '@/agent/agent';
import type { MessageCoordinator } from './message-coordinator';
import { createGuildId, createChannelId, createUserId } from './types';
import { createStatusMiddleware } from './presence';
import { splitMessage } from './messages';
import { createDiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';
import type { QuestionRegistry } from '@/agent/question-registry';
import type { AnswerClassifier } from '@/agent/answer-classifier';
import type { AttachmentMetadata } from './attachments/types';
import { inferImageContentType } from './content-type';
import type { InboxManager } from './inbox';
import type { CatchUpSessionRunner } from './catchup';
import type { BotStateManager } from './state';

/**
 * Helper function to extract attachment metadata from a Discord message.
 * Converts Discord.js Attachment objects to AttachmentMetadata.
 *
 * @param message Discord message with attachments
 * @returns Array of attachment metadata
 */
export function extractAttachmentMetadata(message: Message): AttachmentMetadata[] {
    // Stryker disable next-line ConditionalExpression: Mutating to false throws TypeError on undefined attachments
    if(!message.attachments || message.attachments.size === 0) {
        return [];
    }

    return _.map(Array.from(message.attachments.values()), attachment => ({
        url:         attachment.url,
        filename:    attachment.name ?? 'unknown',
        // Stryker disable next-line StringLiteral: Equivalent mutant - 'unknown' and '' both produce 'application/octet-stream' in inferImageContentType
        contentType: inferImageContentType(attachment.name ?? 'unknown', attachment.contentType),
        size:        attachment.size,
        width:       attachment.width ?? undefined,
        height:      attachment.height ?? undefined,
    }));
}

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

    /**
     * Optional dynamic status generator for LLM-generated synopses.
     */
    dynamicStatusGenerator?: DynamicStatusGenerator

    /**
     * Optional callback to track recent message content for context-aware idle status.
     */
    addRecentMessage?: (content: string) => void

    /**
     * Optional message coordinator for multi-message handling with interruption support.
     * When provided, messages are batched and processed through the coordinator.
     */
    coordinator?: MessageCoordinator

    /**
     * Optional question registry for answer correlation.
     */
    questionRegistry?: QuestionRegistry

    /**
     * Optional answer classifier for message classification.
     */
    answerClassifier?: AnswerClassifier

    /**
     * Optional inbox manager for tracking channel activity and unread messages.
     */
    inboxManager?: InboxManager

    /**
     * Optional catch-up session runner for interrupting catch-up sessions.
     */
    catchUpSessionRunner?: CatchUpSessionRunner

    /**
     * Optional bot state manager for checking current mode.
     */
    botStateManager?: BotStateManager

    /**
     * Optional perch session runner for interrupting autonomous perch sessions.
     */
    perchSessionRunner?: import('@/agent/perch').PerchSessionRunner
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
/**
 * Helper function to handle catch-up mode interruption.
 * Interrupts the catch-up session.
 */
async function handleCatchUpInterruption(
    message: Message,
    catchUpSessionRunner: CatchUpSessionRunner
): Promise<void> {
    // Stryker disable all: Logging for observability
    logger.info({
        channelId: message.channel.id,
        msg:       'Interrupting catch-up mode for new message',
    });
    // Stryker restore all

    // Interrupt the catch-up session with full message details
    const channelId = createChannelId(message.channel.id);
    const channel = message.channel as TextChannel;
    catchUpSessionRunner.interrupt({
        channelId,
        author:      message.author.username,
        // Stryker disable next-line LogicalOperator: Fallback for DM channels where name is null
        channelName: channel.name ?? message.channel.id,
        content:     message.content,
    });

    // Presence update is handled by the subscription in bot.ts
}

/**
 * Helper function to handle perch mode interruption.
 * Interrupts the perch session with message details.
 */
async function handlePerchInterruption(
    message: Message,
    perchSessionRunner: import('@/agent/perch').PerchSessionRunner
): Promise<void> {
    // Stryker disable all: Logging for observability
    logger.info({
        channelId: message.channel.id,
        msg:       'Interrupting perch mode for new message',
    });
    // Stryker restore all

    // Get channel name for interruption context
    const channel = message.channel as TextChannel;

    // Interrupt the perch session with message details
    perchSessionRunner.interrupt({
        channelId:   createChannelId(message.channel.id),
        author:      message.author.username,
        channelName: channel.name ?? message.channel.id,
        content:     message.content,
    });

    // Presence update is handled by the subscription in bot.ts
}

/**
 * Helper function to update channel metadata in inbox manager.
 * This is a synchronous operation that just updates the cache.
 */
// Stryker disable all: Optional inbox integration - tested via inbox-manager.test.ts
function updateChannelMetadataInInbox(
    message: Message,
    inboxManager: InboxManager
): void {
    const channel = message.channel as TextChannel;
    inboxManager.updateChannelMetadata(
        createChannelId(message.channel.id),
        channel.name ?? message.channel.id,
        createGuildId(message.guild?.id ?? 'DM')
    );
}
// Stryker restore all

/**
 * Helper function to handle state transitions and inbox updates.
 */
function handleStateAndInbox(
    message: Message,
    botStateManager: BotStateManager | undefined,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): void {
    // Transition state manager to processing_message mode when in idle mode
    // This ensures BotStateManager is the single source of truth for state
    if(botStateManager?.getMode() === 'idle') {
        botStateManager.startProcessingMessage(
            createChannelId(message.channel.id),
            message.content
        );
    }

    // Update channel metadata in inbox if shouldRespond is true
    // Stryker disable next-line all: Optional inbox integration - tested via inbox-manager.test.ts
    if(inboxManager && shouldRespond) {
        updateChannelMetadataInInbox(message, inboxManager);
    }
}

/**
 * Helper function to delegate message to coordinator or process directly.
 */
async function delegateToCoordinatorOrProcess(
    message: Message,
    coordinator: MessageCoordinator | undefined,
    createContext: (message: Message) => DiscordMessageContext,
    processMessage: (message: Message) => Promise<void>
): Promise<void> {
    // Stryker disable all: Integration tests cover coordinator path, unit tests cover direct path
    if(coordinator) {
        // Convert Discord.js Message to DiscordMessageContext
        const context = createContext(message);

        // Hand off to coordinator (it will handle batching, interruption, and onResponse)
        // Only pass channel if it has sendTyping method (some channel types don't)
        const channel = 'sendTyping' in message.channel ? message.channel : undefined;
        coordinator.handleMessage(context, message, channel);
        // Stryker restore all
    } else {
        // Direct processing (backward compatibility)
        await processMessage(message);
    }
}

/**
 * Helper function to handle mode-based interruptions (catch-up or perch).
 * Returns true if the message triggered an interruption (caller should return early).
 */
async function handleModeInterruptions(
    message: Message,
    botStateManager: BotStateManager | undefined,
    catchUpSessionRunner: CatchUpSessionRunner | undefined,
    perchSessionRunner: import('@/agent/perch').PerchSessionRunner | undefined
): Promise<boolean> {
    // Handle catch-up mode interruption
    if(botStateManager?.getMode() === 'catching_up' && catchUpSessionRunner) {
        await handleCatchUpInterruption(message, catchUpSessionRunner);
        return true;
    }

    // Handle perch mode interruption
    if(botStateManager?.getMode() === 'perching' && perchSessionRunner) {
        await handlePerchInterruption(message, perchSessionRunner);
        return true;
    }

    return false;
}

/**
 * Helper function to update inbox checkpoint after message processing.
 */
async function updateInboxCheckpoint(
    message: Message,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): Promise<void> {
    // Stryker disable all: Optional inbox integration - checkpoint update for catch-up tracking
    if(inboxManager && shouldRespond) {
        await inboxManager.recordActivity(
            createChannelId(message.channel.id),
            createGuildId(message.guild?.id ?? 'DM'),
            message.id,
            message.createdAt.toISOString()
        );
    }
    // Stryker restore all
}

/**
 * Helper function to check if a message should be ignored.
 * Returns true if the message is from a bot or from the bot itself.
 */
function shouldIgnoreMessage(message: Message, botUserId: UserId): boolean {
    // Ignore bot messages
    if(message.author.bot) {
        return true;
    }

    // Ignore messages from the bot itself
    if(message.author.id === botUserId) {
        return true;
    }

    return false;
}

/**
 * Helper function to determine response context for a message.
 * Returns an object with isDM, isMention, isMonitoredChannel, and shouldRespond.
 */
function determineResponseContext(
    message: Message,
    botUserId: UserId,
    monitoredChannelIds: ChannelId[]
): { isDM: boolean, isMention: boolean, isMonitoredChannel: boolean, shouldRespond: boolean } {
    const isDM = !message.guild; // DM channels have no guild
    const isMention = message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
    const isMonitoredChannel = monitoredChannelIds.includes(message.channel.id as ChannelId);
    const shouldRespond = isDM || isMention || isMonitoredChannel;

    return { isDM, isMention, isMonitoredChannel, shouldRespond };
}

/**
 * Helper function to check for pending questions and handle answers/interruptions/unrelated.
 * Returns true if message was handled (early return), false to continue normal processing.
 */
async function handlePendingQuestion(
    message: Message,
    questionRegistry: QuestionRegistry,
    answerClassifier: AnswerClassifier,
    isMention: boolean
): Promise<boolean> {
    // For threads, use parent channel ID for lookup; for regular channels, use the channel ID
    let lookupChannelId: ChannelId;
    let lookupThreadId: string | undefined;

    if(message.channel.isThread()) {
        // Thread messages: parent channel + thread ID
        lookupChannelId = createChannelId(message.channel.parentId ?? message.channel.id);
        lookupThreadId = message.channel.id;
    } else {
        // Regular channel messages: just channel ID, no thread
        lookupChannelId = createChannelId(message.channel.id);
        lookupThreadId = undefined;
    }

    const pendingQuestion = questionRegistry.findPendingQuestion(
        lookupChannelId,
        lookupThreadId
    );

    if(!pendingQuestion) {
        return false;
    }

    const classification = await answerClassifier.classify(pendingQuestion, {
        content:             message.content,
        authorId:            message.author.id,
        channelId:           message.channel.id,
        threadId:            lookupThreadId,
        referencedMessageId: message.reference?.messageId,
        isBotMentioned:      isMention,
        targetUserId:        pendingQuestion.targetUserId,
    });

    // Stryker disable all: Logger debug object
    logger.debug({
        questionId: pendingQuestion.questionId,
        channelId:  lookupChannelId,
        threadId:   lookupThreadId,
        classification,
        msg:        `Message classified as ${classification}`,
    });
    // Stryker restore all

    if(classification === 'answer') {
        // Stryker disable all: Logger info object
        logger.info({
            questionId:  pendingQuestion.questionId,
            responderId: message.author.id,
            messageId:   message.id,
            msg:         'Question resolved with text answer',
        });
        // Stryker restore all

        // Resolve the question - don't send to coordinator
        questionRegistry.resolveWithAnswer(pendingQuestion.questionId, {
            content:     message.content,
            responderId: createUserId(message.author.id),
            messageId:   message.id,
            channelId:   lookupChannelId,
            threadId:    lookupThreadId,
        });
        return true; // Early return
    }

    if(classification === 'interruption') {
        // Stryker disable all: Logger info object
        logger.info({
            questionId: pendingQuestion.questionId,
            msg:        'Question cancelled due to interruption',
        });
        // Stryker restore all

        // Cancel pending question and continue to normal processing
        questionRegistry.cancel(pendingQuestion.questionId);
        return false;
    }

    // If unrelated, send polite reply and keep question pending
    // Stryker disable next-line ConditionalExpression: Exhaustive branch - always true here since answer/interruption returned above
    if(classification === 'unrelated') {
        // Stryker disable all: Logger debug object
        logger.debug({
            questionId: pendingQuestion.questionId,
            msg:        'Message classified as unrelated, question still pending',
        });
        // Stryker restore all
        await withDiscordRetry(
            async () => {
                await message.reply({
                    content: "I'm not sure if this message is for me. If you'd like my help, please @mention me!",
                });
            },
            // Stryker disable next-line StringLiteral: Operation name for logging only
            'replyToUnrelatedMessage'
        );
        return true; // Early return - don't continue processing
    }

    // Stryker disable next-line BooleanLiteral: TypeScript requires return but logically unreachable
    return false;
}

export function createMessageHandler(options: MessageHandlerOptions): (message: Message) => Promise<void> {
    const { monitoredChannelIds, botUserId, onMessage, presenceManager, agent, dynamicStatusGenerator, addRecentMessage, coordinator, questionRegistry, answerClassifier, inboxManager, catchUpSessionRunner, botStateManager, perchSessionRunner } = options;

    // Create status middleware if presenceManager, agent, and botStateManager are provided
    const statusMiddleware = presenceManager && agent && botStateManager
        ? createStatusMiddleware({
            presenceManager,
            agent,
            logger,
            dynamicStatusGenerator,
            botStateManager,
        })
        : null;

    // Create rate limiter for Discord message sending
    // Stryker disable next-line ObjectLiteral: Logger debug object
    const rateLimiter = createDiscordRateLimiter({
        globalConcurrency: 5,
        logger,
    });

    // Helper to create DiscordMessageContext from Discord.js Message
    const createContext = (message: Message): DiscordMessageContext => {
        const attachments = extractAttachmentMetadata(message);
        return {
            guildId:     createGuildId(message.guild?.id ?? 'DM'),
            channelId:   createChannelId(message.channel.id),
            userId:      createUserId(message.author.id),
            messageId:   message.id,
            content:     message.content,
            timestamp:   message.createdAt.toISOString(),
            botUserId,
            // Stryker disable next-line ConditionalExpression: Empty array exclusion - tests verify both cases
            attachments: attachments.length > 0 ? attachments : undefined,
        };
    };

    // Helper function to process a message after filtering checks pass
    async function processMessage(message: Message): Promise<void> {
        // Convert Discord.js Message to DiscordMessageContext
        const context = createContext(message);

        try {
            logger.info({
                userId:         message.author.id,
                channelId:      message.channel.id,
                messageId:      message.id,
                contentPreview: message.content.slice(0, 50) + (message.content.length > 50 ? '...' : ''),
                msg:            `Processing message from ${message.author.tag}`,
            });

            // Use status middleware if available, otherwise call onMessage directly
            // Discord.js channels implement sendTyping() for typing indicator support
            const channel = message.channel as { sendTyping(): Promise<void> };
            const reply = statusMiddleware
                ? await statusMiddleware(context, channel)
                : await onMessage(context);

            // Track this message for context-aware idle status
            addRecentMessage?.(context.content);

            // Record channel activity for inbox tracking
            // Stryker disable all: Optional inbox integration - tested via inbox-manager.test.ts
            if(inboxManager) {
                const guildId = createGuildId(message.guild?.id ?? 'DM');
                inboxManager.recordActivity(
                    context.channelId,
                    guildId,
                    context.messageId,
                    context.timestamp
                ).catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.warn({
                        channelId: context.channelId,
                        error:     errorMsg,
                        msg:       'Failed to record inbox activity',
                    });
                });
            }
            // Stryker restore all

            // Reply if callback returned a string
            if(reply !== null) {
                logger.info({
                    messageId:      message.id,
                    responseLength: reply.length,
                    msg:            `Response generated (${reply.length} chars)`,
                });

                // Split long messages into Discord-safe chunks
                const chunks = splitMessage(reply);

                try {
                    // First chunk uses reply() to thread the response (with retry and rate limiting)
                    await withDiscordRetry(
                        () => rateLimiter.replyToMessage(message, chunks[0]),
                        // Stryker disable next-line StringLiteral: Operation name for logging only
                        'replyToMessage'
                    );
                    logger.info({ messageId: message.id, chunkIndex: 0, totalChunks: chunks.length, msg: 'Reply sent successfully' });

                    // Subsequent chunks use channel.send() to continue the conversation (with retry and rate limiting)
                    const channel = message.channel as TextChannel;
                    // Stryker disable next-line EqualityOperator: Loop starts at 1 to skip already-sent first chunk
                    for(let i = 1; i < chunks.length; i++) {
                        await withDiscordRetry(
                            () => rateLimiter.sendToChannel(channel, chunks[i]),
                            // Stryker disable next-line StringLiteral: Operation name for logging
                            'sendToChannel'
                        );
                        logger.info({ messageId: message.id, chunkIndex: i, totalChunks: chunks.length, msg: 'Continuation sent successfully' });
                    }
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
    }

    return async (message: Message) => {
        logger.debug({
            authorId:  message.author.id,
            channelId: message.channel.id,
            isDM:      !message.guild,
            msg:       `Message received from ${message.author.tag}`,
        });

        // Check if message should be ignored
        if(shouldIgnoreMessage(message, botUserId)) {
            return;
        }

        // Determine response context
        const { isDM, isMention, isMonitoredChannel, shouldRespond } = determineResponseContext(
            message,
            botUserId,
            monitoredChannelIds
        );

        // FIRST: Check for pending questions BEFORE shouldRespond filtering
        // This allows answers in unmonitored channels or without mentions
        if(questionRegistry && answerClassifier) {
            const handled = await handlePendingQuestion(message, questionRegistry, answerClassifier, isMention);
            if(handled) {
                return;
            }
        }

        // THEN: Normal shouldRespond check for non-pending-question messages
        logger.debug({
            isDM,
            isMention,
            isMonitoredChannel,
            shouldRespond,
            msg: `Filtering: isDM=${isDM}, isMention=${isMention}, isMonitored=${isMonitoredChannel} → shouldRespond=${shouldRespond}`,
        });

        if(!shouldRespond) {
            return;
        }

        // Handle mode-based interruptions (catch-up or perch)
        const wasInterrupted = await handleModeInterruptions(
            message,
            botStateManager,
            catchUpSessionRunner,
            perchSessionRunner
        );
        if(wasInterrupted) {
            return;
        }

        // Handle state transitions and inbox updates
        handleStateAndInbox(message, botStateManager, inboxManager, shouldRespond);

        // If coordinator is provided, delegate to it; otherwise process directly
        await delegateToCoordinatorOrProcess(message, coordinator, createContext, processMessage);

        // Update checkpoint to mark this message as "seen" for catch-up purposes
        await updateInboxCheckpoint(message, inboxManager, shouldRespond);
    };
}
