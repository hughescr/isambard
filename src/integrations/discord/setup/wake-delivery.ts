import type { Logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import type { DiscordCapability } from '../capability';
import { ENVELOPE_KIND_TO_CHANNEL, type ResponseRouter } from '../channel-registry';
import type { DiscordRateLimiter } from '../rate-limiter';
import { queuedOutboxIdsFromPartialResponse, sendEnvelopeResponse, type SendEnvelopeResponseResult } from '../response-sender';
import { createChannelId } from '../types';
import type { Conductor, Envelope, TurnResult } from '@/agent';
import { ResponseUnavailableError } from '@/errors';

/** A settled turn's delivery callback — see `Conductor.setWakeTurnDelivery`/`NotificationBridge.attachReplyDelivery`. */
export type WakeTurnDelivery = (envelope: Envelope, result: TurnResult) => Promise<void>;

/** First line of `text`, for the default `task` fallback prefix's summary excerpt. */
function firstLine(text: string): string {
    // String#split always returns at least one element, including for an empty string.
    return text.split('\n')[0]!;
}

/** Default {@link CreateWakeTurnDeliveryParams.fallbackPrefix}: distinct wording for a `notification` bridge reply vs. an unrouted `task` wake-turn reply. */
function defaultFallbackPrefix(envelope: Envelope): string {
    if(envelope.kind === 'notification') {
        return 'Reply to a host notification:\n';
    }
    return `Background work finished (${firstLine(envelope.text)}) — no origin channel was recorded, so this landed here:\n`;
}

/** Dependencies for {@link createWakeTurnDelivery}. */
export interface CreateWakeTurnDeliveryParams {
    conductor:          Pick<Conductor, 'deliver'>
    responseRouter:     ResponseRouter
    client:             Client
    rateLimiter:        DiscordRateLimiter
    /** Optional Discord capability facade for outbox fallback — forwarded to every `sendEnvelopeResponse` call unchanged. */
    discordCapability?: DiscordCapability
    logger:             Pick<Logger, 'warn' | 'error'>
    /** Overrides the route-3 fallback text prefix; defaults to {@link defaultFallbackPrefix}. */
    fallbackPrefix?:    (envelope: Envelope) => string
}

/**
 * Builds the delivery callback wired to `Conductor.setWakeTurnDelivery` and
 * `NotificationBridge.attachReplyDelivery`. See the module doc for the three routing cases.
 * @param params See {@link CreateWakeTurnDeliveryParams}.
 * @returns A {@link WakeTurnDelivery}.
 */
export function createWakeTurnDelivery(params: CreateWakeTurnDeliveryParams): WakeTurnDelivery {
    const { conductor, responseRouter, client, rateLimiter, discordCapability, logger, fallbackPrefix } = params;

    /** Maps every sender result to a durable or intentionally skipped conductor outcome. */
    async function deliverViaConductor(
        envelope: Envelope,
        sendAndDescribe: () => Promise<SendEnvelopeResponseResult>
    ): Promise<void> {
        try {
            await conductor.deliver(envelope.id, async () => {
                const sendResult = await sendAndDescribe();
                switch(sendResult.status) {
                    case 'sent': { return { kind: 'committed', disposition: 'sent', channelId: sendResult.channelId, messageIds: sendResult.messageIds };
                    }
                    case 'queued': { return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: sendResult.outboxIds };
                    }
                    case 'partial': { return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: queuedOutboxIdsFromPartialResponse(sendResult) };
                    }
                    case 'skipped': { return { kind: 'skipped', reason: sendResult.reason };
                    }
                    case 'unavailable': { throw new ResponseUnavailableError();
                    }
                }
            });
        } catch (err) {
            logger.error({ err, envelopeId: envelope.id, kind: envelope.kind }, 'Wake turn response delivery failed');
        }
    }

    async function deliverToKnownTarget(envelope: Envelope, text: string): Promise<void> {
        await deliverViaConductor(envelope, async () => {
            return sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  envelope.channelId ? createChannelId(envelope.channelId) : undefined,
                text,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
        });
    }

    async function deliverToFallback(envelope: Envelope, text: string): Promise<void> {
        const prefixedText = (fallbackPrefix ?? defaultFallbackPrefix)(envelope) + text;
        await deliverViaConductor(envelope, async () => {
            const routing = await responseRouter.routeToFallback(prefixedText);
            return sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  routing.targetChannelId,
                text:       prefixedText,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
        });
    }

    return async function deliverWakeTurn(envelope: Envelope, result: TurnResult): Promise<void> {
        // Stryker disable next-line llm: TurnResult.response is string | null, so these explicit empty cases and !response are equivalent for every produced result.
        if(result.response === null || result.response === '' || result.outcome !== undefined) {
            return;
        }
        const text = result.response;
        // Stryker disable next-line llm: Envelope.kind is a required EnvelopeKind literal, so its nullish fallback is unreachable for every constructed envelope.
        const hasKnownTarget = envelope.channelId !== undefined || ENVELOPE_KIND_TO_CHANNEL[envelope.kind] !== undefined;

        if(hasKnownTarget) {
            await deliverToKnownTarget(envelope, text);
            return;
        }
        await deliverToFallback(envelope, text);
    };
}
