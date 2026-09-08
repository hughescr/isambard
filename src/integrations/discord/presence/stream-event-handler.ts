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

import type { PresenceThrottle } from './presence-view.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { getToolDescription } from './types.js';
import { extractToolUses, redactSensitiveArgs, type ActivityPhase, type AgentStreamEvent, type LedgerEvent, type LedgerStore } from '@/agent';

/**
 * Stream event handler interface.
 */
export interface StreamEventHandler {
    /** Handler function to be called for each stream event */
    onStreamEvent: (event: AgentStreamEvent) => void
    /** Call when processing completes to clear activity phase */
    complete:      () => void
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
 * allows an update. Narrows `dynamicStatusGenerator` to non-`undefined`; peeks `throttle` (never
 * `record()`s it — recording happens once the composed view is actually applied).
 */
function canGenerateSynopsis(
    dynamicStatusGenerator: DynamicStatusGenerator | undefined,
    throttle:               PresenceThrottle
): dynamicStatusGenerator is DynamicStatusGenerator {
    return Boolean(dynamicStatusGenerator) && throttle.shouldUpdate();
}

/**
 * Pre-generates a thinking synopsis from the user's raw message before the conductor turn's first
 * stream event arrives, so a turn whose very first `thinking` phase has no accumulated content or
 * tool history yet (`handleThinkingTransition`'s fallback branch) still carries a personalised
 * digest instead of the generic phase text. Peeks `throttle` (never `record()`s it — same
 * contract as {@link canGenerateSynopsis}), the sole gate the conductor path has for whether
 * generation is worth it.
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
 * (checked here, before dispatching) and `turnId` matching the still-open turn (checked by the
 * reducer, in case this turn already ended by the time an async synopsis resolves). `phaseType`
 * is informational only: the reducer deliberately applies a digest whose phase has since flipped
 * within the same turn, and carries it across later flips until a fresher one lands.
 * @param deps See {@link CreateLedgerStreamEventHandlerDeps}.
 * @returns A handler of shape {@link LedgerStreamEventHandler} (same `onStreamEvent`/`complete` shape as {@link StreamEventHandler}).
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
     * context worth generating from (accumulated thinking content or prior tool history),
     * otherwise falls back to the pre-generated `thinkingSynopsis` (itself already a resolved
     * synopsis, from {@link buildLedgerThinkingSynopsis}) — dispatched only when defined.
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

    // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- branching is inherent to the SDK frame shapes handled
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
