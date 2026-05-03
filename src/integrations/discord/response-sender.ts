import { logger } from '@hughescr/logger';
import type { Message, TextChannel, Client } from 'discord.js';
import type { DiscordCapability } from './capability';
import { type ResponseRouter, type RoutingResult, WellKnownChannelNotFoundError  } from './channel-registry';
import { splitMessage } from './messages';
import type { DiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';
import type { BotStateManager, SessionType } from './state';
import { createChannelId } from './types';
import { ChannelNotAccessibleError, InvariantViolationError } from '@/errors';

/** Type guard: check if a routing/response result is a RoutingResult (has shouldSend). */
function isRoutingResult(result: unknown): result is RoutingResult {
    return typeof result === 'object' && result !== null && 'shouldSend' in result;
}

/** Type guard: check if a resolveRouting result has a skipResult (not a routing). */
function hasSkipResult(routeResult: unknown): routeResult is { skipResult: SendResponseResult } {
    return typeof routeResult === 'object' && routeResult !== null && 'skipResult' in routeResult;
}

/**
 * Configuration for sending a response.
 */
interface SendResponseConfig {
    /** Response router for routing decisions */
    responseRouter:     ResponseRouter
    /** Bot state manager to determine session type */
    botStateManager:    BotStateManager
    /** The response text to send */
    response:           string
    /** The Discord message this is responding to */
    message:            Message
    /** Rate limiter for Discord API calls */
    rateLimiter:        DiscordRateLimiter
    /** Discord client for fetching channels */
    client:             Client
    /** Whether to use fallback or skip on error (handlers.ts uses fallback, bot.ts skips) */
    useFallbackOnError: boolean
    /**
     * Optional Discord capability facade.
     * When provided, each chunk is sent via the facade (with outbox fallback when Discord is offline)
     * instead of directly via the rate limiter.
     */
    discordCapability?: DiscordCapability
}

/**
 * Result of sending a response.
 */
interface SendResponseResult {
    /** Whether the response was sent */
    sent:        boolean
    /** Whether the response was queued to the outbox (Discord offline) */
    queued?:     boolean
    /** Routing information (if sent) */
    routing?:    RoutingResult
    /** Error that occurred (if any) */
    error?:      Error
    /** Reason for not sending (if not sent) */
    skipReason?: string
}

/**
 * Configuration for sending a response to a well-known channel.
 */
interface SendToWellKnownConfig {
    /** Response router for routing decisions */
    responseRouter:     ResponseRouter
    /** The response text to send */
    response:           string | null | undefined
    /** Session type (catching_up or perching) */
    sessionType:        'catching_up' | 'perching'
    /** Rate limiter for Discord API calls */
    rateLimiter:        DiscordRateLimiter
    /** Discord client for fetching channels */
    client:             Client
    /**
     * Optional Discord capability facade.
     * When provided, each chunk is sent via the facade (with outbox fallback when Discord is offline)
     * instead of directly via the rate limiter.
     */
    discordCapability?: DiscordCapability
}

/**
 * Handles a WellKnownChannelNotFoundError during routing.
 * Returns a fallback routing result or a skip result depending on useFallbackOnError.
 */

function handleWellKnownChannelError(
    routeError: WellKnownChannelNotFoundError,
    sessionType: SessionType,
    response: string,
    message: Message,
    useFallbackOnError: boolean
): RoutingResult | SendResponseResult {
    if(useFallbackOnError) {
        // handlers.ts: fallback to original channel
        // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
        logger.warn({
            channelType: routeError.context.channelType,
            msg:         'Well-known channel not found, falling back to original channel',
        });
        // Stryker restore ObjectLiteral,StringLiteral
        return {
            shouldSend:      true,
            content:         response,
            targetChannelId: createChannelId(message.channel.id),
            isFallback:      true,
            fallbackReason:  routeError.message,
        } satisfies RoutingResult;
    }
    // bot.ts: skip response
    // Stryker disable all: Logging for observability
    logger.error({
        error:       routeError,
        sessionType,
        channelType: routeError.context.channelType,
        msg:         `Cannot route response: well-known channel #${routeError.context.channelType} not configured. Response skipped.`,
    });
    // Stryker restore all
    return {
        sent:       false,
        skipReason: `Well-known channel #${routeError.context.channelType} not configured`,
    } satisfies SendResponseResult;
}

/**
 * Sends message chunks by replying to the origin message (thread-preserving).
 */
async function sendChunksByReply(
    message: Message,
    chunks: string[],
    rateLimiter: DiscordRateLimiter
): Promise<void> {
    // First chunk uses reply() to thread the response (with retry and rate limiting)
    const firstChunk = chunks[0];
    // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — splitMessage guarantees ≥1 chunk for non-empty input; unreachable in practice
    if(firstChunk === undefined) {
        // Stryker disable next-line StringLiteral: invariant violation message — debug context only
        throw new InvariantViolationError('sendChunksByReply', 'chunks is empty — splitMessage guarantees ≥1 chunk');
    }
    const firstReply = await withDiscordRetry(
        () => rateLimiter.replyToMessage(message, firstChunk)
    );
    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
    logger.info({ messageId: message.id, chunkIndex: 0, totalChunks: chunks.length, msg: 'Reply sent successfully' });

    // Subsequent chunks reply to our first message to maintain threading
    // Stryker disable next-line EqualityOperator,UpdateOperator: Loop starts at 1; UpdateOperator (i--) would cause infinite loop — untestable without real Discord API
    for(let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < chunks.length; unreachable in practice
        if(chunk === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('sendChunksByReply', 'chunks[i] undefined despite i < chunks.length');
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API
        await withDiscordRetry(
            () => rateLimiter.replyToMessage(firstReply, chunk)
        );
        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ messageId: message.id, chunkIndex: i, totalChunks: chunks.length, msg: 'Continuation sent successfully' });
    }
}

/**
 * Sends message chunks to a different target channel (not the origin).
 */
async function sendChunksToChannel(
    message: Message,
    chunks: string[],
    targetChannelId: string,
    client: Client,
    rateLimiter: DiscordRateLimiter
): Promise<void> {
    const targetChannel = await client.channels.fetch(targetChannelId);
    if(!targetChannel?.isTextBased()) {
        throw new ChannelNotAccessibleError(targetChannelId);
    }

    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop — untestable without real Discord API
    for(let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < chunks.length; unreachable in practice
        if(chunk === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('sendChunksToChannel', 'chunks[i] undefined despite i < chunks.length');
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API
        await withDiscordRetry(
            () => rateLimiter.sendToChannel(targetChannel as TextChannel, chunk)
        );
        // Stryker disable all: Logging for observability
        logger.info({
            messageId:   message.id,
            chunkIndex:  i,
            totalChunks: chunks.length,
            targetChannelId,
            msg:         'Message chunk sent successfully',
        });
        // Stryker restore all
    }
}

/**
 * Routes a response, handling WellKnownChannelNotFoundError.
 * Returns { routing } on success, or { skipResult } if response should be skipped.
 */
async function resolveRouting(
    responseRouter: ResponseRouter,
    sessionType: SessionType,
    response: string,
    message: Message,
    useFallbackOnError: boolean
): Promise<{ routing: RoutingResult } | { skipResult: SendResponseResult }> {
    try {
        const routing = await responseRouter.routeResponse(
            sessionType,
            response,
            createChannelId(message.channel.id)
        );
        return { routing };
    } catch (routeError: unknown) {
        if(routeError instanceof WellKnownChannelNotFoundError) {
            const result = handleWellKnownChannelError(routeError, sessionType, response, message, useFallbackOnError);
            if(isRoutingResult(result)) {
                return { routing: result };
            }
            return { skipResult: result };
        }
        throw routeError;
    }
}

/**
 * Shared helper function for routing and sending responses.
 * Handles:
 * - Determining session type from bot state
 * - Routing response via responseRouter
 * - Fallback handling for WellKnownChannelNotFoundError
 * - Message splitting for Discord's 2000-char limit
 * - Sending message chunks to target channel
 *
 * @param config - Configuration for sending the response
 * @returns Result indicating success/failure and routing metadata
 */
export async function sendResponse(config: SendResponseConfig): Promise<SendResponseResult> {
    const { responseRouter, botStateManager, response, message, rateLimiter, client, useFallbackOnError } = config;

    // Determine session type from bot state
    const sessionType = botStateManager.getSessionType(message.channel.isDMBased());

    // Route response based on session type
    const routeResult = await resolveRouting(responseRouter, sessionType, response, message, useFallbackOnError);
    if(hasSkipResult(routeResult)) {
        return routeResult.skipResult;
    }
    const routing = routeResult.routing;

    const shouldSend = routing.shouldSend;
    const content = routing.content;
    const targetChannelId = routing.targetChannelId;

    // Log fallback if needed
    // Stryker disable all: Logging for observability
    if(routing.isFallback && routing.fallbackReason) {
        logger.warn({
            messageId: message.id,
            reason:    routing.fallbackReason,
            msg:       'Response routed via fallback',
        });
    }
    // Stryker restore all

    if(!shouldSend) {
        // Agent chose not to respond (@@NO_RESPONSE@@ sentinel)
        // Stryker disable all: Logging for observability
        logger.info({
            messageId:    message.id,
            sessionType,
            fullResponse: response,
            msg:          'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        });
        // Stryker restore all
        return {
            sent:       false,
            routing,
            skipReason: 'Agent chose not to respond (@@NO_RESPONSE@@ sentinel)',
        };
    }

    // Stryker disable ObjectLiteral,StringLiteral: Logging for observability
    logger.info({
        messageId:      message.id,
        responseLength: content.length,
        msg:            `Response generated (${content.length} chars)`,
    });
    // Stryker restore ObjectLiteral,StringLiteral

    // Split long messages into Discord-safe chunks
    const chunks = splitMessage(content);

    // If capability facade is provided, use it for all chunks — it handles outbox fallback
    // Stryker disable all: Integration send helper — tested via bot integration tests
    if(config.discordCapability) {
        let anyQueued = false;
        for(const chunk of chunks) {
            // eslint-disable-next-line no-await-in-loop -- sequential: Discord message ordering
            const result = await config.discordCapability.sendToChannel(
                targetChannelId,
                chunk,
                { priority: 'high', type: 'agent_response' }
            );
            if(result.status === 'queued' || result.status === 'unavailable') {
                anyQueued = true;
                // Continue loop so remaining chunks are also queued, not dropped
            }
        }
        return { sent: !anyQueued, queued: anyQueued || undefined, routing };
    }
    // Stryker restore all

    try {
        // If target channel is the same as origin, use reply() for first chunk
        // Otherwise, send all chunks to target channel
        await (targetChannelId === message.channel.id
            ? sendChunksByReply(message, chunks, rateLimiter)
            : sendChunksToChannel(message, chunks, targetChannelId, client, rateLimiter));

        return {
            sent: true,
            routing,
        };
    } catch (replyError) {
        const err = replyError instanceof Error ? replyError : new Error(String(replyError));
        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.error({ error: err, messageId: message.id, msg: `Failed to send response: ${err.message}` });
        return {
            sent:  false,
            routing,
            error: err,
        };
    }
}

/**
 * Sends a single chunk to a well-known channel via capability or direct rate-limited send.
 * Returns the SendResult status when using capability, or 'sent' for the direct path.
 */
// Stryker disable all: Integration send helper — tested via bot integration tests
async function sendOneChunkToWellKnownChannel(
    chunk:             string,
    sessionType:       'catching_up' | 'perching',
    targetChannelId:   string,
    rateLimiter:       DiscordRateLimiter,
    client:            Client,
    discordCapability: DiscordCapability | undefined,
    targetChannel:     TextChannel | undefined
): Promise<'sent' | 'queued' | 'unavailable'> {
    if(discordCapability) {
        const outboxType = sessionType === 'catching_up' ? 'catch_up_output' : 'perch_output';
        const result = await discordCapability.sendToChannel(targetChannelId, chunk, { priority: 'high', type: outboxType });
        return result.status;
    }
    await withDiscordRetry(() => rateLimiter.sendToChannel(targetChannel!, chunk));
    return 'sent';
}
// Stryker restore all

/**
 * Sends message chunks to a well-known channel, using capability facade or direct rate-limited send.
 * Returns true if all chunks were sent directly, false if any were queued to the outbox.
 */
// Stryker disable BlockStatement,StringLiteral,ConditionalExpression,EqualityOperator: Logging only — not behavior-affecting
function buildChunkLogMsg(isQueued: boolean, chunkIndex: number): string {
    if(isQueued) {
        return chunkIndex === 0 ? 'Response queued to outbox for well-known channel' : 'Continuation queued to outbox for well-known channel';
    }
    return chunkIndex === 0 ? 'Response sent to well-known channel' : 'Continuation sent to well-known channel';
}
// Stryker restore StringLiteral,ConditionalExpression,EqualityOperator

async function sendChunksToWellKnownChannel(
    chunks:            string[],
    sessionType:       'catching_up' | 'perching',
    targetChannelId:   string,
    rateLimiter:       DiscordRateLimiter,
    client:            Client,
    discordCapability: DiscordCapability | undefined
): Promise<boolean> {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: channelType is only used in log messages below (which are already Stryker-disabled)
    const channelType = sessionType === 'catching_up' ? 'catch-up' : 'perch-time';
    // Stryker disable next-line ConditionalExpression: targetChannel is only needed for non-capability path
    const targetChannel = discordCapability ? undefined : await client.channels.fetch(targetChannelId) as TextChannel | undefined;
    if(!discordCapability && !targetChannel?.isTextBased()) {
        throw new ChannelNotAccessibleError(targetChannelId);
    }
    let anyQueued = false;
    // Stryker disable next-line UpdateOperator: i-- would cause infinite loop — untestable without real Discord API
    for(let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — loop bounds guarantee i < chunks.length; unreachable in practice
        if(chunk === undefined) {
            // Stryker disable next-line StringLiteral: invariant violation message — debug context only
            throw new InvariantViolationError('sendChunksToWellKnownChannel', 'chunks[i] undefined despite i < chunks.length');
        }
        // eslint-disable-next-line no-await-in-loop -- sequential: Discord message ordering
        const status = await sendOneChunkToWellKnownChannel(chunk, sessionType, targetChannelId, rateLimiter, client, discordCapability, targetChannel);
        // Stryker disable ConditionalExpression,BlockStatement,BooleanLiteral: anyQueued tracking — capability send status tested in capability.test.ts
        if(status === 'queued' || status === 'unavailable') {
            anyQueued = true;
        }
        // Stryker restore ConditionalExpression,BlockStatement,BooleanLiteral
        // Stryker disable ObjectLiteral: Logging for observability
        logger.info({
            sessionType,
            channelType,
            targetChannelId,
            chunkIndex:  i,
            totalChunks: chunks.length,
            msg:         buildChunkLogMsg(anyQueued, i),
        });
        // Stryker restore ObjectLiteral
    }
    return !anyQueued;
}

/**
 * Sends a response to a well-known channel (catch-up or perch-time).
 * This is used for autonomous sessions (perch/catch-up) that don't have a triggering message.
 *
 * @param config - Configuration for sending the response
 * @returns Result indicating success/failure and routing metadata
 */
export async function sendResponseToWellKnownChannel(config: SendToWellKnownConfig): Promise<SendResponseResult> {
    const { response, sessionType, responseRouter, rateLimiter, client } = config;

    // Handle empty/null responses
    // Stryker disable next-line ConditionalExpression: response.length === 0 is equivalent to !response for empty string (both falsy)
    if(!response || response.length === 0) {
        // Stryker disable all: Logging for observability
        logger.info({
            sessionType,
            msg: 'No response to send (empty response from agent)',
        });
        // Stryker restore all
        return {
            sent:       false,
            skipReason: 'Empty response from agent',
        };
    }

    // Route response based on session type (no origin channel for autonomous sessions)
    let routing: RoutingResult;
    try {
        routing = await responseRouter.routeResponse(
            sessionType,
            response,
            // No origin channel for autonomous sessions - pass undefined
            undefined
        );
    } catch (routeError: unknown) {
        if(routeError instanceof WellKnownChannelNotFoundError) {
            // Stryker disable all: Logging for observability
            logger.error({
                error:       routeError,
                sessionType,
                channelType: routeError.context.channelType,
                msg:         `Cannot route response: well-known channel #${routeError.context.channelType} not configured. Response skipped.`,
            });
            // Stryker restore all
            return {
                sent:       false,
                skipReason: `Well-known channel #${routeError.context.channelType} not configured`,
            };
        }
        throw routeError;
    }

    const shouldSend = routing.shouldSend;
    const content = routing.content;
    const targetChannelId = routing.targetChannelId;

    if(!shouldSend) {
        // Agent chose not to respond (@@NO_RESPONSE@@ sentinel)
        // Stryker disable all: Logging for observability
        logger.info({
            sessionType,
            fullResponse: response,
            msg:          'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        });
        // Stryker restore all
        return {
            sent:       false,
            routing,
            skipReason: 'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        };
    }

    // Stryker disable all: Logging for observability
    logger.info({
        responseLength: content.length,
        msg:            `Response generated (${content.length} chars)`,
    });
    // Stryker restore all

    // Split long messages into Discord-safe chunks
    const chunks = splitMessage(content);

    try {
        const allSent = await sendChunksToWellKnownChannel(
            chunks,
            sessionType,
            targetChannelId,
            rateLimiter,
            client,
            config.discordCapability
        );

        // Stryker disable ConditionalExpression,BooleanLiteral: queued flag propagation — callers don't inspect this but it's semantically correct
        return allSent
            ? { sent: true, routing }
            : { sent: false, queued: true, routing };
        // Stryker restore ConditionalExpression,BooleanLiteral
    } catch (sendError) {
        const err = sendError instanceof Error ? sendError : new Error(String(sendError));
        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.error({ error: err, sessionType, msg: `Failed to send response: ${err.message}` });
        return {
            sent:  false,
            routing,
            error: err,
        };
    }
}
