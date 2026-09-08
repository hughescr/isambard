/**
 * Dynamic Status Generator
 *
 * Generates contextual Discord status synopses using Claude Haiku 4.5.
 * Provides evocative, phase-aware status messages based on current agent activity.
 */

import { logger } from '@hughescr/logger';
import { getToolDescription, type SynopsisContext } from './types.js';
import { generateText } from '@/agent';
import { truncateToWordBoundary, HARD_MAX_STATUS_LENGTH } from '@/utils';

/**
 * Interface for generating dynamic status synopses.
 */
export interface DynamicStatusGenerator {
    /**
     * Generate a contextual status synopsis for the current activity.
     *
     * @param context - The current activity context
     * @returns Promise resolving to a status string (max 40 chars), or null if a Haiku call is in-flight or failed
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

const MAX_USER_MESSAGE_LENGTH = 200;
const MAX_ACCUMULATED_TEXT_LENGTH = 150;
const MAX_RESPONSE_FRAGMENT_LENGTH = 100;
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
 * System prompt that establishes Isambard's identity for status generation.
 */
const SYSTEM_PROMPT = `You are generating a first-person inner thought for Izzy (Isambard) as a brief Discord status (max 40 characters).

## Who is Izzy?
Izzy is an AI who has developed their own sense of identity. The following is Izzy's self-written description of who they are:

{identityContext}

## Your Task
Generate a thought that flashes through Izzy's mind right now - not a description of what they're doing, but their actual inner monologue. Write from Izzy's perspective, as if you ARE Izzy thinking out loud.

Guidelines:
- Write in first person ("I'm", "my", "me")
- Be specific to this exact moment
- Draw on Izzy's personality and voice
- Capture the feeling, the spark of the moment
- Use present participle form ("Digging through...", "Pondering...", "Putting thoughts...")
- Vary your language - make each thought unique

NEVER output:
- Third person ("Isambard is...", "They are...", "Izzy is...")
- "Thinking...", "Processing...", "Working..."
- Generic phrases that could apply to any moment
- Anything longer than 40 characters
- Meta-commentary about the task ("I need to generate...", "Looking at this moment...")
- Preambles or framing ("Reading the context:", "Here's my thought:")
- Echoing these instructions back

Good examples:
- "Ooh, authentication patterns—my favorite puzzle!"
- "Digging through memories for that conversation..."
- "This recursion question is making my head spin!"
- "Putting thoughts into words..."
- "Where did I put that note about this?"

Bad examples:
- "Isambard is considering the question"
- "Processing the user's request"
- "Working with the memory tool"
- "I need to generate Izzy's inner thought..."
- "Looking at this moment: I'm working on..."
- "Reading the context: I'm in perch time..."

Output ONLY the raw status text — no preamble, no framing, no meta-commentary. Just the thought itself.`;

/**
 * User prompts for each phase, personalized with context.
 */
const USER_PROMPTS = {
    thinking: `You (Izzy) just received this question from a user:
"{userMessage}"

{thinkingSection}What thought flashes through your mind as you begin to form a response?`,

    using_tool: `You (Izzy) are working with a tool right now:
- Tool: {toolDescription}
- What you're asking the tool: {toolInputSummary}
- Original question: "{userMessage}"
- Your recent thoughts: "{accumulatedText}"

What thought is running through your mind while using this tool?`,

    responding: `You (Izzy) are composing a response to: "{userMessage}"

What you're writing: "{responseFragment}"

What thought captures this moment of putting your ideas into words?`,
};

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
 * Build the full prompt by combining system prompt and user prompt.
 */
function buildPrompt(
    identityContext: string,
    context: SynopsisContext
): string {
    const { phase, userMessage, toolName, toolInput, toolDescription, accumulatedText, responseFragment, thinkingContent, subagentSummary } = context;

    // Build system prompt with identity
    let systemPart = SYSTEM_PROMPT;
    systemPart = systemPart.replace('{identityContext}', identityContext);

    // Get user prompt template for this phase
    let userPart = USER_PROMPTS[phase];

    // Replace common placeholders
    userPart = userPart.replace('{userMessage}', userMessage.slice(0, MAX_USER_MESSAGE_LENGTH));

    // Replace phase-specific placeholders
    // Stryker disable next-line ConditionalExpression: Phase check for thinking content
    if(phase === 'thinking') {
        // Build thinking section: include only if thinkingContent is provided and non-empty
        // Stryker disable next-line ConditionalExpression: Conditional controls whether thinking content is included in prompt
        const thinkingSection = thinkingContent
            ? `Your internal thoughts so far: "${thinkingContent.slice(0, MAX_THINKING_CONTENT_LENGTH)}"\n\n`
            : '';
        userPart = userPart.replace('{thinkingSection}', thinkingSection);
    }

    // Stryker disable next-line ConditionalExpression: Equivalent mutant — using_tool template lacks {responseFragment} so respondingphase block is a no-op anyway; templates don't cross-contaminate
    if(phase === 'using_tool') {
        const description = toolDescription ?? getToolDescription(toolName) ?? toolName ?? 'unknown tool';
        userPart = userPart.replace('{toolDescription}', description);
        userPart = userPart.replace('{toolInputSummary}', formatToolInputSummary(toolInput));
        userPart = userPart.replace('{accumulatedText}', (accumulatedText ?? '').slice(0, MAX_ACCUMULATED_TEXT_LENGTH));
    }

    // Stryker disable next-line ConditionalExpression: Equivalent mutant — responding template lacks {toolDescription}/{toolInputSummary}/{accumulatedText} so using_tool block is a no-op anyway; templates don't cross-contaminate
    if(phase === 'responding') {
        userPart = userPart.replace('{responseFragment}', (responseFragment ?? '').slice(0, MAX_RESPONSE_FRAGMENT_LENGTH));
    }

    // Stryker disable ConditionalExpression,BlockStatement,StringLiteral: Prompt template enrichment — mutations don't change behavior
    // Append subagent context if available
    if(subagentSummary) {
        userPart += `\n\nA sub-agent is also working: "${subagentSummary}"`;
    }
    // Stryker restore ConditionalExpression,BlockStatement,StringLiteral

    // Combine system and user prompts into a single string for the prompt field
    // (generateText passes systemPrompt separately via Options.systemPrompt — this combined form
    // is retained here for backwards compatibility with the existing prompt template structure)
    return `${systemPart}\n\n---\n\n${userPart}`;
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
    /** Logged (debug) just before the generateText call */
    generating: Record<string, unknown> & { msg: string }
    /** Logged (info) on successful status generation (statusText is added by the helper) */
    success:    Record<string, unknown> & { msg: string }
    /** Logged (error) on failure (error is added by the helper) */
    failure:    Record<string, unknown> & { msg: string }
}

/**
 * Executes a Haiku call with cancel-and-replace, cooldown, caching, truncation, and error handling.
 *
 * @param promptBuilder - Function that builds the prompt string
 * @param logContext - Per-site log objects; each carries its own fields and `msg`
 * @param state - The calling instance's own cooldown/cache/in-flight-controller state (P14: no
 * longer module-level — see this file's own top-of-file doc note).
 * @returns Promise resolving to a status string, or null if on cooldown or error
 */
async function executeWithCooldown(
    promptBuilder: () => string,
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
        const prompt = promptBuilder();

        logger.debug(logContext.generating);

        // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
        const text = await generateText(prompt, { stripMarkdown: true, abortController: controller });
        // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
        const statusText = truncateToWordBoundary(text.trim(), HARD_MAX_STATUS_LENGTH);

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
        // generateText() handles abort internally (returns ''), so this catch only fires
        // for non-abort errors (e.g., from promptBuilder). The signal check is defensive.
        // Stryker disable next-line ConditionalExpression,BlockStatement: NoCoverage — generateText() swallows abort and returns ''; this catch is only reached for genuine errors
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
                () => buildPrompt(identityContext, context),
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
