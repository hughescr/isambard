/**
 * Status Middleware
 *
 * Wraps message processing to update Discord presence based on agent stream events.
 * Maps agent activity (thinking, tool usage, responding) to Discord presence phases.
 *
 * Uses shouldUpdate() from PresenceManager to avoid wasted LLM calls for synopsis
 * generation when the update would be throttled anyway.
 */

import type { PresenceManager } from './manager.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { createStreamEventHandler } from './stream-event-handler.js';
import type { ClaudeAgent } from '../../../agent/agent.js';
import type { DiscordMessageContext } from '../types.js';

/**
 * Discord channel interface for typing indicator.
 */
interface TypingChannel {
    sendTyping(): Promise<void>
}

/**
 * Dependencies for creating status middleware.
 */
export interface StatusMiddlewareDeps {
    /** Presence manager for updating Discord status */
    presenceManager: PresenceManager
    /** Claude agent for processing messages */
    agent:           ClaudeAgent
    /** Logger instance */
    logger: {
        debug: (obj: Record<string, unknown> | string, message?: string) => void
        info:  (obj: Record<string, unknown> | string, message?: string) => void
        error: (obj: Record<string, unknown> | string, message?: string) => void
    }
    /** Optional dynamic status generator for LLM-generated synopses */
    dynamicStatusGenerator?: DynamicStatusGenerator
}

/**
 * Function that processes a message with presence updates.
 */
export type StatusMiddleware = (
    context: DiscordMessageContext,
    channel?: TypingChannel
) => Promise<string | null>;

/**
 * Creates a status middleware that wraps message processing with presence updates.
 *
 * The middleware:
 * - Starts typing indicator when processing begins
 * - Updates presence based on agent stream events
 * - Maps stream events to presence phases (thinking, using_tool, responding)
 * - Checks shouldUpdate() before generating expensive LLM synopses
 * - Stops typing and clears presence when complete or on error
 * - Handles concurrent messages independently
 *
 * @param deps - Dependencies including presence manager and agent
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * const middleware = createStatusMiddleware({
 *   presenceManager: myPresenceManager,
 *   agent: myAgent,
 *   logger: myLogger
 * });
 *
 * const response = await middleware(messageContext, discordChannel);
 * // Discord presence updated throughout processing
 * ```
 */
export function createStatusMiddleware(
    deps: StatusMiddlewareDeps
): StatusMiddleware {
    const { presenceManager, agent, logger, dynamicStatusGenerator } = deps;

    return async (
        context: DiscordMessageContext,
        channel?: TypingChannel
    ): Promise<string | null> => {
        // Track typing interval for cleanup
        let typingInterval: ReturnType<typeof setInterval> | null = null;

        const userMessage = context.content;

        // Pre-generate thinking synopsis at start (before agent.chat) if update would apply.
        // This allows immediate status display without waiting for the first stream event.
        // The synopsis is cached and reused when transitioning to 'thinking' phase.
        let thinkingSynopsis: string | undefined;
        // Stryker disable next-line ConditionalExpression: Equivalent - try/catch swallows TypeError when undefined
        if(dynamicStatusGenerator && presenceManager.shouldUpdate()) {
            try {
                thinkingSynopsis = await dynamicStatusGenerator.generateSynopsis({
                    phase: 'thinking',
                    userMessage,
                });
            } catch{
                // Fallback handled by active generator - empty catch is intentional
            }
        }

        // Create stream event handler for presence updates
        const { onStreamEvent, complete } = createStreamEventHandler({
            presenceManager,
            dynamicStatusGenerator,
            logger,
            userMessage,
            messageId: context.messageId,
            thinkingSynopsis,
        });

        try {
            // Start typing indicator
            if(channel) {
                await channel.sendTyping();
                logger.debug({ messageId: context.messageId }, 'Started typing indicator');

                // Refresh typing every 8 seconds (Discord timeout is ~10s)
                // Stryker disable next-line BlockStatement: Typing refresh is periodic side effect, tested via integration
                typingInterval = setInterval(() => {
                    // Stryker disable all: Error logging for typing indicator failure - observational only
                    void channel.sendTyping().catch((error: unknown) => {
                        logger.error({ error, messageId: context.messageId, msg: 'Failed to send typing indicator' });
                    });
                    // Stryker restore all
                }, 8000);
            }

            // Process message with stream callback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Agent chat type allows stream callback
            const response = await (agent.chat as any)(context, onStreamEvent);

            // Transition to idle after completion
            complete();

            // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Response type matches agent return type
            return response;
        } catch (error) {
            // Handle errors gracefully
            logger.error(
                { error, messageId: context.messageId },
                'Error processing message in status middleware'
            );

            // Clear presence on error
            complete();

            return null;
        } finally {
            // Clean up typing interval
            // Stryker disable next-line ConditionalExpression: clearInterval(null) is a no-op in JS, equivalent behavior
            if(typingInterval) {
                clearInterval(typingInterval);
                logger.debug({ messageId: context.messageId }, 'Stopped typing indicator');
            }
        }
    };
}
