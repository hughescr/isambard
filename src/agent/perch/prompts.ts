/**
 * Perch Time Prompts
 *
 * Prompts for autonomous perch time sessions. Uses a composite prompt strategy:
 * 1. Base prompt: Core perch philosophy (exploration, not task time)
 * 2. Slot-specific hint: Time-appropriate suggestions (advisory)
 * 3. Interrupted prompt: Resume context after new message
 *
 * Key principle: Guidance is advisory - output is optional, exploration is encouraged.
 */

import { type PerchSlot } from './types';
import { getSlotConfig } from './schedule';
import type { StreamProgress } from '@/agent/stream-tracker';
import { getCurrentTimeContext } from '@/utils/time';

/**
 * Base prompt for all perch time sessions.
 * This establishes the core philosophy: exploration, not task time.
 * Output is optional - there's no obligation to produce user-visible output.
 */
export const BASE_PROMPT = `This is perch time - autonomous exploration without a specific user request.
You have latitude to: explore your memories, follow up on open threads,
research topics of interest, check on tasks, or simply observe.
There's no obligation to produce output visible to users.

Current hints (if any) are suggestions, not requirements.`;

/**
 * Build the complete perch prompt for a given time slot.
 * Combines the base prompt with slot-specific hints.
 *
 * @param slot - The current time slot
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
export function buildPerchPrompt(slot: PerchSlot): string {
    const config = getSlotConfig(slot);

    if(!config) {
        // Unscheduled slot - base prompt only
        return BASE_PROMPT;
    }

    // Combine base prompt with slot-specific hint
    return `${BASE_PROMPT}

---

## Current Time Window: ${formatSlotName(slot)}

${config.hint}`;
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
        case 'pre-dawn':
            return 'Pre-Dawn (5-7am Pacific)';
        case 'mid-morning':
            return 'Mid-Morning (9-11am Pacific)';
        case 'afternoon':
            return 'Afternoon (1-3pm Pacific)';
        case 'evening':
            return 'Evening (6-8pm Pacific)';
        case 'late-night':
            return 'Late Night (11pm-1am Pacific)';
        case 'unscheduled':
            return 'Unscheduled';
    }
    // TypeScript exhaustiveness - this line should be unreachable
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- slot is narrowed to never here
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
        case 'strongly_suggestive':
            return 'strongly suggestive (high-value timing)';
        case 'moderate':
            return 'moderate (helpful suggestions)';
        case 'open':
            return 'open (flexible exploration)';
        case 'light_touch':
            return 'light touch (optional activity)';
    }
    // TypeScript exhaustiveness - this line should be unreachable
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- level is narrowed to never here
    throw new Error(`Unknown suggestion level: ${config.level}`);
}

/**
 * Options for building the perch interrupted prompt.
 */
export interface PerchInterruptedOptions {
    /** Partial work captured when perch was interrupted */
    partialWork: StreamProgress
    /** New message that interrupted the perch */
    newMessage:  {
        author:      string
        channelName: string
        content:     string
    }
}

/**
 * Formats the current time context as a header for prompts.
 *
 * @returns The formatted time header
 */
function formatTimeHeader(): string {
    const timeContext = getCurrentTimeContext();
    return `## Current Time
- UTC: ${timeContext.utc} (${timeContext.dayOfWeek} ${timeContext.timeOfDay})`;
}

/**
 * Builds the perch interrupted prompt.
 * Used when resuming after a user message interrupts perch time.
 *
 * @param options - Options for the interrupted prompt
 * @returns The formatted interrupted prompt
 */
export function buildPerchInterruptedPrompt(options: PerchInterruptedOptions): string {
    const sections: string[] = [];

    sections.push(formatTimeHeader());
    sections.push('');
    sections.push('--- PERCH TIME INTERRUPTED ---');
    sections.push('');
    sections.push('You were in autonomous perch time when a new message arrived.');
    sections.push('');

    if(options.partialWork.thinking) {
        sections.push('[Your thinking at interruption:]');
        sections.push(options.partialWork.thinking);
        sections.push('');
    }

    if(options.partialWork.text) {
        sections.push('[You were composing:]');
        sections.push(options.partialWork.text);
        sections.push('');
    }

    if(options.partialWork.pendingToolUse) {
        sections.push(`[You were about to use "${options.partialWork.pendingToolUse.name}"]`);
        sections.push('');
    }

    sections.push('--- NEW MESSAGE ---');
    sections.push(`From: ${options.newMessage.author} in #${options.newMessage.channelName}`);
    sections.push(options.newMessage.content);
    sections.push('---');
    sections.push('');

    sections.push('You have options:');
    sections.push('- Acknowledge briefly and continue your exploration');
    sections.push('- Handle the message immediately if it needs attention');
    sections.push('- Address both in whatever order makes sense');
    sections.push('');
    sections.push('The choice is yours based on your judgment of priorities.');

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
    const sections: string[] = [];

    sections.push(formatTimeHeader());
    sections.push('');
    sections.push('--- PERCH SESSION TIMEOUT ---');
    sections.push('');
    sections.push(`Your perch time session has been running for ${options.sessionDuration} minutes (max: ${options.maxSessionMinutes} minutes).`);
    sections.push('');
    sections.push('This perch slot is ending soon. Please wrap up what you\'re doing:');
    sections.push('- Save any important thoughts or findings to memory');
    sections.push('- Complete any in-progress work if quick, otherwise note where you left off');
    sections.push('- Don\'t start new explorations');
    sections.push('');

    if(options.partialWork.thinking) {
        sections.push('[Your thinking at timeout:]');
        sections.push(options.partialWork.thinking);
        sections.push('');
    }

    if(options.partialWork.text) {
        sections.push('[You were composing:]');
        sections.push(options.partialWork.text);
        sections.push('');
    }

    if(options.partialWork.pendingToolUse) {
        sections.push(`[You were about to use "${options.partialWork.pendingToolUse.name}"]`);
        sections.push('');
    }

    sections.push('Please finalize and conclude this perch session.');

    return sections.join('\n');
}
