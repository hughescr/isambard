import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import _ from 'lodash';
import { randomUUID } from 'node:crypto';
import type { Client, TextChannel, Message, MessageCreateOptions } from 'discord.js';
import { logger } from '@hughescr/logger';
import type { MessageSearchService } from '../integrations/discord/message-history/search';
import type { QuestionRegistry } from './question-registry';
import { questionOptionSchema } from './question-registry';
import { buildQuestionButtons } from '../integrations/discord/button-builder';
import { createChannelId, createUserId, type UserId, type ChannelId } from '../integrations/discord/types';
import { withDiscordRetry } from '../integrations/discord/retry';
import { splitMessage } from '../integrations/discord/messages';

/**
 * Context for the current Discord conversation.
 * Used to provide conversation-specific information to MCP tools.
 */
export interface DiscordMCPServerContext {
    /**
     * User ID of the user who initiated the current conversation.
     */
    currentUserId?: UserId

    /**
     * Channel ID of the current conversation.
     */
    currentChannelId?: ChannelId
}

/**
 * Stored conversation context.
 * Initially empty, updated via setConversationContext.
 */
let conversationContext: DiscordMCPServerContext = {};

/**
 * Updates the conversation context for MCP tools.
 * Should be called before processing a conversation.
 *
 * @param context - New conversation context
 */
export function setConversationContext(context: DiscordMCPServerContext): void {
    conversationContext = context;
}

/**
 * Clears the conversation context.
 * Should be called after processing completes.
 */
export function clearConversationContext(): void {
    conversationContext = {};
}

/**
 * Helper: Validates thread creation parameters.
 * Returns error result if createThread is true but threadName is missing, null otherwise.
 */
function validateThreadCreation(createThread?: boolean, threadName?: string): CallToolResult | null {
    if(createThread && !threadName) {
        logger.warn({ createThread, threadName }, 'Discord tool returned error: threadName required when createThread is true');
        return {
            content: [{ type: 'text' as const, text: 'Error: threadName is required when createThread is true' }],
            isError: true,
        };
    }
    return null;
}

/**
 * Helper: Fetches and validates a Discord channel.
 * Returns the channel or an error result.
 */
async function fetchAndValidateChannel(
    client: Client,
    channelId: string
): Promise<{ channel: TextChannel } | { error: CallToolResult }> {
    const channel = await withDiscordRetry(
        () => client.channels.fetch(channelId),
        // Stryker disable next-line StringLiteral: Operation name for logging
        'fetchChannel'
    );

    if(!channel) {
        logger.warn({ channelId }, 'Discord tool returned error: Channel not found');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel not found' }],
                isError: true,
            }
        };
    }

    // Stryker disable all: Integration code - Discord channel validation
    if(!channel.isTextBased()) {
        logger.warn({ channelId }, 'Discord tool returned error: Channel is not text-based');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel is not a text-based channel' }],
                isError: true,
            }
        };
    }
    // Stryker restore all

    return { channel: channel as TextChannel };
}

/**
 * Helper: Sends a message to a Discord channel, with optional reply.
 * Returns the sent message.
 */
async function sendMessage(
    channel: TextChannel,
    content: string,
    replyToMessageId?: string
): Promise<Message> {
    if(replyToMessageId) {
        const originalMessage = await withDiscordRetry(
            () => channel.messages.fetch(replyToMessageId),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'fetchMessage'
        );
        return withDiscordRetry(
            () => originalMessage.reply(content),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'replyToMessage'
        );
    }

    return withDiscordRetry(
        () => channel.send(content),
        // Stryker disable next-line StringLiteral: Operation name for logging
        'sendMessage'
    );
}

/**
 * Helper: Creates a thread for a message if requested and supported.
 * Returns the thread ID or undefined.
 */
async function createThreadIfRequested(
    channel: TextChannel,
    sentMessage: Message,
    createThread?: boolean,
    threadName?: string
): Promise<string | undefined> {
    if(!createThread || !threadName) {
        return undefined;
    }

    // Check if channel supports threads (not DM channels or thread-incapable channels)
    // Stryker disable next-line ConditionalExpression,LogicalOperator: All conditions required for thread capability check
    if('threads' in channel && channel.isTextBased() && !channel.isThread() && !channel.isDMBased()) {
        const thread = await withDiscordRetry(
            () => sentMessage.startThread({ name: threadName }),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'startThread'
        );
        return thread.id;
    }

    return undefined;
}

/**
 * Helper: Validates options count for askUserQuestion.
 * Returns error result if options exceed Discord's 25-button limit, null otherwise.
 */
function validateQuestionOptions(options?: { label: string, value: string }[]): CallToolResult | null {
    // Stryker disable next-line EqualityOperator: 25 options is valid max
    if(options && options.length > 25) {
        logger.warn({ optionCount: options.length }, 'Discord tool returned error: Too many options (max 25)');
        return {
            content: [{ type: 'text' as const, text: 'Error: Too many options. Discord allows a maximum of 25 buttons (5 rows × 5 buttons per row).' }],
            isError: true,
        };
    }
    return null;
}

/**
 * Helper: Normalizes a channel ID, converting thread IDs to their parent channel.
 * Returns normalized channel ID, existing thread ID (if any), and the parent channel.
 */
async function normalizeChannelId(
    client: Client,
    channelId: string
): Promise<{
    normalizedChannelId: string
    existingThreadId?:   string
    channel:             TextChannel
} | { error: CallToolResult }> {
    const fetchedChannel = await withDiscordRetry(
        () => client.channels.fetch(channelId),
        // Stryker disable next-line StringLiteral: Operation name for logging
        'fetchChannel'
    );

    if(!fetchedChannel) {
        logger.warn({ channelId }, 'Discord tool returned error: Channel not found in normalizeChannelId');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel not found' }],
                isError: true,
            }
        };
    }

    let normalizedChannelId = channelId;
    let existingThreadId: string | undefined;

    // Stryker disable all: Integration code - Thread normalization and channel validation
    if(fetchedChannel.isThread()) {
        normalizedChannelId = fetchedChannel.parentId ?? channelId;
        existingThreadId = fetchedChannel.id;
    }

    const channel = fetchedChannel.isThread()
        ? await withDiscordRetry(
            () => client.channels.fetch(normalizedChannelId),
            'fetchParentChannel'
        )
        : fetchedChannel;

    if(!channel) {
        logger.warn({ normalizedChannelId }, 'Discord tool returned error: Parent channel not found');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Parent channel not found' }],
                isError: true,
            }
        };
    }

    if(!channel.isTextBased()) {
        logger.warn({ normalizedChannelId }, 'Discord tool returned error: Parent channel is not text-based');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel is not a text-based channel' }],
                isError: true,
            }
        };
    }
    // Stryker restore all

    return {
        normalizedChannelId,
        existingThreadId,
        channel: channel as TextChannel,
    };
}

/**
 * Helper: Prepares the target channel for sending a question, handling existing threads or creating new ones.
 * Returns the target channel and thread ID (if any).
 */
// Stryker disable all: Integration code - Thread preparation
async function prepareQuestionChannel(
    fetchedChannel: ReturnType<Client['channels']['fetch']> extends Promise<infer T> ? T : never,
    channel: TextChannel,
    existingThreadId?: string,
    createThread?: boolean,
    threadName?: string
): Promise<{ targetChannel: TextChannel, threadId?: string }> {
    if(existingThreadId) {
        // Already in a thread - use it
        return {
            targetChannel: fetchedChannel as TextChannel,
            threadId:      existingThreadId,
        };
    }

    if(createThread && 'threads' in channel) {
        const thread = await withDiscordRetry(
            () => channel.threads.create({
                name: threadName ?? 'Q&A'
            }),
            'createThread'
        );
        return {
            targetChannel: thread as unknown as TextChannel,
            threadId:      thread.id,
        };
    }

    return { targetChannel: channel };
}
// Stryker restore all

/**
 * Helper: Builds message options for a question, including optional mention and buttons.
 */
function buildQuestionMessage(
    questionId: string,
    question: string,
    targetUserId?: string,
    options?: { label: string, value: string }[]
): MessageCreateOptions {
    let questionContent = question;
    if(targetUserId) {
        questionContent = `<@${targetUserId}> ${question}`;
    }

    const messageOptions: MessageCreateOptions = { content: questionContent };

    if(options && options.length > 0) {
        messageOptions.components = buildQuestionButtons({ questionId, options });
    }

    return messageOptions;
}

/**
 * Helper: Registers a question with the question registry and waits for response.
 * Returns the registration result.
 */
async function registerAndWaitForAnswer(
    questionRegistry: QuestionRegistry,
    params: {
        questionId:          string
        normalizedChannelId: string
        threadId?:           string
        sentMessage:         Message
        currentUserId?:      UserId
        clientUser:          Client['user']
        question:            string
        options?:            { label: string, value: string }[]
        targetUserId?:       string
        timeoutSeconds?:     number
    }
): Promise<Awaited<ReturnType<QuestionRegistry['register']>>> {
    // Stryker disable next-line ArithmeticOperator,LogicalOperator: Timeout conversion
    const timeoutMs = (params.timeoutSeconds ?? 300) * 1000;

    return questionRegistry.register({
        questionId:      params.questionId,
        channelId:       createChannelId(params.normalizedChannelId),
        threadId:        params.threadId,
        originMessageId: params.sentMessage.id,
        // Stryker disable all: Fallback chain for triggerUserId
        triggerUserId:   params.currentUserId
          ?? (params.clientUser ? createUserId(params.clientUser.id) : createUserId('system')),
        // Stryker restore all
        questionText: params.question,
        options:      params.options,
        targetUserId: params.targetUserId ? createUserId(params.targetUserId) : undefined,
        createdAt:    Date.now(),
        // Stryker disable next-line ArithmeticOperator: Expiration calculation
        expiresAt:    Date.now() + timeoutMs,
    });
}

/**
 * Helper: Formats the result of a question for the MCP tool response.
 * Handles both timeout and success cases with appropriate logging.
 */
function formatQuestionResult(
    result: Awaited<ReturnType<QuestionRegistry['register']>>,
    questionId: string,
    channelId: string,
    threadId?: string
): CallToolResult {
    if(result.timedOut) {
        // Stryker disable all: Logger info object
        logger.info({
            questionId,
            channelId,
            threadId,
            msg: 'Question timed out without answer',
        });
        // Stryker restore all

        // Stryker disable all: Tool response object
        return {
            content: [{ type: 'text' as const, text: JSON.stringify({
                questionId: result.questionId,
                timedOut:   true,
                message:    'Question timed out without response',
                channelId:  result.channelId,
                threadId:   result.threadId,
            }) }],
        };
        // Stryker restore all
    }

    // Stryker disable all: Logger info object
    logger.info({
        questionId,
        channelId:         result.channelId,
        threadId:          result.threadId,
        responderId:       result.answer?.responderId,
        hasSelectedOption: Boolean(result.answer?.selectedOption),
        msg:               'Question answered',
    });
    // Stryker restore all

    return {
        content: [{ type: 'text' as const, text: JSON.stringify({
            questionId:     result.questionId,
            answer:         result.answer?.content,
            selectedOption: result.answer?.selectedOption,
            responderId:    result.answer?.responderId,
            channelId:      result.channelId,
            threadId:       result.threadId,
            timedOut:       false,
        }) }],
    };
}

/**
 * Creates an MCP server for Discord message history and message sending operations.
 *
 * Provides tools for:
 * - Searching messages by text, time range, or both
 * - Getting recent messages from a channel
 * - Fetching specific messages by ID
 * - Sending messages to Discord channels
 * - Asking questions and waiting for user responses
 *
 * This server wraps the MessageSearchService and Discord client for use with the Claude Agent SDK.
 */
export function createDiscordMCPServer(
    searchService: MessageSearchService,
    client: Client,
    questionRegistry: QuestionRegistry
) {
    return createSdkMcpServer({
        name:    'discord',
        version: '1.0.0',
        tools:   [
            tool(
                'searchMessages',
                'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID to search in'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    query:     z.string().optional().describe('Text to search for in message content'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    startTime: z.string().optional().describe('Start of time range (ISO 8601 format)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    endTime:   z.string().optional().describe('End of time range (ISO 8601 format)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().max(100).optional().describe('Maximum messages to return (default 10, max 100)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await searchService.searchMessages({
                            channelId: args.channelId,
                            query:     args.query,
                            startTime: args.startTime ? new Date(args.startTime) : undefined,
                            endTime:   args.endTime ? new Date(args.endTime) : undefined,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value
                            limit:     args.limit ?? 10,
                        });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'searchMessages', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'getRecentMessages',
                'Get the most recent messages from a Discord channel',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().max(100).optional().describe('Number of messages to return (default 10, max 100)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const result = await searchService.getRecentMessages(
                            args.channelId,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value, tested via integration
                            args.limit ?? 10
                        );
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'getRecentMessages', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'getMessageById',
                'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    messageId: z.union([z.string(), z.array(z.string())]).describe('Discord message ID or array of message IDs'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Handle array input
                        if(_.isArray(args.messageId)) {
                            const results = await searchService.getMessagesById(
                                args.channelId,
                                args.messageId
                            );
                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
                            };
                        }

                        // Handle single string input (existing logic)
                        const result = await searchService.getMessageById(
                            args.channelId,
                            args.messageId
                        );
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: 'Message not found' }],
                            };
                        }
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'getMessageById', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'sendDiscordMessage',
                'Send a message to a Discord channel. Use this to communicate with users during processing.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId:        z.string().describe('Target channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    content:          z.string().describe('Message content (max 2000 chars)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    replyToMessageId: z.string().optional().describe('Optional message ID to reply to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    createThread:     z.boolean().optional().describe('Create a new thread for this message'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    threadName:       z.string().optional().describe('Thread name (required if createThread is true)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Validate inputs
                        const threadError = validateThreadCreation(args.createThread, args.threadName);
                        if(threadError) {
                            return threadError;
                        }

                        // Fetch and validate channel
                        const channelResult = await fetchAndValidateChannel(client, args.channelId);
                        if('error' in channelResult) {
                            return channelResult.error;
                        }

                        // Split message into chunks
                        const chunks = splitMessage(args.content);
                        const sentMessages: Message[] = [];

                        // Send first chunk (with reply if specified)
                        const firstMessage = await sendMessage(
                            channelResult.channel,
                            chunks[0],
                            args.replyToMessageId
                        );
                        sentMessages.push(firstMessage);

                        // Send remaining chunks (no reply reference)
                        // Stryker disable next-line EqualityOperator: Inverted loop condition creates infinite loop
                        for(let i = 1; i < chunks.length; i++) {
                            const msg = await sendMessage(channelResult.channel, chunks[i]);
                            sentMessages.push(msg);
                        }

                        // Create thread if requested (on first message only)
                        const threadId = await createThreadIfRequested(
                            channelResult.channel,
                            firstMessage,
                            args.createThread,
                            args.threadName
                        );

                        const result = {
                            success:     true,
                            messageIds:  _.map(sentMessages, 'id'),
                            chunksCount: chunks.length,
                            ...(threadId && { threadId }),
                        };

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'sendDiscordMessage', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),

            tool(
                'askUserQuestion',
                'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit).',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId:      z.string().describe('Channel to ask in'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    question:       z.string().describe('Question text'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    options:        z.array(questionOptionSchema).optional().describe('Optional button choices for the user'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    timeoutSeconds: z.number().optional().describe('Timeout in seconds (default: 300)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    createThread:   z.boolean().optional().describe('Create a thread for this Q&A'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    threadName:     z.string().optional().describe('Thread name if creating thread'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    targetUserId:   z.string().optional().describe('Optional user ID to @mention in the question. Advisory only - anyone can answer.'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // 1. Validate options count
                        const optionsError = validateQuestionOptions(args.options);
                        if(optionsError) {
                            return optionsError;
                        }

                        // 2. Normalize channel ID (handles threads)
                        const normalizeResult = await normalizeChannelId(client, args.channelId);
                        if('error' in normalizeResult) {
                            return normalizeResult.error;
                        }

                        const { normalizedChannelId, existingThreadId, channel } = normalizeResult;

                        // 3. Build message with optional buttons
                        const questionId = randomUUID();
                        const messageOptions = buildQuestionMessage(
                            questionId,
                            args.question,
                            args.targetUserId,
                            args.options
                        );

                        // 4. Prepare target channel (existing thread or create new)
                        const { targetChannel, threadId } = await prepareQuestionChannel(
                            existingThreadId ? await client.channels.fetch(existingThreadId) : channel,
                            channel,
                            existingThreadId,
                            args.createThread,
                            args.threadName
                        );

                        // 5. Send question
                        const sentMessage = await withDiscordRetry(
                            () => targetChannel.send(messageOptions),
                            // Stryker disable next-line StringLiteral: Operation name for logging
                            'sendQuestion'
                        );

                        // Stryker disable all: Logger info object
                        logger.info({
                            questionId,
                            channelId:    args.channelId,
                            threadId,
                            targetUserId: args.targetUserId,
                            hasOptions:   Boolean(args.options?.length),
                            optionCount:  args.options?.length ?? 0,
                            msg:          'Question asked via MCP tool',
                        });
                        // Stryker restore all

                        // 6. Register question and wait for answer
                        const result = await registerAndWaitForAnswer(questionRegistry, {
                            questionId,
                            normalizedChannelId,
                            threadId,
                            sentMessage,
                            currentUserId:  conversationContext.currentUserId,
                            clientUser:     client.user,
                            question:       args.question,
                            options:        args.options,
                            targetUserId:   args.targetUserId,
                            timeoutSeconds: args.timeoutSeconds,
                        });

                        // 7. Format and return result
                        return formatQuestionResult(result, questionId, args.channelId, threadId);
                    } catch (error) {
                        // Stryker disable all: Error handling path
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'askUserQuestion', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                        // Stryker restore all
                    }
                }
            ),

            tool(
                'addReaction',
                'Add one or more emoji reactions to a Discord message',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    messageId: z.string().describe('Discord message ID to react to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    emoji:     z.union([z.string(), z.array(z.string())]).describe('Emoji or array of emojis to react with (e.g., "👍" or ["👍", "❤️"])'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Fetch and validate channel
                        const channelResult = await fetchAndValidateChannel(client, args.channelId);
                        if('error' in channelResult) {
                            return channelResult.error;
                        }

                        // Fetch the message
                        const message = await withDiscordRetry(
                            () => channelResult.channel.messages.fetch(args.messageId),
                            // Stryker disable next-line StringLiteral: Operation name for logging
                            'fetchMessage'
                        );

                        if(!message) {
                            logger.warn({ tool: 'addReaction', channelId: args.channelId, messageId: args.messageId }, 'Discord tool returned error: Message not found');
                            return {
                                content: [{ type: 'text' as const, text: 'Error: Message not found' }],
                                isError: true,
                            };
                        }

                        // Normalize emoji to array
                        const emojis = _.isArray(args.emoji) ? args.emoji : [args.emoji];

                        // Add reactions sequentially
                        const addedEmojis: string[] = [];
                        const failedEmojis: { emoji: string, error: string }[] = [];

                        for(const emoji of emojis) {
                            try {
                                await withDiscordRetry(
                                    () => message.react(emoji),
                                    // Stryker disable next-line StringLiteral: Operation name for logging
                                    'addReaction'
                                );
                                addedEmojis.push(emoji);
                            } catch (error) {
                                const errorMessage = _.isError(error) ? error.message : String(error);
                                failedEmojis.push({ emoji, error: errorMessage });
                            }
                        }

                        const result = {
                            success:      failedEmojis.length === 0,
                            addedEmojis,
                            failedEmojis: failedEmojis.length > 0 ? failedEmojis : undefined,
                            channelId:    args.channelId,
                            messageId:    args.messageId,
                        };

                        if(failedEmojis.length > 0) {
                            logger.warn({ tool: 'addReaction', channelId: args.channelId, messageId: args.messageId, failedEmojis }, 'Discord tool returned partial error: Some reactions failed');
                        }

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                            ...(failedEmojis.length > 0 && { isError: true }),
                        };
                    } catch (error) {
                        const message = _.isError(error) ? error.message : String(error);
                        logger.warn({ tool: 'addReaction', error: message, channelId: args.channelId, messageId: args.messageId }, 'Discord tool returned error');
                        return {
                            content: [{ type: 'text' as const, text: `Error: ${message}` }],
                            isError: true,
                        };
                    }
                }
            ),
        ],
    });
}
