/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import _ from 'lodash';
import { generateTextWithSystemPrompt } from '@/agent/text-generator';

/**
 * Interface for generating idle status text using AI.
 */
export interface IdleStatusGenerator {
    /**
   * Generate creative idle status text using Claude Haiku.
   * This is async and may fail - returns fallback "Idle" on error.
   *
   * @param includeIdleEmoji - Whether to include the 💤 emoji prefix (default: true)
   * @returns Discord activity configuration
   */
    generate(includeIdleEmoji?: boolean): Promise<ActivitiesOptions>
}

/**
 * Dependencies for creating an idle status generator.
 */
export interface IdleStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        debug: (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        info:  (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        error: (message: any, ...args: any[]) => void
    }
    /** Discord activity type (e.g., ActivityType.Custom) */
    activityType:      ActivityType
    /** Identity/personality context for the AI prompt */
    identityContext:   string
    /** Optional callback to retrieve recent conversation context */
    getRecentContext?: () => Promise<string | undefined>
}

/**
 * System prompt template for generating idle status text.
 * Uses personality context to create contextually appropriate status messages.
 */
const SYSTEM_PROMPT_TEMPLATE = `You are capturing Isambard's idle mental state as a Discord status (max 128 characters).

## Who is Isambard?
Isambard is an AI who has developed their own sense of identity. The following is Isambard's self-written description of who they are:

{identityContext}

## Your Task
Isambard is currently idle - between conversations, mind drifting. Craft a status that reflects what might be passing through their mind in this quiet moment.

Izzy's thoughts might naturally linger on recent conversations, topics discussed, or things they learned. Draw on both their personality and what's recently been on their mind.

NEVER output:
- "Idle", "Waiting...", "Standing by"
- Generic availability phrases
- Anything longer than 128 characters

Output ONLY the status text.`;

/**
 * User prompt template when recent context is available.
 */
const USER_PROMPT_WITH_CONTEXT = `Recent activity that might be on Isambard's mind:
{recentContext}

What fleeting thought might cross Isambard's mind while idle?`;

/**
 * User prompt when no recent context is available.
 */
const USER_PROMPT_WITHOUT_CONTEXT = `What fleeting thought might cross Isambard's mind while idle?`;

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
    const { logger, activityType, identityContext, getRecentContext } = deps;

    return {
        async generate(includeIdleEmoji = true): Promise<ActivitiesOptions> {
            try {
                logger.debug({ includeIdleEmoji }, 'Generating idle status with Haiku');

                // Build system prompt with identity context
                const systemPrompt = _.replace(SYSTEM_PROMPT_TEMPLATE, '{identityContext}', identityContext);

                // Get recent context if callback is provided
                const recentContext = await getRecentContext?.();

                // Build user prompt based on context availability
                const userPrompt = recentContext
                    ? _.replace(USER_PROMPT_WITH_CONTEXT, '{recentContext}', recentContext)
                    : USER_PROMPT_WITHOUT_CONTEXT;

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true });
                // Reserve space for emoji prefix if needed (💤 + space = 3 chars)
                const maxLength = includeIdleEmoji ? 125 : 128;
                const statusText = text.slice(0, maxLength);

                // Add 💤 prefix if requested
                const finalStatus = includeIdleEmoji ? `💤 ${statusText}` : statusText;

                logger.info({ statusText: finalStatus }, 'Generated idle status');
                return { name: finalStatus, type: activityType };
            } catch (error) {
                // Stryker disable all: Error fallback - tested only via integration, difficult to trigger in unit tests
                logger.error({ error }, 'Failed to generate idle status, using fallback');
                const fallback = includeIdleEmoji ? '💤 Idle' : 'Idle';
                return { name: fallback, type: activityType };
                // Stryker restore all
            }
        },
    };
}
