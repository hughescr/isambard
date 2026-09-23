/**
 * The turn synopsis stream handler: one per open ledger turn (opened by `turn-synopsis.ts`).
 *
 * It follows the turn's stream events — thinking, tool usage, responding — only to decide WHEN a
 * fresh turn synopsis is worth generating and with WHAT context, and dispatches each resolved
 * synopsis into the session's own `LedgerStore` as a `turn_synopsis` event. It never writes a
 * phase: the ledger reducer is the sole source of `turn.phase` (from the raw SDK frames).
 *
 * - Phase transition tracking (currentPhase, lastToolName)
 * - State accumulation (pendingToolInputs, accumulatedText, etc.)
 * - Synopsis generation with rich context, gated by the session's {@link SynopsisBudget}
 * - Duplicate transition prevention
 *
 * @module agent/session/synopsis-stream-handler
 */

import { redactSensitiveArgs } from '../stream-extractors';
import type { AgentStreamEvent } from '../types';
import type { LedgerEvent, LedgerStore } from './ledger';
import { getToolDescription, type SynopsisContext, type SynopsisGenerator } from './synopsis-generator';
import type { Clock } from './types';

/**
 * The per-session gate deciding whether a turn synopsis is worth generating right now. Every
 * `true` answer SPENDS it (see `createSynopsisBudget` in `turn-synopsis.ts`), so a caller asks
 * only at the moment it would start a generation.
 */
export interface SynopsisBudget {
    /** True — and the budget is spent — when a generation may start now. */
    shouldGenerate(): boolean
}

/**
 * Turn synopsis stream handler: fed every stream event of one turn, completed when it closes.
 */
export interface SynopsisStreamHandler {
    /** Handler function to be called for each stream event */
    onStreamEvent: (event: AgentStreamEvent) => void
    /** Call when the turn closes: no synopsis is dispatched after this */
    complete:      () => void
}

/** Dependencies for {@link createSynopsisStreamHandler}. */
export interface CreateSynopsisStreamHandlerDeps {
    /** The id of the ledger turn this handler's synopses belong to — carried on every dispatched `turn_synopsis` event so the reducer can drop a stale one (design doc section 8). */
    turnId:                   string
    /** Where a resolved synopsis is dispatched — normally the conductor's own `LedgerStore`. */
    sink:                     Pick<LedgerStore, 'dispatch'>
    /** This session's generation budget: asked (and so spent) only when a generation would start. */
    budget:                   SynopsisBudget
    /** This session's own per-instance generator (P14). */
    generator:                SynopsisGenerator
    /** Stamps each dispatched event's `at`: the session core never reads the wall clock directly. */
    clock:                    Pick<Clock, 'now'>
    userMessage:              string
    /**
     * The seed synopsis (via {@link buildSeedSynopsis}) whose generation started when this
     * handler's turn opened. A PROMISE rather than a resolved string because generation starts at
     * turn-open: awaiting it first would leave the turn's opening frames unhandled. It is
     * dispatched as soon as it settles — whatever the turn's first frames turn out to be (a
     * tool call, reply text, thinking, or the `result` that closes it) — unless the turn has
     * completed, it resolved to `undefined` (no seed, skipped, or failed), or something fresher
     * has already been dispatched. Resolving to `undefined`, or rejecting, simply means no seed.
     */
    thinkingSynopsis?:        Promise<string | undefined>
    onThinkingContentUpdate?: (content: string) => void
}

/**
 * Pre-generates the seed synopsis from the turn's seed (the user's raw message) the moment the
 * turn opens, before its first stream event arrives. Asks `budget` first, so a seed generation
 * spends the session's window like any other.
 * @param generator This session's synopsis generator.
 * @param budget This session's {@link SynopsisBudget} — generation is skipped when it says no.
 * @param userMessage The turn's seed, used as synopsis context.
 * @returns The seed synopsis, or `undefined` if skipped / errored.
 */
export async function buildSeedSynopsis(
    generator:   SynopsisGenerator,
    budget:      SynopsisBudget,
    userMessage: string
): Promise<string | undefined> {
    if(!budget.shouldGenerate()) {
        return undefined;
    }
    try {
        return await generator.generateSynopsis({
            phase: 'thinking',
            userMessage,
        }) ?? undefined;
    } catch{
        // No seed — the ledger's turn simply has no synopsis yet; empty catch is intentional
    }
    return undefined;
}

/**
 * Creates a stream event handler that publishes turn synopses into the long-lived session's
 * ledger (design doc section 8) instead of writing phases directly: the reducer is the sole
 * source of `turn.phase.type` (set from the raw SDK frames the conductor already folds into the
 * ledger via `sdk_frame` events), so this handler only ever dispatches
 * `turn_synopsis { turnId, text, at }` — and only once a synopsis has actually resolved to a
 * non-null string. A dispatch is dropped by two independent guards: `completed` (checked here,
 * before dispatching) and `turnId` matching the still-open turn (checked by the reducer, in case
 * this turn already ended by the time an async synopsis resolves).
 * @param deps See {@link CreateSynopsisStreamHandlerDeps}.
 * @returns A {@link SynopsisStreamHandler}.
 */
export function createSynopsisStreamHandler(deps: CreateSynopsisStreamHandlerDeps): SynopsisStreamHandler {
    const { turnId, sink, budget, generator, clock, userMessage, thinkingSynopsis, onThinkingContentUpdate } = deps;

    let currentPhase: 'thinking' | 'using_tool' | 'responding' | null = null;
    let lastToolName: string | undefined;
    let completed = false;
    /**
     * Whether this handler has dispatched ANY synopsis yet. Gates the seed: the pre-generated text
     * is a placeholder for the start of the turn, so once anything fresher has gone out it must
     * never be dispatched — a stale "Audit trail…" overwrote two later, fresher synopses minutes
     * into a production turn, each overwrite reaching Discord immediately via presence-setup's
     * synopsis-arrival bypass.
     */
    let anySynopsisDispatched = false;

    const pendingToolInputs = new Map<string, unknown>();
    let accumulatedText = '';
    let accumulatedThinkingContent = '';
    const recentToolCalls: string[] = [];
    let latestSubagentSummary: string | undefined;
    const lastSummaryByTask = new Map<string, string>();
    const MAX_THINKING_CONTENT_LENGTH = 1500;
    const MAX_RECENT_TOOLS = 3;

    /** Dispatches a `turn_synopsis` after the async caller has checked this turn is still live. */
    function dispatchSynopsis(text: string): void {
        anySynopsisDispatched = true;
        const event: LedgerEvent = {
            type: 'turn_synopsis', turnId, text, at: new Date(clock.now()),
        };
        sink.dispatch(event);
    }

    /**
     * Generates a synopsis for `context` and dispatches it once resolved — only on success (a
     * non-null result while still not `completed`). No fallback dispatch: a skipped or failed
     * generation simply leaves the turn's current synopsis (if any) in place.
     */
    function generateAndDispatch(context: SynopsisContext): void {
        if(!budget.shouldGenerate()) {
            return;
        }
        void (async () => {
            try {
                const synopsis = await generator.generateSynopsis(context);
                // Stryker disable next-line llm: generateSynopsis is typed Promise<string | null>, so == null and === null accept the same values.
                if(completed || synopsis === null) {
                    return;
                }
                dispatchSynopsis(synopsis);
            } catch{
                // Live generation failed — no fallback dispatch (see doc comment above).
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
            // Stryker disable next-line llm: lastToolName was just assigned toolName, so both Map keys are identical here.
            toolInput:       pendingToolInputs.get(toolName),
            // Stryker disable next-line llm: lastToolName was just assigned toolName, so both description arguments are identical here.
            toolDescription: getToolDescription(toolName),
            accumulatedText: capturedAccumulatedText || undefined,
            recentToolCalls: capturedRecentToolCalls,
            subagentSummary: latestSubagentSummary,
        });

        return true;
    };

    /**
     * Handles the transition into the `thinking` phase: generates a fresh synopsis when there is
     * context worth generating from (accumulated thinking content or prior tool history). The
     * context check comes first, so the budget is never spent on a transition with nothing to
     * say. With no context there is nothing to do here: the seed is already dispatched as soon as
     * it settles (see {@link CreateSynopsisStreamHandlerDeps.thinkingSynopsis}).
     */
    function handleThinkingTransition(): void {
        if(accumulatedThinkingContent === '' && recentToolCalls.length === 0) {
            return;
        }
        generateAndDispatch({
            phase:           'thinking',
            userMessage,
            thinkingContent: accumulatedThinkingContent || undefined,
            recentToolCalls: [...recentToolCalls],
            subagentSummary: latestSubagentSummary,
        });
    }

    const collectAssistantText = (event: Extract<AgentStreamEvent, { type: 'assistant' }>): string => {
        const content = event.message?.content;
        let completeText = '';
        // Stryker disable next-line llm: content is an array or undefined, and arrays are truthy, so ?? and || are equivalent.
        for(const block of content ?? []) {
            if(block.type === 'thinking' && block.thinking) {
                accumulatedThinkingContent = (accumulatedThinkingContent + block.thinking).slice(-MAX_THINKING_CONTENT_LENGTH);
                onThinkingContentUpdate?.(accumulatedThinkingContent);
            }
            if(block.type === 'text' && block.text) {
                completeText += block.text;
            }
        }
        return completeText;
    };

    const handleAssistantTools = (event: Extract<AgentStreamEvent, { type: 'assistant' }>): boolean => {
        let hadToolUseUpdate = false;
        for(const toolUse of event.message?.content?.filter(block => block.type === 'tool_use') ?? []) {
            pendingToolInputs.set(toolUse.name, redactSensitiveArgs(toolUse.input));
            if(handleToolPhaseTransition(toolUse.name)) {
                hadToolUseUpdate = true;
            }
        }
        return hadToolUseUpdate;
    };

    const handleAssistantEvent = (event: Extract<AgentStreamEvent, { type: 'assistant' }>): void => {
        // Complete frames concatenate every text block in order; partial frames use delta.
        const completeText = collectAssistantText(event);
        const hadToolUseUpdate = handleAssistantTools(event);

        // Partial frames carry the text as a delta, complete ones as a text block; either
        // way it is response text, so it both accumulates and marks the responding phase.
        // `||`, not `??`: a delta of '' is not text, and must not mask a real text block
        // on the same frame.
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty-string delta must fall through to the frame's text blocks, which ?? would not do
        const responseText = event.delta?.text || completeText;
        accumulatedText = (accumulatedText + responseText).slice(-200);

        if(hadToolUseUpdate) {
            return;
        }

        const newPhase = responseText ? 'responding' : 'thinking';

        if(newPhase !== currentPhase) {
            currentPhase = newPhase;

            if(newPhase === 'thinking') {
                handleThinkingTransition();
            } else {
                generateAndDispatch({
                    phase:           'responding',
                    userMessage,
                    // Stryker disable next-line llm: this branch requires nonempty responseText just appended to accumulatedText, so the fallback is unreachable.
                    accumulatedText: accumulatedText || undefined,
                    subagentSummary: latestSubagentSummary,
                });
            }
        }
    };

    const handleSystemEvent = (event: Extract<AgentStreamEvent, { type: 'system' }>): void => {
        if(event.subtype === 'task_progress' && event.summary) {
            // Stryker disable next-line llm: task_id is a string or undefined, for which ?? '' and || '' return the same string.
            const taskKey = event.task_id ?? '';
            if(lastSummaryByTask.get(taskKey) === event.summary) {
                return;
            }
            lastSummaryByTask.set(taskKey, event.summary);
            latestSubagentSummary = event.summary;

            generateAndDispatch({
                phase:           currentPhase === 'responding' ? 'responding' : 'thinking',
                userMessage,
                subagentSummary: event.summary,
                thinkingContent: accumulatedThinkingContent || undefined,
                recentToolCalls: [...recentToolCalls],
            });
        }
    };

    const onStreamEvent = (event: AgentStreamEvent): void => {
        switch(event.type) {
            case 'assistant': {
                handleAssistantEvent(event);
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
                handleSystemEvent(event);
                break;
            }
        }
    };

    const complete = (): void => {
        completed = true;
    };

    /**
     * Awaits the seed and dispatches it, unless the turn has since completed, the seed yielded
     * nothing, or something fresher already went out. Started once, at construction.
     *
     * No `thinkingSynopsis === undefined` fast path: `await undefined` is `undefined`, which the
     * `text === undefined` guard below already handles, so such a guard would be an equivalent
     * mutant rather than behaviour.
     */
    function dispatchSeedWhenSettled(): void {
        void (async () => {
            try {
                const text = await thinkingSynopsis;
                // Stryker disable next-line llm: thinkingSynopsis is typed Promise<string | undefined>, so == undefined and === undefined accept the same values.
                if(completed || text === undefined || anySynopsisDispatched) {
                    return;
                }
                dispatchSynopsis(text);
            } catch{
                // No seed — the turn simply has no synopsis until a live one lands.
            }
        })();
    }

    // The seed is dispatched as soon as it settles, whatever the turn's first frames are: waiting
    // for a `thinking` transition instead left a tool-first or text-first turn's seed generated,
    // paid for and discarded — and, since the seed spends the session's budget, left that turn
    // with no synopsis at all for a whole window. `anySynopsisDispatched` keeps it from ever
    // overwriting something fresher; `completed` keeps it off a turn that already closed.
    dispatchSeedWhenSettled();

    return {
        onStreamEvent,
        complete,
    };
}
