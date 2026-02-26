import type { OperationalMode } from './types';
import { TransitionError } from '@/errors';

/**
 * Valid state transitions for operational modes.
 *
 * ## Idle Hub Pattern
 *
 * All modes must transition through 'idle' as a central hub. Direct mode-to-mode
 * transitions (e.g., `catching_up` → `processing_message`) are intentionally
 * forbidden to maintain clear state boundaries.
 *
 * ### Suspending a Mode
 *
 * To suspend one mode for another (e.g., suspend catch-up to process a message):
 * 1. Session runner's `suspend()` saves state and calls `goIdle()`
 * 2. New message is processed normally (idle → processing_message → idle)
 * 3. Session runner's `resumeAfterSuspension()` restores state and continues
 *
 * This pattern ensures clean state transitions and proper cleanup between operations.
 *
 * @internal Maps each mode to the list of modes it can transition to.
 */
// Stryker disable ArrayDeclaration: Static transition mappings - values tested implicitly through transition behavior
export const VALID_TRANSITIONS: Record<OperationalMode, OperationalMode[]> = {
    idle:               ['catching_up', 'processing_message', 'perching'],
    catching_up:        ['idle'],
    processing_message: ['idle'],
    perching:           ['idle'],
};
// Stryker restore ArrayDeclaration

/**
 * Check if a transition between two operational modes is valid.
 *
 * @param from - The current operational mode
 * @param to - The target operational mode
 * @returns true if the transition is allowed, false otherwise
 */
export function isValidTransition(from: OperationalMode, to: OperationalMode): boolean {
    // Stryker disable next-line OptionalChaining,BooleanLiteral: Safe property access with fallback - tested via valid and invalid transitions
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Assert that a transition between two operational modes is valid.
 * Throws TransitionError if the transition is not allowed.
 *
 * @param from - The current operational mode
 * @param to - The target operational mode
 * @throws {TransitionError} If the transition is invalid
 */
export function assertValidTransition(from: OperationalMode, to: OperationalMode): void {
    if(!isValidTransition(from, to)) {
        throw new TransitionError(from, to);
    }
}

/**
 * Get the emoji prefix for a mode.
 *
 * @param mode - The operational mode
 * @returns The emoji string for the mode
 */
export function getModeEmoji(mode: OperationalMode): string {
    const baseEmojis: Record<OperationalMode, string> = {
        idle:               '💤',
        catching_up:        '📥',
        processing_message: '💬',
        perching:           '🪶',
    };

    return baseEmojis[mode];
}

export { TransitionError } from '@/errors';
