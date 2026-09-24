import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import pLimit from 'p-limit';
import {
    fetchImages,
    saveNonImageAttachment,
    isSupportedImageType,
    formatBytes
} from '../attachments';
import type { AttachmentMetadata, FetchedImage } from '../attachments/types';
import type { DiscordCapability } from '../capability';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import type { InboxManager } from '../inbox';
import { MessageCoordinator } from '../message-coordinator';
import type { DiscordRateLimiter } from '../rate-limiter';
import { queuedOutboxIdsFromPartialResponse, sendEnvelopeResponse } from '../response-sender';
import { createChannelId, type ChannelId, type DiscordMessageContext, type ExchangeSpeaker } from '../types';
import { createConductorProcessor, type DiscordEnvelopeDeps } from './conductor-processor';
import {
    type PlatformImage, type ActivityLogger, type Conductor, type ContextPolicy, type ContextBuilder, type TimeHeaderProvider, generateText
} from '@/agent';
import { ResponseUnavailableError } from '@/errors';
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

async function saveNonImageAttachments(
    attachments: AttachmentMetadata[],
    scratchDir: string,
    messageId: string
): Promise<string[]> {
    const additions: string[] = [];
    const saveNext = async (index: number): Promise<void> => {
        const attachment = attachments[index];
        if(!attachment) {
            return;
        }
        const stored = await saveNonImageAttachment(attachment, scratchDir, messageId);
        if(stored) {
            const detail = `${stored.localPath} (${stored.contentType}, ${formatBytes(stored.size)})`;
            additions.push(stored.contentType.startsWith('video/')
                ? `[Video file saved: ${detail}. Use analyzeLocalVideo to analyze this video for scene frames, metadata, and transcription.]`
                : `[Attached file: ${detail}]`);
            logger.info({
                filename:    stored.originalFilename, localPath:   stored.localPath,
                contentType: stored.contentType, size:        stored.size,
                msg:         `Saved non-image attachment: ${stored.originalFilename}`,
            });
        } else {
            logger.warn({
                filename:    attachment.filename, contentType: attachment.contentType,
                msg:         `Failed to save non-image attachment: ${attachment.filename}`,
            });
        }
        await saveNext(index + 1);
    };
    await saveNext(0);
    return additions;
}

/**
 * Processes all attachments from Discord contexts.
 * Images are fetched and prepared for Claude's vision API.
 * Non-image files are saved to the scratch directory and referenced in text.
 *
 * @param contexts - Discord message contexts containing attachments
 * @returns Processed images and content additions for message text
 */
export async function processAttachments(contexts: DiscordMessageContext[]): Promise<ProcessedAttachments> {
    if(contexts.length === 0) {
        return { images: [], contentAdditions: [] };
    }

    const allAttachments = contexts.flatMap(ctx => ctx.attachments ?? []);
    let images: FetchedImage[] = [];
    const contentAdditions: string[] = [];

    const imageAttachments = allAttachments.filter(att => isSupportedImageType(att.contentType));
    if(imageAttachments.length > 0) {
        const result = await fetchImages(imageAttachments);
        images = result.images;
        logger.info({
            totalAttachments: imageAttachments.length,
            fetchedImages:    images.length,
            failedImages:     result.failures.length,
            msg:              `Fetched ${images.length} images from ${imageAttachments.length} image attachments (${result.failures.length} failed)`,
        });

        for(const failure of result.failures) {
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

    const nonImageAttachments = allAttachments.filter(att => !isSupportedImageType(att.contentType));
    contentAdditions.push(...await saveNonImageAttachments(
        nonImageAttachments, process.cwd(), contexts[0]!.messageId
    ));

    return { images, contentAdditions };
}
/**
 * Parameters for setting up coordinator integration.
 */
interface SetupCoordinatorParams {
    responseRouter:     ResponseRouter
    rateLimiter:        DiscordRateLimiter
    readyClient:        Client
    channelRegistry:    ChannelRegistryManager
    setLastSessionId?:  (sessionId: string | undefined) => void
    addRecentMessage?:  (content: string, author: ExchangeSpeaker) => void
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
     * `contextBuilder` travel together; bot.ts's own wiring always supplies all four.
     */
    conversationConductor: Conductor
    contextPolicy:         ContextPolicy
    envelopeProvider:      DiscordEnvelopeDeps
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
 * This pure helper has direct behavioral coverage for its snowflake comparison and `!existing`
 * guard, while its caller exercises the delivery and watermark data flow.
 */
function newestMessagePerChannel(batch: Message[]): Map<string, Message> {
    const newest = new Map<string, Message>();
    for(const message of batch) {
        const existing = newest.get(message.channelId);
        // Stryker disable next-line llm: Map.get returns Message or undefined, and every Message object is truthy, so both guards are equivalent.
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
export function setupCoordinatorIntegration(params: SetupCoordinatorParams): MessageCoordinator {
    const {
        responseRouter, rateLimiter, readyClient,
        conversationConductor, contextPolicy, envelopeProvider, contextBuilder, inboxManager,
    } = params;
    const limitWatermarkWrites = pLimit(3);
    const watermarkTails = new Map<string, Promise<void>>();

    function recordHandledInChannelOrder(manager: InboxManager, channelId: string, message: Message): Promise<void> {
        // Wait outside the concurrency limit so a queued write cannot occupy a permit.
        const previous = watermarkTails.get(channelId) ?? Promise.resolve();
        const write = previous.then(() => limitWatermarkWrites(() => manager.recordHandled(
            createChannelId(channelId), message.id, message.createdAt.toISOString()
        )));
        // The queue tail always settles successfully; the caller observes the write outcome.
        const settledTail = Promise.allSettled([write]).then(() => {
            if(watermarkTails.get(channelId) === settledTail) {
                watermarkTails.delete(channelId);
            }
            return undefined;
        });
        watermarkTails.set(channelId, settledTail);
        return write;
    }

    async function deliverAndMark(
        response: string,
        envelopeId: string | undefined,
        discordMessage: Message,
        batch: Message[]
    ): Promise<void> {
        // Stryker disable next-line llm: envelopeId is string or undefined, never null, so strict and loose undefined checks are equivalent.
        if(envelopeId === undefined) {
            logger.warn({ msg: 'Conductor response has no envelopeId — cannot deliver idempotently, skipping send' });
            return;
        }

        try {
            const deliverResult = await conversationConductor.deliver(envelopeId, async () => {
                const sendResult = await sendEnvelopeResponse({
                    envelopeId,
                    kind:              'discord',
                    channelId:         createChannelId(discordMessage.channelId),
                    text:              response,
                    responseRouter,
                    client:            readyClient,
                    rateLimiter,
                    discordCapability: params.discordCapability,
                });
                switch(sendResult.status) {
                    case 'sent': {
                        return { kind: 'committed', disposition: 'sent', channelId: sendResult.channelId, messageIds: sendResult.messageIds };
                    }
                    case 'queued': {
                        return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: sendResult.outboxIds };
                    }
                    case 'partial': {
                        return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: queuedOutboxIdsFromPartialResponse(sendResult) };
                    }
                    case 'skipped': {
                        return { kind: 'skipped', reason: sendResult.reason };
                    }
                    case 'unavailable': {
                        throw new ResponseUnavailableError();
                    }
                }
            });
            if(deliverResult.outcome === 'committed') {
                params.addRecentChannel?.(createChannelId(discordMessage.channelId));
            }
        } catch (err) {
            logger.error({ err, envelopeId, msg: 'Conductor response delivery failed' });
        }

        // A settled response advances each channel's watermark even when delivery queued or skipped.
        if(inboxManager) {
            const newestByChannel = [...newestMessagePerChannel(batch)];
            const outcomes = await Promise.allSettled(newestByChannel.map(([channelId, newestMessage]) =>
                recordHandledInChannelOrder(inboxManager, channelId, newestMessage)));
            for(const [index, outcome] of outcomes.entries()) {
                if(outcome.status === 'rejected') {
                    logger.warn({ err: outcome.reason, channelId: newestByChannel[index]![0], msg: 'Failed to record handled watermark' });
                }
            }
        }
    }

    function logExchange(response: string, discordMessage: Message): void {
        if(!params.activityLogger) {
            return;
        }
        const userContent = discordMessage.content;
        const actLogger = params.activityLogger;
        void (async () => {
            try {
                let summary = 'Discord exchange in channel';
                const generated = await generateText(
                    `Summarize this Discord exchange in one sentence (max 30 words):\nUser: ${userContent.slice(0, 500)}\nIzzy: ${response.slice(0, 500)}`
                );
                if(generated) {
                    summary = generated;
                }
                await actLogger.log({ type: 'discord-exchange', summary });
            } catch (err) {
                logger.warn({ err, channelId: discordMessage.channelId, msg: 'Activity log failed for Discord exchange' });
            }
        })();
    }

    const coordinator = new MessageCoordinator({
        debounceMs:      250,
        registryReady:   () => params.channelRegistry.isReady(),
        onProcessingEnd: () => {
            // No-op: presence/activity-phase transitions are driven entirely by the conductor's
            // own ledger (composed in presence-setup.ts), never by the coordinator's
            // processing-end signal.
        },
        onResponse: async (result, discordMessage, batch) => {
            if(result.response && discordMessage) {
                params.addRecentMessage?.(result.response, 'izzy');
                await deliverAndMark(result.response, result.envelopeId, discordMessage, batch);
                logExchange(result.response, discordMessage);
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
