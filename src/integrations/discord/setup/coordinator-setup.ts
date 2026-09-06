import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import {
    fetchImages,
    saveNonImageAttachment,
    isSupportedImageType,
    formatBytes,
    addAttachmentInfoToContexts
} from '../attachments';
import type { FetchedImage } from '../attachments/types';
import type { DiscordCapability } from '../capability';
import type { CatchUpSessionRunner } from '../catchup';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import type { ChannelMetadata } from '../channel-registry/types';
import type { InboxManager } from '../inbox';
import { MessageCoordinator } from '../message-coordinator';
import { type createDynamicStatusGenerator, type PresenceManager, type PresenceThrottle } from '../presence';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendResponse, sendEnvelopeResponse } from '../response-sender';
import type { BotStateManager } from '../state';
import { createChannelId, type ChannelId, type DiscordMessageContext } from '../types';
import { createConductorProcessor, type DiscordEnvelopeProvider } from './conductor-processor';
import { createPresenceStreamHandler, type PresenceStreamHandler } from './presence-stream-handler';
import {
    type ClaudeAgent, type PerchSessionRunner, type EventDeltaTracker, type MessageContext, type PlatformImage, type ActivityLogger, type PersonHistoryCoordinator, type Conductor, type ContextPolicy, type ContextBuilder, type DeliveryGuard, type SessionJournal, type LedgerStore, generateText
} from '@/agent';
import { resolveTimezone } from '@/utils';

/**
 * Result of processing Discord message attachments
 */
export interface ProcessedAttachments {
    /** Fetched image attachments ready for Claude */
    images:           FetchedImage[]
    /** Text descriptions of saved non-image attachments */
    contentAdditions: string[]
}

/**
 * Processes all attachments from Discord contexts.
 * Images are fetched and prepared for Claude's vision API.
 * Non-image files are saved to the scratch directory and referenced in text.
 *
 * @param contexts - Discord message contexts containing attachments
 * @returns Processed images and content additions for message text
 */
// Stryker disable all: Integration function with external dependencies - tested via bot integration tests
// eslint-disable-next-line sonarjs/cognitive-complexity -- attachment pipeline: image fetching, non-image file saving, and video hints require distinct branching per attachment type
export async function processAttachments(contexts: DiscordMessageContext[]): Promise<ProcessedAttachments> {
    const allAttachments = contexts.flatMap(ctx => ctx.attachments ?? []);
    let images: FetchedImage[] = [];
    const contentAdditions: string[] = [];

    if(allAttachments.length > 0) {
        // Fetch images
        const imageAttachments = allAttachments.filter(att => isSupportedImageType(att.contentType));
        if(imageAttachments.length > 0) {
            const result = await fetchImages(imageAttachments);
            images = result.images;
            // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
            logger.info({
                totalAttachments: imageAttachments.length,
                fetchedImages:    images.length,
                failedImages:     result.failures.length,
                msg:              `Fetched ${images.length} images from ${imageAttachments.length} image attachments (${result.failures.length} failed)`,
            });

            // Log failures
            for(const failure of result.failures) {
                // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                logger.warn({
                    filename:    failure.filename,
                    contentType: failure.contentType,
                    size:        failure.size,
                    error:       failure.error,
                    msg:         `Failed to fetch image: ${failure.filename}`,
                });
                contentAdditions.push(
                    `[Image fetch failed: ${failure.filename} - ${failure.error}]`
                );
            }
        }

        // Save non-image attachments to scratch directory; add video hints for video files
        const nonImageAttachments = allAttachments.filter(att => !isSupportedImageType(att.contentType));
        if(nonImageAttachments.length > 0) {
            const scratchDir = process.cwd();
            const messageId = contexts[0]?.messageId ?? 'unknown';

            for(const attachment of nonImageAttachments) {
                // eslint-disable-next-line no-await-in-loop -- sequential: per-file save to disk
                const stored = await saveNonImageAttachment(attachment, scratchDir, messageId);
                if(stored) {
                    if(stored.contentType.startsWith('video/')) {
                        contentAdditions.push(
                            `[Video file saved: ${stored.localPath} (${stored.contentType}, ${formatBytes(stored.size)}). Use analyzeLocalVideo to analyze this video for scene frames, metadata, and transcription.]`
                        );
                    } else {
                        contentAdditions.push(
                            `[Attached file: ${stored.localPath} (${stored.contentType}, ${formatBytes(stored.size)})]`
                        );
                    }
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                    logger.info({
                        filename:    stored.originalFilename,
                        localPath:   stored.localPath,
                        contentType: stored.contentType,
                        size:        stored.size,
                        msg:         `Saved non-image attachment: ${stored.originalFilename}`,
                    });
                } else {
                    // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
                    logger.warn({
                        filename:    attachment.filename,
                        contentType: attachment.contentType,
                        msg:         `Failed to save non-image attachment: ${attachment.filename}`,
                    });
                }
            }
        }
    }

    return { images, contentAdditions };
}
// Stryker restore all

/**
 * Sentinel thrown from inside the `send` callback passed to `conversationConductor.deliver`
 * (conductor branch's `onResponse`, below) when `sendResponse` reports `sent: false` — an
 * expected outcome (outbox-queued while Discord is offline, or routing skipped the send), not a
 * failure. Distinguishes that case from a genuine delivery error so `deliver`'s caller logs only
 * the latter.
 */
class ResponseNotSentError extends Error {}

/**
 * Parameters for setting up coordinator integration.
 */
interface SetupCoordinatorParams {
    agent:                    ClaudeAgent
    presenceManager:          PresenceManager | undefined
    dynamicStatusGenerator:   ReturnType<typeof createDynamicStatusGenerator> | undefined
    botStateManager:          BotStateManager
    catchUpSessionRunner:     CatchUpSessionRunner | undefined
    perchSessionRunner:       PerchSessionRunner | undefined
    responseRouter:           ResponseRouter
    rateLimiter:              DiscordRateLimiter
    readyClient:              Client
    channelRegistry:          ChannelRegistryManager
    eventDeltaTracker?:       EventDeltaTracker
    onThinkingContentUpdate?: (content: string) => void
    setLastSessionId?:        (sessionId: string | undefined) => void
    addRecentMessage?:        (content: string, author: 'user' | 'izzy') => void
    /** Push a channel into the recent-channels ring buffer on successful response send. */
    addRecentChannel?:        (channelId: ChannelId) => void
    activityLogger?:          ActivityLogger
    historyCoordinator?:      PersonHistoryCoordinator
    discordCapability?:       DiscordCapability
    /**
     * P10: only read by the conductor branch, to advance each channel's HANDLED watermark
     * (`recordHandled`) once a batch's envelope has finished being handled (sent, `@@NO_RESPONSE@@`
     * skip, or outbox-queued) — see `setupConductorCoordinator`'s own doc.
     */
    inboxManager?:            InboxManager

    /**
     * P9 conductor-mode dependencies. When `conversationConductor` is present, the coordinator's
     * processor is `createConductorProcessor(...)` instead of `agent.handleInput`, and `onResponse`
     * delivers exactly once via `conversationConductor.deliver` (keyed on the conductor's own
     * envelope id, idempotent against the same guard `open()` seeds from crash recovery at boot)
     * and never calls `botStateManager.goIdle()` — the ledger shim (`../state/ledger-shim.ts`) is
     * the sole writer of that transition in conductor mode. `deliveryGuard`/`journal` are accepted
     * for backward-compatible wiring but unused by the conductor branch, which delivers entirely
     * through `conversationConductor.deliver` instead. `conversationConductor`/`contextPolicy`/
     * `envelopeProvider`/`contextBuilder` travel together: providing `conversationConductor`
     * without the rest is a caller error (asserted via the non-null assertions below, deliberately
     * — this file stays Stryker-disabled so no test exercises the assertion itself, only bot.ts's
     * own wiring, which always supplies all four).
     */
    conversationConductor?: Conductor
    contextPolicy?:         ContextPolicy
    /** @deprecated Unused by the conductor branch (P9's delivery-keying fix) — delivery now goes entirely through `conversationConductor.deliver`'s own internal guard. Kept only so existing callers that still pass it do not need to change. */
    deliveryGuard?:         DeliveryGuard
    /** @deprecated Unused by the conductor branch (P9's delivery-keying fix) — `conversationConductor.deliver` journals `response_delivered` itself. Kept only so existing callers that still pass it do not need to change. */
    journal?:               SessionJournal
    envelopeProvider?:      DiscordEnvelopeProvider
    /** Only needed in conductor mode, for `createConductorProcessor`'s own timezone dependency. */
    contextBuilder?:        Pick<ContextBuilder, 'loadUserTimezone' | 'loadUserMemories'>
    /**
     * P11: forwarded verbatim into `createConductorProcessor`'s own `ledgerStore`/`throttle`
     * (paired with `dynamicStatusGenerator` above) so every conductor turn also overlays synopses
     * onto the conversation ledger — see that module's own doc. Omitted entirely, the conductor
     * branch behaves exactly as it did before P11 (a `StreamTracker` only, no ledger writes).
     */
    ledgerStore?:           Pick<LedgerStore, 'dispatch'>
    presenceThrottle?:      PresenceThrottle
}

/**
 * Maps a single Discord message context to platform-agnostic message context for the agent.
 */
function toMessageContext(context: DiscordMessageContext): MessageContext {
    return {
        channelId:   context.channelId,
        userId:      context.userId,
        messageId:   context.messageId,
        content:     context.content,
        timestamp:   context.timestamp,
        botUserId:   context.botUserId,
        guildId:     context.guildId,
        attachments: context.attachments,
    };
}

/**
 * Maps Discord message contexts to platform-agnostic message contexts for the agent.
 */
function toMessageContexts(contexts: DiscordMessageContext[]): MessageContext[] {
    return contexts.map(ctx => toMessageContext(ctx));
}

/**
 * Prepends a 'Requesting user: <userId> (<username>)' line to the first context's
 * content. There is no ambient conversation context for MCP tools any more
 * (see discord-mcp-server.ts's explicit requestingUserId argument), so Izzy must
 * be told who is asking directly in the batch text she reads.
 */
function prependRequestingUserLine(contexts: DiscordMessageContext[]): DiscordMessageContext[] {
    const first = contexts[0];
    if(!first) {
        return contexts;
    }

    const label = `Requesting user: ${first.userId} (${first.username ?? 'unknown'})`;

    return contexts.map((ctx, idx) => (idx === 0 ? { ...ctx, content: `${label}\n${ctx.content}` } : ctx));
}

/**
 * Maps Discord fetched images to platform-agnostic image format for the agent.
 */
export function toPlatformImages(images: FetchedImage[]): PlatformImage[] {
    return images.map(img => ({
        filename:     img.filename,
        mediaType:    img.mediaType,
        base64Data:   img.base64Data,
        originalSize: img.originalSize,
        width:        img.width,
        height:       img.height,
    }));
}

/**
 * Groups `batch` by Discord channel id and picks, per channel, the message with the highest
 * snowflake id — the "newest message of the batch" {@link InboxManager.recordHandled} advances
 * the channel's HANDLED watermark to (P10). A batch normally spans one channel, but this groups
 * defensively so a hypothetical multi-channel batch still advances every channel's watermark
 * exactly once.
 *
 * Deliberately kept OUTSIDE the `Stryker disable all` region below: unlike that region's
 * integration-glue functions, this is a pure, directly-testable helper with real branching logic
 * (the snowflake comparison and the `!existing` guard), so it earns full mutation coverage rather
 * than riding along with the composition-root disable.
 */
function newestMessagePerChannel(batch: Message[]): Map<string, Message> {
    const newest = new Map<string, Message>();
    for(const message of batch) {
        const existing = newest.get(message.channelId);
        if(!existing || BigInt(message.id) > BigInt(existing.id)) {
            newest.set(message.channelId, message);
        }
    }
    return newest;
}

/**
 * Sets up the message coordinator integration with the agent.
 * Configures the processor to handle message contexts and call the agent.
 *
 * @param params - Configuration for coordinator setup
 * @returns Configured message coordinator
 */
// Stryker disable all: Integration function coordinating multiple components with callbacks - tested via bot integration tests
export function setupCoordinatorIntegration(params: SetupCoordinatorParams): MessageCoordinator {
    if(params.conversationConductor) {
        return setupConductorCoordinator(params, params.conversationConductor);
    }

    const {
        agent,
        presenceManager,
        dynamicStatusGenerator,
        botStateManager,
        catchUpSessionRunner,
        perchSessionRunner,
        responseRouter,
        rateLimiter,
        readyClient,
    } = params;

    const coordinator = new MessageCoordinator({
        debounceMs:        250,
        eventDeltaTracker: params.eventDeltaTracker,
        registryReady:     () => params.channelRegistry.isReady(),
        onProcessingEnd:   ({ wasInterrupted, willResume }) => {
            if(wasInterrupted && !willResume) {
                const currentMode = botStateManager.getMode();
                if(currentMode === 'processing_message') {
                    logger.warn({ msg: 'Processing interrupted with no pending resume — recovering to idle' });
                    botStateManager.goIdle();
                }
            }
        },
        // eslint-disable-next-line complexity -- onResponse coordinates send, ring-buffer, activity-log, session-resume; branching is inherent
        onResponse: async (result, discordMessage) => {
            // Only send response if we have both a response and a message to reply to
            if(result.response && discordMessage) {
                // Track bot response for idle status context
                params.addRecentMessage?.(result.response, 'izzy');

                // Capture rate limiter reference for safe closure access
                const limiter = rateLimiter;

                const sendResult = await sendResponse({
                    responseRouter,
                    botStateManager,
                    response:           result.response,
                    message:            discordMessage,
                    rateLimiter:        limiter,
                    client:             readyClient,
                    useFallbackOnError: false,
                    discordCapability:  params.discordCapability,
                });

                // Feed recent-channels ring buffer from the response-send path.
                // This ensures channels where Izzy replied (not just received) appear in signals.
                if(sendResult.sent) {
                    params.addRecentChannel?.(createChannelId(discordMessage.channelId));
                }

                // If response was queued to outbox (Discord offline), ensure bot returns to idle
                // so perch/catch-up aren't blocked waiting for a send that already completed
                if(!sendResult.sent) {
                    const modeAfterSend = botStateManager.getMode();
                    if(modeAfterSend === 'processing_message') {
                        botStateManager.goIdle();
                    }
                }

                // Log the exchange as activity (fire-and-forget with Haiku summary)
                if(params.activityLogger) {
                    const userContent  = discordMessage.content;
                    const botResponse  = result.response;
                    const actLogger    = params.activityLogger;
                    void (async () => {
                        try {
                            let summary = 'Discord exchange in channel';
                            const generated = await generateText(
                                `Summarize this Discord exchange in one sentence (max 30 words):\nUser: ${userContent.slice(0, 500)}\nIzzy: ${botResponse.slice(0, 500)}`
                            );
                            if(generated) {
                                summary = generated;
                            }
                            await actLogger.log({
                                type: 'discord-exchange',
                                summary,
                            });
                        } catch (err) {
                            logger.warn({ err, channelId: discordMessage.channelId, msg: 'Activity log failed for Discord exchange' });
                        }
                    })();
                }
            }

            // Update session ID tracker
            params.setLastSessionId?.(result.sessionId);

            // Resume catch-up if we were suspended
            if(botStateManager.getMode() === 'idle' && catchUpSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming catch-up after suspension' });
                // Resume catch-up (async, don't await)
                void catchUpSessionRunner.resumeAfterSuspension().catch((error) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume catch-up after suspension' });
                    // Clear suspension state (error recovery)
                    catchUpSessionRunner.clearSuspension();
                });
            }

            // Resume perch if we were suspended
            if(botStateManager.getMode() === 'idle' && perchSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming perch after suspension' });
                void perchSessionRunner.resumeAfterSuspension().catch((error) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume perch after suspension' });
                    perchSessionRunner.clearSuspension();
                });
            }
        },
    });

    // Helper to update presence when starting to process a user message
    const updatePresenceForMessageStart = (context?: DiscordMessageContext): void => {
        if(!context) {
            logger.warn('Processor called with empty contexts array');
            return;
        }
        if(botStateManager.getMode() === 'idle') {
            botStateManager.startProcessingMessage(context.channelId, context.content);
        }
    };

    // Helper to complete presence updates after message processing
    const completePresenceForMessage = (
        streamEventHandler: PresenceStreamHandler | undefined,
        wasInterrupted: boolean
    ): void => {
        // Don't transition to idle if session was interrupted for batching
        // (the coordinator will immediately restart with batched messages)
        if(wasInterrupted) {
            return;
        }

        // Transition to idle after completion
        const currentMode = botStateManager.getMode();
        if(streamEventHandler) {
            streamEventHandler.complete();
        }

        // Transition state manager to idle when message processing completes
        if(currentMode === 'processing_message') {
            botStateManager.goIdle();
        }
    };

    // Set the processor to call agent.handleInput
    coordinator.setProcessor(async (contexts, resumeContext, abortSignal) => {
        // Update presence to show processing message if not in catch-up mode
        updatePresenceForMessageStart(contexts[0]);

        // Create abort controller from signal
        const abortController = new AbortController();
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

        // Process attachments from all contexts
        const { images, contentAdditions } = await processAttachments(contexts);

        // Modify contexts to include attachment file paths in content, then prepend the
        // requesting-user line so Izzy knows who she's answering (there is no ambient
        // conversation context for MCP tools any more).
        const modifiedContexts = prependRequestingUserLine(addAttachmentInfoToContexts(contexts, contentAdditions));

        // Extract user message from first context for synopsis generation
        const userMessage = contexts[0]?.content ?? '';

        // Create stream event handler for presence updates if presenceManager available
        const streamEventHandler = await createPresenceStreamHandler(
            presenceManager,
            dynamicStatusGenerator,
            userMessage,
            botStateManager,
            params.onThinkingContentUpdate
        );

        // Get unmuted channels and format for system prompt
        const registry = params.channelRegistry;
        const client = params.readyClient;
        const unmutedChannels = await registry.getUnmutedChannels();
        const channelList = unmutedChannels.map((channel: ChannelMetadata) => {
            // Get guild name for disambiguation
            let guildName: string | undefined;
            if(channel.guildId !== 'DM') {
                try {
                    const guild = client.guilds.cache.get(channel.guildId);
                    guildName = guild?.name;
                } catch{
                    // Silent: guilds.cache.get() can throw on edge cases (stale cache entry,
                    // guild object corruption). Guild name is cosmetic disambiguation only —
                    // the channel list still renders without it.
                }
            }

            // Format: "channelName (guildName) [well-known: type]" or "channelName [well-known: type]"
            let formatted = channel.channelName;
            if(guildName) {
                formatted += ` (${guildName})`;
            }
            if(channel.isWellKnown) {
                formatted += ` [well-known: ${channel.isWellKnown}]`;
            }
            return formatted;
        });

        // Build context note for suspended sessions
        let contextNote: string | undefined;
        if(perchSessionRunner?.isSuspended()) {
            contextNote = 'Note: This message arrived during perch-time, which has been paused. Respond normally to the user. Perch-time will resume after this conversation.';
        } else if(catchUpSessionRunner?.isSuspended()) {
            contextNote = 'Note: This message arrived during catch-up, which has been paused. Respond normally to the user. Catch-up will resume after this conversation.';
        }

        // Auto-inject cross-platform history for the sender
        const HISTORY_FETCH_TIMEOUT_MS = 5000;
        let personHistory: string | undefined;
        if(params.historyCoordinator) {
            try {
                const historyPromise = (async () => {
                    const senderUsername = contexts[0]?.username;
                    if(senderUsername) {
                        const historyResult = await params.historyCoordinator!.getPersonHistory(
                            senderUsername, { timeWindowMinutes: 120, maxMessagesPerPlatform: 10, platformHint: 'discord' }
                        );
                        if(historyResult.history) {
                            return historyResult.history;
                        }
                    }
                    // If no person found or no history, fall back to channel-local history
                    const channelId = contexts[0]?.channelId;
                    const messageId = contexts[0]?.messageId;
                    if(channelId) {
                        return params.historyCoordinator!.getChannelLocalHistory(channelId, messageId);
                    }
                    return undefined;
                })();

                personHistory = await Promise.race([
                    historyPromise,
                    new Promise<undefined>((resolve) => { setTimeout(resolve, HISTORY_FETCH_TIMEOUT_MS); }),
                ]);
            } catch (err) {
                logger.warn({ err }, 'Failed to fetch person history for context injection');
            }
        }

        // Call handleInput with presence updates, images, and channel context
        const result = await agent.handleInput(toMessageContexts(modifiedContexts), {
            resumeContext: resumeContext ?? undefined,
            abortController,
            onStreamEvent: streamEventHandler?.onStreamEvent,
            images:        images.length > 0 ? toPlatformImages(images) : undefined,
            channelList,
            contextNote,
            personHistory,
        });

        // Complete presence updates after processing
        // Pass wasInterrupted flag to skip idle transition for batching
        completePresenceForMessage(streamEventHandler, result.wasInterrupted);

        return result;
    });

    return coordinator;
}

/**
 * The conductor-mode branch of {@link setupCoordinatorIntegration}: the processor is
 * `createConductorProcessor(...)` (never `agent.handleInput`), `onProcessingEnd` never calls
 * `goIdle` (the ledger shim — `../state/ledger-shim.ts` — is the sole writer of that transition
 * in conductor mode), and `onResponse` delivers exactly once through
 * `conversationConductor.deliver` — keyed on `result.envelopeId`, the CONDUCTOR's own envelope
 * id (`conductor-processor.ts` passes it through on every `ProcessResult`), not the triggering
 * Discord message id: a merged multi-message batch has one envelope id and potentially several
 * Discord message ids, and `deliver`'s guard is the same one `open()` seeds from crash-recovery
 * at boot (`params.deliveryGuard`/`params.journal` are unused here — `deliver` journals
 * `response_delivered` on the conductor's own injected journal, the same object as
 * `params.journal`, so there is no second write path — see conductor.ts's own module doc for why
 * a second, independently-seeded guard cannot provide the same idempotency).
 *
 * P10: the actual send goes through {@link sendEnvelopeResponse} (client-based, no triggering
 * `Message` to reply to/thread through) instead of the legacy `sendResponse`, and an
 * outbox-queued send (`sent: false, queued: true`) counts as delivered too — the outbox now owns
 * retrying it, so `deliver`'s journal write must still happen or a later boot's crash recovery
 * would treat it as undelivered and resend a second copy. Only the `@@NO_RESPONSE@@` sentinel or
 * a missing well-known channel (`sent: false` with no `queued`) skips the journal write. On every
 * one of those three outcomes — sent, no-response skip, or outbox-queued — `inboxManager`'s
 * per-channel HANDLED watermark advances (`recordHandled`, once per channel via
 * {@link newestMessagePerChannel}): the outbox owns retrying a queued send, so the message is not
 * "still unhandled" from the replay watermark's point of view. `addRecentMessage`/the
 * activity-log write are kept unchanged from the legacy branch (folded gap: the idle-status
 * generator's inputs are unaffected by which processor is wired in). The legacy branch's
 * catch-up/perch resume-after-suspension calls ARE also kept here, unchanged: until P12 opens a
 * perch conductor, `bot.ts` still constructs the legacy `catchUpSessionRunner`/`perchSessionRunner`
 * (and, for perch, its scheduler) regardless of mode, and `handlers.ts`'s `handleModeInterruptions`
 * still suspends them on a live Discord message — the ledger shim explicitly never touches
 * `perching`/`catching_up` (see `ledger-shim.ts`'s own doc), so nothing else would ever resume a
 * run this branch's own turn interrupted, leaving it suspended for the rest of the process
 * lifetime. Only the conversation session's own `idle`/`processing_message` transitions are the
 * ledger shim's exclusively, which is why the earlier `onProcessingEnd` above stays a no-op.
 * @param params The same params `setupCoordinatorIntegration` received.
 * @param conversationConductor Non-optional here — `setupCoordinatorIntegration` only calls this
 * when `params.conversationConductor` is defined.
 * @returns The conductor-backed `MessageCoordinator`.
 */
function setupConductorCoordinator(params: SetupCoordinatorParams, conversationConductor: Conductor): MessageCoordinator {
    const {
        responseRouter, rateLimiter, readyClient, botStateManager,
        contextPolicy, envelopeProvider, contextBuilder, inboxManager,
        catchUpSessionRunner, perchSessionRunner, ledgerStore, presenceThrottle, dynamicStatusGenerator,
        onThinkingContentUpdate,
    } = params;

    const coordinator = new MessageCoordinator({
        debounceMs:      250,
        registryReady:   () => params.channelRegistry.isReady(),
        onProcessingEnd: () => {
            // No-op: startProcessingMessage/goIdle in conductor mode are owned entirely by
            // ../state/ledger-shim.ts, driven by the conductor's own ledger — never by the
            // coordinator's processing-end signal.
        },
        // eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- onResponse coordinates idempotent delivery, the per-channel HANDLED watermark, ring-buffer, activity-log and legacy catch-up/perch resume writes (mirrors the legacy branch's own disable at line 306); branching is inherent
        onResponse: async (result, discordMessage, batch) => {
            if(result.response && discordMessage) {
                params.addRecentMessage?.(result.response, 'izzy');

                const { envelopeId } = result;
                if(envelopeId === undefined) {
                    // Should not happen in practice — createConductorProcessor always sets it —
                    // but delivering under a fabricated id would break deliver()'s idempotency
                    // guarantee, so skip the send entirely rather than guess.
                    logger.warn({ msg: 'Conductor response has no envelopeId — cannot deliver idempotently, skipping send' });
                } else {
                    try {
                        const deliverResult = await conversationConductor.deliver(envelopeId, async () => {
                            const sendResult = await sendEnvelopeResponse({
                                envelopeId,
                                kind:              'discord',
                                channelId:         createChannelId(discordMessage.channelId),
                                text:              result.response!,
                                responseRouter,
                                client:            readyClient,
                                rateLimiter,
                                discordCapability: params.discordCapability,
                            });
                            if(!sendResult.sent && !sendResult.queued) {
                                // Genuinely nothing to journal — the @@NO_RESPONSE@@ sentinel or a
                                // missing well-known channel. Throwing here is deliver()'s only way
                                // to learn the send did not happen at all, so it does not journal a
                                // response_delivered row or mark the guard for something that was
                                // never actually delivered (or queued for later delivery).
                                throw new ResponseNotSentError();
                            }
                            return { channelId: discordMessage.channelId, messageIds: [] };
                        });
                        if(deliverResult.delivered) {
                            params.addRecentChannel?.(createChannelId(discordMessage.channelId));
                        }
                    } catch (err) {
                        if(!(err instanceof ResponseNotSentError)) {
                            logger.error({ err, envelopeId, msg: 'Conductor response delivery failed' });
                        }
                    }

                    // P10: advance the per-channel HANDLED watermark on every one of the three
                    // outcomes above (sent, no-response skip, or outbox-queued) — only an
                    // interrupted turn with no response at all (the outer `if` above being false)
                    // leaves a batch's messages unhandled for a future crash replay.
                    if(inboxManager) {
                        for(const [channelId, newestMessage] of newestMessagePerChannel(batch)) {
                            try {
                                // eslint-disable-next-line no-await-in-loop -- sequential per-channel watermark writes, bounded by the batch's small channel count
                                await inboxManager.recordHandled(createChannelId(channelId), newestMessage.id, newestMessage.createdAt.toISOString());
                            } catch (err) {
                                logger.warn({ err, channelId, msg: 'Failed to record handled watermark' });
                            }
                        }
                    }
                }

                // Log the exchange as activity (fire-and-forget with Haiku summary) — identical to
                // the legacy branch, per the folded idle-status-inputs gap.
                if(params.activityLogger) {
                    const userContent = discordMessage.content;
                    const botResponse = result.response;
                    const actLogger = params.activityLogger;
                    void (async () => {
                        try {
                            let summary = 'Discord exchange in channel';
                            const generated = await generateText(
                                `Summarize this Discord exchange in one sentence (max 30 words):\nUser: ${userContent.slice(0, 500)}\nIzzy: ${botResponse.slice(0, 500)}`
                            );
                            if(generated) {
                                summary = generated;
                            }
                            await actLogger.log({
                                type: 'discord-exchange',
                                summary,
                            });
                        } catch (err) {
                            logger.warn({ err, channelId: discordMessage.channelId, msg: 'Activity log failed for Discord exchange' });
                        }
                    })();
                }
            }

            params.setLastSessionId?.(result.sessionId);

            // Resume catch-up/perch if a live message interrupted a suspended legacy run — kept
            // identical to the legacy branch (see this function's own doc for why the ledger shim
            // does not make these unnecessary until P12 retires the legacy runners entirely).
            if(botStateManager.getMode() === 'idle' && catchUpSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming catch-up after suspension' });
                void catchUpSessionRunner.resumeAfterSuspension().catch((error: unknown) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume catch-up after suspension' });
                    catchUpSessionRunner.clearSuspension();
                });
            }

            if(botStateManager.getMode() === 'idle' && perchSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming perch after suspension' });
                void perchSessionRunner.resumeAfterSuspension().catch((error: unknown) => {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume perch after suspension' });
                    perchSessionRunner.clearSuspension();
                });
            }
        },
    });

    coordinator.setProcessor(createConductorProcessor({
        conductor:        conversationConductor,
        contextPolicy:    contextPolicy!,
        envelopeProvider: envelopeProvider!,
        contextBuilder:   contextBuilder!,
        resolveTimezone,
        logger,
        ledgerStore,
        throttle:         presenceThrottle,
        dynamicStatusGenerator,
        onThinkingContentUpdate,
    }));

    return coordinator;
}
// Stryker restore all
