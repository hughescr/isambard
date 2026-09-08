/**
 * Process-lifecycle seams extracted from `src/index.ts` (P10): OS signal handling and the
 * Discord-reconnect recovery subscriber. Both were previously inlined in the composition root
 * with no test coverage; here they are small, injectable, unit-tested functions, and
 * `src/index.ts` becomes thin composition wiring around them.
 *
 * @module app/lifecycle
 */
import type { Logger } from '@hughescr/logger';
import type { Clock, TimerHandle } from '@/agent';
import type { ServiceHealthChange } from '@/services';

/** How much longer than `deadlineMs` the hard-exit timer waits before forcing `exit(1)` — headroom for `stop()`'s own bounded shutdown sequence to finish reporting `{ forced: true }` and unwind. */
const HARD_EXIT_GRACE_MS = 10_000;

/** Dependencies and configuration for {@link registerSignalHandlers}. */
export interface RegisterSignalHandlersParams {
    /** The process to listen on — injected so tests never touch the real `process`. */
    proc:       Pick<NodeJS.Process, 'on' | 'off'>
    /** The graceful-shutdown entry point (typically `() => app.stop()`). Not required to be idempotent on its own — this module's own `shuttingDown` guard ensures it is only ever invoked once, from the first signal received. */
    stop:       () => Promise<void>
    /** The graceful budget `stop()` is expected to honour on its own (e.g. `config.session.shutdownDeadlineMs`); the hard-exit timer below waits this long plus {@link HARD_EXIT_GRACE_MS} before forcing `exit(1)`. */
    deadlineMs: number
    clock:      Clock
    logger:     Pick<Logger, 'info' | 'warn' | 'error'>
    /** Terminates the process — injected so tests observe the call instead of actually exiting. */
    exit:       (code: number) => void
}

/**
 * Registers SIGINT/SIGTERM handlers exactly once: the first signal received calls `stop()`,
 * racing it against a `deadlineMs + 10s` hard timer — `stop()` settling first exits `0`, the
 * timer firing first (or `stop()` rejecting) exits `1`. Every signal after the first, while a
 * shutdown is already running, is logged and otherwise ignored — `stop()` is never called twice
 * and the process never double-exits.
 * @param params See {@link RegisterSignalHandlersParams}.
 * @returns An `unregister` function that removes both listeners (used by the `bun --hot` cleanup
 * path so a hot reload never leaves a stale pair of handlers registered alongside a fresh pair).
 */
export function registerSignalHandlers(params: RegisterSignalHandlersParams): () => void {
    const { proc, stop, deadlineMs, clock, logger, exit } = params;

    let shuttingDown = false;

    function handleSignal(signal: string): void {
        if(shuttingDown) {
            logger.info({ signal, msg: 'Shutdown already in progress; ignoring signal' });
            return;
        }
        shuttingDown = true;
        logger.info({ signal, msg: 'Received shutdown signal, shutting down gracefully...' });

        let hardExitTimer: TimerHandle | undefined;
        const hardExitDeadline = new Promise<'timed-out'>((resolve) => {
            hardExitTimer = clock.setTimer(() => resolve('timed-out'), deadlineMs + HARD_EXIT_GRACE_MS);
        });

        Promise.race([stop().then((): 'stopped' => 'stopped'), hardExitDeadline])
            .then((outcome) => {
                if(hardExitTimer !== undefined) {
                    clock.clearTimer(hardExitTimer);
                }
                if(outcome === 'timed-out') {
                    logger.error({ signal, deadlineMs, msg: 'Shutdown exceeded its deadline; forcing exit' });
                    exit(1);
                } else {
                    exit(0);
                }
                return undefined;
            })
            .catch((error: unknown) => {
                if(hardExitTimer !== undefined) {
                    clock.clearTimer(hardExitTimer);
                }
                logger.error({ error: error instanceof Error ? error.message : String(error), signal, msg: 'Shutdown failed' });
                exit(1);
            });
    }

    function sigintHandler(): void {
        handleSignal('SIGINT');
    }
    function sigtermHandler(): void {
        handleSignal('SIGTERM');
    }

    proc.on('SIGINT', sigintHandler);
    proc.on('SIGTERM', sigtermHandler);

    return () => {
        proc.off('SIGINT', sigintHandler);
        proc.off('SIGTERM', sigtermHandler);
    };
}

/** Dependencies for {@link createDiscordRecoveryHandler}. */
export interface CreateDiscordRecoveryHandlerParams {
    /** Re-warms the channel-registry cache after a reconnect. */
    warmCache:     () => Promise<void>
    /** Submits a catch-up envelope through the conductor. */
    submitCatchUp: () => Promise<void>
    logger:        Pick<Logger, 'warn'>
}

/**
 * Builds the health-registry subscriber that runs Isambard's Discord-reconnect recovery phase:
 * re-warm the channel cache, then submit a catch-up envelope through the conductor. P13b: the
 * one-shot branch (recovering a stuck `processing_message` bot-state mode, then
 * `bot.triggerCatchUp()`) is gone — the conductor is the only path, and its ledger is the sole
 * writer of processing-state transitions. Catch-up on the FIRST connection is handled elsewhere
 * (`runConductorInboxInit`, run from `bot.ts`'s own `clientReady`); this handler only fires on a
 * later reconnect.
 * @param params See {@link CreateDiscordRecoveryHandlerParams}.
 * @returns A `ServiceHealthChange` listener, ready to pass to `healthRegistry.subscribe`.
 */
export function createDiscordRecoveryHandler(params: CreateDiscordRecoveryHandlerParams): (change: ServiceHealthChange) => void {
    const { warmCache, submitCatchUp, logger } = params;

    return (change: ServiceHealthChange): void => {
        if(change.service !== 'discord' || change.newState !== 'online') {
            return;
        }

        void (async () => {
            try {
                await warmCache();
                await submitCatchUp();
            } catch (error) {
                logger.warn({ error: error instanceof Error ? error.message : String(error), msg: 'Discord recovery phase failed' });
            }
        })();
    };
}
