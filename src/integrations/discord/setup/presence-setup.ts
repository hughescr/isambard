import { logger } from '@hughescr/logger';
import { ActivityType, type Client  } from 'discord.js';
import {
    attachTurnSynopsis,
    composePresence,
    createActiveStatusGenerator,
    createDynamicStatusGenerator,
    createIdleStatusGenerator,
    planPresenceUpdate,
    PresenceManager,
    type PresenceThrottle,
    type PresenceView
} from '../presence';
import { IdentityCache, type Conductor, type ContextBuilder, type LedgerStore, type Signal } from '@/agent';
import type { DiscordConfig } from '@/config';

/** Return type of {@link createDynamicStatusGenerator} — one per session ledger (P14). */
type DynamicStatusGenerator = ReturnType<typeof createDynamicStatusGenerator>;

/**
 * How long a freshly-idle composed view must persist before it is applied. A follow-up message
 * that interrupts a running turn ends that turn a few hundred ms before the next one opens; an
 * idle view applied in that gap paints "💤", consumes the presence throttle window the new turn's
 * own placeholder then needs, and starts a Haiku idle generation that is stale on arrival (first
 * conductor-mode soak, 2026-09-06). Going idle is never urgent enough to need the first 1.5 s.
 */
export const IDLE_SETTLE_MS = 1500;

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

/**
 * One session presence composes from: its ledger and, when the session has a live conductor, that
 * conductor. Passing the two TOGETHER is the point — a ledger paired with another session's
 * conductor would subscribe to one session's frames while dispatching `phase_synopsis` events
 * carrying the other's turn ids, which `reducePhaseSynopsis`'s exact-id guard drops in silence
 * (the very bug `turn-synopsis.ts` exists to fix), and would hand that session another session's
 * per-instance status generator (the P14 cross-session abort/cooldown defect). Two index-aligned
 * arrays could express that mistake; this shape cannot.
 */
export interface ConductorPresenceSession {
    /** The session ledger to compose presence from. */
    ledger:     LedgerStore
    /**
     * The conductor that writes {@link ledger}. Present entries get one {@link attachTurnSynopsis}
     * attachment, which is what gives EVERY turn kind — not just a human Discord message — a Haiku
     * synopsis overlaid on presence. Omitted (a ledger with no live conductor) attaches nothing,
     * and that ledger still contributes to the composed view.
     */
    conductor?: Pick<Conductor, 'subscribeTurn'>
}

/** Result of {@link setupConductorPresence}. */
export interface ConductorPresenceSetupResult {
    /** Presence manager for Discord status updates. */
    presenceManager:         PresenceManager
    /** Stops mirroring every session's ledger into `presenceManager`, and detaches every synopsis attachment. */
    unsubscribeLedgers:      () => void
    /**
     * One dynamic-status-generator instance per entry in the `sessions` param, in the same order
     * (conventionally `[conversation, perch]`) — each with its own cooldown/cache/in-flight state
     * (P14). Callers wire the entry for a given session's turns (e.g. the conversation entry into
     * `createConductorProcessor`'s own `dynamicStatusGenerator` dep).
     */
    dynamicStatusGenerators: DynamicStatusGenerator[]
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
 * @param params Construction inputs (status generators, identity cache, live-signals/task-context
 * callbacks), plus the sessions to compose from and the shared `PresenceThrottle` instance.
 * @returns See {@link ConductorPresenceSetupResult}.
 */
export function setupConductorPresence(params: {
    identityContext:          string
    presenceConfig:           NonNullable<DiscordConfig['presence']>
    readyClient:              Client
    /**
     * The sessions to compose from, each pairing a ledger with its OWN conductor — conventionally
     * `[conversation, perch]` (P12: perch's own real conductor ledger, when present; design doc
     * section 8: conversation wins when both are live). See {@link ConductorPresenceSession} for
     * why the pair travels as one object rather than as two index-aligned arrays.
     */
    sessions:                 readonly ConductorPresenceSession[]
    /** The one process-wide throttle shared with the ledger-sink stream handler (P11). */
    throttle:                 PresenceThrottle
    /** Forwarded verbatim to every synopsis attachment (see `bot.ts`'s last-thinking-content ring buffer). */
    onThinkingContentUpdate?: (content: string) => void
    /** Test seam: the synopsis attachment factory, defaulting to the real {@link attachTurnSynopsis}. */
    attachSynopsis?:          typeof attachTurnSynopsis
    /**
     * P14: injectable dynamic-status-generator factory, defaulting to the real
     * {@link createDynamicStatusGenerator}. Called once PER SESSION (in `sessions` order) so each
     * session gets its own cooldown/cache/in-flight-controller instance — a single shared
     * instance let one session's Haiku call abort the other's and let one session's cooldown gate
     * the other's synopsis (status-generator-dynamic.ts now keeps that state in the closure
     * returned by this factory, not at module scope). See {@link ConductorPresenceSetupResult.dynamicStatusGenerators}.
     */
    createDynamicGenerator?:  typeof createDynamicStatusGenerator
    getTaskContext?:          () => Promise<string | undefined>
    getRecentContext:         () => Promise<string | undefined>
    contextBuilder?:          ContextBuilder
    getLastThinkingContent?:  () => string | undefined
    /** Pre-built write-through identity cache. When provided, replaces the inline loader. */
    identityCache?:           IdentityCache
    /** Optional live-signals snapshot callback. */
    getLiveSignals?:          () => Promise<Signal[]>
    /** Getter for the last idle status text (anti-rut). */
    getPreviousStatus?:       () => string | undefined
    /** Setter for persisting the last idle status text (anti-rut). */
    setPreviousStatus?:       (text: string) => void
    /**
     * Optional Q3/B4 daily cost ceiling predicate: `tick()` re-reads it on every compose (never
     * cached), so a pause taken or cleared mid-run is reflected on the very next ledger event —
     * rendered as a `⏸ perch` marker in the composed prefix (see `composePresence`'s own doc).
     */
    isCostPaused?:            () => boolean
}): ConductorPresenceSetupResult {
    const {
        identityContext,
        presenceConfig,
        readyClient,
        sessions,
        throttle,
        onThinkingContentUpdate,
        attachSynopsis = attachTurnSynopsis,
        createDynamicGenerator = createDynamicStatusGenerator,
        getTaskContext,
        getRecentContext,
        contextBuilder,
        getLastThinkingContent,
        identityCache: providedIdentityCache,
        getLiveSignals,
        getPreviousStatus,
        setPreviousStatus,
        isCostPaused,
    } = params;

    // P14: one generator instance per session — see ConductorPresenceSession's own doc for why
    // sharing one instance across sessions is a defect, not an optimisation. Attaching it to the
    // session object here is what keeps a session's ledger, conductor and generator together from
    // this point on: nothing below indexes one collection with another's position.
    const attachedSessions = sessions.map(session => ({
        ...session,
        dynamicStatusGenerator: createDynamicGenerator({ identityContext }),
    }));
    const ledgers: readonly LedgerStore[] = attachedSessions.map(session => session.ledger);
    const dynamicStatusGenerators: DynamicStatusGenerator[] = attachedSessions.map(session => session.dynamicStatusGenerator);

    // The ONE place a presence synopsis handler is attached (see presence/turn-synopsis.ts):
    // once per session, so every turn kind that session opens — human, bare notification, task
    // wake, peer, catch-up, perch, wrapup, resume — gets a Haiku digest instead of the ledger's
    // bare base phase.
    const detachSynopses = attachedSessions.flatMap(({ ledger, conductor, dynamicStatusGenerator }) => {
        if(conductor === undefined) {
            return [];
        }
        return [attachSynopsis({
            conductor,
            ledgerStore: ledger,
            throttle,
            dynamicStatusGenerator,
            logger,
            onThinkingContentUpdate,
        })];
    });

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

    /** Applies `view` via the presence manager. */
    function apply(view: PresenceView): void {
        void presenceManager.applyView(view);
    }

    let idleSettleTimer: ReturnType<typeof setTimeout> | null = null;

    /** Fires {@link IDLE_SETTLE_MS} after a view first composed idle: applies the CURRENT view only if it is still idle. */
    function applyIdleIfStillIdle(): void {
        idleSettleTimer = null;
        const view = composePresence(ledgers.map(store => store.get()), isCostPaused?.() ?? false);
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
        const view = composePresence(ledgers.map(store => store.get()), isCostPaused?.() ?? false);
        const signature = phaseSignature(view);
        const digest = digestOf(view);

        if(view.phase.type === 'idle' && settleIdle) {
            lastSeenSignature = signature;
            lastSeenDigest = digest;
            idleSettleTimer ??= setTimeout(applyIdleIfStillIdle, IDLE_SETTLE_MS);
            return;
        }
        if(idleSettleTimer !== null) {
            clearTimeout(idleSettleTimer);
            idleSettleTimer = null;
        }
        // (An idle view has a null signature AND no digest, so the two-clause form below cannot
        // misfire on idle -> idle: both digests are undefined there.)
        const digestJustArrived = signature === lastSeenSignature && digest !== lastSeenDigest;

        lastSeenSignature = signature;
        lastSeenDigest = digest;

        if(digestJustArrived) {
            // Record as well as apply: what went out IS now what Discord shows, so the ticks that
            // follow (the same phase re-composed by the next sdk_frame, carrying the same digest)
            // must be held by a fresh window rather than sailing through planPresenceUpdate and
            // re-sending identical text — two "Updated Discord presence" lines 1 ms apart in the
            // 2026-09-08 production log. The bypass's own intent is unchanged: a fresh digest
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
        dynamicStatusGenerators,
        unsubscribeLedgers: (): void => {
            for(const unsubscribe of [...unsubscribes, ...detachSynopses]) {
                unsubscribe();
            }
            if(idleSettleTimer !== null) {
                clearTimeout(idleSettleTimer);
                idleSettleTimer = null;
            }
        },
    };
}
