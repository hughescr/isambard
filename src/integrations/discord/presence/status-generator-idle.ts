/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import _ from 'lodash';
import { generateText } from '@/agent/text-generator';

/**
 * Interface for generating idle status text using AI.
 */
export interface IdleStatusGenerator {
    /**
   * Generate creative idle status text using Claude Haiku.
   * This is async and may fail - returns fallback "Idle" on error.
   *
   * @returns Discord activity configuration
   */
    generate(): Promise<ActivitiesOptions>
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
    activityType:    ActivityType
    /** Identity/personality context for the AI prompt */
    identityContext: string
}

/**
 * Prompt template for generating idle status text.
 * Uses personality context to create contextually appropriate status messages.
 */
const IDLE_STATUS_PROMPT = `You are generating a brief, creative Discord status message for an AI assistant that is currently idle.

Context about the assistant:
{identity}

Generate a single short phrase (max 128 chars) that reflects the assistant's personality while being idle. Examples:
- "Dozing in the void"
- "Contemplating digital dreams"
- "Awaiting your call"

Output ONLY the status text, nothing else.`;

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
 *   identityContext: 'I am a helpful AI assistant'
 * });
 *
 * const activity = await generator.generate();
 * // Returns: { name: 'Dozing peacefully', type: ActivityType.Custom }
 * ```
 */
export function createIdleStatusGenerator(
    deps: IdleStatusGeneratorDeps
): IdleStatusGenerator {
    const { logger, activityType, identityContext } = deps;

    return {
        async generate(): Promise<ActivitiesOptions> {
            try {
                logger.debug('Generating idle status with Haiku');

                const prompt = _.replace(IDLE_STATUS_PROMPT, '{identity}', identityContext);
                const text = await generateText(prompt);
                const statusText = text.slice(0, 128);

                logger.info({ statusText }, 'Generated idle status');
                return { name: statusText, type: activityType };
            } catch (error) {
                logger.error({ error }, 'Failed to generate idle status, using fallback');
                return { name: 'Idle', type: activityType };
            }
        },
    };
}
