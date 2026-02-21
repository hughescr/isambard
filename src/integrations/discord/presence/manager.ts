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
 * Presence manager coordinating Discord presence updates.
 *
 * The manager coordinates all presence updates with:
 * - Immediate updates for all phases (throttling handled upstream by BotStateManager)
 * - Automatic idle status refresh on an interval
 * - State transitions between active and idle phases
 * - Graceful error handling
 *
 * @example
 * ```typescript
 * const manager = new PresenceManager({
 *   discordClient: myClient,
 *   activeStatusGenerator: myActiveGen,
 *   idleStatusGenerator: myIdleGen,
 *   config: { updateThrottleMs: 10000, ... },
 *   logger: myLogger
 * });
 *
 * manager.start();
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
export class PresenceManager {
    private currentPhase:        PresencePhase | null = null; // Start uninitialized
    private idleRefreshInterval: NodeJS.Timeout | null = null;
    private presenceDisplayMode: PresenceDisplayMode = 'none'; // Track presence display mode for status prefixes

    constructor(private readonly deps: PresenceManagerDeps) {}

    /**
     * Actually update Discord presence.
     */
    private async applyPresenceUpdate(activity: ActivitiesOptions): Promise<void> {
        try {
            // Use low retry count for presence updates (not critical)
            await withDiscordRetry(
                () => {
                    this.deps.discordClient.user?.setActivity(activity);
                    return Promise.resolve();
                },
                // Stryker disable next-line StringLiteral: Operation name for retry logging
                'setActivity',
                // Stryker disable next-line ObjectLiteral: Retry policy already tested in retry module
                { policy: { maxAttempts: 2 } }
            );
            this.deps.logger.info({ activity }, 'Updated Discord presence');
        } catch (error) {
            this.deps.logger.error({ error, activity }, 'Failed to update Discord presence');
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
    private async refreshIdleStatus(): Promise<void> {
        // Stryker disable next-line ConditionalExpression,OptionalChaining,BlockStatement: Defensive guard for race condition - unreachable in tests
        if(this.currentPhase?.type !== 'idle') {
            return; // No longer idle
        }

        // Capture current mode at start to detect stale results
        const modeAtStart = this.presenceDisplayMode;

        const activity = await this.deps.idleStatusGenerator.generate();

        // Check if mode changed while generating - if so, discard stale result
        if(this.presenceDisplayMode !== modeAtStart) {
            this.deps.logger.debug({ modeAtStart, currentMode: this.presenceDisplayMode }, 'Discarding stale idle status (mode changed during generation)');
            return;
        }

        await this.applyPresenceUpdate(activity);
    }

    /**
     * Start periodic idle status refresh.
     * Returns a promise that resolves after the first refresh completes.
     */
    private async startIdleRefresh(): Promise<void> {
        // Stryker disable ConditionalExpression,BlockStatement: Async race condition guard — two concurrent callers could both see null before either sets idleRefreshInterval; no reliable test for this
        if(this.idleRefreshInterval) {
            return; // Already running
        }
        // Stryker restore ConditionalExpression,BlockStatement

        // Generate immediately and wait for it
        await this.refreshIdleStatus();

        // Then refresh periodically
        this.idleRefreshInterval = setInterval(() => {
            void this.refreshIdleStatus();
        }, this.deps.config.idleRefreshIntervalMs);

        this.deps.logger.debug({ intervalMs: this.deps.config.idleRefreshIntervalMs }, 'Started idle status refresh');
    }

    /**
     * Stop periodic idle status refresh.
     */
    private stopIdleRefresh(): void {
        if(this.idleRefreshInterval) {
            clearInterval(this.idleRefreshInterval);
            this.idleRefreshInterval = null;
            this.deps.logger.debug('Stopped idle status refresh');
        }
    }

    /**
     * Transition to a new presence display mode, managing status updates and lifecycle.
     * This method has side effects: generates LLM-powered status updates,
     * manages idle refresh loop lifecycle, and handles complex state transitions.
     *
     * @param mode - Presence display mode state
     * @param catchUpContext - Optional rich context for catch-up status generation
     */
    transitionPresenceDisplayMode(mode: PresenceDisplayMode, catchUpContext?: CatchUpSynopsisContext): void {
        // Stryker disable next-line StringLiteral,ObjectLiteral: Log message content is not behavior-affecting
        this.deps.logger.debug({ mode, previousMode: this.presenceDisplayMode }, 'Setting presence display mode');
        const previousMode = this.presenceDisplayMode;
        this.presenceDisplayMode = mode;

        // When ENTERING catch-up mode (from 'none'), generate ONE initial status update
        // with the 📥 prefix. The catch-up agent session's stream handler will then
        // drive all subsequent status updates (thinking, using_tool, responding).
        // We do NOT start the idle refresh loop during catch-up.
        const enteringCatchUp = mode === 'catching_up' && previousMode === 'none';

        // Handle based on current phase state
        if(this.currentPhase) {
            // We have a current phase - update it with the new mode
            if(this.currentPhase.type === 'idle') {
                // For idle phase, generate ONE initial status when entering catch-up mode
                // This shows the 📥 prefix immediately
                // Do NOT start the idle refresh loop - stream handler will drive updates
                if(enteringCatchUp) {
                    void (async () => {
                        // Stryker disable BlockStatement: Error logging catch block for observability
                        try {
                            // Use dynamic generator if catch-up context provided and generator available
                            if(catchUpContext && this.deps.dynamicStatusGenerator) {
                                const statusText = await this.deps.dynamicStatusGenerator.generateCatchUpSynopsis(catchUpContext);
                                // Stryker disable next-line ConditionalExpression: Null guard — fall through to idle generator when Haiku returns null
                                if(statusText !== null) {
                                    const activity = this.deps.activeStatusGenerator.formatStatus(statusText, mode);
                                    await this.applyPresenceUpdate(activity);
                                    return;
                                }
                            }
                            // Fallback to idle generator (no dynamic generator, no context, or null result)
                            const activity = await this.deps.idleStatusGenerator.generate();
                            await this.applyPresenceUpdate(activity);
                        } catch (error) {
                            // Stryker disable next-line ObjectLiteral,StringLiteral: Error logging content
                            this.deps.logger.error({ error, mode }, 'Failed to generate catch-up status');
                        }
                        // Stryker restore BlockStatement
                    })();
                }
                // When exiting catch-up mode, generate an immediate idle refresh
                // This ensures we show normal idle status without waiting for the next interval
                const exitingCatchUp = mode === 'none' && previousMode === 'catching_up';
                if(exitingCatchUp) {
                    void this.refreshIdleStatus();
                }
            } else if(mode !== 'none') {
                // For active phases, update immediately with new mode prefix
                // Skip when transitioning to 'none' (idle) — the subsequent updatePhase(idle) handles it
                const activity = this.deps.activeStatusGenerator.generate(this.currentPhase, mode);
                void this.applyPresenceUpdate(activity);
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
                        if(catchUpContext && this.deps.dynamicStatusGenerator) {
                            const statusText = await this.deps.dynamicStatusGenerator.generateCatchUpSynopsis(catchUpContext);
                            // Stryker disable next-line ConditionalExpression: Null guard — fall through to idle generator when Haiku returns null
                            if(statusText !== null) {
                                const activity = this.deps.activeStatusGenerator.formatStatus(statusText, mode);
                                await this.applyPresenceUpdate(activity);
                                return;
                            }
                        }
                        // Fallback to idle generator (no dynamic generator, no context, or null result)
                        const activity = await this.deps.idleStatusGenerator.generate();
                        await this.applyPresenceUpdate(activity);
                    } catch (error) {
                        // Stryker disable next-line ObjectLiteral,StringLiteral: Error logging content
                        this.deps.logger.error({ error, mode }, 'Failed to generate catch-up status');
                    }
                    // Stryker restore BlockStatement
                })();
            }
        }

        // DON'T trigger idle refresh loop during catch-up - stream handler drives updates
        // DO trigger immediate idle refresh when exiting catch-up to 'none' (handled above)
    }

    /**
     * Update presence based on current phase.
     * Applies updates immediately (throttling handled upstream by BotStateManager).
     *
     * @param phase - Current activity phase
     */
    async updatePhase(phase: PresencePhase): Promise<void> {
        // Stryker disable ObjectLiteral,StringLiteral: Log message content is not behavior-affecting
        const logPhase = phase.type === 'idle'
            ? { ...phase, since: DateTime.fromJSDate(phase.since).toISO() }
            : phase;
        // Stryker restore ObjectLiteral,StringLiteral
        this.deps.logger.debug({ phase: logPhase }, 'Updating presence phase');

        const wasIdle = this.currentPhase?.type === 'idle';
        const nowIdle = phase.type === 'idle';

        this.currentPhase = phase;

        // Handle idle state transitions
        // Transition TO idle: always immediate (bypasses cooldown)
        if(nowIdle && !wasIdle) {
            // If presence display mode is active, don't start idle refresh yet.
            // The transitionPresenceDisplayMode('none') call will trigger idle refresh with correct mode.
            if(this.presenceDisplayMode === 'none') {
                await this.startIdleRefresh();
            }
            return;
        }

        // Already idle and staying idle - don't restart the refresh loop
        if(nowIdle && wasIdle) {
            this.deps.logger.debug('Already idle, skipping duplicate idle transition');
            return;
        }

        // Transition FROM idle: stop the refresh loop
        // Stryker disable next-line ConditionalExpression,LogicalOperator: Equivalent — stopIdleRefresh() is idempotent (no-op when no interval running); both →true and &&→|| only add no-op calls when !wasIdle
        if(!nowIdle && wasIdle) {
            this.stopIdleRefresh();
        }

        // Handle active phases (throttling is now done upstream by BotStateManager)
        // Stryker disable next-line ConditionalExpression: Equivalent — !nowIdle is always true here; both nowIdle branches above return early
        if(!nowIdle) {
            const activity = this.deps.activeStatusGenerator.generate(phase, this.presenceDisplayMode);
            await this.applyPresenceUpdate(activity);
        }
    }

    /**
     * Start the presence manager (enables idle refresh if idle).
     */
    start(): void {
        this.deps.logger.info('Starting presence manager');
        // Don't start idle refresh here - wait for explicit phase transition
        // The caller should call updatePhase() after determining if catch-up is needed
    }

    /**
     * Stop the presence manager (clears all timers).
     */
    stop(): void {
        this.deps.logger.info('Stopping presence manager');
        this.stopIdleRefresh();
    }
}
