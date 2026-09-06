/**
 * Cross-session shutdown orchestration for the long-lived session core (P10). This module owns
 * the ACROSS-SESSIONS sequencing only: stop ingress, run every session's own shutdown
 * concurrently, then flush the shared journal — all bounded by `deadlineMs`, after which the
 * result reports `forced: true` and whatever the still-running session shutdowns eventually do is
 * no longer awaited.
 *
 * The per-session wait/interrupt/flush/close sequence (host-side turn wait up to `turnWaitMs`,
 * an interrupt on timeout, that session's own journal flush, then closing its handle) already
 * lives in {@link import('./conductor').Conductor.shutdown} (P7/P9) — this module calls that
 * once per session and does not reimplement any part of it, per the P10 folded-gap instruction
 * that a session's own shutdown sequence has exactly one owner.
 *
 * @module agent/session/shutdown
 */
import type { Logger } from '@hughescr/logger';
import type { Clock, TimerHandle } from './types';

/** One long-lived session's own shutdown entry point — structurally, `Conductor.shutdown` bound to that session. */
export interface ShutdownSession {
    /** Name for logging only (e.g. 'conversation', 'perch'). */
    name:     string
    /** The session's own wait/interrupt/flush/close sequence (see the module doc). */
    shutdown: (options: { turnWaitMs: number, deadlineMs: number }) => Promise<void>
}

/** The shared write-ahead journal port this module flushes once, after every session has settled. */
export interface ShutdownJournal {
    flush: () => Promise<void>
}

/** Dependencies and configuration for {@link createShutdown}. */
export interface CreateShutdownParams {
    /** Every long-lived session this process owns; each is shut down concurrently. */
    sessions:    ShutdownSession[]
    /** Flushed once after every session's shutdown has settled — skipped if `deadlineMs` forces completion first. */
    journal:     ShutdownJournal
    /** Stops accepting new live ingress (e.g. the Discord message-ingress gate). Called first, before any session's shutdown. */
    stopIngress: () => void | Promise<void>
    clock:       Clock
    /** Forwarded verbatim to every session's `shutdown()` — see `Conductor.shutdown`'s own `turnWaitMs`. */
    turnWaitMs:  number
    /** Bounds the whole sessions-then-flush phase (not `stopIngress`). On elapse, `run()` resolves with `{ forced: true }` without awaiting whatever is still in flight. */
    deadlineMs:  number
    logger:      Pick<Logger, 'info' | 'warn' | 'error'>
}

/** Outcome of {@link Shutdown.run}. */
export interface ShutdownResult {
    /** `true` when `deadlineMs` elapsed before every session's shutdown (and the journal flush) had settled. */
    forced: boolean
}

/** The cross-session shutdown orchestrator returned by {@link createShutdown}. */
export interface Shutdown {
    /** Idempotent: the first call starts the sequence, every later call returns that same promise. */
    run: () => Promise<ShutdownResult>
}

/**
 * Creates a cross-session shutdown orchestrator.
 * @param params See {@link CreateShutdownParams}.
 * @returns A {@link Shutdown} whose `run()` is safe to call from both a `bot.stop()` path and a
 * signal handler without racing itself.
 */
export function createShutdown(params: CreateShutdownParams): Shutdown {
    const { sessions, journal, stopIngress, clock, turnWaitMs, deadlineMs, logger } = params;

    let runPromise: Promise<ShutdownResult> | undefined;

    async function doRun(): Promise<ShutdownResult> {
        await stopIngress();

        let forced = false;
        let deadlineTimer: TimerHandle | undefined;
        const deadline = new Promise<void>((resolve) => {
            deadlineTimer = clock.setTimer(() => {
                forced = true;
                resolve();
            }, deadlineMs);
        });

        const graceful = (async (): Promise<void> => {
            await Promise.allSettled(sessions.map(session => session.shutdown({ turnWaitMs, deadlineMs })));
            try {
                await journal.flush();
            } catch (error) {
                logger.error({ error }, 'Shutdown: journal flush failed');
            }
        })();

        await Promise.race([graceful, deadline]);
        if(deadlineTimer !== undefined) {
            clock.clearTimer(deadlineTimer);
        }

        // Stryker disable next-line ObjectLiteral,StringLiteral: Logging for observability
        logger.info({ forced, sessionCount: sessions.length, msg: 'Shutdown sequence complete' });

        return { forced };
    }

    function run(): Promise<ShutdownResult> {
        runPromise ??= doRun();
        return runPromise;
    }

    return { run };
}
