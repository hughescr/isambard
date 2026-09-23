import { logger } from '@hughescr/logger';
import { ActivityType, type Client  } from 'discord.js';
import {
    composePresence,
    createActiveStatusGenerator,
    createIdleStatusGenerator,
    planPresenceUpdate,
    PresenceManager,
    type PresenceThrottle,
    type PresenceView
} from '../presence';
import { IdentityCache, type ContextBuilder, type LedgerStore, type Signal } from '@/agent';
import type { DiscordConfig } from '@/config';

/**
 * How long a freshly-idle composed view must persist before it is applied. A follow-up message
 * that interrupts a running turn ends that turn a few hundred ms before the next one opens; an
 * idle view applied in that gap paints "💤", consumes the presence throttle window the new turn's
 * own placeholder then needs, and starts a Haiku idle generation that is stale on arrival (first
 * conductor-mode soak, 2026-09-06). Going idle is never urgent enough to need the first 1.5 s.
 */
export const IDLE_SETTLE_MS = 1500;

/** Result of {@link setupConductorPresence}. */
export interface ConductorPresenceSetupResult {
    /** Presence manager for Discord status updates. */
    presenceManager:    PresenceManager
    /** Stops mirroring every session's ledger into `presenceManager`. */
    unsubscribeLedgers: () => void
}

/**
 * Sets up Discord presence for the long-lived conversation conductor: composes presence from
 * the session ledgers (design doc section 8) instead of bridging a state machine: no
 * `subscribe`, no display-mode transition call, and no explicit idle bootstrap — the very first
 * synchronous compose (before any ledger has emitted an event) already renders `💤`, because every
 * ledger starts with no open turn.
 *
 * The composition/throttle DECISION lives entirely in `presence-view.ts`'s pure
 * `composePresence`/`planPresenceUpdate` (already measured at 100% mutation coverage on their
 * own); this function's own body is just the plumbing that calls them and applies the result.
 *
 * It renders the turn synopsis (`PresenceView.synopsis`) but never produces one: the producer is
 * the session core's `attachTurnSynopsis`, wired per session by `src/app/sessions.ts`.
 * @param params Construction inputs (status generators, identity cache, live-signals/task-context
 * callbacks), plus the ledgers to compose from and the display `PresenceThrottle` instance.
 * @returns See {@link ConductorPresenceSetupResult}.
 */
export function setupConductorPresence(params: {
    identityContext:         string
    presenceConfig:          NonNullable<DiscordConfig['presence']>
    readyClient:             Client
    /**
     * The session ledgers to compose from — conventionally `[conversation, perch]` (P12: perch's
     * own real conductor ledger, when present; design doc section 8: conversation wins when both
     * are live).
     */
    ledgers:                 readonly LedgerStore[]
    /** The display rate limit only: turn synopsis generation has its own per-session `SynopsisBudget`. */
    throttle:                PresenceThrottle
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
     * Optional composed perch-pause predicate: `tick()` re-reads it on every compose (never
     * cached), so a pause taken or cleared mid-run is reflected on the very next ledger event —
     * rendered as a `⏸ perch` marker in the composed prefix (see `composePresence`'s own doc).
     */
    isPerchPaused?:          () => boolean
}): ConductorPresenceSetupResult {
    const {
        identityContext,
        presenceConfig,
        readyClient,
        ledgers,
        throttle,
        getTaskContext,
        getRecentContext,
        contextBuilder,
        getLastThinkingContent,
        identityCache: providedIdentityCache,
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
        isPerchPaused,
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
        logger,
        // Q3/B4: recompose fresh on every idle refresh tick (the periodic timer, not only a
        // ledger-driven applyView) so the `⏸ perch` marker clears when either pause cause resets:
        // the daily cost ceiling at local midnight or the quota window at its own rollover. These
        // wall-clock events have no ledger notification, so the very next tick must replace the
        // prefix last composed by a ledger event.
        recomposeIdlePrefix: () => {
            const view = composePresence(ledgers.map(store => store.get()), isPerchPaused?.() ?? false);
            return { prefix: view.prefix, compacting: view.compacting };
        },
    });

    presenceManager.start();

    // P11 fix, keyed on the turn since #39: the session core's turn synopsis producer dispatches
    // `turn_synopsis` once a Haiku generation resolves (design doc section 8) — an LLM call, so it
    // can never resolve within the same synchronous tick as the sdk_frame that started it. Left to
    // `planPresenceUpdate` alone, whichever tick happens to apply first (the synopsis-less static
    // label, or an earlier phase still holding the window) consumes the whole 12s window, and the
    // synopsis — once it finally resolves — is then either a whole window late or dropped outright
    // for a turn shorter than the window (see the P11 review finding this fixes).
    // `lastSeenSignature`/`lastSeenSynopsis` remember the (role, turnId) and synopsis text of the
    // most recently COMPOSED non-idle view — whether or not it was actually applied — reset at
    // every idle view. A tick where the SAME winning turn's synopsis CHANGES (absent -> present, or
    // one synopsis -> a fresher one) is a REFINEMENT of whatever is already on screen for it (or
    // would have been, throttle permitting), not a new presence-worthy event: apply it directly,
    // bypassing the throttle, so the window a placeholder already spent (or is still holding)
    // doesn't also swallow the synopsis it was generated for. A synopsis lives on the turn, so a
    // phase flip never changes it and always takes the ordinary throttled path; a synopsis from
    // the session that is NOT winning never reaches the view at all.
    //
    // The bypass is therefore the one deliberate exception to "at most one non-idle update per
    // throttle window". Its bound comes from the producer: each session's `SynopsisBudget` lets
    // at most one generation START per 12 s, and its generator's cancel-and-replace aborts any
    // call still in flight when the next starts, so one session's synopses ARRIVE at most twice in
    // any 12 s span (two consecutive arrivals can sit close together; the third is ≥ 12 s after
    // the first). A bypass also records the throttle, so the ordinary path stays held after it.
    let lastSeenSignature: string | null = null;
    let lastSeenSynopsis: string | undefined;

    /** Applies `view` via the presence manager. */
    function apply(view: PresenceView): void {
        void presenceManager.applyView(view);
    }

    let idleSettleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Fires {@link IDLE_SETTLE_MS} after a view first composed idle: applies the CURRENT view only if it is still idle. */
    function applyIdleIfStillIdle(): void {
        idleSettleTimer = null;
        const view = composePresence(ledgers.map(store => store.get()), isPerchPaused?.() ?? false);
        if(view.phase.type === 'idle' && planPresenceUpdate(view, throttle) !== null) {
            apply(view);
        }
    }

    /**
     * Composes the current view from every ledger and applies it, if `planPresenceUpdate` says
     * to. An idle view is held for {@link IDLE_SETTLE_MS} first (see that constant) unless
     * `settleIdle` is false — the one synchronous setup tick applies its idle view at once.
     */
    function tick(settleIdle = true): void {
        const view = composePresence(ledgers.map(store => store.get()), isPerchPaused?.() ?? false);

        if(view.phase.type === 'idle') {
            lastSeenSignature = null;
            lastSeenSynopsis = undefined;
            if(settleIdle) {
                idleSettleTimer ??= setTimeout(applyIdleIfStillIdle, IDLE_SETTLE_MS);
            } else {
                planPresenceUpdate(view, throttle);
                apply(view);
            }
            return;
        }
        if(idleSettleTimer !== null) {
            clearTimeout(idleSettleTimer);
            idleSettleTimer = null;
        }
        // Keyed on the winning turn, not its phase: a new turn (even straight after another, with
        // no idle view in between) starts a new signature, so its first synopsis-less view is not
        // mistaken for a refinement of the previous turn's.
        const signature = `${view.activeRole}:${view.turnId}`;
        const synopsisJustArrived = signature === lastSeenSignature && view.synopsis !== lastSeenSynopsis;

        lastSeenSignature = signature;
        lastSeenSynopsis = view.synopsis;

        if(synopsisJustArrived) {
            // Record as well as apply: what went out IS now what Discord shows, so the ticks that
            // follow (the same turn re-composed by the next sdk_frame, carrying the same synopsis)
            // must be held by a fresh window rather than sailing through planPresenceUpdate and
            // re-sending identical text — two "Updated Discord presence" lines 1 ms apart in the
            // 2026-09-08 production log. The bypass's own intent is unchanged: a fresh synopsis
            // still never waits for the window, it just opens one.
            throttle.record();
            apply(view);
            return;
        }

        if(planPresenceUpdate(view, throttle) !== null) {
            apply(view);
        }
    }

    const unsubscribes = ledgers.map(store => store.subscribe(() => tick()));
    tick(false);

    return {
        presenceManager,
        unsubscribeLedgers: (): void => {
            for(const unsubscribe of unsubscribes) {
                // Stryker disable next-line llm: every element is a required function return value and therefore cannot be nullish.
                unsubscribe();
            }
            // Stryker disable next-line llm: idleSettleTimer is Timeout | null and never undefined, so != null and !== null are equivalent.
            if(idleSettleTimer !== null) {
                // Stryker disable next-line llm: Node and Bun use the same timer cancellation mechanism for clearTimeout and clearInterval.
                clearTimeout(idleSettleTimer);
                idleSettleTimer = null;
            }
        },
    };
}
