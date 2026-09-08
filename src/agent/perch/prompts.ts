/**
 * Perch Slot Naming
 *
 * Formats a perch time slot into a human-readable display name. Used by the perch-slot
 * envelope builder (./envelope.ts) for the slot header.
 */

import { type PerchSlot } from './types';
import { InvariantViolationError } from '@/errors';

/**
 * Format a slot name for display in prompts.
 * Converts kebab-case to Title Case with context.
 *
 * @param slot - The slot to format
 * @returns Human-readable slot name
 */
export function formatSlotName(slot: PerchSlot): string {
    switch(slot) {
        case 'pre-dawn': {
            return 'Pre-Dawn (5-7am Pacific)';
        }
        case 'mid-morning': {
            return 'Mid-Morning (9-11am Pacific)';
        }
        case 'wikipedia': {
            return 'Wikipedia Exploration (12pm-2pm Pacific)';
        }
        case 'afternoon': {
            return 'Afternoon (2-4pm Pacific)';
        }
        case 'evening': {
            return 'Evening (6-8pm Pacific)';
        }
        case 'late-night': {
            return 'Late Night (11pm-1am Pacific)';
        }
        case 'unscheduled': {
            return 'Unscheduled';
        }
    }
    // TypeScript exhaustiveness - this line should be unreachable

    // Stryker disable next-line all: Unreachable exhaustiveness check
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Unreachable exhaustiveness check
    throw new InvariantViolationError('getSlotDescription', `Unknown slot: ${slot}`);
}
