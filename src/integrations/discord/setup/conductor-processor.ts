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
 * person-history race, and — critically — no `BotStateManager` writes at all (that is
 * `../state/ledger-shim.ts`'s sole job in conductor mode, driven by the conductor's own ledger
 * rather than by this processor).
 *
 * @module integrations/discord/setup/conductor-processor
 */
import type { Logger } from '@hughescr/logger';
import { addAttachmentInfoToContexts } from '../attachments';
import type { MessageProcessor, ProcessResult } from '../message-coordinator';
import type { DiscordMessageContext } from '../types';
import { processAttachments, toPlatformImages } from './coordinator-setup';
import type { ResolvedDiscordNames } from './discord-envelope-provider';
import {
    buildDiscordEnvelope, buildResumeNote, StreamTracker,
    type AgentStreamEvent, type Conductor, type ContextBuilder, type ContextPolicy, type DiscordEnvelopeInput, type PlatformImage
} from '@/agent';
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
    conductor:        Conductor
    contextPolicy:    ContextPolicy
    envelopeProvider: DiscordEnvelopeProvider
    /** Only the two members this processor needs: the author's stored timezone, and their `[About this user]` memory block text. */
    contextBuilder:   Pick<ContextBuilder, 'loadUserTimezone' | 'loadUserMemories'>
    /** Resolves a possibly-`undefined` stored timezone to a definite IANA zone — injected so tests do not depend on the server's real timezone or `src/utils/time.ts`'s `DateTime.local()` fallback. */
    resolveTimezone:  (userTimezone?: string) => string
    logger:           Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/** An empty `ProcessResult` for the (unreachable in production — the coordinator never calls a processor with an empty batch) empty-contexts guard. */
function emptyResult(): ProcessResult {
    return {
        response: null, wasInterrupted: false, streamTracker: new StreamTracker(),
    };
}

/**
 * Creates the conductor-backed `MessageProcessor` conductor-mode coordinator-setup.ts installs
 * in place of the legacy `agent.handleInput` processor.
 * @param params See {@link CreateConductorProcessorParams}.
 * @returns A `MessageProcessor` — see `message-coordinator.ts`.
 */
export function createConductorProcessor(params: CreateConductorProcessorParams): MessageProcessor {
    const {
        conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
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

        const [names, channelList, storedTimezone, newEvents] = await Promise.all([
            envelopeProvider.resolveNames(first),
            envelopeProvider.channelList(),
            contextBuilder.loadUserTimezone(first.userId),
            contextPolicy.eventsDelta(),
        ]);

        const input = envelopeProvider.toEnvelopeInput(enrichedContexts, names, platformImages, channelList);
        // Gap 1 (timezone): every envelope stamp and time header uses the AUTHOR's own zone —
        // resolveTimezone's fallback (server zone) only kicks in when nothing is stored for them.
        const timezone = resolveTimezone(storedTimezone);
        const shouldInjectMemory = contextPolicy.shouldInjectUserMemory(input.authorId);
        const userMemoryBlock = shouldInjectMemory ? await contextBuilder.loadUserMemories(input.authorId) : undefined;
        // An interrupted turn's captured partial work (message-coordinator.ts's own resume-context
        // handling), rendered as a `[RESUME NOTE]` block so it still reaches Claude even though the
        // interrupting messages arrive as a fresh envelope rather than a continuation of the old one.
        const resumeNote = resumeContext ? buildResumeNote(resumeContext.partialWork) : undefined;

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
            now:             new Date(),
            timezone,
            timeHeader:      formatTimeHeader(timezone),
            newEvents:       newEvents.length > 0 ? newEvents : undefined,
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
        const unsubscribe = conductor.subscribeTurn((turnId, frame) => {
            if(turnId === envelope.id) {
                streamTracker.update(frame as AgentStreamEvent);
            }
        });

        let result;
        try {
            result = await conductor.submit(envelope, {
                priority: 'human', requestingChannelId: input.channelId, signal: abortSignal,
            });
        } finally {
            unsubscribe();
        }

        logger.info({
            envelopeId: envelope.id, contextUsagePercent: result.contextUsagePercent, outcome: result.outcome,
        }, 'Conductor turn settled');

        // Gap 2 (post-compaction reset inputs): only mark when the envelope actually reached the
        // SDK — a withdrawn envelope's memory block/events delta were never shown to Claude, so
        // marking them seen would wrongly skip the real injection next time. `markInjected` is
        // further gated on `shouldInjectMemory` itself: when the window hadn't elapsed and no
        // block was built, writing the mark here would reset the injection clock to now and
        // defer the real re-injection indefinitely for an active user.
        if(result.outcome !== 'withdrawn') {
            contextPolicy.markEventsSeen();
            if(shouldInjectMemory) {
                contextPolicy.markInjected(input.authorId);
            }
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
