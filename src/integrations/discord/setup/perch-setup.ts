import { logger } from '@hughescr/logger';
import type { Client } from 'discord.js';
import { DateTime } from 'luxon';
import type { DiscordCapability } from '../capability';
import type { ChannelRegistryManager, ResponseRouter } from '../channel-registry';
import type { DiscordRateLimiter } from '../rate-limiter';
import { sendEnvelopeResponse } from '../response-sender';
import {
    type ContextBuilder, type PerchConfig, type PerchScheduler, type PerchDriver, type PerchSlotHooks, type ActivityLogger,
    type Clock, type Conductor, type Envelope, type SubmitOptions, type TimeHeaderProvider, type TurnResult,
    createPerchScheduler, createPerchDriver
} from '@/agent';

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
    /** Session-peers block 4: forwarded to {@link createPerchDriver} unchanged — see its own `PerchDriverDeps.timeHeader` doc. */
    timeHeader?:        TimeHeaderProvider
    /** Slot-boundary callbacks, forwarded to {@link createPerchDriver} unchanged — see `PerchSlotHooks`. Supplied by `createPerchConductor`, so an identity-driven system-prompt reopen waits for the open slot to end. */
    slotHooks?:         PerchSlotHooks
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
 * Perch setup: builds a {@link createPerchDriver} bound to a {@link wrapConductorWithDelivery}-
 * wrapped perch conductor and a {@link createPerchScheduler} with no `isPerchTurnRunning`
 * predicate — the driver owns overlap/deferral itself (see `perch-driver.ts`'s own doc), so the
 * scheduler simply calls `driver.runSlot(slot)` unconditionally on every trigger. Returns the
 * driver so the caller (`bot.ts`) can `stop()` it during shutdown. There is no presence wiring
 * here — the perch conductor's own ledger feeds presence (see `bot.ts`'s presence composition).
 * @param params See {@link SetupPerchDriverParams}.
 * @returns The built driver and scheduler; the scheduler has already been started.
 */
export function setupPerchDriverAndScheduler(params: SetupPerchDriverParams): {
    driver:    PerchDriver
    scheduler: PerchScheduler
} {
    const { conductor, perchConfig, clock, contextBuilder, activityLogger, channelRegistry, responseRouter, client, rateLimiter, discordCapability, isCostPaused, timeHeader, slotHooks } = params;

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
        timeHeader,
        slotHooks,
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
