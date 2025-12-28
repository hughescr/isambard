/**
 * Status Middleware
 *
 * Wraps message processing to update Discord presence based on agent stream events.
 * Maps agent activity (thinking, tool usage, responding) to Discord presence phases.
 */

import type { PresenceManager } from './manager.js';
import type { PresencePhase } from './types.js';
import type { ClaudeAgent } from '../../../agent/agent.js';
import type { AgentStreamEvent } from '../../../agent/types.js';
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
    const { presenceManager, agent, logger } = deps;

    return async (
        context: DiscordMessageContext,
        channel?: TypingChannel
    ): Promise<string | null> => {
        try {
            // Start typing indicator
            if(channel) {
                await channel.sendTyping();
                logger.debug({ messageId: context.messageId }, 'Started typing indicator');
            }

            // Define stream event handler
            const onStreamEvent = (event: AgentStreamEvent): void => {
                // Helper to handle presence update errors
                const safeUpdatePhase = async (phase: PresencePhase): Promise<void> => {
                    try {
                        await presenceManager.updatePhase(phase);
                    } catch (error) {
                        // Don't crash on presence update errors
                        logger.error(
                            { error, event, messageId: context.messageId },
                            'Failed to update presence from stream event'
                        );
                    }
                };

                // Map stream events to presence phases
                if(event.type === 'assistant') {
                    if(event.delta?.text) {
                        // Assistant generating response text
                        void safeUpdatePhase({
                            type:      'responding',
                            startedAt: new Date(),
                        });
                    } else {
                        // Assistant thinking (no text delta)
                        void safeUpdatePhase({
                            type:      'thinking',
                            startedAt: new Date(),
                        });
                    }
                } else if(event.type === 'tool_progress') {
                    // Tool usage in progress
                    void safeUpdatePhase({
                        type:      'using_tool',
                        toolName:  event.tool_name ?? 'unknown',
                        startedAt: new Date(),
                    });
                } else if(event.type === 'result') {
                    // Processing complete, go idle
                    void safeUpdatePhase({
                        type:  'idle',
                        since: new Date(),
                    });
                }
            };

            // Process message with stream callback
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Agent chat type allows stream callback
            const response = await (agent.chat as any)(context, onStreamEvent);

            // Ensure we transition to idle after completion
            try {
                await presenceManager.updatePhase({
                    type:  'idle',
                    since: new Date(),
                });
            } catch (presenceError) {
                // Don't crash on presence update errors
                logger.error(
                    { error: presenceError, messageId: context.messageId },
                    'Failed to update presence to idle after completion'
                );
            }

            // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Response type matches agent return type
            return response;
        } catch (error) {
            // Handle errors gracefully
            logger.error(
                { error, messageId: context.messageId },
                'Error processing message in status middleware'
            );

            // Clear presence on error (don't propagate errors from this)
            try {
                await presenceManager.updatePhase({
                    type:  'idle',
                    since: new Date(),
                });
            } catch (presenceError) {
                logger.error(
                    { error: presenceError, messageId: context.messageId },
                    'Failed to update presence to idle after error'
                );
            }

            return null;
        }
    };
}
