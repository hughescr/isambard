/**
 * Delivers a settled background-work wake turn (R2, `docs/plans/long-lived-session-phase2-4.md`
 * — `Conductor.adoptWakeTurn`'s synthesized `task`-kind envelope, wired via
 * `Conductor.setWakeTurnDelivery`) or a settled host-notification reply (`notification`-kind, via
 * `NotificationBridge.attachReplyDelivery`) to Discord.
 *
 * Three routes, in priority order — all three go through `Conductor.deliver` (keyed on
 * `envelope.id`, not on a channel), so every route journals `response_delivered` and is
 * deduplicated against a restart the same way:
 *  1. `envelope.channelId` is set (the launch record — or, for a `notification` bridge envelope,
 *     the envelope itself in some future kind — carries an origin channel): deliver there.
 *  2. `envelope.channelId` is unset but `envelope.kind` maps to a well-known channel (`perch`,
 *     `catchup`) — this is how a perch-launched background task's wake reaches perch-time:
 *     `sessions.ts`'s perch `onWakeTurnSettled` rewrites the envelope's `kind` to `'perch'` before
 *     calling this function, and `sendEnvelopeResponse`'s own `ResponseRouter.resolveEnvelopeTarget`
 *     resolves the well-known channel regardless of `channelId`. Routing this case through the
 *     fallback-channel branch instead (as a literal reading of "no channelId" might suggest) would
 *     make a perfectly-deliverable perch reply depend on the unrelated `fallback` well-known
 *     channel being configured, and would prefix it with a "no origin channel was recorded"
 *     message that is not true — the origin (perch) resolved just fine.
 *  3. Neither applies (a `task` envelope whose launch record was never found or was evicted, or a
 *     `notification`-kind bridge envelope, which never carries a channel by design): route to the
 *     `fallback` well-known channel via `ResponseRouter.routeToFallback`, with an explanatory
 *     prefix. This route is ALSO wrapped in `Conductor.deliver` (an earlier version of this module
 *     left it unwrapped, reasoning there was "no stable per-envelope channel to protect against a
 *     double-send" — that reasoning does not hold: `deliver` keys on `envelope.id`, which every
 *     route already has, not on a channel; leaving it unwrapped meant a fallback-delivered `task`
 *     reply never journaled `response_delivered`, so crash recovery kept re-reporting the same
 *     already-delivered summary on every restart within the recovery window once `'task'` became
 *     replayable).
 *
 * Every route swallows its own delivery failure (logged) rather than rejecting — this function is
 * always invoked from a fire-and-forget context (`Conductor`'s `onWakeTurnSettled`,
 * `NotificationBridge`'s `attachReplyDelivery`) that already treats a thrown error as "log and
 * move on"; matches `perch-setup.ts`'s `wrapConductorWithDelivery` precedent for the same reason.
 *
 * @module integrations/discord/setup/wake-delivery
 */
import type { Logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import type { DiscordCapability } from '../capability';
import { ENVELOPE_KIND_TO_CHANNEL, type ResponseRouter } from '../channel-registry';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse } from '../response-sender';
import { createChannelId } from '../types';
import type { Conductor, Envelope, TurnResult } from '@/agent';

/**
 * Sentinel thrown inside the `conductor.deliver` callback (route 1/2 above) to skip its journal
 * write when the send neither succeeded nor queued — mirrors `perch-setup.ts`'s identical
 * `PerchTurnNotSentError`: caught one frame up and suppressed (not logged as an error), since
 * "neither sent nor queued, no outbox to fall back to" is an already-logged, expected outcome of
 * `sendEnvelopeResponse` itself, not a new failure this module needs to report again.
 */
class WakeTurnNotSentError extends Error {}

/** A settled turn's delivery callback — see `Conductor.setWakeTurnDelivery`/`NotificationBridge.attachReplyDelivery`. */
export type WakeTurnDelivery = (envelope: Envelope, result: TurnResult) => Promise<void>;

/** First line of `text`, for the default `task` fallback prefix's summary excerpt. */
function firstLine(text: string): string {
    // Stryker disable next-line StringLiteral: unreachable by construction — `String.split` never
    // returns an empty array, so index 0 of its result is always defined for any string input;
    // the `?? ''` fallback can never be observed regardless of what it's mutated to.
    return text.split('\n')[0] ?? '';
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

    /**
     * Shared `Conductor.deliver` wrapper for both routes below: runs `sendAndDescribe` (which
     * performs the actual `sendEnvelopeResponse` call and reports its `{ sent, queued }` result
     * alongside the channel it targeted) inside `conductor.deliver`'s send callback, throwing
     * {@link WakeTurnNotSentError} to skip the `response_delivered` journal write when the send
     * neither succeeded nor queued. Swallows its own failure (logged, except the not-sent
     * sentinel) rather than rejecting — see the module doc.
     */
    async function deliverViaConductor(
        envelope: Envelope,
        sendAndDescribe: () => Promise<{ sendResult: { sent: boolean, queued?: boolean }, channelId: string }>
    ): Promise<void> {
        try {
            await conductor.deliver(envelope.id, async () => {
                const { sendResult, channelId } = await sendAndDescribe();
                if(!sendResult.sent && !sendResult.queued) {
                    throw new WakeTurnNotSentError();
                }
                return { channelId, messageIds: [] };
            });
        } catch (err) {
            if(!(err instanceof WakeTurnNotSentError)) {
                logger.error({ err, envelopeId: envelope.id, kind: envelope.kind }, 'Wake turn response delivery failed');
            }
        }
    }

    async function deliverToKnownTarget(envelope: Envelope, text: string): Promise<void> {
        await deliverViaConductor(envelope, async () => {
            const sendResult = await sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  envelope.channelId ? createChannelId(envelope.channelId) : undefined,
                text,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
            return { sendResult, channelId: envelope.channelId ?? '' };
        });
    }

    async function deliverToFallback(envelope: Envelope, text: string): Promise<void> {
        const prefixedText = (fallbackPrefix ?? defaultFallbackPrefix)(envelope) + text;
        await deliverViaConductor(envelope, async () => {
            const routing = await responseRouter.routeToFallback(prefixedText);
            const sendResult = await sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  routing.targetChannelId,
                text:       prefixedText,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
            return { sendResult, channelId: routing.targetChannelId };
        });
    }

    return async function deliverWakeTurn(envelope: Envelope, result: TurnResult): Promise<void> {
        if(result.response === null || result.response === '' || result.outcome !== undefined) {
            return;
        }
        const text = result.response;
        const hasKnownTarget = envelope.channelId !== undefined || ENVELOPE_KIND_TO_CHANNEL[envelope.kind] !== undefined;

        if(hasKnownTarget) {
            await deliverToKnownTarget(envelope, text);
            return;
        }
        await deliverToFallback(envelope, text);
    };
}
