/**
 * The sole writer of `processing_message`/`idle`, activity-phase and compaction transitions onto
 * {@link BotStateManager} in conductor mode (P9, temporary — deleted in P12 once presence
 * composes from ledgers directly, design section 7.1). Driven entirely by subscribing to the
 * conversation ledger's own event stream, so presence, routing and the legacy perch/catch-up
 * runners keep working unmodified while only Discord turns migrate to the long-lived conductor:
 * this shim never touches `perching`/`catching_up` — those stay owned by the legacy runners.
 *
 * @module integrations/discord/state/ledger-shim
 */
import type { Logger } from '@hughescr/logger';
import { createChannelId } from '../types';
import type { BotStateManager } from './types';
import { createBotStateCompactionSink, type ActivityPhase, type Ledger, type LedgerEvent, type LedgerStore } from '@/agent';

/** Dependencies for {@link installLedgerShim}. */
export interface InstallLedgerShimParams {
    ledgerStore:     LedgerStore
    botStateManager: BotStateManager
    logger:          Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/**
 * Subscribes to `ledgerStore` and mirrors its turn/phase/compaction facts onto
 * `botStateManager`:
 *  - `turn_submitted` for a `'discord'`/`'catchup'` envelope, while idle: `startProcessingMessage`.
 *    `EnvelopeMeta` carries no message text (plan amendment A1), so the second argument is
 *    always `''` — gap 3's `addRecentMessage`/activity-log inputs (coordinator-setup.ts) are
 *    what keep the idle-status generator's own text inputs alive, not this call.
 *  - The same event while NOT idle (a legacy perch/catch-up session already owns the mode):
 *    logged as a warning, no write — this shim never overrides perching/catching_up.
 *  - The ledger's turn closing (`ledger.turn` transitions to `null`) ends processing_message,
 *    but ONLY when this shim is the one that started it (`tracking`) and only while still in
 *    `processing_message` — a turn this shim never started (a spontaneous notification turn) or
 *    a mode some other transition already moved on from is left alone.
 *  - A change in `ledger.turn.phase`: `updateActivityPhase`.
 *  - A transition of `ledger.compaction` (`'none'` -> `'compacting'` or back): delegates to
 *    `createBotStateCompactionSink` (the same stash/restore adapter the one-shot path already
 *    uses), so both paths' presence behaviour during compaction is identical. Driven off the
 *    ledger's own `compaction` field rather than a discrete `compaction_started`/
 *    `compaction_finished` event: `compaction_started` against an open turn also sets
 *    `turn.phase` to `'compacting'` in the same reducer step, and compaction ends via the SDK's
 *    `compact_boundary` frame (an ordinary `sdk_frame` dispatch) — no production code ever
 *    dispatches a discrete `compaction_finished` event.
 * @param params See {@link InstallLedgerShimParams}.
 * @returns An unsubscribe function that stops all mirroring.
 */
export function installLedgerShim(params: InstallLedgerShimParams): () => void {
    const { ledgerStore, botStateManager, logger } = params;
    const compactionSink = createBotStateCompactionSink(botStateManager.getCompactionStateManager());

    /** True once this shim itself has called `startProcessingMessage` for the turn currently open, so the matching `goIdle` can be told apart from an unrelated turn ending. */
    let tracking = false;
    let lastPhase: ActivityPhase | null = null;
    /**
     * Mirrors `ledger.compaction` so the sink is driven by the ledger's own state transition
     * rather than by a discrete `compaction_started`/`compaction_finished` event: `'/compact'`
     * submitted against an open turn (the normal production shape) sets `turn.phase` to
     * `'compacting'` in the SAME reducer step as `compaction_started`, which would otherwise be
     * swallowed by the phase-mirror branch below before this function ever saw the compaction
     * event. And nothing in production ever dispatches a discrete `compaction_finished` event —
     * compaction ends via the SDK's `compact_boundary` frame, which only shows up as an ordinary
     * `sdk_frame` dispatch that flips `ledger.compaction` back to `'none'`. Comparing the ledger's
     * own field on every dispatch catches both.
     */
    let lastCompaction = ledgerStore.get().compaction;

    /** Handles a `turn_submitted` event for a `'discord'`/`'catchup'` envelope. Returns `true` when it fully handled the dispatch (the caller should not fall through to the phase/compaction checks below). */
    function handleTurnSubmitted(event: Extract<LedgerEvent, { type: 'turn_submitted' }>): void {
        const { channelId } = event.envelope;
        if(channelId === undefined) {
            logger.warn({ kind: event.envelope.kind }, 'ledger-shim: discord/catchup turn submitted with no channelId — skipping startProcessingMessage');
            return;
        }
        if(botStateManager.getMode() === 'idle') {
            botStateManager.startProcessingMessage(createChannelId(channelId), '');
            tracking = true;
        } else {
            logger.warn({ mode: botStateManager.getMode(), kind: event.envelope.kind }, 'ledger-shim: turn started while not idle — leaving mode untouched (owned by a legacy perch/catch-up session)');
        }
    }

    /** Reports a `ledger.compaction` transition (if any since the last dispatch) to `compactionSink`. */
    function mirrorCompactionTransition(ledger: Ledger, event: LedgerEvent): void {
        if(ledger.compaction === lastCompaction) {
            return;
        }
        lastCompaction = ledger.compaction;
        if(ledger.compaction === 'compacting') {
            compactionSink.onCompactionStart(event.type === 'compaction_started' ? event.trigger : undefined);
        } else {
            compactionSink.onCompactionEnd('');
        }
    }

    /** Reports a `ledger.turn.phase` change (if any since the last dispatch) to `botStateManager`. */
    function mirrorPhaseChange(ledger: Ledger): void {
        const phase = ledger.turn?.phase ?? null;
        if(phase !== null && phase !== lastPhase) {
            lastPhase = phase;
            botStateManager.updateActivityPhase(phase);
        }
    }

    return ledgerStore.subscribe((ledger, event) => {
        if(event.type === 'turn_submitted' && (event.envelope.kind === 'discord' || event.envelope.kind === 'catchup')) {
            handleTurnSubmitted(event);
            return;
        }

        if(tracking && ledger.turn === null) {
            tracking = false;
            lastPhase = null;
            if(botStateManager.getMode() === 'processing_message') {
                botStateManager.goIdle();
            }
            return;
        }

        mirrorCompactionTransition(ledger, event);
        mirrorPhaseChange(ledger);
    });
}
