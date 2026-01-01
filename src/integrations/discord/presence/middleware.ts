/**
 * Status Middleware
 *
 * Wraps message processing to update Discord presence based on agent stream events.
 * Maps agent activity (thinking, tool usage, responding) to Discord presence phases.
 */

import type { PresenceManager } from './manager.js';
import type { PresencePhase } from './types.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
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

        // Track current phase for transition detection
        let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
        let lastToolName: string | undefined;
        const userMessage = context.content;

        // Pre-generate thinking synopsis at start (before agent.chat).
        // This allows immediate status display without waiting for the first stream event.
        // The synopsis is cached and reused when transitioning to 'thinking' phase.
        let thinkingSynopsis: string | undefined;
        // Stryker disable next-line ConditionalExpression: Equivalent - try/catch swallows TypeError when undefined
        if(dynamicStatusGenerator) {
            try {
                thinkingSynopsis = await dynamicStatusGenerator.generateSynopsis({
                    phase: 'thinking',
                    userMessage,
                });
            } catch{
                // Fallback handled by active generator - empty catch is intentional
            }
        }

        try {
            // Start typing indicator
            if(channel) {
                await channel.sendTyping();
                logger.debug({ messageId: context.messageId }, 'Started typing indicator');

                // Refresh typing every 8 seconds (Discord timeout is ~10s)
                typingInterval = setInterval(() => {
                    void channel.sendTyping();
                }, 8000);
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
                    const newPhase = event.delta?.text ? 'responding' : 'thinking';

                    if(newPhase !== currentPhase) {
                        currentPhase = newPhase;

                        if(newPhase === 'thinking') {
                            // Use pre-generated thinking synopsis
                            void safeUpdatePhase({
                                type:            'thinking',
                                startedAt:       new Date(),
                                userMessage,
                                generatedStatus: thinkingSynopsis,
                            });
                        } else {
                            // Generate responding synopsis asynchronously
                            if(dynamicStatusGenerator) {
                                void (async () => {
                                    try {
                                        const synopsis = await dynamicStatusGenerator.generateSynopsis({
                                            phase:            'responding',
                                            userMessage,
                                            // Stryker disable next-line OptionalChaining: Equivalent - try/catch swallows TypeError when text is undefined
                                            responseFragment: event.delta?.text?.slice(0, 100),
                                        });
                                        void safeUpdatePhase({
                                            type:            'responding',
                                            startedAt:       new Date(),
                                            generatedStatus: synopsis,
                                        });
                                    } catch{
                                        void safeUpdatePhase({
                                            type:      'responding',
                                            startedAt: new Date(),
                                        });
                                    }
                                })();
                            } else {
                                void safeUpdatePhase({
                                    type:      'responding',
                                    startedAt: new Date(),
                                });
                            }
                        }
                    }
                } else if(event.type === 'tool_progress') {
                    // Track tool invocations to show which tool is currently executing.
                    // Only update presence when transitioning to a new tool to minimize API calls.
                    const toolName = event.tool_name ?? 'unknown';

                    if(currentPhase !== 'using_tool' || toolName !== lastToolName) {
                        currentPhase = 'using_tool';
                        lastToolName = toolName;

                        // Stryker disable next-line ConditionalExpression: Equivalent - try/catch swallows TypeError when undefined
                        if(dynamicStatusGenerator) {
                            void (async () => {
                                try {
                                    const synopsis = await dynamicStatusGenerator.generateSynopsis({
                                        phase: 'using_tool',
                                        userMessage,
                                        toolName,
                                    });
                                    void safeUpdatePhase({
                                        type:            'using_tool',
                                        toolName,
                                        startedAt:       new Date(),
                                        generatedStatus: synopsis,
                                    });
                                } catch{
                                    void safeUpdatePhase({
                                        type:      'using_tool',
                                        toolName,
                                        startedAt: new Date(),
                                    });
                                }
                            })();
                        } else {
                            void safeUpdatePhase({
                                type:      'using_tool',
                                toolName,
                                startedAt: new Date(),
                            });
                        }
                    }
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
        } finally {
            // Clean up typing interval
            if(typingInterval) {
                clearInterval(typingInterval);
                logger.debug({ messageId: context.messageId }, 'Stopped typing indicator');
            }
        }
    };
}
