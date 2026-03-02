/**
 * Dynamic Status Generator
 *
 * Generates contextual Discord status synopses using Claude Haiku 4.5.
 * Provides evocative, phase-aware status messages based on current agent activity.
 */

import { logger } from '@hughescr/logger';
import { getToolDescription, type SynopsisContext, type CatchUpSynopsisContext  } from './types.js';
import { generateText } from '@/agent';
import { truncateToWordBoundary, HARD_MAX_STATUS_LENGTH } from '@/utils';

// Re-export for backwards compatibility with existing imports

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

    /**
     * Generate a catch-up status based on inbox context.
     * Used when entering catch-up mode to show a rich, contextual status.
     *
     * @param context - The inbox state context
     * @returns Promise resolving to a status string (max 40 chars), or null if a Haiku call is in-flight or failed
     */
    generateCatchUpSynopsis(context: CatchUpSynopsisContext): Promise<string | null>
}

/**
 * Dependencies for creating a dynamic status generator.
 */
export interface DynamicStatusGeneratorDeps {
    /** Context about the assistant's identity for personalized status */
    identityContext: string
}

const MAX_USER_MESSAGE_LENGTH = 200;
const MAX_ACCUMULATED_TEXT_LENGTH = 150;
const MAX_RESPONSE_FRAGMENT_LENGTH = 100;
const MAX_TOOL_INPUT_LENGTH = 200;
const MAX_THINKING_CONTENT_LENGTH = 500;

// Rate limiting: minimum 2 seconds between Haiku calls (cooldown measured from call completion)
// Module-level state shared across all generator instances
// Stryker disable next-line AssignmentOperator: Initial value irrelevant, first call always sets lastHaikuCall = now
let lastHaikuCall = 0;
// Stryker disable next-line AssignmentOperator: Initial value irrelevant, first successful call always updates cache
let cachedStatus: string | null = null;
// Stryker disable next-line AssignmentOperator,BooleanLiteral: Initial value irrelevant, haikuInFlight is set before every API call
let haikuInFlight = false;
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
 * Prompt template for catch-up status generation.
 * Used when entering catch-up mode to generate a contextual status based on inbox state.
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const CATCH_UP_PROMPT = `You (Izzy) just woke up and found messages waiting in your inbox:
- {totalUnread} messages across {channelCount} channel(s)
- Channels: {channelNames}
- From: {topAuthors}
- You've been away for {timeSinceLastActive}
- It's {timeOfDay} on {dayOfWeek}

Generate a thought that SPECIFICALLY mentions one of: an author name, a channel name, the time away, or the time/day. Be curious, excited, playful.

NEVER output generic phrases like:
- "Catching up..." / "What did I miss..." / "Messages waiting..."
- "Time to see what's new..." / "Let's see what happened..."
- Anything that could apply to ANY inbox state

GOOD examples (notice they use specific details):
- "Ooh, Craig left me something—Monday treat!"
- "Three hours and #general got busy!"
- "Sarah AND Mike wrote? Intriguing..."
- "Early morning messages from the team..."
- "{totalUnread} messages? Someone's chatty!"
- "Been away {timeSinceLastActive} and look what I find!"

What thought flashes through your mind as you see what's waiting?`;
// Stryker restore StringLiteral

/**
 * Resets the cooldown state for testing purposes.
 * This allows tests to simulate time passing without actual delays.
 */
export function resetCooldownState(): void {
    lastHaikuCall = 0;
    cachedStatus = null;
    // Stryker disable next-line BooleanLiteral: resetCooldownState resets all module state atomically for test isolation
    haikuInFlight = false;
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
 * Build the full prompt by combining system prompt and user prompt.
 */
function buildPrompt(
    identityContext: string,
    context: SynopsisContext
): string {
    const { phase, userMessage, toolName, toolInput, toolDescription, accumulatedText, responseFragment, thinkingContent } = context;

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

    // Combine system and user prompts
    // Since unstable_v2_prompt doesn't support systemPrompt, we embed it in the prompt
    return `${systemPart}\n\n---\n\n${userPart}`;
}

/**
 * Creates a dynamic status generator that uses Claude Haiku to generate
 * contextual status messages.
 *
 * The generator implements rate limiting (2 second cooldown measured from call completion)
 * to avoid excessive API calls during rapid status updates.
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

    return {
        async generateSynopsis(context: SynopsisContext): Promise<string | null> {
            const { phase } = context;

            // Mutex: if a Haiku call is already in-flight, return null so caller skips update
            if(haikuInFlight) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Debug logging for in-flight diagnostics
                logger.debug({ phase, haikuInFlight, msg: 'Haiku call in-flight, skipping synopsis' });
                return null;
            }

            // Rate limiting - check if we're within cooldown window (measured from last call completion)
            const now = Date.now();
            // Stryker disable next-line EqualityOperator: < vs <= boundary at exact cooldown time is equivalent
            if(now - lastHaikuCall < HAIKU_COOLDOWN_MS && cachedStatus) {
                logger.debug({ phase, msg: 'Haiku call within cooldown, using cached status' });
                return cachedStatus;
            }
            // No cache — fall through to make real call

            haikuInFlight = true;
            try {
                const prompt = buildPrompt(identityContext, context);

                logger.debug({
                    phase,
                    userMessageLength: context.userMessage.length,
                    msg:               'Generating synopsis with Haiku',
                });

                // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
                const text = await generateText(prompt, { stripMarkdown: true });
                // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
                const statusText = truncateToWordBoundary(text.trim(), HARD_MAX_STATUS_LENGTH);

                // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: Empty status check for LLM failure — return null so caller skips update
                if(!statusText) {
                    return null;
                }

                // eslint-disable-next-line require-atomic-updates -- single-threaded: haikuInFlight mutex guards this, no concurrent writers
                cachedStatus = statusText;
                logger.info({ phase, statusText, msg: 'Generated dynamic status' });
                return statusText;
            } catch (error) {
                logger.error({
                    error,
                    phase,
                    msg: 'Failed to generate synopsis',
                });
                return null;
            } finally {
                // Record timestamp for cooldown AFTER call completion (not before)
                // eslint-disable-next-line require-atomic-updates -- single-threaded: finally block clears in-flight state, no concurrent writers
                lastHaikuCall = Date.now();
                // eslint-disable-next-line require-atomic-updates -- single-threaded: finally block clears in-flight state, no concurrent writers
                haikuInFlight = false;
            }
        },

        // Stryker disable StringLiteral,ObjectLiteral: Prompt template building and logging for status generation
        async generateCatchUpSynopsis(context: CatchUpSynopsisContext): Promise<string | null> {
            // Mutex: if a Haiku call is already in-flight, return null so caller skips update
            if(haikuInFlight) {
                logger.debug({ haikuInFlight, msg: 'Haiku call in-flight for catch-up, skipping synopsis' });
                return null;
            }

            // Rate limiting - check if we're within cooldown window (measured from last call completion)
            const now = Date.now();
            // Stryker disable next-line ArithmeticOperator,EqualityOperator: Time arithmetic boundary
            if(now - lastHaikuCall < HAIKU_COOLDOWN_MS && cachedStatus) {
                logger.debug({ msg: 'Haiku call within cooldown for catch-up, using cached status' });
                return cachedStatus;
            }
            // No cache — fall through to make real call

            haikuInFlight = true;
            try {
                // Build the prompt with context values
                let prompt = SYSTEM_PROMPT;
                prompt = prompt.replace('{identityContext}', identityContext);
                prompt = `${prompt}\n\n---\n\n${CATCH_UP_PROMPT}`;

                // Replace placeholders with context values
                prompt = prompt.replace('{totalUnread}', String(context.totalUnread));
                prompt = prompt.replace('{channelCount}', String(context.channelCount));
                prompt = prompt.replace('{channelNames}', context.channelNames.join(', '));
                prompt = prompt.replace('{topAuthors}', context.topAuthors.join(', '));
                prompt = prompt.replace('{timeSinceLastActive}', context.timeSinceLastActive);
                prompt = prompt.replace('{timeOfDay}', context.timeOfDay);
                prompt = prompt.replace('{dayOfWeek}', context.dayOfWeek);

                logger.debug({
                    totalUnread:  context.totalUnread,
                    channelCount: context.channelCount,
                    msg:          'Generating catch-up synopsis with Haiku',
                });

                // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
                const text = await generateText(prompt, { stripMarkdown: true });
                // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
                const statusText = truncateToWordBoundary(text.trim(), HARD_MAX_STATUS_LENGTH);

                // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: Empty status check for LLM failure — return null so caller skips update
                if(!statusText) {
                    return null;
                }

                // eslint-disable-next-line require-atomic-updates -- single-threaded: haikuInFlight mutex guards this, no concurrent writers
                cachedStatus = statusText;
                logger.info({ statusText, msg: 'Generated catch-up status' });
                return statusText;
            } catch (error) {
                logger.error({
                    error,
                    msg: 'Failed to generate catch-up synopsis',
                });
                return null;
            } finally {
                // Record timestamp for cooldown AFTER call completion (not before)
                // eslint-disable-next-line require-atomic-updates -- single-threaded: finally block clears in-flight state, no concurrent writers
                lastHaikuCall = Date.now();
                // eslint-disable-next-line require-atomic-updates -- single-threaded: finally block clears in-flight state, no concurrent writers
                haikuInFlight = false;
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    };
}

export { truncateToWordBoundary, HARD_MAX_STATUS_LENGTH } from '@/utils';
