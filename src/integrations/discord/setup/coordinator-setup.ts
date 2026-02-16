import type { Client } from 'discord.js';
import _ from 'lodash';
import { logger } from '@hughescr/logger';
import type { ClaudeAgent } from '@/agent/agent';
import { setConversationContext, clearConversationContext } from '@/agent';
import type { BotStateManager } from '../state';
import { createDynamicStatusGenerator, type PresenceManager } from '../presence';
import type { DiscordMessageContext } from '../types';
import { MessageCoordinator } from '../message-coordinator';
import type { CatchUpSessionRunner } from '../catchup';
import type { PerchSessionRunner } from '@/agent/perch';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import type { DiscordRateLimiter } from '../rate-limiter';
import {
    fetchImages,
    saveNonImageAttachment,
    isSupportedImageType,
    formatBytes,
    addAttachmentInfoToContexts
} from '../attachments';
import type { FetchedImage } from '../attachments/types';
import { sendResponse } from '../response-sender';
import { createPresenceStreamHandler } from './presence-stream-handler';

/**
 * Result of processing Discord message attachments
 */
interface ProcessedAttachments {
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
async function processAttachments(contexts: DiscordMessageContext[]): Promise<ProcessedAttachments> {
    const allAttachments = contexts.flatMap(ctx => ctx.attachments ?? []);
    let images: FetchedImage[] = [];
    const contentAdditions: string[] = [];

    if(allAttachments.length > 0) {
        // Fetch images
        const imageAttachments = _.filter(allAttachments, att => isSupportedImageType(att.contentType));
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

        // Save non-image attachments to scratch directory
        const nonImageAttachments = _.filter(allAttachments, att => !isSupportedImageType(att.contentType));
        if(nonImageAttachments.length > 0) {
            const scratchDir = process.cwd();
            const messageId = contexts[0]?.messageId ?? 'unknown';

            for(const attachment of nonImageAttachments) {
                const stored = await saveNonImageAttachment(attachment, scratchDir, messageId);
                if(stored) {
                    contentAdditions.push(
                        `[Attached file: ${stored.localPath} (${stored.contentType}, ${formatBytes(stored.size)})]`
                    );
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
 * Parameters for setting up coordinator integration.
 */
export interface SetupCoordinatorParams {
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
    eventDeltaTracker?:       import('../../../agent/event-delta-tracker').EventDeltaTracker
    onThinkingContentUpdate?: (content: string) => void
    setLastSessionId?:        (sessionId: string | undefined) => void
}

/**
 * Maps a single Discord message context to platform-agnostic message context for the agent.
 */
export function toMessageContext(context: DiscordMessageContext): import('@/agent/types').MessageContext {
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
export function toMessageContexts(contexts: DiscordMessageContext[]): import('@/agent/types').MessageContext[] {
    return _.map(contexts, toMessageContext);
}

/**
 * Maps Discord fetched images to platform-agnostic image format for the agent.
 */
export function toPlatformImages(images: FetchedImage[]): import('@/agent/types').PlatformImage[] {
    return _.map(images, img => ({
        filename:     img.filename,
        mediaType:    img.mediaType,
        base64Data:   img.base64Data,
        originalSize: img.originalSize,
        width:        img.width,
        height:       img.height,
    }));
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
        onResponse:        async (result, discordMessage) => {
            // Only send response if we have both a response and a message to reply to
            if(result.response && discordMessage) {
                // Capture rate limiter reference for safe closure access
                const limiter = rateLimiter;

                await sendResponse({
                    responseRouter,
                    botStateManager,
                    response:           result.response,
                    message:            discordMessage,
                    rateLimiter:        limiter,
                    client:             readyClient,
                    useFallbackOnError: false,
                });
            }

            // Update session ID tracker
            params.setLastSessionId?.(result.sessionId);

            // Resume catch-up if we were suspended
            if(botStateManager.getMode() === 'idle' && catchUpSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming catch-up after suspension' });
                // Resume catch-up (async, don't await)
                void catchUpSessionRunner.resumeAfterSuspension().catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
                    logger.error({ error: errorMsg, msg: 'Failed to resume catch-up after suspension' });
                    // Clear suspension state (error recovery)
                    catchUpSessionRunner.clearSuspension();
                });
            }

            // Resume perch if we were suspended
            if(botStateManager.getMode() === 'idle' && perchSessionRunner?.isSuspended()) {
                logger.info({ msg: 'Resuming perch after suspension' });
                void perchSessionRunner.resumeAfterSuspension().catch((error) => {
                    const errorMsg = _.isError(error) ? error.message : String(error);
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
        streamEventHandler: ReturnType<typeof createPresenceStreamHandler> | undefined,
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
    coordinator.setProcessor(async (contexts, resumeContext, sessionId, abortSignal) => {
        // Update presence to show processing message if not in catch-up mode
        updatePresenceForMessageStart(contexts[0]);

        // Set conversation context for MCP tools
        setConversationContext({
            currentUserId:    contexts[0]?.userId,
            currentChannelId: contexts[0]?.channelId,
        });

        try {
            // Create abort controller from signal
            const abortController = new AbortController();
            abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Process attachments from all contexts
            const { images, contentAdditions } = await processAttachments(contexts);

            // Modify contexts to include attachment file paths in content
            const modifiedContexts = addAttachmentInfoToContexts(contexts, contentAdditions);

            // Extract user message from first context for synopsis generation
            const userMessage = contexts[0]?.content ?? '';

            // Create stream event handler for presence updates if presenceManager available
            const streamEventHandler = createPresenceStreamHandler(
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
            const channelList = _.map(unmutedChannels, (channel: import('../channel-registry/types').ChannelMetadata) => {
                // Get guild name for disambiguation
                let guildName: string | undefined;
                if(channel.guildId !== 'DM') {
                    try {
                        const guild = client.guilds.cache.get(channel.guildId);
                        guildName = guild?.name;
                    } catch{
                        // Guild not in cache, skip guild name
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

            // Call handleInput with presence updates, images, and channel context
            const result = await agent.handleInput(toMessageContexts(modifiedContexts), {
                sessionId,
                resumeContext: resumeContext ?? undefined,
                abortController,
                onStreamEvent: streamEventHandler?.onStreamEvent,
                images:        images.length > 0 ? toPlatformImages(images) : undefined,
                channelList,
                contextNote,
            });

            // Complete presence updates after processing
            // Pass wasInterrupted flag to skip idle transition for batching
            completePresenceForMessage(streamEventHandler, result.wasInterrupted);

            return result;
        } finally {
            // Clear context after processing
            clearConversationContext();
        }
    });

    return coordinator;
}
// Stryker restore all
