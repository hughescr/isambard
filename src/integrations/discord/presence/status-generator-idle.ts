/**
 * Idle Status Generator
 *
 * Generates creative, personality-driven Discord status text using Claude Haiku.
 * This is async and may fail - provides graceful fallbacks.
 */

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import type { ActivitiesOptions, ActivityType } from 'discord.js';
import { renderPrefixedText } from './presence-view.js';
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
   * With no `options` (or `options.prefix` omitted), behaves exactly as before: a `'💤 '`
   * emoji prefix and a 128-code-unit budget. When `options.prefix` is given (the P11 composed
   * presence prefix), that prefix is rendered in full and never truncated; the generated text is
   * word-boundary-truncated to whatever budget remains out of Discord's 128-code-unit limit
   * (after the prefix, a ` • ` separator, and — when `options.compacting` — a `'compacting'`
   * marker), and dropped entirely when fewer than 12 code units would remain for it.
   *
   * @param options - Optional composed prefix and compacting marker (P11)
   * @returns Discord activity configuration
   */
    generate(options?: IdleStatusOptions): Promise<ActivitiesOptions>
}

/** Optional composed-prefix inputs to {@link IdleStatusGenerator.generate} (P11). */
export interface IdleStatusOptions {
    /** The composed presence prefix (session indicators + task counts), rendered in full. */
    prefix?:     string
    /** When true, a `'compacting'` marker is inserted between the prefix and the digest. */
    compacting?: boolean
}

/**
 * Dependencies for creating an idle status generator.
 */
export interface IdleStatusGeneratorDeps {
    /** Logger instance for structured logging */
    logger: {
        debug: (message: unknown, ...args: unknown[]) => void
        info:  (message: unknown, ...args: unknown[]) => void
        warn:  (message: unknown, ...args: unknown[]) => void
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
 * Static instructions block — contains signal-menu vibe guidance and output rules.
 * This block precedes the SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel along with the
 * static prefix, making the entire system prompt eligible for cross-session caching.
 * Per-call dynamic content (signals menu, previous-status block) lives in the user
 * prompt, not here.
 */
const SYSTEM_PROMPT_INSTRUCTIONS = `## The Vibe
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

/** Discord's custom-status length limit, in UTF-16 code units (`.length`). */
const PRESENCE_BUDGET = 128;

/**
 * The status text used when a generation produced nothing and there is no previous status to keep
 * showing. Matches the text of the hardcoded `'💤 Idle'` thrown-error fallback below, so the two
 * degraded paths look the same to anyone reading the presence.
 */
const DEFAULT_IDLE_TEXT = 'Idle';

/**
 * Deadline for the idle-status Haiku call, overriding `text-generator`'s 15s default.
 *
 * A boot-time call measured at ~16s was cut off by that default and returned `''`, which this
 * module then composed and applied as a status with no body. The generation is entirely
 * best-effort and nothing waits on it, so waiting twice as long costs nothing and removes the
 * most common source of empty results.
 */
const IDLE_GENERATION_TIMEOUT_MS = 30_000;

/** The result of composing one idle-status render: the final name, and the digest actually used (if any). */
interface ComposedIdleStatus {
    name:        string
    digestText?: string
}

/** Unchanged pre-P11 behaviour: a bare `'💤 '` prefix and a 128-code-unit budget for the whole thing. */
function composeDefaultIdleStatus(rawText: string): ComposedIdleStatus {
    // Reserve space for emoji prefix
    // Discord limit is 128 code units (.length property)
    // "💤 " is 3 code units (2 for emoji surrogate pair + 1 for space)
    const emojiPrefix = '💤 ';
    const maxLength = PRESENCE_BUDGET - emojiPrefix.length;
    const statusText = truncateToWordBoundary(rawText, maxLength);
    return { name: `${emojiPrefix}${statusText}`, digestText: statusText };
}

/** The composed prefix plus, when compacting, the `'compacting'` marker — never truncated. */
function composeIdleBase(prefix: string, compacting: boolean): string {
    return renderPrefixedText(prefix, compacting, undefined).name;
}

/**
 * P11 composed-prefix behaviour: `prefix` (and, when compacting, the `'compacting'` marker) is
 * rendered in full and never truncated; the generated text is word-boundary-truncated to
 * whatever budget remains, and dropped entirely (no digest at all) when too little budget would
 * remain for it — see {@link renderPrefixedText}, shared with the active-phase render path so the
 * two never drift apart on the budget/separator/truncation rules.
 */
function composePrefixedIdleStatus(prefix: string, compacting: boolean, rawText: string): ComposedIdleStatus {
    return renderPrefixedText(prefix, compacting, rawText);
}

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
     * System prompt is a string array with SYSTEM_PROMPT_DYNAMIC_BOUNDARY at the end
     * so the entire system prompt (static prefix + instructions) is eligible for
     * cross-session Anthropic prompt caching.  Per-call dynamic content (signals menu,
     * previous-status block) lives in the user prompt.
     */
    async function buildLiveSignalsPrompts(identity: string): Promise<{ systemPrompt: string[], userPrompt: string }> {
        // getLiveSignals is always defined when this function is called (guarded by if(getLiveSignals) at call site)
        // boundary cast: TypeScript cannot narrow the closure-captured optional based on the outer if-guard
        const signals = await getLiveSignals!();

        // Both static prefix and instructions precede the boundary — all fully cacheable.
        // SYSTEM_PROMPT_DYNAMIC_BOUNDARY at the end signals that nothing follows it (all dynamic
        // content is in the user prompt).
        const staticPrefix = SYSTEM_PROMPT_STATIC_PREFIX.replace('{identityContext}', identity);
        const systemPrompt = [staticPrefix, SYSTEM_PROMPT_INSTRUCTIONS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];

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
        const systemPrompt = `${staticPrefix}\n\n${SYSTEM_PROMPT_INSTRUCTIONS}`;

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

    /**
     * The text to actually compose into the status.
     *
     * An empty generation (the deadline firing, an abort, or a model that returned nothing) must
     * never be applied: composing it produced a status that was all prefix and no thought. Instead
     * the last status this generator produced keeps standing — the same "refuse it rather than
     * cache it" stance {@link import('./status-generator-dynamic').rejectSynopsis} takes for a
     * response it would not want to show, reached here by keeping the previous value rather than
     * by returning null (this generator has no caller-side skip to return into: it must produce an
     * activity every time).
     *
     * @param rawText - The trimmed generated text
     * @returns `rawText` when it has content, else the cached previous status, else {@link DEFAULT_IDLE_TEXT}
     */
    function resolveIdleText(rawText: string): string {
        if(rawText !== '') {
            return rawText;
        }
        const previous = getPreviousStatus?.();
        const fallback = previous !== undefined && previous.trim() !== '' ? previous : DEFAULT_IDLE_TEXT;
        logger.warn({ usedPreviousStatus: fallback === previous }, 'Idle status generation produced no text');
        return fallback;
    }

    return {
        // Stryker disable StringLiteral,ObjectLiteral: Prompt template building and logging for status generation
        async generate(options?: IdleStatusOptions): Promise<ActivitiesOptions> {
            try {
                logger.debug('Generating idle status with Haiku');

                const identity = await identityContext();

                const { systemPrompt, userPrompt } = getLiveSignals
                    ? await buildLiveSignalsPrompts(identity)
                    : await buildLegacyPrompts(identity);

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true, timeoutMs: IDLE_GENERATION_TIMEOUT_MS, label: 'idle-status' });
                // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
                const rawText = resolveIdleText(text.trim());

                const { name: finalStatus, digestText } = options?.prefix === undefined
                    ? composeDefaultIdleStatus(rawText)
                    : composePrefixedIdleStatus(options.prefix, options.compacting ?? false, rawText);

                logger.info({ statusText: finalStatus }, 'Generated idle status');

                // Persist the generated text so the next refresh sees it in anti-rut block.
                // Nothing to persist when the digest was dropped entirely for lack of budget.
                if(digestText !== undefined) {
                    setPreviousStatus?.(digestText);
                }

                return { name: finalStatus, type: activityType };
            } catch (error) {
                logger.error({ error }, 'Failed to generate idle status, using fallback');
                // P11: a composed prefix (task counts, compacting marker) must survive a Haiku
                // failure — dropping straight to the bare '💤 Idle' silently hid the task counts
                // for as long as generation kept failing. Only the truly prefix-less legacy path
                // (no options.prefix — pre-P11 callers) still gets the hardcoded fallback.
                const name = options?.prefix === undefined ? '💤 Idle' : composeIdleBase(options.prefix, options.compacting ?? false);
                return { name, type: activityType };
            }
        },
        // Stryker restore StringLiteral,ObjectLiteral
    };
}
