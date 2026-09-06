/**
 * The sole writer of `processing_message`/`idle` mode transitions onto {@link BotStateManager} in
 * conductor mode (P9, temporary — deleted in P12 once the perch session opens its own conductor,
 * design section 7.1). Driven entirely by subscribing to the conversation ledger's own event
 * stream, so routing and the legacy perch/catch-up runners keep working unmodified while only
 * Discord turns migrate to the long-lived conductor: this shim never touches
 * `perching`/`catching_up` — those stay owned by the legacy runners.
 *
 * P11: activity-phase and compaction mirroring onto `BotStateManager` are GONE from this shim —
 * presence now reads `Ledger.turn.phase` and `Ledger.compaction` directly via
 * `presence/presence-view.ts`'s composer, so double-writing that state through `BotStateManager`
 * would just be redundant plumbing this file no longer needs to own. Only the mode transitions
 * (`processing_message`/`idle`) stay, because routing and the legacy perch gate still key off
 * `botStateManager.getMode()`.
 *
 * @module integrations/discord/state/ledger-shim
 */
import type { Logger } from '@hughescr/logger';
import { createChannelId } from '../types';
import type { BotStateManager } from './types';
import type { LedgerEvent, LedgerStore } from '@/agent';

/** Dependencies for {@link installLedgerShim}. */
export interface InstallLedgerShimParams {
    ledgerStore:     LedgerStore
    botStateManager: BotStateManager
    logger:          Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/**
 * Subscribes to `ledgerStore` and mirrors its mode-relevant facts onto `botStateManager`:
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
 *  - Activity-phase and compaction changes are NOT mirrored anywhere (P11: presence reads
 *    `Ledger.turn.phase`/`Ledger.compaction` directly — see the module doc above).
 * @param params See {@link InstallLedgerShimParams}.
 * @returns An unsubscribe function that stops all mirroring.
 */
export function installLedgerShim(params: InstallLedgerShimParams): () => void {
    const { ledgerStore, botStateManager, logger } = params;

    /** True once this shim itself has called `startProcessingMessage` for the turn currently open, so the matching `goIdle` can be told apart from an unrelated turn ending. */
    let tracking = false;

    /** Handles a `turn_submitted` event for a `'discord'`/`'catchup'` envelope. Returns `true` when it fully handled the dispatch (the caller should not fall through to the mode-transition check below). */
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

    return ledgerStore.subscribe((ledger, event) => {
        if(event.type === 'turn_submitted' && (event.envelope.kind === 'discord' || event.envelope.kind === 'catchup')) {
            handleTurnSubmitted(event);
            return;
        }

        if(tracking && ledger.turn === null) {
            tracking = false;
            if(botStateManager.getMode() === 'processing_message') {
                botStateManager.goIdle();
            }
        }
    });
}
