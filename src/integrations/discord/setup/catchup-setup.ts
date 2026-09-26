import { logger } from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import type { DiscordCapability } from '../capability';
import type { ResponseRouter } from '../channel-registry';
import type { InboxManager } from '../inbox';
import type { IngressGate } from '../ingress-gate';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse } from '../response-sender';
import { createChannelId, createUserId, isDmScope, type ChannelId, type ChannelScope } from '../types';
import {
    type PerchConfig, type Conductor, type QueryEnvelope, type UndeliveredEnvelope, type ContextPolicy,
    type TimeHeaderProvider, type BootRecoveryRuntime,
    buildDiscordEnvelope, buildCatchupEnvelope, formatTimeHeader
} from '@/agent';
import { InvariantViolationError, ResponseUnavailableError } from '@/errors';
import type { ServiceHealthRegistry } from '@/services';
import { resolveTimezone, truncateToWordBoundary } from '@/utils';

/**
 * Local shape covering exactly what boot-time envelope composition ({@link runConductorInboxInit})
 * reads from a replayed message — deliberately narrower than the inbox module's own
 * `UnreadMessage` type, which its barrel (`../inbox/index.ts`) does not re-export.
 */
interface ReplayableMessage {
    id:          string
    channelId:   ChannelId
    channelName: string
    guildId:     ChannelScope
    author:      string
    /** The real Discord user ID, absent in historical inbox rows. */
    authorId?:   string
    content:     string
    timestamp:   string
}

/**
 * Rendered as the replay envelope's `continuationNote` block (see {@link BuildDiscordEnvelopeParams}):
 * a crash-recovery replay is indistinguishable from a live message otherwise, so a reply already
 * posted before the crash (missed only by the delivery-guard write) would be answered a second
 * time with no signal to Izzy that it may be a repeat (the plan's own synthesis-risk mitigation).
 */
const REPLAY_CAVEAT = '[REPLAY NOTE] These messages were received before a restart and may already have been answered — check before repeating work.';

/**
 * Fallback lookback window for the merged boot envelope's events-since-mark seeding (R1) when the
 * journal carries no `turn_completed`/`turn_failed` entry to derive `lastKnownAt` from (a
 * genuinely fresh journal). Matches `sessionConfigSchema`'s own `bootEventsWindowMs` default
 * (24h) — duplicated here since {@link RunConductorInboxInitParams} takes it as a plain optional
 * number, not the config object itself.
 */
const DEFAULT_BOOT_EVENTS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Max characters kept per entry in the merged boot envelope's `## Replies redelivered for you`
 * section — the section is meant to carry a *description* of what was redelivered (matching
 * `BuildCatchupEnvelopeParams.redelivered`'s own doc), not the redelivered reply verbatim.
 * Without a cap, a long assistant reply (Discord replies routinely run to thousands of
 * characters) would be embedded a SECOND time in the transcript — once via the actual Discord
 * redelivery, and again here — on every crash-recovery boot.
 */
const REDELIVERED_TEXT_PREVIEW_LENGTH = 200;
const UNHANDLED_INBOX_INITIALIZATION_PREFIX = 'Unhandled error in inbox';

function logUnhandledInboxInitializationError(error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({
        error: errorMsg,
        msg:   `${UNHANDLED_INBOX_INITIALIZATION_PREFIX} initialization`,
    });
}

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
 * @param envelope The envelope to submit — see {@link QueryEnvelope}.
 * @param deps See {@link SubmitConductorEnvelopeDeps}.
 */
export async function submitAndDeliverConductorEnvelope(envelope: QueryEnvelope, deps: SubmitConductorEnvelopeDeps): Promise<void> {
    const { conversationConductor, responseRouter, client, rateLimiter, discordCapability } = deps;

    const result = await conversationConductor.submit(envelope, { priority: 'normal' });
    if(!result.response) {
        return;
    }
    try {
        await conversationConductor.deliver(envelope.id, async () => {
            const sendResult = await sendEnvelopeResponse({
                envelopeId: envelope.id,
                kind:       envelope.kind,
                channelId:  envelope.channelId,
                text:       result.response,
                responseRouter,
                client,
                rateLimiter,
                discordCapability,
            });
            switch(sendResult.status) {
                case 'sent': {
                    return { kind: 'committed', disposition: 'sent', channelId: sendResult.channelId, messageIds: sendResult.messageIds };
                }
                case 'queued': {
                    return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: sendResult.outboxIds };
                }
                case 'skipped': {
                    return { kind: 'skipped', reason: sendResult.reason };
                }
                case 'unavailable': {
                    throw new ResponseUnavailableError();
                }
            }
        });
    } catch (err) {
        logger.warn({ err, envelopeId: envelope.id, msg: 'Conductor envelope delivery failed' });
    }
}

/** Parameters for {@link submitConductorCatchUp}. */
export interface SubmitConductorCatchUpParams extends SubmitConductorEnvelopeDeps {
    inboxManager: InboxManager
    /**
     * Session-peers block 4: renders the catch-up envelope's time header. The composition root
     * supplies the conversation role's provider (which appends the ambient other-session/quota
     * lines); omitted, this falls back to the bare `formatTimeHeader`, exactly as before that
     * block. Called with no argument — a catch-up has no single user whose zone to render.
     */
    timeHeader?:  TimeHeaderProvider
}

/**
 * Builds and submits a catch-up envelope through the conductor — used both by
 * {@link runConductorInboxInit} at boot (when unread mail remains after replay) and by `bot.ts`'s
 * `triggerCatchUp` (a live Discord-reconnect catch-up), so a conductor-mode catch-up always goes
 * through this one path.
 * @param params See {@link SubmitConductorCatchUpParams}.
 */
export async function submitConductorCatchUp(params: SubmitConductorCatchUpParams): Promise<void> {
    const { inboxManager, timeHeader = formatTimeHeader, ...envelopeDeps } = params;
    const overview = inboxManager.getUnreadOverview();
    const timezone = resolveTimezone();
    const envelope = buildCatchupEnvelope({
        unreadCount:  overview.totalUnread,
        channelCount: overview.channels.length,
        now:          new Date(),
        timezone,
        timeHeader:   timeHeader(),
    });
    // With no lost tasks passed, only unread mail makes a catch-up wake; the one caller
    // (`bot.ts`'s `triggerCatchUp`) checks `totalUnread > 0` first. Before the envelope
    // contracts (#60) the conductor's own submit() threw here instead.
    if(envelope.mode === 'append') {
        throw new InvariantViolationError('submitConductorCatchUp', 'called with no unread mail — a catch-up with nothing unread opens no turn, so there is nothing to submit');
    }
    await submitAndDeliverConductorEnvelope(envelope, envelopeDeps);
}

/** Parameters for {@link runConductorInboxInit}. */
export interface RunConductorInboxInitParams {
    inboxManager:          InboxManager
    readyClient:           Client
    perchConfig:           PerchConfig | undefined
    ingressGate:           IngressGate<Message>
    conversationConductor: Conductor
    /**
     * The session supervisor's half of boot recovery (`src/app/runtime.ts`): the journal read and
     * recovery computation ({@link BootRecoveryRuntime.loadRecovery}) and the boot sequence itself
     * ({@link BootRecoveryRuntime.runBoot}). This adapter decides when each runs.
     */
    recoveryRuntime:       BootRecoveryRuntime
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
    /**
     * R1: drives the merged boot envelope's events-since-mark section. Seeded here from the
     * journal-derived `lastKnownAt` boundary (or the `bootEventsWindowMs` fallback) before
     * `eventsDelta()` is read, then advanced via `markEventsSeen()` once the envelope has
     * submitted. Optional — when omitted, the merged envelope carries no events section, exactly
     * like omitting `healthRegistry` leaves `ContextPolicy.healthNote()` permanently disabled.
     */
    contextPolicy?:        ContextPolicy
    /**
     * Fallback lookback window for seeding the events mark when the journal carries no
     * `turn_completed`/`turn_failed` entry to derive `lastKnownAt` from. Defaults to
     * {@link DEFAULT_BOOT_EVENTS_WINDOW_MS} (24h, matching `sessionConfigSchema`'s own
     * `bootEventsWindowMs` default).
     */
    bootEventsWindowMs?:   number
    /**
     * R1: background-task descriptions lost at restart, sourced from
     * `createConversationConductor`'s own {@link import('@/app/sessions').ConversationConductorResult.bootLostTasks}
     * — a snapshot read BEFORE the conversation session was ever opened, so it cannot race
     * `Conductor.open()`'s own fire-and-forget `task_lost` journal write (see that field's own
     * doc for why a read taken after `open()` — `recoveryRuntime.loadRecovery()` below, done for
     * the boot sequence's undelivered-redelivery needs — would reliably see the same tasks as
     * already resolved). Optional so tests and any caller that predates this field keep
     * working: when omitted, the merged envelope falls back to this function's own (racy) local
     * `recovery.lostTasks` computation, matching pre-R1-fix behaviour exactly.
     */
    bootLostTasks?:        string[]
    /**
     * Session-peers block 4: renders the time header of both boot-time envelopes this sequence
     * builds (each replayed channel's Discord envelope and the merged boot envelope). See
     * {@link SubmitConductorCatchUpParams.timeHeader}.
     */
    timeHeader?:           TimeHeaderProvider
}

/**
 * The Discord side of boot-time crash recovery (P10), run once through the bot's recovery adapter
 * when the session supervisor (`src/app/runtime.ts`) runs recovery: loads unread mail, loads the
 * recovery through `recoveryRuntime.loadRecovery()`, then runs the runtime's boot sequence
 * (`recoveryRuntime.runBoot`) exactly once to redeliver anything a crash left undelivered and
 * replay anything received-but-unhandled, opening the ingress gate always (even with nothing to
 * replay — a boot with no crash-recovery work still needs its live-message buffer drained). Once
 * that sequence resolves, this function builds and submits ONE merged boot envelope (R1: the boot
 * bundle and the Discord catch-up merge into a single envelope on the Discord side) via
 * {@link submitMergedBootEnvelope} — unread overview, events since the journal-derived
 * `lastKnownAt` mark, recovery's lost tasks, and the undelivered replies this same boot actually
 * redelivered — submitted with a turn or appended without one per the envelope's own contract
 * (see `buildCatchupEnvelope`'s doc). The boot sequence's own `submitCatchUp` callback is
 * therefore a no-op here: the merged envelope subsumes it.
 *
 * Perch's `triggerOnStartup` test mode means perch handles everything this boot: recovery
 * (undelivered redelivery, replay, the gate opening) still runs unconditionally below so a crash
 * is never silently dropped, but the merged boot envelope itself is suppressed entirely —
 * mirroring the oneshot branch's own "perch scheduler handles presence, no action needed here"
 * comment.
 *
 * `Conductor.open()` (already awaited by the session supervisor before this runs) computes and
 * consumes its own boot-time `RecoveryResult` entirely internally and does not expose it, so the
 * runtime recomputes `recovery` from a fresh journal read over the same window — a deliberate,
 * documented duplication of one read-only computation, not of the wait/interrupt/flush sequence
 * the P10 folded gap is actually about (that sequence has exactly one owner:
 * `Conductor.shutdown`, run by the supervisor's cross-session shutdown).
 *
 * `submitReplay` (composed here, since the boot sequence itself never builds an envelope — see
 * `agent/session/boot-sequence.ts`'s module doc) and the merged boot envelope both submit through
 * `conversationConductor.submit` and then deliver any response through the SAME
 * `conversationConductor.deliver` + {@link sendEnvelopeResponse} idempotency path the live
 * coordinator uses (`setup/coordinator-setup.ts`), so a boot-time submission and a live one can
 * never double-deliver the same envelope id.
 * @param params See {@link RunConductorInboxInitParams}.
 */
export async function runConductorInboxInit(params: RunConductorInboxInitParams): Promise<void> {
    const {
        inboxManager, readyClient, perchConfig, ingressGate,
        conversationConductor, recoveryRuntime, responseRouter, rateLimiter, excludeChannelIds, discordCapability,
        contextPolicy, bootEventsWindowMs, bootLostTasks, timeHeader = formatTimeHeader,
    } = params;

    const envelopeDeps: SubmitConductorEnvelopeDeps = { conversationConductor, responseRouter, client: readyClient, rateLimiter, discordCapability };

    // R1: descriptions of undelivered replies THIS boot actually redelivered — fed into the
    // merged boot envelope's "Replies redelivered for you" section below. Only a successful
    // `deliverUndelivered` call pushes here (a failed one is logged and swallowed, same as
    // before), so this list means "redelivered", not merely "attempted".
    const redeliveredTexts: string[] = [];

    async function deliverUndelivered(item: UndeliveredEnvelope): Promise<void> {
        try {
            const deliverResult = await conversationConductor.deliver(item.envelopeId, async () => {
                const target = responseRouter.resolveDeliveryTarget({ kind: item.envelopeKind, channelId: item.channelId === undefined ? undefined : createChannelId(item.channelId) });
                let channelId: ChannelId | undefined;
                switch(target.kind) {
                    case 'origin': {
                        channelId = target.channelId;
                        break;
                    }
                    case 'well-known': {
                        // Sender resolves this mapping and converts a missing channel into skipped.
                        channelId = undefined;
                        break;
                    }
                    case 'fallback': {
                        const fallback = await responseRouter.routeToFallback(item.responseText);
                        channelId = fallback.targetChannelId;
                        break;
                    }
                }
                const sendResult = await sendEnvelopeResponse({
                    envelopeId: item.envelopeId,
                    kind:       item.envelopeKind,
                    channelId,
                    text:       item.responseText,
                    responseRouter,
                    client:     readyClient,
                    rateLimiter,
                    discordCapability,
                });
                switch(sendResult.status) {
                    case 'sent': { return { kind: 'committed', disposition: 'sent', channelId: sendResult.channelId, messageIds: sendResult.messageIds };
                    }
                    case 'queued': { return { kind: 'committed', disposition: 'queued', channelId: sendResult.channelId, outboxIds: sendResult.outboxIds };
                    }
                    case 'skipped': { return { kind: 'skipped', reason: sendResult.reason };
                    }
                    case 'unavailable': { throw new ResponseUnavailableError();
                    }
                }
            });
            if(deliverResult.outcome === 'committed') {
                redeliveredTexts.push(truncateToWordBoundary(item.responseText, REDELIVERED_TEXT_PREVIEW_LENGTH));
            }
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
    async function submitReplayChannel(channelId: ChannelId, channelMessages: readonly ReplayableMessage[]): Promise<void> {
        const newest = channelMessages[channelMessages.length - 1]!;
        const envelope = buildDiscordEnvelope({
            messages: channelMessages.map(message => ({
                messageId: message.id,
                content:   `${message.author}: ${message.content}`,
            })),
            authorId:         newest.authorId === undefined ? undefined : createUserId(newest.authorId),
            authorName:       newest.author,
            channelId,
            channelName:      newest.channelName,
            isDM:             isDmScope(newest.guildId),
            now:              new Date(),
            timezone,
            timeHeader:       timeHeader(),
            continuationNote: REPLAY_CAVEAT,
        });
        await submitAndDeliverConductorEnvelope(envelope, envelopeDeps);
        // Stryker disable next-line llm: submitReplay groups messages by message.channelId, so newest.channelId always equals channelId here and the swap is unobservable.
        await inboxManager.recordHandled(channelId, newest.id, newest.timestamp);
    }

    async function submitReplay(messages: readonly ReplayableMessage[]): Promise<void> {
        const byChannel = new Map<ChannelId, ReplayableMessage[]>();
        for(const message of messages) {
            // Stryker disable next-line llm: get returns a truthy array or undefined, and message.channelId is already a string, so || and + '' are equivalent mutations.
            const existing = byChannel.get(message.channelId) ?? [];
            // Stryker disable next-line llm: spreading a fresh single-element array appends exactly the same one value.
            existing.push(message);
            // Stryker disable next-line llm: only array contents are observed, so storing a value-equal shallow copy cannot change behavior.
            byChannel.set(message.channelId, existing);
        }

        for(const [channelId, channelMessages] of byChannel) {
            try {
                // eslint-disable-next-line no-await-in-loop -- submit each channel envelope and watermark in source order
                await submitReplayChannel(channelId, channelMessages);
            } catch (err) {
                logger.warn({ err, channelId, msg: 'Boot-time replay submission failed — channel will be replayed again on the next boot' });
            }
        }
    }

    /**
     * Builds and submits the R1 merged boot envelope: reads `contextPolicy.eventsDelta()` against
     * the mark {@link seedEventsMark} already seeded (BEFORE the ingress gate opened — see that
     * function's own doc for the concurrency hazard seeding here, after the gate is open, used to
     * create); submits with a turn (`submitAndDeliverConductorEnvelope`, `{ priority: 'normal' }`)
     * when the envelope is a query envelope (unread mail or a lost task), or appends it
     * without opening one (`conversationConductor.appendWithoutTurn`) otherwise; advances the
     * mark via `markEventsSeen()` only AFTER submission, so a failure partway through does not
     * mark events seen that were never actually surfaced. A no-op for the events section (and the
     * mark call) when `contextPolicy` was not supplied.
     *
     * Submits NOTHING at all — never calls `submit` nor `appendWithoutTurn` — when there is
     * genuinely nothing to report (no unread mail, no lost task, no events delta, nothing
     * redelivered): the acceptance criterion is "a resume boot with nothing to report ... submits
     * no envelope", not an envelope containing only a header and a time stamp. The events mark is
     * still advanced via `markEventsSeen()` in this case too — the delta was computed (and found
     * empty) either way, so there is nothing lost by moving the mark forward.
     */
    async function submitMergedBootEnvelope(lostTasks: string[]): Promise<void> {
        const eventsDelta = contextPolicy ? await contextPolicy.eventsDelta() : undefined;

        const overview = inboxManager.getUnreadOverview();
        // Stryker disable next-line llm: InboxManager.getUnreadOverview sums filter(...).length values from zero, so totalUnread is never negative and `<= 0` is unreachable.
        const hasNothingToReport = overview.totalUnread === 0
          && lostTasks.length === 0
          && (eventsDelta?.length ?? 0) === 0
          && redeliveredTexts.length === 0;

        if(!hasNothingToReport) {
            const envelope = buildCatchupEnvelope({
                unreadCount:  overview.totalUnread,
                channelCount: overview.channels.length,
                now:          new Date(),
                timezone,
                timeHeader:   timeHeader(),
                eventsDelta,
                lostTasks,
                redelivered:  redeliveredTexts,
            });

            if(envelope.mode === 'query') {
                await submitAndDeliverConductorEnvelope(envelope, envelopeDeps);
            } else {
                conversationConductor.appendWithoutTurn(envelope);
            }
        }

        contextPolicy?.markEventsSeen();
    }

    /**
     * Seeds `contextPolicy`'s events mark from `knownAt` (or the `bootEventsWindowMs` fallback)
     * — called BEFORE the boot sequence opens the ingress gate, not from inside
     * `submitMergedBootEnvelope` after it already has. A Discord message buffered during boot is
     * released the moment the gate opens; if the mark were seeded only later (inside
     * `submitMergedBootEnvelope`, which runs AFTER the boot sequence resolves), a live turn
     * released by that gate could call `contextPolicy.eventsDelta()` — and, on a non-withdrawn
     * submit, its own `markEventsSeen()` — concurrently with this boot sequence moving the mark
     * backwards to `knownAt`, an order-dependent race with no single correct outcome. Seeding
     * here, before any live traffic can possibly observe or advance the mark, removes the window
     * entirely: by the time the gate opens, the mark already holds its boot-time value.
     */
    function seedEventsMark(knownAt: Date | undefined): void {
        if(!contextPolicy) {
            return;
        }
        const seedMs = knownAt?.getTime() ?? (Date.now() - (bootEventsWindowMs ?? DEFAULT_BOOT_EVENTS_WINDOW_MS));
        contextPolicy.markEventsSeenAt(seedMs);
    }

    const skipCatchUp = Boolean(perchConfig?.testMode?.triggerOnStartup);

    // Tracks whether the runtime's boot sequence was actually reached — once it is, ITS OWN
    // `finally` guarantees the gate opens exactly once, so the backstop below must not double-open
    // it.
    let bootSequenceStarted = false;
    try {
        inboxManager.setBotUserId(readyClient.user!.id);
        await inboxManager.loadUnread();

        const { recovery, knownAt } = await recoveryRuntime.loadRecovery();

        // R1 concurrency fix: seed BEFORE the boot sequence opens the ingress gate — see
        // seedEventsMark's own doc for the race this ordering removes. Skipped entirely when
        // this boot's merged envelope is suppressed (perch testMode), matching
        // submitMergedBootEnvelope's own skipCatchUp gate below.
        if(!skipCatchUp) {
            seedEventsMark(knownAt);
        }

        bootSequenceStarted = true;
        await recoveryRuntime.runBoot<ReplayableMessage>({
            recovery,
            deliver:         deliverUndelivered,
            replayUnhandled: () => inboxManager.replayUnhandled({ excludeChannelIds }),
            submitReplay,
            // R1: the catch-up envelope is now built as ONE merged boot envelope after this
            // sequence resolves (see submitMergedBootEnvelope) — this callback is a deliberate
            // no-op so the boot sequence's own conditional call does not also submit a second,
            // narrower catch-up-only envelope.
            submitCatchUp:   () => Promise.resolve(),
            unreadCount:     () => (skipCatchUp ? 0 : inboxManager.getUnreadOverview().totalUnread),
            ingressGate,
        });

        if(!skipCatchUp) {
            try {
                // R1 race fix: `bootLostTasks` (a snapshot taken before the session opened — see
                // its own doc) is preferred when supplied; the local `recovery.lostTasks` computed just
                // above is a fallback ONLY for a caller that predates that field, since a read of
                // THIS journal at THIS point in the boot sequence races `Conductor.open()`'s own
                // fire-and-forget `task_lost` write and, in production, reliably loses it.
                await submitMergedBootEnvelope(
                    bootLostTasks ?? recovery.lostTasks.map(task => task.description ?? task.taskId)
                );
            } catch (err) {
                logger.warn({ err, msg: 'Boot-time catch-up envelope submission failed' });
            }
        }
    } finally {
        // Backstop for a failure BEFORE the boot sequence is ever reached (e.g. `loadUnread` or
        // the recovery load itself rejects) — without this, such a failure would leave the gate
        // stuck in `buffering` forever, since the boot sequence's own `finally` never gets a
        // chance to run.
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
    /** Forwarded verbatim to {@link runConductorInboxInit} — see its own `RunConductorInboxInitParams.recoveryRuntime` doc. */
    recoveryRuntime:       BootRecoveryRuntime
    responseRouter:        ResponseRouter
    rateLimiter:           DiscordRateLimiter
    ingressGate:           IngressGate<Message>
    excludeChannelIds?:    ReadonlySet<ChannelId>
    discordCapability?:    DiscordCapability
    /** Forwarded verbatim to {@link runConductorInboxInit} — see its own `RunConductorInboxInitParams.contextPolicy` doc (R1). */
    contextPolicy?:        ContextPolicy
    /** Forwarded verbatim to {@link runConductorInboxInit} — see its own `RunConductorInboxInitParams.bootEventsWindowMs` doc (R1). */
    bootEventsWindowMs?:   number
    /** Forwarded verbatim to {@link runConductorInboxInit} — see its own `RunConductorInboxInitParams.bootLostTasks` doc (R1). */
    bootLostTasks?:        string[]
    /** Forwarded verbatim to {@link runConductorInboxInit} — see its own `RunConductorInboxInitParams.timeHeader` doc (session-peers block 4). */
    timeHeader?:           TimeHeaderProvider
}

/**
 * Sets up inbox and catch-up functionality.
 * Initializes inbox, loads unread messages, and starts catch-up if needed.
 *
 * @param params - Configuration for inbox setup
 * @returns A promise settling once inbox initialization finishes — including the deferred
 * discord-online path, when Discord was not yet available at call time.
 */
export function setupInboxAndCatchUp(params: SetupInboxParams): Promise<void> {
    const {
        inboxManager,
        readyClient,
        perchConfig,
        healthRegistry,
        conversationConductor,
        recoveryRuntime,
        responseRouter,
        rateLimiter,
        ingressGate,
        excludeChannelIds,
        discordCapability,
        contextPolicy,
        bootEventsWindowMs,
        bootLostTasks,
        timeHeader,
    } = params;

    async function runInboxInit(): Promise<void> {
        try {
            logger.info({ msg: 'Starting inbox initialization...' });

            await runConductorInboxInit({
                inboxManager, readyClient, perchConfig, ingressGate,
                conversationConductor, recoveryRuntime, responseRouter, rateLimiter, excludeChannelIds, discordCapability,
                contextPolicy, bootEventsWindowMs, bootLostTasks, timeHeader,
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
                    void runInboxInit()
                        .catch(logUnhandledInboxInitializationError)
                        .finally(() => resolve());
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
