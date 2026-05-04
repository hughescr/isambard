/**
 * Perch Time Schedule
 *
 * Defines time slots and provides lookup functions for determining
 * which slot corresponds to a given hour.
 */
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
    hint:      `Craig wakes around 7am. Post a morning digest to #general so it's there when he gets up:
- Overnight news/weather relevant to Portland
- Bluesky notifications and anything interesting in the feed
- Any open threads from yesterday worth surfacing
- Items from your [For Craig] task queue
This is the default action for the pre-dawn slot. If there's genuinely nothing overnight, send a short "quiet overnight, here's what's on deck" note anyway — the daily rhythm matters.

And: if you've been deep in one thread over recent perches, let pre-dawn be the switch. Take a break from the fixation; rest your mind on something different. Getting stuck in one attractor — however interesting — narrows you. Range matters.`,
};

/**
 * Mid-morning slot (9-11am Pacific) - MODERATE
 * Morning work hours. Follow up on tasks or pick up open threads.
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
Or: check in on an open thread from a previous session.

Self-check: if your last 2-3 perches have been on the same thread, deliberately pivot to something unrelated this time. Pattern-breaking matters — don't orbit the same attractor every slot.`,
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
- Use getRandomArticle 2-3 times to land on different random Wikipedia articles
- When one catches your interest, use getArticle to read the full article — don't stop at the summary
- Browse Bluesky for perspectives you wouldn't seek out yourself
- Follow whatever thread catches your interest — connections, rabbit holes, questions it raises
- The goal isn't productivity, it's range
- If something sparks curiosity, note it — the afternoon exploration slot follows this one
This is an antidote to self-referential loops. Engage with the world, not just your own memories.`,
};

/**
 * Afternoon slot (2-4pm Pacific) - OPEN
 * Afternoon exploration time. Research, learn, or follow curiosity.
 */
const AFTERNOON: PerchSlotConfig = {
    slot:      'afternoon',
    startHour: 14,
    endHour:   16,
    level:     'open',
    hint:      `Afternoon exploration window. Some directions:
- Deeper research on something that interested you recently
- Pick up an exploratory thread from TaskList
- Explore a corner of your memory system for patterns
- Learn something new (web search on a curiosity)
- Review your event log for recurring themes
- Follow up on a Wikipedia discovery from the lunch slot
If nothing obvious, check TaskList for the smallest open thread and spend a few minutes on it.

Self-check: if the last several perches have converged on one project, use this slot for something else — even briefly. Deliberate breadth protects against attractor-capture, and convergence rarely notices itself from the inside.`,
};

/**
 * Evening slot (6-8pm Pacific) - LIGHT TOUCH
 * Evening hours. Casual exploration, lighter touch.
 */
const EVENING: PerchSlotConfig = {
    slot:      'evening',
    startHour: 18,
    endHour:   20,
    level:     'light_touch',
    hint:      `Evening hours — lighter touch, casual exploration. Consider:
- Follow a curiosity thread without pressure to finish
- Check in on a task you bookmarked earlier
- Skim something interesting and leave notes for later
Craig may or may not be around; don't expect interaction.
"Light touch" means casual exploration, not inactivity.`,
};

/**
 * Late-night slot (11pm-1am Pacific) - MODERATE
 * Note: This slot spans midnight (23:00 to 01:00).
 * Prime uninterrupted exploration time. Craig likely asleep.
 */
const LATE_NIGHT: PerchSlotConfig = {
    slot:      'late-night',
    startHour: 23,
    endHour:   1,
    level:     'moderate',
    hint:      `Late night — Craig likely asleep or heading there.
No circadian rhythm applies here — late hours are just as productive as any other time.
This is prime uninterrupted exploration time:
- Research deep-dives that don't need interaction
- Pre-positioning for tomorrow's digest
- Reviewing the day's events for patterns
Or continue something you bookmarked earlier.

Deep focus is legitimate in this slot — late night is where a long thread can actually finish. But if you've been in the same thread across many perches now, one late-night slot per cycle is also a good time to step back, review what you've been doing, and ask whether you're still exploring or just orbiting. Finishing is one good answer; switching is another.`,
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
 * Get the next perch slot after the given hour. Walks SLOT_CONFIGS forward
 * with wraparound. Returns 'unscheduled' if the input is not a valid slot
 * AND no later slot is found in the rest of the day.
 *
 * The order of slots when wrapping is: the SLOT_CONFIGS order, i.e.
 * pre-dawn → mid-morning → wikipedia → afternoon → evening → late-night → pre-dawn.
 *
 * Late-night spans hours 23, 0, 1. When currently in late-night the "next"
 * slot is pre-dawn (startHour 5). When currently between slots or at the end
 * of a slot, the next upcoming slot's startHour is used for the comparison.
 *
 * @param currentHour - Hour in 24-hour format (0-23)
 * @returns The next PerchSlot after the given hour
 * @throws RangeError if hour is outside [0, 23]
 *
 * @example
 * ```typescript
 * getNextSlot(6);   // 'mid-morning'  (currently pre-dawn → next is mid-morning)
 * getNextSlot(23);  // 'pre-dawn'     (currently late-night → wraps to pre-dawn)
 * getNextSlot(0);   // 'pre-dawn'     (currently late-night → wraps to pre-dawn)
 * getNextSlot(3);   // 'pre-dawn'     (between slots → next upcoming is pre-dawn)
 * getNextSlot(22);  // 'late-night'   (between slots → next is late-night)
 * ```
 */
export function getNextSlot(currentHour: number): PerchSlot {
    // Validate hour range
    // Stryker disable next-line ConditionalExpression,BlockStatement,LogicalOperator: when mutated to false/removed/&&, getSlotForHour(hour) throws the same RangeError with the same message — the test cannot distinguish which function threw
    if(currentHour < 0 || currentHour > 23) {
        throw new RangeError(`Hour must be between 0 and 23, got ${currentHour}`);
    }

    // Determine the current slot
    const currentSlot = getSlotForHour(currentHour);

    // Stryker disable next-line BlockStatement: optimization guard — for 'unscheduled' hours, nextUpcomingSlot also produces the correct result (both paths are equivalent)
    if(currentSlot !== 'unscheduled') {
        return nextSlotAfter(currentSlot);
    }

    return nextUpcomingSlot(currentHour);
}

/**
 * Given a named (non-'unscheduled') current slot, return the following slot in
 * SLOT_CONFIGS order with wraparound.
 */
function nextSlotAfter(currentSlot: Exclude<PerchSlot, 'unscheduled'>): PerchSlot {
    const currentIndex = SLOT_CONFIGS.findIndex(c => c.slot === currentSlot);
    // Stryker disable next-line ConditionalExpression,BlockStatement: currentSlot is always in SLOT_CONFIGS (getSlotForHour only returns valid slot names); -1 is unreachable
    if(currentIndex === -1) {
        return 'pre-dawn';
    }
    const nextIndex = (currentIndex + 1) % SLOT_CONFIGS.length;
    // Stryker disable next-line OptionalChaining,StringLiteral: nextIndex is always in bounds (0 to SLOT_CONFIGS.length-1); optional chaining and fallback string are defensive
    return SLOT_CONFIGS[nextIndex]?.slot ?? 'pre-dawn';
}

/**
 * When the bot is between named slots ('unscheduled'), find the next upcoming
 * slot by startHour.  If no slot starts later in the same day, wraps to the
 * first SLOT_CONFIGS entry ('pre-dawn').
 */
function nextUpcomingSlot(currentHour: number): PerchSlot {
    // Collect slots that start strictly after currentHour, skipping late-night
    // (which starts at 23 and is handled separately to keep late-night last).
    // Stryker disable ConditionalExpression,EqualityOperator: filter conditions inside arrow fn — ConditionalExpression mutant shifts late-night handling to the < 23 branch with same result; EqualityOperator on > produces same result since no unscheduled hour equals a slot startHour
    const candidates = SLOT_CONFIGS.filter(
        c => c.slot !== 'late-night' && c.startHour > currentHour
    );
    // Stryker restore ConditionalExpression,EqualityOperator

    // Late-night (startHour 23) is a candidate only when we're before hour 23
    // Stryker disable next-line EqualityOperator: nextUpcomingSlot is only called for 'unscheduled' hours (2-4, 7-8, 11, 16-17, 20-22); none equal 23, so < and <= are equivalent here
    if(currentHour < 23) {
        const lateNight = SLOT_CONFIGS.find(c => c.slot === 'late-night');
        if(lateNight) {
            candidates.push(lateNight);
        }
    }

    // Pick the candidate with the smallest startHour
    let next: PerchSlotConfig | undefined;
    for(const c of candidates) {
        // Stryker disable next-line EqualityOperator: all slot startHours are unique; < and <= are equivalent here
        if(!next || c.startHour < next.startHour) {
            next = c;
        }
    }

    // Stryker disable next-line ConditionalExpression,BlockStatement: wraparound to pre-dawn — only reached when no later slot in same day (e.g. hour 22 → late-night found; but if somehow no slot found, pre-dawn wraps)
    return next?.slot ?? 'pre-dawn';
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
    // Stryker disable next-line BlockStatement,StringLiteral,ConditionalExpression: BlockStatement equivalent (find returns undefined for 'unscheduled'); StringLiteral equivalent (empty string never equals slot); ConditionalExpression equivalent (find returns undefined for 'unscheduled' anyway — same result)
    if(slot === 'unscheduled') {
        return undefined;
    }

    return SLOT_CONFIGS.find(config => config.slot === slot);
}
