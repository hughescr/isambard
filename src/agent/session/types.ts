/**
 * Shared types for the long-lived session core (src/agent/session/**).
 *
 * This module is the SOLE owner of `SessionRole`, `EnvelopeKind` (the full 8-member union
 * used by envelopes and the ledger), `Envelope`/`EnvelopeMeta`, `TurnKind`, and the
 * `JournalEntry` discriminated union (plan amendment A1). Downstream packages (P4-P8) import
 * from here rather than redeclaring any of these.
 *
 * @module agent/session/types
 */
import type { Options, Query, SDKControlGetContextUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PlatformImage } from '../types';

/** Which of the two concurrent sessions a piece of state belongs to. */
export type SessionRole = 'conversation' | 'perch';

declare const timerHandleBrand: unique symbol;

/**
 * Opaque handle returned by {@link Clock.setTimer}, passed back to {@link Clock.clearTimer}.
 * Deliberately not structurally compatible with anything else so callers cannot construct one
 * by hand or reach into it.
 */
export interface TimerHandle {
    readonly [timerHandleBrand]: never
}

/**
 * Time port for the session core. `systemClock` (./clock.ts) is the only real-timer
 * implementation allowed anywhere under src/agent/session/; tests inject a fake.
 */
export interface Clock {
    now:        () => number
    setTimer:   (fn: () => void, ms: number) => TimerHandle
    clearTimer: (handle: TimerHandle) => void
}

/** The subset of the SDK's context-usage response the session core needs. */
export type ContextUsageSummary = Pick<SDKControlGetContextUsageResponse, 'percentage' | 'totalTokens' | 'maxTokens'>;

/**
 * The subset of the real SDK `Query` the session core depends on, plus a narrowed
 * `getContextUsage`. A live `Query` stays assignable to this by return-type covariance
 * (`SDKControlGetContextUsageResponse` is a structural superset of `ContextUsageSummary`) and
 * because `Query extends AsyncGenerator<SDKMessage, void>`, which is itself an
 * `AsyncIterable<SDKMessage>`.
 */
export type SessionQuery = Pick<Query, 'interrupt' | 'close' | 'stopTask' | 'streamInput'> & {
    getContextUsage: (opts?: { detail?: 'summary' | 'full' }) => Promise<ContextUsageSummary>
} & AsyncIterable<SDKMessage>;

/** Factory shape matching the real SDK `query()` function, narrowed to `SessionQuery`. */
export type SessionQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>, options: Options }) => SessionQuery;

/**
 * The full set of envelope kinds the ledger and conductor key off of. `queued.human` in the
 * ledger keys on `kind === 'discord'`; every other kind increments `queued.other`.
 */
export type EnvelopeKind = 'discord' | 'perch' | 'notification' | 'catchup' | 'wrapup' | 'resume' | 'compact' | 'boot';

/** Every {@link EnvelopeKind} member, for table-driven tests that must stay exhaustive as the union grows. */
export const ENVELOPE_KINDS: readonly EnvelopeKind[] = ['discord', 'perch', 'notification', 'catchup', 'wrapup', 'resume', 'compact', 'boot'];

/**
 * The minimal envelope shape the ledger keys `turn_submitted` events on — distinct from
 * {@link Envelope} (the full domain type built by the P6 envelope builders): `queuedAt` is when
 * the envelope entered the queue, which the ledger subtracts from the first assistant frame's
 * timestamp to compute `latency.bySource`; `Envelope.createdAt` is not a substitute for it.
 */
export interface EnvelopeMeta {
    id:         string
    kind:       EnvelopeKind
    queuedAt:   Date
    channelId?: string
    perch?: {
        slot:   string
        endsAt: Date
    }
}

/** A unit of host-driven work submitted to a session's input queue. */
export interface Envelope {
    id:           string
    kind:         EnvelopeKind
    text:         string
    /**
     * Widened to {@link PlatformImage} (rather than pre-encoded `string[]`) because
     * `toSdkUserMessage` (P6, ./envelope.ts) feeds this straight into
     * `buildMultimodalContent`, which needs each image's media type and base64 data — a plain
     * string array would force a lossy re-encoding step for no benefit.
     */
    images?:      PlatformImage[]
    channelId?:   string
    authorId?:    string
    /** Present only for envelopes that originated from a human message (currently: discord). */
    origin?:      { kind: 'human' }
    /**
     * How the host queues/escalates this envelope: `'human'` interrupts promptly (a direct
     * message), `'wake'` escalates after a wait (perch, catch-up, resume, a waking
     * notification), `'accumulate'` queues silently with no escalation (boot, compact, a
     * non-waking notification). Renamed from the prior 2-way `priority` field (plan amendment
     * A1 extension) — confirmed unread by any consumer before the rename.
     */
    hostPriority: 'human' | 'wake' | 'accumulate'
    shouldQuery:  boolean
    createdAt:    Date
}

/**
 * The kind of turn a session is running, as recorded on the ledger and in journal entries.
 * Every envelope kind can open a turn of the same kind; a turn can also open spontaneously
 * (no envelope) as `'notification'` when the model speaks unprompted.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- deliberate distinct name: TurnKind names the ledger/journal's "kind of turn" concept (currently identical to EnvelopeKind because every envelope kind can open a same-kind turn), kept separate so a future turn-only kind does not force a rename at every EnvelopeKind call site
export type TurnKind = EnvelopeKind;

/**
 * Append-only record of session lifecycle facts, written by the conductor to the
 * {@link https://en.wikipedia.org/wiki/Write-ahead_logging | write-ahead} journal so a crash
 * mid-turn can be replayed on restart. Every member carries `at: Date`.
 */
export type JournalEntry
    = | { type: 'envelope_submitted', at: Date, envelopeId: string, kind: EnvelopeKind }
      | { type: 'response_delivered', at: Date, envelopeId: string }
      | { type: 'turn_completed', at: Date, envelopeId: string, kind: EnvelopeKind }
      | { type: 'turn_failed', at: Date, envelopeId: string, kind: EnvelopeKind, error: string }
      | { type: 'task_started', at: Date, taskId: string, description: string }
      | { type: 'task_completed', at: Date, taskId: string, description?: string }
      | { type: 'compaction_started', at: Date, trigger?: 'manual' | 'auto' }
      | { type: 'compaction_completed', at: Date }
      | { type: 'compaction_failed', at: Date, error: string }
      | { type: 'session_opened', at: Date, sessionId: string, fallback?: boolean };
