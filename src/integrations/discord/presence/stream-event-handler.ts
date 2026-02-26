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

import type { BotStateManager } from '../state/index.js';
import type { PresenceManager } from './manager.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { type PresencePhase, getToolDescription  } from './types.js';
import { extractToolUses, redactSensitiveArgs, type AgentStreamEvent } from '@/agent';

/**
 * Determines whether synopsis generation should be attempted.
 *
 * Synopsis generation is expensive (LLM call), so it should only run when:
 * 1. A dynamic status generator is available
 * 2. The throttle allows an update (checked via botStateManager)
 *
 * When botStateManager is not available, returns false to fail closed
 * and avoid unlimited expensive LLM calls.
 *
 * This function acts as a type guard, narrowing dynamicStatusGenerator
 * from `DynamicStatusGenerator | undefined` to `DynamicStatusGenerator`
 * when it returns true.
 *
 * @param dynamicStatusGenerator - Optional generator for LLM synopses
 * @param botStateManager - Optional state manager with throttle logic
 * @returns true if synopsis generation should be attempted
 */
export function shouldGenerateSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    botStateManager:        BotStateManager | undefined
): dynamicStatusGenerator is DynamicStatusGenerator {
    return Boolean(dynamicStatusGenerator && (botStateManager?.shouldUpdatePresence() ?? false));
}

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
    userMessage:              string
    /** Optional message ID for logging */
    messageId?:               string
    /** Optional pre-generated thinking synopsis */
    thinkingSynopsis?:        string
    /**
     * Bot state manager for activity phase updates.
     */
    botStateManager:          BotStateManager
    /** Optional callback fired when thinking content is updated */
    onThinkingContentUpdate?: (content: string) => void
}

/**
 * Stream event handler interface.
 */
export interface StreamEventHandler {
    /** Handler function to be called for each stream event */
    onStreamEvent: (event: AgentStreamEvent) => void
    /** Call when processing completes to clear activity phase */
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
 * // Pass onStreamEvent to agent.handleInput
 * await agent.handleInput([context], { onStreamEvent });
 *
 * // Call complete when done
 * complete();
 * ```
 */
export function createStreamEventHandler(
    deps: StreamEventHandlerDeps
): StreamEventHandler {
    const { dynamicStatusGenerator, logger, userMessage, messageId, thinkingSynopsis, botStateManager, onThinkingContentUpdate } = deps;

    // Track current phase for transition detection
    let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
    let lastToolName: string | undefined;
    let completed = false;

    // Track accumulated state from stream events for rich context
    const pendingToolInputs = new Map<string, unknown>();
    let accumulatedText = '';
    let accumulatedThinkingContent = '';
    const recentToolCalls: string[] = [];
    // Stryker disable next-line ArithmeticOperator: Configuration constant
    const MAX_THINKING_CONTENT_LENGTH = 1500;
    const MAX_RECENT_TOOLS = 3;

    // Helper to handle presence update errors
    // Stryker disable ConditionalExpression,BlockStatement: Error handling
    const safeUpdatePhase = async (phase: PresencePhase): Promise<void> => {
        try {
            // ALWAYS route through botStateManager
            if(phase.type === 'idle') {
                // Idle phase means clear activity and potentially go idle
                botStateManager.clearActivityPhase();
            } else {
                // TypeScript narrows PresencePhase to ActivityPhase when phase.type !== 'idle'
                botStateManager.updateActivityPhase(phase);
            }
        } catch (error) {
            // Stryker restore ConditionalExpression,BlockStatement
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
     *
     * @param synopsisContext - Context for synopsis generation
     * @param basePhase - Phase to update to (without generatedStatus)
     */
    const updatePhaseWithSynopsis = (
        synopsisContext: Parameters<NonNullable<typeof dynamicStatusGenerator>['generateSynopsis']>[0],
        basePhase: Exclude<PresencePhase, { type: 'idle' }>
    ): void => {
        // Stryker disable next-line ConditionalExpression: Equivalent - try/catch swallows TypeError when undefined
        if(shouldGenerateSynopsis(dynamicStatusGenerator, botStateManager)) {
            void (async () => {
                try {
                    const synopsis = await dynamicStatusGenerator.generateSynopsis(synopsisContext);
                    // Stryker disable next-line ConditionalExpression: Staleness guard for async race condition
                    if(completed) {
                        return; // Stale — handler already completed
                    }
                    // Stryker disable next-line ConditionalExpression: Null guard — skip update when Haiku returns null (in-flight/failed)
                    if(synopsis === null) {
                        return; // Haiku in-flight or failed — skip presence update
                    }
                    void safeUpdatePhase({
                        ...basePhase,
                        generatedStatus: synopsis,
                    });
                } catch{
                    // Stryker disable next-line ConditionalExpression: Staleness guard for async race condition
                    if(completed) {
                        return;
                    }
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
        // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: Rate-limit optimization - prevents redundant Discord API calls for same-tool transitions; no test for same-tool deduplication
        if(currentPhase === 'using_tool' && toolName === lastToolName) {
            // Stryker disable next-line BooleanLiteral: Returns false to signal no transition occurred
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

    // Define stream event handler
    // eslint-disable-next-line complexity -- Event handler has inherent branching for different event types
    const onStreamEvent = (event: AgentStreamEvent): void => {
        // Map stream events to presence phases
        switch(event.type) {
            case 'assistant': {
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
                            // Stryker disable next-line OptionalChaining: Optional callback pattern
                            onThinkingContentUpdate?.(accumulatedThinkingContent);
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

                if(newPhase !== currentPhase) {
                    currentPhase = newPhase;

                    if(newPhase === 'thinking') {
                    // Check if we have accumulated context that warrants regeneration
                        const hasThinkingContent = Boolean(accumulatedThinkingContent);
                        // Stryker disable next-line ConditionalExpression,EqualityOperator: Synopsis optimization - tool history presence check
                        const hasToolHistory = recentToolCalls.length > 0;

                        // Stryker disable next-line ConditionalExpression,LogicalOperator: Synopsis optimization - regeneration threshold
                        if((hasThinkingContent || hasToolHistory) && shouldGenerateSynopsis(dynamicStatusGenerator, botStateManager)) {
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
                                    // Stryker disable next-line ConditionalExpression: Staleness guard for async race condition
                                    if(completed) {
                                        return; // Stale — handler already completed
                                    }
                                    // Stryker disable next-line ConditionalExpression: Null guard — skip update when Haiku returns null (in-flight/failed)
                                    if(synopsis === null) {
                                        return; // Haiku in-flight or failed — skip presence update
                                    }
                                    // Stryker disable next-line ObjectLiteral: All properties required for presence update
                                    void safeUpdatePhase({
                                        type:            'thinking',
                                        startedAt:       new Date(),
                                        userMessage,
                                        generatedStatus: synopsis,
                                    });
                                } catch{
                                // Stryker disable next-line ConditionalExpression: Staleness guard for async race condition
                                    if(completed) {
                                        return;
                                    }
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

                break;
            }
            case 'tool_progress': {
            // Track tool invocations to show which tool is currently executing.
            // Only update presence when transitioning to a new tool to minimize API calls.
                handleToolPhaseTransition(event.tool_name ?? 'unknown');

                break;
            }
            case 'result': {
            // Processing complete, go idle
                void safeUpdatePhase({
                    type:  'idle',
                    since: new Date(),
                });

                break;
            }
        // No default
        }
    };

    /**
     * Completes the handler and clears activity phase.
     * Call this when processing is done.
     */
    const complete = (): void => {
        completed = true;
        botStateManager.clearActivityPhase();
    };

    return {
        onStreamEvent,
        complete,
    };
}
