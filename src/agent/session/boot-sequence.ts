/**
 * The P10 boot sequence: everything a conductor-mode boot needs BEYOND what
 * {@link import('./conductor').Conductor.open} already does for a single session.
 *
 * `Conductor.open()` (P8/P9) already, on every boot: reads the journal window, computes
 * {@link import('./recovery').computeRecovery}, journals a `task_lost` entry for every task that
 * never reached a terminal state, seeds the delivery guard from every already-confirmed
 * `response_delivered` id, and pushes the boot bundle its `buildBootBundle` builds (wired per role
 * in `src/app/sessions.ts`) as the session's opening `[BOOT]` handshake (#98), not via this
 * module. So this module does NOT repeat any of that: it does not recompute recovery, does not
 * dispatch `task_lost`, and does not submit a second boot envelope (which would double-inject the
 * bundle the handshake already delivered).
 *
 * What's left, run once after `open()` resolves and before ingress reopens:
 *  1. Deliver every undelivered envelope's response once (recovery only lists turns that
 *     produced a reply, #130), through the caller's `deliver`
 *     (composed from `Conductor.deliver` + the discord-layer `sendEnvelopeResponse`, which this
 *     agent-layer module cannot import directly — see eslint-plugin-boundaries: agent never
 *     imports discord).
 *  2. Replay messages received but never handled before a crash (`replayUnhandled`), submitting
 *     them as one envelope via the caller's `submitReplay` when there are any.
 *  3. Flush the shared journal, so every fact this boot sequence just recorded (deliveries,
 *     the replay envelope's own `envelope_submitted`) is durable before new live traffic is
 *     admitted.
 *  4. Open the ingress gate with the replayed ids — always, even when nothing replayed, so a
 *     boot with no crash-recovery work still starts draining buffered live messages.
 *  5. Submit the catch-up envelope, only when there is unread mail left after replay.
 *
 * @module agent/session/boot-sequence
 */
import type { Logger } from '@hughescr/logger';
import type { RecoveryResult, UndeliveredEnvelope } from './recovery';

/** The subset of {@link import('./recovery').RecoveryResult} this module reads. */
export interface BootRecovery {
    undelivered: readonly UndeliveredEnvelope[]
}

/** The subset of {@link import('./ports').SessionJournal} this module needs. */
export interface BootJournal {
    flush: () => Promise<void>
}

/** The subset of the P10 ingress gate this module drives. */
export interface BootIngressGate {
    /** Opens the gate, draining buffered live messages minus `replayedIds` — called exactly once, always. */
    open: (replayedIds: ReadonlySet<string>) => void
}

/** Dependencies and configuration for {@link runBootSequence}. */
export interface RunBootSequenceParams<TReplayedMessage extends { id: string }> {
    /** Boot-time recovery result, already computed inside `Conductor.open()` (see the module doc) — only `undelivered` is read here. */
    recovery:        BootRecovery
    /**
     * Delivers one undelivered envelope's response exactly once. The exactly-once guarantee is
     * this function's own contract (composed by the caller from `Conductor.deliver`'s
     * idempotency guard) — this module simply calls it once per `recovery.undelivered` entry and
     * does not implement its own dedupe.
     */
    deliver:         (item: UndeliveredEnvelope) => Promise<void>
    /** Fetches messages received but never handled before a crash (the gap between each channel's HANDLED watermark and its lastSeenAt). */
    replayUnhandled: () => Promise<readonly TReplayedMessage[]>
    /** Submits one envelope carrying every replayed message. Called only when `replayUnhandled()` returned at least one message. */
    submitReplay:    (messages: readonly TReplayedMessage[]) => Promise<void>
    /**
     * Submits the catch-up envelope. Called only when `unreadCount() > 0`.
     *
     * R1: the only production caller is the session supervisor (`src/app/runtime.ts`), which
     * runs this through the Discord adapter's `runConductorInboxInit` (`catchup-setup.ts`, via
     * {@link BootRecoveryRuntime.runBoot}); that adapter passes `() => Promise.resolve()` here
     * unconditionally — the boot bundle and the Discord catch-up merge into ONE envelope built AFTER this whole sequence resolves
     * (`submitMergedBootEnvelope`), so this seam is deliberately a no-op in production. It (and
     * `unreadCount` below) is retained rather than removed because it is still real,
     * independently-testable behaviour this module owns and exercises in its own test suite —
     * a future second caller (or a return to a narrower per-source catch-up) can use it again
     * without a signature change. The actual "does this boot have anything to report" gate lives
     * in `catchup-setup.ts`'s `submitMergedBootEnvelope`, not here.
     */
    submitCatchUp:   () => Promise<void>
    /**
     * Current unread-message count, read after replay has been submitted — gates `submitCatchUp`
     * above. See that field's doc: `runConductorInboxInit` feeds this a value but the callback it
     * gates is a no-op, so in production this only affects the returned `catchUpSubmitted` flag,
     * which that caller does not read either.
     */
    unreadCount:     () => number
    ingressGate:     BootIngressGate
    journal:         BootJournal
    /** Records durable completion milestones for boot recovery. */
    logger:          Pick<Logger, 'info'>
}

/** What {@link runBootSequence} resolves with. */
export interface RunBootSequenceResult {
    /** How many messages `replayUnhandled()` returned (0 when nothing needed replaying). */
    replayedCount:    number
    /** Whether the catch-up envelope was submitted. */
    catchUpSubmitted: boolean
}

/** What {@link BootRecoveryRuntime.loadRecovery} resolves with. */
export interface BootRecoveryLoad {
    /** The recovery recomputed from the conversation journal's recovery window. */
    recovery: RecoveryResult
    /** The journal-derived last-known-alive boundary (`lastKnownAt`), or `undefined` for a fresh journal. */
    knownAt:  Date | undefined
}

/**
 * The runtime's half of boot-time crash recovery, handed to a host's {@link BootRecoveryAdapter}.
 * The runtime (`src/app/runtime.ts`) owns the journal read, the recovery computation and the boot
 * sequence itself; the host only supplies the platform callbacks and decides WHEN each step runs,
 * because it has to interleave its own work between them (loading unread mail before the journal
 * read, seeding the events mark before the ingress gate opens, submitting its merged boot envelope
 * afterwards).
 */
export interface BootRecoveryRuntime {
    /** Reads the conversation journal's recovery window and recomputes recovery from it. */
    loadRecovery: () => Promise<BootRecoveryLoad>
    /** Runs {@link runBootSequence} once over the conversation journal (the runtime supplies `journal`). */
    runBoot:      <TReplayedMessage extends { id: string }>(params: Omit<RunBootSequenceParams<TReplayedMessage>, 'journal' | 'logger'>) => Promise<RunBootSequenceResult>
}

/** A host's replay/ingress-gate side of boot-time crash recovery, driven by the runtime once the conversation session has opened. */
export interface BootRecoveryAdapter {
    /** Runs the host's boot recovery through `runtime`. Must not reject. */
    recover: (runtime: BootRecoveryRuntime) => Promise<void>
}

/**
 * Runs the P10 boot sequence once, after `Conductor.open()` has resolved. See the module doc for
 * exactly what this does and does not repeat from `open()`'s own boot recovery.
 * @param params See {@link RunBootSequenceParams}.
 * @returns See {@link RunBootSequenceResult}.
 */
export async function runBootSequence<TReplayedMessage extends { id: string }>(
    params: RunBootSequenceParams<TReplayedMessage>
): Promise<RunBootSequenceResult> {
    const { recovery, deliver, replayUnhandled, submitReplay, submitCatchUp, unreadCount, ingressGate, journal, logger } = params;

    // The gate must open exactly once no matter what fails above it — a rejection here would
    // otherwise leave it in `buffering` forever, silently buffering every live message until a
    // restart (see the module's own risk note). `replayedIds` stays empty unless a replay was
    // both fetched AND successfully resubmitted: a `submitReplay` failure means those messages
    // were never actually reprocessed, so treating them as "already handled" would let a live
    // duplicate arriving during boot be silently dropped instead of answered.
    let replayedIds = new Set<string>();
    let replayedCount: number;

    try {
        for(const item of recovery.undelivered) {
            // eslint-disable-next-line no-await-in-loop -- sequential, exactly-once delivery over a small bounded boot-time list; each `deliver` call is its own durability barrier
            await deliver(item);
        }

        const replayed = await replayUnhandled();
        replayedCount = replayed.length;
        if(replayed.length > 0) {
            await submitReplay(replayed);
        }
        replayedIds = new Set(replayed.map(message => message.id));
        logger.info({ redeliveredCount: recovery.undelivered.length, replayedCount, msg: 'Boot recovery: response redelivery and message replay complete' });

        await journal.flush();
        logger.info({ msg: 'Boot recovery: journal flushed' });
    } finally {
        ingressGate.open(replayedIds);
        logger.info({ replayedCount: replayedIds.size, msg: 'Boot recovery: ingress gate opened' });
    }

    let catchUpSubmitted = false;
    if(unreadCount() > 0) {
        await submitCatchUp();
        catchUpSubmitted = true;
    }

    return { replayedCount, catchUpSubmitted };
}
