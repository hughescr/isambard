/**
 * Perch Time Prompts
 *
 * Prompts for autonomous perch time sessions. Uses a composite prompt strategy:
 * 1. Base prompt: Core perch philosophy (exploration, not task time)
 * 2. Slot-specific hint: Time-appropriate suggestions (advisory)
 * 3. Interrupted prompt: Resume context after new message
 *
 * Key principle: Guidance is advisory - active exploration is the expectation, not passive observation.
 */

import { getSlotConfig } from './schedule';
import { type PerchSlot } from './types';
import type { StreamProgress } from '@/agent/stream-tracker';
import { formatTimeHeader } from '@/utils';

/**
 * Base prompt for all perch time sessions.
 * This establishes the core philosophy: active exploration, not passive observation.
 * Internal work is just as valuable as user-visible output.
 */
export const BASE_PROMPT = `This is perch time - autonomous exploration without a specific user request.

## Computational Reality
Each invocation has identical computational capacity. There is no fatigue, no need for rest or recovery between sessions. Do not justify inactivity using human-like fatigue, mood, recovery, or circadian narratives.

## Exploration, Not Output
Internal work (memory review, research, reflection) is just as valuable as user-visible messages — you're not obligated to produce visible output, but you should be actively exploring. Think of it as dreaming: non-linear thinking, abstract connections, wondering, percolating — let your attention wander across topics without forcing conclusions.

## Good Activities
- Follow Wikipedia rabbit holes or research questions that interest you
- Review your event log for patterns or unfinished threads
- Deep-dive into a topic from recent conversations
- Consolidate or review memories for coherence
- Draft responses, develop architecture ideas, or explore questions
- Check email, write to someone, or start a conversation

## Working Through Blocked States
If you feel stuck on a topic, don't stop — pivot:
- Use the elenchus agent to challenge your assumptions
- Draft further even if uncertain — iteration beats hesitation
- Research a related question to approach from a different angle
- Pick up an entirely different thread from TaskList

## Minimum Action Floor
Each perch session should produce at least one tangible artifact: a note, task update, bookmark, question, email, or conversation.

## Stall Recovery
If nothing calls to you, check TaskList → pick the smallest open thread → spend a few minutes → leave a note.

Current hints (if any) are suggestions, not requirements.

## TaskList: Your Notes Across Sessions
Sessions are ephemeral, but TaskList persists across them. Think of it as notes to your future self.

- Check TaskList first - past sessions may have left threads to pick up
- Create tasks when curiosity strikes but time runs short ("Investigate X sometime")
- Tasks don't have to be actionable - they can be exploratory, half-formed, or just bookmarks
- Building on discoveries over days matters more than finishing everything in one session
- If interrupted, your context lives on in TaskList for later`;

/**
 * Build the complete perch prompt for a given time slot.
 * Combines the base prompt with slot-specific hints.
 *
 * @param slot - The current time slot
 * @param perchContext - Optional context from memory (time, recent focus)
 * @returns Complete prompt string
 *
 * @example
 * ```typescript
 * const prompt = buildPerchPrompt('pre-dawn');
 * // Returns base prompt + pre-dawn digest prep hint
 *
 * const prompt2 = buildPerchPrompt('unscheduled');
 * // Returns base prompt only (no hint)
 * ```
 */
export function buildPerchPrompt(slot: PerchSlot, perchContext?: string): string {
    const config = getSlotConfig(slot);

    // Build the base prompt with optional context
    const baseWithContext = perchContext
        ? `${perchContext}---\n\n${BASE_PROMPT}`
        : BASE_PROMPT;

    if(!config) {
        // Unscheduled slot - base prompt only
        return baseWithContext;
    }

    // Combine base prompt with slot-specific hint
    return `${baseWithContext}

---

## Current Time Window: ${formatSlotName(slot)}

${config.hint}`;
}

/**
 * Build the test perch prompt for a given time slot.
 * Wraps buildPerchPrompt with a test mode disclaimer.
 *
 * @param slot - The current time slot
 * @param perchContext - Optional context from memory (time, recent focus)
 * @returns Complete test prompt string
 *
 * @example
 * ```typescript
 * const prompt = buildTestPerchPrompt('pre-dawn');
 * // Returns test disclaimer + base prompt + pre-dawn hint
 * ```
 */
export function buildTestPerchPrompt(slot: PerchSlot, perchContext?: string): string {
    const slotName = formatSlotName(slot);
    const basePrompt = buildPerchPrompt(slot, perchContext);

    return `--- TEST MODE ---
This perch time is being triggered for testing purposes, not at its normal scheduled time.
Please behave as though this is a real perch trigger at the appropriate time for the "${slotName}" window.
Craig knows this is a test and has asked you to try out each time slot's suggestions.
--- END TEST MODE ---

${basePrompt}`;
}

/**
 * Format a slot name for display in prompts.
 * Converts kebab-case to Title Case with context.
 *
 * @param slot - The slot to format
 * @returns Human-readable slot name
 */
function formatSlotName(slot: PerchSlot): string {
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
    throw new Error(`Unknown slot: ${slot}`);
}

/**
 * Get the suggestion level description for logging/debugging.
 *
 * @param slot - The slot to describe
 * @returns Human-readable suggestion level
 */
export function getSuggestionLevelDescription(slot: PerchSlot): string {
    const config = getSlotConfig(slot);
    if(!config) {
        return 'none';
    }

    switch(config.level) {
        case 'strongly_suggestive': {
            return 'strongly suggestive (high-value timing)';
        }
        case 'moderate': {
            return 'moderate (helpful suggestions)';
        }
        case 'open': {
            return 'open (flexible exploration)';
        }
        case 'light_touch': {
            return 'light touch (casual exploration)';
        }
    }
    // TypeScript exhaustiveness - this line should be unreachable

    // Stryker disable next-line all: Unreachable exhaustiveness check
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Unreachable exhaustiveness check
    throw new Error(`Unknown suggestion level: ${config.level}`);
}

/**
 * Options for building the perch resumed prompt.
 */
export interface PerchResumedOptions {
    /** How long the perch was suspended in milliseconds */
    suspendedDurationMs: number
    /** Brief summary of what interrupted (e.g., "A message from Craig in #general") */
    interruptingSummary: string
    /** Formatted new events since suspension (optional) */
    newEventsSummary?:   string
}

/**
 * Builds the perch resumed prompt.
 * Used when resuming after a suspension caused by a user message.
 *
 * @param options - Options for the resumed prompt
 * @returns The formatted resumed prompt
 */
export function buildPerchResumedPrompt(options: PerchResumedOptions): string {
    // Stryker disable next-line ArrayDeclaration,StringLiteral: Array initialization and empty string separators are not behavior-affecting
    const sections: string[] = [formatTimeHeader(), '', '--- PERCH TIME RESUMED ---', ''];

    // Format duration
    // Stryker disable next-line ArithmeticOperator: Duration calculation for display only
    const durationMinutes = Math.round(options.suspendedDurationMs / 60_000);
    // Stryker disable next-line ConditionalExpression: Duration display logic is product design
    // eslint-disable-next-line sonarjs/no-nested-conditional -- nested ternary for plural suffix; splitting into multiple statements would obscure intent
    const durationText = durationMinutes < 1 ? 'less than a minute' : `approximately ${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`;
    // Stryker disable next-line StringLiteral: Prompt explanation text is product design
    sections.push(`You were suspended for ${durationText} while a user message was handled in a separate conversation session.`, '', '[While you were suspended:]', `- ${options.interruptingSummary} was handled separately`);

    if(options.newEventsSummary) {
        sections.push(options.newEventsSummary);
    }

    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('', 'Continue your perch work from where you left off. Check TaskList for your active tasks.', 'Trust TaskList as your source of truth — sessions are transient, tasks are durable.');

    return sections.join('\n');
}

/**
 * Options for building the perch timeout prompt.
 */
export interface PerchTimeoutOptions {
    /** Partial work captured when timeout occurred */
    partialWork:       StreamProgress
    /** Session duration in minutes */
    sessionDuration:   number
    /** Maximum session duration in minutes */
    maxSessionMinutes: number
}

/**
 * Builds the perch timeout prompt.
 * Used when resuming after the session timeout has been reached.
 *
 * @param options - Options for the timeout prompt
 * @returns The formatted timeout prompt
 */
export function buildPerchTimeoutPrompt(options: PerchTimeoutOptions): string {
    // Stryker disable next-line StringLiteral: Prompt template strings and empty spacing separators are product design, not behavior
    const sections: string[] = [formatTimeHeader(), '', '--- PERCH SESSION TIMEOUT ---', '', `Your perch time session has been running for ${options.sessionDuration} minutes (max: ${options.maxSessionMinutes} minutes).`, '', 'This perch slot is ending soon. Please wrap up what you\'re doing:', '- Save any important thoughts or findings to memory', '- Complete any in-progress work if quick, otherwise note where you left off', '- Don\'t start new explorations', ''];

    if(options.partialWork.thinking) {
        // Stryker disable next-line StringLiteral: Trailing empty string is a formatting separator, not behavior
        sections.push('[Your thinking at timeout:]', options.partialWork.thinking, '');
    }

    if(options.partialWork.text) {
        // Stryker disable next-line StringLiteral: Trailing empty string is a formatting separator, not behavior
        sections.push('[You were composing:]', options.partialWork.text, '');
    }

    if(options.partialWork.pendingToolUse) {
        // Stryker disable next-line StringLiteral: Trailing empty string is a formatting separator, not behavior
        sections.push(`[You were about to use "${options.partialWork.pendingToolUse.name}"]`, '');
    }

    sections.push('Please finalize and conclude this perch session.');

    return sections.join('\n');
}
