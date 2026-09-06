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
 * header, the optional `[Service health]`/`[About this user]`/`[Recent events]`/`[Channels]`
 * sections (each rendered only when its input is provided/non-empty), then the message texts
 * in order.
 * @param params Discord envelope inputs
 * @returns A `discord`-kind {@link Envelope}
 */
export function buildDiscordEnvelope(params: BuildDiscordEnvelopeParams): Envelope {
    const {
        messages, authorId, authorName, channelId, channelName, guildName, isDM,
        now, timezone, timeHeader, newEvents, userMemoryBlock, channelList, healthNote, images, resumeNote,
    } = params;

    const stamp = formatEnvelopeStamp(now, timezone);
    const channelSegment = formatDiscordChannelSegment(isDM, channelName, guildName);
    const header = `[DISCORD ${channelSegment} · ${stamp} · @${authorName}]`;

    const text = joinSections([
        header,
        timeHeader,
        renderSection('Service health', healthNote),
        renderSection('About this user', userMemoryBlock),
        newEvents && newEvents.length > 0 ? renderSection('Recent events', newEvents.join('\n')) : undefined,
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
