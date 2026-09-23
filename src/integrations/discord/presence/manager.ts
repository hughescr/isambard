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
import { renderPresenceText, type PresenceView } from './presence-view.js';
import type { ActiveStatusGenerator } from './status-generator-active.js';
import type { IdleStatusGenerator } from './status-generator-idle.js';
import type { PresenceConfig } from './types.js';
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
     * Part of the composed prefix (e.g. the `⏸ perch` pause marker) can change from wall-clock
     * time alone: the daily cost ceiling clears at local midnight, and a quota-window pause clears
     * when its window rolls over, neither with a ledger event. Without this, the idle refresh loop
     * would keep rendering whatever prefix was cached at the last `applyView` call until the next
     * ledger-driven one, which may never come while idle. When omitted, the refresh loop keeps
     * rendering the prefix and compacting marker of the last idle view passed to `applyView`.
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
 * - Views composed from the session ledgers as its only input: an idle view starts (or
 *   refreshes) the idle loop, a non-idle view stops it and applies the rendered active text
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
 * await manager.applyView(composePresence([conversationLedger, perchLedger]));
 * // A live turn: applies renderPresenceText(view, digest) immediately (throttling handled upstream)
 *
 * await manager.applyView(composePresence([conversationLedger, perchLedger]));
 * // Neither session live: an idle view, which starts the idle refresh loop
 *
 * manager.stop();
 * // Cleans up all timers
 * ```
 */
export class PresenceManager {
    /**
     * The last view {@link applyView} applied (`null` until the first one). While it is idle,
     * every idle refresh replaces it with a copy carrying the `recomposeIdlePrefix` result, so the
     * refresh loop and its stale-result checks always read the current composed prefix.
     */
    private currentView:         PresenceView | null = null;
    private idleRefreshInterval: NodeJS.Timeout | null = null;
    /** The idle generation currently in flight, keyed by the composed prefix it was started for, so concurrent refreshes for the same prefix share one Haiku call (see refreshIdleStatus). */
    private inFlightIdleRefresh: { prefix: string, promise: Promise<void> } | null = null;
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
     * The interval callback may already be queued when a non-idle view clears its timer, so
     * check the current view before starting another idle generation.
     */
    private async refreshIdleStatus(): Promise<void> {
        if(this.currentView?.phase.type !== 'idle') {
            return; // No longer idle
        }

        // Q3/B4: recompose the prefix/compacting fresh on every refresh (not only when a new view
        // arrives via applyView) so a wall-clock-driven pause change — the daily cost ceiling
        // clearing at local midnight or a quota window rolling over, neither with a fresh
        // applyView — is picked up by the very next periodic tick instead of lingering indefinitely.
        const recomposed = this.deps.recomposeIdlePrefix?.();
        if(recomposed) {
            this.currentView = { ...this.currentView, prefix: recomposed.prefix, compacting: recomposed.compacting };
        }

        // Capture the composed prefix at start to detect stale results
        const idleAtStart = { prefix: this.currentView.prefix, compacting: this.currentView.compacting };

        // Coalesce concurrent refreshes for the SAME prefix: at boot both sessions go idle a few
        // hundred ms apart, and each idle view calls in here while the first Haiku generation is
        // still in flight — a second generation for an identical prefix would only produce a
        // second, redundant Haiku call and presence update. A DIFFERENT prefix still starts its
        // own generation (the in-flight one then discards itself as stale below).
        if(this.inFlightIdleRefresh?.prefix === idleAtStart.prefix) {
            return this.inFlightIdleRefresh.promise;
        }
        const promise = this.generateAndApplyIdle(idleAtStart).finally(() => {
            if(this.inFlightIdleRefresh?.promise === promise) {
                this.inFlightIdleRefresh = null;
            }
        });
        this.inFlightIdleRefresh = { prefix: idleAtStart.prefix, promise };
        return promise;
    }

    /** The generate-then-apply half of {@link refreshIdleStatus}, split out so the in-flight coalescing above can hold its promise. */
    private async generateAndApplyIdle(idleAtStart: { prefix: string, compacting: boolean }): Promise<void> {
        // A fresh options object, so a generator that mutates its input cannot corrupt the
        // captured prefix the stale check below compares against.
        const activity = await this.deps.idleStatusGenerator.generate({
            prefix: idleAtStart.prefix, compacting: idleAtStart.compacting,
        });

        // The session went busy while Haiku was writing an idle line (a follow-up message
        // interrupting a turn goes idle for a few hundred ms before the next turn opens) —
        // applying it now would paint "💤" over an active status.
        // Stryker disable next-line llm: equivalent — currentView is a PresenceView or null, so !this.currentView || … yields the same boolean as currentView?.phase.type !== 'idle' for every reachable value (null gives undefined !== 'idle' → true either way)
        if(this.currentView?.phase.type !== 'idle') {
            this.deps.logger.debug({ currentPhase: this.currentView?.phase.type }, 'Discarding stale idle status (no longer idle)');
            return;
        }

        // The composed prefix changed while generating - discard the stale result
        if(this.currentView.prefix !== idleAtStart.prefix) {
            this.deps.logger.debug({ prefixAtStart: idleAtStart.prefix, currentPrefix: this.currentView.prefix }, 'Discarding stale idle status (composed prefix changed during generation)');
            return;
        }

        // Forced, not deduped: this periodic re-push is the presence keep-alive (see
        // forcePresenceUpdate) and the idle line is usually identical tick to tick.
        await this.forcePresenceUpdate(activity);
    }

    /**
     * Applies a composed {@link PresenceView} (P11 conductor-mode presence): idle views record the
     * view and either start the idle refresh loop (first idle) or, when it is already running,
     * refresh immediately with the new prefix — an idle-to-idle prefix change (a background task
     * starting/finishing while otherwise idle) must reach Discord right away, not lag by up to
     * `idleRefreshIntervalMs`; the loop itself is never restarted, so the periodic cadence is
     * unaffected. Non-idle views stop the idle refresh loop and apply
     * `renderPresenceText(view, digest)`, where `digest` is the winning turn's synopsis
     * (`view.synopsis`) or, when it has none yet, `activeStatusGenerator.generate(view.phase).name`
     * — a static label. The activity type always comes from the active generator.
     */
    async applyView(view: PresenceView): Promise<void> {
        this.currentView = view;

        if(view.phase.type === 'idle') {
            await (this.idleRefreshInterval ? this.refreshIdleStatus() : this.startIdleRefresh());
            return;
        }

        this.stopIdleRefresh();
        // Stryker disable next-line llm: equivalent — currentView was just assigned this view and no intervening manager operation reassigns it, so view.phase and this.currentView.phase are the same object
        const generated = this.deps.activeStatusGenerator.generate(view.phase);
        const text = renderPresenceText(view, view.synopsis ?? generated.name);
        await this.applyPresenceUpdate({ name: text, type: generated.type });
    }

    /**
     * Start periodic idle status refresh.
     * Returns a promise that resolves after the first refresh completes.
     */
    private async startIdleRefresh(): Promise<void> {
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
     * Start the presence manager. Logs only: the idle refresh loop starts on the first idle
     * {@link applyView}, not here.
     */
    start(): void {
        this.deps.logger.info('Starting presence manager');
    }

    /**
     * Stop the presence manager (clears all timers).
     */
    stop(): void {
        this.deps.logger.info('Stopping presence manager');
        this.stopIdleRefresh();
    }
}
