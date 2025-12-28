/**
 * Active Status Generator
 *
 * Generates Discord status text based on the current agent activity phase.
 * Fast, synchronous, deterministic - maps phases to pre-defined status messages.
 */

import type { ActivitiesOptions, ActivityType } from 'discord.js';
import type { PresencePhase } from './types.js';
import { ToolStatusMap } from './types.js';

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
export interface ActiveStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        debug: (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        warn:  (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        error: (message: any, ...args: any[]) => void
    }
    /** Discord activity type (e.g., ActivityType.Custom) */
    activityType: ActivityType
}

/**
 * Creates an active status generator.
 *
 * The generator maps presence phases to Discord status text using a simple switch statement.
 * For tool usage, it looks up the tool name in ToolStatusMap and falls back to "Working..."
 * for unknown tools.
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

            switch(phase.type) {
                case 'idle':
                    // Should not be called for idle - caller's responsibility
                    logger.warn('Active status generator called for idle phase');
                    return { name: 'Idle', type: activityType };

                case 'thinking':
                    return { name: 'Thinking...', type: activityType };

                case 'using_tool': {
                    const statusText = ToolStatusMap[phase.toolName] ?? 'Working...';
                    return { name: statusText, type: activityType };
                }

                case 'responding':
                    return { name: 'Responding...', type: activityType };

                default: {
                    // Exhaustiveness check - TypeScript will error if we miss a case
                    const _exhaustive: never = phase;
                    logger.error({ phase: _exhaustive }, 'Unknown presence phase');
                    return { name: 'Processing...', type: activityType };
                }
            }
        },
    };
}
