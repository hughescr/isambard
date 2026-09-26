import { logger } from '@hughescr/logger';
import type { TextChannel, Client } from 'discord.js';
import type { DiscordCapability } from './capability';
import { type ResponseRouter, WellKnownChannelNotFoundError  } from './channel-registry';
import { splitMessage } from './messages';
import type { DiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';
import { type ChannelId } from './types';
import type { EnvelopeKind } from '@/agent';
import { ChannelNotAccessibleError, InvariantViolationError } from '@/errors';
import type { OutboxItemType } from '@/services';

/**
 * Maps an envelope kind to the outbox item type used when queuing through a
 * {@link DiscordCapability} — `catchup`/`perch` kinds map to `catch_up_output`/`perch_output`;
 * every other envelope kind queues as a plain `agent_response`.
 */
function outboxTypeForEnvelopeKind(kind: EnvelopeKind): OutboxItemType {
    if(kind === 'catchup') {
        return 'catch_up_output';
    }
    if(kind === 'perch') {
        return 'perch_output';
    }
    return 'agent_response';
}

/** One response is one outbox row; sendText owns ordered chunking and prefix progress. */
async function sendViaCapability(
    discordCapability: DiscordCapability,
    targetChannelId:   ChannelId,
    content:           string,
    kind:              EnvelopeKind
): Promise<SendEnvelopeResponseResult> {
    const result = await discordCapability.sendText(targetChannelId, content, {
        priority: 'high', type: outboxTypeForEnvelopeKind(kind), queueOnDefinitiveFailure: true,
    });
    if(result.status === 'sent') {
        return { status: 'sent', channelId: targetChannelId, messageIds: result.messageIds };
    }
    if(result.status === 'queued') {
        return { status: 'queued', channelId: targetChannelId, outboxIds: [result.outboxId] };
    }
    return { status: 'unavailable' };
}

/**
 * Chunk-sending branch of {@link sendEnvelopeResponse} when no {@link DiscordCapability} is
 * available: sends directly via the rate limiter, with no outbox to fall back to on failure, so a
 * failed send resolves to the tagged `unavailable` result. Split out purely to keep
 * `sendEnvelopeResponse` under the project's complexity threshold — no behavioural difference
 * from being inlined.
 */
async function sendChunksViaClient(
    client:          Client,
    rateLimiter:     DiscordRateLimiter,
    targetChannelId: ChannelId,
    chunks:          string[],
    envelopeId:      string,
    kind:            EnvelopeKind
): Promise<SendEnvelopeResponseResult> {
    try {
        const targetChannel = await client.channels.fetch(targetChannelId);
        if(!targetChannel?.isTextBased()) {
            throw new ChannelNotAccessibleError(targetChannelId);
        }
        const messageIds: string[] = [];
        for(const [i, chunk] of chunks.entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API, message ordering
            const message = await withDiscordRetry(() => rateLimiter.sendToChannel(targetChannel as TextChannel, chunk));
            messageIds.push(message.id);
            logger.info({ envelopeId, kind, chunkIndex: i, totalChunks: chunks.length, msg: 'Envelope response chunk sent successfully' });
        }
        return { status: 'sent', channelId: targetChannelId, messageIds };
    } catch (sendError) {
        const err = sendError instanceof Error ? sendError : new Error(String(sendError));
        logger.warn({ error: err, envelopeId, kind, msg: `Envelope response send failed, no outbox to queue to: ${err.message}` });
        return { status: 'unavailable' };
    }
}

/**
 * Configuration for {@link sendEnvelopeResponse}.
 */
interface SendEnvelopeResponseConfig {
    /** Id of the envelope this response answers, for logging only. */
    envelopeId:         string
    /** The envelope kind that produced this response — drives routing via {@link ResponseRouter.resolveEnvelopeTarget}. */
    kind:               EnvelopeKind
    /** The envelope's origin channel; required for `discord`/`notification` kinds. */
    channelId?:         ChannelId
    /** The response text to send. */
    text:               string
    /** Response router for routing decisions. */
    responseRouter:     ResponseRouter
    /** Discord client for fetching channels. */
    client:             Client
    /** Rate limiter for Discord API calls. */
    rateLimiter:        DiscordRateLimiter
    /**
     * Optional Discord capability facade. When provided, the whole response routes through its
     * outbox-backed ordered text send. Every production call site wires this; omitting it
     * is a test-only convenience, and a send failure with no facade is reported honestly as the
     * tagged `unavailable` result rather than as an outbox commitment.
     */
    discordCapability?: DiscordCapability
}

/** Tagged result of {@link sendEnvelopeResponse}; unavailable is not committed for boot replay. */
export type SendEnvelopeResponseResult
    = | { status: 'sent', channelId: ChannelId, messageIds: string[] }
      | { status: 'queued', channelId: ChannelId, outboxIds: string[] }
      | { status: 'unavailable' }
      | { status: 'skipped', reason: string };

/**
 * Sends a conductor-mode envelope's response, client-based (P10): no `botStateManager` read (the
 * caller already knows the envelope's `kind`) and no discord.js `Message` to reply to or thread
 * through — responses go directly to the resolved target channel. With a capability, the
 * full response is one outbox-backed ordered text send; without one, chunks send via
 * {@link withDiscordRetry}. Used for the boot sequence's replay/catch-up deliveries and any other
 * envelope-kind response that has no triggering `Message` object.
 *
 * A `discord`/`notification` kind with no `channelId` is a programming error (there is no origin
 * to route to) and throws {@link InvariantViolationError} rather than silently dropping the
 * response. An origin wins even for mapped kinds; a missing well-known channel for
 * `catchup`/`perch`/`wrapup` has no channel to fall back to, so
 * it resolves to `skipped`; `@@NO_RESPONSE@@` also resolves to `skipped` with reason `no-response`.
 * With `config.discordCapability` (wired at every production call site), one persisted response
 * resolves to `queued` with one outbox ID. The conductor commits sent/queued outcomes; skipped
 * and unavailable are left for a later boot replay. Without a `discordCapability`, a channel
 * that cannot be fetched or a chunk send that fails after retries is likewise `unavailable`.
 *
 * @param config - See {@link SendEnvelopeResponseConfig}.
 * @returns See {@link SendEnvelopeResponseResult}.
 */
export async function sendEnvelopeResponse(config: SendEnvelopeResponseConfig): Promise<SendEnvelopeResponseResult> {
    const { envelopeId, kind, channelId, text, responseRouter, client, rateLimiter, discordCapability } = config;

    if((kind === 'discord' || kind === 'notification') && channelId === undefined) {
        throw new InvariantViolationError('sendEnvelopeResponse', `channelId is required for envelope kind: ${kind}`);
    }

    let resolved: { targetChannelId: ChannelId, shouldSend: boolean, content: string };
    try {
        resolved = await responseRouter.resolveEnvelopeTarget(kind, text, channelId);
    } catch (routeError: unknown) {
        if(routeError instanceof WellKnownChannelNotFoundError) {
            logger.error({
                error:       routeError,
                envelopeId,
                kind,
                channelType: routeError.context.channelType,
                msg:         `Cannot route envelope response: well-known channel #${routeError.context.channelType} not configured. Response skipped.`,
            });
            return { status: 'skipped', reason: `Well-known channel #${routeError.context.channelType} not configured` };
        }
        throw routeError;
    }

    if(!resolved.shouldSend) {
        logger.info({
            envelopeId,
            kind,
            fullResponse: text,
            msg:          'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        });
        return { status: 'skipped', reason: 'no-response' };
    }

    return discordCapability
        ? sendViaCapability(discordCapability, resolved.targetChannelId, resolved.content, kind)
        : sendChunksViaClient(client, rateLimiter, resolved.targetChannelId, splitMessage(resolved.content), envelopeId, kind);
}
