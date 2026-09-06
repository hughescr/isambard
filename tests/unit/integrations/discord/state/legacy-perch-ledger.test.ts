/**
 * Behavioural tests for {@link createLegacyPerchLedger} (P11): a throwaway `LedgerStore` adapter
 * (deleted in P12) that mirrors the legacy perch runner's mode and activity-phase transitions
 * from {@link BotStateManager} into a perch-kind ledger turn, so `composePresence` renders 🦉
 * plus the perch synopsis for a perch-only run.
 */
import { describe, expect, it, jest } from 'bun:test';
import { initialLedger, type ActivityPhase } from '@/agent';
import { composePresence } from '@/integrations/discord/presence/presence-view';
import { createLegacyPerchLedger } from '@/integrations/discord/state/legacy-perch-ledger';
import type { BotState, BotStateManager, StateChange } from '@/integrations/discord/state/types';

function botState(mode: BotState['mode'], activityPhase: ActivityPhase | null = null): BotState {
    return {
        mode, activityPhase, modeEnteredAt: new Date(0), modeContext: {},
    };
}

/** A minimal fake `BotStateManager`: only `subscribe` is used by the adapter, captured so the test can `emit` crafted `StateChange`s. */
function makeBotStateManager() {
    let listener: ((change: StateChange) => void) | undefined;
    const botStateManager = {
        subscribe: jest.fn((l: (change: StateChange) => void) => {
            listener = l;
            return () => {
                listener = undefined;
            };
        }),
    } as unknown as BotStateManager;
    function emit(change: StateChange): void {
        listener?.(change);
    }
    return { botStateManager, emit };
}

describe('createLegacyPerchLedger', () => {
    it('starts with role \'perch\' and no open turn', () => {
        const { botStateManager } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));

        expect(store.get()).toMatchObject({ role: 'perch', turn: null, tasks: [], compaction: 'none' });
    });

    it('opens a fresh perch turn when the mode transitions into perching', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(1000));

        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });

        expect(store.get().turn).toMatchObject({ kind: 'perch', startedAt: new Date(1000), phase: null });
        expect(typeof store.get().turn?.id).toBe('string');
        expect(store.get().turn?.id.length).toBeGreaterThan(0);
    });

    it('gives two successive perch turns distinct ids', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));

        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });
        const firstId = store.get().turn?.id;
        emit({ previousState: botState('perching'), newState: botState('idle'), changeType: 'mode_transition' });
        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });
        const secondId = store.get().turn?.id;

        expect(secondId).not.toBe(firstId);
    });

    it('mirrors an activity_phase change into turn.phase while perching', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));
        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });

        const phase: ActivityPhase = { type: 'using_tool', toolName: 'Bash', startedAt: new Date(0), generatedStatus: 'checking on things' };
        emit({ previousState: botState('perching'), newState: botState('perching', phase), changeType: 'activity_phase' });

        expect(store.get().turn?.phase).toEqual(phase);
    });

    it('ignores an activity_phase change while not perching', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));

        const phase: ActivityPhase = { type: 'thinking', startedAt: new Date(0) };
        emit({ previousState: botState('processing_message'), newState: botState('processing_message', phase), changeType: 'activity_phase' });

        expect(store.get().turn).toBeNull();
    });

    it('clears turn and phase when the mode transitions away from perching', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));
        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });
        const phase: ActivityPhase = { type: 'thinking', startedAt: new Date(0) };
        emit({ previousState: botState('perching'), newState: botState('perching', phase), changeType: 'activity_phase' });

        emit({ previousState: botState('perching', phase), newState: botState('idle'), changeType: 'mode_transition' });

        expect(store.get().turn).toBeNull();
    });

    it('notifies subscribers on every mirrored change', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));
        const listener = jest.fn();
        store.subscribe(listener);

        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });
        const phase: ActivityPhase = { type: 'thinking', startedAt: new Date(0) };
        emit({ previousState: botState('perching'), newState: botState('perching', phase), changeType: 'activity_phase' });
        emit({ previousState: botState('perching', phase), newState: botState('idle'), changeType: 'mode_transition' });

        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('carries the perch synopsis as the composed digest when only the perch ledger is live', () => {
        const { botStateManager, emit } = makeBotStateManager();
        const store = createLegacyPerchLedger(botStateManager, () => new Date(0));
        emit({ previousState: botState('idle'), newState: botState('perching'), changeType: 'mode_transition' });
        const phase: ActivityPhase = { type: 'thinking', startedAt: new Date(0), generatedStatus: 'watching the nest' };
        emit({ previousState: botState('perching'), newState: botState('perching', phase), changeType: 'activity_phase' });

        const view = composePresence([initialLedger('conversation'), store.get()]);

        expect(view.live).toEqual(['perch']);
        expect(view.phase).toEqual(phase);
        expect(view.activeRole).toBe('perch');
    });
});
