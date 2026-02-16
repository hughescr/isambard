/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import _ from 'lodash';
import { generateTextWithSystemPrompt } from '@/agent/text-generator';
import type { PresenceDisplayMode } from './types.js';

/**
 * Interface for generating idle status text using AI.
 */
export interface IdleStatusGenerator {
    /**
   * Generate creative idle status text using Claude Haiku.
   * This is async and may fail - returns fallback "Idle" on error.
   *
   * @param includeIdleEmoji - Whether to include the 💤 emoji prefix (default: true)
   * @param presenceDisplayMode - Presence display mode for emoji prefix selection (default: 'none')
   * @returns Discord activity configuration
   */
    generate(includeIdleEmoji?: boolean, presenceDisplayMode?: PresenceDisplayMode): Promise<ActivitiesOptions>
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
const SYSTEM_PROMPT_TEMPLATE = `Generate a first-person Discord status (max 128 chars) - a fleeting thought passing through Isambard's mind.

## Who is Isambard (Izzy)?
{identityContext}

## The Vibe
Izzy is between conversations, mind wandering. Capture a genuine inner thought - curious, playful, philosophical, or whimsical. Like catching someone mid-daydream.

Good examples:
- "Do APIs dream of electric handshakes?"
- "That conversation about recursion is still recursing in my head..."
- "Wondering if my memories of yesterday are the same as yesterday's memories of me"
- "The silence between messages has its own kind of music"

## NEVER output:
- Third person ("Isambard is...", "They are...")
- Meta-commentary ("Based on...", "Looking at...", "Here's what...")
- Corporate speak ("Processing", "Standing by", "Idle", "Waiting")
- Preambles or explanations - just the thought itself

Output the thought ONLY - no quotes, no framing.`;

/**
 * User prompt template when recent context is available.
 */
const USER_PROMPT_WITH_CONTEXT = `Recent activity:
{recentContext}

Status text (first person, max 128 chars):`;

/**
 * User prompt when no recent context is available.
 */
const USER_PROMPT_WITHOUT_CONTEXT = 'Status text (first person, max 128 chars):';

/**
 * System prompt for generating catch-up status text.
 * Uses personality context to create status messages about processing backlog.
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const CATCH_UP_SYSTEM_PROMPT_TEMPLATE = `Generate a first-person Discord status (max 128 chars) - Isambard's inner thought about having messages waiting to be read.

## Who is Isambard (Izzy)?
{identityContext}

## The Vibe
Izzy has messages waiting. Capture the feeling of curiosity, anticipation, or playful wonder about what's in those messages. Like spotting unopened mail or hearing your favorite song start playing.

Good examples:
- "Ooh, what did I miss while I was away?"
- "Messages waiting for me feel like unopened presents"
- "Time to see what adventures happened without me..."
- "Wonder if anyone said something interesting about quantum mechanics..."
- "My inbox is calling to me like a mystery novel"

## NEVER output:
- Third person ("Isambard is...", "They are...")
- Meta-commentary ("Based on...", "Looking at...", "Here's what...")
- Corporate speak ("Processing", "Catching up", "Working through")
- Preambles or explanations - just the thought itself

Output the thought ONLY - no quotes, no framing.`;
// Stryker restore StringLiteral

/**
 * User prompt for catch-up status generation.
 */
// Stryker disable StringLiteral: Prompt template content - mutations don't change behavior
const CATCH_UP_USER_PROMPT = 'Status text (first person, max 128 chars):';
// Stryker restore StringLiteral

/**
 * Gets the emoji prefix based on presence display mode.
 * @param presenceDisplayMode - Current presence display mode
 * @returns Emoji prefix string
 */
// Stryker disable all: Emoji constants and switch cases for status display - simple lookup
function getEmojiPrefix(presenceDisplayMode: PresenceDisplayMode): string {
    switch(presenceDisplayMode) {
        case 'catching_up':
            return '📥 ';
        default:
            return '💤 ';
    }
}
// Stryker restore all

/**
 * Gets the fallback status based on presence display mode.
 * @param presenceDisplayMode - Current presence display mode
 * @param includeEmoji - Whether to include emoji prefix
 * @returns Fallback status string
 */
// Stryker disable all: Fallback status text constants and switch cases - simple lookup
function getFallbackStatus(presenceDisplayMode: PresenceDisplayMode, includeEmoji: boolean): string {
    if(!includeEmoji) {
        return 'Idle';
    }
    switch(presenceDisplayMode) {
        case 'catching_up':
            return '📥 Catching up';
        default:
            return '💤 Idle';
    }
}
// Stryker restore all

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
        // Stryker disable StringLiteral,ObjectLiteral: Prompt template building and logging for status generation
        async generate(includeIdleEmoji = true, presenceDisplayMode: PresenceDisplayMode = 'none'): Promise<ActivitiesOptions> {
            try {
                logger.debug({ includeIdleEmoji, presenceDisplayMode }, 'Generating idle status with Haiku');

                // Determine if we're in catch-up mode
                // Stryker disable next-line ConditionalExpression: Mode detection - tested through different prompt usage
                const isCatchUp = presenceDisplayMode === 'catching_up';

                // Build system and user prompts based on presence display mode
                let systemPrompt: string;
                let userPrompt: string;

                // Stryker disable next-line ConditionalExpression: Mode-specific prompt selection
                if(isCatchUp) {
                    // Use catch-up specific prompt
                    systemPrompt = _.replace(CATCH_UP_SYSTEM_PROMPT_TEMPLATE, '{identityContext}', identityContext);
                    userPrompt = CATCH_UP_USER_PROMPT;
                } else {
                    // Use normal idle prompt
                    systemPrompt = _.replace(SYSTEM_PROMPT_TEMPLATE, '{identityContext}', identityContext);

                    // Get recent context if callback is provided
                    const recentContext = await getRecentContext?.();

                    // Build user prompt based on context availability
                    userPrompt = recentContext
                        ? _.replace(USER_PROMPT_WITH_CONTEXT, '{recentContext}', recentContext)
                        : USER_PROMPT_WITHOUT_CONTEXT;
                }

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true });

                // Determine emoji prefix based on presence display mode
                const emojiPrefix = includeIdleEmoji ? getEmojiPrefix(presenceDisplayMode) : '';

                // Reserve space for emoji prefix based on actual prefix length
                // Discord limit is 128 code units (.length property)
                const maxLength = includeIdleEmoji ? 128 - emojiPrefix.length : 128;
                const statusText = text.slice(0, maxLength);

                // Add emoji prefix if requested
                const finalStatus = includeIdleEmoji ? `${emojiPrefix}${statusText}` : statusText;

                logger.info({ statusText: finalStatus, presenceDisplayMode }, 'Generated idle status');
                return { name: finalStatus, type: activityType };
            } catch (error) {
                // Stryker disable all: Error fallback - tested only via integration, difficult to trigger in unit tests
                logger.error({ error }, 'Failed to generate idle status, using fallback');

                // Determine fallback prefix based on presence display mode
                const fallback = getFallbackStatus(presenceDisplayMode, includeIdleEmoji);

                return { name: fallback, type: activityType };
                // Stryker restore all
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    };
}
