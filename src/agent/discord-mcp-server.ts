import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
// eslint-disable-next-line no-restricted-imports -- Discord MCP adapter hosted in src/agent by convention; the sole #40 fence exemption
import type { Client, TextChannel, GuildTextBasedChannel, Message, MessageCreateOptions } from 'discord.js';
import { z } from 'zod';
import type { DiscordMcpChannelRegistry, MCPDMTracker, MCPMessageSearchService, MCPMessageSplitter, MCPOutboundMessageSender, MCPOutboundSendResult, MCPRetryHelper } from './discord-ports';
import { checkServiceHealth, mcpJsonResult, withHealthGuard, withToolErrorHandling } from './mcp-helpers';
import { type QuestionRegistry, questionOptionSchema  } from './question-registry';
import { createChannelId, createUserId, type ChannelId, type UserId } from './types';
import { InvariantViolationError, PathSecurityError } from '@/errors';
import type { ServiceHealthRegistry, ReconnectionLoop } from '@/services';
import type { PersonAllowlist } from '@/storage';
import { validateFilePaths, formatLocalDateTime } from '@/utils';

/** Button-builder port for question messages sent by the Discord MCP server. */
interface MCPQuestionButtonBuilder {
    buildQuestionButtons(config: { questionId: string, options: { label: string, value: string }[] }): NonNullable<MessageCreateOptions['components']>
}

/**
 * Validates a tool-supplied requestingUserId against the person allowlist.
 *
 * Returns the validated UserId to use as currentUserId, or undefined to let the
 * caller fall back to client.user?.id ?? 'system'. Falls back (with a logged
 * warning) when requestingUserId is set but not allowlisted, rather than trusting
 * a hallucinated id as the question's triggerUserId. When no allowlist is
 * configured, any explicitly given requestingUserId is accepted (fail-open,
 * matching the bsky/email MCP servers' allowlist convention). An empty string is
 * treated the same as an absent argument (no warning) rather than reaching
 * createUserId, whose non-empty validation would otherwise throw.
 *
 * @param requestingUserId - Raw user id from the tool argument, if given
 * @param personAllowlist - Optional person allowlist to validate against
 */
function validateRequestingUserId(
    requestingUserId: string | undefined,
    personAllowlist: PersonAllowlist | undefined
): UserId | undefined {
    if(!requestingUserId) {
        return undefined;
    }
    if(!personAllowlist || personAllowlist.isAllowed('discord', requestingUserId)) {
        return createUserId(requestingUserId);
    }
    logger.warn({ requestingUserId }, 'askUserQuestion requestingUserId not allowlisted; falling back to client user id');
    return undefined;
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

/** Type guard: check if a channel/normalize result is an error result (has error property). */
function isErrorResult(result: unknown): result is { error: CallToolResult } {
    return typeof result === 'object' && result !== null && 'error' in result;
}

/** Add local time only to search records with a usable timestamp. */
function addLocalTimestamps(messages: unknown[], timezone: string): void {
    for(const message of messages) {
        // Stryker disable next-line llm: the fetcher emits Date.toISOString(), never ''; the only divergence is timestamp: '', where the original would carry Luxon's 'Invalid DateTime' sentinel, a wart not worth pinning.
        if(typeof message === 'object' && message !== null && 'timestamp' in message && typeof message.timestamp === 'string') {
            Object.assign(message, { localTimestamp: formatLocalDateTime(message.timestamp, timezone) });
        }
    }
}

/**
 * Helper: Fetches and validates a Discord channel.
 * Returns the channel or an error result.
 */
async function fetchAndValidateChannel(
    client: Client,
    channelId: string,
    retryHelper: MCPRetryHelper
): Promise<{ channel: TextChannel } | { error: CallToolResult }> {
    const channel = await retryHelper.withRetry(
        () => client.channels.fetch(channelId)
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

    // Stryker disable next-line llm: isTextBased() returns boolean, so negation and strict comparison with false agree.
    if(!channel.isTextBased()) {
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
    retryHelper: MCPRetryHelper,
    replyToMessageId?: string,
    files?: string[]
): Promise<Message> {
    const messageOptions: MessageCreateOptions = { content };
    // Stryker disable next-line llm: files is string[] or undefined, so both guards accept exactly the non-empty arrays.
    if(files && files.length > 0) {
        messageOptions.files = files;
    }

    if(replyToMessageId) {
        const originalMessage = await retryHelper.withRetry(
            // Stryker disable next-line llm: this branch establishes that replyToMessageId is truthy, making the empty-string fallback unreachable.
            () => channel.messages.fetch(replyToMessageId)
        );
        return retryHelper.withRetry(
            () => originalMessage.reply(messageOptions)
        );
    }

    return retryHelper.withRetry(
        () => channel.send(messageOptions)
    );
}

/**
 * Helper: Sends all message chunks to a channel, appending each confirmed Message to
 * `sentMessages` as it goes, so a caller can report what was sent when a later chunk fails.
 * Throws if chunks is empty (splitMessage invariant violation).
 */
async function sendAllChunks(
    channel: TextChannel,
    chunks: string[],
    retryHelper: MCPRetryHelper,
    sentMessages: Message[],
    replyToMessageId?: string,
    files?: string[]
): Promise<void> {
    const firstChunk = chunks[0];
    if(firstChunk === undefined) {
        throw new InvariantViolationError('sendAllChunks', 'splitMessage returned empty chunks array');
    }
    const firstMessage = await sendMessage(channel, firstChunk, retryHelper, replyToMessageId, files);
    // Stryker disable next-line ArrayMethodSwap: the caller passes an empty sentMessages, so this first insertion has the same order.
    sentMessages.push(firstMessage);
    for(let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        if(chunk === undefined) {
            throw new InvariantViolationError('sendAllChunks', 'chunks[i] undefined despite i < chunks.length');
        }
        // eslint-disable-next-line no-await-in-loop -- send chunks in order and return sent messages in that same order
        const msg = await sendMessage(channel, chunk, retryHelper);
        sentMessages.push(msg);
    }
}

/** Builds a single-text error result for a Discord MCP tool. */
function toolError(text: string): CallToolResult {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

const NEVER_QUEUED_NOTE = 'Messages with files or createThread are sent directly and never queued';

/**
 * Error for a direct send that threw part-way: a chunk whose response never arrived may still have
 * been posted, so this never claims nothing was sent, and it lists every confirmed message.
 */
function directSendFailure(error: unknown, sentMessages: Message[], chunkCount: number): CallToolResult {
    const message = error instanceof Error ? error.message : String(error);
    if(sentMessages.length === 0) {
        return toolError(`Error: delivery could not be confirmed: ${message}. ${NEVER_QUEUED_NOTE}; check the channel before sending again.`);
    }
    const ids = sentMessages.map(sent => sent.id).join(', ');
    return toolError(`Error: only the first ${sentMessages.length} of ${chunkCount} chunks were confirmed sent (messageIds: ${ids}); delivery of the rest could not be confirmed: ${message}. ${NEVER_QUEUED_NOTE}; check the channel before sending the rest again.`);
}

/** Error for a send that stopped before every chunk was confirmed and was not queued. */
function notSentError(result: { sentMessageIds: string[], chunkCount: number }, reason: string): CallToolResult {
    const sent = result.sentMessageIds.length;
    const prefix = sent === 0
        ? 'Error: message not sent'
        : `Error: only the first ${sent} of ${result.chunkCount} chunks were sent (messageIds: ${result.sentMessageIds.join(', ')}); the rest were not sent`;
    return toolError(`${prefix}: ${reason}`);
}

/** Maps an outbox-backed send result onto the sendDiscordMessage tool result Izzy sees. */
function formatOutboundResult(result: MCPOutboundSendResult): CallToolResult {
    switch(result.status) {
        case 'sent': {
            return mcpJsonResult({ success: true, status: 'sent', messageIds: result.messageIds, chunksCount: result.chunkCount });
        }
        case 'queued': {
            const sent = result.sentMessageIds.length;
            if(sent === 0) {
                return mcpJsonResult({
                    success:     true,
                    status:      'queued',
                    delivered:   false,
                    outboxId:    result.outboxId,
                    chunksCount: result.chunkCount,
                    note:        `Discord is unavailable. The message is queued (outbox id ${result.outboxId}) and will be delivered automatically when Discord is back. It has NOT been sent yet; do not send it again.`,
                });
            }
            return mcpJsonResult({
                success:     true,
                status:      'partially_sent',
                messageIds:  result.sentMessageIds,
                outboxId:    result.outboxId,
                chunksCount: result.chunkCount,
                note:        `The first ${sent} of ${result.chunkCount} chunks were sent. The rest are queued (outbox id ${result.outboxId}) and will be delivered automatically when Discord is back; they have NOT been sent yet, so do not send them again.`,
            });
        }
        case 'failed': {
            return notSentError(result, `${result.error}. It was not queued.`);
        }
        case 'unavailable': {
            return notSentError(result, 'Discord is unavailable and the message could not be queued.');
        }
    }
}

/**
 * Helper: Creates a thread for a message if requested and supported.
 * Returns the thread ID or undefined.
 */
async function createThreadIfRequested(
    channel: TextChannel,
    sentMessage: Message,
    retryHelper: MCPRetryHelper,
    createThread?: boolean,
    threadName?: string
): Promise<string | undefined> {
    if(!createThread || !threadName) {
        return undefined;
    }

    // Check if channel supports threads (not DM channels or thread-incapable channels)
    if('threads' in channel && channel.isTextBased() && !channel.isThread() && !channel.isDMBased()) {
        const thread = await retryHelper.withRetry(
            () => sentMessage.startThread({ name: threadName })
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
    channelId: string,
    retryHelper: MCPRetryHelper
): Promise<{
    normalizedChannelId: string
    existingThreadId?:   string
    channel:             TextChannel
} | { error: CallToolResult }> {
    const fetchedChannel = await retryHelper.withRetry(
        () => client.channels.fetch(channelId)
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

    if(fetchedChannel.isThread()) {
        // Stryker disable next-line llm: Discord thread parentId is null or a non-empty snowflake, so nullish and falsy fallback coincide.
        normalizedChannelId = fetchedChannel.parentId ?? channelId;
        existingThreadId = fetchedChannel.id;
    }

    const channel = fetchedChannel.isThread()
        ? await retryHelper.withRetry(
            () => client.channels.fetch(normalizedChannelId)
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
    retryHelper: MCPRetryHelper,
    existingThreadId?: string,
    createThread?: boolean,
    threadName?: string
): Promise<{ targetChannel: GuildTextBasedChannel, threadId?: string }> {
    if(existingThreadId) {
        // Already in a thread - use it
        return {
            // fetchedChannel is Channel|null resolved from client.channels.fetch(existingThreadId);
            // callers only pass existingThreadId when the channel is a guild text-based thread channel.
            targetChannel: fetchedChannel as GuildTextBasedChannel,
            threadId:      existingThreadId,
        };
    }

    if(createThread && 'threads' in channel) {
        const thread = await retryHelper.withRetry(
            () => channel.threads.create({
                name: threadName ?? 'Q&A'
            })
        );
        // thread is PublicThreadChannel<false>|PrivateThreadChannel, both satisfy GuildTextBasedChannel
        return {
            targetChannel: thread,
            threadId:      thread.id,
        };
    }

    // Stryker disable next-line llm: callers only read threadId by value, so an absent property and explicit undefined are indistinguishable.
    return { targetChannel: channel };
}

/**
 * Helper: Builds message options for a question, including optional mention and buttons.
 */
function buildQuestionMessage(
    questionId: string,
    question: string,
    buttonBuilder: MCPQuestionButtonBuilder,
    targetUserId?: string,
    options?: { label: string, value: string }[]
): MessageCreateOptions {
    let questionContent = question;
    if(targetUserId) {
        questionContent = `<@${targetUserId}> ${question}`;
    }

    const messageOptions: MessageCreateOptions = { content: questionContent };

    // Stryker disable next-line llm: options is an array or undefined, making both guards true exactly for non-empty arrays.
    if(options && options.length > 0) {
        messageOptions.components = buttonBuilder.buildQuestionButtons({ questionId, options });
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
    switch(result.state) {
        case 'answered': {
            logger.info({
                questionId,
                channelId:         result.channelId,
                threadId:          result.threadId,
                responderId:       result.answer.responderId,
                hasSelectedOption: Boolean(result.answer.selectedOption),
                msg:               'Question answered',
            });

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    questionId:     result.questionId,
                    state:          result.state,
                    answer:         result.answer.content,
                    selectedOption: result.answer.selectedOption,
                    responderId:    result.answer.responderId,
                    channelId:      result.channelId,
                    threadId:       result.threadId,
                    message:        'Question answered',
                }) }],
            };
        }

        case 'timed_out': {
            logger.info({
                questionId,
                channelId,
                threadId,
                msg: 'Question timed out without answer',
            });

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    questionId: result.questionId,
                    state:      result.state,
                    message:    'Question timed out without response',
                    channelId:  result.channelId,
                    threadId:   result.threadId,
                }) }],
            };
        }

        case 'cancelled': {
            logger.info({
                questionId,
                channelId: result.channelId,
                threadId:  result.threadId,
                reason:    result.reason,
                msg:       'Question cancelled',
            });

            return {
                content: [{ type: 'text' as const, text: JSON.stringify({
                    questionId: result.questionId,
                    state:      result.state,
                    reason:     result.reason,
                    message:    `Question cancelled: ${result.reason}`,
                    channelId:  result.channelId,
                    threadId:   result.threadId,
                }) }],
            };
        }
    }
}

/**
 * Options for creating the Discord MCP server.
 */
interface DiscordMCPServerOptions {
    /** Message search service for querying message history */
    searchService:     MCPMessageSearchService
    /** Discord.js client for sending messages and fetching channel data */
    client:            Client
    /** Registry for tracking pending questions awaiting user responses */
    questionRegistry:  QuestionRegistry
    /** Channel registry for name resolution and mute management */
    channelRegistry:   DiscordMcpChannelRegistry
    /** DM tracker for username-to-channel resolution */
    dmTracker:         MCPDMTracker
    /** Message splitter for chunking long messages */
    messageSplitter:   MCPMessageSplitter
    /** Button builder for interactive question options */
    buttonBuilder:     MCPQuestionButtonBuilder
    /** Retry helper for Discord API calls */
    retryHelper:       MCPRetryHelper
    /** Server timezone for localTimestamp enrichment. The MCP server is a
     *  shared, session-level resource created at startup. Per-user timezone
     *  would require threading user context into each tool call. The agent's
     *  prompts and message formatting use per-user timezone where available.
     */
    timezone?:         string
    /** Optional service health registry for fast-fail guards */
    healthRegistry?:   ServiceHealthRegistry
    /** Optional reconnection loop to trigger on health check failure */
    reconnectionLoop?: ReconnectionLoop
    /** Optional person allowlist for validating askUserQuestion's requestingUserId argument */
    personAllowlist?:  PersonAllowlist
    /** Outbox-backed sender for plain-text sendDiscordMessage calls (queues while Discord is unavailable) */
    outboundSender:    MCPOutboundMessageSender
}

/** Arguments of the sendDiscordMessage tool after file validation. */
interface SendDiscordMessageArgs {
    channelId:         string
    content:           string
    replyToMessageId?: string
    createThread?:     boolean
    threadName?:       string
    requestingUserId?: string
}

/** Resolves `@username` through the DM tracker and anything else through the channel registry. */
async function resolveSendTarget(
    channelId: string,
    options: Pick<DiscordMCPServerOptions, 'dmTracker' | 'channelRegistry'>
): Promise<{ channelId: ChannelId } | { error: CallToolResult }> {
    if(channelId.startsWith('@')) {
        const username = channelId.slice(1);
        const dmChannelId = await options.dmTracker.getOrCreateDMByUsername(username);
        if(!dmChannelId) {
            return { error: toolError(`Error: Could not find user @${username} in any server`) };
        }
        return { channelId: dmChannelId };
    }
    return { channelId: options.channelRegistry.resolveChannelId(channelId) };
}

/**
 * Sends a message with files or a thread request straight to Discord. These are never queued:
 * a thread needs the delivered message, so they fail visibly while Discord is unavailable.
 */
async function sendDirect(args: SendDiscordMessageArgs, validatedFiles: string[] | undefined, options: DiscordMCPServerOptions): Promise<CallToolResult> {
    if(options.healthRegistry) {
        const unavailable = checkServiceHealth(options.healthRegistry, 'discord', options.reconnectionLoop);
        if(unavailable) {
            return unavailable;
        }
    }
    const target = await resolveSendTarget(args.channelId, options);
    if(isErrorResult(target)) {
        return target.error;
    }
    const channelResult = await fetchAndValidateChannel(options.client, target.channelId, options.retryHelper);
    if(isErrorResult(channelResult)) {
        return channelResult.error;
    }

    // Stryker disable next-line llm: MCP validation requires a string, and every accepted string satisfies s || '' === s.
    const chunks = options.messageSplitter.splitMessage(args.content);
    const sentMessages: Message[] = [];
    try {
        await sendAllChunks(channelResult.channel, chunks, options.retryHelper, sentMessages, args.replyToMessageId, validatedFiles);
    } catch (error: unknown) {
        return directSendFailure(error, sentMessages, chunks.length);
    }
    const messageIds = sentMessages.map(msg => msg.id);

    let threadId: string | undefined;
    try {
        // sendAllChunks throws before returning when the splitter yields no first chunk.
        threadId = await createThreadIfRequested(channelResult.channel, sentMessages[0]!, options.retryHelper, args.createThread, args.threadName);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Error: the message was sent (messageIds: ${messageIds.join(', ')}) but the thread could not be created: ${message}. Do not send the message again.`);
    }

    const result = {
        success:     true,
        messageIds,
        chunksCount: chunks.length,
        ...(threadId && { threadId }),
        ...(validatedFiles && { filesAttached: validatedFiles.length }),
    };

    logger.info({ requestingUserId: args.requestingUserId, channelId: args.channelId, messageIds, msg: 'Message sent via MCP tool' });

    return {
        // Stryker disable next-line NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
}

/**
 * Sends a plain-text message through the outbox-backed sender: it is delivered now when Discord
 * is available and queued otherwise. Neither the channel nor a reply target can be checked while
 * Discord is unavailable, so a bad id is only found when the queued message is replayed.
 */
async function sendViaOutbox(args: SendDiscordMessageArgs, options: DiscordMCPServerOptions): Promise<CallToolResult> {
    if(args.content.trim() === '') {
        return toolError('Error: content is empty; nothing was sent.');
    }
    if(args.channelId.startsWith('@') && !options.outboundSender.isReady()) {
        return toolError(`Error: cannot resolve ${args.channelId} while Discord is unavailable; use the DM channel id to queue the message.`);
    }
    const target = await resolveSendTarget(args.channelId, options);
    if(isErrorResult(target)) {
        return target.error;
    }
    const result = await options.outboundSender.sendText(target.channelId, args.content, { replyToMessageId: args.replyToMessageId });
    logger.info({ requestingUserId: args.requestingUserId, channelId: args.channelId, status: result.status, msg: 'Outbox-backed message send via MCP tool' });
    return formatOutboundResult(result);
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
 * @param options - All required dependencies for the Discord MCP server
 */
export function createDiscordMCPServer(options: DiscordMCPServerOptions) {
    const { searchService, client, questionRegistry, channelRegistry, buttonBuilder, retryHelper, timezone, personAllowlist } = options;

    return createSdkMcpServer({
        name:       'discord',
        version:    '1.0.0',
        // The system prompt names Discord tools directly: never defer them behind ToolSearch.
        alwaysLoad: true,
        tools:      [
            tool(
                'searchMessages',
                'Search Discord message history by text, time range, or both. It returns the oldest matching page and summarizes newer fetched matches in overflow. Always inspect metadata.coverage, metadata.fetched, and metadata.matchedInFetched: limitReached means the fetch cap was reached, not that all matching messages were fetched. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    query:     z.string().optional().describe('Text to search for in message content'),
                    startTime: z.string().optional().describe('Start of time range (ISO 8601 format)'),
                    endTime:   z.string().optional().describe('End of time range (ISO 8601 format)'),
                    limit:     z.number().int().positive().max(100).optional().describe('Maximum messages to return (default 10, max 100)'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('searchMessages', async (args): Promise<CallToolResult> => {
                        const channelId = channelRegistry.resolveChannelId(args.channelId);
                        const result = await searchService.searchMessages({
                            channelId,
                            query:     args.query,
                            startTime: args.startTime ? new Date(args.startTime) : undefined,
                            endTime:   args.endTime ? new Date(args.endTime) : undefined,
                            limit:     args.limit ?? 10,
                        });

                        // Enrich messages with local timestamps if timezone is provided
                        if(timezone) {
                            addLocalTimestamps(result.messages, timezone);
                        }

                        return {
                            // Stryker disable next-line NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'getRecentMessages',
                'Get the most recent messages from a Discord channel. It returns the newest page and a count-only overflow for older fetched messages. Always inspect metadata.coverage, metadata.fetched, and metadata.matchedInFetched: limitReached means the fetch cap was reached, not that all channel messages were fetched. Use searchMessages with time range for summaries. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    limit:     z.number().int().positive().max(100).optional().describe('Number of messages to return (default 10, max 100)'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('getRecentMessages', async (args): Promise<CallToolResult> => {
                        const channelId = channelRegistry.resolveChannelId(args.channelId);
                        const result = await searchService.getRecentMessages(
                            channelId,
                            args.limit ?? 10
                        );

                        // Enrich messages with local timestamps if timezone is provided
                        if(timezone) {
                            addLocalTimestamps(result.messages, timezone);
                        }

                        return {
                            // Stryker disable next-line NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'getMessageById',
                'Fetch a specific Discord message by its ID, or multiple messages by an array of IDs. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    messageId: z.union([z.string(), z.array(z.string())]).describe('Discord message ID or array of message IDs'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('getMessageById', async (args): Promise<CallToolResult> => {
                        const channelId = channelRegistry.resolveChannelId(args.channelId);
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
                                // Stryker disable next-line llm, NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
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
                            // Stryker disable next-line llm, NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                        };
                    })),
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

NEVER invent or guess channel IDs. If unsure, use #general.

The channel must always be given explicitly — there is no ambient conversation context.

Delivery: plain text messages go through a durable outbox. The result's "status" is "sent" (with messageIds), "queued" (Discord is unavailable; the message is stored and will be delivered automatically when Discord is back — it has NOT been sent yet, so do not send it again), or "partially_sent" (the first chunks were sent and the rest are queued). If the message a queued reply answers is deleted before the reply is delivered, the reply is dropped and you are notified with its text. Messages with files or createThread are never queued: if Discord is unavailable they return an error, so try again later. While Discord is unavailable, @username cannot be resolved; use the DM channel ID instead.`,
                {
                    channelId:        z.string().describe('Target channel ID, #channel-name, or @username for DM - use from message context, memory, or default: 1451694737026449581 (#general)'),
                    content:          z.string().describe('Message content. Long content is split into several messages automatically.'),
                    replyToMessageId: z.string().optional().describe('Optional message ID to reply to'),
                    createThread:     z.boolean().optional().describe('Create a new thread for this message'),
                    threadName:       z.string().optional().describe('Thread name (required if createThread is true)'),
                    files:            z.union([z.string(), z.array(z.string())]).optional().describe('File path(s) to attach. Must be inside the working directory (no symlinks).'),
                    requestingUserId: z.string().optional().describe('User id from the envelope/message header, for logging only.'),
                },

                // No outer health guard: a plain-text message is queued while Discord is unavailable,
                // and sendDirect applies the same health check to the sends that are never queued.
                withToolErrorHandling('sendDiscordMessage', async (args): Promise<CallToolResult> => {
                    const threadError = validateThreadCreation(args.createThread, args.threadName);
                    if(threadError) {
                        return threadError;
                    }

                    // Validate file paths first, so a security error is reported even while Discord is unavailable.
                    let validatedFiles: string[] | undefined;
                    if(args.files) {
                        try {
                            validatedFiles = await validateFilePaths(args.files);
                        } catch (error) {
                            if(error instanceof PathSecurityError) {
                                logger.warn({ tool: 'sendDiscordMessage', error: error.message, path: error.context.path }, 'Discord tool returned security error');
                                return toolError(`Security Error: ${error.message}`);
                            }
                            throw error;
                        }
                    }

                    if((validatedFiles?.length ?? 0) > 0 || args.createThread === true) {
                        return sendDirect(args, validatedFiles, options);
                    }
                    return sendViaOutbox(args, options);
                }),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'askUserQuestion',
                'Ask a question and wait for the user to respond. Pauses processing until an answer is received or timeout. The returned state identifies whether the question was answered, timed out, or cancelled. Options are limited to 25 maximum (Discord limit). Accepts channel ID or #channel-name format. The channel and requesting user must always be given explicitly — there is no ambient conversation context. Questions are never queued: if Discord is unavailable this returns an error, so ask again later.',
                {
                    channelId:        z.string().describe('Channel to ask in - channel ID or #channel-name (e.g., #general)'),
                    question:         z.string().describe('Question text'),
                    options:          z.array(questionOptionSchema).optional().describe('Optional button choices for the user'),
                    timeoutSeconds:   z.number().optional().describe('Timeout in seconds (default: 300)'),
                    createThread:     z.boolean().optional().describe('Create a thread for this Q&A'),
                    threadName:       z.string().optional().describe('Thread name if creating thread'),
                    targetUserId:     z.string().optional().describe('Optional user ID to @mention in the question. Advisory only - anyone can answer.'),
                    requestingUserId: z.string().optional().describe('User id from the envelope/message header you are answering. Validated against the person allowlist; falls back to the bot user id when missing or not allowlisted.'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('askUserQuestion', async (args): Promise<CallToolResult> => {
                        // 1. Validate options count
                        const optionsError = validateQuestionOptions(args.options);
                        if(optionsError) {
                            return optionsError;
                        }

                        // 2. Resolve channel name to ID if needed
                        const channelId = channelRegistry.resolveChannelId(args.channelId);

                        // 3. Normalize channel ID (handles threads)
                        const normalizeResult = await normalizeChannelId(client, channelId, retryHelper);
                        if(isErrorResult(normalizeResult)) {
                            return normalizeResult.error;
                        }

                        const { normalizedChannelId, existingThreadId, channel } = normalizeResult;

                        // 4. Build message with optional buttons
                        const questionId = randomUUID();
                        const messageOptions = buildQuestionMessage(
                            questionId,
                            args.question,
                            buttonBuilder,
                            args.targetUserId,
                            args.options
                        );

                        // 5. Prepare target channel (existing thread or create new)
                        const { targetChannel, threadId } = await prepareQuestionChannel(
                            existingThreadId ? await client.channels.fetch(existingThreadId) : channel,
                            channel,
                            retryHelper,
                            existingThreadId,
                            args.createThread,
                            args.threadName
                        );

                        // 6. Send question. Questions are never queued: a failure returns a clear error
                        // instead, and never claims nothing was posted (a lost response may hide a post).
                        let sentMessage: Message;
                        try {
                            sentMessage = await retryHelper.withRetry(
                                () => targetChannel.send(messageOptions)
                            );
                        } catch (error: unknown) {
                            const message = error instanceof Error ? error.message : String(error);
                            return toolError(`Error: the question's delivery could not be confirmed (questions are never queued): ${message}. Check the channel; if the question is not there, ask again when Discord is available.`);
                        }

                        logger.info({
                            questionId,
                            channelId:    args.channelId,
                            threadId,
                            targetUserId: args.targetUserId,
                            hasOptions:   Boolean(args.options?.length),
                            optionCount:  args.options?.length ?? 0,
                            msg:          'Question asked via MCP tool',
                        });

                        // 7. Register question and wait for answer
                        const result = await registerAndWaitForAnswer(questionRegistry, {
                            questionId,
                            normalizedChannelId,
                            threadId,
                            sentMessage,
                            currentUserId:  validateRequestingUserId(args.requestingUserId, personAllowlist),
                            clientUser:     client.user,
                            question:       args.question,
                            options:        args.options,
                            targetUserId:   args.targetUserId,
                            timeoutSeconds: args.timeoutSeconds,
                        });

                        // 8. Format and return result
                        return formatQuestionResult(result, questionId, args.channelId, threadId);
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }
            ),

            tool(
                'addReaction',
                'Add one or more emoji reactions to a Discord message. Accepts channel ID or #channel-name format.',
                {
                    channelId: z.string().describe('Discord channel ID or #channel-name (e.g., #general)'),
                    messageId: z.string().describe('Discord message ID to react to'),
                    emoji:     z.union([z.string(), z.array(z.string())]).describe('Emoji or array of emojis to react with (e.g., "👍" or ["👍", "❤️"])'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('addReaction', async (args): Promise<CallToolResult> => {
                        // Resolve channel name to ID if needed
                        const channelId = channelRegistry.resolveChannelId(args.channelId);

                        // Fetch and validate channel
                        const channelResult = await fetchAndValidateChannel(client, channelId, retryHelper);
                        if(isErrorResult(channelResult)) {
                            return channelResult.error;
                        }

                        // Fetch the message
                        const message = await retryHelper.withRetry(
                            () => channelResult.channel.messages.fetch(args.messageId)
                        );

                        // Normalize emoji to array
                        const emojis = Array.isArray(args.emoji) ? args.emoji : [args.emoji];

                        // Add reactions sequentially
                        const addedEmojis: string[] = [];
                        const failedEmojis: { emoji: string, error: string }[] = [];

                        for(const emoji of emojis) {
                            try {
                            // eslint-disable-next-line no-await-in-loop -- preserve emoji attempt order and ordered success/failure results
                                await retryHelper.withRetry(
                                    () => message.react(emoji)
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
                            failedEmojis: failedEmojis.length > 0 ? failedEmojis : undefined,
                            channelId:    args.channelId,
                            messageId:    args.messageId,
                        };

                        if(failedEmojis.length > 0) {
                            logger.warn({ tool: 'addReaction', channelId: args.channelId, messageId: args.messageId, failedEmojis }, 'Discord tool returned partial error: Some reactions failed');
                        }

                        return {
                            // Stryker disable next-line llm, NumberLiteralValue: JSON indentation changes only presentation whitespace, not the result data.
                            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                            ...(failedEmojis.length > 0 && { isError: true }),
                        };
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'muteChannel',
                'Mute a Discord channel so the bot will not respond to messages in it. Use this when you want to observe a channel without participating. Accepts either a numeric channel ID or channel name with # prefix (e.g., #general).',
                {
                    channelId: z.string().describe('Discord channel ID or name with # prefix (e.g., #general)'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('muteChannel', async (args): Promise<CallToolResult> => {
                        const channelId = channelRegistry.resolveChannelId(args.channelId);
                        await channelRegistry.muteChannel(channelId);
                        logger.info({ tool: 'muteChannel', channelId, msg: 'Channel muted' });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, muted: true }) }],
                        };
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'unmuteChannel',
                'Unmute a Discord channel so the bot will respond to messages in it again. Accepts either a numeric channel ID or channel name with # prefix (e.g., #general).',
                {
                    channelId: z.string().describe('Discord channel ID or name with # prefix (e.g., #general)'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('unmuteChannel', async (args): Promise<CallToolResult> => {
                        const channelId = channelRegistry.resolveChannelId(args.channelId);
                        await channelRegistry.unmuteChannel(channelId);
                        logger.info({ tool: 'unmuteChannel', channelId, msg: 'Channel unmuted' });
                        return {
                            content: [{ type: 'text' as const, text: JSON.stringify({ success: true, channelId, muted: false }) }],
                        };
                    })),
                { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),

            tool(
                'listChannels',
                'List all channels the bot is tracking, with their mute status. Use this to see available channels.',
                {
                    includesMuted: z.boolean().optional().describe('Include muted channels in the list (default: false)'),
                },
                withHealthGuard(options.healthRegistry, 'discord', options.reconnectionLoop,
                    withToolErrorHandling('listChannels', async (args): Promise<CallToolResult> => {
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
                    })),
                { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } }
            ),
        ],
    });
}
