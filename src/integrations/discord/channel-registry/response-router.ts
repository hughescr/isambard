import type { SessionType } from '../state/types';
import type { ChannelId } from '../types';
import type { ChannelRegistryManager } from './manager';
import { processResponse } from './sentinel';
import type { WellKnownChannel } from './types';
import { InvariantViolationError, WellKnownChannelNotFoundError } from '@/errors';

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

interface ResponseRouterConfig {
    manager: ChannelRegistryManager
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
     * @returns Routing result with target channel and processed content
     */
    async routeResponse(
        sessionType: SessionType,
        response: string,
        originChannelId: ChannelId | undefined
    ): Promise<RoutingResult> {
        // Process response for sentinel
        const { shouldSend, content } = processResponse(response);

        // For DM or regular message processing, use origin channel
        // Stryker disable next-line ConditionalExpression,BlockStatement: Early return for dm/processing_message — without this guard, would fall through to wellKnown lookup which returns same result when originChannelId is defined
        if(sessionType === 'dm' || sessionType === 'processing_message') {
            if(!originChannelId) {
                // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
                throw new InvariantViolationError('routeResponse', `originChannelId is required for session type: ${sessionType}`);
            }
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
            if(!originChannelId) {
                // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
                throw new InvariantViolationError('routeResponse', `originChannelId is required for fallback routing with session type: ${sessionType}`);
            }
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

        // Well-known channel missing - try fallback
        const fallbackChannel = await this.config.manager.getWellKnownChannel('fallback');

        if(fallbackChannel) {
            const fallbackReason = `⚠️ Channel #${wellKnownType} not configured, routing to fallback.\n\n`;
            return {
                targetChannelId: fallbackChannel.channelId,
                shouldSend,
                content:         fallbackReason + content,
                isFallback:      true,
                fallbackReason:  `#${wellKnownType} not configured`,
            };
        }

        // Both well-known and fallback missing - throw error
        throw new WellKnownChannelNotFoundError(wellKnownType);
    }

    /**
     * Gets the target channel for a session type without processing a response.
     * Useful for logging or preview.
     */
    async getTargetChannel(sessionType: SessionType, originChannelId: ChannelId | undefined): Promise<ChannelId> {
        // Stryker disable next-line ConditionalExpression,BlockStatement: Early return for dm/processing_message — without this guard, would fall through to wellKnown lookup which returns same result when originChannelId is defined
        if(sessionType === 'dm' || sessionType === 'processing_message') {
            if(!originChannelId) {
                // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
                throw new InvariantViolationError('getTargetChannel', `originChannelId is required for session type: ${sessionType}`);
            }
            return originChannelId;
        }

        const wellKnownType = SESSION_TO_CHANNEL[sessionType];
        if(!wellKnownType) {
            if(!originChannelId) {
                // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
                throw new InvariantViolationError('getTargetChannel', `originChannelId is required for fallback routing with session type: ${sessionType}`);
            }
            return originChannelId;
        }

        const wellKnownChannel = await this.config.manager.getWellKnownChannel(wellKnownType);
        if(!wellKnownChannel) {
            throw new WellKnownChannelNotFoundError(wellKnownType);
        }

        return wellKnownChannel.channelId;
    }
}
