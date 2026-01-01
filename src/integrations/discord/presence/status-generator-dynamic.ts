/**
 * Dynamic Status Generator
 *
 * Generates contextual Discord status synopses using Claude Haiku 4.5.
 * Provides evocative, phase-aware status messages based on current agent activity.
 */

import _ from 'lodash';
import { generateText } from '@/agent/text-generator.js';
import { logger } from '@hughescr/logger';
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

const SYNOPSIS_PROMPT = `Generate a brief Discord status (max 40 chars) showing what an AI assistant is doing.

Context about the assistant:
{identity}

Current activity:
- Phase: {phase}
- User asked: "{userMessage}"
{toolContext}

Generate a short, evocative phrase in present participle form. Examples for each phase:
- thinking: "Pondering code patterns...", "Mulling over your question..."
- using_tool: "Consulting memories...", "Searching for context..."
- responding: "Crafting a response...", "Formulating thoughts..."

Output ONLY the status text, nothing else. Max 40 characters.`;

/**
 * Resets the debounce state for testing purposes.
 * This allows tests to simulate time passing without actual delays.
 */
export function resetDebounceState(): void {
    lastHaikuCall = 0;
    cachedStatus = null;
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
            const { phase, userMessage, toolName } = context;

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

                // Build optional tool context line for the prompt template.
                // Empty string when no tool is active to avoid template gaps.
                const toolContext = toolName
                    ? `- Tool being used: ${toolName}`
                    : '';

                let prompt = SYNOPSIS_PROMPT;
                // Stryker disable next-line StringLiteral: Template placeholder mutation doesn't affect test assertions
                prompt = _.replace(prompt, '{identity}', identityContext);
                prompt = _.replace(prompt, '{phase}', phase);
                prompt = _.replace(prompt, '{userMessage}', userMessage.slice(0, MAX_USER_MESSAGE_LENGTH));
                prompt = _.replace(prompt, '{toolContext}', toolContext);

                logger.debug({
                    phase,
                    userMessageLength: userMessage.length,
                    msg:               'Generating synopsis with Haiku',
                });

                const text = await generateText(prompt);
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
