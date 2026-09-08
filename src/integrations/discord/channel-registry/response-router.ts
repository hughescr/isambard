import type { ChannelId } from '../types';
import type { ChannelRegistryManager } from './manager';
import { processResponse } from './sentinel';
import type { WellKnownChannel } from './types';
import type { EnvelopeKind } from '@/agent';
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
 * Maps conductor-mode {@link EnvelopeKind}s to their well-known channel targets (P10). Only
 * `catchup`/`perch` route to a well-known channel; every other kind (`discord`, `notification`,
 * and any future kind) requires an explicit `originChannelId` — see {@link ResponseRouter.resolveEnvelopeTarget}.
 */
export const ENVELOPE_KIND_TO_CHANNEL: Partial<Record<EnvelopeKind, WellKnownChannel>> = {
    catchup: 'catch-up',
    perch:   'perch-time',
};

/** Result of {@link ResponseRouter.resolveEnvelopeTarget}. */
export interface EnvelopeRoutingResult {
    /** The channel to send the response to */
    targetChannelId: ChannelId
    /** Whether to actually send (false if sentinel detected) */
    shouldSend:      boolean
    /** The cleaned response content */
    content:         string
}

export class ResponseRouter {
    constructor(private readonly config: ResponseRouterConfig) {}

    /**
     * Resolves the delivery target for a conductor-mode envelope's response (P10). `catchup`/
     * `perch` kinds resolve via {@link ENVELOPE_KIND_TO_CHANNEL} against the channel registry's
     * well-known channels, throwing {@link WellKnownChannelNotFoundError} when that channel isn't
     * configured — there is no fallback-channel attempt here; the
     * caller ({@link import('../response-sender').sendEnvelopeResponse}) decides what a missing
     * well-known channel means. Every other kind (`discord`, `notification`, and any future kind)
     * routes to `originChannelId`, which is required in that case.
     *
     * @param kind - The envelope kind that produced this response
     * @param response - The raw response text to process for the `@@NO_RESPONSE@@` sentinel
     * @param originChannelId - The channel the triggering envelope came from, when it had one
     * @returns The resolved target channel plus sentinel-processed `shouldSend`/`content`
     */
    async resolveEnvelopeTarget(
        kind: EnvelopeKind,
        response: string,
        originChannelId?: ChannelId
    ): Promise<EnvelopeRoutingResult> {
        const { shouldSend, content } = processResponse(response);

        const wellKnownType = ENVELOPE_KIND_TO_CHANNEL[kind];
        if(wellKnownType) {
            const wellKnownChannel = await this.config.manager.getWellKnownChannel(wellKnownType);
            if(!wellKnownChannel) {
                throw new WellKnownChannelNotFoundError(wellKnownType);
            }
            return {
                targetChannelId: wellKnownChannel.channelId,
                shouldSend,
                content,
            };
        }

        if(!originChannelId) {
            // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
            throw new InvariantViolationError('resolveEnvelopeTarget', `originChannelId is required for envelope kind: ${kind}`);
        }

        return {
            targetChannelId: originChannelId,
            shouldSend,
            content,
        };
    }

    /**
     * Routes an operator notification directly to the configured fallback channel.
     * Use this for startup or registry errors that have no associated origin channel.
     *
     * @param content - The notification content to send
     * @returns Routing result targeting the fallback channel, or throws WellKnownChannelNotFoundError
     *          if no fallback channel is configured.
     */
    async routeToFallback(content: string): Promise<RoutingResult> {
        const { shouldSend, content: processedContent } = processResponse(content);

        const fallbackChannel = await this.config.manager.getWellKnownChannel('fallback');
        if(!fallbackChannel) {
            throw new WellKnownChannelNotFoundError('fallback');
        }

        return {
            targetChannelId: fallbackChannel.channelId,
            shouldSend,
            content:         processedContent,
            isFallback:      true,
        };
    }
}
