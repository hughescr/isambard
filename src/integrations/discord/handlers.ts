import type { Client, Message, TextChannel } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { DiscordMessageContext, UserId, ChannelId } from './types';
import type { MessageCoordinator } from './message-coordinator';
import { createGuildId, createChannelId, createUserId } from './types';
import type { QuestionRegistry } from '@/agent/question-registry';
import type { AnswerClassifier } from '@/agent/answer-classifier';
import type { AttachmentMetadata } from './attachments/types';
import { inferImageContentType } from './content-type';
import type { InboxManager } from './inbox';
import type { CatchUpSessionRunner } from './catchup';
import type { BotStateManager } from './state';
import type { ChannelRegistryManager, DMTracker } from './channel-registry';
import { withDiscordRetry } from './retry';

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
     * The bot's user ID (used to detect @mentions and ignore own messages).
     */
    botUserId: UserId

    /**
     * Channel registry for dynamic channel management.
     * Used to determine if messages should be processed.
     */
    channelRegistry: ChannelRegistryManager

    /**
     * Optional callback to track recent message content for context-aware idle status.
     */
    addRecentMessage?: (content: string) => void

    /**
     * Message coordinator for multi-message handling with interruption support.
     * Handles batching and processing messages through the coordinator.
     */
    coordinator: MessageCoordinator

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
     * Bot state manager for checking current mode.
     */
    botStateManager: BotStateManager

    /**
     * Optional perch session runner for interrupting autonomous perch sessions.
     */
    perchSessionRunner?: import('@/agent/perch').PerchSessionRunner

    /**
     * Optional DM tracker for tracking DM channels.
     */
    dmTracker?: DMTracker
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
 * 2. Hands off to the message coordinator for batching and processing
 * 3. Coordinator handles interruption, batching, and response routing
 *
 * Additional features:
 * - Interrupts catch-up or perch sessions when new messages arrive
 * - Tracks pending questions and correlates answers
 * - Updates inbox checkpoints for catch-up tracking
 * - Manages bot state transitions (idle → processing_message)
 *
 * @param options - Configuration for the message handler
 * @returns Event handler function for the 'messageCreate' event
 *
 * @example
 * ```typescript
 * const client = new Client({ intents: [...] });
 * const coordinator = createMessageCoordinator({ agent, onResponse: ... });
 *
 * client.on('messageCreate', createMessageHandler({
 *   botUserId: myBotUserId,
 *   channelRegistry: myChannelRegistry,
 *   coordinator: coordinator,
 *   botStateManager: myBotStateManager,
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
        content:     message.cleanContent,
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
        content:     message.cleanContent,
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
            message.cleanContent
        );
    }

    // Update channel metadata in inbox if shouldRespond is true
    // Stryker disable next-line all: Optional inbox integration - tested via inbox-manager.test.ts
    if(inboxManager && shouldRespond) {
        updateChannelMetadataInInbox(message, inboxManager);
    }
}

/**
 * Helper function to handle mode-based interruptions (catch-up or perch).
 * Interrupts any active catch-up or perch session as a side-effect, then returns to let the message continue to the coordinator.
 */
async function handleModeInterruptions(
    message: Message,
    botStateManager: BotStateManager | undefined,
    catchUpSessionRunner: CatchUpSessionRunner | undefined,
    perchSessionRunner: import('@/agent/perch').PerchSessionRunner | undefined
): Promise<void> {
    // Handle catch-up mode interruption
    if(botStateManager?.getMode() === 'catching_up' && catchUpSessionRunner) {
        // Always call interrupt — session runner decides what to do based on
        // whether resume is in progress, already interrupted, etc.
        await handleCatchUpInterruption(message, catchUpSessionRunner);
        return;
    }

    // Handle perch mode interruption
    if(botStateManager?.getMode() === 'perching' && perchSessionRunner) {
        // Always call interrupt — session runner decides what to do based on
        // whether resume is in progress, already interrupted, etc.
        await handlePerchInterruption(message, perchSessionRunner);
    }
}

/**
 * Helper function to update inbox checkpoint after message processing.
 */
// Stryker disable all: Optional inbox integration - checkpoint update for catch-up tracking
async function updateInboxCheckpoint(
    message: Message,
    inboxManager: InboxManager | undefined,
    shouldRespond: boolean
): Promise<void> {
    if(inboxManager && shouldRespond) {
        await inboxManager.recordActivity(
            createChannelId(message.channel.id),
            createGuildId(message.guild?.id ?? 'DM'),
            message.id,
            message.createdAt.toISOString()
        );
    }
}
// Stryker restore all

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
 * Returns an object with isDM, isMention, isReplyToBot, and shouldRespond.
 */
async function determineResponseContext(
    message: Message,
    botUserId: UserId,
    channelRegistry: ChannelRegistryManager
): Promise<{ isDM: boolean, isMention: boolean, isReplyToBot: boolean, shouldRespond: boolean }> {
    const isDM = !message.guild; // DM channels have no guild
    const isMention = message.content.includes(`<@${botUserId}>`) || message.content.includes(`<@!${botUserId}>`);
    const channelId = createChannelId(message.channel.id);

    // Check for reply to bot
    let isReplyToBot = false;
    // Stryker disable next-line ConditionalExpression: Guard skips fetch when no reference exists; catch swallows the same failure
    if(message.reference?.messageId) {
        // Stryker disable BlockStatement
        try {
            const referencedMessage = await message.fetchReference();
            isReplyToBot = referencedMessage.author.id === botUserId;
        } catch{
            // If we can't fetch the reference, assume it's not a reply to bot
        }
        // Stryker restore BlockStatement
    }

    // Muting applies at the channel level only. Threads inherit their parent channel's mute state.
    // For thread messages, check parent channel mute state
    // If parent is muted, threads inherit the mute unless override conditions apply
    let shouldRespond = channelRegistry.shouldProcess(channelId, isDM, isMention, isReplyToBot);
    if(shouldRespond && message.channel.isThread?.() && message.channel.parentId) {
        const parentChannelId = createChannelId(message.channel.parentId);
        // Check if parent channel is muted. Override conditions (mention, reply) still apply - if someone @mentions Izzy in a thread of a muted channel, still respond.
        shouldRespond = channelRegistry.shouldProcess(parentChannelId, false, isMention, isReplyToBot);
    }

    return { isDM, isMention, isReplyToBot, shouldRespond };
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
        content:             message.cleanContent,
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
            content:     message.cleanContent,
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
    const { botUserId, channelRegistry, addRecentMessage, coordinator, questionRegistry, answerClassifier, inboxManager, catchUpSessionRunner, botStateManager, perchSessionRunner, dmTracker } = options;

    // Helper to create DiscordMessageContext from Discord.js Message
    const createContext = (message: Message): DiscordMessageContext => {
        const attachments = extractAttachmentMetadata(message);
        return {
            guildId:     createGuildId(message.guild?.id ?? 'DM'),
            channelId:   createChannelId(message.channel.id),
            userId:      createUserId(message.author.id),
            messageId:   message.id,
            content:     message.cleanContent,
            timestamp:   message.createdAt.toISOString(),
            botUserId,
            // Stryker disable next-line ConditionalExpression: Empty array exclusion - tests verify both cases
            attachments: attachments.length > 0 ? attachments : undefined,
        };
    };

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
        const { isDM, isMention, isReplyToBot, shouldRespond } = await determineResponseContext(
            message,
            botUserId,
            channelRegistry
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
            isReplyToBot,
            shouldRespond,
            msg: `Filtering: isDM=${isDM}, isMention=${isMention}, isReplyToBot=${isReplyToBot} → shouldRespond=${shouldRespond}`,
        });

        if(!shouldRespond) {
            return;
        }

        // Track DM channel if this is a DM message
        if(dmTracker && isDM) {
            try {
                await dmTracker.trackFromMessage(
                    createUserId(message.author.id),
                    createChannelId(message.channel.id),
                    message.author.username
                );
            } catch (error) {
                // Log tracking failure but continue processing message
                logger.warn({
                    error,
                    userId:    message.author.id,
                    channelId: message.channel.id,
                    msg:       'Failed to track DM channel, continuing message processing',
                });
            }
        }

        // Handle mode-based interruptions (catch-up or perch)
        // This interrupts the session as a side-effect; the message continues to the coordinator below
        await handleModeInterruptions(
            message,
            botStateManager,
            catchUpSessionRunner,
            perchSessionRunner
        );

        // Handle state transitions and inbox updates
        handleStateAndInbox(message, botStateManager, inboxManager, shouldRespond);

        // Track this message for context-aware idle status
        addRecentMessage?.(message.cleanContent);

        // Convert Discord.js Message to DiscordMessageContext
        const context = createContext(message);
        // Hand off to coordinator (it will handle batching, interruption, and onResponse)
        const channel = 'sendTyping' in message.channel ? message.channel : undefined;
        coordinator.handleMessage(context, message, channel);

        // Update checkpoint to mark this message as "seen" for catch-up purposes
        await updateInboxCheckpoint(message, inboxManager, shouldRespond);
    };
}
