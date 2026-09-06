/**
 * A throwaway `LedgerStore` adapter (P11, deleted in P12 once the perch session opens its own
 * real long-lived conductor and ledger) that mirrors the still-legacy perch runner's mode and
 * activity-phase transitions from {@link BotStateManager} into a `'perch'`-kind ledger turn, so
 * `composePresence` (design doc section 8) can render 🦉 plus the perch synopsis for a
 * perch-only run without any other package needing to know the perch session is not yet a real
 * conductor.
 *
 * Read-only from the ledger's own perspective: nothing ever calls `dispatch` on the returned
 * store (it exists only to satisfy the `LedgerStore` shape other P11 consumers expect), because
 * every fact this adapter carries is driven by `botStateManager`'s own state changes instead.
 *
 * @module integrations/discord/state/legacy-perch-ledger
 */
import type { BotStateManager, StateChange } from './types';
import { initialLedger, type Ledger, type LedgerEvent, type LedgerStore } from '@/agent';

/**
 * Wraps `botStateManager` in a `LedgerStore` for role `'perch'`:
 *  - A `mode_transition` INTO `'perching'` opens a fresh turn `{ id, kind: 'perch', startedAt: now(), phase: null }`.
 *  - An `activity_phase` change while the mode is (still) `'perching'` mirrors `newState.activityPhase`
 *    onto `turn.phase` — this is how the perch synopsis (`generatedStatus`) reaches the composer.
 *    An `activity_phase` change while NOT perching is ignored.
 *  - A `mode_transition` AWAY from `'perching'` clears the turn (and with it, its phase).
 *  - `tasks` stays `[]` and `compaction` stays `'none'` for the adapter's whole lifetime — the
 *    legacy perch runner has no notion of either.
 * @param botStateManager The legacy runner's own state manager; only `subscribe` is used.
 * @param now Clock for `turn.startedAt`, injected so tests do not depend on real time.
 * @returns A `LedgerStore` whose `dispatch` is a no-op (see module doc) and whose `get`/`subscribe` reflect the mirror above.
 */
export function createLegacyPerchLedger(botStateManager: BotStateManager, now: () => Date): LedgerStore {
    let ledger: Ledger = initialLedger('perch');
    const listeners = new Set<(ledger: Ledger, event: LedgerEvent) => void>();
    let nextTurnId = 0;

    function setLedger(next: Ledger, event: LedgerEvent): void {
        ledger = next;
        const snapshot = ledger;
        for(const listener of listeners) {
            listener(snapshot, event);
        }
    }

    function handleModeTransition(change: StateChange): void {
        if(change.newState.mode === 'perching' && ledger.turn === null) {
            const at = now();
            nextTurnId += 1;
            const event: LedgerEvent = { type: 'turn_submitted', envelope: { id: `perch-${nextTurnId}`, kind: 'perch', queuedAt: at }, at };
            setLedger({
                ...ledger,
                turn: {
                    id: `perch-${nextTurnId}`, kind: 'perch', startedAt: at, phase: null, interrupting: false,
                },
            }, event);
            return;
        }
        if(change.previousState.mode === 'perching' && change.newState.mode !== 'perching' && ledger.turn !== null) {
            setLedger({ ...ledger, turn: null }, { type: 'phase_changed', phase: null, at: now() });
        }
    }

    function handleActivityPhase(change: StateChange): void {
        if(change.newState.mode !== 'perching' || ledger.turn === null) {
            return;
        }
        const { activityPhase } = change.newState;
        setLedger({ ...ledger, turn: { ...ledger.turn, phase: activityPhase } }, { type: 'phase_changed', phase: activityPhase, at: now() });
    }

    botStateManager.subscribe((change: StateChange) => {
        if(change.changeType === 'mode_transition') {
            handleModeTransition(change);
            return;
        }
        if(change.changeType === 'activity_phase') {
            handleActivityPhase(change);
        }
    });

    return {
        // eslint-disable-next-line @typescript-eslint/no-empty-function -- read-only adapter: see module doc, nothing ever dispatches into this store
        dispatch:  (): void => {},
        get:       (): Ledger => ledger,
        subscribe: (listener: (ledger: Ledger, event: LedgerEvent) => void): (() => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
