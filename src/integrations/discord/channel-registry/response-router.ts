import type { ChannelId } from '../types';
import type { ChannelRegistryManager } from './manager';
import { processResponse } from './sentinel';
import type { WellKnownChannel } from './types';
import type { EnvelopeKind, Envelope } from '@/agent';
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

/** Well-known targets for channel-less conductor envelopes; an explicit origin always wins. */
export const ENVELOPE_KIND_TO_CHANNEL: Partial<Record<EnvelopeKind, WellKnownChannel>> = {
    catchup: 'catch-up',
    perch:   'perch-time',
    wrapup:  'perch-time',
};

/** Classification only; the caller owns well-known lookup and fallback delivery. */
export type EnvelopeDeliveryTarget
    = | { kind: 'origin', channelId: ChannelId }
      | { kind: 'well-known', channel: WellKnownChannel }
      | { kind: 'fallback' };

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

    /** Classifies without I/O: start channel, then well-known kind, then caller-managed fallback. */
    resolveDeliveryTarget(envelope: Pick<Envelope, 'kind' | 'channelId'>): EnvelopeDeliveryTarget {
        if(envelope.channelId !== undefined) {
            return { kind: 'origin', channelId: envelope.channelId };
        }
        const channel = ENVELOPE_KIND_TO_CHANNEL[envelope.kind];
        return channel === undefined ? { kind: 'fallback' } : { kind: 'well-known', channel };
    }

    /**
     * Resolves a conductor response with origin-first precedence. Missing mapped channels throw
     * {@link WellKnownChannelNotFoundError}; caller-managed fallback is never implicit here.
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

        const target = this.resolveDeliveryTarget({ kind, channelId: originChannelId });
        switch(target.kind) {
            case 'origin': {
                return { targetChannelId: target.channelId, shouldSend, content };
            }
            case 'well-known': {
                const channel = await this.config.manager.getWellKnownChannel(target.channel);
                if(!channel) {
                    throw new WellKnownChannelNotFoundError(target.channel);
                }
                return { targetChannelId: channel.channelId, shouldSend, content };
            }
            case 'fallback': {
                throw new InvariantViolationError('resolveEnvelopeTarget', `originChannelId is required for envelope kind: ${kind}`);
            }
        }
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
