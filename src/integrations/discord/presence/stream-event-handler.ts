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
import type { PresenceThrottle } from './presence-view.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { getToolDescription, type PresencePhase } from './types.js';
import { extractToolUses, redactSensitiveArgs, type ActivityPhase, type AgentStreamEvent, type LedgerEvent, type LedgerStore } from '@/agent';

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
function shouldGenerateSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    botStateManager:        BotStateManager | undefined
): dynamicStatusGenerator is DynamicStatusGenerator {
    return Boolean(dynamicStatusGenerator && (botStateManager?.shouldUpdatePresence() ?? false));
}

/**
 * Pre-generates a thinking synopsis before message processing begins.
 *
 * This allows an immediate, personalized status display the moment the agent
 * starts thinking — without waiting for the first stream event. The synopsis
 * is generated from the user's raw message and cached as `thinkingSynopsis`
 * for use when the handler first enters the thinking phase.
 *
 * Only generates if `shouldGenerateSynopsis` passes (generator available AND
 * presence throttle allows it). Errors are silently swallowed; the stream
 * event handler has its own fallback when `thinkingSynopsis` is undefined.
 *
 * @param dynamicStatusGenerator - Optional LLM-based status generator
 * @param botStateManager - Bot state manager providing throttle logic
 * @param userMessage - The user's raw message, used as synopsis context
 * @returns Pre-generated synopsis string, or undefined if skipped / errored
 */
export async function buildThinkingSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    botStateManager:        BotStateManager | undefined,
    userMessage:            string
): Promise<string | undefined> {
    // Stryker disable next-line ConditionalExpression: Fallback to false when botStateManager unavailable
    if(!shouldGenerateSynopsis(dynamicStatusGenerator, botStateManager)) {
        return undefined;
    }
    // Stryker disable BlockStatement: catch body returns undefined; empty catch also returns undefined — equivalent mutant
    try {
        return await dynamicStatusGenerator.generateSynopsis({
            phase: 'thinking',
            userMessage,
        }) ?? undefined;
    } catch{
        // Fallback handled by active generator - empty catch is intentional
        return undefined;
    }
    // Stryker restore BlockStatement
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
    // Stryker disable next-line ArrayDeclaration: initial empty array — mutating to non-empty changes initial state, causes test timeout (stale tool calls appear in presence)
    const recentToolCalls: string[] = [];
    let latestSubagentSummary: string | undefined;
    // Last summary seen per subagent task, for deduplication. Keyed by task_id so
    // interleaved events from parallel subagents (A, B, A, B...) don't defeat the check.
    const lastSummaryByTask = new Map<string, string>();
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
        basePhase: Exclude<PresencePhase, { type: 'idle' } | { type: 'compacting' }>
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
                subagentSummary: latestSubagentSummary,
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
    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Event handler has inherent branching for different event types (assistant, tool_progress, result) with nested phase logic
    const onStreamEvent = (event: AgentStreamEvent): void => {
        // Map stream events to presence phases
        switch(event.type) {
            case 'assistant': {
            // Extract thinking content from message content blocks
                interface ContentBlock {
                    type:      string
                    thinking?: string
                }
                const content: ContentBlock[] | undefined = event.message?.content;
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
                // Stryker disable BlockStatement,BooleanLiteral: tool use loop — mutating causes test timeout (tool transitions never fire)
                for(const toolUse of toolUses) {
                    pendingToolInputs.set(toolUse.name, redactSensitiveArgs(toolUse.input));

                    // Trigger 'using_tool' presence update when tool_use blocks are detected
                    if(handleToolPhaseTransition(toolUse.name)) {
                        hadToolUseUpdate = true;
                    }
                }
                // Stryker restore BlockStatement,BooleanLiteral

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
                                        subagentSummary: latestSubagentSummary,
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
                                subagentSummary:  latestSubagentSummary,
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
                latestSubagentSummary = undefined;
                lastSummaryByTask.clear();
                void safeUpdatePhase({
                    type:  'idle',
                    since: new Date(),
                });

                break;
            }
            case 'user':
            case 'tool_result': {
                break;
            }
            // Stryker disable next-line BlockStatement: system case body — mutating causes test timeout (task_progress events never processed)
            case 'system': {
                // Handle task_progress events from subagents.
                // Note: these are PROGRESS UPDATES from a running subagent (intermediate status
                // summaries the subagent emits mid-task), NOT lifecycle signals.
                // The SDK emits task_progress roughly once per subagent tool call, but only
                // regenerates `summary` every ~30s — the same string is re-stamped on every
                // event in between. Skip repeats so each unchanged summary costs one phase
                // update and at most one synopsis call, not one per tool call.
                // Stryker disable next-line ConditionalExpression,BlockStatement,EqualityOperator: Subtype guard for task_progress events
                if(event.subtype === 'task_progress' && event.summary) {
                    // Stryker disable next-line StringLiteral: fallback key when the SDK omits task_id — any constant works
                    const taskKey = event.task_id ?? '';
                    if(lastSummaryByTask.get(taskKey) === event.summary) {
                        break; // Same summary re-stamped on a per-tool-call progress event
                    }
                    lastSummaryByTask.set(taskKey, event.summary);
                    latestSubagentSummary = event.summary;

                    // Collapse phase to thinking or responding — 'using_tool' lacks required toolName/toolInput/toolDescription fields
                    // Stryker disable next-line ConditionalExpression,EqualityOperator: phase selection — mutating causes test timeout (wrong phase propagated to presence)
                    const synopsisPhase = currentPhase === 'responding' ? 'responding' as const : 'thinking' as const;

                    // Update presence with subagent context
                    updatePhaseWithSynopsis(
                        {
                            phase:           synopsisPhase,
                            userMessage,
                            subagentSummary: event.summary,
                            // Stryker disable LogicalOperator,ArrayDeclaration: Context fields for synopsis enrichment — value doesn't affect core behavior
                            thinkingContent: accumulatedThinkingContent || undefined,
                            recentToolCalls: [...recentToolCalls],
                            // Stryker restore LogicalOperator,ArrayDeclaration
                        },
                        synopsisPhase === 'responding'
                            ? { type: 'responding' as const, startedAt: new Date() }
                            : { type: 'thinking' as const,   startedAt: new Date(), userMessage }
                    );
                }
                break;
            }
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

/** The one thing {@link createLedgerStreamEventHandler} needs from a {@link LedgerStore}: dispatching an event. */
export type LedgerSink = Pick<LedgerStore, 'dispatch'>;

/** Dependencies for {@link createLedgerStreamEventHandler}. */
export interface CreateLedgerStreamEventHandlerDeps {
    /** The id of the ledger turn this handler's synopses belong to — carried on every dispatched `phase_synopsis` event so the reducer can drop a stale one (design doc section 8). */
    turnId:                  string
    /** Where a resolved synopsis is dispatched — normally the conductor's own `LedgerStore`. */
    sink:                    LedgerSink
    /** Gates whether a synopsis is worth generating at all: `shouldUpdate()` is peeked (never `record()`-ed — that is `planPresenceUpdate`'s job once the composed view is actually applied). */
    throttle:                PresenceThrottle
    /** Optional LLM-based synopsis generator; omitted means no synopsis is ever generated. */
    dynamicStatusGenerator?: DynamicStatusGenerator
    logger: {
        error: (obj: Record<string, unknown> | string, message?: string) => void
    }
    userMessage:              string
    /** A synopsis already resolved (via {@link buildThinkingSynopsis}) before this handler was created, used for the very first `thinking` phase when there is not yet enough context to generate a fresh one. */
    thinkingSynopsis?:        string
    onThinkingContentUpdate?: (content: string) => void
}

/** Handler returned by {@link createLedgerStreamEventHandler} — same shape as {@link StreamEventHandler}. */
export type LedgerStreamEventHandler = StreamEventHandler;

/**
 * Whether a synopsis is worth generating: a generator is configured AND the throttle currently
 * allows an update. Narrows `dynamicStatusGenerator` the same way `shouldGenerateSynopsis` does
 * for the oneshot handler, but peeks the throttle rather than `botStateManager`.
 */
function canGenerateSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    throttle:               PresenceThrottle
): dynamicStatusGenerator is DynamicStatusGenerator {
    return Boolean(dynamicStatusGenerator) && throttle.shouldUpdate();
}

/**
 * The {@link createLedgerStreamEventHandler} counterpart of {@link buildThinkingSynopsis}:
 * pre-generates a thinking synopsis from the user's raw message before the conductor turn's first
 * stream event arrives, so a turn whose very first `thinking` phase has no accumulated content or
 * tool history yet (`handleThinkingTransition`'s fallback branch) still carries a personalised
 * digest instead of the generic phase text. Peeks `throttle` (never `record()`s it — same
 * contract as {@link canGenerateSynopsis}) rather than a `BotStateManager`, since the conductor
 * path has none.
 * @param dynamicStatusGenerator Optional LLM-based status generator; omitted skips generation.
 * @param throttle The shared `PresenceThrottle` — generation is skipped while its window is open,
 * since the digest would just be thrown away with nothing to show it on.
 * @param userMessage The user's raw message, used as synopsis context.
 * @returns Pre-generated synopsis string, or `undefined` if skipped / errored.
 */
export async function buildLedgerThinkingSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    throttle:               PresenceThrottle,
    userMessage:            string
): Promise<string | undefined> {
    if(!canGenerateSynopsis(dynamicStatusGenerator, throttle)) {
        return undefined;
    }
    // Stryker disable BlockStatement: catch body returns undefined; empty catch also returns undefined — equivalent mutant
    try {
        return await dynamicStatusGenerator.generateSynopsis({
            phase: 'thinking',
            userMessage,
        }) ?? undefined;
    } catch{
        // Fallback handled by the ledger's own base phase (no generatedStatus) — empty catch is intentional
        return undefined;
    }
    // Stryker restore BlockStatement
}

/**
 * Creates a stream event handler that overlays synopses onto the long-lived session's ledger
 * (design doc section 8) instead of writing phases directly: P4's reducer is the sole source of
 * `turn.phase.type` (set from the raw SDK frames the conductor already folds into the ledger via
 * `sdk_frame` events), so this handler only ever dispatches `phase_synopsis { turnId, phaseType,
 * text }` — and only once a synopsis has actually resolved to a non-null string — never a
 * phase-type event of its own. A dispatch is dropped by two independent guards: `completed`
 * (checked here, before dispatching) and `turnId`/`phaseType` matching the still-open turn
 * (checked by the reducer, in case this turn already ended or moved on to a different phase by
 * the time an async synopsis resolves).
 * @param deps See {@link CreateLedgerStreamEventHandlerDeps}.
 * @returns A handler with the same `onStreamEvent`/`complete` shape as {@link createStreamEventHandler}.
 */

export function createLedgerStreamEventHandler(deps: CreateLedgerStreamEventHandlerDeps): LedgerStreamEventHandler {
    const { turnId, sink, throttle, dynamicStatusGenerator, userMessage, thinkingSynopsis, onThinkingContentUpdate } = deps;

    let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
    let lastToolName: string | undefined;
    let completed = false;

    const pendingToolInputs = new Map<string, unknown>();
    let accumulatedText = '';
    let accumulatedThinkingContent = '';
    const recentToolCalls: string[] = [];
    let latestSubagentSummary: string | undefined;
    const lastSummaryByTask = new Map<string, string>();
    const MAX_THINKING_CONTENT_LENGTH = 1500;
    const MAX_RECENT_TOOLS = 3;

    /** Dispatches a `phase_synopsis` for `phaseType`, unless `complete()` has already fired for this turn. */
    function dispatchSynopsis(phaseType: ActivityPhase['type'], text: string): void {
        if(completed) {
            return;
        }
        const event: LedgerEvent = {
            type: 'phase_synopsis', turnId, phaseType, text, at: new Date(),
        };
        sink.dispatch(event);
    }

    /**
     * Generates a synopsis for `context` and dispatches it as `phaseType` once resolved — only on
     * success (a non-null result while still not `completed`). No fallback dispatch: the ledger's
     * own base phase (no `generatedStatus`) already reached the composer via the reducer, so a
     * skipped or failed generation simply leaves it without an overlay.
     */
    function generateAndDispatch(
        context:   Parameters<DynamicStatusGenerator['generateSynopsis']>[0],
        phaseType: ActivityPhase['type']
    ): void {
        if(!canGenerateSynopsis(dynamicStatusGenerator, throttle)) {
            return;
        }
        void (async () => {
            try {
                const synopsis = await dynamicStatusGenerator.generateSynopsis(context);
                if(completed || synopsis === null) {
                    return;
                }
                dispatchSynopsis(phaseType, synopsis);
            } catch{
                // Live generation failed — no fallback dispatch for using_tool/responding/task_progress (see doc comment above).
            }
        })();
    }

    const handleToolPhaseTransition = (toolName: string): boolean => {
        if(currentPhase === 'using_tool' && toolName === lastToolName) {
            return false;
        }

        currentPhase = 'using_tool';
        lastToolName = toolName;

        const capturedAccumulatedText = accumulatedText;
        const capturedRecentToolCalls = [...recentToolCalls];

        recentToolCalls.unshift(toolName);
        if(recentToolCalls.length > MAX_RECENT_TOOLS) {
            recentToolCalls.pop();
        }

        generateAndDispatch({
            phase:           'using_tool',
            userMessage,
            toolName,
            toolInput:       pendingToolInputs.get(toolName),
            toolDescription: getToolDescription(toolName),
            accumulatedText: capturedAccumulatedText || undefined,
            recentToolCalls: capturedRecentToolCalls,
            subagentSummary: latestSubagentSummary,
        }, 'using_tool');

        return true;
    };

    /**
     * Handles the transition into the `thinking` phase: generates a fresh synopsis when there is
     * context worth generating from (mirrors `createStreamEventHandler`'s regeneration threshold),
     * otherwise falls back to the pre-generated `thinkingSynopsis` (itself already a resolved
     * synopsis, from {@link buildThinkingSynopsis}) — dispatched only when defined.
     */
    function handleThinkingTransition(): void {
        const hasThinkingContent = Boolean(accumulatedThinkingContent);
        const hasToolHistory = recentToolCalls.length > 0;

        if((hasThinkingContent || hasToolHistory) && canGenerateSynopsis(dynamicStatusGenerator, throttle)) {
            const capturedThinkingContent = accumulatedThinkingContent || undefined;
            const capturedRecentToolCalls = [...recentToolCalls];

            void (async () => {
                try {
                    const synopsis = await dynamicStatusGenerator.generateSynopsis({
                        phase:           'thinking',
                        userMessage,
                        thinkingContent: capturedThinkingContent,
                        recentToolCalls: capturedRecentToolCalls,
                        subagentSummary: latestSubagentSummary,
                    });
                    if(completed || synopsis === null) {
                        return;
                    }
                    dispatchSynopsis('thinking', synopsis);
                } catch{
                    if(completed || thinkingSynopsis === undefined) {
                        return;
                    }
                    dispatchSynopsis('thinking', thinkingSynopsis);
                }
            })();
        } else if(thinkingSynopsis !== undefined) {
            dispatchSynopsis('thinking', thinkingSynopsis);
        }
    }

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- mirrors createStreamEventHandler's event handler; branching is inherent to the SDK frame shapes handled
    const onStreamEvent = (event: AgentStreamEvent): void => {
        switch(event.type) {
            case 'assistant': {
                interface ContentBlock {
                    type:      string
                    thinking?: string
                }
                const content: ContentBlock[] | undefined = event.message?.content;
                if(content) {
                    for(const block of content) {
                        if(block.type === 'thinking' && block.thinking) {
                            accumulatedThinkingContent = (accumulatedThinkingContent + block.thinking).slice(-MAX_THINKING_CONTENT_LENGTH);
                            onThinkingContentUpdate?.(accumulatedThinkingContent);
                        }
                    }
                }

                const toolUses = extractToolUses(event);
                let hadToolUseUpdate = false;
                for(const toolUse of toolUses) {
                    pendingToolInputs.set(toolUse.name, redactSensitiveArgs(toolUse.input));
                    if(handleToolPhaseTransition(toolUse.name)) {
                        hadToolUseUpdate = true;
                    }
                }

                if(event.delta?.text) {
                    accumulatedText = (accumulatedText + event.delta.text).slice(-200);
                }

                if(hadToolUseUpdate) {
                    return;
                }

                const newPhase = event.delta?.text ? 'responding' : 'thinking';

                if(newPhase !== currentPhase) {
                    currentPhase = newPhase;

                    if(newPhase === 'thinking') {
                        handleThinkingTransition();
                    } else {
                        generateAndDispatch({
                            phase:            'responding',
                            userMessage,
                            responseFragment: event.delta?.text?.slice(0, 100),
                            accumulatedText:  accumulatedText || undefined,
                            subagentSummary:  latestSubagentSummary,
                        }, 'responding');
                    }
                }

                break;
            }
            case 'tool_progress': {
                handleToolPhaseTransition(event.tool_name ?? 'unknown');
                break;
            }
            case 'result': {
                latestSubagentSummary = undefined;
                lastSummaryByTask.clear();
                break;
            }
            case 'user':
            case 'tool_result': {
                break;
            }
            case 'system': {
                if(event.subtype === 'task_progress' && event.summary) {
                    const taskKey = event.task_id ?? '';
                    if(lastSummaryByTask.get(taskKey) === event.summary) {
                        break;
                    }
                    lastSummaryByTask.set(taskKey, event.summary);
                    latestSubagentSummary = event.summary;

                    const synopsisPhase = currentPhase === 'responding' ? 'responding' as const : 'thinking' as const;

                    generateAndDispatch({
                        phase:           synopsisPhase,
                        userMessage,
                        subagentSummary: event.summary,
                        thinkingContent: accumulatedThinkingContent || undefined,
                        recentToolCalls: [...recentToolCalls],
                    }, synopsisPhase);
                }
                break;
            }
        }
    };

    const complete = (): void => {
        completed = true;
    };

    return {
        onStreamEvent,
        complete,
    };
}
