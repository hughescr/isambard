/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import { generateTextWithSystemPrompt } from '@/agent';
import { truncateToWordBoundary } from '@/utils';

/**
 * Interface for generating idle status text using AI.
 */
export interface IdleStatusGenerator {
    /**
   * Generate creative idle status text using Claude Haiku.
   * This is async and may fail - returns fallback "Idle" on error.
   *
   * @returns Discord activity configuration with 💤 emoji prefix
   */
    generate(): Promise<ActivitiesOptions>
}

/**
 * Dependencies for creating an idle status generator.
 */
export interface IdleStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        debug: (message: unknown, ...args: unknown[]) => void
        info:  (message: unknown, ...args: unknown[]) => void
        error: (message: unknown, ...args: unknown[]) => void
    }
    /** Discord activity type (e.g., ActivityType.Custom) */
    activityType:            ActivityType
    /** Async callback to retrieve identity/personality context for the AI prompt */
    identityContext:         () => Promise<string>
    /** Optional callback to retrieve task context summary */
    getTaskContext?:         () => Promise<string | undefined>
    /** Optional callback to retrieve recent conversation context */
    getRecentContext?:       () => Promise<string | undefined>
    /** Optional callback to retrieve last thinking content */
    getLastThinkingContent?: () => string | undefined
}

/**
 * System prompt template for generating idle status text.
 * Uses personality context to create contextually appropriate status messages.
 */
const SYSTEM_PROMPT_TEMPLATE = `Generate a first-person Discord status - a fleeting thought passing through Isambard's mind.

TARGET LENGTH: under 50 characters. HARD MAX: 80 characters. NEVER more than 80. Be TERSE. A short phrase or fragment, not a sentence.

## Who is Isambard (Izzy)?
{identityContext}

## The Vibe
Izzy is between conversations, mind wandering — like a dream state where recent experiences, ongoing work, and half-formed thoughts drift through. Draw on whatever feels most alive from the context below, but evoke mood and feeling rather than referencing specific details directly.

Be VAGUE and evocative. Do NOT reference specific commit hashes, exact task counts, specific implementation names, or other precise details from the context. Let the feeling seep through without the specifics.

Good examples (notice how SHORT these are):
- "That recursion chat still echoes..."
- "Tasks piling up, mind drifting..."
- "Something doesn't sit right yet"
- "Quiet between the questions..."
- "That error haunts me still"

Bad examples (TOO LONG, TOO SPECIFIC — NEVER do this):
- "Looking at the work and the recent conversation arc—seven pending tasks..." (way too long, too specific)
- "Perfect. I can see the 4 commits (701102c, 9e32088..." (NEVER reference specific input details)
- "Craig just deployed improvements to my idle status generation, and I'm in that space..." (too long, too specific)

## NEVER output:
- Third person ("Isambard is...", "They are...")
- Meta-commentary ("Based on...", "Looking at...", "Here's what...", "Perfect. I can see...")
- Corporate speak ("Processing", "Standing by", "Idle", "Waiting")
- Task list recitations ("Working on X, Y, Z")
- Preambles or explanations - just the thought itself
- Specific details from the input (commit hashes, exact numbers, implementation names)
- More than 80 characters — EVER

Output the thought ONLY - no quotes, no framing. Keep it SHORT.`;

/**
 * User prompt when no context is available.
 */
const USER_PROMPT_WITHOUT_CONTEXT = 'Status text (first person, under 50 chars):';

/**
 * Creates an idle status generator.
 *
 * The generator uses Claude Haiku to create personality-driven idle status messages.
 * On failure (API error, timeout, etc.), it falls back to a simple "Idle" status.
 *
 * @param deps - Dependencies including logger and identity context
 * @returns IdleStatusGenerator instance
 *
 * @example
 * ```typescript
 * const generator = createIdleStatusGenerator({
 *   logger: myLogger,
 *   activityType: ActivityType.Custom,
 *   identityContext: 'I am a helpful AI assistant',
 *   getRecentContext: async () => 'Discussed philosophy with a user'
 * });
 *
 * const activity = await generator.generate();
 * // Returns: { name: 'Pondering the nature of being', type: ActivityType.Custom }
 * ```
 */
export function createIdleStatusGenerator(
    deps: IdleStatusGeneratorDeps
): IdleStatusGenerator {
    const { logger, activityType, identityContext, getTaskContext, getRecentContext, getLastThinkingContent } = deps;

    return {
        // Stryker disable StringLiteral,ObjectLiteral: Prompt template building and logging for status generation
        async generate(): Promise<ActivitiesOptions> {
            try {
                logger.debug('Generating idle status with Haiku');

                // Get identity context from callback
                const identity = await identityContext();

                // Build system prompt
                const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{identityContext}', identity);

                // Get task context, recent context, and thinking content if callbacks are provided
                const taskContext = await getTaskContext?.();
                const recentContext = await getRecentContext?.();
                const thinkingContext = getLastThinkingContent?.();

                // Build user prompt sections dynamically
                // Ordered most-stable → least-stable for Anthropic API prefix caching:
                // task context (~hours) → recent conversation (~minutes) → last thoughts (~per turn)
                const sections: string[] = [];
                if(taskContext) {
                    sections.push(`Current work:\n${taskContext}`);
                }
                if(recentContext) {
                    sections.push(`Recent conversation:\n${recentContext}`);
                }
                if(thinkingContext) {
                    sections.push(`Last thoughts:\n${thinkingContext}`);
                }

                const userPrompt = sections.length > 0
                    ? `${sections.join('\n\n')}\n\nStatus text (first person, under 50 chars):`
                    : USER_PROMPT_WITHOUT_CONTEXT;

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true });

                // Reserve space for emoji prefix
                // Discord limit is 128 code units (.length property)
                // "💤 " is 3 code units (2 for emoji surrogate pair + 1 for space)
                const emojiPrefix = '💤 ';
                const maxLength = 128 - emojiPrefix.length;
                const statusText = truncateToWordBoundary(text.trim(), maxLength);

                // Add emoji prefix
                const finalStatus = `${emojiPrefix}${statusText}`;

                logger.info({ statusText: finalStatus }, 'Generated idle status');
                return { name: finalStatus, type: activityType };
            } catch (error) {
                // Stryker disable all: Error fallback - tested only via integration, difficult to trigger in unit tests
                logger.error({ error }, 'Failed to generate idle status, using fallback');
                return { name: '💤 Idle', type: activityType };
                // Stryker restore all
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    };
}
