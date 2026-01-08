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
import type { PresencePhase } from './types.js';
import { getToolDescription } from './types.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import type { ClaudeAgent } from '../../../agent/agent.js';
import { extractToolUses, redactSensitiveArgs } from '../../../agent/agent.js';
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

        // Track current phase for transition detection
        let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
        let lastToolName: string | undefined;
        const userMessage = context.content;

        // Track accumulated state from stream events for rich context
        const pendingToolInputs = new Map<string, unknown>();
        let accumulatedText = '';
        let accumulatedThinkingContent = '';
        const recentToolCalls: string[] = [];
        const MAX_THINKING_CONTENT_LENGTH = 500;
        const MAX_RECENT_TOOLS = 3;

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

        try {
            // Start typing indicator
            if(channel) {
                await channel.sendTyping();
                logger.debug({ messageId: context.messageId }, 'Started typing indicator');

                // Refresh typing every 8 seconds (Discord timeout is ~10s)
                typingInterval = setInterval(() => {
                    void channel.sendTyping().catch((error: unknown) => {
                        logger.error({ error, messageId: context.messageId, msg: 'Failed to send typing indicator' });
                    });
                }, 8000);
            }

            // Define stream event handler
            // eslint-disable-next-line complexity -- Event handler has inherent branching for different event types
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

                /**
                 * Generates synopsis and updates phase, with fallback on error.
                 * Checks shouldUpdate() before making expensive LLM calls.
                 *
                 * @param synopsisContext - Context for synopsis generation
                 * @param basePhase - Phase to update to (without generatedStatus)
                 */
                const updatePhaseWithSynopsis = (
                    synopsisContext: Parameters<NonNullable<typeof dynamicStatusGenerator>['generateSynopsis']>[0],
                    basePhase: Exclude<PresencePhase, { type: 'idle' }>
                ): void => {
                    // Stryker disable next-line ConditionalExpression: Equivalent - try/catch swallows TypeError when undefined
                    if(dynamicStatusGenerator && presenceManager.shouldUpdate()) {
                        void (async () => {
                            try {
                                const synopsis = await dynamicStatusGenerator.generateSynopsis(synopsisContext);
                                void safeUpdatePhase({
                                    ...basePhase,
                                    generatedStatus: synopsis,
                                });
                            } catch{
                                void safeUpdatePhase(basePhase);
                            }
                        })();
                    } else {
                        void safeUpdatePhase(basePhase);
                    }
                };

                /**
                 * Handles phase transition to 'using_tool' state.
                 * Extracted to avoid duplicate logic between 'assistant' and 'tool_progress' event handlers.
                 *
                 * @param toolName - Name of the tool being used
                 * @returns true if a phase transition occurred, false if already in same tool phase
                 */
                const handleToolPhaseTransition = (toolName: string): boolean => {
                    // Check if this is a new tool transition
                    if(currentPhase === 'using_tool' && toolName === lastToolName) {
                        return false;
                    }

                    currentPhase = 'using_tool';
                    lastToolName = toolName;

                    // Capture current state for async closure (BEFORE adding current tool)
                    // recentToolCalls represents PREVIOUS tools, not including current
                    const capturedAccumulatedText = accumulatedText;
                    const capturedRecentToolCalls = [...recentToolCalls];

                    // Add current tool to recent AFTER capturing (current tool goes into history for next call)
                    recentToolCalls.unshift(toolName);
                    if(recentToolCalls.length > MAX_RECENT_TOOLS) {
                        recentToolCalls.pop();
                    }

                    updatePhaseWithSynopsis(
                        {
                            phase:           'using_tool',
                            userMessage,
                            toolName,
                            toolInput:       pendingToolInputs.get(toolName),
                            toolDescription: getToolDescription(toolName),
                            accumulatedText: capturedAccumulatedText || undefined,
                            recentToolCalls: capturedRecentToolCalls,
                        },
                        {
                            type:      'using_tool',
                            toolName,
                            startedAt: new Date(),
                        }
                    );

                    return true;
                };

                // Map stream events to presence phases
                if(event.type === 'assistant') {
                    // Extract thinking content from message content blocks
                    interface ContentBlock {
                        type:      string
                        thinking?: string
                    }
                    const content = event.message?.content as ContentBlock[] | undefined;
                    if(content) {
                        for(const block of content) {
                            // Stryker disable next-line ConditionalExpression: Type guard - only thinking blocks have .thinking property
                            if(block.type === 'thinking' && block.thinking) {
                                accumulatedThinkingContent = (accumulatedThinkingContent + block.thinking).slice(-MAX_THINKING_CONTENT_LENGTH);
                            }
                        }
                    }

                    // Extract tool_use blocks and store redacted inputs for later use
                    const toolUses = extractToolUses(event);
                    let hadToolUseUpdate = false;
                    for(const toolUse of toolUses) {
                        pendingToolInputs.set(toolUse.name, redactSensitiveArgs(toolUse.input));

                        // Trigger 'using_tool' presence update when tool_use blocks are detected
                        if(handleToolPhaseTransition(toolUse.name)) {
                            hadToolUseUpdate = true;
                        }
                    }

                    // Accumulate response text for context (keep last 200 chars)
                    if(event.delta?.text) {
                        accumulatedText = (accumulatedText + event.delta.text).slice(-200);
                    }

                    // Skip thinking/responding phase detection if we just processed tool_use blocks
                    // The tool_use blocks indicate tool execution, not thinking/responding
                    if(hadToolUseUpdate) {
                        return;
                    }

                    // Stryker disable next-line StringLiteral: Equivalent - newPhase used only for state tracking; updatePhase uses hardcoded literals
                    const newPhase = event.delta?.text ? 'responding' : 'thinking';

                    if(newPhase !== currentPhase || presenceManager.shouldUpdate()) {
                        currentPhase = newPhase;

                        if(newPhase === 'thinking') {
                            // Check if we have accumulated context that warrants regeneration
                            const hasThinkingContent = Boolean(accumulatedThinkingContent);
                            const hasToolHistory = recentToolCalls.length > 0;

                            if((hasThinkingContent || hasToolHistory) && dynamicStatusGenerator && presenceManager.shouldUpdate()) {
                                // Capture current state for async closure
                                const capturedThinkingContent = accumulatedThinkingContent || undefined;
                                const capturedRecentToolCalls = [...recentToolCalls];

                                void (async () => {
                                    try {
                                        const synopsis = await dynamicStatusGenerator.generateSynopsis({
                                            phase:           'thinking',
                                            userMessage,
                                            thinkingContent: capturedThinkingContent,
                                            recentToolCalls: capturedRecentToolCalls,
                                        });
                                        // Stryker disable next-line ObjectLiteral: All properties required for presence update
                                        void safeUpdatePhase({
                                            type:            'thinking',
                                            startedAt:       new Date(),
                                            userMessage,
                                            generatedStatus: synopsis,
                                        });
                                    } catch{
                                        void safeUpdatePhase({
                                            type:            'thinking',
                                            startedAt:       new Date(),
                                            userMessage,
                                            generatedStatus: thinkingSynopsis,
                                        });
                                    }
                                })();
                            } else {
                                // Use pre-generated thinking synopsis when no thinking content yet or dynamicStatusGenerator unavailable
                                void safeUpdatePhase({
                                    type:            'thinking',
                                    startedAt:       new Date(),
                                    userMessage,
                                    generatedStatus: thinkingSynopsis,
                                });
                            }
                        } else {
                            updatePhaseWithSynopsis(
                                {
                                    phase:            'responding',
                                    userMessage,
                                    // Stryker disable next-line OptionalChaining: Equivalent - try/catch swallows TypeError when text is undefined
                                    responseFragment: event.delta?.text?.slice(0, 100),
                                    accumulatedText:  accumulatedText || undefined,
                                },
                                {
                                    type:      'responding',
                                    startedAt: new Date(),
                                }
                            );
                        }
                    }
                } else if(event.type === 'tool_progress') {
                    // Track tool invocations to show which tool is currently executing.
                    // Only update presence when transitioning to a new tool to minimize API calls.
                    handleToolPhaseTransition(event.tool_name ?? 'unknown');
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
            // Stryker disable next-line ConditionalExpression: clearInterval(null) is a no-op in JS, equivalent behavior
            if(typingInterval) {
                clearInterval(typingInterval);
                logger.debug({ messageId: context.messageId }, 'Stopped typing indicator');
            }
        }
    };
}
