/**
 * Active Status Generator
 *
 * Generates Discord status text based on the current agent activity phase.
 * Fast, synchronous, deterministic - maps phases to pre-defined status messages.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import { type PresencePhase, ToolStatusMap  } from './types.js';

/**
 * Interface for generating status text based on current activity phase.
 */
export interface ActiveStatusGenerator {
    /**
   * Generate Discord activity for the current agent activity phase.
   * This is fast and synchronous - uses pre-defined mappings.
   *
   * @param phase - Current presence phase
   * @returns Discord activity configuration
   */
    generate(phase: PresencePhase): ActivitiesOptions
}

/**
 * Dependencies for creating an active status generator.
 */
interface ActiveStatusGeneratorDeps {
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
 * Creates an active status generator.
 *
 * The generator maps presence phases to Discord status text using a simple switch statement.
 * For tool usage, it looks up the tool name in ToolStatusMap and falls back to "Working..."
 * for unknown tools. The result is the bare digest: `PresenceManager.applyView` renders it
 * after the composed presence prefix via `renderPresenceText`.
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
 * ```
 */
export function createActiveStatusGenerator(
    deps: ActiveStatusGeneratorDeps
): ActiveStatusGenerator {
    const { logger, activityType } = deps;

    return {
        generate(phase: PresencePhase): ActivitiesOptions {
            logger.debug({ phase }, 'Generating active status');

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

            return { name: baseStatus, type: activityType };
        },
    };
}
