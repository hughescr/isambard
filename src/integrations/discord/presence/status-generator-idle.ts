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
   * A generation that is empty, multiline, over 80 characters, or shaped like reasoning/planning
   * narration rather than a status (see {@link rejectIdleStatusText}) is refused outright and
   * replaced with the last known-good status (itself re-validated) or `'Idle'` — never truncated
   * to fit, since truncating a runaway narration is how it would reach Discord looking like a
   * status. Only a usable digest reaches the composition below.
   *
   * With no `options` (or `options.prefix` omitted), behaves exactly as before: a `'💤 '`
   * emoji prefix and a 128-code-unit budget. When `options.prefix` is given (the P11 composed
   * presence prefix), that prefix is rendered in full and never truncated; the (already-usable)
   * digest is word-boundary-truncated to whatever budget remains out of Discord's 128-code-unit
   * limit (after the prefix, a ` • ` separator, and — when `options.compacting` — a `'compacting'`
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

/**
 * The system prompt's own stated "HARD MAX: 80 characters" — anything longer is a paragraph of
 * narration, not a status, so it is refused outright rather than word-boundary-truncated. Matches
 * `synopsis-generator.ts`'s `SYNOPSIS_MAX_LENGTH` precedent for the identical reasoning: trimming
 * a runaway generation to fit would cache a bad shape (and is exactly how #122's reasoning dump
 * reached Discord — truncated to 128 chars and shown as-is).
 */
const IDLE_STATUS_HARD_MAX = 80;

/**
 * One pair of double quotes wrapped around the whole response, straight or curly. Haiku sometimes
 * quotes the status even though the system prompt forbids it; that is a formatting tic, not a bad
 * status, so the quotes come off before {@link rejectIdleStatusText} judges the text — otherwise a
 * quoted reasoning dump (`"I need to pick a status"`) slips past {@link REASONING_OPENING_PATTERN},
 * which is anchored to the opening word and does not expect a leading `"`. Matches
 * `synopsis-generator.ts`'s identical `SURROUNDING_QUOTES_PATTERN`.
 */
const SURROUNDING_QUOTES_PATTERN = /^["“]([\s\S]*)["”]$/;

/**
 * Openings that mean Haiku narrated the job of writing a status instead of writing one. Drawn from
 * the production leak in #122 ("I need to pick one or two signals and let them shape a fleeting
 * thought...") plus the system prompt's own `## NEVER output` meta-commentary examples
 * ("Based on...", "Looking at...", "Here's...", "Perfect. I can see...").
 */
const REASONING_OPENING_PATTERN = /^(?:I need to|I should|I'll|I will|I'm going to|I'm trying to|I want to|Let me|First,|We need|Based on|Looking at|Here's|Here is|Perfect[.,]|Okay[.,]|Alright[.,])/i;

/** Izzy written about rather than from: the third-person case the system prompt forbids most explicitly. */
const THIRD_PERSON_PATTERN = /\b(?:Isambard|Izzy|They) (?:is|are|was|needs|wants)\b/i;

/**
 * Judge a non-empty Haiku response: is this an idle status, or a comment about the job of writing
 * one? Mirrors `synopsis-generator.ts`'s `rejectSynopsis` — checked in this order so the reported
 * reason is the first thing wrong: a multiline narration is `multiline`, not `too_long`.
 *
 * Only ever called on non-empty text — an empty generation is its own `resolveIdleText` branch,
 * reported as `'empty'`, not routed through here.
 *
 * @internal Exported for direct unit testing; production reaches it through resolveIdleText.
 * @param text - The trimmed generated text (or a previously cached status being re-validated)
 * @returns The reason to reject, or null when the text is usable as-is
 */
export function rejectIdleStatusText(text: string): string | null {
    if(text.includes('\n')) {
        return 'multiline';
    }
    if(text.length > IDLE_STATUS_HARD_MAX) {
        return 'too_long';
    }
    if(REASONING_OPENING_PATTERN.test(text)) {
        return 'reasoning';
    }
    if(THIRD_PERSON_PATTERN.test(text)) {
        return 'third_person';
    }
    return null;
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
        // Stryker disable next-line llm: `== undefined` differs from `=== undefined` only for null, which the `() => string | undefined` contract excludes
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
        // Stryker disable next-line llm: value is only consumed as a truthiness guard, so `?? ''` is unobservable in the composed prompt
        const thinkingContext = getLastThinkingContent?.();

        // Build sections most-stable → least-stable for Anthropic API prefix caching:
        // task context (~hours) → recent conversation (~minutes) → last thoughts (~per turn)
        const sections: string[] = [];
        if(taskContext) {
            // Stryker disable next-line ArrayMethodSwap: sections is empty at this first push, so unshift is indistinguishable from push
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
     * An empty generation (the deadline firing, an abort, or a model that returned nothing), or a
     * non-empty one that is refused by {@link rejectIdleStatusText} (multiline, over the 80-char
     * hard max, or reasoning/planning narration such as #122's "I need to pick one or two
     * signals..." leak), must never be applied: composing either produces a status that is not a
     * thought. Instead the last status this generator produced keeps standing — the same "refuse
     * it rather than cache it" stance the session core's turn synopsis generator (`rejectSynopsis`
     * in `src/agent/session/synopsis-generator.ts`) takes for a response it would not want to show,
     * reached here by keeping the previous value rather than by returning null (this generator has
     * no caller-side skip to return into: it must produce an activity every time).
     *
     * The cached previous status is itself re-validated with {@link rejectIdleStatusText} before
     * being reused: without this, a previously-cached bad status (e.g. one cached in-memory just
     * before this fix deployed, or from any future regression) would be reused, truncated by the
     * compose functions, and reintroduce the exact same bug via the fallback path instead of the
     * primary path.
     *
     * @param rawText - The trimmed generated text
     * @returns `rawText` when it is usable as-is, else the re-validated cached previous status, else {@link DEFAULT_IDLE_TEXT}
     */
    function resolveIdleText(rawText: string): string {
        const reason = rawText === '' ? 'empty' : rejectIdleStatusText(rawText);
        if(reason === null) {
            return rawText;
        }
        const previous = getPreviousStatus?.();
        // Stryker disable next-line llm: for any string, trim() !== '' and trim().length > 0 are equivalent
        const previousIsUsable = previous !== undefined && previous.trim() !== '' && rejectIdleStatusText(previous) === null;
        const fallback = previousIsUsable ? previous : DEFAULT_IDLE_TEXT;
        logger.warn({ usedPreviousStatus: previousIsUsable, reason }, 'Idle status generation produced no usable text');
        return fallback;
    }

    return {
        async generate(options?: IdleStatusOptions): Promise<ActivitiesOptions> {
            try {
                logger.debug('Generating idle status with Haiku');

                const identity = await identityContext();

                const { systemPrompt, userPrompt } = getLiveSignals
                    ? await buildLiveSignalsPrompts(identity)
                    : await buildLegacyPrompts(identity);

                const text = await generateTextWithSystemPrompt(systemPrompt, userPrompt, { stripMarkdown: true, timeoutMs: IDLE_GENERATION_TIMEOUT_MS, label: 'idle-status' });
                // Stryker disable next-line MethodExpression: trim() is defensive — generateText() already returns trimmed output
                const rawText = resolveIdleText(text.trim().replace(SURROUNDING_QUOTES_PATTERN, '$1'));

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
    };
}
