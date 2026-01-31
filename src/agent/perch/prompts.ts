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
 * Build the test perch prompt for a given time slot.
 * Wraps buildPerchPrompt with a test mode disclaimer.
 *
 * @param slot - The current time slot
 * @returns Complete test prompt string
 *
 * @example
 * ```typescript
 * const prompt = buildTestPerchPrompt('pre-dawn');
 * // Returns test disclaimer + base prompt + pre-dawn hint
 * ```
 */
export function buildTestPerchPrompt(slot: PerchSlot): string {
    const slotName = formatSlotName(slot);
    const basePrompt = buildPerchPrompt(slot);

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

    // Stryker disable next-line all: Unreachable exhaustiveness check
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- Unreachable exhaustiveness check
    throw new Error(`Unknown suggestion level: ${config.level}`);
}

/**
 * Options for building the perch interrupted prompt.
 */
export interface PerchInterruptedOptions {
    /** Partial work captured when perch was interrupted */
    partialWork: StreamProgress
    /** New message that interrupted the perch (for context only - already handled) */
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
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    // Stryker disable next-line StringLiteral: Prompt header text is product design
    sections.push('--- PERCH TIME INTERRUPTED ---');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    // Stryker disable next-line StringLiteral: Prompt explanation text is product design
    sections.push('You were in autonomous perch time when a new message arrived.');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');

    if(options.partialWork.thinking) {
        sections.push('[Your thinking at interruption:]');
        sections.push(options.partialWork.thinking);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    if(options.partialWork.text) {
        sections.push('[You were composing:]');
        sections.push(options.partialWork.text);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    if(options.partialWork.pendingToolUse) {
        sections.push(`[You were about to use "${options.partialWork.pendingToolUse.name}"]`);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    // Stryker disable next-line StringLiteral: Prompt section header is product design
    sections.push('--- NEW MESSAGE ---');
    sections.push(`From: ${options.newMessage.author} in #${options.newMessage.channelName}`);
    sections.push(options.newMessage.content);
    // Stryker disable next-line StringLiteral: Section separator is product design
    sections.push('---');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    sections.push('## What To Do');
    sections.push('1. Create a task for this incoming message (so it doesn\'t get lost)');
    sections.push('2. Check TaskList to see what you were working on before the interruption');
    // Stryker disable next-line StringLiteral: Prompt instruction text is product design
    sections.push('3. Prioritize: handle the message now, or finish perch work first - your call');
    // Stryker disable next-line StringLiteral: Prompt instruction text is product design
    sections.push('4. Work through tasks systematically, updating status as you go');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    sections.push('The sender is online right now, which you can factor into prioritization.');
    sections.push('Trust TaskList as your source of truth - sessions are transient, tasks are durable.');

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
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    // Stryker disable next-line StringLiteral: Prompt header text is product design
    sections.push('--- PERCH SESSION TIMEOUT ---');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    sections.push(`Your perch time session has been running for ${options.sessionDuration} minutes (max: ${options.maxSessionMinutes} minutes).`);
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');
    // Stryker disable next-line StringLiteral: Prompt instruction text is product design
    sections.push('This perch slot is ending soon. Please wrap up what you\'re doing:');
    sections.push('- Save any important thoughts or findings to memory');
    // Stryker disable next-line StringLiteral: Prompt instruction text is product design
    sections.push('- Complete any in-progress work if quick, otherwise note where you left off');
    // Stryker disable next-line StringLiteral: Prompt instruction text is product design
    sections.push('- Don\'t start new explorations');
    // Stryker disable next-line StringLiteral: Empty string for formatting
    sections.push('');

    if(options.partialWork.thinking) {
        sections.push('[Your thinking at timeout:]');
        sections.push(options.partialWork.thinking);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    if(options.partialWork.text) {
        sections.push('[You were composing:]');
        sections.push(options.partialWork.text);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    if(options.partialWork.pendingToolUse) {
        sections.push(`[You were about to use "${options.partialWork.pendingToolUse.name}"]`);
        // Stryker disable next-line StringLiteral: Empty string for formatting
        sections.push('');
    }

    sections.push('Please finalize and conclude this perch session.');

    return sections.join('\n');
}
