/**
 * The ONE place a Haiku presence synopsis is attached to a conductor turn.
 *
 * Before this module, `createLedgerStreamEventHandler` was constructed at exactly one call site
 * — inside `setup/conductor-processor.ts`'s closure for a human Discord envelope — so every
 * other turn (a bare notification, an adopted task wake, a peer message, catch-up, perch,
 * wrapup, resume) ran with the ledger's bare base phase and painted a generic "Thinking…".
 *
 * The fix is to key attachment off the LEDGER's own turn rather than off any one submit path:
 * the conductor mints a turn's identity and dispatches it (`turn_submitted`, or
 * `spontaneous_turn_opened`) BEFORE it notifies frame subscribers, so a `LedgerStore.subscribe`
 * listener has a handler open — carrying the id the reducer compares against — by the time the
 * turn's first frame arrives. Two invariants hold this together and must not be broken:
 *
 * 1. Every `phase_synopsis.turnId` comes from `ledger.turn.id`, never from `subscribeTurn`'s own
 *    `turnId` argument. Those two disagreeing (`'notification'` vs `notification-<ms>`) WAS the
 *    bug: `reducePhaseSynopsis` requires an exact match and silently drops everything else.
 * 2. `conductor.ts` dispatches `spontaneous_turn_opened` before `notifyTurnSubscribers` on BOTH
 *    unbidden-turn paths — `beginSpontaneousTurn`, and `onFrame`'s `awaitingTurnEnd` branch,
 *    where the conductor declines to claim `currentTurn` but the ledger opens a turn anyway.
 *    Move either dispatch after the notify and that turn loses its first frame; for the common
 *    one-assistant-frame-then-result shape, that is its ONLY frame and it stays generic.
 *
 * @module integrations/discord/presence/turn-synopsis
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PresenceThrottle } from './presence-view.js';
import type { DynamicStatusGenerator } from './status-generator-dynamic.js';
import { buildLedgerThinkingSynopsis, createLedgerStreamEventHandler, type LedgerStreamEventHandler } from './stream-event-handler.js';
import type { AgentStreamEvent, Conductor, LedgerStore, LedgerTurn, TurnKind } from '@/agent';

/**
 * Turn kinds that deliberately get NO synopsis handler. `compact` is the only member:
 * `reduceCompactionStarted` already puts the turn in a `compacting` phase and `composePresence`
 * already renders its own marker for that, and the envelope's entire text is the literal
 * `/compact` — a Haiku call there would spend subscription quota to describe nothing.
 *
 * This set is also the cheapest dial for the ongoing Haiku volume this attachment adds: one line
 * here (plus its test) turns a whole turn kind back off.
 */
const SYNOPSIS_EXCLUDED_KINDS: ReadonlySet<TurnKind> = new Set<TurnKind>(['compact']);

/** Dependencies for {@link attachTurnSynopsis}. */
export interface AttachTurnSynopsisDeps {
    /** The conductor whose frames feed the live handler — only `subscribeTurn` is used. */
    conductor:               Pick<Conductor, 'subscribeTurn'>
    /** The ledger this conductor writes to: `get`/`subscribe` drive attachment, `dispatch` is the handler's synopsis sink. */
    ledgerStore:             Pick<LedgerStore, 'get' | 'subscribe' | 'dispatch'>
    /** The one process-wide throttle, shared with `presence-setup.ts` — peeked, never recorded, by the handler. */
    throttle:                PresenceThrottle
    /** This session's own per-instance generator (P14). Omitted means no synopsis is ever generated. */
    dynamicStatusGenerator?: DynamicStatusGenerator
    logger: {
        error: (obj: Record<string, unknown> | string, message?: string) => void
    }
    /** Forwarded verbatim to every handler (see `bot.ts`'s last-thinking-content ring buffer). */
    onThinkingContentUpdate?: (content: string) => void
    /** Test seam: the handler factory, defaulting to the real {@link createLedgerStreamEventHandler}. */
    createHandler?:           typeof createLedgerStreamEventHandler
    /** Test seam: the seed pre-generator, defaulting to the real {@link buildLedgerThinkingSynopsis}. */
    buildThinkingSynopsis?:   typeof buildLedgerThinkingSynopsis
}

/**
 * Attaches presence-synopsis generation to every turn of one (ledger, conductor) pair. Call once
 * per pair, from the composition root (`setup/presence-setup.ts`).
 *
 * Adopts a turn that is already open at attach time via `ledgerStore.get()`, because
 * `LedgerStore.subscribe` does not replay the current value. That window is real: `bot.ts` opens
 * the conversation conductor, then AWAITS the perch conductor's open (a subprocess spawn, up to a
 * 30 s ceiling) before it calls `setupConductorPresence`, and the email/Bluesky/quota pollers
 * `src/index.ts` starts concurrently can drive an autonomous frame into the conversation
 * conductor throughout it. Without the adoption such a turn gets its handler only on its next
 * ledger event — or never, if its next frame is the `result` that closes it. An adopted turn's
 * handler is also PRIMED (`primeThinkingSynopsis`), because the frames it would have learned its
 * phase from are already gone: without priming the seed is generated, paid for and discarded
 * whenever no further `thinking` transition arrives.
 * @param deps See {@link AttachTurnSynopsisDeps}.
 * @returns A detach function: completes the live handler and unsubscribes from both sources.
 */
export function attachTurnSynopsis(deps: AttachTurnSynopsisDeps): () => void {
    const {
        conductor, ledgerStore, throttle, dynamicStatusGenerator, logger, onThinkingContentUpdate,
        createHandler = createLedgerStreamEventHandler,
        buildThinkingSynopsis = buildLedgerThinkingSynopsis,
    } = deps;

    /** The id of the ledger turn currently attached to — tracked separately from `handler` so an EXCLUDED kind is skipped once per turn rather than re-evaluated on every one of its ledger events. */
    let openTurnId: string | undefined;
    let handler: LedgerStreamEventHandler | undefined;

    function closeCurrent(): void {
        handler?.complete();
        handler = undefined;
        openTurnId = undefined;
    }

    /**
     * Opens a handler for `turn`. `adopted` is true only for the one turn that was ALREADY open
     * when this function attached: that turn has already emitted the frames a fresh handler would
     * have learned its phase from, and `subscribeTurn` has no replay, so its seed is primed
     * (dispatched as soon as it resolves) rather than left waiting for a `thinking` transition
     * that may never come — the turn's next frame can be the `result` that closes it.
     */
    function openFor(turn: LedgerTurn, adopted: boolean): void {
        openTurnId = turn.id;
        if(SYNOPSIS_EXCLUDED_KINDS.has(turn.kind)) {
            return;
        }
        const { seed } = turn;
        handler = createHandler({
            turnId:                turn.id,
            sink:                  ledgerStore,
            throttle,
            dynamicStatusGenerator,
            logger,
            userMessage:           seed ?? '',
            // A seedless turn (a bare notification: no envelope, so no seed) gets no
            // pre-generation at all — `buildUserPrompt` would just omit its "Question being
            // answered" section, and the synopsis comes from live thinking content instead.
            thinkingSynopsis:      seed === undefined ? undefined : buildThinkingSynopsis(dynamicStatusGenerator, throttle, seed),
            primeThinkingSynopsis: adopted,
            onThinkingContentUpdate,
        });
    }

    const inFlight = ledgerStore.get().turn;
    if(inFlight !== null) {
        openFor(inFlight, true);
    }

    const unsubscribeLedger = ledgerStore.subscribe((ledger) => {
        const { turn } = ledger;
        if(turn?.id === openTurnId) {
            return;
        }
        closeCurrent();
        if(turn !== null) {
            openFor(turn, false);
        }
    });

    // No id comparison: the conductor runs one turn at a time, so whatever frame it reports
    // belongs to whatever turn is open. `reducePhaseSynopsis`'s own id guard is the backstop —
    // if that invariant is ever weakened this degrades to a silently dropped digest, never a
    // wrong status. Same boundary cast, for the same reason, as conductor-processor.ts's.
    const unsubscribeFrames = conductor.subscribeTurn((_turnId: string, frame: SDKMessage) => {
        handler?.onStreamEvent(frame as unknown as AgentStreamEvent);
    });

    return (): void => {
        unsubscribeFrames();
        closeCurrent();
        unsubscribeLedger();
    };
}
