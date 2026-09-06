/**
 * The P10 boot sequence: everything a conductor-mode boot needs BEYOND what
 * {@link import('./conductor').Conductor.open} already does for a single session.
 *
 * `Conductor.open()` (P8/P9) already, on every boot: reads the journal window, computes
 * {@link import('./recovery').computeRecovery}, journals a `task_lost` entry for every task that
 * never reached a terminal state, seeds the delivery guard from every already-confirmed
 * `response_delivered` id, and — for the conversation conductor specifically
 * (`src/app/sessions.ts`) — injects the boot bundle via a SessionStart hook
 * (`createBootBundleHooks`), not via this module. So this module does NOT repeat any of that: it
 * does not recompute recovery, does not dispatch `task_lost`, and does not submit a second boot
 * envelope (which would double-inject the bundle the hook already delivered).
 *
 * What's left, run once after `open()` resolves and before ingress reopens:
 *  1. Deliver every undelivered envelope's response once, through the caller's `deliver`
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
import type { UndeliveredEnvelope } from './recovery';

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
    /** Submits the catch-up envelope. Called only when `unreadCount() > 0`. */
    submitCatchUp:   () => Promise<void>
    /** Current unread-message count, read after replay has been submitted. */
    unreadCount:     () => number
    ingressGate:     BootIngressGate
    journal:         BootJournal
}

/** What {@link runBootSequence} resolves with. */
export interface RunBootSequenceResult {
    /** How many messages `replayUnhandled()` returned (0 when nothing needed replaying). */
    replayedCount:    number
    /** Whether the catch-up envelope was submitted. */
    catchUpSubmitted: boolean
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
    const { recovery, deliver, replayUnhandled, submitReplay, submitCatchUp, unreadCount, ingressGate, journal } = params;

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

        await journal.flush();
    } finally {
        ingressGate.open(replayedIds);
    }

    let catchUpSubmitted = false;
    if(unreadCount() > 0) {
        await submitCatchUp();
        catchUpSubmitted = true;
    }

    return { replayedCount, catchUpSubmitted };
}
