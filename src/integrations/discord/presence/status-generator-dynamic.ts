/**
 * Dynamic Status Generator
 *
 * Generates contextual Discord status synopses using Claude Haiku 4.5.
 * Provides evocative, phase-aware status messages based on current agent activity.
 */

import _ from 'lodash';
import { generateText } from '@/agent/text-generator.js';
import { logger } from '@hughescr/logger';
import { getToolDescription } from './types.js';
import type { SynopsisContext, CatchUpSynopsisContext } from './types.js';

/**
 * Interface for generating dynamic status synopses.
 */
export interface DynamicStatusGenerator {
    /**
     * Generate a contextual status synopsis for the current activity.
     *
     * @param context - The current activity context
     * @returns Promise resolving to a status string (max 40 chars)
     */
    generateSynopsis(context: SynopsisContext): Promise<string>

    /**
     * Generate a catch-up status based on inbox context.
     * Used when entering catch-up mode to show a rich, contextual status.
     *
     * @param context - The inbox state context
     * @returns Promise resolving to a status string (max 40 chars)
     */
    generateCatchUpSynopsis(context: CatchUpSynopsisContext): Promise<string>
}

/**
 * Dependencies for creating a dynamic status generator.
 */
export interface DynamicStatusGeneratorDeps {
    /** Context about the assistant's identity for personalized status */
    identityContext: string
}

export const HARD_MAX_STATUS_LENGTH = 80;
const MAX_USER_MESSAGE_LENGTH = 200;
const MAX_ACCUMULATED_TEXT_LENGTH = 150;
const MAX_RESPONSE_FRAGMENT_LENGTH = 100;
const MAX_TOOL_INPUT_LENGTH = 200;
const MAX_THINKING_CONTENT_LENGTH = 500;

/**
 * Truncates text to a maximum length, respecting word boundaries.
 *
 * If the text fits within maxLength, returns it unchanged.
 * Otherwise, finds the last space before maxLength and truncates there,
 * appending a unicode ellipsis (…).
 * If no space is found (single long word), hard truncates at maxLength-1
 * and appends the ellipsis.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum allowed length for the result
 * @returns Truncated text with ellipsis if needed
 */
export function truncateToWordBoundary(text: string, maxLength: number): string {
    if(text.length <= maxLength) {
        return text;
    }

    // Find the last space before maxLength
    const lastSpaceIndex = text.lastIndexOf(' ', maxLength - 1);

    if(lastSpaceIndex > 0) {
        // Truncate at word boundary and add ellipsis
        return `${text.slice(0, lastSpaceIndex)}\u2026`;
    }

    // No space found - hard truncate at maxLength-1 + ellipsis
    return `${text.slice(0, maxLength - 1)}\u2026`;
}

const FALLBACK_STATUSES: Record<SynopsisContext['phase'], string> = {
    thinking:   'Thinking...',
    using_tool: 'Working...',
    responding: 'Responding...',
};

// Rate limiting: minimum 2 seconds between Haiku calls
// Module-level state shared across all generator instances
// Stryker disable next-line AssignmentOperator: Initial value irrelevant, first call always sets lastHaikuCall = now
let lastHaikuCall = 0;
// Stryker disable next-line AssignmentOperator: Initial value irrelevant, first successful call always updates cache
let cachedStatus: string | null = null;
const HAIKU_DEBOUNCE_MS = 2000;

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

Output ONLY the status text.`;

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

/**
 * Resets the debounce state for testing purposes.
 * This allows tests to simulate time passing without actual delays.
 */
export function resetDebounceState(): void {
    lastHaikuCall = 0;
    cachedStatus = null;
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
    systemPart = _.replace(systemPart, '{identityContext}', identityContext);

    // Get user prompt template for this phase
    let userPart = USER_PROMPTS[phase];

    // Replace common placeholders
    userPart = _.replace(userPart, '{userMessage}', userMessage.slice(0, MAX_USER_MESSAGE_LENGTH));

    // Replace phase-specific placeholders
    // Stryker disable next-line ConditionalExpression: Phase check for thinking content
    if(phase === 'thinking') {
        // Build thinking section: include only if thinkingContent is provided and non-empty
        // Stryker disable next-line ConditionalExpression: Conditional controls whether thinking content is included in prompt
        const thinkingSection = thinkingContent
            ? `Your internal thoughts so far: "${thinkingContent.slice(0, MAX_THINKING_CONTENT_LENGTH)}"\n\n`
            : '';
        userPart = _.replace(userPart, '{thinkingSection}', thinkingSection);
    }

    if(phase === 'using_tool') {
        const description = toolDescription ?? getToolDescription(toolName) ?? toolName ?? 'unknown tool';
        userPart = _.replace(userPart, '{toolDescription}', description);
        userPart = _.replace(userPart, '{toolInputSummary}', formatToolInputSummary(toolInput));
        userPart = _.replace(userPart, '{accumulatedText}', (accumulatedText ?? '').slice(0, MAX_ACCUMULATED_TEXT_LENGTH));
    }

    if(phase === 'responding') {
        userPart = _.replace(userPart, '{responseFragment}', (responseFragment ?? '').slice(0, MAX_RESPONSE_FRAGMENT_LENGTH));
    }

    // Combine system and user prompts
    // Since unstable_v2_prompt doesn't support systemPrompt, we embed it in the prompt
    return `${systemPart}\n\n---\n\n${userPart}`;
}

/**
 * Creates a dynamic status generator that uses Claude Haiku to generate
 * contextual status messages.
 *
 * The generator implements rate limiting (2 second debounce) to avoid
 * excessive API calls during rapid status updates.
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
        async generateSynopsis(context: SynopsisContext): Promise<string> {
            const { phase } = context;

            // Rate limiting - check if we're within debounce window
            const now = Date.now();
            // Stryker disable next-line EqualityOperator: < vs <= boundary at exact debounce time is equivalent
            if(now - lastHaikuCall < HAIKU_DEBOUNCE_MS && cachedStatus) {
                logger.debug({ phase, msg: 'Haiku call debounced, using cached status' });
                return cachedStatus;
            }

            try {
                // Record timestamp for rate limiting before making API call.
                // This ensures subsequent rapid calls see the updated timestamp.
                lastHaikuCall = now;

                const prompt = buildPrompt(identityContext, context);

                logger.debug({
                    phase,
                    userMessageLength: context.userMessage.length,
                    msg:               'Generating synopsis with Haiku',
                });

                // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
                const text = await generateText(prompt, { stripMarkdown: true });
                const statusText = truncateToWordBoundary(_.trim(text), HARD_MAX_STATUS_LENGTH);

                // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: Empty status check for LLM failure fallback
                if(!statusText) {
                    return FALLBACK_STATUSES[phase];
                }

                cachedStatus = statusText;
                logger.info({ phase, statusText, msg: 'Generated dynamic status' });
                return statusText;
            } catch (error) {
                logger.error({
                    error,
                    phase,
                    msg: 'Failed to generate synopsis, using fallback',
                });
                return FALLBACK_STATUSES[phase];
            }
        },

        async generateCatchUpSynopsis(context: CatchUpSynopsisContext): Promise<string> {
            // Rate limiting - check if we're within debounce window
            const now = Date.now();
            // Stryker disable next-line EqualityOperator: < vs <= boundary at exact debounce time is equivalent
            if(now - lastHaikuCall < HAIKU_DEBOUNCE_MS && cachedStatus) {
                logger.debug({ msg: 'Haiku call debounced for catch-up, using cached status' });
                return cachedStatus;
            }

            try {
                // Record timestamp for rate limiting before making API call
                lastHaikuCall = now;

                // Build the prompt with context values
                let prompt = SYSTEM_PROMPT;
                prompt = _.replace(prompt, '{identityContext}', identityContext);
                prompt = `${prompt}\n\n---\n\n${CATCH_UP_PROMPT}`;

                // Replace placeholders with context values
                prompt = _.replace(prompt, '{totalUnread}', String(context.totalUnread));
                prompt = _.replace(prompt, '{channelCount}', String(context.channelCount));
                prompt = _.replace(prompt, '{channelNames}', context.channelNames.join(', '));
                prompt = _.replace(prompt, '{topAuthors}', context.topAuthors.join(', '));
                prompt = _.replace(prompt, '{timeSinceLastActive}', context.timeSinceLastActive);
                prompt = _.replace(prompt, '{timeOfDay}', context.timeOfDay);
                prompt = _.replace(prompt, '{dayOfWeek}', context.dayOfWeek);

                logger.debug({
                    totalUnread:  context.totalUnread,
                    channelCount: context.channelCount,
                    msg:          'Generating catch-up synopsis with Haiku',
                });

                // Stryker disable next-line ObjectLiteral,BooleanLiteral: stripMarkdown option tested in text-generator.ts unit tests
                const text = await generateText(prompt, { stripMarkdown: true });
                const statusText = truncateToWordBoundary(_.trim(text), HARD_MAX_STATUS_LENGTH);

                // Stryker disable next-line BooleanLiteral,ConditionalExpression,BlockStatement: Empty status check for LLM failure fallback
                if(!statusText) {
                    return 'Messages waiting...';
                }

                cachedStatus = statusText;
                logger.info({ statusText, msg: 'Generated catch-up status' });
                return statusText;
            } catch (error) {
                logger.error({
                    error,
                    msg: 'Failed to generate catch-up synopsis, using fallback',
                });
                return 'Messages waiting...';
            }
        },
    };
}
