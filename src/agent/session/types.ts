/**
 * Shared types for the long-lived session core (src/agent/session/**).
 *
 * This module is the SOLE owner of `SessionRole`, `EnvelopeKind` (the full 10-member union
 * used by envelopes and the ledger), `EnvelopeOrigin`, `Envelope`/`EnvelopeMeta`, `TurnKind`, and
 * the `JournalEntry` discriminated union (plan amendment A1). Downstream packages (P4-P8) import
 * from here rather than redeclaring any of these.
 *
 * @module agent/session/types
 */
import type { Options, Query, SDKControlGetContextUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelId, PlatformImage, UserId } from '../types';

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
 * The full set of envelope kinds the ledger and conductor key off of. See {@link EnvelopeOrigin}
 * for the separate "is a human waiting on this" concept the ledger's `queued.human` and the
 * conductor's same-channel pre-emption actually key on.
 */
export type EnvelopeKind = 'discord' | 'perch' | 'notification' | 'catchup' | 'wrapup' | 'continuation' | 'compact' | 'boot' | 'task' | 'peer';

/** Every {@link EnvelopeKind} member, for table-driven tests that must stay exhaustive as the union grows. */
export const ENVELOPE_KINDS: readonly EnvelopeKind[] = ['discord', 'perch', 'notification', 'catchup', 'wrapup', 'continuation', 'compact', 'boot', 'task', 'peer'];

/**
 * Marks an envelope (and the turn/ledger accounting it feeds) as one a human is synchronously
 * waiting on, independent of {@link EnvelopeKind}: the ledger's `queued.human` count and the
 * conductor's same-channel pre-emption test `role === 'human'` rather than `kind === 'discord'`.
 * `platform` is a single-member union today; extend it the day a second human-facing platform
 * exists rather than overloading `role`.
 */
export interface EnvelopeOrigin {
    role:     'human'
    platform: 'discord'
}

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
    channelId?: ChannelId
    /** The submitting {@link Envelope.synopsisSeed}, carried through to `LedgerTurn.seed` so the presence synopsis attachment can seed a generation without reaching back for the envelope. */
    seed?:      string
    /** The submitting {@link Envelope.origin}, read by the ledger's `queued.human` accounting instead of `kind`. */
    origin?:    EnvelopeOrigin
    perch?: {
        slot:   string
        endsAt: Date
    }
}

/**
 * The fields every envelope carries, whatever its contract. Not an envelope on its own: every
 * envelope is exactly one of {@link QueryEnvelope}, {@link AccumulationEnvelope} or
 * {@link AdoptedPeerEnvelope}, told apart at runtime by `mode`.
 */
interface EnvelopeBase {
    id:            string
    text:          string
    /**
     * Widened to {@link PlatformImage} (rather than pre-encoded `string[]`) because
     * `toSdkUserMessage` (P6, ./envelope.ts) feeds this straight into
     * `buildMultimodalContent`, which needs each image's media type and base64 data — a plain
     * string array would force a lossy re-encoding step for no benefit.
     */
    images?:       PlatformImage[]
    createdAt:     Date
    /**
     * Header-free, capped (see `SYNOPSIS_SEED_CAP` in ./envelope.ts) content for the turn
     * synopsis generator, carried onto `LedgerTurn.seed` via {@link EnvelopeMeta.seed}.
     *
     * Deliberately NOT {@link text}: every stamped builder opens `text` with a `[KIND · stamp]`
     * header plus the time header plus the ambient quota lines, and the generator only reads the
     * first `SYNOPSIS_SEED_CAP` characters of what it is given (`./synopsis-generator.ts`
     * imports that same constant from ./envelope.ts rather than declaring a second cap of its
     * own) — seeding from `text` would feed Haiku nothing but chrome. Absent for `boot` (opens no turn at all) and `compact` (the text is the literal
     * `/compact`, and presence already renders the compacting marker from `Ledger.compaction`).
     */
    synopsisSeed?: string
}

/**
 * Source metadata an envelope of a kind that has none must not carry. Declared `?: never`
 * rather than left off, so code handling any {@link Envelope} can still read (and always gets
 * `undefined` from) the fields another variant owns.
 */
interface NoSource {
    channelId?: never
    authorId?:  never
    origin?:    never
    peer?:      never
}

/** A `discord` envelope: a human's message with a channel and human origin. Historical replay may omit the author ID. */
export interface DiscordQueryEnvelope extends EnvelopeBase {
    mode:      'query'
    kind:      'discord'
    channelId: ChannelId
    authorId?: UserId
    /** The human origin the ledger and conductor key off of; projected (not forwarded verbatim) onto the SDK's `SDKUserMessage.origin` by `toSdkUserMessage`. */
    origin:    EnvelopeOrigin
    peer?:     never
}

/**
 * A `task` envelope, synthesized when the conductor adopts an SDK wake (R2): its channel and
 * author come from the task's launch record, and are absent when none was found.
 */
export interface TaskQueryEnvelope extends EnvelopeBase {
    mode:       'query'
    kind:       'task'
    channelId?: ChannelId
    authorId?:  UserId
    origin?:    never
    peer?:      never
}

/** A host-originated envelope that opens a turn and carries no source metadata. */
export interface HostQueryEnvelope extends EnvelopeBase, NoSource {
    mode: 'query'
    kind: 'perch' | 'notification' | 'catchup' | 'wrapup' | 'continuation' | 'compact'
}

/**
 * An envelope that opens a turn: the only contract {@link import('./conductor').Conductor.submit}
 * accepts, sent to the SDK with `shouldQuery: true`. Deliberately excludes the adopted peer
 * record, which also once carried `shouldQuery: true` but must never be submitted.
 */
export type QueryEnvelope = DiscordQueryEnvelope | TaskQueryEnvelope | HostQueryEnvelope;

/**
 * An append-only envelope: sent to the SDK with `shouldQuery: false`, which appends it to the
 * transcript without an assistant turn and answers it with a bare, absorbed acknowledgement
 * `result`. The only contract {@link import('./conductor').Conductor.appendWithoutTurn}
 * accepts: the boot handshake, a non-waking notification, and a non-waking catch-up.
 */
export interface AccumulationEnvelope extends EnvelopeBase, NoSource {
    mode: 'append'
    kind: 'boot' | 'notification' | 'catchup'
}

/**
 * The host-side record of a turn the SDK already started from another Claude Code process's
 * `<cross-session-message>` prompt (session-peers block 2). Never submitted and never appended:
 * the only contract {@link import('./conductor').Conductor.adoptPeerTurn} accepts.
 */
export interface AdoptedPeerEnvelope extends EnvelopeBase {
    mode:       'adopted'
    kind:       'peer'
    /**
     * The sender of the `<cross-session-message>` prompt. `from` is the raw
     * `uds:/tmp/cc-socks/<pid>.sock` reply address (verified as a working `SendMessage` `to:`
     * target by the block-0 probe, 2026-09-09); `fromName` is the peer-registry name the tag
     * carried, absent when the tag named none.
     */
    peer:       { from: string, fromName?: string }
    channelId?: never
    authorId?:  never
    origin?:    never
}

/**
 * A unit of host-driven work for a session: exactly one of the three contracts, discriminated
 * by `mode`. Which one decides where it may go — {@link QueryEnvelope} to `submit()`,
 * {@link AccumulationEnvelope} to `appendWithoutTurn()`, {@link AdoptedPeerEnvelope} to
 * `adoptPeerTurn()` — so passing one to the wrong seam is a compile error rather than a runtime
 * throw. `notification` and `catchup` appear in two contracts: whether one wakes is decided at
 * build time, which is why `kind` alone is not the discriminant.
 */
export type Envelope = QueryEnvelope | AccumulationEnvelope | AdoptedPeerEnvelope;

/**
 * What a settled turn's reply delivery reads from its envelope. Wider than {@link Envelope} on
 * purpose: the perch conductor relabels an adopted `task` wake as `kind: 'perch'` so its reply
 * routes to the perch channel, while keeping whatever channel the task's launch record carried —
 * a pairing no envelope contract allows, and one delivery has no reason to forbid.
 */
export interface DeliverableEnvelope {
    id:         string
    kind:       EnvelopeKind
    text:       string
    channelId?: ChannelId
}

/**
 * The kind of turn a session is running, as recorded on the ledger and in journal entries.
 * Every envelope kind can open a turn of the same kind; a turn can also open spontaneously
 * (no envelope) as `'notification'` when the model speaks unprompted.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- deliberate distinct name: TurnKind names the ledger/journal's "kind of turn" concept (currently identical to EnvelopeKind because every envelope kind can open a same-kind turn), kept separate so a future turn-only kind does not force a rename at every EnvelopeKind call site
export type TurnKind = EnvelopeKind;

/**
 * How a session open ended up: a brand-new session (`fresh`), the requested transcript picked up
 * again (`resumed`), or a resume that was attempted and refused, so a fresh session was created in
 * its place (`resume_fallback`).
 */
export type SessionOpenOutcome = 'fresh' | 'resumed' | 'resume_fallback';

/**
 * Why a session open happened: the process starting up (`boot`), the live session going away
 * mid-life (`crash_reopen`), or the host asking for a controlled close-and-resume
 * (`requested_reopen`, following a `session_reopen_requested` row).
 */
export type SessionOpenCause = 'boot' | 'crash_reopen' | 'requested_reopen';

/** How a background task ended, as the ledger recorded it when the task left `ledger.tasks`. */
export type TaskFinishedOutcome = 'completed' | 'failed' | 'stopped';

/**
 * Append-only record of session lifecycle facts, written by the conductor to the
 * {@link https://en.wikipedia.org/wiki/Write-ahead_logging | write-ahead} journal so a crash
 * mid-turn can be replayed on restart. Every member carries `at: Date`.
 */
export type JournalEntry
    /** channelId identifies the requesting Discord channel, when the envelope came from one — carried so P8 crash recovery can attribute an undelivered response to its destination channel. */
    = | { type: 'envelope_submitted', at: Date, envelopeId: string, kind: EnvelopeKind, channelId?: string }
      /** channelId/messageIds identify where the response landed, for the P8 delivery guard's crash-recovery replay. */
      | { type: 'response_delivered', at: Date, envelopeId: string, channelId: string, messageIds: string[], disposition?: 'sent' | 'queued' }
      /** responseText (present when the host observed one) seeds P8 recovery's undelivered-envelope replay; `truncated` marks a text capped before storage. */
      | { type: 'turn_completed', at: Date, envelopeId: string, kind: EnvelopeKind, responseText?: string, truncated?: boolean }
      | { type: 'turn_failed', at: Date, envelopeId: string, kind: EnvelopeKind, error: string }
      | { type: 'task_started', at: Date, taskId: string, description: string }
      /** A task that left the ledger's running set, with the terminal status the ledger gave it; a later row for the same task records a late `task_notification` correcting that status, and the LAST row is its final outcome. `task_lost` (below) stays separate: loss is epistemic, not a fourth outcome. */
      | { type: 'task_finished', at: Date, taskId: string, description?: string, outcome: TaskFinishedOutcome }
      /**
       * Legacy pre-#61 journal rows: can be safely deleted after 2026-09-25. Read-only — written
       * by builds before `task_finished` existed, for every terminal task whatever its status, so
       * its outcome is unknown. Nothing writes it any more.
       */
      | { type: 'task_completed', at: Date, taskId: string, description?: string }
      | { type: 'task_lost', at: Date, taskId: string, description?: string }
      /**
       * A background-work launch (R2): recorded by the {@link
       * import('../hooks/task-launch').createTaskLaunchHooks} PostToolUse hook for an
       * Agent/Workflow/Bash-background launch made during a live turn, so the eventual
       * `<task-notification>` wake (see {@link import('./conductor').Conductor.adoptWakeTurn})
       * can synthesize an envelope back to the launching turn's channel/author. `kind` is the
       * launching turn's kind (a launch made from a `task`-kind turn — chained background work —
       * inherits that turn's channel/author).
       */
      | { type: 'task_launched', at: Date, taskId: string, toolUseId: string, toolName: string, envelopeId: string, kind: EnvelopeKind, channelId?: string, authorId?: string, description?: string }
      | { type: 'compaction_started', at: Date, trigger?: 'manual' | 'auto' }
      /** Metadata only: the summary itself is never persisted (see conductor.ts's module doc). */
      | { type: 'compaction_completed', at: Date }
      | { type: 'compaction_failed', at: Date, error: string }
      /**
       * Every writer sets `cause`. It is optional only because legacy pre-#61 journal rows
       * (`{ resumed, fallback? }`, normalised to `outcome` on read) never recorded one: can be
       * safely deleted after 2026-09-25 — make `cause` required then.
       */
      | { type: 'session_opened', at: Date, role: SessionRole, sessionId: string, outcome: SessionOpenOutcome, cause?: SessionOpenCause }
      /**
       * A controlled close-and-resume the host asked for — today, because the identity behind
       * this session's SDK `systemPrompt` changed, and the SDK fixes that prompt at `query()`
       * time. Journaled the moment the request is ACCEPTED, not when it runs, so a request
       * deferred behind a running turn is still visible if the process dies before the idle
       * point ever arrives. The `session_opened` row that follows it (if one does) is the
       * replacement session.
       */
      | { type: 'session_reopen_requested', at: Date, role: SessionRole, reason: string }
      /** The counterpart to session_opened, journaled by the P7 shutdown sequence. */
      | { type: 'session_ended', at: Date, sessionId: string }
      /** Journaled last, after session_ended, once the P7 shutdown sequence has flushed the journal. */
      | { type: 'shutdown', at: Date }
      /**
       * The Q3/B4 daily cost ceiling's day bucket, saved by {@link
       * import('./cost-ceiling-store').createCostCeilingStore} on every state-changing
       * `CostCeiling.record()`/rollover and replayed at boot (via `readSince`, taking the latest
       * one) so a restart neither loses today's spend nor silently un-pauses perch. Role-independent
       * — appended through whichever role's journal the composition root has in hand, since the
       * ceiling itself tracks spend across both conductors.
       */
      | { type: 'cost_ceiling_snapshot', at: Date, dateKey: string, totalUsd: number, paused: boolean };
