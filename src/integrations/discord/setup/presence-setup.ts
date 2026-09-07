import { logger } from '@hughescr/logger';
import { ActivityType, type Client  } from 'discord.js';
import type { InboxManager } from '../inbox';
import {
    composePresence,
    createActiveStatusGenerator,
    type createDynamicStatusGenerator,
    createIdleStatusGenerator,
    planPresenceUpdate,
    PresenceManager,
    type PresenceThrottle,
    type PresenceView
} from '../presence';
import type { BotStateManager, StateChange } from '../state';
import { IdentityCache, type ContextBuilder, type LedgerStore, type Signal } from '@/agent';
import type { DiscordConfig } from '@/config';

/**
 * Result of setting up presence management.
 */
export interface PresenceSetupResult {
    /** Presence manager for Discord status updates */
    presenceManager:           PresenceManager
    /** Unsubscribe function for mode transition subscription */
    unsubscribeModeTransition: () => void
    /** Unsubscribe function for activity phase subscription */
    unsubscribeActivityPhase:  () => void
}

/**
 * Sets up Discord presence management with status generators and state manager integration.
 *
 * Creates the presence manager with active, idle, and dynamic status generators.
 * Sets up bidirectional integration with bot state manager:
 * - Mode transitions sync to presence display modes
 * - Activity phase changes update Discord status
 *
 * @param params - Configuration for presence setup
 * @returns Presence setup result with manager and unsubscribe functions, or undefined if presence config not provided
 */
export function setupPresence(params: {
    identityContext:         string
    presenceConfig:          NonNullable<DiscordConfig['presence']>
    readyClient:             Client
    botStateManager:         BotStateManager
    dynamicStatusGenerator:  ReturnType<typeof createDynamicStatusGenerator> | undefined
    inboxManager:            InboxManager | undefined
    getTaskContext?:         () => Promise<string | undefined>
    getRecentContext:        () => Promise<string | undefined>
    contextBuilder?:         ContextBuilder
    getLastThinkingContent?: () => string | undefined
    /** Pre-built write-through identity cache. When provided, replaces the inline loader. */
    identityCache?:          IdentityCache
    /** Optional live-signals snapshot callback. Step 3 will consume this. */
    getLiveSignals?:         () => Promise<Signal[]>
    /** Getter for the last idle status text (anti-rut, Step 3). */
    getPreviousStatus?:      () => string | undefined
    /** Setter for persisting the last idle status text (anti-rut, Step 3). */
    setPreviousStatus?:      (text: string) => void
}): PresenceSetupResult {
    const {
        identityContext,
        presenceConfig,
        readyClient,
        botStateManager,
        dynamicStatusGenerator,
        inboxManager,
        getTaskContext,
        getRecentContext,
        contextBuilder,
        getLastThinkingContent,
        identityCache: providedIdentityCache,
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
    } = params;

    const activeStatusGenerator = createActiveStatusGenerator({
        activityType: ActivityType.Custom,
        logger,
    });

    // Use the provided write-through identity cache, or create a local one.
    // The loader falls back to the static identityContext string when contextBuilder
    // is not available (e.g. in tests or minimal setups).
    const identityCache = providedIdentityCache ?? new IdentityCache(
        // Stryker disable next-line ConditionalExpression: loader fallback — contextBuilder absent path is a valid production configuration
        contextBuilder ? () => contextBuilder.loadCoreIdentity() : () => Promise.resolve(identityContext)
    );

    const idleStatusGenerator = createIdleStatusGenerator({
        logger,
        activityType:    ActivityType.Custom,
        identityContext: () => identityCache.get(),
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
        getTaskContext,
        getRecentContext,
        getLastThinkingContent,
    });

    const presenceManager = new PresenceManager({
        discordClient: readyClient,
        config:        presenceConfig,
        activeStatusGenerator,
        idleStatusGenerator,
        dynamicStatusGenerator,
        logger,
    });

    presenceManager.start();

    // Stryker disable all: Integration callbacks syncing state between components - tested via bot integration tests
    // Bridge: Sync BotStateManager → PresenceManager
    const unsubscribeModeTransition = botStateManager.subscribe((change: StateChange) => {
        // Sync mode changes to presence manager
        if(change.changeType === 'mode_transition') {
            const mode = change.newState.mode;

            // Map BotState mode to PresenceDisplayMode for presence
            switch(mode) {
                case 'idle': {
                    presenceManager.transitionPresenceDisplayMode('none');
                    // Explicitly transition presence to idle phase
                    void presenceManager.updatePhase({ type: 'idle', since: new Date() });

                    break;
                }
                case 'catching_up': {
                    presenceManager.transitionPresenceDisplayMode('catching_up');

                    break;
                }
                case 'processing_message': {
                    presenceManager.transitionPresenceDisplayMode('processing_message');

                    break;
                }
                case 'perching': {
                    presenceManager.transitionPresenceDisplayMode('perching');

                    break;
                }
            // No default
            }
        }
    });

    // Bridge: Sync activity phases to presence manager
    const unsubscribeActivityPhase = botStateManager.subscribe((change: StateChange) => {
        if(change.changeType === 'activity_phase') {
            const phase = change.newState.activityPhase;
            if(phase) {
                // Throttle active phase updates to avoid Discord rate limits
                if(botStateManager.shouldUpdatePresence()) {
                    void presenceManager.updatePhase(phase);
                    botStateManager.recordPresenceUpdate();
                }
            } else {
                // Idle transitions intentionally bypass throttling:
                // - End of work should show immediately to users
                // - Prevents "stuck" active status after processing completes
                // - Idle is a stable state, not a rapid-fire event
                if(change.newState.mode === 'idle') {
                    void presenceManager.updatePhase({ type: 'idle', since: new Date() });
                    botStateManager.recordPresenceUpdate();
                }
            }
        }
    });

    // If no inbox manager, transition to idle immediately
    // (otherwise, idle transition happens after catch-up check in inbox init)
    if(!inboxManager) {
        void presenceManager.updatePhase({ type: 'idle', since: new Date() });
    }

    return {
        presenceManager,
        unsubscribeModeTransition,
        unsubscribeActivityPhase,
    };
}
// Stryker restore all

/** `${activeRole}:${phaseType}` for a non-idle {@link PresenceView}, `null` for idle. */
function phaseSignature(view: PresenceView): string | null {
    // Stryker disable next-line StringLiteral: equivalent mutant — composePresence's own invariant
    // (presence-view.ts's resolveActiveRole) guarantees `activeRole` is non-null whenever
    // `phase.type !== 'idle'` (the only branch that evaluates this expression, per the guard
    // above), so the `?? ''` fallback's literal value can never be observed: every `view` this
    // function is ever called with (always `composePresence`'s own return value, from `tick()`)
    // makes this branch dead. Kept only as a type-level defensive default against `PresenceView`'s
    // own type, which does not itself encode that correlation.
    return view.phase.type === 'idle' ? null : `${view.activeRole ?? ''}:${view.phase.type}`;
}

/** `true` when the view's phase carries a ledger-overlaid synopsis (`compacting` has none). */
function digestOf(view: PresenceView): string | undefined {
    return 'generatedStatus' in view.phase ? view.phase.generatedStatus : undefined;
}

/** Result of {@link setupConductorPresence}. */
export interface ConductorPresenceSetupResult {
    /** Presence manager for Discord status updates. */
    presenceManager:    PresenceManager
    /** Stops mirroring every ledger in `ledgers` into `presenceManager`. */
    unsubscribeLedgers: () => void
}

/**
 * Sets up Discord presence for conductor mode (P9 `config.session.mode === 'conductor'`):
 * composes presence from the session ledgers (design doc section 8) instead of bridging
 * `BotStateManager`. Deliberately does none of what `setupPresence`'s bridge (:110-181, untouched
 * — see this file's module-level doc discipline) does: no `botStateManager.subscribe`, no
 * `transitionPresenceDisplayMode` call, and no explicit idle bootstrap — the very first
 * synchronous compose (before any ledger has emitted an event) already renders `💤`, because every
 * ledger starts with no open turn.
 *
 * The composition/throttle DECISION lives entirely in `presence-view.ts`'s pure
 * `composePresence`/`planPresenceUpdate` (already measured at 100% mutation coverage on their
 * own); this function's own body is just the plumbing that calls them and applies the result.
 * @param params Construction inputs mirroring `setupPresence`'s (status generators, identity
 * cache, live-signals/task-context callbacks), plus the ledgers to compose from and the shared
 * `PresenceThrottle` instance.
 * @returns See {@link ConductorPresenceSetupResult}.
 */
export function setupConductorPresence(params: {
    identityContext:         string
    presenceConfig:          NonNullable<DiscordConfig['presence']>
    readyClient:             Client
    /** The session ledgers to compose from — conventionally `[conversationLedger, perchLedger]` (P12: perch's own real conductor ledger, when present; design doc section 8: conversation wins when both are live). */
    ledgers:                 readonly LedgerStore[]
    /** The one process-wide throttle shared with the ledger-sink stream handler (P11). */
    throttle:                PresenceThrottle
    dynamicStatusGenerator:  ReturnType<typeof createDynamicStatusGenerator> | undefined
    getTaskContext?:         () => Promise<string | undefined>
    getRecentContext:        () => Promise<string | undefined>
    contextBuilder?:         ContextBuilder
    getLastThinkingContent?: () => string | undefined
    /** Pre-built write-through identity cache. When provided, replaces the inline loader. */
    identityCache?:          IdentityCache
    /** Optional live-signals snapshot callback. */
    getLiveSignals?:         () => Promise<Signal[]>
    /** Getter for the last idle status text (anti-rut). */
    getPreviousStatus?:      () => string | undefined
    /** Setter for persisting the last idle status text (anti-rut). */
    setPreviousStatus?:      (text: string) => void
    /**
     * The still-legacy `BotStateManager` — used ONLY to call `recordPresenceUpdate()` on every
     * applied update, never `subscribe`d to. P12 gives perch its own real conductor, but a
     * rejected (or omitted) `perchConductor.open()` still falls back to the legacy
     * `PerchSessionRunner`/scheduler (`perch-setup.ts`'s `setupPerchSessionRunnerAndScheduler`),
     * whose own stream handler (`createPresenceStreamHandler`) still gates its Haiku calls on
     * `botStateManager.shouldUpdatePresence()` — a throttle whose clock the removed oneshot
     * bridge used to advance on every activity update. Omitted, that fallback runner's synopsis
     * generation goes unthrottled (P11 review finding).
     */
    botStateManager?:        Pick<BotStateManager, 'recordPresenceUpdate'>
    /**
     * Optional Q3/B4 daily cost ceiling predicate: `tick()` re-reads it on every compose (never
     * cached), so a pause taken or cleared mid-run is reflected on the very next ledger event —
     * rendered as a `⏸ perch` marker in the composed prefix (see `composePresence`'s own doc).
     */
    isCostPaused?:           () => boolean
}): ConductorPresenceSetupResult {
    const {
        identityContext,
        presenceConfig,
        readyClient,
        ledgers,
        throttle,
        dynamicStatusGenerator,
        getTaskContext,
        getRecentContext,
        contextBuilder,
        getLastThinkingContent,
        identityCache: providedIdentityCache,
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
        botStateManager,
        isCostPaused,
    } = params;

    const activeStatusGenerator = createActiveStatusGenerator({
        activityType: ActivityType.Custom,
        logger,
    });

    const identityCache = providedIdentityCache ?? new IdentityCache(
        contextBuilder ? () => contextBuilder.loadCoreIdentity() : () => Promise.resolve(identityContext)
    );

    const idleStatusGenerator = createIdleStatusGenerator({
        logger,
        activityType:    ActivityType.Custom,
        identityContext: () => identityCache.get(),
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
        getTaskContext,
        getRecentContext,
        getLastThinkingContent,
    });

    const presenceManager = new PresenceManager({
        discordClient:       readyClient,
        config:              presenceConfig,
        activeStatusGenerator,
        idleStatusGenerator,
        dynamicStatusGenerator,
        logger,
        // Q3/B4: recompose fresh on every idle refresh tick (the periodic timer, not only a
        // ledger-driven applyView) so the `⏸ perch` marker clearing at local midnight — a
        // wall-clock event with no ledger notification behind it — is visible on the very next
        // tick instead of lingering on whatever prefix was last composed by a ledger event.
        recomposeIdlePrefix: () => {
            const view = composePresence(ledgers.map(store => store.get()), isCostPaused?.() ?? false);
            return { prefix: view.prefix, compacting: view.compacting };
        },
    });

    presenceManager.start();

    // P11 fix: the ledger-sink stream handler (stream-event-handler.ts) peeks `throttle` to decide
    // whether generating a synopsis is worth it, then dispatches `phase_synopsis` once it resolves
    // (design doc section 8) — but that generation is an LLM call, so it can never resolve within
    // the same synchronous tick as the sdk_frame that started it. Left to `planPresenceUpdate`
    // alone, whichever tick happens to apply first (the digest-less base phase, or an even earlier
    // phase still holding the window) consumes the whole 12s window, and the digest — once it
    // finally resolves — is then either a whole window late or dropped outright for a turn shorter
    // than the window (see the P11 review finding this fixes). `lastSeenSignature`/
    // `lastSeenDigest` remember the (role, phaseType) and digest text of the most recently
    // COMPOSED non-idle view — whether or not it was actually applied — reset at every idle view
    // (a turn boundary). A tick where that exact phase's digest text CHANGES (absent -> present,
    // or one digest -> a fresher one) is a REFINEMENT of whatever is already on screen for it (or
    // would have been, throttle permitting), not a new presence-worthy event: apply it directly,
    // bypassing the throttle, so the window a placeholder already spent (or is still holding)
    // doesn't also swallow the synopsis it was generated for. Digests are already rate-limited at
    // generation time (the stream handler starts one only while the throttle window is open), so
    // this cannot flood Discord. A digest the ledger merely CARRIED across a phase flip (same text,
    // new signature) is not a change and takes the ordinary throttled path.
    let lastSeenSignature: string | null = null;
    let lastSeenDigest: string | undefined;

    /** Applies `view` and, if a legacy `botStateManager` was provided, keeps its own throttle clock in sync (see the param's doc). */
    function apply(view: PresenceView): void {
        void presenceManager.applyView(view);
        botStateManager?.recordPresenceUpdate();
    }

    /** Composes the current view from every ledger and applies it, if `planPresenceUpdate` says to. */
    function tick(): void {
        const view = composePresence(ledgers.map(store => store.get()), isCostPaused?.() ?? false);
        const signature = phaseSignature(view);
        const digest = digestOf(view);
        const digestJustArrived = signature !== null && signature === lastSeenSignature && digest !== undefined && digest !== lastSeenDigest;

        lastSeenSignature = signature;
        lastSeenDigest = digest;

        if(digestJustArrived) {
            apply(view);
            return;
        }

        if(planPresenceUpdate(view, throttle) !== null) {
            apply(view);
        }
    }

    const unsubscribes = ledgers.map(store => store.subscribe(tick));
    tick();

    return {
        presenceManager,
        unsubscribeLedgers: (): void => {
            for(const unsubscribe of unsubscribes) {
                unsubscribe();
            }
        },
    };
}
