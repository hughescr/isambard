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
    let anyQueued = false;
    for(const [i, chunk] of chunks.entries()) {
        // eslint-disable-next-line no-await-in-loop -- sequential: Discord message ordering, outbox writes must preserve order
        const result = await discordCapability.sendToChannel(targetChannelId, chunk, {
            priority: 'high',
            type:     outboxTypeForEnvelopeKind(kind),
        });
        if(result.status === 'queued' || result.status === 'unavailable') {
            anyQueued = true;
        }
        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ envelopeId, kind, chunkIndex: i, totalChunks: chunks.length, msg: 'Envelope response chunk sent via capability facade' });
    }
    return { sent: !anyQueued, queued: anyQueued || undefined };
}

/**
 * Chunk-sending branch of {@link sendEnvelopeResponse} when no {@link DiscordCapability} is
 * available: sends directly via the rate limiter, with no outbox to fall back to on failure (see
 * {@link sendEnvelopeResponse}'s own doc for why that resolves to a genuine `{ sent: false }`
 * rather than a fabricated `queued: true`). Split out purely to keep `sendEnvelopeResponse` under
 * the project's complexity threshold — no behavioural difference from being inlined.
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

        // Stryker disable next-line UpdateOperator: i-- would cause infinite loop — untestable without real Discord API
        for(let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            // Stryker disable next-line ConditionalExpression,BlockStatement: invariant guard — splitMessage guarantees every index in range; unreachable in practice
            if(chunk === undefined) {
                // Stryker disable next-line StringLiteral,CallExpression: invariant violation — debug context only
                throw new InvariantViolationError('sendEnvelopeResponse', 'chunks[i] undefined despite i < chunks.length');
            }
            // eslint-disable-next-line no-await-in-loop -- sequential: rate-limited Discord API, message ordering
            await withDiscordRetry(() => rateLimiter.sendToChannel(targetChannel as TextChannel, chunk));
            // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
            logger.info({ envelopeId, kind, chunkIndex: i, totalChunks: chunks.length, msg: 'Envelope response chunk sent successfully' });
        }

        return { sent: true };
    } catch (sendError) {
        const err = sendError instanceof Error ? sendError : new Error(String(sendError));
        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.warn({ error: err, envelopeId, kind, msg: `Envelope response send failed, no outbox to queue to: ${err.message}` });
        return { sent: false };
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
     * Optional Discord capability facade. When provided, every chunk routes through it — with
     * outbox fallback when Discord is offline. Every production call site wires this; omitting it
     * is a test-only convenience, and a send failure with no facade is reported honestly as
     * `{ sent: false }` rather than a fabricated `queued: true` (see the module-level history: P10
     * originally faked `queued: true` on any failure here, which journaled a lost response as
     * delivered).
     */
    discordCapability?: DiscordCapability
}

/** Result of {@link sendEnvelopeResponse}. */
interface SendEnvelopeResponseResult {
    /** Whether the response was sent. */
    sent:        boolean
    /** Set when the channel couldn't be reached or the send failed after retries — the response should be treated as pending, not lost. */
    queued?:     boolean
    /** Reason for not sending (when `sent` is `false` and not queued). */
    skipReason?: string
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
 * response. A missing well-known channel for `catchup`/`perch` has no channel to fall back to, so
 * it resolves to `{ sent: false, skipReason }` instead. The `@@NO_RESPONSE@@` sentinel resolves to
 * `{ sent: false, skipReason: 'no-response' }`. When `config.discordCapability` is provided (every
 * production call site wires one), a chunk queued or unavailable through it resolves to
 * `{ sent: false, queued: true }`, and the caller (the boot sequence, via `Conductor.deliver`)
 * treats that the same as never having sent at all, safe to retry on a later boot — the outbox
 * itself owns the retry. Without a `discordCapability`, there is no outbox to fall back to, so a
 * channel that can't be fetched or a chunk send that still fails after retries resolves to a
 * genuine `{ sent: false }` rather than a fabricated `queued: true`.
 *
 * @param config - See {@link SendEnvelopeResponseConfig}.
 * @returns See {@link SendEnvelopeResponseResult}.
 */
export async function sendEnvelopeResponse(config: SendEnvelopeResponseConfig): Promise<SendEnvelopeResponseResult> {
    const { envelopeId, kind, channelId, text, responseRouter, client, rateLimiter, discordCapability } = config;

    if((kind === 'discord' || kind === 'notification') && channelId === undefined) {
        // Stryker disable next-line StringLiteral: invariant detail string is debug-only metadata
        throw new InvariantViolationError('sendEnvelopeResponse', `channelId is required for envelope kind: ${kind}`);
    }

    let resolved: { targetChannelId: ChannelId, shouldSend: boolean, content: string };
    try {
        resolved = await responseRouter.resolveEnvelopeTarget(kind, text, channelId);
    } catch (routeError: unknown) {
        if(routeError instanceof WellKnownChannelNotFoundError) {
            // Stryker disable all: Logging for observability
            logger.error({
                error:       routeError,
                envelopeId,
                kind,
                channelType: routeError.context.channelType,
                msg:         `Cannot route envelope response: well-known channel #${routeError.context.channelType} not configured. Response skipped.`,
            });
            // Stryker restore all
            return {
                sent:       false,
                skipReason: `Well-known channel #${routeError.context.channelType} not configured`,
            };
        }
        throw routeError;
    }

    if(!resolved.shouldSend) {
        // Stryker disable all: Logging for observability
        logger.info({
            envelopeId,
            kind,
            fullResponse: text,
            msg:          'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        });
        // Stryker restore all
        return {
            sent:       false,
            skipReason: 'no-response',
        };
    }

    const chunks = splitMessage(resolved.content);

    return discordCapability
        ? sendChunksViaCapability(discordCapability, resolved.targetChannelId, chunks, envelopeId, kind)
        : sendChunksViaClient(client, rateLimiter, resolved.targetChannelId, chunks, envelopeId, kind);
}
