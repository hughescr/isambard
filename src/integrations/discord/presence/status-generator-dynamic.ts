/**
 * Dynamic Status Generator
 *
 * Generates contextual Discord status synopses using Claude Haiku 4.5.
 * Provides evocative, phase-aware status messages based on current agent activity.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '@hughescr/logger';
import { getToolDescription, type SynopsisContext } from './types.js';
import { generateTextWithSystemPrompt, SYNOPSIS_SEED_CAP } from '@/agent';
import { truncateToWordBoundary, HARD_MAX_STATUS_LENGTH } from '@/utils';

/**
 * Interface for generating dynamic status synopses.
 */
export interface DynamicStatusGenerator {
    /**
     * Generate a contextual status synopsis for the current activity.
     *
     * @param context - The current activity context
     * @returns Promise resolving to a status string (max 40 chars), or null if a Haiku call is
     * in-flight, failed, or returned something that is not a status line (see {@link rejectSynopsis})
     */
    generateSynopsis(context: SynopsisContext): Promise<string | null>
}

/**
 * Dependencies for creating a dynamic status generator.
 */
interface DynamicStatusGeneratorDeps {
    /** Context about the assistant's identity for personalized status */
    identityContext: string
}

/**
 * The line every user prompt ends with, always present.
 *
 * Without an ask at the end, the prompt is a document of `##` sections and nothing else, so Haiku
 * commented on it instead of answering it ("Looking at what's happening here: Craig is asking me
 * to...", "I need to capture what's actually happening in this moment for Izzy."). Ending on the
 * question is what turns the snapshot back into a request for one status line.
 */
const CLOSING_ASK = "Izzy's status line right now (first person, under 40 characters, nothing else):";

const MAX_ACCUMULATED_TEXT_LENGTH = 150;
const MAX_TOOL_INPUT_LENGTH = 200;
const MAX_THINKING_CONTENT_LENGTH = 500;

// Rate limiting: minimum 2 seconds between Haiku calls (cooldown measured from call completion).
// P14: this used to be module-level state shared across every generator instance — a single
// shared cooldown/cache/in-flight-controller let one session's Haiku call abort the other
// session's in-flight call, and one session's cooldown gate the other's synopsis. It now lives in
// the closure `createDynamicStatusGenerator` returns, so each instance (one per session, per
// `presence-setup.ts`'s `setupConductorPresence`) keeps its own.
const HAIKU_COOLDOWN_MS = 2000;

/**
 * Human-readable labels used in the "Doing right now" section. `thinking` has two: the very first
 * synopsis of a turn is built from the user message alone (nothing has streamed, no tool has run),
 * which is a different moment from thinking mid-turn between two tool calls.
 */
const PHASE_LABELS = {
    using_tool:       'Using a tool',
    responding:       'Writing the reply',
    thinking_first:   'Just received the question, starting to think',
    thinking_ongoing: 'Thinking about the next step',
};

/**
 * The "Phase:" label for the current context — see {@link PHASE_LABELS} for the thinking split.
 *
 * @param context - The current activity context
 * @returns The human-readable phase label
 */
function phaseLabel(context: SynopsisContext): string {
    if(context.phase !== 'thinking') {
        return PHASE_LABELS[context.phase];
    }
    if(!context.thinkingContent && !context.recentToolCalls?.length) {
        return PHASE_LABELS.thinking_first;
    }
    return PHASE_LABELS.thinking_ongoing;
}

/**
 * Build the system prompt: the fixed instructions with Izzy's identity spliced in.
 *
 * @param identityContext - Izzy's self-written description of who they are
 * @returns The system prompt sent as `systemPrompt` (never concatenated into the user prompt)
 */
function buildSystemPrompt(identityContext: string): string {
    return `You write Izzy's Discord status line: one first-person thought, at most 40 characters, that shows what is on Izzy's mind at this exact instant.

## Who Izzy is
Izzy (Isambard) is an AI who has developed their own sense of identity. In Izzy's own words:

${identityContext}

## What you are given
A snapshot of Izzy's current turn, in labelled sections. A section with nothing to show is left out.
- "Question being answered": the message from the person Izzy is replying to.
- "Most recent thinking": the newest slice of Izzy's private reasoning, cut mid-stream. This is the freshest signal of what Izzy is doing right now. Weight it most.
- "Doing right now": the current phase. For a tool call, also the tool, what it does, and the arguments. When any reply text has been written, also the newest part of it.
- "Recent tools": tools Izzy used just before this moment, newest first.
- "Background work": what sub-agents Izzy launched are doing.
- "Previous status": the thought shown last time. Write a different one.

## How to write the thought
- First person, present tense, one line, no more than 40 characters.
- Make it about THIS moment. Pull one concrete detail from the most recent thinking or the current action: a file, a name, a doubt, a small discovery, a decision being made.
- Sound like Izzy, using the voice and personality described above.
- Prefer a present-participle opening ("Digging through...", "Wondering whether...", "Rereading...").
- Make each thought different from the last. Do not reuse the same opening twice in a row.

Never:
- Third person, or naming Izzy ("Izzy is...", "Isambard is...").
- Filler that fits any moment ("Thinking...", "Working on it...", "Processing...").
- Describing the job of writing a status, quoting these instructions, or adding a preamble.
- Quotation marks, markdown, emoji, or any explanation.

## Examples
Good (each is a complete answer):
- Digging through memories for that thread...
- Wondering whether the Goldstein cite holds
- Three essays, one fix—where does it go?
- Rereading my own repair plan, wincing

Bad (never answer like this):
- I need to capture what's happening for Izzy...   (narrates the job instead of doing it)
- Looking at what's happening here: Craig is...     (commentary, third person)
- Thinking...                                       (filler)
- "Pondering the question"                          (quotation marks)

Output only the thought.`;
}

/**
 * Format tool input as a JSON summary, truncated if needed.
 */
function formatToolInputSummary(toolInput: unknown): string {
    if(toolInput === undefined || toolInput === null) {
        return '(no input)';
    }

    try {
        const json = JSON.stringify(toolInput);
        if(json.length <= MAX_TOOL_INPUT_LENGTH) {
            return json;
        }
        return `${json.slice(0, MAX_TOOL_INPUT_LENGTH)}...`;
    } catch{
        // JSON.stringify can fail with circular refs, BigInt, etc.
        return '(complex input)';
    }
}

/**
 * Build the user prompt: a snapshot of the current turn as labelled `##` sections.
 *
 * Sections appear in a fixed order and are omitted entirely when they have nothing to show,
 * except "Doing right now" which always carries at least the phase label. {@link CLOSING_ASK} is
 * always the last line, whatever the sections are.
 *
 * Two deliberate tail-slices (P14b): the newest thinking and the newest reply text are what the
 * status should reflect, so both are cut from the END of the accumulated string, not the head.
 *
 * Kept pure: the previous status is passed in rather than read from the generator's own state, so
 * the whole prompt is a function of its arguments.
 *
 * @param context - The current activity context
 * @param previousStatus - The status this generator produced last time, or null on the first call
 * @returns The user prompt sent as the `userPrompt` argument
 */
function buildUserPrompt(context: SynopsisContext, previousStatus: string | null): string {
    const { phase, userMessage, toolName, toolInput, toolDescription, accumulatedText, thinkingContent, recentToolCalls, subagentSummary } = context;

    const sections: string[] = [];

    if(userMessage) {
        // SYNOPSIS_SEED_CAP, shared with the agent layer's `toSynopsisSeed`, is the ONE cap on
        // this section: `turn-synopsis.ts` builds every `userMessage` from `LedgerTurn.seed`,
        // which was already sliced to that width when the envelope was built. A second local
        // constant here could only ever drift into being unreachable.
        sections.push(`## Question being answered\n${userMessage.slice(0, SYNOPSIS_SEED_CAP)}`);
    }

    if(thinkingContent) {
        // TAIL, not head: the handler already keeps a rolling window, so the newest reasoning
        // is at the end. Taking the head would show Haiku thoughts from ~1000 chars ago.
        sections.push(`## Most recent thinking\n${thinkingContent.slice(-MAX_THINKING_CONTENT_LENGTH)}`);
    }

    const doingLines = [`Phase: ${phaseLabel(context)}`];
    if(phase === 'using_tool') {
        doingLines.push(
            `Tool: ${toolDescription ?? getToolDescription(toolName) ?? toolName ?? 'unknown tool'}`,
            `Arguments: ${formatToolInputSummary(toolInput)}`
        );
    }
    // TAIL of accumulatedText: the newest words written are the ones the status should reflect.
    const replySoFar = accumulatedText?.slice(-MAX_ACCUMULATED_TEXT_LENGTH);
    if(replySoFar) {
        doingLines.push(`Reply so far: ${replySoFar}`);
    }
    sections.push(`## Doing right now\n${doingLines.join('\n')}`);

    if(recentToolCalls?.length) {
        // Already newest-first from the caller. Descriptions, not bare names: "Searching file
        // contents" tells Haiku what the tool actually did, where "Grep" tells it nothing.
        sections.push(`## Recent tools\n${recentToolCalls.map(name => getToolDescription(name) ?? name).join(', ')}`);
    }

    if(subagentSummary) {
        sections.push(`## Background work\n${subagentSummary}`);
    }

    // Last: the system prompt asks for a thought different from the last one, which is only
    // possible if the last one is actually shown.
    if(previousStatus !== null) {
        sections.push(`## Previous status\n${previousStatus}`);
    }

    // Always last: see CLOSING_ASK. The prompt has to END on the question.
    sections.push(CLOSING_ASK);

    return sections.join('\n\n');
}

/**
 * One pair of double quotes wrapped around the whole response, straight or curly. Haiku sometimes
 * quotes the status even though the system prompt forbids it; that is a formatting tic, not a bad
 * status, so the quotes come off and the thought inside is kept.
 */
const SURROUNDING_QUOTES_PATTERN = /^["“]([\s\S]*)["”]$/;

/**
 * Openings that mean Haiku narrated the task instead of answering it. Every one of these is from
 * the production log after the prompt rewrite ("I need to capture what's actually happening in
 * this moment for Izzy.", "Looking at what's happening here: Craig is asking me to...").
 */
const META_OPENING_PATTERN = /^(?:I need to|I should|I'm generating|I'm going to write|Looking at (?:this|what)|Here's|Here is|Status:|Context:|Reading the context)/i;

/** Izzy written about rather than from: the one thing the system prompt forbids most explicitly. */
const THIRD_PERSON_PATTERN = /\b(?:Izzy|Isambard) (?:is|was|needs|wants)\b/;

/**
 * Judge a Haiku response: is this a status line, or a comment about the job of writing one?
 *
 * Checked in order, so the reason reported is the first thing wrong: a multiline narration is
 * `multiline`, not `meta`. A response over the hard cap is refused outright rather than trimmed —
 * a sentence that long is a paragraph of narration, and trimming it would cache a bad shape that
 * the next call's "## Previous status" section would then copy.
 *
 * @internal Exported for direct unit testing; production reaches it through executeWithCooldown.
 * @param text - The trimmed, quote-stripped response
 * @returns The reason to reject, or null when the response is usable
 */
export function rejectSynopsis(text: string): string | null {
    if(text.includes('\n')) {
        return 'multiline';
    }
    if(text.length > HARD_MAX_STATUS_LENGTH) {
        return 'too_long';
    }
    if(META_OPENING_PATTERN.test(text)) {
        return 'meta';
    }
    if(THIRD_PERSON_PATTERN.test(text)) {
        return 'third_person';
    }
    return null;
}

/**
 * Per-log-site shapes for executeWithCooldown.
 * Each entry is the exact object passed to the logger at that point.
 * The `msg` field is required; all other fields are caller-defined.
 */
interface CooldownLogContext {
    /** Logged (debug) when cancelling a previous in-flight Haiku call */
    inFlight:   Record<string, unknown> & { msg: string }
    /** Logged (debug) when returning the cached status during cooldown */
    cooldown:   Record<string, unknown> & { msg: string }
    /** Logged (debug) just before the generateTextWithSystemPrompt call */
    generating: Record<string, unknown> & { msg: string }
    /** Logged (info) on successful status generation (statusText is added by the helper) */
    success:    Record<string, unknown> & { msg: string }
    /** Logged (error) on failure (error is added by the helper) */
    failure:    Record<string, unknown> & { msg: string }
}

/**
 * Executes a Haiku call with cancel-and-replace, cooldown, caching, validation, truncation, and
 * error handling.
 *
 * @param promptBuilder - Function that builds the system and user prompts
 * @param logContext - Per-site log objects; each carries its own fields and `msg`
 * @param state - The calling instance's own cooldown/cache/in-flight-controller state (P14: no
 * longer module-level — see this file's own top-of-file doc note).
 * @returns Promise resolving to a status string, or null on error or a rejected response
 */
async function executeWithCooldown(
    promptBuilder: () => { systemPrompt: string | string[], userPrompt: string },
    logContext: CooldownLogContext,
    state: InstanceState
): Promise<string | null> {
    // Cancel-and-replace: abort any previous in-flight call (from THIS instance only) and start fresh
    // Stryker disable next-line ConditionalExpression,BlockStatement: abort previous call — cancel-and-replace pattern
    if(state.inFlightController) {
        state.inFlightController.abort();
        // Stryker disable next-line ObjectLiteral,StringLiteral: Debug logging for cancellation diagnostics
        logger.debug({ ...logContext.inFlight });
    }

    // Rate limiting - check if we're within cooldown window (measured from last call completion)
    const now = Date.now();
    // Stryker disable next-line EqualityOperator: < vs <= boundary at exact cooldown time is equivalent
    if(now - state.lastHaikuCall < HAIKU_COOLDOWN_MS && state.cachedStatus) {
        logger.debug(logContext.cooldown);
        return state.cachedStatus;
    }
    // No cache — fall through to make real call

    const controller = new AbortController();
    state.inFlightController = controller;

    try {
        const { systemPrompt, userPrompt } = promptBuilder();

        logger.debug(logContext.generating);

        // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
        const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true, abortController: controller });
        // Stryker disable next-line MethodExpression: trim() is defensive — generateTextWithSystemPrompt() already returns trimmed output
        const candidate = text.trim().replace(SURROUNDING_QUOTES_PATTERN, '$1');

        // Refuse narration rather than caching it: a bad status that reaches state.cachedStatus is
        // shown to the user AND fed back as "## Previous status" on the next call, which taught the
        // model that narration was the expected shape.
        const reason = rejectSynopsis(candidate);
        if(reason) {
            logger.warn({ rejectedText: candidate, reason, ...logContext.failure, msg: 'Rejected synopsis' });
            return null;
        }

        const statusText = truncateToWordBoundary(candidate, HARD_MAX_STATUS_LENGTH);

        // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: Empty status check for LLM failure — return null so caller skips update
        if(!statusText) {
            return null;
        }

        // eslint-disable-next-line require-atomic-updates -- cancel-and-replace: inFlightController identity check in finally ensures only the winning call updates cachedStatus
        state.cachedStatus = statusText;
        logger.info({ statusText, ...logContext.success });
        return statusText;
    } catch (error) {
        // Aborted by a newer call — expected, return null silently.
        // generateTextWithSystemPrompt() handles abort internally (returns ''), so this catch only fires
        // for non-abort errors (e.g., from promptBuilder). The signal check is defensive.
        // Stryker disable next-line ConditionalExpression,BlockStatement: NoCoverage — generateTextWithSystemPrompt() swallows abort and returns ''; this catch is only reached for genuine errors
        if(controller.signal.aborted) {
            return null;
        }
        logger.error({ error, ...logContext.failure });
        return null;
    } finally {
        // Record timestamp for cooldown AFTER call completion (not before)
        // eslint-disable-next-line require-atomic-updates -- cancel-and-replace: each call sets its own lastHaikuCall in finally; concurrent calls don't share this write path
        state.lastHaikuCall = Date.now();
        // Only clear if WE are still the current controller
        // Stryker disable next-line EqualityOperator,ConditionalExpression,BlockStatement: identity check — only clear if we're still the active controller; if we skip clearing, the next call aborts this controller at its start (equivalent behavior)
        if(state.inFlightController === controller) {
            state.inFlightController = null;
        }
    }
}

/** Per-instance cooldown/cache/in-flight-controller state (P14: see this file's top-of-file doc note). */
interface InstanceState {
    lastHaikuCall:      number
    cachedStatus:       string | null
    inFlightController: AbortController | null
}

/**
 * Creates a dynamic status generator that uses Claude Haiku to generate
 * contextual status messages.
 *
 * The generator implements rate limiting (2 second cooldown measured from call completion)
 * to avoid excessive API calls during rapid status updates. P14: the cooldown/cache/in-flight
 * state lives in THIS closure — every call to this factory returns an instance with its own,
 * independent state, so two instances (e.g. the conversation and perch sessions) never abort
 * each other's in-flight call or gate each other's cooldown.
 *
 * @param deps - Dependencies including identity context
 * @returns DynamicStatusGenerator instance
 *
 * @example
 * ```typescript
 * const generator = createDynamicStatusGenerator({
 *   identityContext: 'I am Isambard, an AI assistant'
 * });
 *
 * const status = await generator.generateSynopsis({
 *   phase: 'thinking',
 *   userMessage: 'How do I implement authentication?'
 * });
 * // Returns something like: "Pondering security patterns..."
 * ```
 */
export function createDynamicStatusGenerator(
    deps: DynamicStatusGeneratorDeps
): DynamicStatusGenerator {
    const { identityContext } = deps;

    // Built once per instance and sent as the array form with SYSTEM_PROMPT_DYNAMIC_BOUNDARY at
    // the end (same pattern as status-generator-idle.ts): the identity block never changes across
    // this instance's calls, so handing the SDK the identical array keeps the whole system prompt
    // eligible for cross-call prompt caching. Everything per-call lives in the user prompt.
    const systemPrompt = [buildSystemPrompt(identityContext), SYSTEM_PROMPT_DYNAMIC_BOUNDARY];

    // Stryker disable next-line ObjectLiteral: initial field values are irrelevant — the first call
    // through executeWithCooldown always sets lastHaikuCall/cachedStatus itself and treats a null
    // inFlightController identically to one already cleared by a prior call's finally block.
    const state: InstanceState = {
        lastHaikuCall:      0,
        cachedStatus:       null,
        inFlightController: null,
    };

    return {
        async generateSynopsis(context: SynopsisContext): Promise<string | null> {
            const { phase } = context;
            return executeWithCooldown(
                // `state.cachedStatus` is read at build time (after the cooldown gate), so it is
                // the status this instance most recently produced.
                () => ({ systemPrompt, userPrompt: buildUserPrompt(context, state.cachedStatus) }),
                {
                    // Stryker disable next-line StringLiteral: log message configuration
                    inFlight:   { phase, msg: 'Cancelling previous in-flight synopsis call' },
                    cooldown:   { phase, msg: 'Haiku call within cooldown, using cached status' },
                    generating: { phase, userMessageLength: context.userMessage.length, msg: 'Generating synopsis with Haiku' },
                    success:    { phase, msg: 'Generated dynamic status' },
                    failure:    { phase, msg: 'Failed to generate synopsis' },
                },
                state
            );
        },
    };
}

export { truncateToWordBoundary, HARD_MAX_STATUS_LENGTH } from '@/utils';
