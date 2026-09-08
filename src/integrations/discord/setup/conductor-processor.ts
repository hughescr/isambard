/**
 * Bridges the long-lived conversation {@link Conductor} onto Discord's `MessageProcessor`
 * contract (P9, design section 3.1/6): every call builds a `DiscordEnvelopeInput` (attachments
 * fetched, names resolved, the per-turn channel list, the author's own timezone for the stamp
 * and time header), submits it to the conductor with the coordinator's own `AbortSignal` (so the
 * existing debounce/withdraw/interrupt contract at message-coordinator.ts is preserved
 * unmodified), and maps the settled `TurnResult` back onto `ProcessResult` — a REAL
 * `StreamTracker`, subscribed to just this turn's frames via `conductor.subscribeTurn`, so an
 * interrupted turn's partial work is captured. The coordinator's own resume-context handling
 * (message-coordinator.ts) turns that captured progress into a `ResumeContext` on the NEXT
 * processor call; this module renders its `partialWork` into a `[RESUME NOTE]` block (via
 * `buildResumeNote`) on the resubmitted envelope, so the interruption's progress still reaches
 * Claude even though the interrupting messages arrive as a fresh envelope.
 *
 * Deliberately does none of the legacy processor's other work: no channel list folded into a
 * system prompt, no `contextNote` for a suspended perch/catch-up session, no cross-platform
 * person-history race, and — critically — no separate state-machine writes at all; presence and
 * activity-phase transitions are read directly off the conductor's own ledger (composed by
 * `presence-setup.ts`'s `setupConductorPresence`), never written by this processor.
 *
 * @module integrations/discord/setup/conductor-processor
 */
import type { Logger } from '@hughescr/logger';
import { DateTime } from 'luxon';
import { addAttachmentInfoToContexts } from '../attachments';
import type { MessageProcessor, ProcessResult } from '../message-coordinator';
import { buildLedgerThinkingSynopsis, createLedgerStreamEventHandler, type createDynamicStatusGenerator, type PresenceThrottle } from '../presence';
import type { DiscordMessageContext } from '../types';
import { processAttachments, toPlatformImages } from './coordinator-setup';
import type { ResolvedDiscordNames } from './discord-envelope-provider';
import {
    buildDiscordEnvelope, buildResumeNote, StreamTracker,
    type AgendaEntry, type AgentStreamEvent, type BuildDiscordEnvelopeParams, type CalendarDelta, type Conductor, type ContextBuilder, type ContextPolicy, type DiscordEnvelopeInput, type LedgerStore, type PlatformImage, type StateTopSetDelta
} from '@/agent';
import { formatCalendarContext } from '@/integrations/caldav';
import { formatTimeHeader } from '@/utils';

/**
 * The slice of `discord-envelope-provider.ts` this processor depends on, gathered into one
 * dependency object so `createConductorProcessor`'s own parameter list stays flat. Each member
 * is a closure already bound to a `ChannelRegistryManager`/`Client` pair (see that module's own
 * `resolveNames`/`channelListProvider` factories) — this processor never sees either directly.
 */
export interface DiscordEnvelopeProvider {
    resolveNames:    (context: DiscordMessageContext) => Promise<ResolvedDiscordNames>
    toEnvelopeInput: (contexts: DiscordMessageContext[], names: ResolvedDiscordNames, images: PlatformImage[], channelList: string[]) => DiscordEnvelopeInput
    channelList:     () => Promise<string[]>
}

/** Dependencies for {@link createConductorProcessor}. */
export interface CreateConductorProcessorParams {
    conductor:                Conductor
    contextPolicy:            ContextPolicy
    envelopeProvider:         DiscordEnvelopeProvider
    /** Only the two members this processor needs: the author's stored timezone, and their `[About this user]` memory block text. */
    contextBuilder:           Pick<ContextBuilder, 'loadUserTimezone' | 'loadUserMemories'>
    /** Resolves a possibly-`undefined` stored timezone to a definite IANA zone — injected so tests do not depend on the server's real timezone or `src/utils/time.ts`'s `DateTime.local()` fallback. */
    resolveTimezone:          (userTimezone?: string) => string
    logger:                   Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
    /**
     * P11: when provided together with {@link throttle}, every turn also gets a
     * `createLedgerStreamEventHandler` overlaying synopses onto this ledger (design doc section
     * 8) — `dispatch` is the only member it needs. Omitted entirely, the processor behaves exactly
     * as before P11 (a plain `StreamTracker`, no ledger writes).
     */
    ledgerStore?:             Pick<LedgerStore, 'dispatch'>
    /** The one process-wide throttle shared with `presence-setup.ts`'s conductor branch. Required alongside `ledgerStore` for the ledger-sink wiring to activate. */
    throttle?:                PresenceThrottle
    /** Optional LLM-based synopsis generator for the ledger-sink handler; omitted means no synopsis is ever generated (the ledger's base phase still reaches the composer via `sdk_frame`). */
    dynamicStatusGenerator?:  ReturnType<typeof createDynamicStatusGenerator>
    /** Forwarded verbatim to the ledger-sink handler's own `onThinkingContentUpdate` (see `bot.ts`'s `getLastThinkingContent`/`setLastThinkingContent` ring buffer) — omitted means the idle-status generator never sees a last-thinking-content signal in conductor mode. */
    onThinkingContentUpdate?: (content: string) => void
}

/** An empty `ProcessResult` for the (unreachable in production — the coordinator never calls a processor with an empty batch) empty-contexts guard. */
function emptyResult(): ProcessResult {
    return {
        response: null, wasInterrupted: false, streamTracker: new StreamTracker(),
    };
}

/** `delta` itself when at least one of its three lists is non-empty, else `undefined` — the `stateChanged` param's "nothing to show" collapse, matching `newEvents`'s own empty-array-to-undefined pattern. */
function stateChangedOrUndefined(delta: StateTopSetDelta): StateTopSetDelta | undefined {
    return delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0 ? delta : undefined;
}

/** The empty, non-first delta `calendarDelta()` resolves to when it rejects — collapses onto no `[Calendar]` section this turn (a transient CalDAV failure costs one skipped calendar refresh, never a dropped turn). */
// Stryker disable BooleanLiteral: equivalent given the empty agenda/events/added/removed/changed above -- calendarChangedOrUndefined's `delta.isFirst ? agendaText === '' : !hasChanges` collapses to `undefined` for either value of isFirst (agendaText is always '' and hasChanges is always false here), and `polled` is never read anywhere downstream of this constant in this file.
const EMPTY_CALENDAR_DELTA: CalendarDelta = {
    agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false,
};
// Stryker restore BooleanLiteral

/** One `+`/`-`/`~` change-list line for an `AgendaEntry`: `HH:mm–HH:mm summary` in `timezone`, or `All day: summary` for an all-day entry — mirrors `formatCalendarContext`'s own `formatEventLine` convention so the change list and the full agenda text read consistently. */
function formatAgendaLine(entry: AgendaEntry, timezone: string): string {
    if(entry.isAllDay) {
        return `All day: ${entry.summary}`;
    }
    const start = DateTime.fromISO(entry.start, { zone: timezone }).toFormat('HH:mm');
    const end = DateTime.fromISO(entry.end, { zone: timezone }).toFormat('HH:mm');
    return `${start}–${end} ${entry.summary}`;
}

/**
 * `buildDiscordEnvelope`'s `calendarChanged` param from a `CalendarDelta`, or `undefined` when
 * there is nothing worth injecting: an unchanged (non-first) delta, or a first-ever poll whose
 * agenda is empty (no calendar configured, or a genuinely empty day). Otherwise the full agenda
 * text (`agendaText`, built by the caller via `formatCalendarContext`) plus the `+/-/~` change
 * list rendered via {@link formatAgendaLine}.
 */
function calendarChangedOrUndefined(delta: CalendarDelta, agendaText: string, timezone: string): BuildDiscordEnvelopeParams['calendarChanged'] {
    const hasChanges = delta.added.length > 0 || delta.removed.length > 0 || delta.changed.length > 0;
    if(delta.isFirst ? agendaText === '' : !hasChanges) {
        return undefined;
    }
    return {
        agenda:  agendaText,
        added:   delta.added.map(entry => formatAgendaLine(entry, timezone)),
        removed: delta.removed.map(entry => formatAgendaLine(entry, timezone)),
        changed: delta.changed.map(entry => formatAgendaLine(entry, timezone)),
        isFirst: delta.isFirst,
    };
}

/**
 * Creates the conductor-backed `MessageProcessor` that `coordinator-setup.ts` installs.
 * @param params See {@link CreateConductorProcessorParams}.
 * @returns A `MessageProcessor` — see `message-coordinator.ts`.
 */
export function createConductorProcessor(params: CreateConductorProcessorParams): MessageProcessor {
    const {
        conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle, dynamicStatusGenerator, onThinkingContentUpdate,
    } = params;

    return async (contexts, resumeContext, abortSignal): Promise<ProcessResult> => {
        const first = contexts[0];
        if(first === undefined) {
            logger.warn('createConductorProcessor: processor called with an empty context batch');
            return emptyResult();
        }

        const { images, contentAdditions } = await processAttachments(contexts);
        const enrichedContexts = addAttachmentInfoToContexts(contexts, contentAdditions);
        const platformImages = toPlatformImages(images);

        // P11: pre-generated alongside the other independent I/O below (never on its own await) so
        // the first `thinking` phase of the turn — before any accumulated content or tool history
        // exists for handleThinkingTransition to regenerate from — still carries a synopsis instead
        // of falling through to nothing (the same throttle-gated pattern `buildLedgerThinkingSynopsis`
        // itself uses, since the conductor path has no separate state manager to peek).
        const thinkingSynopsisPromise = ledgerStore && throttle
            ? buildLedgerThinkingSynopsis(dynamicStatusGenerator, throttle, first.content)
            : Promise.resolve(undefined);

        // Gap 1/4 (timezone): every envelope stamp and time header uses the AUTHOR's own zone —
        // resolveTimezone's fallback (server zone) only kicks in when nothing is stored for them.
        // Resolved BEFORE the Promise.all below (rather than alongside it, as loadUserTimezone
        // used to run) because Q12's calendarDelta() needs the resolved zone as an argument, not
        // a promise of one.
        const storedTimezone = await contextBuilder.loadUserTimezone(first.userId);
        const timezone = resolveTimezone(storedTimezone);

        const [names, channelList, newEvents, stateTopSetDelta, calendarDelta, thinkingSynopsis, memoryBlock] = await Promise.all([
            envelopeProvider.resolveNames(first),
            envelopeProvider.channelList(),
            contextPolicy.eventsDelta(),
            contextPolicy.stateTopSetDelta(),
            // Q12: a transient CalDAV failure must not take the whole turn down with it — logged
            // and collapsed onto an empty, non-first delta, which calendarChangedOrUndefined then
            // renders as no [Calendar] section at all this turn.
            contextPolicy.calendarDelta(first.userId, timezone).catch((err: unknown) => {
                logger.warn({ err }, 'calendarDelta failed; envelope sent without a calendar section this turn');
                return EMPTY_CALENDAR_DELTA;
            }),
            thinkingSynopsisPromise,
            // R1: the memory block is loaded on every message (one query, as the one-shot path
            // always did) — the fingerprint decision below, not the query itself, gates injection.
            contextBuilder.loadUserMemories(first.userId),
        ]);

        const input = envelopeProvider.toEnvelopeInput(enrichedContexts, names, platformImages, channelList);
        // R1: fingerprint-based, not time-windowed — true when this exact block content has never
        // been shown to this user, or differs from what was last shown (see context-policy.ts).
        const shouldInjectMemory = contextPolicy.shouldInjectUserMemory(input.authorId, memoryBlock);
        const userMemoryBlock = shouldInjectMemory ? memoryBlock : undefined;
        // An interrupted turn's captured partial work (message-coordinator.ts's own resume-context
        // handling), rendered as a `[RESUME NOTE]` block so it still reaches Claude even though the
        // interrupting messages arrive as a fresh envelope rather than a continuation of the old one.
        const resumeNote = resumeContext ? buildResumeNote(resumeContext.partialWork) : undefined;
        const now = new Date();
        const calendarAgendaText = formatCalendarContext(calendarDelta.events, now, timezone);

        const envelope = buildDiscordEnvelope({
            messages: [{
                channelId: input.channelId,
                userId:    input.authorId,
                messageId: input.messageId,
                content:   input.content,
                timestamp: input.createdAt.toISOString(),
                botUserId: first.botUserId,
                guildId:   first.guildId,
            }],
            authorId:        input.authorId,
            authorName:      input.authorName,
            channelId:       input.channelId,
            channelName:     input.channelName,
            guildName:       input.guildName,
            isDM:            input.isDM,
            now,
            timezone,
            timeHeader:      formatTimeHeader(timezone),
            newEvents:       newEvents.length > 0 ? newEvents : undefined,
            stateChanged:    stateChangedOrUndefined(stateTopSetDelta),
            calendarChanged: calendarChangedOrUndefined(calendarDelta, calendarAgendaText, timezone),
            healthNote:      contextPolicy.healthNote(),
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: an empty-string memory block must collapse to undefined too, not just null/undefined, so `??` would be wrong here
            userMemoryBlock: userMemoryBlock || undefined,
            channelList:     input.channelList.length > 0 ? input.channelList.join('\n') : undefined,
            images:          input.images,
            resumeNote,
        });

        // A REAL StreamTracker, subscribed to just this turn's frames (message-coordinator.ts
        // requires one on every ProcessResult, and reads it to capture partial work on an
        // interrupted turn for the next submit's resume context).
        const streamTracker = new StreamTracker();
        // P11: overlays synopses onto the ledger for this turn's own id — only when the caller
        // wired both ledgerStore and throttle (see CreateConductorProcessorParams's doc).
        const ledgerHandler = ledgerStore && throttle
            ? createLedgerStreamEventHandler({
                turnId: envelope.id, sink: ledgerStore, throttle, dynamicStatusGenerator, logger, userMessage: input.content, thinkingSynopsis, onThinkingContentUpdate,
            })
            : undefined;
        const unsubscribe = conductor.subscribeTurn((turnId, frame) => {
            if(turnId === envelope.id) {
                streamTracker.update(frame as AgentStreamEvent);
                ledgerHandler?.onStreamEvent(frame as AgentStreamEvent);
            }
        });

        let result;
        try {
            result = await conductor.submit(envelope, {
                priority: 'human', requestingChannelId: input.channelId, signal: abortSignal,
            });
        } finally {
            unsubscribe();
            ledgerHandler?.complete();
        }

        logger.info({
            envelopeId: envelope.id, contextUsagePercent: result.contextUsagePercent, outcome: result.outcome,
        }, 'Conductor turn settled');

        // Gap 2 (post-compaction reset inputs): only mark when the envelope actually reached the
        // SDK — a withdrawn envelope's memory block/events delta/state-top-set delta were never
        // shown to Claude, so marking them seen would wrongly skip the real injection next time
        // (Q9: `markStateTopSetSeen` gated here exactly like `markEventsSeen`). `markInjected` is
        // unconditional on a non-withdrawn submit (R1) — not further gated on `shouldInjectMemory`
        // — because the fingerprint recorded is always the block actually loaded this turn: when
        // `shouldInjectMemory` was false the block was unchanged, so re-recording the same
        // fingerprint is a no-op; when it was true, this is exactly the mark the next turn's
        // comparison needs.
        if(result.outcome !== 'withdrawn') {
            contextPolicy.markEventsSeen();
            // Best-effort: unlike markEventsSeen/markInjected (synchronous, in-memory, cannot
            // throw), markStateTopSetSeen performs a real DynamoDB query. The turn has already
            // settled and its response is about to be handed back to the caller — a transient
            // throttle/network error here must not take the completed reply down with it. A
            // missed mark only costs one extra (harmless) delta on the next turn.
            try {
                await contextPolicy.markStateTopSetSeen();
            } catch (err) {
                logger.warn({ err, envelopeId: envelope.id }, 'markStateTopSetSeen failed; state top-set baseline not updated this turn');
            }
            contextPolicy.markInjected(input.authorId, memoryBlock);
            // Q12: synchronous, in-memory marks (like markEventsSeen/markInjected above) — cannot
            // throw, so no try/catch is needed here.
            contextPolicy.markCalendarSeen(first.userId);
            contextPolicy.markHealthSeen();
        }

        return {
            response:       result.response,
            sessionId:      result.sessionId,
            wasInterrupted: result.wasInterrupted,
            streamTracker,
            envelopeId:     envelope.id,
        };
    };
}
