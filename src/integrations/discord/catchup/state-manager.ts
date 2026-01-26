/**
 * Catch-Up State Manager
 *
 * Manages the state machine for Discord bot catch-up mode, tracking:
 * - Current catch-up state (idle, catching_up, interrupted, processing)
 * - Channels where inbox tools were used (getChannelSummary, fetchMessages)
 */

import type { ChannelId } from '@/integrations/discord/types';
import type { CatchUpState } from './types';

/**
 * Valid state transitions for catch-up state machine.
 * Each key is a current state, and the value is an array of valid next states.
 */
const VALID_TRANSITIONS: Record<CatchUpState, CatchUpState[]> = {
    idle:                    ['catching_up', 'processing_message'],
    catching_up:             ['catching_up', 'catching_up_interrupted', 'idle'],
    catching_up_interrupted: ['catching_up', 'idle'],
    processing_message:      ['idle'],
};

/**
 * Interface for managing catch-up state.
 */
export interface CatchUpStateManager {
    /**
     * Get the current catch-up state.
     * @returns Current state
     */
    getState(): CatchUpState

    /**
     * Update the catch-up state.
     * @param state - New state to transition to
     */
    setState(state: CatchUpState): void

    /**
     * Get the set of channels where inbox tools were used.
     * @returns Set of viewed channel IDs
     */
    getViewedChannels(): Set<ChannelId>

    /**
     * Mark a channel as viewed (inbox tool was used).
     * @param channelId - Channel ID to mark as viewed
     */
    markChannelViewed(channelId: ChannelId): void

    /**
     * Clear all viewed channels.
     * Called when catch-up session ends.
     */
    clearViewedChannels(): void
}

/**
 * Creates a catch-up state manager.
 *
 * The manager tracks:
 * - Current state in the catch-up state machine
 * - Channels where getChannelSummary/fetchMessages was called
 *
 * @param logger - Structured logger for state transition warnings
 * @returns CatchUpStateManager instance
 *
 * @example
 * ```typescript
 * const manager = createCatchUpStateManager(logger);
 *
 * // Start catch-up
 * manager.setState('catching_up');
 *
 * // Track viewed channels
 * manager.markChannelViewed(channelId1);
 * manager.markChannelViewed(channelId2);
 *
 * // Handle interruption
 * manager.setState('catching_up_interrupted');
 *
 * // Resume
 * manager.setState('catching_up');
 *
 * // Finish catch-up
 * manager.setState('idle');
 * manager.clearViewedChannels();
 * ```
 */
export function createCatchUpStateManager(logger: { warn: (obj: Record<string, unknown>) => void }): CatchUpStateManager {
    let currentState: CatchUpState = 'idle';
    const viewedChannels = new Set<ChannelId>();

    return {
        getState(): CatchUpState {
            return currentState;
        },

        setState(state: CatchUpState): void {
            const validNextStates = VALID_TRANSITIONS[currentState];
            if(!validNextStates.includes(state)) {
                // Log warning but allow transition for robustness
                logger.warn({ from: currentState, to: state, msg: 'Invalid catch-up state transition detected' });
            }
            currentState = state;
        },

        getViewedChannels(): Set<ChannelId> {
            return new Set(viewedChannels);
        },

        markChannelViewed(channelId: ChannelId): void {
            viewedChannels.add(channelId);
        },

        clearViewedChannels(): void {
            viewedChannels.clear();
        },
    };
}
