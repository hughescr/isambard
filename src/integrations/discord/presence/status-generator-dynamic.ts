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
import type { SynopsisContext } from './types.js';

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
}

/**
 * Dependencies for creating a dynamic status generator.
 */
export interface DynamicStatusGeneratorDeps {
    /** Context about the assistant's identity for personalized status */
    identityContext: string
}

const MAX_STATUS_LENGTH = 40;
const MAX_USER_MESSAGE_LENGTH = 200;
const MAX_ACCUMULATED_TEXT_LENGTH = 150;
const MAX_RESPONSE_FRAGMENT_LENGTH = 100;
const MAX_TOOL_INPUT_LENGTH = 200;
const MAX_THINKING_CONTENT_LENGTH = 500;

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
const SYSTEM_PROMPT = `You are capturing Isambard's mental state as a brief Discord status (max 40 characters).

## Who is Isambard?
Isambard is an AI who has developed their own sense of identity. The following is Isambard's self-written description of who they are:

{identityContext}

## Your Task
Craft a status that captures what's currently flowing through Isambard's mind - not a generic label, but an evocative snapshot of this specific moment. Use present participle form.

Guidelines:
- Be specific to what Isambard is actually doing/thinking right now
- Draw on Isambard's personality as expressed in their identity
- Capture the essence, the flavor of the moment
- Vary your language - no two statuses alike

NEVER output:
- "Thinking...", "Processing...", "Working..."
- Generic phrases that could apply to any moment
- Anything longer than 40 characters

Output ONLY the status text.`;

/**
 * User prompts for each phase, personalized with context.
 */
const USER_PROMPTS = {
    thinking: `Isambard is considering this question from a user:
"{userMessage}"

{thinkingSection}What's going through Isambard's mind as they begin to form a response?`,

    using_tool: `Current activity:
- Tool: {toolDescription}
- What Isambard is asking: {toolInputSummary}
- Original question: "{userMessage}"
- Recent thoughts: "{accumulatedText}"

What's Isambard's mental state while working with this tool?`,

    responding: `Isambard is composing a response to: "{userMessage}"

What they're writing: "{responseFragment}"

What captures this moment of articulation?`,
};

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
    if(phase === 'thinking') {
        // Build thinking section: include only if thinkingContent is provided and non-empty
        const thinkingSection = thinkingContent
            ? `Isambard's internal thoughts: "${thinkingContent.slice(0, MAX_THINKING_CONTENT_LENGTH)}"\n\n`
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

                // Stryker disable next-line ObjectLiteral: stripMarkdown option tested in text-generator.ts unit tests
                const text = await generateText(prompt, { stripMarkdown: true });
                const statusText = _.trim(text.slice(0, MAX_STATUS_LENGTH));

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
    };
}
