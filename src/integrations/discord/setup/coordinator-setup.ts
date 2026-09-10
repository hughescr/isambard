import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import {
    fetchImages,
    saveNonImageAttachment,
    isSupportedImageType,
    formatBytes
} from '../attachments';
import type { FetchedImage } from '../attachments/types';
import type { DiscordCapability } from '../capability';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import type { InboxManager } from '../inbox';
import { MessageCoordinator } from '../message-coordinator';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse } from '../response-sender';
import { createChannelId, type ChannelId, type DiscordMessageContext } from '../types';
import { createConductorProcessor, type DiscordEnvelopeProvider } from './conductor-processor';
import {
    type PlatformImage, type ActivityLogger, type Conductor, type ContextPolicy, type ContextBuilder, type TimeHeaderProvider, generateText
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
 * (`onResponse`, below) when `sendEnvelopeResponse` reports neither `sent` nor `queued` — an
 * expected outcome (the `@@NO_RESPONSE@@` sentinel or a missing well-known channel), not a
 * failure. Distinguishes that case from a genuine delivery error so `deliver`'s caller logs only
 * the latter.
 */
class ResponseNotSentError extends Error {}

/**
 * Parameters for setting up coordinator integration.
 */
interface SetupCoordinatorParams {
    responseRouter:     ResponseRouter
    rateLimiter:        DiscordRateLimiter
    readyClient:        Client
    channelRegistry:    ChannelRegistryManager
    setLastSessionId?:  (sessionId: string | undefined) => void
    addRecentMessage?:  (content: string, author: 'user' | 'izzy') => void
    /** Push a channel into the recent-channels ring buffer on successful response send. */
    addRecentChannel?:  (channelId: ChannelId) => void
    activityLogger?:    ActivityLogger
    discordCapability?: DiscordCapability
    /**
     * Advances each channel's HANDLED watermark (`recordHandled`) once a batch's envelope has
     * finished being handled (sent, `@@NO_RESPONSE@@` skip, or outbox-queued).
     */
    inboxManager?:      InboxManager

    /**
     * The long-lived conversation conductor: the coordinator's processor is always
     * `createConductorProcessor(...)`, and `onResponse` delivers exactly once via
     * `conversationConductor.deliver` (keyed on the conductor's own envelope id, idempotent
     * against the same guard `open()` seeds from crash recovery at boot). Presence/activity-phase
     * transitions are driven entirely by the conductor's own ledger (composed by
     * `presence-setup.ts`'s `setupConductorPresence`), not by this coordinator.
     * `conversationConductor`/`contextPolicy`/`envelopeProvider`/
     * `contextBuilder` travel together — this file stays Stryker-disabled so no test exercises
     * the required-ness itself, only bot.ts's own wiring, which always supplies all four.
     */
    conversationConductor: Conductor
    contextPolicy:         ContextPolicy
    envelopeProvider:      DiscordEnvelopeProvider
    /** `createConductorProcessor`'s own timezone dependency. */
    contextBuilder?:       Pick<ContextBuilder, 'loadUserTimezone' | 'loadUserMemories'>
    /** Session-peers block 4: forwarded verbatim into `createConductorProcessor` — see its own `CreateConductorProcessorParams.timeHeader` doc. */
    timeHeader?:           TimeHeaderProvider
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
 * Sets up the message coordinator integration with the long-lived conversation conductor: the
 * processor is always `createConductorProcessor(...)`, `onProcessingEnd` is a no-op (presence/
 * activity-phase transitions are driven entirely by the conductor's own ledger, composed in
 * `presence-setup.ts`), and `onResponse` delivers exactly once through `conversationConductor.deliver` — keyed on
 * `result.envelopeId`, the CONDUCTOR's own envelope id (`conductor-processor.ts` passes it
 * through on every `ProcessResult`), not the triggering Discord message id: a merged
 * multi-message batch has one envelope id and potentially several Discord message ids.
 *
 * The actual send goes through {@link sendEnvelopeResponse} (client-based, no triggering
 * `Message` to reply to/thread through), and an outbox-queued send (`sent: false, queued: true`)
 * counts as delivered too — the outbox now owns retrying it, so `deliver`'s journal write must
 * still happen or a later boot's crash recovery would treat it as undelivered and resend a
 * second copy. Only the `@@NO_RESPONSE@@` sentinel or a missing well-known channel (`sent: false`
 * with no `queued`) skips the journal write. On every one of those three outcomes — sent,
 * no-response skip, or outbox-queued — `inboxManager`'s per-channel HANDLED watermark advances
 * (`recordHandled`, once per channel via {@link newestMessagePerChannel}): the outbox owns
 * retrying a queued send, so the message is not "still unhandled" from the replay watermark's
 * point of view.
 * @param params - Configuration for coordinator setup
 * @returns Configured message coordinator
 */
// Stryker disable all: Integration function coordinating multiple components with callbacks - tested via bot integration tests
export function setupCoordinatorIntegration(params: SetupCoordinatorParams): MessageCoordinator {
    const {
        responseRouter, rateLimiter, readyClient,
        conversationConductor, contextPolicy, envelopeProvider, contextBuilder, inboxManager,
    } = params;

    const coordinator = new MessageCoordinator({
        debounceMs:      250,
        registryReady:   () => params.channelRegistry.isReady(),
        onProcessingEnd: () => {
            // No-op: presence/activity-phase transitions are driven entirely by the conductor's
            // own ledger (composed in presence-setup.ts), never by the coordinator's
            // processing-end signal.
        },
        // eslint-disable-next-line sonarjs/cognitive-complexity -- onResponse coordinates idempotent delivery, the per-channel HANDLED watermark, ring-buffer, and activity-log writes; branching is inherent
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

                    // Advance the per-channel HANDLED watermark on every one of the three outcomes
                    // above (sent, no-response skip, or outbox-queued) — only an interrupted turn
                    // with no response at all (the outer `if` above being false) leaves a batch's
                    // messages unhandled for a future crash replay.
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

                // Log the exchange as activity (fire-and-forget with Haiku summary).
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
        },
    });

    coordinator.setProcessor(createConductorProcessor({
        conductor:      conversationConductor,
        contextPolicy,
        envelopeProvider,
        contextBuilder: contextBuilder!,
        resolveTimezone,
        logger,
        timeHeader:     params.timeHeader,
    }));

    return coordinator;
}
// Stryker restore all
