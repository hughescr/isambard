/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import type { Anthropic } from '@anthropic-ai/sdk';
import { StatusGenerationError } from './errors.js';

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
  generate(): Promise<ActivitiesOptions>;
}

/**
 * Dependencies for creating an idle status generator.
 */
export interface IdleStatusGeneratorDeps {
  /** Anthropic API client for Haiku calls */
  anthropic: Anthropic;
  /** Logger instance for structured logging */
  logger: {
    debug: (message: any, ...args: any[]) => void;
    info: (message: any, ...args: any[]) => void;
    error: (message: any, ...args: any[]) => void;
  };
  /** Discord activity type (e.g., ActivityType.Custom) */
  activityType: ActivityType;
  /** Identity/personality context for the AI prompt */
  identityContext: string;
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
 * @param deps - Dependencies including Anthropic client, logger, and identity context
 * @returns IdleStatusGenerator instance
 *
 * @example
 * ```typescript
 * const generator = createIdleStatusGenerator({
 *   anthropic: myAnthropicClient,
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
  deps: IdleStatusGeneratorDeps,
): IdleStatusGenerator {
  const { anthropic, logger, activityType, identityContext } = deps;

  return {
    async generate(): Promise<ActivitiesOptions> {
      try {
        logger.debug('Generating idle status with Haiku');

        const prompt = IDLE_STATUS_PROMPT.replace('{identity}', identityContext);

        const response = await anthropic.messages.create({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 50,
          messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content?.type !== 'text') {
          throw new StatusGenerationError('Unexpected response type from Haiku');
        }

        const statusText = content.text.trim().slice(0, 128);
        logger.info({ statusText }, 'Generated idle status');

        return { name: statusText, type: activityType };
      } catch (error) {
        logger.error({ error }, 'Failed to generate idle status, using fallback');
        return { name: 'Idle', type: activityType };
      }
    },
  };
}
