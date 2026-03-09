import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Client, TextChannel, Message, MessageCreateOptions } from 'discord.js';
import { z } from 'zod';
// eslint-disable-next-line no-warning-comments, sonarjs/todo-tag -- tracked in roadmap, not forgotten
// TODO: Decouple - Discord MCP server should expose platform-agnostic MCP tool interfaces wrapping messaging platform capabilities
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord message history; decouple per roadmap
import { buildQuestionButtons } from '../integrations/discord/button-builder';
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord channel registry; decouple per roadmap
import { type ChannelRegistryManager, DMTracker, resolveChannelId  } from '../integrations/discord/channel-registry';
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord message history; decouple per roadmap
import type { MessageSearchService } from '../integrations/discord/message-history/search';
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord messages; decouple per roadmap
import { splitMessage } from '../integrations/discord/messages';
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord retry; decouple per roadmap
import { withDiscordRetry } from '../integrations/discord/retry';
// eslint-disable-next-line boundaries/element-types, boundaries/entry-point -- Discord MCP server imports Discord types; decouple per roadmap
import { createChannelId, createUserId, type UserId, type ChannelId } from '../integrations/discord/types';
import { mcpErrorResult } from './mcp-helpers';
import { type QuestionRegistry, questionOptionSchema  } from './question-registry';
import { validateFilePaths, PathSecurityError, formatLocalDateTime } from '@/utils';

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
        // Stryker disable next-line all: Logging for observability
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
        // Stryker disable next-line all: Logging for observability
        logger.warn({ channelId }, 'Discord tool returned error: Channel not found');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel not found' }],
                isError: true,
            }
        };
    }

    if(!channel.isTextBased()) {
        // Stryker disable next-line all: Logging for observability
        logger.warn({ channelId }, 'Discord tool returned error: Channel is not text-based');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel is not a text-based channel' }],
                isError: true,
            }
        };
    }

    return { channel: channel as TextChannel };
}

/**
 * Helper: Sends a message to a Discord channel, with optional reply and files.
 * Returns the sent message.
 */
async function sendMessage(
    channel: TextChannel,
    content: string,
    replyToMessageId?: string,
    files?: string[]
): Promise<Message> {
    const messageOptions: MessageCreateOptions = { content };
    if(files && files.length > 0) {
        messageOptions.files = files;
    }

    if(replyToMessageId) {
        const originalMessage = await withDiscordRetry(
            () => channel.messages.fetch(replyToMessageId),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'fetchMessage'
        );
        return withDiscordRetry(
            () => originalMessage.reply(messageOptions),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'replyToMessage'
        );
    }

    return withDiscordRetry(
        () => channel.send(messageOptions),
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
        // Stryker disable next-line all: Logging for observability
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
        // Stryker disable next-line all: Logging for observability
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

    if(fetchedChannel.isThread()) {
        normalizedChannelId = fetchedChannel.parentId ?? channelId;
        existingThreadId = fetchedChannel.id;
    }

    const channel = fetchedChannel.isThread()
        ? await withDiscordRetry(
            () => client.channels.fetch(normalizedChannelId),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'fetchParentChannel'
        )
        : fetchedChannel;

    if(!channel) {
        // Stryker disable next-line all: Logging for observability
        logger.warn({ normalizedChannelId }, 'Discord tool returned error: Parent channel not found');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Parent channel not found' }],
                isError: true,
            }
        };
    }

    if(!channel.isTextBased()) {
        // Stryker disable next-line all: Logging for observability
        logger.warn({ normalizedChannelId }, 'Discord tool returned error: Parent channel is not text-based');
        return {
            error: {
                content: [{ type: 'text' as const, text: 'Error: Channel is not a text-based channel' }],
                isError: true,
            }
        };
    }

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

    // Stryker disable next-line LogicalOperator: Both conditions required - createThread flag AND channel capability
    if(createThread && 'threads' in channel) {
        const thread = await withDiscordRetry(
            () => channel.threads.create({
                // Stryker disable next-line LogicalOperator,StringLiteral: Fallback chain for thread name with default
                name: threadName ?? 'Q&A'
            }),
            // Stryker disable next-line StringLiteral: Operation name for logging
            'createThread'
        );
        return {
            targetChannel: thread as unknown as TextChannel,
            threadId:      thread.id,
        };
    }

    return { targetChannel: channel };
}

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
        triggerUserId:   params.currentUserId
          ?? (params.clientUser ? createUserId(params.clientUser.id) : createUserId('system')),
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
        // Stryker disable ObjectLiteral,StringLiteral: Logger info object - content not behavior-affecting
        logger.info({
            questionId,
            channelId,
            threadId,
            msg: 'Question timed out without answer',
        });
        // Stryker restore ObjectLiteral,StringLiteral

        return {
            content: [{ type: 'text' as const, text: JSON.stringify({
                questionId: result.questionId,
                timedOut:   true,
                message:    'Question timed out without response',
                channelId:  result.channelId,
                threadId:   result.threadId,
            }) }],
        };
    }

    // Stryker disable ObjectLiteral,StringLiteral: Logger info object - content not behavior-affecting
    logger.info({
        questionId,
        channelId:         result.channelId,
        threadId:          result.threadId,
        responderId:       result.answer?.responderId,
        hasSelectedOption: Boolean(result.answer?.selectedOption),
        msg:               'Question answered',
    });
    // Stryker restore ObjectLiteral,StringLiteral

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
 *
 * @param searchService Message search service for querying Discord message history
 * @param client Discord.js client for sending messages and fetching channel data
 * @param questionRegistry Registry for tracking pending questions awaiting user responses
 * @param channelRegistry Channel registry manager for DM channel and user metadata
 * @param timezone Server timezone for localTimestamp enrichment. The MCP server is a
 *                 shared, session-level resource created at startup. Per-user timezone
 *                 would require threading user context into each tool call. The agent's
 *                 prompts and message formatting use per-user timezone where available.
 */
export function createDiscordMCPServer(
    searchService: MessageSearchService,
    client: Client,
    questionRegistry: QuestionRegistry,
    channelRegistry: ChannelRegistryManager,
    timezone?: string
) {
    // Create DMTracker for username resolution (requires channelRegistry)
    const dmTracker = new DMTracker(channelRegistry, client);

    return createSdkMcpServer({
        name:    'discord',
        version: '1.0.0',
        tools:   [
            tool(
                'searchMessages',
                'Search Discord message history by text, time range, or both. Returns messages with overflow summaries if results exceed limit. Accepts channel ID or #channel-name format.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
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
                        const channelId = resolveChannelId(args.channelId, channelRegistry);
                        const result = await searchService.searchMessages({
                            channelId,
                            query:     args.query,
                            startTime: args.startTime ? new Date(args.startTime) : undefined,
                            endTime:   args.endTime ? new Date(args.endTime) : undefined,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value
                            limit:     args.limit ?? 10,
                        });

                        // Enrich messages with local timestamps if timezone is provided
                        if(timezone) {
                            for(const msg of result.messages) {
                                msg.localTimestamp = formatLocalDateTime(msg.timestamp, timezone);
                            }
                        }

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'searchMessages', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'getRecentMessages',
                'Get the most recent messages from a Discord channel. Returns the N most recent messages plus an overflow count. Use searchMessages with time range for AI summaries of older messages. Accepts channel ID or #channel-name format.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    limit:     z.number().int().positive().max(100).optional().describe('Number of messages to return (default 10, max 100)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const channelId = resolveChannelId(args.channelId, channelRegistry);
                        const result = await searchService.getRecentMessages(
                            channelId,
                            // Stryker disable next-line LogicalOperator: ?? operator provides default value, tested via integration
                            args.limit ?? 10
                        );

                        // Enrich messages with local timestamps if timezone is provided
                        if(timezone) {
                            for(const msg of result.messages) {
                                msg.localTimestamp = formatLocalDateTime(msg.timestamp, timezone);
                            }
                        }

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'getRecentMessages', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'getMessageById',
                'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs. Accepts channel ID or #channel-name format.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    messageId: z.union([z.string(), z.array(z.string())]).describe('Discord message ID or array of message IDs'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const channelId = resolveChannelId(args.channelId, channelRegistry);
                        // Handle array input
                        if(Array.isArray(args.messageId)) {
                            const results = await searchService.getMessagesById(
                                channelId,
                                args.messageId
                            );

                            // Enrich messages with local timestamps if timezone is provided
                            if(timezone) {
                                for(const msg of results) {
                                    msg.localTimestamp = formatLocalDateTime(msg.timestamp, timezone);
                                }
                            }

                            return {
                                content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
                            };
                        }

                        // Handle single string input (existing logic)
                        const result = await searchService.getMessageById(
                            channelId,
                            args.messageId
                        );
                        if(!result) {
                            return {
                                content: [{ type: 'text' as const, text: 'Message not found' }],
                            };
                        }

                        // Enrich message with local timestamp if timezone is provided
                        if(timezone) {
                            result.localTimestamp = formatLocalDateTime(result.timestamp, timezone);
                        }

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'getMessageById', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'sendDiscordMessage',
                `Send a message to a Discord channel or DM to a user. Use this to communicate with users.

CRITICAL: Only use channel IDs from:
1. The channelId in a message you're responding to (preferred)
2. Your memory (/state/discord-channels)
3. Channel name: #general, #off-topic, etc.
4. @username format for DMs (e.g., "@alice" to send a DM)
5. Default: 1451694737026449581 (#general)

NEVER invent or guess channel IDs. If unsure, use #general.`,
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId:        z.string().describe('Target channel ID, #channel-name, or @username for DM - use from message context, memory, or default: 1451694737026449581 (#general)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    content:          z.string().describe('Message content (max 2000 chars)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    replyToMessageId: z.string().optional().describe('Optional message ID to reply to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    createThread:     z.boolean().optional().describe('Create a new thread for this message'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    threadName:       z.string().optional().describe('Thread name (required if createThread is true)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    files:            z.union([z.string(), z.array(z.string())]).optional().describe('File path(s) to attach. Must be inside the working directory (no symlinks).'),
                },
                // eslint-disable-next-line sonarjs/cognitive-complexity -- MCP tool handler validates inputs, resolves channels, sends chunks, and creates threads; branching is inherent to the multi-step protocol
                async (args): Promise<CallToolResult> => {
                    try {
                        // Validate inputs
                        const threadError = validateThreadCreation(args.createThread, args.threadName);
                        if(threadError) {
                            return threadError;
                        }

                        // Validate file paths if provided
                        let validatedFiles: string[] | undefined;
                        if(args.files) {
                            try {
                                validatedFiles = await validateFilePaths(args.files);
                            } catch (error) {
                                if(error instanceof PathSecurityError) {
                                    // Stryker disable next-line all: Logging parameters don't affect behavior
                                    logger.warn({ tool: 'sendDiscordMessage', error: error.message, path: error.context.path }, 'Discord tool returned security error');
                                    return {
                                        content: [{ type: 'text' as const, text: `Security Error: ${error.message}` }],
                                        isError: true,
                                    };
                                }
                                throw error;
                            }
                        }

                        // Resolve channel identifier (handle #channel-name and @username)
                        let resolvedChannelId: typeof args.channelId;

                        // First, check for @username (DM resolution)
                        if(args.channelId.startsWith('@')) {
                            const username = args.channelId.slice(1); // Remove @
                            const dmChannelId = await dmTracker.getOrCreateDMByUsername(username);
                            if(!dmChannelId) {
                                return {
                                    content: [{ type: 'text' as const, text: `Error: Could not find user @${username} in any server` }],
                                    isError: true,
                                };
                            }
                            resolvedChannelId = dmChannelId;
                        } else {
                            // If not @username, try to resolve as #channel-name or pass through numeric ID
                            resolvedChannelId = resolveChannelId(args.channelId, channelRegistry);
                        }

                        // Fetch and validate channel
                        const channelResult = await fetchAndValidateChannel(client, resolvedChannelId);
                        if('error' in channelResult) {
                            return channelResult.error;
                        }

                        // Split message into chunks
                        const chunks = splitMessage(args.content);
                        const sentMessages: Message[] = [];

                        // Send first chunk (with reply and files if specified)
                        const firstMessage = await sendMessage(
                            channelResult.channel,
                            chunks[0],
                            args.replyToMessageId,
                            validatedFiles
                        );
                        sentMessages.push(firstMessage);

                        // Send remaining chunks (no reply reference, no files)
                        // Stryker disable next-line EqualityOperator,UpdateOperator: Loop mutation would cause infinite loop
                        for(let i = 1; i < chunks.length; i++) {
                            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API
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
                            messageIds:  sentMessages.map(msg => msg.id),
                            chunksCount: chunks.length,
                            ...(threadId && { threadId }),
                            ...(validatedFiles && { filesAttached: validatedFiles.length }),
                        };

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'sendDiscordMessage', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'askUserQuestion',
                'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId:      z.string().describe('Channel to ask in - channel ID or #channel-name (e.g., #general)'),
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

                        // 2. Resolve channel name to ID if needed
                        const channelId = resolveChannelId(args.channelId, channelRegistry);

                        // 3. Normalize channel ID (handles threads)
                        const normalizeResult = await normalizeChannelId(client, channelId);
                        if('error' in normalizeResult) {
                            return normalizeResult.error;
                        }

                        const { normalizedChannelId, existingThreadId, channel } = normalizeResult;

                        // 4. Build message with optional buttons
                        const questionId = randomUUID();
                        const messageOptions = buildQuestionMessage(
                            questionId,
                            args.question,
                            args.targetUserId,
                            args.options
                        );

                        // 5. Prepare target channel (existing thread or create new)
                        const { targetChannel, threadId } = await prepareQuestionChannel(
                            existingThreadId ? await client.channels.fetch(existingThreadId) : channel,
                            channel,
                            existingThreadId,
                            args.createThread,
                            args.threadName
                        );

                        // 6. Send question
                        const sentMessage = await withDiscordRetry(
                            () => targetChannel.send(messageOptions),
                            // Stryker disable next-line StringLiteral: Operation name for logging
                            'sendQuestion'
                        );

                        // Stryker disable ObjectLiteral,StringLiteral,LogicalOperator: Logger info object - content not behavior-affecting
                        logger.info({
                            questionId,
                            channelId:    args.channelId,
                            threadId,
                            targetUserId: args.targetUserId,
                            hasOptions:   Boolean(args.options?.length),
                            optionCount:  args.options?.length ?? 0,
                            msg:          'Question asked via MCP tool',
                        });
                        // Stryker restore ObjectLiteral,StringLiteral,LogicalOperator

                        // 7. Register question and wait for answer
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

                        // 8. Format and return result
                        return formatQuestionResult(result, questionId, args.channelId, threadId);
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'askUserQuestion', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'addReaction',
                'Add one or more emoji reactions to a Discord message. Accepts channel ID or #channel-name format.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    messageId: z.string().describe('Discord message ID to react to'),
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    emoji:     z.union([z.string(), z.array(z.string())]).describe('Emoji or array of emojis to react with (e.g., "👍" or ["👍", "❤️"])'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Resolve channel name to ID if needed
                        const channelId = resolveChannelId(args.channelId, channelRegistry);

                        // Fetch and validate channel
                        const channelResult = await fetchAndValidateChannel(client, channelId);
                        if('error' in channelResult) {
                            return channelResult.error;
                        }

                        // Fetch the message
                        const message = await withDiscordRetry(
                            () => channelResult.channel.messages.fetch(args.messageId),
                            // Stryker disable next-line StringLiteral: Operation name for logging
                            'fetchMessage'
                        );

                        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Discord.js types fetch() as non-nullable but runtime may return falsy
                        if(!message) {
                            // Stryker disable next-line all: Logging for observability
                            logger.warn({ tool: 'addReaction', channelId: args.channelId, messageId: args.messageId }, 'Discord tool returned error: Message not found');
                            return {
                                content: [{ type: 'text' as const, text: 'Error: Message not found' }],
                                isError: true,
                            };
                        }

                        // Normalize emoji to array
                        const emojis = Array.isArray(args.emoji) ? args.emoji : [args.emoji];

                        // Add reactions sequentially
                        const addedEmojis: string[] = [];
                        const failedEmojis: { emoji: string, error: string }[] = [];

                        for(const emoji of emojis) {
                            try {
                                // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API
                                await withDiscordRetry(
                                    () => message.react(emoji),
                                    // Stryker disable next-line StringLiteral: Operation name for logging
                                    'addReaction'
                                );
                                addedEmojis.push(emoji);
                            } catch (error) {
                                const errorMessage = error instanceof Error ? error.message : String(error);
                                failedEmojis.push({ emoji, error: errorMessage });
                            }
                        }

                        const result = {
                            success:      failedEmojis.length === 0,
                            addedEmojis,
                            // Stryker disable next-line ConditionalExpression,EqualityOperator: Check needed to conditionally include failedEmojis
                            failedEmojis: failedEmojis.length > 0 ? failedEmojis : undefined,
                            channelId:    args.channelId,
                            messageId:    args.messageId,
                        };

                        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Logging for observability
                        if(failedEmojis.length > 0) {
                            // Stryker disable next-line all: Logging parameters don't affect behavior
                            logger.warn({ tool: 'addReaction', channelId: args.channelId, messageId: args.messageId, failedEmojis }, 'Discord tool returned partial error: Some reactions failed');
                        }

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                            // Stryker disable next-line ConditionalExpression,EqualityOperator,LogicalOperator: Conditional isError flag
                            ...(failedEmojis.length > 0 && { isError: true }),
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'addReaction', error: message, channelId: args.channelId, messageId: args.messageId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'muteChannel',
                // Stryker disable next-line StringLiteral: Tool description is documentation only
                'Mute a Discord channel so the bot will not respond to messages in it. Use this when you want to observe a channel without participating. Accepts either a numeric channel ID or channel name with # prefix (e.g., #general).',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or name with # prefix (e.g., #general)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const channelId = resolveChannelId(args.channelId, channelRegistry);
                        await channelRegistry.muteChannel(channelId);
                        // Stryker disable next-line all: Logging for observability
                        logger.info({ tool: 'muteChannel', channelId, msg: 'Channel muted' });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, muted: true }) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'muteChannel', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'unmuteChannel',
                // Stryker disable next-line StringLiteral: Tool description is documentation only
                'Unmute a Discord channel so the bot will respond to messages in it again. Accepts either a numeric channel ID or channel name with # prefix (e.g., #general).',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    channelId: z.string().describe('Discord channel ID or name with # prefix (e.g., #general)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        const channelId = resolveChannelId(args.channelId, channelRegistry);
                        await channelRegistry.unmuteChannel(channelId);
                        // Stryker disable next-line all: Logging for observability
                        logger.info({ tool: 'unmuteChannel', channelId, msg: 'Channel unmuted' });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, muted: false }) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'unmuteChannel', error: message, channelId: args.channelId }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'listChannels',
                // Stryker disable next-line StringLiteral: Tool description is documentation only
                'List all channels the bot is tracking, with their mute status. Use this to see available channels.',
                {
                    // Stryker disable next-line StringLiteral: describe() is documentation only
                    includesMuted: z.boolean().optional().describe('Include muted channels in the list (default: false)'),
                },
                async (args): Promise<CallToolResult> => {
                    try {
                        // Get channels based on includesMuted parameter (default false)
                        const includesMuted = args.includesMuted === true;
                        const channels = includesMuted
                            ? channelRegistry.getAllChannels()
                            : await channelRegistry.getUnmutedChannels();

                        // Format output
                        const formatted = channels.map(ch => ({
                            channelId:     ch.channelId,
                            channelName:   ch.channelName,
                            guildId:       ch.guildId,
                            isMuted:       ch.isMuted,
                            wellKnownType: ch.isWellKnown,
                        }));

                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ channels: formatted, count: formatted.length }) }],
                        };
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Stryker disable next-line all: Logging for observability
                        logger.warn({ tool: 'listChannels', error: message }, 'Discord tool returned error');
                        return mcpErrorResult(error);
                    }
                },
                // Stryker disable next-line ObjectLiteral: Tool annotations are MCP server configuration
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),
        ],
    });
}
