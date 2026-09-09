/**
 * Presence Manager
 *
 * Coordinates Discord presence updates and idle status refresh loops.
 * Throttling for conductor-mode ledger composition is handled upstream by
 * `presence-setup.ts`'s `setupConductorPresence`; this manager adds only one
 * filter of its own — an identical-activity dedupe (see `lastAppliedActivity`).
 *
 * Update behavior:
 * - Active phases (thinking, responding, using_tool) are applied immediately, but an activity
 *   identical (name AND type) to the last one Discord accepted is dropped rather than re-sent
 * - Idle transitions are applied immediately - they mark end of work
 * - Idle refresh loop runs independently on its own schedule, and is EXEMPT from the dedupe:
 *   it doubles as a presence keep-alive, since Discord clears a bot's activity on a fresh
 *   IDENTIFY (not RESUME) and nothing else re-applies presence after a reconnect. The idle
 *   line is usually identical tick to tick, so deduping it would silence the keep-alive
 *   entirely and leave the bot showing no status until the next active phase.
 */

import type { Client as DiscordClient, ActivitiesOptions } from 'discord.js';
import { DateTime } from 'luxon';
import { renderPresenceText, type PresenceView } from './presence-view.js';
import type { ActiveStatusGenerator } from './status-generator-active.js';
import type { IdleStatusGenerator } from './status-generator-idle.js';
import type { PresenceConfig, PresencePhase, PresenceDisplayMode } from './types.js';
import { withDiscordRetry } from '@/integrations/discord/retry';

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
    /**
     * Q3/B4: optional recompose hook consulted on every idle refresh (the periodic timer AND the
     * immediate refresh `applyView` triggers), not only when a fresh view arrives via `applyView`.
     * Part of the composed prefix (e.g. the `⏸ perch` cost-ceiling marker) can change from wall-
     * clock time alone — the ceiling clears at local midnight with no ledger event — so without
     * this, the idle refresh loop would keep rendering whatever prefix was cached at the last
     * `applyView` call until the next ledger-driven one, which may never come while idle. Omitted
     * (the legacy `setupPresence` bridge, which never composes a `PresenceView` at all) leaves the
     * cached prefix behaviour unchanged.
     */
    recomposeIdlePrefix?:  () => { prefix: string, compacting: boolean }
    /** Logger instance */
    logger: {
        debug: (message: unknown, ...args: unknown[]) => void
        info:  (message: unknown, ...args: unknown[]) => void
        error: (message: unknown, ...args: unknown[]) => void
    }
}

/**
 * Presence manager coordinating Discord presence updates.
 *
 * The manager coordinates all presence updates with:
 * - Immediate updates for all phases (conductor-mode throttling handled upstream by presence-setup.ts)
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
    /** The idle generation currently in flight, keyed by the composed prefix it was started for, so concurrent refreshes for the same prefix share one Haiku call (see refreshIdleStatus). */
    private inFlightIdleRefresh: { prefix: string | null, promise: Promise<void> } | null = null;
    private presenceDisplayMode: PresenceDisplayMode = 'none'; // Track presence display mode for status prefixes
    // P11: set only by applyView(), never by the oneshot updatePhase/transitionPresenceDisplayMode paths.
    // Non-null means the idle refresh loop should render via the composed prefix, not the legacy '💤 ' default.
    private composedPrefix:      string | null = null;
    private composedCompacting = false;
    /**
     * The last activity Discord actually accepted (name + type), used to drop an update that
     * would change nothing — the composition upstream can legitimately produce the same text
     * twice (a digest bypass followed by the next ledger tick), and re-sending it spends a
     * Discord API call to repaint the identical status. Deliberately NOT set when the apply
     * failed, nor when there was no `client.user` to call `setActivity` on, so a retry of the
     * same activity still goes out.
     */
    private lastAppliedActivity: { name: string, type: ActivitiesOptions['type'] } | null = null;

    constructor(private readonly deps: PresenceManagerDeps) {}

    /**
     * Update Discord presence, unless the activity is identical (name AND type) to the last one
     * Discord accepted. The idle refresh loop deliberately does NOT come through here — see
     * {@link forcePresenceUpdate}.
     */
    private async applyPresenceUpdate(activity: ActivitiesOptions): Promise<void> {
        if(this.lastAppliedActivity?.name === activity.name && this.lastAppliedActivity.type === activity.type) {
            this.deps.logger.debug({ activity }, 'Presence unchanged, skipping update');
            return;
        }

        await this.forcePresenceUpdate(activity);
    }

    /**
     * Actually update Discord presence, with no dedupe: used by the idle refresh loop, whose
     * periodic re-push is also the presence keep-alive after a gateway IDENTIFY clears the bot's
     * activity. The idle line is usually word-for-word the same tick to tick, so it would be
     * deduped away — leaving Discord showing nothing at all — if it went through
     * {@link applyPresenceUpdate}. Still records `lastAppliedActivity`, so a following non-idle
     * apply of the same text is deduped normally.
     */
    private async forcePresenceUpdate(activity: ActivitiesOptions): Promise<void> {
        try {
            // `client.user` is null until the gateway READY frame lands; an apply in that window
            // reaches nobody, so it must not be recorded as applied (which would dedupe away the
            // first real apply afterwards). The operation reports whether it actually called
            // setActivity.
            // Use low retry count for presence updates (not critical)
            const sent = await withDiscordRetry(
                () => {
                    const user = this.deps.discordClient.user;
                    if(!user) {
                        return Promise.resolve(false);
                    }
                    user.setActivity(activity);
                    return Promise.resolve(true);
                },
                // Stryker disable next-line ObjectLiteral: Retry policy already tested in retry module
                { policy: { maxAttempts: 2 } }
            );
            // Only an apply that actually reached Discord is remembered — see lastAppliedActivity.
            if(sent) {
                this.lastAppliedActivity = { name: activity.name, type: activity.type };
                this.deps.logger.info({ activity }, 'Updated Discord presence');
            }
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

        // Q3/B4: recompose the cached prefix/compacting fresh on every refresh (not only when a
        // new view arrives via applyView) so a wall-clock-driven change — the cost-ceiling marker
        // clearing at local midnight, with no ledger event to trigger a fresh applyView — is
        // picked up by the very next periodic tick instead of lingering indefinitely.
        const recomposed = this.deps.recomposeIdlePrefix?.();
        if(recomposed) {
            this.composedPrefix = recomposed.prefix;
            this.composedCompacting = recomposed.compacting;
        }

        // Capture current mode/prefix at start to detect stale results
        const modeAtStart = this.presenceDisplayMode;
        const prefixAtStart = this.composedPrefix;

        // Coalesce concurrent refreshes for the SAME prefix: at boot both sessions go idle a few
        // hundred ms apart, and each idle view calls in here while the first Haiku generation is
        // still in flight — a second generation for an identical prefix would only produce a
        // second, redundant Haiku call and presence update. A DIFFERENT prefix still starts its
        // own generation (the in-flight one then discards itself as stale below).
        if(this.inFlightIdleRefresh !== null && this.inFlightIdleRefresh.prefix === prefixAtStart) {
            return this.inFlightIdleRefresh.promise;
        }
        const promise = this.generateAndApplyIdle(modeAtStart, prefixAtStart).finally(() => {
            if(this.inFlightIdleRefresh?.promise === promise) {
                this.inFlightIdleRefresh = null;
            }
        });
        this.inFlightIdleRefresh = { prefix: prefixAtStart, promise };
        return promise;
    }

    /** The generate-then-apply half of {@link refreshIdleStatus}, split out so the in-flight coalescing above can hold its promise. */
    private async generateAndApplyIdle(modeAtStart: PresenceDisplayMode, prefixAtStart: string | null): Promise<void> {
        // P11: once applyView() has composed a prefix, every idle refresh renders through it
        // instead of the legacy bare '💤 ' default.
        const activity = prefixAtStart === null
            ? await this.deps.idleStatusGenerator.generate()
            : await this.deps.idleStatusGenerator.generate({ prefix: prefixAtStart, compacting: this.composedCompacting });

        // Either path: the session went busy while Haiku was writing an idle line (a follow-up
        // message interrupting a turn goes idle for a few hundred ms before the next turn opens) —
        // applying it now would paint "💤" over an active status.
        if(this.currentPhase?.type !== 'idle') {
            this.deps.logger.debug({ currentPhase: this.currentPhase?.type }, 'Discarding stale idle status (no longer idle)');
            return;
        }

        if(prefixAtStart === null) {
            // Legacy path: check if display mode changed while generating - if so, discard stale result
            if(this.presenceDisplayMode !== modeAtStart) {
                this.deps.logger.debug({ modeAtStart, currentMode: this.presenceDisplayMode }, 'Discarding stale idle status (mode changed during generation)');
                return;
            }
        } else if(this.composedPrefix !== prefixAtStart) {
            // P11 path: check if the composed prefix changed while generating - if so, discard stale result
            this.deps.logger.debug({ prefixAtStart, currentPrefix: this.composedPrefix }, 'Discarding stale idle status (composed prefix changed during generation)');
            return;
        }

        // Forced, not deduped: this periodic re-push is the presence keep-alive (see
        // forcePresenceUpdate) and the idle line is usually identical tick to tick.
        await this.forcePresenceUpdate(activity);
    }

    /**
     * Applies a composed {@link PresenceView} (P11 conductor-mode presence): idle views store the
     * composed prefix and either start the idle refresh loop (first idle) or, when it is already
     * running, refresh immediately with the new prefix — an idle-to-idle prefix change (a
     * background task starting/finishing while otherwise idle) must reach Discord right away, not
     * lag by up to `idleRefreshIntervalMs`; the loop itself is never restarted, so the periodic
     * cadence is unaffected. Non-idle views stop the idle refresh loop and apply
     * `renderPresenceText(view, digest)`, where `digest` is
     * `activeStatusGenerator.generate(view.phase).name` — no display mode, so no emoji prefix.
     */
    async applyView(view: PresenceView): Promise<void> {
        this.currentPhase = view.phase;

        if(view.phase.type === 'idle') {
            this.composedPrefix = view.prefix;
            this.composedCompacting = view.compacting;
            await (this.idleRefreshInterval ? this.refreshIdleStatus() : this.startIdleRefresh());
            return;
        }

        this.stopIdleRefresh();
        const generated = this.deps.activeStatusGenerator.generate(view.phase);
        const text = renderPresenceText(view, generated.name);
        await this.applyPresenceUpdate({ name: text, type: generated.type });
    }

    /**
     * Start periodic idle status refresh.
     * Returns a promise that resolves after the first refresh completes.
     */
    private async startIdleRefresh(): Promise<void> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: belt-and-braces guard — every caller (applyView, updatePhase, transitionPresenceDisplayMode) already branches on idleRefreshInterval before calling in, so no test can reach this with the interval set
        if(this.idleRefreshInterval) {
            return; // Already running
        }

        // The periodic loop is registered SYNCHRONOUSLY, before the first (awaited) generation:
        // registering it only after that await let a second caller arriving mid-generation (the
        // second session going idle at boot) see a still-null interval and start a second loop —
        // two Haiku idle refreshes every interval for the life of the process. Any caller that
        // now sees the interval set goes through refreshIdleStatus() instead, which coalesces
        // onto the generation already in flight.
        this.idleRefreshInterval = setInterval(() => {
            void this.refreshIdleStatus();
        }, this.deps.config.idleRefreshIntervalMs);
        this.deps.logger.debug({ intervalMs: this.deps.config.idleRefreshIntervalMs }, 'Started idle status refresh');

        // Generate immediately and wait for it
        await this.refreshIdleStatus();
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
     * Transition to a new presence display mode, managing status updates and idle refresh
     * lifecycle.
     *
     * P14: conductor-mode presence flows exclusively through {@link applyView}, which never sets
     * `presenceDisplayMode` — so no production code calls this method today, and
     * `getPresencePrefix`'s 💬/🦉 prefixes (in `status-generator-active.ts`) never fire on this
     * path in practice. Kept as public API (with its own test coverage) for a future non-`applyView`
     * caller rather than deleted with the last one that used it.
     *
     * @param mode - Presence display mode state
     */
    transitionPresenceDisplayMode(mode: PresenceDisplayMode): void {
        // Stryker disable next-line StringLiteral,ObjectLiteral: Log message content is not behavior-affecting
        this.deps.logger.debug({ mode, previousMode: this.presenceDisplayMode }, 'Setting presence display mode');
        this.presenceDisplayMode = mode;

        // Stryker disable next-line ConditionalExpression: stopIdleRefresh() is idempotent — →true equivalent (adds harmless no-op when mode=none)
        if(mode !== 'none') {
            this.stopIdleRefresh();
        }

        // For active phases, update immediately with the new mode prefix. Skip when
        // transitioning to 'none' (idle) — the subsequent updatePhase(idle) handles it — and
        // skip when there is no current phase at all (nothing to re-render with a prefix).
        if(this.currentPhase && this.currentPhase.type !== 'idle' && mode !== 'none') {
            const activity = this.deps.activeStatusGenerator.generate(this.currentPhase, mode);
            void this.applyPresenceUpdate(activity);
        }
    }

    /**
     * Update presence based on current phase.
     * Applies updates immediately (conductor-mode throttling handled upstream by presence-setup.ts).
     *
     * P14: no production caller today — conductor-mode presence flows exclusively through
     * {@link applyView}, which folds this method's idle-refresh-lifecycle logic in directly
     * (plus the composed-prefix handling `updatePhase` doesn't do). Kept as public API, with its
     * own extensive test coverage of the idle refresh loop, for a caller outside the conductor
     * composition (e.g. a bare phase-only presence source) rather than deleted with the last one.
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
            // Stryker disable next-line ConditionalExpression,EqualityOperator: display mode guard — mutating causes test timeout (idle refresh starts when display mode active)
            if(this.presenceDisplayMode === 'none') {
                await this.startIdleRefresh();
            }
            return;
        }

        // Already idle and staying idle - don't restart the refresh loop
        if(nowIdle && wasIdle) {
            // Stryker disable next-line StringLiteral: log message — string mutation causes test timeout (presence state machine observes this log)
            this.deps.logger.debug('Already idle, skipping duplicate idle transition');
            return;
        }

        // Transition FROM idle: stop the refresh loop
        // Stryker disable next-line ConditionalExpression,LogicalOperator: Equivalent — stopIdleRefresh() is idempotent (no-op when no interval running); both →true and &&→|| only add no-op calls when !wasIdle
        if(!nowIdle && wasIdle) {
            this.stopIdleRefresh();
        }

        // Handle active phases (conductor-mode throttling is done upstream by presence-setup.ts)
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
