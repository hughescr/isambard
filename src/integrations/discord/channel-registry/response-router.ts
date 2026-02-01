import type { ChannelRegistryManager } from './manager';
import type { DMTracker } from './dm-tracker';
import type { WellKnownChannel } from './types';
import type { ChannelId, UserId } from '../types';
import { processResponse } from './sentinel';

export type SessionType = 'catching_up' | 'perching' | 'processing_message' | 'dm';

export interface RoutingResult {
    /** The channel to send the response to */
    targetChannelId: ChannelId
    /** Whether to actually send (false if sentinel detected) */
    shouldSend:      boolean
    /** The cleaned response content */
    content:         string
    /** Whether we fell back to DM due to missing channel */
    isFallback:      boolean
    /** Error message if fallback was needed */
    fallbackReason?: string
}

export interface ResponseRouterConfig {
    manager:   ChannelRegistryManager
    dmTracker: DMTracker
}

/**
 * Maps session types to their well-known channel targets.
 */
const SESSION_TO_CHANNEL: Partial<Record<SessionType, WellKnownChannel>> = {
    catching_up: 'catch-up',
    perching:    'perch-time',
};

export class ResponseRouter {
    constructor(private readonly config: ResponseRouterConfig) {}

    /**
     * Determines where to route a response based on session type.
     *
     * @param sessionType - The type of session that generated the response
     * @param response - The raw response from the agent
     * @param originChannelId - The channel where the triggering message came from
     * @param triggeringUserId - The user who triggered the session (for DM fallback)
     * @returns Routing result with target channel and processed content
     */
    async routeResponse(
        sessionType: SessionType,
        response: string,
        originChannelId: ChannelId,
        triggeringUserId: UserId
    ): Promise<RoutingResult> {
        // Process response for sentinel
        const { shouldSend, content } = processResponse(response);

        // For DM or regular message processing, use origin channel
        // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - falls through to same result via !wellKnownType path
        if(sessionType === 'dm' || sessionType === 'processing_message') {
            return {
                targetChannelId: originChannelId,
                shouldSend,
                content,
                isFallback:      false,
            };
        }

        // For catch-up or perch, try well-known channel
        const wellKnownType = SESSION_TO_CHANNEL[sessionType];
        if(!wellKnownType) {
            // Shouldn't happen, but fallback to origin
            return {
                targetChannelId: originChannelId,
                shouldSend,
                content,
                isFallback:      false,
            };
        }

        // Try to get well-known channel
        const wellKnownChannel = await this.config.manager.getWellKnownChannel(wellKnownType);

        if(wellKnownChannel) {
            return {
                targetChannelId: wellKnownChannel.channelId,
                shouldSend,
                content,
                isFallback:      false,
            };
        }

        // Well-known channel missing - fallback to DM
        const dmChannelId = await this.config.dmTracker.getOrCreateDM(triggeringUserId);

        return {
            targetChannelId: dmChannelId,
            shouldSend,
            content,
            isFallback:      true,
            fallbackReason:  `Well-known channel #${wellKnownType} not found. Response sent via DM instead.`,
        };
    }

    /**
     * Gets the target channel for a session type without processing a response.
     * Useful for logging or preview.
     */
    async getTargetChannel(sessionType: SessionType, originChannelId: ChannelId): Promise<ChannelId> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Equivalent mutant - falls through to same result via !wellKnownType path
        if(sessionType === 'dm' || sessionType === 'processing_message') {
            return originChannelId;
        }

        const wellKnownType = SESSION_TO_CHANNEL[sessionType];
        if(!wellKnownType) {
            return originChannelId;
        }

        const wellKnownChannel = await this.config.manager.getWellKnownChannel(wellKnownType);
        return wellKnownChannel?.channelId ?? originChannelId;
    }
}
