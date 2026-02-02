import type { Message, TextChannel, Client } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { ChannelId } from './types';
import type { ResponseRouter, SessionType, RoutingResult } from './channel-registry';
import type { BotStateManager } from './state';
import { WellKnownChannelNotFoundError } from './channel-registry';
import { splitMessage } from './messages';
import type { DiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';

/**
 * Configuration for sending a response.
 */
export interface SendResponseConfig {
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
}

/**
 * Result of sending a response.
 */
export interface SendResponseResult {
    /** Whether the response was sent */
    sent:        boolean
    /** Routing information (if sent) */
    routing?:    RoutingResult
    /** Error that occurred (if any) */
    error?:      Error
    /** Reason for not sending (if not sent) */
    skipReason?: string
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
// eslint-disable-next-line complexity -- Message sending involves multiple branching paths for routing, splitting, and error handling
export async function sendResponse(config: SendResponseConfig): Promise<SendResponseResult> {
    const { responseRouter, botStateManager, response, message, rateLimiter, client, useFallbackOnError } = config;

    // Determine session type from bot state
    const mode = botStateManager.getMode();
    let sessionType: SessionType = 'processing_message';
    if(mode === 'catching_up') {
        sessionType = 'catching_up';
    } else if(mode === 'perching') {
        sessionType = 'perching';
    } else if(message.channel.isDMBased()) {
        sessionType = 'dm';
    }

    // Route response based on session type
    let routing: RoutingResult;
    try {
        routing = await responseRouter.routeResponse(
            sessionType,
            response,
            message.channel.id as ChannelId
        );
    } catch (routeError: unknown) {
        if(routeError instanceof WellKnownChannelNotFoundError) {
            if(useFallbackOnError) {
                // handlers.ts: fallback to original channel
                logger.warn({
                    channelType: routeError.channelType,
                    msg:         'Well-known channel not found, falling back to original channel',
                });
                routing = {
                    shouldSend:      true,
                    content:         response,
                    targetChannelId: message.channel.id as ChannelId,
                    isFallback:      true,
                    fallbackReason:  routeError.message,
                };
            } else {
                // bot.ts: skip response
                // Stryker disable all: Logging for observability
                logger.error({
                    error:       routeError,
                    sessionType,
                    channelType: routeError.channelType,
                    msg:         `Cannot route response: well-known channel #${routeError.channelType} not configured. Response skipped.`,
                });
                // Stryker restore all
                return {
                    sent:       false,
                    skipReason: `Well-known channel #${routeError.channelType} not configured`,
                };
            }
        } else {
            throw routeError;
        }
    }

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
        logger.debug({
            messageId: message.id,
            msg:       'Agent chose not to respond (@@NO_RESPONSE@@ sentinel)',
        });
        // Stryker restore all
        return {
            sent:       false,
            routing,
            skipReason: 'Agent chose not to respond (@@NO_RESPONSE@@ sentinel)',
        };
    }

    logger.info({
        messageId:      message.id,
        responseLength: content.length,
        msg:            `Response generated (${content.length} chars)`,
    });

    // Split long messages into Discord-safe chunks
    const chunks = splitMessage(content);

    try {
        // If target channel is the same as origin, use reply() for first chunk
        // Otherwise, send all chunks to target channel
        if(targetChannelId === message.channel.id) {
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
        } else {
            // Send all chunks to different target channel
            const targetChannel = await client.channels.fetch(targetChannelId);
            if(!targetChannel || !('send' in targetChannel)) {
                throw new Error(`Target channel ${targetChannelId} not found or not a text channel`);
            }

            for(let i = 0; i < chunks.length; i++) {
                await withDiscordRetry(
                    () => rateLimiter.sendToChannel(targetChannel as TextChannel, chunks[i]),
                    // Stryker disable next-line StringLiteral: Operation name for logging
                    'sendToChannel'
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

        return {
            sent: true,
            routing,
        };
    } catch (replyError) {
        const err = _.isError(replyError) ? replyError : new Error(String(replyError));
        logger.error({ error: err, messageId: message.id, msg: `Failed to send response: ${err.message}` });
        return {
            sent:  false,
            routing,
            error: err,
        };
    }
}
