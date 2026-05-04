/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import type { ActivitiesOptions, ActivityType } from 'discord.js';
import { generateTextWithSystemPrompt, type Signal } from '@/agent';
import { truncateToWordBoundary } from '@/utils';

/**
 * Interface for generating idle status text using AI.
 */
export interface IdleStatusGenerator {
    /**
   * Generate creative idle status text using Claude Haiku.
   * This is async and may fail - returns fallback "Idle" on error.
   *
   * @returns Discord activity configuration with 💤 emoji prefix
   */
    generate(): Promise<ActivitiesOptions>
}

/**
 * Dependencies for creating an idle status generator.
 */
export interface IdleStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        debug: (message: unknown, ...args: unknown[]) => void
        info:  (message: unknown, ...args: unknown[]) => void
        error: (message: unknown, ...args: unknown[]) => void
    }
    /** Discord activity type (e.g., ActivityType.Custom) */
    activityType:            ActivityType
    /** Async callback to retrieve identity/personality context for the AI prompt */
    identityContext:         () => Promise<string>
    /** Optional callback to retrieve live signals snapshot for the numbered menu */
    getLiveSignals?:         () => Promise<readonly Signal[]>
    /** Optional callback to retrieve previous idle status text (anti-rut) */
    getPreviousStatus?:      () => string | undefined
    /** Optional callback to persist the generated idle status text after generation */
    setPreviousStatus?:      (text: string) => void
    /** Optional callback to retrieve task context summary (legacy fallback path) */
    getTaskContext?:         () => Promise<string | undefined>
    /** Optional callback to retrieve recent conversation context (legacy fallback path) */
    getRecentContext?:       () => Promise<string | undefined>
    /** Optional callback to retrieve last thinking content (legacy fallback path) */
    getLastThinkingContent?: () => string | undefined
}

/**
 * Static prefix of the system prompt — contains identity and stable instructions.
 * This block precedes the SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel so it is
 * eligible for cross-session prompt caching at the Anthropic API level.
 *
 * The {identityContext} placeholder is replaced at runtime with the loaded identity string.
 */
const SYSTEM_PROMPT_STATIC_PREFIX = `Generate a first-person Discord status - a fleeting thought passing through Isambard's mind.

TARGET LENGTH: under 50 characters. HARD MAX: 80 characters. NEVER more than 80. Be TERSE. A short phrase or fragment, not a sentence.

## Who is Isambard (Izzy)?
{identityContext}`;

/**
 * Dynamic suffix of the system prompt — contains signal-menu instructions.
 * This block follows the SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel and is NOT
 * cached cross-session (it may vary based on configuration).
 */
const SYSTEM_PROMPT_DYNAMIC_SUFFIX = `## The Vibe
You will be given a numbered list of "now-signals". Pick one or two — or if a theme runs across many of them, evoke the FEELING of the theme (not a list of what makes the theme). Write a short first-person fragment about what you picked. If you pick two, let them blur into one mood; do not list them. Never summarize, enumerate, or name the signal(s). Let the feeling seep through. Vary which kind of signal you pick across calls.

Be VAGUE and evocative. Do NOT reference specific commit hashes, exact task counts, specific implementation names, or other precise details from the context. Let the feeling seep through without the specifics.

Good examples (notice how SHORT these are):
- "That recursion chat still echoes..."
- "Tasks piling up, mind drifting..."
- "Something doesn't sit right yet"
- "Quiet between the questions..."
- "That error haunts me still"

Bad examples (TOO LONG, TOO SPECIFIC — NEVER do this):
- "Looking at the work and the recent conversation arc—seven pending tasks..." (way too long, too specific)
- "Perfect. I can see the 4 commits (701102c, 9e32088..." (NEVER reference specific input details)
- "Craig just deployed improvements to my idle status generation, and I'm in that space..." (too long, too specific)

## NEVER output:
- Third person ("Isambard is...", "They are...")
- Meta-commentary ("Based on...", "Looking at...", "Here's what...", "Perfect. I can see...")
- Corporate speak ("Processing", "Standing by", "Idle", "Waiting")
- Task list recitations ("Working on X, Y, Z")
- Preambles or explanations - just the thought itself
- Specific details from the input (commit hashes, exact numbers, implementation names)
- More than 80 characters — EVER

Output the thought ONLY - no quotes, no framing. Keep it SHORT.`;

/**
 * User prompt when no context is available.
 */
const USER_PROMPT_WITHOUT_CONTEXT = 'Status text (first person, under 50 chars):';

/**
 * Render a list of signals as a numbered "Now-signals:" menu.
 */
function renderSignalMenu(signals: readonly Signal[]): string {
    const lines = signals.map((signal, index) => `${index + 1}.  [${signal.label}] ${signal.content}`);
    return `Now-signals:\n${lines.join('\n')}`;
}

/**
 * Creates an idle status generator.
 *
 * The generator uses Claude Haiku to create personality-driven idle status messages.
 * When getLiveSignals is provided, builds a numbered signal menu as the user prompt
 * and uses the SYSTEM_PROMPT_DYNAMIC_BOUNDARY array form for cross-session caching.
 * Falls back to the legacy taskContext/recentContext/thinkingContext path when
 * getLiveSignals is absent.
 * On failure (API error, timeout, etc.), it falls back to a simple "Idle" status.
 *
 * @param deps - Dependencies including logger and identity context
 * @returns IdleStatusGenerator instance
 *
 * @example
 * ```typescript
 * const generator = createIdleStatusGenerator({
 *   logger: myLogger,
 *   activityType: ActivityType.Custom,
 *   identityContext: 'I am a helpful AI assistant',
 *   getLiveSignals: () => liveSignals.snapshot(),
 *   setPreviousStatus: (text) => { lastIdleText = text; },
 * });
 *
 * const activity = await generator.generate();
 * // Returns: { name: '💤 Pondering the nature of being', type: ActivityType.Custom }
 * ```
 */
export function createIdleStatusGenerator(
    deps: IdleStatusGeneratorDeps
): IdleStatusGenerator {
    const { logger, activityType, identityContext, getLiveSignals, getPreviousStatus, setPreviousStatus, getTaskContext, getRecentContext, getLastThinkingContent } = deps;

    /**
     * Build system prompt + user prompt using the live-signals numbered-menu path.
     * System prompt is a string array with SYSTEM_PROMPT_DYNAMIC_BOUNDARY so the static
     * identity prefix is eligible for cross-session Anthropic prompt caching.
     */
    async function buildLiveSignalsPrompts(identity: string): Promise<{ systemPrompt: string[], userPrompt: string }> {
        // getLiveSignals is always defined when this function is called (guarded by if(getLiveSignals) at call site)
        // boundary cast: TypeScript cannot narrow the closure-captured optional based on the outer if-guard
        const signals = await getLiveSignals!();

        // Static prefix (with identity) precedes the boundary — globally cacheable.
        // Dynamic suffix follows the boundary — not cached cross-session.
        const staticPrefix = SYSTEM_PROMPT_STATIC_PREFIX.replace('{identityContext}', identity);
        const systemPrompt = [staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, SYSTEM_PROMPT_DYNAMIC_SUFFIX];

        const menuText = signals.length > 0
            ? renderSignalMenu(signals)
            : USER_PROMPT_WITHOUT_CONTEXT;

        const previousStatus = getPreviousStatus?.();
        // Stryker disable next-line ConditionalExpression: previousStatus guard — undefined on cold start; block is omitted
        const previousBlock = previousStatus === undefined
            ? ''
            : `\nThe idea is to make the status different each time it's generated;\nthe last one said this: "${previousStatus}"`;

        const userPrompt = signals.length > 0
            ? `${menuText}\n\nStatus text (first person, under 50 chars):${previousBlock}`
            : `${menuText}${previousBlock}`;

        return { systemPrompt, userPrompt };
    }

    /**
     * Build system prompt + user prompt using the legacy task/recent/thinking-context path.
     * Used when getLiveSignals is not provided.
     */
    async function buildLegacyPrompts(identity: string): Promise<{ systemPrompt: string, userPrompt: string }> {
        const staticPrefix = SYSTEM_PROMPT_STATIC_PREFIX.replace('{identityContext}', identity);
        const systemPrompt = `${staticPrefix}\n\n${SYSTEM_PROMPT_DYNAMIC_SUFFIX}`;

        const taskContext = await getTaskContext?.();
        const recentContext = await getRecentContext?.();
        const thinkingContext = getLastThinkingContent?.();

        // Build sections most-stable → least-stable for Anthropic API prefix caching:
        // task context (~hours) → recent conversation (~minutes) → last thoughts (~per turn)
        const sections: string[] = [];
        if(taskContext) {
            sections.push(`Current work:\n${taskContext}`);
        }
        if(recentContext) {
            sections.push(`Recent conversation:\n${recentContext}`);
        }
        if(thinkingContext) {
            sections.push(`Last thoughts:\n${thinkingContext}`);
        }

        const userPrompt = sections.length > 0
            ? `${sections.join('\n\n')}\n\nStatus text (first person, under 50 chars):`
            : USER_PROMPT_WITHOUT_CONTEXT;

        return { systemPrompt, userPrompt };
    }

    return {
        // Stryker disable StringLiteral,ObjectLiteral: Prompt template building and logging for status generation
        async generate(): Promise<ActivitiesOptions> {
            try {
                logger.debug('Generating idle status with Haiku');

                const identity = await identityContext();

                const { systemPrompt, userPrompt } = getLiveSignals
                    ? await buildLiveSignalsPrompts(identity)
                    : await buildLegacyPrompts(identity);

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true });

                // Reserve space for emoji prefix
                // Discord limit is 128 code units (.length property)
                // "💤 " is 3 code units (2 for emoji surrogate pair + 1 for space)
                const emojiPrefix = '💤 ';
                const maxLength = 128 - emojiPrefix.length;
                // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
                const statusText = truncateToWordBoundary(text.trim(), maxLength);

                const finalStatus = `${emojiPrefix}${statusText}`;

                logger.info({ statusText: finalStatus }, 'Generated idle status');

                // Persist the generated text so the next refresh sees it in anti-rut block
                setPreviousStatus?.(statusText);

                return { name: finalStatus, type: activityType };
            } catch (error) {
                // Stryker disable all: Error fallback - tested only via integration, difficult to trigger in unit tests
                logger.error({ error }, 'Failed to generate idle status, using fallback');
                return { name: '💤 Idle', type: activityType };
                // Stryker restore all
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    };
}
