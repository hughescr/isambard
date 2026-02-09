import type { OperationalMode } from './types';
import { TransitionError } from '@/errors';

export { TransitionError };

/**
 * Valid state transitions for operational modes.
 *
 * ## Idle Hub Pattern
 *
 * All modes must transition through 'idle' as a central hub. Direct mode-to-mode
 * transitions (e.g., `catching_up` → `processing_message`) are intentionally
 * forbidden to maintain clear state boundaries.
 *
 * ### Interrupting a Mode
 *
 * To interrupt one mode for another (e.g., interrupt catch-up to process a message):
 * 1. Call `interrupt()` to signal the current operation should stop
 * 2. Call `goIdle()` to complete the transition to idle
 * 3. Call the appropriate start method (e.g., `startProcessingMessage()`) for the new mode
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
 * Check if a mode can be interrupted by incoming messages.
 *
 * @param mode - The operational mode to check
 * @returns true if the mode can be interrupted, false otherwise
 */
export function canInterrupt(mode: OperationalMode): boolean {
    return mode !== 'idle';
}

/**
 * Get the emoji prefix for a mode, including interrupt indicator if applicable.
 *
 * @param mode - The operational mode
 * @param interrupted - Whether the mode is currently interrupted
 * @returns The emoji string for the mode
 */
export function getModeEmoji(mode: OperationalMode, interrupted: boolean): string {
    const baseEmojis: Record<OperationalMode, string> = {
        idle:               '💤',
        catching_up:        '📥',
        processing_message: '💬',
        perching:           '🪶',
    };

    const baseEmoji = baseEmojis[mode];

    // Add interrupt indicator for interruptible modes
    if(interrupted && canInterrupt(mode) && mode !== 'processing_message') {
        return `${baseEmoji}💬`;
    }

    return baseEmoji;
}
