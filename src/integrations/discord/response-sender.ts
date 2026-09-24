import { logger } from '@hughescr/logger';
import type { TextChannel, Client } from 'discord.js';
import type { DiscordCapability, SendResult } from './capability';
import { type ResponseRouter, WellKnownChannelNotFoundError  } from './channel-registry';
import { DISCORD_MAX_LENGTH, splitMessage } from './messages';
import { DELIVERY_TOKEN_MAX_LENGTH } from './outbox-replay';
import type { DiscordRateLimiter } from './rate-limiter';
import { withDiscordRetry } from './retry';
import { type ChannelId } from './types';
import { maxContentLengthForDeliveryCode } from './zero-width-delivery-code';
import type { EnvelopeKind } from '@/agent';
import { ChannelNotAccessibleError, InvariantViolationError } from '@/errors';
import type { OutboxItemType } from '@/services';

// Every capability send appends a delivery code. Reserve the largest token-shaped code before
// splitting so the code remains whole and no tagged chunk crosses Discord's content limit.
const MAX_CONTENT_LENGTH_WITH_DELIVERY_CODE = maxContentLengthForDeliveryCode('0'.repeat(DELIVERY_TOKEN_MAX_LENGTH), DISCORD_MAX_LENGTH);

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

/**
 * Chunk-sending branch of {@link sendEnvelopeResponse} when a {@link DiscordCapability} is
 * available: every chunk routes through its outbox fallback. Split out purely to keep
 * `sendEnvelopeResponse` under the project's complexity threshold — no behavioural difference
 * from being inlined.
 */
async function sendChunksViaCapability(
    discordCapability: DiscordCapability,
    targetChannelId:   ChannelId,
    chunks:            string[],
    envelopeId:        string,
    kind:              EnvelopeKind
): Promise<SendEnvelopeResponseResult> {
    const results: SendResult[] = [];
    for(const [i, chunk] of chunks.entries()) {
        // Stryker disable llm: targetChannelId is a ChannelId (string), so `targetChannelId || ''` is the identity.
        // eslint-disable-next-line no-await-in-loop -- sequential: Discord message ordering, outbox writes must preserve order
        const result = await discordCapability.sendToChannel(targetChannelId, chunk, {
            priority: 'high', type: outboxTypeForEnvelopeKind(kind),
        });
        // Stryker restore llm
        results.push(result);
        logger.info({ envelopeId, kind, chunkIndex: i, totalChunks: chunks.length, msg: 'Envelope response chunk sent via capability facade' });
    }
    if(results.some(result => result.status === 'unavailable')) {
        return { status: 'unavailable' };
    }
    if(results.every(result => result.status === 'sent')) {
        return { status: 'sent', channelId: targetChannelId, messageIds: results.flatMap(result => (result.message === undefined ? [] : [result.message.id])) };
    }
    if(results.every(result => result.status === 'queued')) {
        return { status: 'queued', channelId: targetChannelId, outboxIds: results.map(result => result.outboxId) };
    }
    return { status: 'partial', channelId: targetChannelId, chunks: results };
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
     * Optional Discord capability facade. When provided, every chunk routes through it with an
     * outbox fallback when Discord is offline. Every production call site wires this; omitting it
     * is a test-only convenience, and a send failure with no facade is reported honestly as the
     * tagged `unavailable` result rather than as an outbox commitment.
     */
    discordCapability?: DiscordCapability
}

/**
 * Tagged result of {@link sendEnvelopeResponse}. Multi-chunk capability sends use this precedence:
 * any unavailable chunk wins; otherwise all sent is sent, all queued is queued, and a sent/queued
 * mix is partial. Unavailable is not committed because boot recovery may safely redeliver it.
 */
export type SendEnvelopeResponseResult
    = | { status: 'sent', channelId: ChannelId, messageIds: string[] }
      | { status: 'queued', channelId: ChannelId, outboxIds: string[] }
      | { status: 'partial', channelId: ChannelId, chunks: SendResult[] }
      | { status: 'unavailable' }
      | { status: 'skipped', reason: string };

/**
 * Extracts outbox IDs for the queued chunks of a partial response, preserving chunk order.
 * Sent chunks already have a durable Discord message and must not be committed to the outbox.
 */
export function queuedOutboxIdsFromPartialResponse(response: Extract<SendEnvelopeResponseResult, { status: 'partial' }>): string[] {
    return response.chunks.flatMap(chunk => (chunk.status === 'queued' ? [chunk.outboxId] : []));
}

/**
 * Sends a conductor-mode envelope's response, client-based (P10): no `botStateManager` read (the
 * caller already knows the envelope's `kind`) and no discord.js `Message` to reply to or thread
 * through — every chunk goes directly to the resolved target channel via
 * {@link withDiscordRetry}. Used for the boot sequence's replay/catch-up deliveries and any other
 * envelope-kind response that has no triggering `Message` object.
 *
 * A `discord`/`notification` kind with no `channelId` is a programming error (there is no origin
 * to route to) and throws {@link InvariantViolationError} rather than silently dropping the
 * response. An origin wins even for mapped kinds; a missing well-known channel for
 * `catchup`/`perch`/`wrapup` has no channel to fall back to, so
 * it resolves to `skipped`; `@@NO_RESPONSE@@` also resolves to `skipped` with reason `no-response`.
 * With `config.discordCapability` (wired at every production call site), all queued chunks resolve
 * to `queued`, a sent/queued mix resolves to `partial`, and any unavailable chunk resolves to
 * `unavailable`. The conductor commits only sent/queued/partial outcomes; skipped and unavailable
 * outcomes are deliberately left for a later boot replay. Without a `discordCapability`, a channel
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

    const chunks = discordCapability === undefined
        ? splitMessage(resolved.content)
        : splitMessage(resolved.content, MAX_CONTENT_LENGTH_WITH_DELIVERY_CODE);

    return discordCapability
        ? sendChunksViaCapability(discordCapability, resolved.targetChannelId, chunks, envelopeId, kind)
        : sendChunksViaClient(client, rateLimiter, resolved.targetChannelId, chunks, envelopeId, kind);
}
