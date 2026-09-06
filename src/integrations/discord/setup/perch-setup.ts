import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import { DateTime } from 'luxon';
import type { DiscordCapability } from '../capability';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import { type createDynamicStatusGenerator, type PresenceManager } from '../presence';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse, sendResponseToWellKnownChannel } from '../response-sender';
import type { BotStateManager } from '../state';
import { createPresenceStreamHandler } from './presence-stream-handler';
import {
    type ClaudeAgent, type ContextBuilder, type PerchConfig, type PerchScheduler, type PerchSessionRunner, type PerchDriver, type ActivityLogger,
    type Clock, type Conductor, type Envelope, type SubmitOptions, type TurnResult,
    createPerchScheduler, createPerchSessionRunner, createPerchDriver
} from '@/agent';

/**
 * Parameters for setting up perch scheduler and runner.
 */
interface SetupPerchParams {
    agent:                    ClaudeAgent
    perchConfig:              PerchConfig
    botStateManager:          BotStateManager
    presenceManager:          PresenceManager | undefined
    dynamicStatusGenerator:   ReturnType<typeof createDynamicStatusGenerator> | undefined
    responseRouter:           ResponseRouter
    rateLimiter:              DiscordRateLimiter
    client:                   Client
    contextBuilder?:          ContextBuilder
    onThinkingContentUpdate?: (content: string) => void
    setLastSessionId?:        (sessionId: string | undefined) => void
    addRecentMessage?:        (content: string, author: 'user' | 'izzy') => void
    activityLogger?:          ActivityLogger
    /** Optional capability facade for outbox fallback when Discord is offline. */
    discordCapability?:       DiscordCapability
}

/**
 * Creates and configures the perch session runner and scheduler.
 *
 * @param params - Configuration for perch setup
 * @returns Object containing configured perch session runner and scheduler
 */
// Stryker disable all: Integration function with callbacks coordinating multiple components - tested via bot integration tests. Scoped to THIS function only (restored below, before wrapConductorWithDelivery/setupPerchDriverAndScheduler) — those have their own dedicated unit tests (perch-setup.test.ts) and must stay mutation-visible.
export function setupPerchSessionRunnerAndScheduler(params: SetupPerchParams): {
    runner:    PerchSessionRunner
    scheduler: PerchScheduler
} {
    const {
        agent,
        perchConfig,
        botStateManager,
        presenceManager,
        dynamicStatusGenerator,
        responseRouter,
        rateLimiter,
        client,
        contextBuilder,
    } = params;

    const runner = createPerchSessionRunner({
        stateManager:    botStateManager,
        logger,
        config:          perchConfig,
        contextBuilder,
        activityLogger:  params.activityLogger,
        runAgentSession: async (runOptions) => {
            // Create abort controller from signal
            const abortController = new AbortController();
            runOptions.abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });

            // Track session completion via Stop/StopFailure hooks (primary signal)
            let stopFired = false;

            // Create stream event handler for presence updates during perch
            const streamEventHandler = await createPresenceStreamHandler(
                presenceManager,
                dynamicStatusGenerator,
                `Perch time: ${runOptions.slot}`,
                botStateManager,
                params.onThinkingContentUpdate
            );

            // Call agent.handleInput with specialMode: 'perching' and the perch prompt
            const result = await agent.handleInput([], {
                specialMode:   'perching',
                abortController,
                perchPrompt:   runOptions.prompt,
                onStreamEvent: streamEventHandler?.onStreamEvent,
                onStop:        () => { stopFired = true; },
                // stopFired means "SDK confirmed session ended (successfully or with failure)". Both paths count as ended.
                onStopFailure: () => { stopFired = true; },
            });

            // Complete presence updates
            if(streamEventHandler) {
                streamEventHandler.complete();
            }

            // Update session ID tracker
            params.setLastSessionId?.(result.sessionId);

            // Log session completion
            logger.info({
                sessionType:    'perching',
                hasResponse:    Boolean(result.response),
                responseLength: result.response?.length ?? 0,
                wasInterrupted: result.wasInterrupted,
                sessionId:      result.sessionId,
                msg:            'Session completed',
            });

            // Route response to well-known channel if present
            if(result.response && !result.wasInterrupted) {
                params.addRecentMessage?.(result.response, 'izzy');
                await sendResponseToWellKnownChannel({
                    response:          result.response,
                    sessionType:       'perching',
                    responseRouter,
                    rateLimiter,
                    client,
                    discordCapability: params.discordCapability,
                });
            }

            return {
                completed:   stopFired,
                sessionId:   result.sessionId,
                partialWork: result.streamTracker.getProgress(),
            };
        },
    });

    const scheduler = createPerchScheduler({
        stateManager:       botStateManager,
        logger,
        config:             perchConfig,
        perchSessionRunner: runner,
        onPerchTrigger:     (slot) => {
            void runner.startPerch(slot).catch((error) => {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger.error({ error: errorMsg, slot, msg: 'Failed to start perch session' });
            });
        },
    });

    // Start the perch scheduler
    scheduler.start();
    logger.info({ msg: 'Perch scheduler initialized and started' });

    return { runner, scheduler };
}
// Stryker restore all

/** Sentinel thrown inside the delivery wrapper's `conductor.deliver` callback (below) to skip the journal write when nothing was actually sent — mirrors `coordinator-setup.ts`/`handlers.ts`'s identical `ResponseNotSentError`. */
class PerchTurnNotSentError extends Error {}

/** Parameters for {@link setupPerchDriverAndScheduler}. */
interface SetupPerchDriverParams {
    /** The full delivery surface the wrapper below needs, on top of what the driver itself uses (`submit`/`interruptCurrent`/`status`). */
    conductor:          Pick<Conductor, 'submit' | 'interruptCurrent' | 'deliver' | 'status'>
    perchConfig:        PerchConfig
    clock:              Clock
    contextBuilder?:    Pick<ContextBuilder, 'buildPerchContext'>
    activityLogger?:    ActivityLogger
    /** Resolves the well-known `perch-time` channel id for a `wrapup` turn's delivery (a `perch` turn resolves it itself via `ENVELOPE_KIND_TO_CHANNEL`). */
    channelRegistry:    ChannelRegistryManager
    responseRouter:     ResponseRouter
    client:             Client
    rateLimiter:        DiscordRateLimiter
    /** Optional capability facade for outbox fallback when Discord is offline. */
    discordCapability?: DiscordCapability
    /** Optional Q3/B4 daily cost ceiling predicate, forwarded to {@link createPerchScheduler}'s deps unchanged. */
    isCostPaused?:      () => boolean
}

/**
 * Wraps `conductor` so that a settled `perch`- or `wrapup`-kind turn with a response is delivered
 * to the well-known `perch-time` channel — via `conductor.deliver` (the same idempotent,
 * journal-backed path `coordinator-setup.ts`/`handlers.ts` use for conversation turns), never a
 * raw send, so a crash between the turn settling and the send landing is recovered on the next
 * boot instead of silently lost or double-sent. A `discord`-kind turn (a live perch-channel
 * message) is left entirely alone — `handlers.ts`'s own `submitPerchChannelMessage` already
 * delivers that one itself, keyed to the ORIGINATING channel rather than the well-known one.
 *
 * `perch` resolves its target channel via `sendEnvelopeResponse`'s own `ENVELOPE_KIND_TO_CHANNEL`
 * mapping; `wrapup` is not in that mapping (it is not itself a live-Discord-message kind), so this
 * wrapper resolves the well-known channel id itself and passes it through explicitly.
 */
function wrapConductorWithDelivery(
    conductor: Pick<Conductor, 'submit' | 'interruptCurrent' | 'deliver' | 'status'>,
    deps: Pick<SetupPerchDriverParams, 'channelRegistry' | 'responseRouter' | 'client' | 'rateLimiter' | 'discordCapability'>
): Pick<Conductor, 'submit' | 'interruptCurrent' | 'status'> {
    const { channelRegistry, responseRouter, client, rateLimiter, discordCapability } = deps;

    async function deliverResult(envelope: Envelope, result: TurnResult): Promise<void> {
        if(!result.response || (envelope.kind !== 'perch' && envelope.kind !== 'wrapup')) {
            return;
        }
        try {
            await conductor.deliver(envelope.id, async () => {
                const perchTimeChannel = envelope.kind === 'wrapup' ? await channelRegistry.getWellKnownChannel('perch-time') : null;
                const channelId = perchTimeChannel?.channelId;
                const sendResult = await sendEnvelopeResponse({
                    envelopeId: envelope.id,
                    kind:       envelope.kind,
                    channelId,
                    text:       result.response!,
                    responseRouter,
                    client,
                    rateLimiter,
                    discordCapability,
                });
                if(!sendResult.sent && !sendResult.queued) {
                    throw new PerchTurnNotSentError();
                }
                return { channelId: channelId ?? '', messageIds: [] };
            });
        } catch (err) {
            if(!(err instanceof PerchTurnNotSentError)) {
                logger.error({ err, envelopeId: envelope.id, kind: envelope.kind, msg: 'Perch turn response delivery failed' });
            }
        }
    }

    return {
        interruptCurrent: options => conductor.interruptCurrent(options),
        status:           () => conductor.status(),
        submit:           async (envelope: Envelope, options: SubmitOptions) => {
            const result = await conductor.submit(envelope, options);
            await deliverResult(envelope, result);
            return result;
        },
    };
}

/**
 * Conductor-mode perch setup (P12): builds a {@link createPerchDriver} bound to a
 * {@link wrapConductorWithDelivery}-wrapped perch conductor and a {@link createPerchScheduler}
 * with no `stateManager`/`PerchSessionRunner` — the driver owns overlap/deferral itself (see
 * `perch-driver.ts`'s own doc), so the scheduler simply calls `driver.runSlot(slot)`
 * unconditionally on every trigger. Returns the driver so the caller (`bot.ts`) can `stop()` it
 * during shutdown.
 *
 * Deliberately does none of what {@link setupPerchSessionRunnerAndScheduler} (the oneshot
 * branch, above, unchanged) does: no `PerchSessionRunner`, no `botStateManager`/presence wiring
 * (the perch conductor's own ledger feeds presence — see `bot.ts`'s conductor-mode branch).
 * @param params See {@link SetupPerchDriverParams}.
 * @returns The built driver and scheduler; the scheduler has already been started.
 */
export function setupPerchDriverAndScheduler(params: SetupPerchDriverParams): {
    driver:    PerchDriver
    scheduler: PerchScheduler
} {
    const { conductor, perchConfig, clock, contextBuilder, activityLogger, channelRegistry, responseRouter, client, rateLimiter, discordCapability, isCostPaused } = params;

    // Stryker disable next-line BlockStatement: composition root — timezone-based hour resolution is not unit-testable with fake timers
    const getCurrentLocalHour = (): number => DateTime.now().setZone(perchConfig.timezone).hour;

    const deliveringConductor = wrapConductorWithDelivery(conductor, {
        channelRegistry, responseRouter, client, rateLimiter, discordCapability,
    });

    const driver = createPerchDriver({
        conductor: deliveringConductor,
        contextBuilder,
        clock,
        config:    perchConfig,
        getCurrentLocalHour,
        activityLogger,
        logger,
    });

    const scheduler = createPerchScheduler({
        logger,
        config:         perchConfig,
        getCurrentLocalHour,
        onPerchTrigger: (slot) => {
            driver.runSlot(slot);
        },
        isCostPaused,
    });

    scheduler.start();
    logger.info({ msg: 'Perch driver and scheduler initialized and started (conductor mode)' });

    return { driver, scheduler };
}
