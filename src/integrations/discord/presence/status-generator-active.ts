/**
 * Active Status Generator
 *
 * Generates Discord status text based on the current agent activity phase.
 * Fast, synchronous, deterministic - maps phases to pre-defined status messages.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import { type PresencePhase, type PresenceDisplayMode, ToolStatusMap  } from './types.js';

/**
 * Interface for generating status text based on current activity phase.
 */
export interface ActiveStatusGenerator {
    /**
   * Generate Discord activity for the current agent activity phase.
   * This is fast and synchronous - uses pre-defined mappings.
   *
   * @param phase - Current presence phase
   * @param presenceDisplayMode - Current presence display mode for prefix generation
   * @returns Discord activity configuration
   */
    generate(phase: PresencePhase, presenceDisplayMode?: PresenceDisplayMode): ActivitiesOptions

    /**
     * Format a status text with the appropriate presence display mode prefix.
     * Use this when you have a pre-generated status text (e.g., from LLM).
     *
     * @param statusText - The status text to format
     * @param presenceDisplayMode - Current presence display mode for prefix generation
     * @returns Discord activity configuration
     */
    formatStatus(statusText: string, presenceDisplayMode?: PresenceDisplayMode): ActivitiesOptions
}

/**
 * Dependencies for creating an active status generator.
 */
export interface ActiveStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        debug: (message: unknown, ...args: unknown[]) => void
        warn:  (message: unknown, ...args: unknown[]) => void
        error: (message: unknown, ...args: unknown[]) => void
    }
    /** Discord activity type (e.g., ActivityType.Custom) */
    activityType: ActivityType
}

/**
 * Returns the emoji prefix for the given presence display mode.
 *
 * @param presenceDisplayMode - Current presence display mode
 * @returns Emoji prefix string (with trailing space if applicable)
 */
function getPresencePrefix(presenceDisplayMode: PresenceDisplayMode | undefined): string {
    // Stryker disable BlockStatement,ConditionalExpression,LogicalOperator: Early return and default case have same behavior ('') - tested in integration
    if(!presenceDisplayMode || presenceDisplayMode === 'none') {
        return '';
    }
    // Stryker restore BlockStatement,ConditionalExpression,LogicalOperator

    // Switch case emojis are tested in test file
    switch(presenceDisplayMode) { // Stryker disable ConditionalExpression,StringLiteral
        case 'catching_up': {
            return '📥 ';
        }
        case 'processing_message': {
            return '💬 ';
        }
        case 'perching': {
            return '🦉 ';
        }
        default: {
            return '';
        }
    }
}

/**
 * Creates an active status generator.
 *
 * The generator maps presence phases to Discord status text using a simple switch statement.
 * For tool usage, it looks up the tool name in ToolStatusMap and falls back to "Working..."
 * for unknown tools.
 *
 * When presence display mode is provided, adds appropriate emoji prefixes:
 * - catching_up: 📥
 * - processing_message: 💬
 * - perching: 🦉
 *
 * @param deps - Dependencies including logger and activity type
 * @returns ActiveStatusGenerator instance
 *
 * @example
 * ```typescript
 * const generator = createActiveStatusGenerator({
 *   logger: myLogger,
 *   activityType: ActivityType.Custom
 * });
 *
 * const activity = generator.generate({ type: 'thinking', startedAt: new Date() });
 * // Returns: { name: 'Thinking...', type: ActivityType.Custom }
 *
 * const activityWithPrefix = generator.generate(
 *   { type: 'thinking', startedAt: new Date() },
 *   'catching_up'
 * );
 * // Returns: { name: '📥 Thinking...', type: ActivityType.Custom }
 * ```
 */
export function createActiveStatusGenerator(
    deps: ActiveStatusGeneratorDeps
): ActiveStatusGenerator {
    const { logger, activityType } = deps;

    return {
        generate(phase: PresencePhase, presenceDisplayMode?: PresenceDisplayMode): ActivitiesOptions {
            logger.debug({ phase, presenceDisplayMode }, 'Generating active status');

            const prefix = getPresencePrefix(presenceDisplayMode);
            let baseStatus: string;

            switch(phase.type) {
                case 'idle': {
                    // Should not be called for idle - caller's responsibility
                    logger.warn('Active status generator called for idle phase');
                    baseStatus = 'Idle';
                    break;
                }

                case 'thinking': {
                    baseStatus = phase.generatedStatus ?? 'Thinking...';
                    break;
                }

                case 'using_tool': {
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: generatedStatus may be absent at runtime despite typed as optional string
                    baseStatus = phase.generatedStatus ?? ToolStatusMap[phase.toolName] ?? 'Working...';
                    break;
                }

                case 'responding': {
                    baseStatus = phase.generatedStatus ?? 'Responding...';
                    break;
                }

                default: {
                    // Exhaustiveness check - TypeScript will error if we miss a case
                    const _exhaustive: never = phase;
                    logger.error({ phase: _exhaustive }, 'Unknown presence phase');
                    baseStatus = 'Processing...';
                }
            }

            return { name: `${prefix}${baseStatus}`, type: activityType };
        },

        formatStatus(statusText: string, presenceDisplayMode?: PresenceDisplayMode): ActivitiesOptions {
            const prefix = getPresencePrefix(presenceDisplayMode);
            return { name: `${prefix}${statusText}`, type: activityType };
        },
    };
}
