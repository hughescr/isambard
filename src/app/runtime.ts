/**
 * The session supervisor: the composition root's owner of session open, failure, shutdown and
 * crash-recovery POLICY. The primitives it composes all live in `src/agent/session/`
 * (`Conductor.open`, `createShutdown`, `computeRecovery`/`lastKnownAt`, `runBootSequence`); the
 * platform side (the Discord bot) only signals readiness, attaches its post-open wiring and
 * supplies a replay/ingress-gate {@link BootRecoveryAdapter}.
 *
 * Policy, per role:
 *  - conversation — opened first, under {@link CONDUCTOR_OPEN_TIMEOUT_MS}. A rejected or timed-out
 *    open logs and calls the injected `exit(1)`: there is no fallback agent to degrade to, and
 *    exiting lets the deploy's process supervisor restart the process. Perch is not attempted.
 *  - perch — opened next, under the same timeout. A failure logs and leaves perch disabled for the
 *    rest of the process, with no restart and no retry.
 *
 * Every session open goes through `Conductor.open()`, whose `[BOOT]` handshake is what makes the
 * real SDK emit its `system/init` frame at all (see `src/agent/session/conductor.ts`).
 *
 * @module app/runtime
 */
import type { Logger } from '@hughescr/logger';
import {
    computeRecovery,
    createShutdown,
    lastKnownAt,
    runBootSequence,
    type BootRecoveryAdapter,
    type BootRecoveryRuntime,
    type Clock,
    type Conductor,
    type SessionJournal,
    type SessionOpenOutcome,
    type Shutdown,
    type ShutdownSession,
    type TimerHandle
} from '@/agent';

/**
 * Bound on how long one conductor `open()` may take before it is treated as failed. `open()` only
 * rejects on an explicit session-closed error — a wedged CLI child (hung auth prompt, stalled
 * network, never emitting an init frame) leaves it pending forever. Racing against this timeout
 * turns a hang into the same failure a rejection takes: `exit(1)` for the conversation session,
 * perch disabled for the perch session.
 */
export const CONDUCTOR_OPEN_TIMEOUT_MS = 30_000;

/**
 * How far back boot-time crash recovery reads a session journal — matches `Conductor`'s own
 * internal recovery window (P8). `Conductor.open()` computes and consumes its own
 * `RecoveryResult` internally without exposing it, so the boot sequence recomputes it from a
 * fresh read over the same window.
 */
export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One long-lived session the supervisor opens and shuts down: a built, not-yet-opened conductor and its own journal. */
export interface SupervisedSession {
    conductor: Pick<Conductor, 'open' | 'shutdown'>
    journal:   SessionJournal
}

/** Dependencies and configuration for {@link createSessionSupervisor}. */
export interface CreateSessionSupervisorParams {
    /** The conversation session, when built. */
    conversation?:  SupervisedSession
    /** The perch session, when built (perch enabled). */
    perch?:         SupervisedSession
    /** Per-open bound; defaults to {@link CONDUCTOR_OPEN_TIMEOUT_MS}. */
    openTimeoutMs?: number
    /** Forwarded to every opened session's `shutdown()` — `config.session.shutdownTurnWaitMs`. */
    turnWaitMs:     number
    /** Bounds the whole cross-session shutdown — `config.session.shutdownDeadlineMs`. */
    deadlineMs:     number
    /** Stops live ingress; the shutdown's first step. */
    stopIngress:    () => void | Promise<void>
    /** Terminates the process; called with `1` when the conversation open fails. */
    exit:           (code: number) => void
    clock:          Clock
    logger:         Pick<Logger, 'info' | 'warn' | 'error'>
}

/** The session supervisor returned by {@link createSessionSupervisor}. */
export interface SessionSupervisor {
    /** Opens the conversation session, then perch, applying the per-role failure policy. Single-flight: later calls return the first call's promise. */
    openSessions(): Promise<SessionOpenOutcome>
    /** The cross-session shutdown over exactly the sessions that opened; `undefined` until {@link openSessions} has settled with at least one open session. */
    readonly shutdown: Shutdown | undefined
    /** Runs boot-time crash recovery through `adapter` once the conversation session is open; a no-op otherwise. */
    runRecovery(adapter: BootRecoveryAdapter): Promise<void>
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Resolves once `open()` resolves; rejects with `message` if it has not settled within `ms`, or with its own error if it rejects first. */
async function openWithin(open: () => Promise<unknown>, ms: number, message: string, clock: Clock): Promise<void> {
    let timer: TimerHandle | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = clock.setTimer(() => {
            reject(new Error(message));
        }, ms);
    });
    try {
        await Promise.race([open(), timeout]);
    } finally {
        clock.clearTimer(timer!);
    }
}

/**
 * Builds the runtime half of boot-time crash recovery over one session journal: the recovery
 * window read, the recovery computation and the boot sequence itself.
 * @param journal The conversation session's journal.
 * @param clock Supplies "now" for the recovery window.
 * @returns A {@link BootRecoveryRuntime} for a host's {@link BootRecoveryAdapter}.
 */
export function createBootRecoveryRuntime(journal: Pick<SessionJournal, 'readSince' | 'flush'>, clock: Clock): BootRecoveryRuntime {
    return {
        loadRecovery: async () => {
            const entries = await journal.readSince(clock.now() - RECOVERY_WINDOW_MS);
            return { recovery: computeRecovery(entries), knownAt: lastKnownAt(entries) };
        },
        runBoot: params => runBootSequence({ ...params, journal }),
    };
}

/**
 * Creates the session supervisor. See the module doc for the per-role policy.
 * @param params See {@link CreateSessionSupervisorParams}.
 * @returns A {@link SessionSupervisor}.
 */
export function createSessionSupervisor(params: CreateSessionSupervisorParams): SessionSupervisor {
    const { conversation, perch, openTimeoutMs = CONDUCTOR_OPEN_TIMEOUT_MS, turnWaitMs, deadlineMs, stopIngress, exit, clock, logger } = params;

    let openPromise: Promise<SessionOpenOutcome> | undefined;
    let shutdown: Shutdown | undefined;
    // Set only once the conversation session has actually opened — the one precondition for
    // boot-time crash recovery.
    let openedConversation: SupervisedSession | undefined;

    function buildShutdown(opened: { name: string, session: SupervisedSession }[]): void {
        if(opened.length > 0) {
            const sessions: ShutdownSession[] = opened.map(({ name, session }) => ({ name, shutdown: options => session.conductor.shutdown(options) }));
            shutdown = createShutdown({
                sessions,
                journal: {
                    flush: async () => {
                        await Promise.allSettled(opened.map(({ session }) => session.journal.flush()));
                    },
                },
                stopIngress,
                clock,
                turnWaitMs,
                deadlineMs,
                logger,
            });
        }
    }

    async function doOpen(): Promise<SessionOpenOutcome> {
        const opened: { name: string, session: SupervisedSession }[] = [];

        let conversationState: SessionOpenOutcome['conversation'] = 'absent';
        if(conversation) {
            try {
                await openWithin(() => conversation.conductor.open(), openTimeoutMs, 'conductor.open() timed out', clock);
            } catch (err) {
                logger.error({ error: errorText(err), msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
                exit(1);
                return { conversation: 'failed', perch: 'absent' };
            }
            conversationState = 'open';
            openedConversation = conversation;
            // Stryker disable next-line ArrayMethodSwap: opened is newly allocated and empty here, so either insertion makes conversation its sole first entry.
            opened.push({ name: 'conversation', session: conversation });
        }

        let perchState: SessionOpenOutcome['perch'] = 'absent';
        if(perch) {
            try {
                await openWithin(() => perch.conductor.open(), openTimeoutMs, 'perch conductor.open() timed out', clock);
                perchState = 'open';
                opened.push({ name: 'perch', session: perch });
            } catch (err) {
                logger.error({ error: errorText(err), msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
                perchState = 'disabled';
            }
        }

        buildShutdown(opened);
        return { conversation: conversationState, perch: perchState };
    }

    return {
        openSessions(): Promise<SessionOpenOutcome> {
            openPromise ??= doOpen();
            return openPromise;
        },

        get shutdown(): Shutdown | undefined {
            return shutdown;
        },

        async runRecovery(adapter: BootRecoveryAdapter): Promise<void> {
            if(openedConversation) {
                await adapter.recover(createBootRecoveryRuntime(openedConversation.journal, clock));
            }
        },
    };
}

/** The platform side of session startup — structurally satisfied by the Discord bot. */
export interface SessionHost {
    /** Resolves once the platform can host sessions (Discord: the guild cache and channel registry exist). */
    readonly ready:           Promise<void>
    /** Runs the platform's post-open wiring for `outcome`, and keeps `shutdown` for its own stop sequence. */
    attachSessions(outcome: SessionOpenOutcome, shutdown: Pick<Shutdown, 'run'> | undefined): Promise<void>
    /** The platform's replay/ingress-gate side of boot-time crash recovery. */
    readonly recoveryAdapter: BootRecoveryAdapter
}

/** Parameters for {@link startSessions}. */
export interface StartSessionsParams {
    host:       SessionHost
    supervisor: SessionSupervisor
    logger:     Pick<Logger, 'error'>
}

/**
 * The startup sequence, in its one required order: wait for the host's readiness, open the
 * sessions, attach the host's post-open wiring, then run boot-time crash recovery. Never rejects —
 * a failure is logged and the remaining steps are skipped, exactly as a throw inside the host's
 * readiness handler used to skip the rest of its setup.
 * @param params See {@link StartSessionsParams}.
 */
export async function startSessions(params: StartSessionsParams): Promise<void> {
    const { host, supervisor, logger } = params;
    try {
        await host.ready;
        const outcome = await supervisor.openSessions();
        await host.attachSessions(outcome, supervisor.shutdown);
        await supervisor.runRecovery(host.recoveryAdapter);
    } catch (err) {
        logger.error({ err, msg: 'Session startup failed' });
    }
}
