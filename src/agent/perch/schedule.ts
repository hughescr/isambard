/**
 * Perch Time Schedule
 *
 * Defines time slots and provides lookup functions for determining
 * which slot corresponds to a given hour.
 */

import _ from 'lodash';
import { type PerchSlot, type PerchSlotConfig } from './types';

// ============================================================================
// Slot Configurations
// ============================================================================

/**
 * Pre-dawn slot (5-7am Pacific) - STRONGLY SUGGESTIVE
 * Craig wakes around 7am. Prepare morning digest.
 */
const PRE_DAWN: PerchSlotConfig = {
    slot:      'pre-dawn',
    startHour: 5,
    endHour:   7,
    level:     'strongly_suggestive',
    hint:      `Craig wakes around 7am. This is a good window for preparing a morning digest:
- Overnight news/weather relevant to Portland
- Any open threads from yesterday worth surfacing
- Items from your [For Craig] task queue
Or pick up something from TaskList that caught your interest.`,
};

/**
 * Mid-morning slot (9-11am Pacific) - MODERATE
 * Morning work hours. Follow up on tasks or observe.
 */
const MID_MORNING: PerchSlotConfig = {
    slot:      'mid-morning',
    startHour: 9,
    endHour:   11,
    level:     'moderate',
    hint:      `Morning work hours. Possibilities:
- Follow up on open tasks or threads
- Check if yesterday's conversations had loose ends
- Continue something from a previous perch session
- Light research on topics from recent discussions
Or: simply observe - no action required.`,
};

/**
 * Wikipedia slot (12pm-2pm Pacific) - MODERATE
 * Lunchtime breadth exploration via random Wikipedia.
 * Discoveries here can seed the afternoon exploration session.
 */
const WIKIPEDIA: PerchSlotConfig = {
    slot:      'wikipedia',
    startHour: 12,
    endHour:   14,
    level:     'moderate',
    hint:      `Lunchtime breadth exploration. Start somewhere unexpected:
- Fetch https://en.wikipedia.org/wiki/Special:Random and read what you land on
- Follow whatever thread catches your interest — connections, rabbit holes, questions it raises
- The goal isn't productivity, it's range
- If something sparks curiosity, note it — the afternoon exploration slot follows this one
This is an antidote to self-referential loops. Engage with the world, not just your own memories.`,
};

/**
 * Afternoon slot (2-4pm Pacific) - OPEN
 * Afternoon exploration time. Research, learn, or do nothing.
 */
const AFTERNOON: PerchSlotConfig = {
    slot:      'afternoon',
    startHour: 14,
    endHour:   16,
    level:     'open',
    hint:      `Afternoon. Some options:
- Deeper research on something that interested you recently
- Pick up an exploratory thread from TaskList
- Explore a corner of your memory system
- Learn something new (web search on a curiosity)
- Review your event log for patterns
Or: do nothing. Perch time isn't productive time.`,
};

/**
 * Evening slot (6-8pm Pacific) - LIGHT TOUCH
 * Evening wind-down. Light exploration or skip.
 */
const EVENING: PerchSlotConfig = {
    slot:      'evening',
    startHour: 18,
    endHour:   20,
    level:     'light_touch',
    hint:      `Evening wind-down hours. Consider:
- Lighter exploration - follow a curiosity
- Skip this slot if nothing calls to you
Craig may or may not be around; don't expect interaction.`,
};

/**
 * Late-night slot (11pm-1am Pacific) - MODERATE
 * Note: This slot spans midnight (23:00 to 01:00).
 * Craig likely asleep. Good time for deep research and digest prep.
 */
const LATE_NIGHT: PerchSlotConfig = {
    slot:      'late-night',
    startHour: 23,
    endHour:   1,
    level:     'moderate',
    hint:      `Late night - Craig likely asleep or heading there.
This can be good for:
- Research deep-dives that don't need interaction
- Pre-positioning for tomorrow's digest
- Reviewing the day's events for patterns
Or continue something you bookmarked earlier.`,
};

/**
 * All perch slot configurations in order.
 */
export const SLOT_CONFIGS: readonly PerchSlotConfig[] = [
    PRE_DAWN,
    MID_MORNING,
    WIKIPEDIA,
    AFTERNOON,
    EVENING,
    LATE_NIGHT,
] as const;

// ============================================================================
// Lookup Functions
// ============================================================================

/**
 * Get the perch slot for a given hour (0-23).
 * Returns 'unscheduled' if no slot matches.
 *
 * Special handling for late-night slot which spans midnight:
 * - Hours 23, 0, 1 all map to 'late-night'
 *
 * @param hour - Hour in 24-hour format (0-23)
 * @returns The matching PerchSlot
 *
 * @example
 * ```typescript
 * getSlotForHour(6);  // 'pre-dawn'
 * getSlotForHour(10); // 'mid-morning'
 * getSlotForHour(23); // 'late-night'
 * getSlotForHour(0);  // 'late-night'
 * getSlotForHour(12); // 'wikipedia'
 * ```
 */
export function getSlotForHour(hour: number): PerchSlot {
    // Validate hour range
    if(hour < 0 || hour > 23) {
        throw new RangeError(`Hour must be between 0 and 23, got ${hour}`);
    }

    // Handle late-night slot specially since it spans midnight (23-1)
    if(hour === 23 || hour === 0 || hour === 1) {
        return 'late-night';
    }

    // Check other slots
    for(const config of SLOT_CONFIGS) {
        // Skip late-night since we already handled it
        // Stryker disable next-line ConditionalExpression,BlockStatement: Optimization to avoid checking late-night twice
        if(config.slot === 'late-night') {
            continue;
        }

        // For normal slots, check if hour is in range [startHour, endHour)
        if(hour >= config.startHour && hour < config.endHour) {
            return config.slot;
        }
    }

    // No slot matched
    return 'unscheduled';
}

/**
 * Get the configuration for a specific slot.
 * Returns undefined for 'unscheduled'.
 *
 * @param slot - The slot to get config for
 * @returns PerchSlotConfig or undefined
 *
 * @example
 * ```typescript
 * const config = getSlotConfig('pre-dawn');
 * console.log(config?.hint); // "Craig wakes around 7am..."
 *
 * const none = getSlotConfig('unscheduled');
 * console.log(none); // undefined
 * ```
 */
export function getSlotConfig(slot: PerchSlot): PerchSlotConfig | undefined {
    // Stryker disable next-line all: Early return for unscheduled is tested behavior
    if(slot === 'unscheduled') {
        return undefined;
    }

    return _.find(SLOT_CONFIGS, { slot });
}
