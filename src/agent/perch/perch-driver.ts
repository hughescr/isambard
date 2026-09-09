/**
 * The perch driver owns a perch slot's turn lifecycle end to end: submitting the slot envelope,
 * arming the wrap-up and interrupt timers relative to the slot's `endsAt`, and — on overlap —
 * deferring to a single pending flag rather than queuing multiple slot envelopes.
 *
 * Every timing decision goes through the injected {@link Clock} (P3) — this module never reads
 * a real timer. `runSlot` is synchronous (it decides to submit-or-defer and returns immediately);
 * the actual submission, including building the perch context, happens in a fire-and-forget
 * async continuation armed off the same `now`/`endsAt` captured synchronously at the top of
 * `runSlot`, so the wrap-up/interrupt timers are never skewed by how long that continuation
 * takes to build the envelope.
 *
 * Deviation from the brief's assumed P7 `Conductor` shape (`submit(envelope, opts): { id, done }`
 * plus a separate `interrupt()`): the landed `Conductor.submit` (`@/agent/session`) instead
 * returns a single `Promise<TurnResult>` scoped 1:1 to that call's envelope, and interruption is
 * `interruptCurrent()`.
 *
 * `slotRunning` (this call's own `submit()` promise has not yet settled) is necessary but NOT
 * sufficient to know the slot turn is the conductor's *currently active* one: `submit()` with
 * `priority: 'other'` only ever ENQUEUES behind whatever else is already running (a perch-channel
 * Discord turn submitted by `handlers.ts`, say), so there is a real window — from the moment
 * `runSlot` flips `slotRunning` true to the moment the conductor actually promotes this envelope
 * off its queue — where `slotRunning` is true but the running turn is someone else's. Interrupting
 * unconditionally in that window would abort the wrong turn (exactly what the brief's "tracked by
 * its submit handle id" language is there to prevent). This module closes that gap by also
 * checking `conductor.status().turn` against the specific envelope id this call built
 * (`slotEnvelopeId`, captured the moment the envelope exists, before `conductor.submit()` is even
 * called) before ever calling `interruptCurrent()` — so an interrupt only ever fires while the
 * conductor's active turn really is this slot's own envelope.
 *
 * The wrap-up nudge has no such interject-into-a-live-turn mechanism available at all: the landed
 * `Conductor` runs one turn at a time end to end and offers no way to inject additional input into
 * an ALREADY-RUNNING turn short of `interruptCurrent()` (which aborts it, discarding the very
 * point of a gentle "wrap up" nudge). So `armWrapUpTimer` cannot make its envelope reach the slot
 * turn while that turn is still working — the SDK gives no such path — but submitting it at
 * `priority: 'human'` (rather than `'other'`) at least guarantees it is the very next turn the
 * conductor runs once the slot turn ends (ahead of any 'other'-priority perch-channel message or
 * the next-hour slot envelope this driver itself queues from `onSlotSettled`), so the model still
 * sees the nudge as its immediate next turn rather than however far back in a FIFO queue.
 *
 * @module agent/perch/perch-driver
 */
import type { Logger } from '@hughescr/logger';
import { buildPerchSlotEnvelope, buildPerchWrapUpEnvelope, computeSlotEndsAt } from './envelope';
import { getSlotForHour } from './schedule';
import type { PerchConfig, PerchSlot } from './types';
import type { ContextBuilder } from '@/agent/context-builder';
import type { Clock, Conductor, TimeHeaderProvider, TimerHandle } from '@/agent/session';
import type { ActivityLogger } from '@/storage';
import { formatTimeHeader } from '@/utils';

/** Grace period fallback (minutes) used when {@link PerchConfig.interruptGraceMinutes} is
 * omitted — mirrors `perchConfigSchema`'s own default in `@/config`. */
const DEFAULT_INTERRUPT_GRACE_MINUTES = 2;

/** Dependencies for {@link createPerchDriver}. */
export interface PerchDriverDeps {
    /**
     * Only the surface the driver needs: submit the slot/wrap-up turns, interrupt an overrun, and
     * `status()` to confirm — right before actually calling `interruptCurrent()` — that the
     * conductor's currently active turn really is this slot's own envelope (see the module doc).
     */
    conductor:           Pick<Conductor, 'submit' | 'interruptCurrent' | 'status'>
    /** Builds the perch context block injected into the slot envelope. Omitted context renders as an empty block. */
    contextBuilder?:     Pick<ContextBuilder, 'buildPerchContext'>
    clock:               Clock
    config:              PerchConfig
    /** Current local hour (0-23) — used only to resolve the slot for a pending trigger once the running slot ends. */
    getCurrentLocalHour: () => number
    activityLogger?:     Pick<ActivityLogger, 'log'>
    /**
     * Session-peers block 4: renders the slot envelope's time header. The composition root
     * supplies a provider that appends the ambient other-session/quota lines; omitted, this
     * falls back to the bare `formatTimeHeader`, exactly as before that block.
     */
    timeHeader?:         TimeHeaderProvider
    logger:              Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

/** What {@link PerchDriver.runSlot} resolves to: `'started'` when a fresh slot turn was
 * submitted, `'deferred'` when a slot turn was already running and this trigger was folded into
 * the single pending flag instead. */
export type RunSlotOutcome = 'started' | 'deferred';

/** The perch driver returned by {@link createPerchDriver}. */
export interface PerchDriver {
    /** Submits a slot turn, or defers to the pending flag if one is already running. */
    runSlot: (slot: PerchSlot) => RunSlotOutcome
    /** Clears all timers and the pending flag. Does not interrupt an already-running turn. */
    stop:    () => void
}

/**
 * Creates a perch driver. See the module doc for the overlap/timer/interrupt contract.
 * @param deps See {@link PerchDriverDeps}.
 * @returns A {@link PerchDriver}.
 */
export function createPerchDriver(deps: PerchDriverDeps): PerchDriver {
    const { conductor, contextBuilder, clock, config, getCurrentLocalHour, activityLogger, logger, timeHeader = formatTimeHeader } = deps;
    const interruptGraceMinutes = config.interruptGraceMinutes ?? DEFAULT_INTERRUPT_GRACE_MINUTES;

    let slotRunning = false;
    let pending = false;
    let wrapUpTimer: TimerHandle | undefined;
    let interruptTimer: TimerHandle | undefined;
    /**
     * The envelope id of the slot turn `submitSlot` is currently driving, or `undefined` before
     * that envelope has been built. Set synchronously the moment the envelope exists (ahead of the
     * `conductor.submit()` call itself), so `armInterruptTimer`'s scoping check below never sees a
     * stale id from a previous slot even during the narrow window between `runSlot` flipping
     * `slotRunning` true and the envelope actually being built.
     */
    let slotEnvelopeId: string | undefined;

    function clearTimers(): void {
        if(wrapUpTimer !== undefined) {
            clock.clearTimer(wrapUpTimer);
            wrapUpTimer = undefined;
        }
        if(interruptTimer !== undefined) {
            clock.clearTimer(interruptTimer);
            interruptTimer = undefined;
        }
    }

    function logActivity(type: 'perch-start' | 'perch-end', summary: string): void {
        void activityLogger?.log({ type, summary }).catch((err: unknown) => {
            logger.warn({ err, type }, 'Failed to log perch activity');
        });
    }

    /**
     * Submitted once — `wrapUpTimer` only ever fires a single time (a `setTimer` callback is not
     * recurring) and `onSlotSettled`'s `clearTimers()` always cancels it before the slot turn's own
     * flag flips, so this callback body never runs more than once nor after the slot has ended;
     * see the module doc for why `priority: 'human'` (not `'other'`) is what makes this the very
     * next turn the conductor runs once the slot turn ends.
     */
    function armWrapUpTimer(now: Date, endsAt: Date): void {
        const fireAt = endsAt.getTime() - config.wrapUpTimeoutMinutes * 60_000;
        const delayMs = Math.max(0, fireAt - now.getTime());
        wrapUpTimer = clock.setTimer(() => {
            wrapUpTimer = undefined;
            const envelope = buildPerchWrapUpEnvelope({ now: new Date(clock.now()), leadMinutes: config.wrapUpTimeoutMinutes });
            conductor.submit(envelope, { priority: 'human' }).catch((err: unknown) => {
                logger.error({ err }, 'Failed to submit perch wrap-up envelope');
            });
        }, delayMs);
    }

    /**
     * Interrupts the conductor's active turn ONLY when it is confirmed (via `status()`) to still
     * be this specific slot's own envelope — never a wrap-up turn, a perch-channel Discord turn, or
     * (the race the module doc describes) this same slot envelope still merely queued behind one of
     * those. `onSlotSettled`'s `clearTimers()` cancels this timer before the slot turn's own flag
     * flips, so by the time this callback runs the slot submission is guaranteed not yet settled —
     * the only open question is whether it is the conductor's ACTIVE turn yet, which the status
     * check below answers.
     */
    function armInterruptTimer(now: Date, endsAt: Date): void {
        const fireAt = endsAt.getTime() + interruptGraceMinutes * 60_000;
        const delayMs = Math.max(0, fireAt - now.getTime());
        interruptTimer = clock.setTimer(() => {
            interruptTimer = undefined;
            const { turn } = conductor.status();
            if(turn?.kind !== 'perch' || turn.envelopeId !== slotEnvelopeId) {
                return;
            }
            conductor.interruptCurrent().catch((err: unknown) => {
                logger.error({ err }, 'Failed to interrupt an overrunning perch slot turn');
            });
        }, delayMs);
    }

    function onSlotSettled(): void {
        clearTimers();
        slotRunning = false;
        slotEnvelopeId = undefined;
        logActivity('perch-end', 'Perch session completed');

        if(pending) {
            pending = false;
            const currentSlot = getSlotForHour(getCurrentLocalHour());
            runSlot(currentSlot);
        }
    }

    /**
     * Builds and submits the slot envelope, then runs {@link onSlotSettled} once the turn
     * resolves. When `contextBuilder` is omitted this never awaits before the `conductor.submit`
     * call below — so `runSlot`'s caller observes that submission synchronously, matching the
     * brief's "submit happens synchronously" intent for the common (no context builder) case;
     * only an actual `buildPerchContext` call introduces a real await point.
     */
    async function submitSlot(slot: PerchSlot, now: Date, endsAt: Date): Promise<void> {
        let perchContext = '';
        if(contextBuilder) {
            try {
                perchContext = await contextBuilder.buildPerchContext(now);
            } catch (err) {
                logger.warn({ err, slot }, 'Failed to build perch context; continuing without it');
            }
        }

        const envelope = buildPerchSlotEnvelope({
            slot, now, timezone: config.timezone, endsAt, timeHeader: timeHeader(config.timezone), perchContext,
        });
        // Captured before conductor.submit() is even called, closing the race the module doc
        // describes: armInterruptTimer's status() check must never see a stale id from a previous
        // slot during the window (when contextBuilder awaits) between slotRunning flipping true and
        // this envelope actually existing.
        slotEnvelopeId = envelope.id;
        logActivity('perch-start', `Perch session started (slot: ${slot})`);

        try {
            await conductor.submit(envelope, { priority: 'other' });
        } catch (err) {
            logger.error({ err, slot }, 'Perch slot turn failed');
        }
        onSlotSettled();
    }

    function runSlot(slot: PerchSlot): RunSlotOutcome {
        if(slotRunning) {
            pending = true;
            return 'deferred';
        }

        slotRunning = true;

        const now = new Date(clock.now());
        const endsAt = computeSlotEndsAt(now, config.maxSessionMinutes);

        armWrapUpTimer(now, endsAt);
        armInterruptTimer(now, endsAt);
        void submitSlot(slot, now, endsAt);

        return 'started';
    }

    return {
        runSlot,
        stop(): void {
            clearTimers();
            pending = false;
        },
    };
}
