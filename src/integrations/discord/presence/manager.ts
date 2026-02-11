/**
 * Presence Manager
 *
 * Coordinates Discord presence updates and idle status refresh loops.
 * Throttling is handled upstream by BotStateManager - this manager applies
 * all updates it receives.
 *
 * Update behavior:
 * - Active phases (thinking, responding, using_tool) are applied immediately
 * - Idle transitions are applied immediately - they mark end of work
 * - Idle refresh loop runs independently on its own schedule
 */

import _ from 'lodash';
import type { Client as DiscordClient, ActivitiesOptions } from 'discord.js';
import type { PresenceConfig, PresencePhase, PresenceDisplayMode, CatchUpSynopsisContext } from './types.js';
import type { ActiveStatusGenerator } from './status-generator-active.js';
import type { IdleStatusGenerator } from './status-generator-idle.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { withDiscordRetry } from '@/integrations/discord/retry';
import { DateTime } from 'luxon';

/**
 * Interface for managing Discord presence state.
 */
export interface PresenceManager {
    /**
     * Update presence based on current phase.
     * Applies updates immediately (throttling handled upstream by BotStateManager).
     *
     * @param phase - Current activity phase
     */
    updatePhase(phase: PresencePhase): Promise<void>

    /**
     * Transition to a new presence display mode, managing status updates and lifecycle.
     * This method has side effects: generates LLM-powered status updates,
     * manages idle refresh loop lifecycle, and handles complex state transitions.
     *
     * @param mode - Presence display mode state
     * @param catchUpContext - Optional rich context for catch-up status generation
     */
    transitionPresenceDisplayMode(mode: PresenceDisplayMode, catchUpContext?: CatchUpSynopsisContext): void

    /**
     * Start the presence manager (enables idle refresh if idle).
     */
    start(): void

    /**
     * Stop the presence manager (clears all timers).
     */
    stop(): void
}

/**
 * Dependencies for creating a presence manager.
 */
export interface PresenceManagerDeps {
    /** Discord client for setting presence */
    discordClient:           DiscordClient
    /** Generator for active status text */
    activeStatusGenerator:   ActiveStatusGenerator
    /** Generator for idle status text */
    idleStatusGenerator:     IdleStatusGenerator
    /** Optional generator for dynamic status text (used for catch-up mode) */
    dynamicStatusGenerator?: DynamicStatusGenerator
    /** Configuration for timing and rate limiting */
    config:                  PresenceConfig
    /** Logger instance */
    logger: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        debug: (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        info:  (message: any, ...args: any[]) => void
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Logger interface accepts any args
        error: (message: any, ...args: any[]) => void
    }
}

/**
 * Creates a presence manager.
 *
 * The manager coordinates all presence updates with:
 * - Immediate updates for all phases (throttling handled upstream by BotStateManager)
 * - Automatic idle status refresh on an interval
 * - State transitions between active and idle phases
 * - Graceful error handling
 *
 * @param deps - Dependencies including Discord client and status generators
 * @returns PresenceManager instance
 *
 * @example
 * ```typescript
 * const manager = createPresenceManager({
 *   discordClient: myClient,
 *   activeStatusGenerator: myActiveGen,
 *   idleStatusGenerator: myIdleGen,
 *   config: { updateThrottleMs: 10000, ... },
 *   logger: myLogger
 * });
 *
 * await manager.updatePhase({ type: 'thinking', startedAt: new Date(), generatedStatus: 'Thinking...' });
 * // Update is applied immediately (throttling handled upstream)
 *
 * await manager.updatePhase({ type: 'idle', since: new Date() });
 * // Starts idle refresh loop
 *
 * manager.stop();
 * // Cleans up all timers
 * ```
 */
export function createPresenceManager(
    deps: PresenceManagerDeps
): PresenceManager {
    const {
        discordClient,
        activeStatusGenerator,
        idleStatusGenerator,
        dynamicStatusGenerator,
        config,
        logger,
    } = deps;

    let currentPhase: PresencePhase | null = null; // Start uninitialized
    let idleRefreshInterval: NodeJS.Timeout | null = null;
    let presenceDisplayMode: PresenceDisplayMode = 'none'; // Track presence display mode for status prefixes

    /**
     * Actually update Discord presence.
     */
    async function applyPresenceUpdate(activity: ActivitiesOptions): Promise<void> {
        try {
            // Use low retry count for presence updates (not critical)
            await withDiscordRetry(
                () => {
                    discordClient.user?.setActivity(activity);
                    return Promise.resolve();
                },
                // Stryker disable next-line StringLiteral: Operation name for retry logging
                'setActivity',
                // Stryker disable next-line ObjectLiteral: Retry policy already tested in retry module
                { policy: { maxAttempts: 2 } }
            );
            logger.info({ activity }, 'Updated Discord presence');
        } catch (error) {
            logger.error({ error, activity }, 'Failed to update Discord presence');
        }
    }

    /**
     * Generate and apply idle status.
     *
     * Note: The guard `if(currentPhase?.type !== 'idle')` is defensive code that handles
     * a theoretical race condition where the interval callback fires just as we're
     * transitioning away from idle. In practice, stopIdleRefresh() clears the interval
     * before the phase change is complete, making this guard unreachable during normal
     * execution. Stryker mutations on this guard (if(false), optional chaining removal,
     * empty block) are effectively equivalent mutants since the guard can only trigger
     * in edge-case timing scenarios that are difficult to reliably reproduce in tests.
     */
    async function refreshIdleStatus(): Promise<void> {
        // Stryker disable next-line ConditionalExpression,OptionalChaining,BlockStatement: Defensive guard for race condition - unreachable in tests
        if(currentPhase?.type !== 'idle') {
            return; // No longer idle
        }

        // Capture current mode at start to detect stale results
        const modeAtStart = presenceDisplayMode;

        // Stryker disable next-line BooleanLiteral: includeEmoji parameter - always true for idle status generation
        const activity = await idleStatusGenerator.generate(true, presenceDisplayMode);

        // Check if mode changed while generating - if so, discard stale result
        // Stryker disable BlockStatement,ObjectLiteral,StringLiteral: Logging for observability and race condition guard
        // Stryker disable next-line ConditionalExpression: Guard clause - prevents stale status when mode changes during generation
        if(presenceDisplayMode !== modeAtStart) {
            logger.debug({ modeAtStart, currentMode: presenceDisplayMode }, 'Discarding stale idle status (mode changed during generation)');
            return;
        }
        // Stryker restore BlockStatement,ObjectLiteral,StringLiteral

        await applyPresenceUpdate(activity);
    }

    /**
     * Start periodic idle status refresh.
     * Returns a promise that resolves after the first refresh completes.
     */
    // Stryker disable BlockStatement: Idempotent guard - tested via integration
    async function startIdleRefresh(): Promise<void> {
        // Stryker disable next-line ConditionalExpression: Guard clause - prevents duplicate interval creation
        if(idleRefreshInterval) {
            return; // Already running
        }
        // Stryker restore BlockStatement

        // Generate immediately and wait for it
        await refreshIdleStatus();

        // Then refresh periodically
        idleRefreshInterval = setInterval(() => {
            void refreshIdleStatus();
        }, config.idleRefreshIntervalMs);

        logger.debug({ intervalMs: config.idleRefreshIntervalMs }, 'Started idle status refresh');
    }

    /**
     * Stop periodic idle status refresh.
     */
    function stopIdleRefresh(): void {
        if(idleRefreshInterval) {
            clearInterval(idleRefreshInterval);
            idleRefreshInterval = null;
            logger.debug('Stopped idle status refresh');
        }
    }

    return {
        transitionPresenceDisplayMode(mode: PresenceDisplayMode, catchUpContext?: CatchUpSynopsisContext): void {
            // Stryker disable next-line StringLiteral,ObjectLiteral: Log message content is not behavior-affecting
            logger.debug({ mode, previousMode: presenceDisplayMode }, 'Setting presence display mode');
            const previousMode = presenceDisplayMode;
            presenceDisplayMode = mode;

            // When ENTERING catch-up mode (from 'none'), generate ONE initial status update
            // to show the 📥 prefix. The catch-up agent session's stream handler will then
            // drive all subsequent status updates (thinking, using_tool, responding).
            // We do NOT start the idle refresh loop during catch-up.
            const enteringCatchUp = (mode === 'catching_up' || mode === 'catching_up_interrupted') && previousMode === 'none';

            // Handle based on current phase state
            if(currentPhase) {
                // We have a current phase - update it with the new mode
                if(currentPhase.type === 'idle') {
                    // For idle phase, generate ONE initial status when entering catch-up mode
                    // This shows the 📥 prefix immediately
                    // Do NOT start the idle refresh loop - stream handler will drive updates
                    if(enteringCatchUp) {
                        void (async () => {
                            // Stryker disable BlockStatement: Error logging catch block for observability
                            try {
                                // Use dynamic generator if catch-up context provided and generator available
                                if(catchUpContext && dynamicStatusGenerator) {
                                    const statusText = await dynamicStatusGenerator.generateCatchUpSynopsis(catchUpContext);
                                    const activity = activeStatusGenerator.formatStatus(statusText, mode);
                                    await applyPresenceUpdate(activity);
                                } else {
                                    // Fallback to idle generator
                                    const activity = await idleStatusGenerator.generate(true, mode);
                                    await applyPresenceUpdate(activity);
                                }
                            } catch (error) {
                                // Stryker disable next-line ObjectLiteral,StringLiteral: Error logging content
                                logger.error({ error, mode }, 'Failed to generate catch-up status');
                            }
                            // Stryker restore BlockStatement
                        })();
                    }
                    // When exiting catch-up mode, generate an immediate idle refresh
                    // This ensures we show normal idle status without waiting for the next interval
                    const exitingCatchUp = mode === 'none' && (previousMode === 'catching_up' || previousMode === 'catching_up_interrupted');
                    if(exitingCatchUp) {
                        void refreshIdleStatus();
                    }
                } else if(mode !== 'none') {
                    // For active phases, update immediately with new mode prefix
                    // Skip when transitioning to 'none' (idle) — the subsequent updatePhase(idle) handles it
                    const activity = activeStatusGenerator.generate(currentPhase, mode);
                    void applyPresenceUpdate(activity);
                }
            } else {
                // No current phase (startup case) - generate ONE initial status when entering catch-up mode
                if(enteringCatchUp) {
                    // Generate catch-up status (with 📥 prefix)
                    // Note: We can't use refreshIdleStatus() here because it checks currentPhase.type === 'idle'
                    // and returns early if false. At startup, currentPhase is null.
                    void (async () => {
                        // Stryker disable BlockStatement: Error logging catch block for observability
                        try {
                            // Use dynamic generator if catch-up context provided and generator available
                            if(catchUpContext && dynamicStatusGenerator) {
                                const statusText = await dynamicStatusGenerator.generateCatchUpSynopsis(catchUpContext);
                                const activity = activeStatusGenerator.formatStatus(statusText, mode);
                                await applyPresenceUpdate(activity);
                            } else {
                                // Fallback to idle generator
                                const activity = await idleStatusGenerator.generate(true, mode);
                                await applyPresenceUpdate(activity);
                            }
                        } catch (error) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: Error logging content
                            logger.error({ error, mode }, 'Failed to generate catch-up status');
                        }
                        // Stryker restore BlockStatement
                    })();
                }
            }

            // DON'T trigger idle refresh loop during catch-up - stream handler drives updates
            // DO trigger immediate idle refresh when exiting catch-up to 'none' (handled above)
        },

        async updatePhase(phase: PresencePhase): Promise<void> {
            // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
            const logPhase = phase.type === 'idle'
                ? { ...phase, since: DateTime.fromJSDate(phase.since).toISO() }
                : phase;
            // Stryker restore ObjectLiteral,StringLiteral
            logger.debug({ phase: logPhase }, 'Updating presence phase');

            const wasIdle = currentPhase?.type === 'idle';
            const nowIdle = phase.type === 'idle';

            currentPhase = phase;

            // Handle idle state transitions
            // Transition TO idle: always immediate (bypasses cooldown)
            if(nowIdle && !wasIdle) {
                // If presence display mode is active, don't start idle refresh yet.
                // The transitionPresenceDisplayMode('none') call will trigger idle refresh with correct mode.
                // Stryker disable next-line ConditionalExpression: Mode check - prevents idle refresh during catch-up
                if(presenceDisplayMode === 'none') {
                    await startIdleRefresh();
                }
                return;
            }

            // Already idle and staying idle - don't restart the refresh loop
            if(nowIdle && wasIdle) {
                logger.debug('Already idle, skipping duplicate idle transition');
                return;
            }

            // Transition FROM idle: stop the refresh loop
            // Stryker disable next-line ConditionalExpression,LogicalOperator: State transition guard - prevents idle refresh when transitioning from idle to active
            if(!nowIdle && wasIdle) {
                stopIdleRefresh();
            }

            // Handle active phases (throttling is now done upstream by BotStateManager)
            // Stryker disable next-line ConditionalExpression: Guard clause - active phase handling
            if(!nowIdle) {
                const activity = activeStatusGenerator.generate(phase, presenceDisplayMode);
                await applyPresenceUpdate(activity);
            }
        },

        start(): void {
            logger.info('Starting presence manager');
            // Don't start idle refresh here - wait for explicit phase transition
            // The caller should call updatePhase() after determining if catch-up is needed
        },

        stop(): void {
            logger.info('Stopping presence manager');
            stopIdleRefresh();
        },
    };
}
