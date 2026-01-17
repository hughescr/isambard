/**
 * Stream Event Handler
 *
 * Reusable stream event handler for Discord presence updates.
 * Extracts the sophisticated event handling logic from middleware to be shared
 * with the message coordinator's processor.
 *
 * The handler tracks agent activity (thinking, tool usage, responding) through
 * stream events and updates Discord presence accordingly with:
 * - Phase transition tracking (currentPhase, lastToolName)
 * - State accumulation (pendingToolInputs, accumulatedText, etc.)
 * - Synopsis generation with rich context
 * - Duplicate transition prevention
 */

import type { PresenceManager } from './manager.js';
import type { PresencePhase } from './types.js';
import { getToolDescription } from './types.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { extractToolUses, redactSensitiveArgs } from '../../../agent/agent.js';
import type { AgentStreamEvent } from '../../../agent/types.js';

/**
 * Dependencies for creating a stream event handler.
 */
export interface StreamEventHandlerDeps {
    /** Presence manager for updating Discord status */
    presenceManager:         PresenceManager
    /** Optional dynamic status generator for LLM-generated synopses */
    dynamicStatusGenerator?: DynamicStatusGenerator
    /** Logger instance */
    logger: {
        error: (obj: Record<string, unknown> | string, message?: string) => void
    }
    /** The user's original message being processed */
    userMessage:       string
    /** Optional message ID for logging */
    messageId?:        string
    /** Optional pre-generated thinking synopsis */
    thinkingSynopsis?: string
}

/**
 * Stream event handler interface.
 */
export interface StreamEventHandler {
    /** Handler function to be called for each stream event */
    onStreamEvent: (event: AgentStreamEvent) => void
    /** Call when processing completes to transition to idle */
    complete:      () => void
}

/**
 * Creates a reusable stream event handler for Discord presence updates.
 *
 * The handler maintains state across stream events to provide rich context
 * for synopsis generation and avoid redundant presence updates.
 *
 * @param deps - Dependencies including presence manager and logger
 * @returns Stream event handler with onStreamEvent callback and complete method
 *
 * @example
 * ```typescript
 * const { onStreamEvent, complete } = createStreamEventHandler({
 *   presenceManager: myPresenceManager,
 *   dynamicStatusGenerator: myDynamicStatusGenerator,
 *   logger: myLogger,
 *   userMessage: 'What is the weather?',
 *   messageId: '123',
 *   thinkingSynopsis: 'Thinking about weather...'
 * });
 *
 * // Pass onStreamEvent to agent.chat or chatBatch
 * await agent.chat(context, onStreamEvent);
 *
 * // Call complete when done
 * complete();
 * ```
 */
export function createStreamEventHandler(
    deps: StreamEventHandlerDeps
): StreamEventHandler {
    const { presenceManager, dynamicStatusGenerator, logger, userMessage, messageId, thinkingSynopsis } = deps;

    // Track current phase for transition detection
    let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
    let lastToolName: string | undefined;

    // Track accumulated state from stream events for rich context
    const pendingToolInputs = new Map<string, unknown>();
    let accumulatedText = '';
    let accumulatedThinkingContent = '';
    const recentToolCalls: string[] = [];
    const MAX_THINKING_CONTENT_LENGTH = 500;
    const MAX_RECENT_TOOLS = 3;

    // Helper to handle presence update errors
    const safeUpdatePhase = async (phase: PresencePhase): Promise<void> => {
        try {
            await presenceManager.updatePhase(phase);
        } catch (error) {
            // Don't crash on presence update errors
            // Stryker disable next-line ObjectLiteral: Logging metadata only
            logger.error(
                { error, messageId },
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
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Rate-limit optimization - prevents redundant Discord API calls
        if(currentPhase === 'using_tool' && toolName === lastToolName) {
            // Stryker disable next-line BooleanLiteral: Return false to skip redundant phase update
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
        // Stryker disable next-line ConditionalExpression,EqualityOperator: Memory optimization - bounds array size
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

    // Define stream event handler
    // eslint-disable-next-line complexity -- Event handler has inherent branching for different event types
    const onStreamEvent = (event: AgentStreamEvent): void => {
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
                        // Stryker disable next-line MethodExpression: Truncation optimization - bounds accumulated content
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
                    // Stryker disable next-line ConditionalExpression,EqualityOperator: Synopsis optimization - tool history presence check
                    const hasToolHistory = recentToolCalls.length > 0;

                    // Stryker disable next-line ConditionalExpression,LogicalOperator: Synopsis optimization - regeneration threshold
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
                            // Stryker disable next-line MethodExpression: Truncation optimization for synopsis input
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

    /**
     * Completes the handler and transitions to idle phase.
     * Call this when processing is done.
     */
    const complete = (): void => {
        void safeUpdatePhase({
            type:  'idle',
            since: new Date(),
        });
    };

    return {
        onStreamEvent,
        complete,
    };
}
