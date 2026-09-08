import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import type { DiscordCapability } from '../capability';
import type { ResponseRouter } from '../channel-registry';
import type { InboxManager } from '../inbox';
import type { IngressGate } from '../ingress-gate';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse } from '../response-sender';
import { createChannelId, type ChannelId } from '../types';
import {
    type PerchConfig, type Conductor, type SessionJournal, type Envelope, type UndeliveredEnvelope,
    computeRecovery, buildDiscordEnvelope, buildCatchupEnvelope, runBootSequence
} from '@/agent';
import type { ServiceHealthRegistry } from '@/services';
import { resolveTimezone, formatTimeHeader } from '@/utils';

/**
 * Sentinel thrown from inside the `send` callback passed to `conversationConductor.deliver`
 * (both {@link submitAndDeliverConductorEnvelope} and `runConductorInboxInit`'s own
 * `deliverUndelivered`) when {@link sendEnvelopeResponse} reports neither `sent` nor `queued` —
 * genuinely nothing to journal (the `@@NO_RESPONSE@@` sentinel or a missing well-known channel).
 * Always caught and logged by its own caller; never a programming error.
 */
class ConductorEnvelopeSkippedError extends Error {}

/**
 * Local shape covering exactly what boot-time envelope composition ({@link runConductorInboxInit})
 * reads from a replayed message — deliberately narrower than the inbox module's own
 * `UnreadMessage` type, which its barrel (`../inbox/index.ts`) does not re-export.
 */
interface ReplayableMessage {
    id:          string
    channelId:   string
    channelName: string
    guildId:     string
    author:      string
    /** The real Discord user id (snowflake) — falls back to {@link author} (a display name) only for pre-P10 callers that never set it. */
    authorId?:   string
    content:     string
    timestamp:   string
}

/**
 * Rendered as the replay envelope's `resumeNote` block (see {@link BuildDiscordEnvelopeParams}):
 * a crash-recovery replay is indistinguishable from a live message otherwise, so a reply already
 * posted before the crash (missed only by the delivery-guard write) would be answered a second
 * time with no signal to Izzy that it may be a repeat (the plan's own synthesis-risk mitigation).
 */
const REPLAY_CAVEAT = '[REPLAY NOTE] These messages were received before a restart and may already have been answered — check before repeating work.';

/**
 * How far back {@link runConductorInboxInit} reads the journal to recompute boot-time recovery —
 * matches `Conductor`'s own internal recovery window (P8), duplicated here because
 * `Conductor.open()` computes and fully consumes its `RecoveryResult` internally (task_lost
 * journaling, delivery-guard seeding, boot-bundle text) without exposing it. See
 * {@link runConductorInboxInit}'s own doc for why recomputing here — rather than adding a new
 * Conductor-surface — is the deliberate choice.
 */
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The Discord-facing dependencies {@link submitAndDeliverConductorEnvelope} and
 * {@link submitConductorCatchUp} need to submit an envelope to the conductor and deliver its
 * response — shared by {@link runConductorInboxInit} (boot-time replay/catch-up) and `bot.ts`'s
 * `triggerCatchUp` (a live Discord-reconnect catch-up), so both paths submit and deliver through
 * the exact same code rather than two independently-maintained copies.
 */
export interface SubmitConductorEnvelopeDeps {
    conversationConductor: Conductor
    responseRouter:        ResponseRouter
    client:                Client
    rateLimiter:           DiscordRateLimiter
    /** Optional capability facade — forwarded verbatim to {@link sendEnvelopeResponse} so a Discord outage queues to the real outbox instead of losing the response. */
    discordCapability?:    DiscordCapability
}

/**
 * Submits `envelope` to `deps.conversationConductor` and, when it produced a response, delivers
 * that response exactly once via `conversationConductor.deliver` + {@link sendEnvelopeResponse} —
 * the same idempotent path the live coordinator uses (`setup/coordinator-setup.ts`), so this
 * submission and a live one can never double-deliver the same envelope id. A delivery failure
 * (no well-known channel, or a send that neither sent nor queued) is logged and swallowed — this
 * function never rejects.
 * @param envelope The envelope to submit — see {@link Envelope}.
 * @param deps See {@link SubmitConductorEnvelopeDeps}.
 */
export async function submitAndDeliverConductorEnvelope(envelope: Envelope, deps: SubmitConductorEnvelopeDeps): Promise<void> {
    const { conversationConductor, responseRouter, client, rateLimiter, discordCapability } = deps;

    const result = await conversationConductor.submit(envelope, { priority: 'other' });
    if(!result.response) {
        return;
    }
    try {
        await conversationConductor.deliver(envelope.id, async () => {
            const sendResult = await sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  envelope.channelId ? createChannelId(envelope.channelId) : undefined,
                text:       result.response!,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
            if(!sendResult.sent && !sendResult.queued) {
                throw new ConductorEnvelopeSkippedError(`Conductor envelope response not delivered: ${sendResult.skipReason ?? 'unknown reason'}`);
            }
            return { channelId: envelope.channelId ?? '', messageIds: [] };
        });
    } catch (err) {
        logger.warn({ err, envelopeId: envelope.id, msg: 'Conductor envelope delivery failed' });
    }
}

/** Parameters for {@link submitConductorCatchUp}. */
export interface SubmitConductorCatchUpParams extends SubmitConductorEnvelopeDeps {
    inboxManager: InboxManager
}

/**
 * Builds and submits a catch-up envelope through the conductor — used both by
 * {@link runConductorInboxInit} at boot (when unread mail remains after replay) and by `bot.ts`'s
 * `triggerCatchUp` (a live Discord-reconnect catch-up), so a conductor-mode catch-up always goes
 * through this one path.
 * @param params See {@link SubmitConductorCatchUpParams}.
 */
export async function submitConductorCatchUp(params: SubmitConductorCatchUpParams): Promise<void> {
    const { inboxManager, ...envelopeDeps } = params;
    const overview = inboxManager.getUnreadOverview();
    const timezone = resolveTimezone();
    await submitAndDeliverConductorEnvelope(buildCatchupEnvelope({
        unreadCount:  overview.totalUnread,
        channelCount: overview.channels.length,
        now:          new Date(),
        timezone,
        timeHeader:   formatTimeHeader(),
    }), envelopeDeps);
}

/** Parameters for {@link runConductorInboxInit}. */
export interface RunConductorInboxInitParams {
    inboxManager:          InboxManager
    readyClient:           Client
    perchConfig:           PerchConfig | undefined
    ingressGate:           IngressGate<Message>
    conversationConductor: Conductor
    journal:               SessionJournal
    responseRouter:        ResponseRouter
    rateLimiter:           DiscordRateLimiter
    /**
     * P10 hook for P12: channels whose replay is owned by a different conductor (the well-known
     * `perch-time` channel routes to the perch conductor instead of this conversation conductor)
     * are skipped entirely by {@link InboxManager.replayUnhandled}. Unused until P12 supplies a
     * value; omitting it replays every channel, which is exactly today's (pre-P12) correct
     * behaviour since no other conductor exists yet to own perch-time's replay.
     */
    excludeChannelIds?:    ReadonlySet<ChannelId>
    /** Optional capability facade — forwarded to every {@link sendEnvelopeResponse} call this boot sequence makes. */
    discordCapability?:    DiscordCapability
}

/**
 * The conductor-mode inbox/boot sequence (P10), run once from `bot.ts`'s `clientReady`: loads
 * unread mail, then runs {@link runBootSequence} exactly once to redeliver
 * anything a crash left undelivered, replay anything received-but-unhandled, open the ingress
 * gate (always, even with nothing to replay — a boot with no crash-recovery work still needs its
 * live-message buffer drained), and submit the catch-up envelope when unread mail remains.
 *
 * Perch's `triggerOnStartup` test mode means perch handles everything this boot: recovery
 * (undelivered redelivery, replay, the gate opening) still runs unconditionally below so a crash
 * is never silently dropped, but the catch-up envelope itself is suppressed — mirroring the
 * oneshot branch's own "perch scheduler handles presence, no action needed here" comment.
 *
 * `Conductor.open()` (already awaited by the caller before this runs) computes and consumes its
 * own boot-time `RecoveryResult` entirely internally and does not expose it, so `undelivered` is
 * recomputed here via the same pure {@link computeRecovery} over a fresh `journal.readSince`
 * window — a deliberate, documented duplication of one read-only computation, not of the
 * wait/interrupt/flush sequence the P10 folded gap is actually about (that sequence has exactly
 * one owner: `Conductor.shutdown`, via `createShutdown`).
 *
 * Both `submitReplay` and `submitCatchUp` (composed here, since `runBootSequence` itself never
 * builds an envelope — see its own module doc) submit through `conversationConductor.submit` and
 * then deliver any response through the SAME `conversationConductor.deliver` +
 * {@link sendEnvelopeResponse} idempotency path the live coordinator uses
 * (`setup/coordinator-setup.ts`), so a boot-time submission and a live one can never double-
 * deliver the same envelope id.
 * @param params See {@link RunConductorInboxInitParams}.
 */
export async function runConductorInboxInit(params: RunConductorInboxInitParams): Promise<void> {
    const {
        inboxManager, readyClient, perchConfig, ingressGate,
        conversationConductor, journal, responseRouter, rateLimiter, excludeChannelIds, discordCapability,
    } = params;

    const envelopeDeps: SubmitConductorEnvelopeDeps = { conversationConductor, responseRouter, client: readyClient, rateLimiter, discordCapability };

    async function deliverUndelivered(item: UndeliveredEnvelope): Promise<void> {
        if(item.responseText === undefined) {
            return;
        }
        try {
            await conversationConductor.deliver(item.envelopeId, async () => {
                const sendResult = await sendEnvelopeResponse({
                    envelopeId: item.envelopeId,
                    kind:       item.envelopeKind,
                    channelId:  item.channelId ? createChannelId(item.channelId) : undefined,
                    text:       item.responseText!,
                    responseRouter,
                    client:     readyClient,
                    rateLimiter,
                    discordCapability,
                });
                if(!sendResult.sent && !sendResult.queued) {
                    throw new ConductorEnvelopeSkippedError(`Boot-time undelivered redelivery skipped: ${sendResult.skipReason ?? 'unknown reason'}`);
                }
                return { channelId: item.channelId ?? '', messageIds: [] };
            });
        } catch (err) {
            logger.warn({ err, envelopeId: item.envelopeId, msg: 'Boot-time undelivered redelivery failed' });
        }
    }

    const timezone = resolveTimezone();

    /**
     * Submits one channel's replay envelope and, only on a successful submission, advances that
     * channel's HANDLED watermark to its newest replayed message — a failed submission must NOT
     * advance the watermark, or the unanswered messages would never be replayed again on a later
     * boot (see the sibling `catch` in {@link submitReplay}, which keeps one channel's failure
     * from blocking the rest).
     */
    async function submitReplayChannel(channelId: string, channelMessages: readonly ReplayableMessage[]): Promise<void> {
        const newest = channelMessages[channelMessages.length - 1]!;
        const envelope = buildDiscordEnvelope({
            messages: channelMessages.map(message => ({
                channelId: message.channelId,
                userId:    message.authorId ?? message.author,
                messageId: message.id,
                content:   `${message.author}: ${message.content}`,
                timestamp: message.timestamp,
                botUserId: readyClient.user!.id,
                guildId:   message.guildId === 'DM' ? undefined : message.guildId,
            })),
            authorId:    newest.authorId ?? newest.author,
            authorName:  newest.author,
            channelId,
            channelName: newest.channelName,
            isDM:        newest.guildId === 'DM',
            now:         new Date(),
            timezone,
            timeHeader:  formatTimeHeader(),
            resumeNote:  REPLAY_CAVEAT,
        });
        await submitAndDeliverConductorEnvelope(envelope, envelopeDeps);
        await inboxManager.recordHandled(createChannelId(channelId), newest.id, newest.timestamp);
    }

    async function submitReplay(messages: readonly ReplayableMessage[]): Promise<void> {
        const byChannel = new Map<string, ReplayableMessage[]>();
        for(const message of messages) {
            const existing = byChannel.get(message.channelId) ?? [];
            existing.push(message);
            byChannel.set(message.channelId, existing);
        }

        for(const [channelId, channelMessages] of byChannel) {
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential, bounded by the small number of channels a crash can plausibly span
                await submitReplayChannel(channelId, channelMessages);
            } catch (err) {
                logger.warn({ err, channelId, msg: 'Boot-time replay submission failed — channel will be replayed again on the next boot' });
            }
        }
    }

    const skipCatchUp = Boolean(perchConfig?.testMode?.triggerOnStartup);

    // Tracks whether `runBootSequence` was actually reached — once it is, ITS OWN `finally`
    // guarantees the gate opens exactly once, so the backstop below must not double-open it.
    let bootSequenceStarted = false;
    try {
        inboxManager.setBotUserId(readyClient.user!.id);
        await inboxManager.loadUnread();

        const entries = await journal.readSince(Date.now() - RECOVERY_WINDOW_MS);
        const recovery = computeRecovery(entries);

        bootSequenceStarted = true;
        await runBootSequence<ReplayableMessage>({
            recovery,
            deliver:         deliverUndelivered,
            replayUnhandled: () => inboxManager.replayUnhandled({ excludeChannelIds }),
            submitReplay,
            submitCatchUp:   () => submitConductorCatchUp({ inboxManager, ...envelopeDeps }),
            unreadCount:     () => (skipCatchUp ? 0 : inboxManager.getUnreadOverview().totalUnread),
            ingressGate,
            journal,
        });
    } finally {
        // Backstop for a failure BEFORE `runBootSequence` is ever reached (e.g. `loadUnread`
        // itself rejects) — without this, such a failure would leave the gate stuck in
        // `buffering` forever, since `runBootSequence`'s own `finally` never gets a chance to run.
        if(!bootSequenceStarted) {
            ingressGate.open(new Set());
        }
    }
}

/**
 * Parameters for setting up inbox and catch-up functionality.
 */
interface SetupInboxParams {
    inboxManager:    InboxManager
    readyClient:     Client
    perchConfig:     PerchConfig | undefined
    /** Optional health registry — when provided, catch-up defers until Discord is online. */
    healthRegistry?: ServiceHealthRegistry

    /** The long-lived conversation conductor's own boot-time recovery/replay/catch-up sequence — see {@link runConductorInboxInit}. */
    conversationConductor: Conductor
    journal:               SessionJournal
    responseRouter:        ResponseRouter
    rateLimiter:           DiscordRateLimiter
    ingressGate:           IngressGate<Message>
    excludeChannelIds?:    ReadonlySet<ChannelId>
    discordCapability?:    DiscordCapability
}

/**
 * Sets up inbox and catch-up functionality.
 * Initializes inbox, loads unread messages, and starts catch-up if needed.
 *
 * @param params - Configuration for inbox setup
 * @returns A promise settling once inbox initialization finishes — including the deferred
 * discord-online path, when Discord was not yet available at call time.
 */
// Stryker disable all: Integration function with async IIFE coordinating multiple components - tested via bot integration tests
export function setupInboxAndCatchUp(params: SetupInboxParams): Promise<void> {
    const {
        inboxManager,
        readyClient,
        perchConfig,
        healthRegistry,
        conversationConductor,
        journal,
        responseRouter,
        rateLimiter,
        ingressGate,
        excludeChannelIds,
        discordCapability,
    } = params;

    async function runInboxInit(): Promise<void> {
        try {
            logger.info({ msg: 'Starting inbox initialization...' });

            await runConductorInboxInit({
                inboxManager, readyClient, perchConfig, ingressGate,
                conversationConductor, journal, responseRouter, rateLimiter, excludeChannelIds, discordCapability,
            });
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.warn({
                error: errorMsg,
                msg:   'Failed to load inbox on startup',
            });
        }
    }

    // If Discord is not yet available, defer inbox init until it comes online (one-shot subscriber).
    // P10: the returned promise settles only once that deferred run actually happens, not when
    // the subscription is merely registered — a caller awaiting `setupInboxAndCatchUp` needs to
    // know inbox init genuinely finished, however long Discord takes to come online.
    if(healthRegistry && !healthRegistry.isAvailable('discord')) {
        logger.info({ msg: 'Discord not yet available — deferring inbox initialization until Discord is online' });
        return new Promise<void>((resolve) => {
            const unsubscribe = healthRegistry.subscribe((change) => {
                if(change.service === 'discord' && change.newState === 'online') {
                    unsubscribe();
                    // runInboxInit() never rejects (its own try/catch swallows and logs every
                    // error), so `.finally` alone is enough to settle this promise once the
                    // deferred run actually finishes.
                    void runInboxInit().finally(() => resolve());
                }
            });
        });
    }

    return runInboxInit().catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({
            error: errorMsg,
            msg:   'Unhandled error in inbox initialization',
        });
    });
}
// Stryker restore all
