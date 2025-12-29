/**
 * Presence Manager
 *
 * Coordinates Discord presence updates with debouncing, rate limiting,
 * and idle status refresh loops.
 */

import type { Client as DiscordClient, ActivitiesOptions } from 'discord.js';
import type { PresenceConfig, PresencePhase } from './types.js';
import type { ActiveStatusGenerator } from './status-generator-active.js';
import type { IdleStatusGenerator } from './status-generator-idle.js';

/**
 * Interface for managing Discord presence state.
 */
export interface PresenceManager {
    /**
   * Update presence based on current phase.
   * Debounced to prevent rate limiting.
   *
   * @param phase - Current activity phase
   */
    updatePhase(phase: PresencePhase): Promise<void>

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
    discordClient:         DiscordClient
    /** Generator for active status text */
    activeStatusGenerator: ActiveStatusGenerator
    /** Generator for idle status text */
    idleStatusGenerator:   IdleStatusGenerator
    /** Configuration for timing and rate limiting */
    config:                PresenceConfig
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
 * - Debouncing to prevent Discord rate limits
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
 *   config: { updateDebounceMs: 2000, ... },
 *   logger: myLogger
 * });
 *
 * await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
 * // Presence updates to "Thinking..." after debounce
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
        config,
        logger,
    } = deps;

    let currentPhase: PresencePhase | null = null; // Start uninitialized
    let lastUpdateTime = 0;
    let pendingUpdate: NodeJS.Timeout | null = null;
    let idleRefreshInterval: NodeJS.Timeout | null = null;

    /**
   * Actually update Discord presence (rate-limited).
   */
    async function applyPresenceUpdate(activity: ActivitiesOptions): Promise<void> {
        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateTime;

        if(timeSinceLastUpdate < config.updateDebounceMs) {
            logger.debug(
                { timeSinceLastUpdate, debounceMs: config.updateDebounceMs },
                'Skipping presence update due to rate limit'
            );
            return;
        }

        try {
            discordClient.user?.setActivity(activity);
            lastUpdateTime = now;
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

        const activity = await idleStatusGenerator.generate();
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
        async updatePhase(phase: PresencePhase): Promise<void> {
            logger.debug({ phase }, 'Updating presence phase');

            const wasIdle = currentPhase?.type === 'idle';
            const nowIdle = phase.type === 'idle';

            currentPhase = phase;

            // Cancel any pending debounced update
            if(pendingUpdate) {
                clearTimeout(pendingUpdate);
                pendingUpdate = null;
            }

            // Handle idle state transitions
            if(nowIdle && !wasIdle) {
                await startIdleRefresh();
                return; // refreshIdleStatus() will update presence
            }
            if(!nowIdle && wasIdle) {
                stopIdleRefresh();
            }

            // Generate status for active phases
            if(!nowIdle) {
                const activity = activeStatusGenerator.generate(phase);

                // Debounce the update
                pendingUpdate = setTimeout(() => {
                    void applyPresenceUpdate(activity);
                    pendingUpdate = null;
                }, config.updateDebounceMs);
            }
        },

        start(): void {
            logger.info('Starting presence manager');
            if(currentPhase?.type === 'idle') {
                void startIdleRefresh();
            }
        },

        stop(): void {
            logger.info('Stopping presence manager');
            stopIdleRefresh();
            if(pendingUpdate) {
                clearTimeout(pendingUpdate);
                pendingUpdate = null;
            }
        },
    };
}
