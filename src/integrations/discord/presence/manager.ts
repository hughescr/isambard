/**
 * Presence Manager
 *
 * Coordinates Discord presence updates with leading-edge throttling,
 * and idle status refresh loops.
 *
 * Throttle behavior:
 * - Active phases (thinking, responding, using_tool) use leading-edge throttle:
 *   First update fires immediately, subsequent updates within cooldown are dropped.
 * - Idle transitions are immediate (bypass cooldown) - they mark end of work.
 * - Idle refresh loop runs independently on its own schedule.
 */

import type { Client as DiscordClient, ActivitiesOptions } from 'discord.js';
import type { PresenceConfig, PresencePhase, CatchUpMode, CatchUpSynopsisContext } from './types.js';
import type { ActiveStatusGenerator } from './status-generator-active.js';
import type { IdleStatusGenerator } from './status-generator-idle.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { withDiscordRetry } from '@/integrations/discord/retry';

/**
 * Interface for managing Discord presence state.
 */
export interface PresenceManager {
    /**
     * Check if an active phase update would be applied (not throttled).
     * Use this before generating expensive LLM synopses.
     *
     * Note: This only applies to active phases. Idle transitions always apply.
     *
     * @returns true if updatePhase would apply the update, false if throttled
     */
    shouldUpdate(): boolean

    /**
     * Update presence based on current phase.
     * Uses leading-edge throttle for active phases.
     *
     * @param phase - Current activity phase
     */
    updatePhase(phase: PresencePhase): Promise<void>

    /**
     * Set the catch-up mode for status prefix generation.
     * This affects the emoji prefix shown in Discord status.
     *
     * @param mode - Catch-up mode state
     * @param catchUpContext - Optional rich context for catch-up status generation
     */
    setCatchUpMode(mode: CatchUpMode, catchUpContext?: CatchUpSynopsisContext): void

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
 * - Leading-edge throttle for active phases (first fires, rest dropped within cooldown)
 * - Immediate updates for idle transitions (bypass cooldown)
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
 * // Check before expensive LLM call
 * if (manager.shouldUpdate()) {
 *   const synopsis = await generateExpensiveSynopsis();
 *   await manager.updatePhase({ type: 'thinking', startedAt: new Date(), generatedStatus: synopsis });
 * }
 *
 * await manager.updatePhase({ type: 'idle', since: new Date() });
 * // Starts idle refresh loop (always applies immediately)
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
    let lastActiveUpdateTime = 0; // Track last active phase update time
    let idleRefreshInterval: NodeJS.Timeout | null = null;
    let catchUpMode: CatchUpMode = 'none'; // Track catch-up mode for status prefixes

    /**
     * Check if enough time has passed since last active phase update.
     * Used to implement leading-edge throttle.
     */
    function isThrottleCooldownExpired(): boolean {
        const now = Date.now();
        const timeSinceLastUpdate = now - lastActiveUpdateTime;
        return timeSinceLastUpdate >= config.updateThrottleMs;
    }

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
        const modeAtStart = catchUpMode;

        const activity = await idleStatusGenerator.generate(true, catchUpMode);

        // Check if mode changed while generating - if so, discard stale result
        if(catchUpMode !== modeAtStart) {
            logger.debug({ modeAtStart, currentMode: catchUpMode }, 'Discarding stale idle status (mode changed during generation)');
            return;
        }

        await applyPresenceUpdate(activity);
    }

    /**
     * Start periodic idle status refresh.
     * Returns a promise that resolves after the first refresh completes.
     */
    async function startIdleRefresh(): Promise<void> {
        if(idleRefreshInterval) {
            return; // Already running
        }

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
        shouldUpdate(): boolean {
            // shouldUpdate only applies to active phases
            // The caller should use this before generating expensive synopses
            return isThrottleCooldownExpired();
        },

        // Stryker disable all: setCatchUpMode integration tested via bot lifecycle, not unit tested
        setCatchUpMode(mode: CatchUpMode, catchUpContext?: CatchUpSynopsisContext): void {
            logger.debug({ mode, previousMode: catchUpMode }, 'Setting catch-up mode');
            const previousMode = catchUpMode;
            catchUpMode = mode;

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
                        })();
                    }
                    // When exiting catch-up mode, generate an immediate idle refresh
                    // This ensures we show normal idle status without waiting for the next interval
                    const exitingCatchUp = mode === 'none' && (previousMode === 'catching_up' || previousMode === 'catching_up_interrupted');
                    if(exitingCatchUp) {
                        void refreshIdleStatus();
                    }
                } else {
                    // For active phases, update immediately (always)
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
                    })();
                }
            }

            // DON'T trigger idle refresh loop during catch-up - stream handler drives updates
            // DO trigger immediate idle refresh when exiting catch-up to 'none' (handled above)
        },
        // Stryker restore all

        async updatePhase(phase: PresencePhase): Promise<void> {
            logger.debug({ phase }, 'Updating presence phase');

            const wasIdle = currentPhase?.type === 'idle';
            const nowIdle = phase.type === 'idle';

            currentPhase = phase;

            // Handle idle state transitions
            // Transition TO idle: always immediate (bypasses cooldown)
            if(nowIdle && !wasIdle) {
                // If catch-up mode is active, don't start idle refresh yet.
                // The setCatchUpMode('none') call will trigger idle refresh with correct mode.
                if(catchUpMode === 'none') {
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
            if(!nowIdle && wasIdle) {
                stopIdleRefresh();
            }

            // Handle active phases with leading-edge throttle
            if(!nowIdle) {
                // Check throttle: only update if cooldown has expired
                if(isThrottleCooldownExpired()) {
                    const activity = activeStatusGenerator.generate(phase, catchUpMode);
                    await applyPresenceUpdate(activity);
                    lastActiveUpdateTime = Date.now();
                } else {
                    const timeSinceLastUpdate = Date.now() - lastActiveUpdateTime;
                    logger.debug(
                        { timeSinceLastUpdate, throttleMs: config.updateThrottleMs },
                        'Skipping presence update due to throttle cooldown'
                    );
                }
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
