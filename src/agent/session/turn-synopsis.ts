/**
 * The turn synopsis producer: the ONE place a Haiku turn synopsis is attached to a conductor's
 * turns. Wired once per session by `src/app/sessions.ts`, next to the conductor and ledger it
 * builds, so the synopsis — which the OTHER session reads as "working on …" in its ambient line,
 * and Discord presence renders as the custom status — does not depend on Discord at all.
 *
 * Attachment keys off the LEDGER's own turn rather than off any one submit path: the conductor
 * mints a turn's identity and dispatches it (`turn_submitted`, or `spontaneous_turn_opened`)
 * BEFORE it notifies frame subscribers, so a `LedgerStore.subscribe` listener has a handler open —
 * carrying the id the reducer compares against — by the time the turn's first frame arrives. Two
 * invariants hold this together and must not be broken:
 *
 * 1. Every `turn_synopsis.turnId` comes from `ledger.turn.id`, never from `subscribeTurn`'s own
 *    `turnId` argument. Those two disagreeing (`'notification'` vs `notification-<ms>`) WAS the
 *    bug: `reduceTurnSynopsis` requires an exact match and silently drops everything else.
 * 2. `conductor.ts` dispatches `spontaneous_turn_opened` before `notifyTurnSubscribers` on BOTH
 *    unbidden-turn paths — `beginSpontaneousTurn`, and `onFrame`'s `awaitingTurnEnd` branch,
 *    where the conductor declines to claim `currentTurn` but the ledger opens a turn anyway.
 *    Move either dispatch after the notify and that turn loses its first frame; for the common
 *    one-assistant-frame-then-result shape, that is its ONLY frame and it stays generic.
 *
 * @module agent/session/turn-synopsis
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Conductor } from './conductor';
import type { LedgerStore, LedgerTurn } from './ledger';
import { sdkFrameToAgentStreamEvent } from './session';
import type { SynopsisGenerator } from './synopsis-generator';
import { buildSeedSynopsis, createSynopsisStreamHandler, type SynopsisBudget, type SynopsisStreamHandler } from './synopsis-stream-handler';
import type { Clock, TurnKind } from './types';

export type { SynopsisBudget } from './synopsis-stream-handler';

/**
 * Turn kinds that deliberately get NO synopsis handler. `compact` is the only member:
 * presence already renders the compacting marker from `Ledger.compaction` for that turn, and the
 * envelope's entire text is the literal
 * `/compact` — a Haiku call there would spend subscription quota to describe nothing.
 *
 * This set is also the cheapest dial for the ongoing Haiku volume this attachment adds: one line
 * here (plus its test) turns a whole turn kind back off.
 */
const SYNOPSIS_EXCLUDED_KINDS: ReadonlySet<TurnKind> = new Set<TurnKind>(['compact']);

/** The default {@link SynopsisBudget} window: at most one synopsis generation may START per session per 12 s. */
export const SYNOPSIS_BUDGET_MS = 12_000;

/**
 * Creates a session's {@link SynopsisBudget}: a leading-edge gate that SPENDS itself. It answers
 * true — and records `now()` — when it has never been spent, or when at least `intervalMs` have
 * passed since it last answered true; a false answer records nothing.
 *
 * It spends itself because nothing else will: the old gate was the Discord presence throttle,
 * peeked here and recorded by the display side. Every caller asks it exactly when it would start a
 * generation, so "spent" means "a generation started".
 * @param params `now` returns milliseconds; `intervalMs` defaults to {@link SYNOPSIS_BUDGET_MS}.
 * @param params.now The clock, in milliseconds.
 * @param params.intervalMs The minimum spacing between two generation starts.
 * @returns A fresh, unspent budget.
 */
export function createSynopsisBudget(params: { now: () => number, intervalMs?: number }): SynopsisBudget {
    const { now, intervalMs = SYNOPSIS_BUDGET_MS } = params;
    let lastSpentAt: number | null = null;
    return {
        shouldGenerate(): boolean {
            const at = now();
            if(lastSpentAt !== null && at - lastSpentAt < intervalMs) {
                return false;
            }
            lastSpentAt = at;
            return true;
        },
    };
}

/** Dependencies for {@link attachTurnSynopsis}. */
export interface AttachTurnSynopsisDeps {
    /** The conductor whose frames feed the live handler — only `subscribeTurn` is used. */
    conductor:                Pick<Conductor, 'subscribeTurn'>
    /** The ledger this conductor writes to: `get`/`subscribe` drive attachment, `dispatch` is the handler's synopsis sink. */
    ledgerStore:              Pick<LedgerStore, 'get' | 'subscribe' | 'dispatch'>
    /** This session's own per-instance generator (P14). */
    generator:                SynopsisGenerator
    /** This session's own generation budget — never shared with the other session or with Discord presence. */
    budget:                   SynopsisBudget
    /** Stamps each dispatched `turn_synopsis` event. */
    clock:                    Pick<Clock, 'now'>
    /** Forwarded verbatim to every handler (the idle Discord status's last-thinking-content buffer, held by `src/index.ts`). */
    onThinkingContentUpdate?: (content: string) => void
    /** Test seam: the handler factory, defaulting to the real {@link createSynopsisStreamHandler}. */
    createHandler?:           typeof createSynopsisStreamHandler
    /** Test seam: the seed pre-generator, defaulting to the real {@link buildSeedSynopsis}. */
    buildSeed?:               typeof buildSeedSynopsis
}

/**
 * Attaches turn synopsis generation to every turn of one (ledger, conductor) pair. Call once per
 * pair, from the composition root (`src/app/sessions.ts`).
 *
 * Adopts a turn that is already open at attach time via `ledgerStore.get()`, because
 * `LedgerStore.subscribe` does not replay the current value. Every seeded turn's handler —
 * adopted or not — dispatches its seed as soon as it resolves (see the handler's
 * `thinkingSynopsis` doc), so an adopted turn whose remaining frames never include a `thinking`
 * transition still gets its seed.
 * @param deps See {@link AttachTurnSynopsisDeps}.
 * @returns A detach function: completes the live handler and unsubscribes from both sources.
 */
export function attachTurnSynopsis(deps: AttachTurnSynopsisDeps): () => void {
    const {
        conductor, ledgerStore, generator, budget, clock, onThinkingContentUpdate,
        createHandler = createSynopsisStreamHandler,
        buildSeed = buildSeedSynopsis,
    } = deps;

    /** The id of the ledger turn currently attached to — tracked separately from `handler` so an EXCLUDED kind is skipped once per turn rather than re-evaluated on every one of its ledger events. */
    let openTurnId: string | undefined;
    let handler: SynopsisStreamHandler | undefined;

    function closeCurrent(): void {
        handler?.complete();
        handler = undefined;
        openTurnId = undefined;
    }

    /** Opens a handler for `turn` (whether it just opened, or was already open at attach time). */
    function openFor(turn: LedgerTurn): void {
        openTurnId = turn.id;
        if(SYNOPSIS_EXCLUDED_KINDS.has(turn.kind)) {
            return;
        }
        const { seed } = turn;
        handler = createHandler({
            turnId:           turn.id,
            sink:             ledgerStore,
            budget,
            generator,
            clock,
            userMessage:      seed ?? '',
            // A seedless turn (a bare notification: no envelope, so no seed) gets no
            // pre-generation at all — `buildUserPrompt` would just omit its "Question being
            // answered" section, and the synopsis comes from live thinking content instead.
            thinkingSynopsis: seed === undefined ? undefined : buildSeed(generator, budget, seed),
            onThinkingContentUpdate,
        });
    }

    const inFlight = ledgerStore.get().turn;
    if(inFlight !== null) {
        openFor(inFlight);
    }

    const unsubscribeLedger = ledgerStore.subscribe((ledger) => {
        const { turn } = ledger;
        // Stryker disable next-line llm: turn?.id and openTurnId are both string | undefined, so == and === are equivalent (no cross-type coercion is possible).
        if(turn?.id === openTurnId) {
            return;
        }
        closeCurrent();
        if(turn !== null) {
            openFor(turn);
        }
    });

    // No id comparison: the conductor runs one turn at a time, so whatever frame it reports
    // belongs to whatever turn is open. `reduceTurnSynopsis`'s own id guard is the backstop —
    // if that invariant is ever weakened this degrades to a silently dropped synopsis, never a
    // wrong one.
    function forwardFrame(_turnId: string, frame: SDKMessage): void {
        handler?.onStreamEvent(sdkFrameToAgentStreamEvent(frame));
    }
    const unsubscribeFrames = conductor.subscribeTurn(forwardFrame);

    return (): void => {
        unsubscribeFrames();
        closeCurrent();
        unsubscribeLedger();
    };
}
