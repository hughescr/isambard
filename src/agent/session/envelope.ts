/**
 * Pure envelope builders for the long-lived session core.
 *
 * `Envelope` is owned solely by `./types` (plan amendment A1) — this module only builds
 * instances of it, it never redeclares the type. Every builder is pure other than the id
 * (`crypto.randomUUID()`), which is the same minor, deliberate impurity every other envelope
 * factory in this codebase already accepts (see `src/integrations/discord/capability.ts`).
 *
 * Builders whose header carries a timestamp (`buildDiscordEnvelope`, `buildPerchEnvelope`,
 * `buildNotificationEnvelope`, `buildCatchupEnvelope`) take `now`/`timezone` and stamp the
 * header via `formatEnvelopeStamp`. The remaining builders (`buildWrapUpEnvelope`,
 * `buildResumeEnvelope`, `buildBootEnvelope`, `buildCompactEnvelope`) carry no stamp in their
 * brief-specified signature, but `Envelope.createdAt` is non-optional — so each of those also
 * takes a plain `now: Date` (a small, deliberate signature addition beyond the brief) purely to
 * populate `createdAt` without reaching for `new Date()` inside a "pure builder" module.
 *
 * Imports are deliberately narrow (nothing from src/integrations/**): './catchup-text',
 * '../multimodal-message-builder', '../types' (MessageContext/PlatformImage — the
 * platform-agnostic leaf types, not this module's own EnvelopeKind/Envelope), '@/utils', and
 * the SDK's own message types.
 *
 * @module agent/session/envelope
 */
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildMultimodalContent } from '../multimodal-message-builder';
import type { MessageContext, PlatformImage } from '../types';
import { buildCatchupText } from './catchup-text';
import type { Envelope } from './types';
import { formatEnvelopeStamp } from '@/utils';

/** Joins non-empty sections with a blank line, dropping any `undefined`/empty entries. */
function joinSections(sections: (string | undefined)[]): string {
    return sections.filter(Boolean).join('\n\n');
}

/** Renders a bracketed body section, or `undefined` when there is nothing to show. */
function renderSection(title: string, body: string | undefined): string | undefined {
    return body ? `[${title}]\n${body}` : undefined;
}

/** Renders the `[State changed]` section body (`+path`/`-path`/`~path` lines), or `undefined` when all three lists are empty. */
function renderStateChangedSection(stateChanged: { added: string[], removed: string[], changed: string[] } | undefined): string | undefined {
    if(!stateChanged) {
        return undefined;
    }
    // No need to special-case "all three lists empty" here: an empty `lines` array joins to
    // `''`, which `renderSection` already collapses to `undefined` on its own falsy check.
    const lines = [
        ...stateChanged.added.map(path => `+${path}`),
        ...stateChanged.removed.map(path => `-${path}`),
        ...stateChanged.changed.map(path => `~${path}`),
    ];
    return renderSection('State changed', lines.join('\n'));
}

/**
 * Renders the `[Calendar]` section body: on `isFirst`, just the full `agenda` text (no change
 * list, since there is no prior injection to diff against). Otherwise a `+/-/~` change list
 * (one already-formatted `HH:mm–HH:mm summary` line per entry, mirroring
 * `renderStateChangedSection`'s prefixing) followed by the full `agenda` text — the change list
 * is omitted (not a blank leading line) when all three lists are empty. `undefined` when
 * `calendarChanged` is `undefined` (or its rendered body would be empty).
 */
function renderCalendarChangedSection(calendarChanged: BuildDiscordEnvelopeParams['calendarChanged']): string | undefined {
    if(!calendarChanged) {
        return undefined;
    }
    if(calendarChanged.isFirst) {
        return renderSection('Calendar', calendarChanged.agenda);
    }
    const lines = [
        ...calendarChanged.added.map(line => `+${line}`),
        ...calendarChanged.removed.map(line => `-${line}`),
        ...calendarChanged.changed.map(line => `~${line}`),
    ];
    // Each part is included only when non-empty, so a non-empty change list with an empty
    // agenda (e.g. the day's only event was just cancelled) doesn't leave a dangling trailing
    // newline, and an empty change list with a non-empty agenda doesn't gain a leading blank line.
    const body = [lines.join('\n'), calendarChanged.agenda].filter(part => part.length > 0).join('\n');
    return renderSection('Calendar', body);
}

/** `#channel-name (Guild)` for a guild channel, or `DM` for a direct message. */
function formatDiscordChannelSegment(isDM: boolean, channelName: string, guildName: string | undefined): string {
    if(isDM) {
        return 'DM';
    }
    const guildSuffix = guildName ? ` (${guildName})` : '';
    return `#${channelName}${guildSuffix}`;
}

/** Inputs to {@link buildDiscordEnvelope}. */
export interface BuildDiscordEnvelopeParams {
    messages:         MessageContext[]
    authorId:         string
    authorName:       string
    channelId:        string
    channelName:      string
    guildName?:       string
    isDM:             boolean
    now:              Date
    timezone:         string
    timeHeader:       string
    newEvents?:       string[]
    userMemoryBlock?: string
    /**
     * State top-set delta since the last mark (Q9): paths that newly entered the top set
     * (`added`), fell out of it (`removed`), or stayed in it with different content
     * (`changed`). Rendered as a `[State changed]` section — `+path`/`-path`/`~path` lines,
     * added then removed then changed — only when at least one list is non-empty; omitted
     * entirely when `undefined` or when all three lists are empty.
     */
    stateChanged?:    { added: string[], removed: string[], changed: string[] }
    /**
     * Calendar delta since the last mark (Q12): `agenda` is the full agenda text (already
     * formatted, e.g. via `formatCalendarContext`); `added`/`removed`/`changed` are already
     * `HH:mm–HH:mm summary` lines this builder prefixes with `+`/`-`/`~`. Rendered as a
     * `[Calendar]` section — on `isFirst` just the full agenda text, otherwise the `+/-/~`
     * change list followed by the full agenda text; omitted entirely when `undefined`.
     */
    calendarChanged?: { agenda: string, added: string[], removed: string[], changed: string[], isFirst: boolean }
    channelList?:     string
    healthNote?:      string
    images?:          PlatformImage[]
    /**
     * A pre-composed `[RESUME NOTE]` block (see `buildResumeNote` in resume-prompt-builder.ts),
     * rendered verbatim after `[Channels]` and before the message texts — the coordinator's own
     * partial-work summary for a turn this envelope's messages interrupted, so an interrupted
     * turn's progress still reaches Claude even though the interrupting messages arrive as a
     * fresh envelope rather than a continuation of the old one.
     */
    resumeNote?:      string
}

/**
 * Builds a Discord turn envelope: `[DISCORD #channel · stamp · @author]` (or
 * `[DISCORD DM · stamp · @author]` for a direct message), followed by the caller-supplied time
 * header, the optional `[Service health]`/`[About this user]`/`[Recent events]`/`[State
 * changed]`/`[Calendar]`/`[Channels]` sections (each rendered only when its input is
 * provided/non-empty), then the message texts in order.
 * @param params Discord envelope inputs
 * @returns A `discord`-kind {@link Envelope}
 */
export function buildDiscordEnvelope(params: BuildDiscordEnvelopeParams): Envelope {
    const {
        messages, authorId, authorName, channelId, channelName, guildName, isDM,
        now, timezone, timeHeader, newEvents, userMemoryBlock, stateChanged, calendarChanged, channelList, healthNote, images, resumeNote,
    } = params;

    const stamp = formatEnvelopeStamp(now, timezone);
    const channelSegment = formatDiscordChannelSegment(isDM, channelName, guildName);
    const header = `[DISCORD ${channelSegment} · ${stamp} · @${authorName}]`;

    const text = joinSections([
        header,
        timeHeader,
        renderSection('Service health', healthNote),
        renderSection('About this user', userMemoryBlock),
        // No need to special-case "empty array" here (mirrors renderStateChangedSection's own
        // comment above): an empty `newEvents` joins to `''`, which `renderSection` already
        // collapses to `undefined` on its own falsy check — a redundant `newEvents.length > 0`
        // guard here would only produce a mutation-equivalent branch with no observable effect.
        newEvents ? renderSection('Recent events', newEvents.join('\n')) : undefined,
        renderStateChangedSection(stateChanged),
        renderCalendarChangedSection(calendarChanged),
        renderSection('Channels', channelList),
        resumeNote,
        ...messages.map(message => message.content),
    ]);

    return {
        id:           crypto.randomUUID(),
        kind:         'discord',
        text,
        images,
        channelId,
        authorId,
        origin:       { kind: 'human' },
        hostPriority: 'human',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/** Inputs to {@link buildPerchEnvelope}. */
export interface BuildPerchEnvelopeParams {
    slotName:           string
    now:                Date
    timezone:           string
    endsAt:             Date
    suggestionLevel:    number
    backgroundSummary?: string
    slotHint:           string
    perchContext:       string
    timeHeader:         string
}

/**
 * Builds a perch-slot envelope: `[PERCH · {slot} slot · stamp · ends HH:mm]`, followed by the
 * time header, a suggestion-level line (with a background clause only when
 * `backgroundSummary` is given), the slot hint, and the perch context.
 * @param params Perch envelope inputs
 * @returns A `perch`-kind {@link Envelope}
 */
export function buildPerchEnvelope(params: BuildPerchEnvelopeParams): Envelope {
    const { slotName, now, timezone, endsAt, suggestionLevel, backgroundSummary, slotHint, perchContext, timeHeader } = params;

    const stamp = formatEnvelopeStamp(now, timezone);
    // formatEnvelopeStamp's output is 'yyyy-MM-dd HH:mm ZONE'; the middle field is exactly the
    // local HH:mm this header needs, without importing luxon into this narrowly-scoped module.
    const endsAtLabel = formatEnvelopeStamp(endsAt, timezone).split(' ')[1];
    const header = `[PERCH · ${slotName} slot · ${stamp} · ends ${endsAtLabel}]`;
    const suggestionLine = backgroundSummary
        ? `Suggestion level: ${suggestionLevel} of 3. Background: ${backgroundSummary}`
        : `Suggestion level: ${suggestionLevel} of 3.`;

    const text = joinSections([header, timeHeader, suggestionLine, slotHint, perchContext]);

    return {
        id:           crypto.randomUUID(),
        kind:         'perch',
        text,
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/** Inputs to {@link buildNotificationEnvelope}. */
export interface BuildNotificationEnvelopeParams {
    source:     string
    text:       string
    now:        Date
    timezone:   string
    timeHeader: string
    wake:       boolean
}

/**
 * Builds a notification envelope: `[NOTIFICATION · {source} · stamp]`, followed by the time
 * header and the notification text. `wake` drives both `shouldQuery` and `hostPriority`
 * ('wake' when true, 'accumulate' when false).
 * @param params Notification envelope inputs
 * @returns A `notification`-kind {@link Envelope}
 */
export function buildNotificationEnvelope(params: BuildNotificationEnvelopeParams): Envelope {
    const { source, text, now, timezone, timeHeader, wake } = params;

    const stamp = formatEnvelopeStamp(now, timezone);
    const header = `[NOTIFICATION · ${source} · ${stamp}]`;

    return {
        id:           crypto.randomUUID(),
        kind:         'notification',
        text:         joinSections([header, timeHeader, text]),
        hostPriority: wake ? 'wake' : 'accumulate',
        shouldQuery:  wake,
        createdAt:    now,
    };
}

/** Inputs to {@link buildCatchupEnvelope}. */
export interface BuildCatchupEnvelopeParams {
    unreadCount:  number
    channelCount: number
    now:          Date
    timezone:     string
    timeHeader:   string
}

/**
 * Builds a catch-up envelope: `[CATCH-UP · stamp]`, the time header, then
 * {@link buildCatchupText}'s body.
 * @param params Catch-up envelope inputs
 * @returns A `catchup`-kind {@link Envelope}
 */
export function buildCatchupEnvelope(params: BuildCatchupEnvelopeParams): Envelope {
    const { unreadCount, channelCount, now, timezone, timeHeader } = params;

    const stamp = formatEnvelopeStamp(now, timezone);
    const header = `[CATCH-UP · ${stamp}]`;

    return {
        id:           crypto.randomUUID(),
        kind:         'catchup',
        text:         joinSections([header, timeHeader, buildCatchupText({ unreadCount, channelCount })]),
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/** Inputs to {@link buildWrapUpEnvelope}. */
export interface BuildWrapUpEnvelopeParams {
    minutesLeft: number
    now:         Date
}

/**
 * Builds a wrap-up envelope: `[WRAP-UP · perch slot ends in N min]` plus a one-line
 * instruction.
 * @param params Wrap-up envelope inputs
 * @returns A `wrapup`-kind {@link Envelope}
 */
export function buildWrapUpEnvelope(params: BuildWrapUpEnvelopeParams): Envelope {
    const { minutesLeft, now } = params;
    const header = `[WRAP-UP · perch slot ends in ${minutesLeft} min]`;
    const instruction = 'Wrap up your current work now; the perch slot is ending.';

    return {
        id:           crypto.randomUUID(),
        kind:         'wrapup',
        text:         joinSections([header, instruction]),
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/**
 * Builds a resume envelope carrying a pre-composed resume note verbatim.
 * @param note Resume note text (see `buildResumeNote` in resume-prompt-builder.ts)
 * @param now Envelope creation time, for `createdAt`
 * @returns A `resume`-kind {@link Envelope}
 */
export function buildResumeEnvelope(note: string, now: Date): Envelope {
    return {
        id:           crypto.randomUUID(),
        kind:         'resume',
        text:         note,
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/**
 * Builds a boot envelope carrying a pre-composed boot bundle verbatim (see boot-bundle.ts).
 * Never interrupts and never escalates: `shouldQuery` is false and `hostPriority` is
 * 'accumulate'.
 * @param text Pre-composed boot bundle text
 * @param now Envelope creation time, for `createdAt`
 * @returns A `boot`-kind {@link Envelope}
 */
export function buildBootEnvelope(text: string, now: Date): Envelope {
    return {
        id:           crypto.randomUUID(),
        kind:         'boot',
        text,
        hostPriority: 'accumulate',
        shouldQuery:  false,
        createdAt:    now,
    };
}

/**
 * Builds the host-driven '/compact' envelope submitted by the compaction guard at a turn
 * boundary.
 * @param now Envelope creation time, for `createdAt`
 * @returns A `compact`-kind {@link Envelope} whose text is exactly '/compact'
 */
export function buildCompactEnvelope(now: Date): Envelope {
    return {
        id:           crypto.randomUUID(),
        kind:         'compact',
        text:         '/compact',
        hostPriority: 'accumulate',
        shouldQuery:  true,
        createdAt:    now,
    };
}

/**
 * Converts a domain {@link Envelope} into the SDK's wire shape. Deliberately does not set the
 * SDK's own `priority?: 'now'|'next'|'later'` field — a different concept from
 * `Envelope.hostPriority` that this session core does not use.
 * @param envelope Envelope to convert
 * @returns An `SDKUserMessage` ready to feed the session's input stream
 */
export function toSdkUserMessage(envelope: Envelope): SDKUserMessage {
    return {
        type:               'user',
        message:            { role: 'user', content: buildMultimodalContent(envelope.text, envelope.images) },
        parent_tool_use_id: null,
        shouldQuery:        envelope.shouldQuery,
        ...(envelope.origin ? { origin: envelope.origin } : {}),
    };
}
