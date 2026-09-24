/**
 * The long-lived session conductor (design doc section 6): the only writer into a session's
 * {@link InputQueue}. Owns resume-or-fresh session opening, a host-side priority queue of
 * {@link Envelope}s, the one-turn-in-flight invariant, the human-wait/interrupt rows,
 * the host-driven `/compact` submission (via {@link CompactionGuard}), `is_error` retry per the
 * injected `retryPolicy`, and a bounded shutdown sequence. Every timing decision goes through the
 * injected {@link Clock} — this module never reads a real timer.
 *
 * The conductor is the sole writer of compaction ledger events (`compaction_started`,
 * `compaction_completed`, `compaction_failed`), and `Ledger.compaction` is the single "compacting"
 * authority. The guard reports its own `/compact` attempt and failures through the conductor's
 * lifecycle functions; the PreCompact/PostCompact hook sinks (built with the session's `Options`
 * in P9's `src/app/sessions.ts`) report through {@link Conductor.compactionStarted} and
 * {@link Conductor.compactionCompleted}, the latter also releasing the guard; and the conductor
 * completes a compaction itself when it observes a `compact_boundary` frame on its own stream.
 * The post-compaction boot-bundle hook belongs to whoever builds the session's `Options`. This module
 * pushes one opening `[BOOT]` handshake per query it creates (the SDK emits no frame until it has
 * read one), carrying the fresh or restart-resume boot bundle its injected `buildBootBundle`
 * builds for that attempt (#98: the SDK never fires a SessionStart callback for startup/resume in
 * a streaming-input session, anthropics/claude-agent-sdk-typescript#465), and drives the guard from every raw frame it observes,
 * which already covers every frame-observable release path (`compact_boundary`, the `/compact`
 * turn's own result, the `error-compacting-conversation` notification, and the clock ceiling).
 * Compaction summaries are deliberately NOT persisted anywhere (Craig, 2026-09-06): the summary
 * already lives in the transcript and the SDK transcript file, and a memory copy would be
 * embedded and pollute search. The journal keeps only the compaction's metadata.
 *
 * @module agent/session/conductor
 */
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import { classifyClaudeError } from '../claude-retry';
import { buildContinuationNote } from '../continuation-prompt-builder';
import { StreamTracker, type StreamProgress  } from '../stream-tracker';
import type { ChannelId, UserId } from '../types';
import type { BootKind } from './boot-bundle';
import { createCompactionGuard, type CompactionFailureReason, type CompactionGuard } from './compaction-guard';
import { createDeliveryGuard, type DeliveryGuard } from './delivery-guard';
import {
    buildBootEnvelope,
    buildCompactEnvelope,
    buildContinuationEnvelope,
    toSdkUserMessage,
    toSynopsisSeed
} from './envelope';
import { InputQueue } from './input-queue';
import { createInterruptFlag } from './interrupt-flag';
import { finishedTaskStatus, type Ledger, type LedgerEvent, type LedgerStore, type LedgerTask } from './ledger';
import type { SessionJournal, ResumeStore } from './ports';
import { computeRecovery } from './recovery';
import { echoedUserMessageUuids } from './result-echo';
import { resultFrameToError } from './result-frame-error';
import { openSession, type SessionHandle } from './session';
import type { TaskLaunchRegistry } from './task-launch-registry';
import type {
    AccumulationEnvelope,
    AdoptedPeerEnvelope,
    Clock,
    EnvelopeMeta,
    EnvelopeOrigin,
    QueryEnvelope,
    SessionOpenCause,
    SessionOpenOutcome,
    SessionQueryFn,
    SessionRole,
    TaskFinishedOutcome,
    TaskQueryEnvelope,
    TimerHandle,
    TurnKind
} from './types';
import type { SessionConfig } from '@/config';
import { InvariantViolationError } from '@/errors';
import type { ErrorClassification, RetryPolicy } from '@/utils';

type ResultFrame = Extract<SDKMessage, { type: 'result' }>;

/**
 * How far back {@link createConductor}'s boot-time recovery reads the journal (P8). Deliberately
 * much shorter than the journal's 30-day TTL retention: `readSince` pages the whole
 * `SESSION_JOURNAL#<role>` partition with no `Limit`, and the base table is provisioned at the
 * AWS-free-tier floor (5 RCU) — a 30-day window on a long-lived conductor session (several rows
 * per turn) would mean tens of thousands of rows read on every boot, saturating that capacity on
 * every restart. Recovery only actually needs facts from the crashed session's own lifetime (the
 * one journaled `session_opened` right before the crash) — 24 hours comfortably covers that for
 * any realistic outage, while an outage longer than 24 hours degrades to an empty-seeded recovery
 * (logged) rather than never starting the conductor at all (see {@link runBootRecovery}'s
 * try/catch).
 */
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long one {@link CreateConductorParams.buildBootBundle} call may take, on the injected
 * {@link Clock}, before the open goes ahead without it (#98). A fresh bundle's reads (hot state,
 * events, task list, channels; perch's context also does calendar, mail and Bluesky work) now sit
 * on the session-open path, and a slow read must cost a missing bundle, never a stuck open.
 *
 * This caps the delay the build ADDS to one open attempt. It does not make the whole open fit
 * inside the session supervisor's 30 s `CONDUCTOR_OPEN_TIMEOUT_MS` (`src/app/runtime.ts`):
 * `open()` also awaits boot recovery, the resume-store load, the CLI's own start-up and a resume-store write, and a boot resume that
 * fails pays for a second build before its fresh fallback. An open that was already slow can
 * still exceed that deadline (conversation then exits the process; perch is disabled). Losing the
 * race does not cancel the build's reads either; their late result is simply ignored.
 */
const BOOT_BUNDLE_BUILD_TIMEOUT_MS = 10_000;

/** The error `Conductor.open()` rejects with when shutdown began before its session could be kept (#98). */
function shutDownDuringOpenError(): Error {
    return new Error('Conductor is shutting down; the session was not opened');
}

/** Caps `turn_completed.responseText` (P8) so an unusually long assistant reply cannot bloat one journal row; `truncated: true` is set when the cap bit. */
const TURN_RESPONSE_TEXT_CAP = 200_000;

/**
 * How long a {@link Conductor.adoptWakeTurn}-signalled `pendingWake` (R2) stays eligible for
 * adoption before it is treated as stale and dropped. The real-SDK handshake this covers
 * (`<task-notification>` UserPromptSubmit -> fresh `system/init` -> the woken turn's own first
 * assistant frame) is normally sub-second, but that first frame can legitimately miss the
 * `onFrame` adoption window entirely — e.g. arriving while a PRIOR turn's `afterResult` is still
 * blocked inside `guard.onTurnEnd()` (`awaitingTurnEnd`), a race the module's spontaneous-turn
 * branch has no way to hold the wake open for. Without a TTL, that miss leaves `pendingWake` set
 * indefinitely, so the NEXT genuinely spontaneous notification turn — however much later —
 * misattributes its own reply to the original launch's channel/author. Generous enough (minutes,
 * not seconds) to tolerate real network/model-startup jitter in the legitimate handshake, while
 * still ruling out an unrelated turn hours or days afterward. Governs a pending PEER message
 * (session-peers block 2) on exactly the same terms and for exactly the same reason.
 */
const PENDING_WAKE_TTL_MS = 5 * 60 * 1000;

/**
 * How long a requested reopen keeps waiting after the last sign that a background task's result is
 * still on its way to the model (#97): a `task_notification` frame, a background task leaving the
 * running set for any reason other than loss, or a turn ending after either. The real SDK delivers
 * a finished task's result as a wake — the `task_notification` frame, then the
 * `<task-notification>` UserPromptSubmit hook, then `system/init`, then the woken turn's assistant
 * frames — and a task that finished mid-turn is only woken once that turn has ended. Closing the
 * session in any of those gaps loses the result, and a resumed CLI does not deliver it again.
 *
 * Once the hook has fired, the pending wake adoption itself holds the reopen (see
 * {@link Conductor.adoptWakeTurn}); this window only covers the gaps before the hook. It is a
 * best-effort quiet period, not a guarantee: the SDK promises an order, not a latency, so a wake
 * slower than this can still be lost. That is why it is generous next to the sub-second gaps seen
 * against the real SDK, and it never extends a wait past `reopenTaskWaitMs`. A timing fact of the
 * SDK like {@link PENDING_WAKE_TTL_MS}, not a policy knob, so it is a constant, not config.
 */
const REOPEN_WAKE_SETTLE_MS = 5000;

/**
 * How many unconsumed peer messages may wait for a spontaneous turn at once. A peer message only
 * becomes its own turn when the SDK serves the turn it started, so a burst from a chatty peer can
 * legitimately queue several; past this many the session is not keeping up and the OLDEST is
 * dropped with a warning, because holding an unbounded list of adoptions — each of which pins an
 * envelope and will eventually mislabel a turn — is worse than losing the least relevant one.
 * Generous relative to any real burst (the peer is a single other session, taking turns of its
 * own), so hitting it is a signal, not routine.
 */
const PENDING_PEER_QUEUE_MAX = 8;

/**
 * The id a bare (envelope-less) notification turn is known by, in BOTH the conductor's
 * `currentTurn` and the ledger's turn. One expression so the two can never drift: the ledger
 * matches every `turn_synopsis` against the LEDGER's id, and a mismatch is a silent drop —
 * `turnIdFor` reporting the literal `'notification'` while the ledger held `notification-<ms>`
 * is exactly how spontaneous turns lost their synopsis before.
 * @param at The instant the turn opened
 * @returns The turn id
 */
function bareNotificationTurnId(at: Date): string {
    return `notification-${at.getTime()}`;
}

/**
 * True only for an assistant frame emitted by the root session. The SDK sets
 * `parent_tool_use_id` to the launching tool id on every subagent assistant frame; those frames
 * remain observable but cannot start or adopt the root session's turn.
 */
function isRootAssistantFrame(frame: SDKMessage): boolean {
    return frame.type === 'assistant' && frame.parent_tool_use_id === null;
}

/**
 * One adoption waiting to be attached to the next spontaneous assistant frame: a background-work
 * wake (R2) or a peer message (session-peers block 2).
 *
 * They share ONE queue, consumed strictly oldest-first, because the SDK serves the turns it starts
 * in arrival order and the host has no way to tell which turn a given assistant frame belongs to
 * beyond that ordering. Preferring one kind over the other — as an earlier version preferred a
 * peer over a wake — mislabels BOTH turns whenever the other kind arrived first: the wake's turn
 * is journalled as a peer and, worse, never runs `buildWakeSettledDeferred`, so the background
 * work's result is silently never delivered to the channel that asked for it.
 */
interface PendingWakeAdoption {
    kind:  'wake'
    wake:  { taskId: string, toolUseId: string, summary: string }
    setAt: number
}

interface PendingPeerAdoption {
    kind:     'peer'
    envelope: AdoptedPeerEnvelope
    setAt:    number
}

type PendingAdoption = PendingWakeAdoption | PendingPeerAdoption;

/** Priority the host queues an envelope at: `'urgent'` before `'normal'` (design section 6). */
export type SubmitPriority = 'urgent' | 'normal';

/** Options accepted by {@link Conductor.submit}. */
export interface SubmitOptions {
    priority:             SubmitPriority
    requestingChannelId?: ChannelId
    /**
     * Ties this submission to the caller's abort contract (P9, design section 6): aborting while
     * the envelope is still held host-side (queued behind another turn) withdraws it — `submit()`
     * resolves `{ status: 'withdrawn', cancellationSource: 'caller_signal' }` and nothing ever
     * reaches the SDK; aborting while this envelope's own turn is already running interrupts it,
     * scoped to `requestingChannelId` like {@link Conductor.interruptCurrent}, and resolves
     * `{ status: 'interrupted', cancellationSource: 'caller_signal' }` (unless another source had
     * already interrupted that turn — the first source wins); aborting while a DIFFERENT
     * channel's turn is running never interrupts that turn — this envelope is still only queued,
     * so it is withdrawn like any other held envelope.
     */
    signal?:              AbortSignal
}

/** Options accepted by {@link Conductor.interruptCurrent}. */
export interface InterruptCurrentOptions {
    requestingChannelId?: ChannelId
    reason?:              string
}

/** Options accepted by {@link Conductor.shutdown}. */
export interface ShutdownOptions {
    turnWaitMs: number
    deadlineMs: number
}

/**
 * What asked for a running turn to be interrupted (or, for `'caller_signal'` only, for a queued
 * envelope to be withdrawn). When several sources ask for the same turn, the first one wins.
 *
 * - `'caller_signal'` — the submitter's own {@link SubmitOptions.signal} aborted.
 * - `'human_preempt'` — a `'human'`-priority envelope arrived for the channel whose Discord turn
 *   is running.
 * - `'human_wait'` — a human envelope waited behind a background turn past
 *   `humanWaitTargetMs` (or, while a tool was still pending, `humanWaitCeilingMs`).
 * - `'compaction_ceiling'` — a `/compact` turn outlived the compaction guard's ceiling.
 * - `'interrupt_current'` — an explicit {@link Conductor.interruptCurrent} call.
 * - `'shutdown'` — {@link Conductor.shutdown}'s `turnWaitMs` elapsed with the turn still running;
 *   also used when shutdown's hard deadline closed the session on a running turn before any
 *   interrupt was sent (#120).
 */
export type CancellationSource = 'caller_signal' | 'human_preempt' | 'human_wait' | 'compaction_ceiling' | 'interrupt_current' | 'shutdown';

/** The fields every {@link TurnResult} arm carries. */
interface TurnResultBase {
    envelopeId:          string
    sessionId:           string | undefined
    /**
     * The context-usage percentage most recently known to the conductor's ledger at the moment
     * this turn settled (design 3.3/P9: 'every result logs the getContextUsage percentage'). This
     * is the value as of the END of the PREVIOUS turn's {@link CompactionGuard.onTurnEnd} poll,
     * not a fresh poll for this specific turn: that poll always runs after this result has
     * already settled (see `afterResult`), so fetching a same-turn value here would delay every
     * `submit()` resolution on an extra SDK round trip. `0` before any turn has ever completed.
     */
    contextUsagePercent: number
}

/** The `status`-discriminated part of a {@link TurnResult}. */
type TurnResultArm
    = | { status: 'completed', response: string }
      | { status: 'failed', response: null, error: Error }
      | { status: 'interrupted', response: null, partialWork: StreamProgress, cancellationSource: CancellationSource }
      | { status: 'withdrawn', response: null, cancellationSource: 'caller_signal' };

/**
 * How one submitted turn ended, resolved by {@link Conductor.submit}, discriminated on `status`:
 *
 * - `'completed'` — the SDK returned a successful result; `response` is its final text.
 * - `'failed'` — an error result that was not (or could no longer be) retried, or a non-success
 *   result the SDK did not flag `is_error`; `error` describes it.
 * - `'interrupted'` — the turn reached the SDK and was interrupted, or was cut off when
 *   {@link Conductor.shutdown} closed its session before its result frame arrived (#120);
 *   `cancellationSource` says who asked. An interrupted turn never carries a reply.
 * - `'withdrawn'` — the envelope was still held host-side when the caller's signal aborted, so
 *   it never reached the SDK and has no partial work.
 *
 * Every arm keeps `response`, so a reader that only wants "the reply, if any" can read it
 * without switching on `status`.
 */
export type TurnResult = TurnResultBase & TurnResultArm;

/**
 * The conductor's lifecycle, as reported by {@link ConductorStatus.lifecycle}. Reuses
 * `session.ts`'s per-handle `SessionState` words where the meanings coincide, and adds the
 * conductor-only states: `'new'` (never opened), `'reopening'` (replacing a session that went
 * away) and `'closing'` (shutdown in progress). See {@link lifecycleAcceptsWork}.
 */
export type ConductorLifecycle = 'new' | 'opening' | 'open' | 'reopening' | 'failed' | 'closing' | 'closed';

/**
 * The single definition of "this conductor can own and buffer work": `'open'`, or `'reopening'`
 * (work is held until the replacement session opens).
 */
export function lifecycleAcceptsWork(lifecycle: ConductorLifecycle): boolean {
    return lifecycle === 'open' || lifecycle === 'reopening';
}

/** A snapshot of the conductor's current state, returned by {@link Conductor.status}. */
export interface ConductorStatus {
    role:         SessionRole
    sessionId:    string | undefined
    /** Where the conductor is in its lifecycle — see {@link ConductorLifecycle} and `Conductor.status`'s projection. */
    lifecycle:    ConductorLifecycle
    /** @deprecated Use `lifecycle` (with {@link lifecycleAcceptsWork}); derived from it as `lifecycle === 'open' || lifecycle === 'reopening'`. */
    opened:       boolean
    /** @deprecated Use `lifecycle`; derived from it as `lifecycle === 'closing' || lifecycle === 'closed'`. */
    shuttingDown: boolean
    queueLength:  number
    turn: {
        kind:        TurnKind
        channelId?:  ChannelId
        envelopeId?: string
        /** The turn's originating envelope author (R2) — `undefined` for a bare spontaneous `notification` turn, or a `task` turn whose {@link CreateConductorParams.taskLaunches} lookup found no launch record. */
        authorId?:   UserId
    } | null
}

/** What {@link CreateConductorParams.buildBootBundle} is asked to build for one open attempt (#98). */
export interface BootBundleRequest {
    /** `restart_resume` only for a boot open resuming a stored session; every other built attempt starts a new transcript. */
    kind:        Extract<BootKind, 'fresh' | 'restart_resume'>
    /** Why this open is happening — `boot`, or the in-process reopen whose resume failed. */
    cause:       SessionOpenCause
    /** Boot-time crash recovery's lost background tasks; always `[]` for a reopen. */
    lostTasks:   string[]
    /** Boot-time crash recovery's envelopes with no delivered response; always `[]` for a reopen. */
    undelivered: string[]
}

/** Dependencies and configuration for {@link createConductor}. */
export interface CreateConductorParams {
    role:                      SessionRole
    queryFn:                   SessionQueryFn
    /**
     * Builds full Agent SDK `Options` for a fresh (`undefined`) or resumed (session id) open, once
     * per query. `cause` is why this query is being opened — `boot` from {@link Conductor.open},
     * `crash_reopen`/`requested_reopen` from an in-process reopen — including the fresh fallback
     * after a failed resume, which keeps its attempt's cause. Anything built from it (the
     * conversation's compaction boot-bundle hook, in `src/app/sessions.ts`) is bound to that one
     * query, so a later query can never change what an earlier one's hooks see.
     */
    buildOptions:              (resume: string | undefined, cause: SessionOpenCause) => Options
    clock:                     Clock
    /** Reads the process's current resident set size, in bytes. */
    readRss:                   () => number
    ledgerStore:               LedgerStore
    config:                    SessionConfig
    /** `config.retry.claude` — drives `is_error` resubmission, on the injected `clock`. */
    retryPolicy:               RetryPolicy
    journal:                   SessionJournal
    resumeStore:               ResumeStore
    /**
     * Builds the boot bundle carried by the opening `[BOOT]` handshake (#98). The real SDK never
     * invokes an SDK-callback SessionStart hook for `startup` or `resume` in a streaming-input
     * session (anthropics/claude-agent-sdk-typescript#465), but it reliably delivers this first
     * message, so this is the only path by which a fresh or restart-resume bundle reaches the model.
     *
     * Called once per open attempt, just before that attempt's query is created, on the injected
     * clock's {@link BOOT_BUNDLE_BUILD_TIMEOUT_MS} bound:
     *  - `restart_resume`/`boot` before {@link Conductor.open} resumes a stored session;
     *  - `fresh`/`boot` before a fresh boot open, or the fresh fallback after that resume failed;
     *  - `fresh` with the reopen's own cause before an in-process reopen's fresh fallback, with
     *    empty recovery lists (the reopen handshake already names what the reopen cut off).
     * Never called for an in-process reopen whose resume succeeds: that transcript survived, and
     * the #62 reopen handshake alone is pushed.
     *
     * `lostTasks`/`undelivered` are the descriptions from this process's boot-time crash recovery
     * (P8), the same shape P6's boot-bundle builder input takes. An empty result, a rejection or a
     * timeout pushes the bare `[BOOT]` marker instead (a failure goes through
     * {@link renderBootBundleFallback} first).
     */
    buildBootBundle?:          (input: BootBundleRequest) => string | Promise<string>
    /**
     * Renders a small, synchronous, I/O-free boot bundle from the request alone, used only when
     * {@link buildBootBundle} rejects or times out, so recovery the conductor has already journaled
     * as `task_lost` (and will therefore never report again) still reaches the model. `''` (or
     * omitting this) falls back to the bare `[BOOT]` marker. Must not throw.
     */
    renderBootBundleFallback?: (input: BootBundleRequest) => string
    logger:                    Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
    /** Observes every raw frame alongside {@link Conductor.subscribeTurn} subscribers. */
    onTurnFrame?:              (turnId: string, frame: SDKMessage) => void
    /** Classifies an `is_error` result's adapted error. Defaults to `classifyClaudeError`. */
    classifyError?:            (error: unknown) => ErrorClassification
    /**
     * Resolves the launch record for an adopted wake turn (R2) — see
     * {@link Conductor.adoptWakeTurn}. `undefined` (the default) when no launch registry is
     * wired; the adopted turn then carries no channelId/authorId.
     */
    taskLaunches?:             Pick<TaskLaunchRegistry, 'lookup' | 'forget'>
    /**
     * Called once an adopted wake turn (R2) settles, with the synthesized `task`-kind envelope
     * and its {@link TurnResult} — the composition root's hook for delivering that reply to its
     * origin channel (or a fallback, for a turn with no channel). A rejection is caught and
     * logged; it never affects the conductor or any other caller.
     */
    onWakeTurnSettled?:        (envelope: TaskQueryEnvelope, result: TurnResult) => void | Promise<void>
}

/** A caller's delivery result, distinguishing durable delivery from intentional non-delivery. */
export type SendOutcome
    = | { kind: 'committed', disposition: 'sent', channelId: ChannelId, messageIds: string[] }
      | { kind: 'committed', disposition: 'queued', channelId: ChannelId, outboxIds: string[] }
      | { kind: 'skipped', reason: string };

/** The outcome of a {@link Conductor.deliver} call. */
export interface DeliverResult {
    outcome:      'committed' | 'skipped' | 'already-committed'
    disposition?: 'sent' | 'queued'
}

/** The long-lived session conductor returned by {@link createConductor}. */
export interface Conductor {
    open:                          () => Promise<{ sessionId: string, resumed: boolean }>
    /** Opens a turn, so it takes only a {@link QueryEnvelope}: an {@link AccumulationEnvelope} belongs on {@link Conductor.appendWithoutTurn}, and an {@link AdoptedPeerEnvelope} on {@link Conductor.adoptPeerTurn} — the SDK already started that turn. */
    submit:                        (envelope: QueryEnvelope, options: SubmitOptions) => Promise<TurnResult>
    /**
     * Pushes `envelope` onto the live SDK queue without opening a turn — mirrors the private
     * boot-bundle push (`pushBootBundle`). Returns `true` once the envelope is the conductor's
     * responsibility — either queued on the live session, or held in the reopen buffer while a
     * session is being replaced — and `false` when it could not be accepted at all (no queue yet,
     * because `open()` has not assigned one, or the conductor is shutting down). Callers with
     * their own "already reported" memory (see `notification-bridge.ts`) key off that boolean:
     * burning a dedupe key on a `false` would lose the notification permanently. Never reads or writes
     * {@link ConductorStatus.turn} and never calls `beginTurn`/`processQueue`: this is the
     * accumulate-only seam for {@link AccumulationEnvelope}s (sent `shouldQuery:false`), which the SDK appends to the
     * transcript without an assistant turn. It does answer each one with its own bare `result`
     * frame (`num_turns: 0`, `result: ""` — SDK 0.3.280, verified 2026-09-22), which can arrive
     * after the CLI has read the next querying message; the session's {@link InputQueue} claims
     * it by its echoed wire uuid so it never settles a turn. Routing one through `submit()`
     * instead would open a turn that bare result settles with an empty reply — which is why the
     * two seams take disjoint envelope contracts.
     */
    appendWithoutTurn:             (envelope: AccumulationEnvelope) => boolean
    /**
     * Asks for a controlled close-and-resume of the live session.
     *
     * This is the only way to change an SDK `systemPrompt`, which is fixed at `query()` time: the
     * host rebuilds the prompt (today, because the identity behind it changed) and calls this, and
     * the conductor closes the current handle and reopens it with `resume` and freshly built
     * options. The reopen runs at the next idle point — no turn running, and no turn-end
     * compaction check still outstanding — once the old session's background work is done (#97):
     * no background task still running, no SDK-started wake or peer turn still pending adoption,
     * and no task finished within the last few seconds (its result may still be on its way; see
     * `REOPEN_WAKE_SETTLE_MS`). Closing the session would kill that work or lose its result. The
     * wait for background work is bounded by `config.reopenTaskWaitMs` from the first request
     * still pending (a later request does not extend it); when it runs out the reopen goes ahead
     * anyway, and the reopen handshake names the tasks still running. The drain is best effort:
     * it cannot promise that every result was delivered. Until the reopen has run NO new queued
     * turn is started (the SDK's own wake turns still run), so the queue waits at most for the
     * turn in flight plus that bound, never for however long it stays busy. Queued envelopes are
     * never dropped: they replay on the replacement session, as do appended envelopes the dying
     * session never read.
     *
     * Recorded rather than discarded when an open or another reopen is already in flight, so an
     * identity change landing in either window is applied afterwards instead of lost — unless
     * that open already built its options from the new prompt, in which case the request is
     * dropped as already satisfied. A no-op only once {@link Conductor.shutdown} has begun.
     *
     * @param reason Short human phrase for the journal, log and boot handshake (e.g. `'an
     *   identity change'`).
     */
    requestReopen:                 (reason: string) => void
    /**
     * Adopts a pending wake turn synthesized from background work finishing (R2): the NEXT
     * spontaneous assistant frame — the one the SDK's own `<task-notification>` wake produces —
     * opens a real `task`-kind turn instead of falling through to the bare `notification`
     * fallback. The turn's response text is `input.summary`; when
     * {@link CreateConductorParams.taskLaunches} resolves a launch record for
     * `{ input.taskId, input.toolUseId }`, that record's `channelId`/`authorId` seed the
     * synthesized envelope, so the reply reaches the channel and author that launched the work,
     * exactly like an ordinary turn. A second call before the first pending wake is consumed
     * overwrites it and logs a warning — only the most recent call's wake is ever adopted.
     *
     * A crash while the adopted turn runs does not re-send it (the model already read the
     * notification): it settles as failed — so the wake delivery sends nothing — and the reopen
     * handshake tells the model the turn was cut off (#99).
     */
    adoptWakeTurn:                 (input: { taskId: string, toolUseId: string, summary: string }) => void
    /**
     * Adopts a pending peer-message turn (session-peers block 2): the NEXT spontaneous assistant
     * frame — the one the SDK's own `<cross-session-message>` delivery produces — opens a real
     * `peer`-kind turn carrying `envelope` instead of falling through to the bare `notification`
     * fallback. Takes an already-built {@link AdoptedPeerEnvelope} (see {@link
     * import('./envelope').buildPeerEnvelope}) rather than the raw `{ from, fromName, text }`
     * triple because the rendering needs a timezone and a time header, neither of which the
     * conductor has — the same division of labour `createNotificationBridge` already uses for
     * `buildNotificationEnvelope`.
     *
     * Nothing is ever pushed to the SDK queue for this turn, for the same reason
     * {@link Conductor.adoptWakeTurn}'s is not: the SDK already started it from the peer's raw
     * prompt. Unlike a wake, an adopted peer turn has no host-side delivery at all — Claude
     * answers a peer by calling `SendMessage` itself, which the envelope's own text instructs.
     * Nor is it re-sent after a crash: it settles as failed, and the reopen handshake names the
     * peer whose message the crash cut off (#99).
     *
     * A peer message that lands while this session is ALREADY mid-turn never reaches here at
     * all: the SDK folds it into the running turn and fires no `UserPromptSubmit` hook (block-0
     * probe P3, 2026-09-09), so no new turn exists for the host to adopt and nothing is recorded
     * — deliberately, rather than reconstructing one from the undeclared `command_lifecycle`
     * frame, which carries neither the sender nor the text and is also emitted for the host's own
     * {@link Conductor.appendWithoutTurn} pushes. A second call before the first pending peer
     * message is consumed overwrites it and logs a warning.
     */
    adoptPeerTurn:                 (envelope: AdoptedPeerEnvelope) => void
    /**
     * Delivers `envelopeId`'s response, deduplicated against confirmed prior deliveries (P8): if
     * the delivery guard already knows this id, `send` is skipped entirely. A committed outcome
     * is journaled and flushed before the delivery guard is marked; a skipped outcome is logged
     * at info and intentionally leaves no durable delivery record so a later response can still
     * be delivered. This is at-least-once, not exactly-once: `send` runs before the journal
     * append/flush that marks delivery, so a crash in that window can still cause a redelivery on
     * the next restart (see "Session journal" in `docs/architecture.md`).
     */
    deliver:                       (envelopeId: string, send: () => Promise<SendOutcome>) => Promise<DeliverResult>
    interruptCurrent:              (options?: InterruptCurrentOptions) => Promise<void>
    subscribeTurn:                 (handler: (turnId: string, frame: SDKMessage) => void) => () => void
    /** A snapshot of the conductor's state; its `lifecycle` is a projection with a fixed precedence (see `currentLifecycle` in `createConductor`). */
    status:                        () => ConductorStatus
    /**
     * Ends the conductor for good; a second call while one is running is a no-op. Rejects every
     * submit still queued, waits up to `turnWaitMs` for a running turn to finish and then
     * interrupts it, journals `session_ended`/`shutdown` and flushes, and closes the session
     * handle — all bounded by `deadlineMs`, after which it closes regardless. A turn still running
     * at the close resolves `status: 'interrupted'` with the source that first asked for an
     * interrupt, or `'shutdown'` (#120); frames the closed handle still forwards are ignored.
     */
    shutdown:                      (options: ShutdownOptions) => Promise<void>
    /** The compaction guard's live threshold percentage — see {@link CompactionGuard.getThresholdPercent}. */
    getCompactionThresholdPercent: () => number
    /** Changes the compaction guard's live threshold percentage — see {@link CompactionGuard.setThresholdPercent}. */
    setCompactionThresholdPercent: (percent: number) => void
    /**
     * The PreCompact hook announced a compaction. Moves the ledger to `'compacting'` (holding the
     * queue until it ends); a no-op while one is already in progress — the conductor is the
     * single producer of `compaction_started`, whichever of the guard or the hook reports first.
     */
    compactionStarted:             (trigger?: 'manual' | 'auto') => void
    /**
     * The PostCompact hook reported a compaction finished. Releases the compaction guard as a
     * success and ends the compaction on the ledger (journaling `compaction_completed` and
     * releasing held submits). Idempotent with the conductor's own `compact_boundary`
     * observation: whichever arrives second is a no-op.
     */
    compactionCompleted:           () => void
}

/** How a caller's `submit()` promise is settled once its turn is resolved one way or another. */
interface Deferred {
    resolve: (result: TurnResult) => void
    reject:  (error: unknown) => void
}

/** One envelope waiting in the host-side priority queue, or already promoted to the active turn. */
interface QueuedItem {
    /**
     * A submitted, compaction or continuation envelope, or the synthesized/adopted envelope of a turn
     * the SDK started itself (a `task` wake, an adopted peer). An adopted item is seeded at
     * `retryPolicy.maxAttempts`, so it never retries through {@link beginTurn}, and a crash
     * reopen never re-queues it either (#99): it settles as failed and the reopen handshake
     * names it. So an adopted item is never pushed to the SDK.
     */
    envelope:               QueryEnvelope | AdoptedPeerEnvelope
    priority:               SubmitPriority
    requestingChannelId?:   ChannelId
    attempts:               number
    deferred:               Deferred
    /** Removes this item's `abort` listener from the caller's {@link SubmitOptions.signal}, when one was given. Set by `submit()`, cleared once run so it fires at most once per item — including across retries, which reuse the same `QueuedItem`. */
    abortCleanup?:          () => void
    /**
     * True once `handleSubmitAbort` withdrew this item while it was neither the running turn nor
     * in `pendingQueue` — i.e. waiting out a `scheduleRetry` backoff timer between attempts.
     * `submit()`'s abort contract withdraws an envelope that is merely "held" regardless of why
     * it's held, but the backoff window has no queue entry to remove it from, so the item's own
     * `deferred` is resolved immediately here and this flag tells {@link routeIncoming} (the
     * retry timer's eventual callback) to drop the item instead of resubmitting a stale envelope
     * whose caller has already been told it was withdrawn.
     */
    withdrawnWhileWaiting?: boolean
}

/** The one turn currently running against the session, if any. */
interface ActiveTurn {
    /**
     * This turn's identity, minted here and reported by {@link turnIdFor} to every
     * `subscribeTurn` subscriber: the submitting envelope's id, or a synthesized
     * `notification-<ms>` for a bare spontaneous turn. The same id is dispatched to the ledger
     * (`turn_submitted`, or `spontaneous_turn_opened`) BEFORE subscribers are notified, so a
     * subscriber that keys off `ledger.turn.id` — the presence synopsis attachment — is already
     * live for this turn's first frame.
     */
    id:               string
    /** `undefined` for a spontaneous SDK-initiated turn nobody submitted. */
    item?:            QueuedItem
    kind:             TurnKind
    channelId?:       ChannelId
    /** The turn's originating envelope author (R2) — see {@link ConductorStatus.turn}. */
    authorId?:        UserId
    /** The turn's originating envelope origin, read by {@link routeIncoming}'s same-channel pre-emption instead of `kind`. */
    origin?:          EnvelopeOrigin
    tracker:          StreamTracker
    /** Who first asked for this turn to be interrupted; `undefined` while nobody has. Set once by {@link interruptCurrentTurnInternal}. */
    interruptSource?: CancellationSource
    escalationArmed:  boolean
    escalationTimer?: TimerHandle
    /**
     * The wire uuid {@link InputQueue.push} stamped on this turn's user message — set only for a
     * turn the host pushed (`beginTurn`); `undefined` for an adopted wake/peer turn or a
     * spontaneous one, which the CLI started itself. A `result` frame whose echo is non-empty
     * but does not name it answers some other message and must not settle this turn.
     */
    wireUuid?:        string
}

/**
 * The error an SDK-started (adopted) turn settles with when a crash cuts it off (#99). Such a
 * turn is never re-sent to the replacement session — the model already read its input — so it
 * ends here, and the reopen handshake names it instead (see {@link CutOffAdoptedTurn}).
 */
const ADOPTED_TURN_CUT_OFF_ERROR = 'The session process ended during this SDK-started turn; it is not re-sent to the replacement session';

/** How the reopen handshake names a cut-off adopted turn's input: the peer session it came from, or a background-task notification (an adopted wake). */
function describeAdoptedTurn(envelope: QueryEnvelope | AdoptedPeerEnvelope): string {
    if(envelope.mode === 'adopted') {
        return `a message from peer session ${envelope.peer.fromName ?? envelope.peer.from}`;
    }
    return 'a background-task notification';
}

/** An adopted turn a crash cut off (#99), as {@link ReopenHandshake} names it: `description` from {@link describeAdoptedTurn}, and the input `text` a fresh-fallback transcript never saw. */
interface CutOffAdoptedTurn {
    description: string
    text:        string
}

/**
 * The reopen handshake's paragraph for a cut-off adopted turn (#99). A resumed transcript already
 * holds the turn's input, so it is only pointed at; a fresh-fallback transcript never saw it, so
 * it is quoted line by line.
 */
function cutOffTurnParagraph({ description, text }: CutOffAdoptedTurn, resumed: boolean): string {
    const opening = `Your turn answering ${description} was cut off when the previous session process ended`;
    const pickUp = 'If it still needs a response, pick it up at your next turn.';
    if(resumed) {
        return `${opening}. It will not be sent to you again: that input is already in the transcript above. ${pickUp}`;
    }
    const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
    return `${opening}, and this new transcript does not contain it. It will not be sent to you again as a new message; here is what it said:\n${quoted}\n${pickUp}`;
}

/** What a reopen's `[BOOT]` handshake says — rendered per attempt by `reopenHandshakeText`. `cutOffTurn` is set only by a crash reopen that interrupted an adopted turn. */
interface ReopenHandshake {
    why:             string
    backgroundTasks: string[]
    cutOffTurn?:     CutOffAdoptedTurn
}

/** A no-op {@link Deferred} for envelopes the conductor submits to itself (`/compact`, a continuation note). */
function internalDeferred(): Deferred {
    return { resolve: () => undefined, reject: () => undefined };
}

/** Normalises an unknown thrown/rejected value to an `Error`: passes an `Error` through, wraps a non-empty string, and falls back to `fallbackMessage` for anything else (`undefined`, or an object with no reliable string form). */
function toError(error: unknown, fallbackMessage: string): Error {
    if(error instanceof Error) {
        return error;
    }
    if(typeof error === 'string' && error !== '') {
        return new Error(error);
    }
    return new Error(fallbackMessage);
}

/** `baseDelayMs * backoffMultiplier ^ (attemptNumber - 1)`, capped at `maxDelayMs`. No jitter — determinism for the injected clock beats a few percent of thundering-herd protection here. */
function computeBackoffDelayMs(policy: RetryPolicy, attemptNumber: number): number {
    const raw = policy.baseDelayMs * policy.backoffMultiplier ** (attemptNumber - 1);
    return Math.min(raw, policy.maxDelayMs);
}

/**
 * True for turn kinds that open with no live human waiting synchronously for them: a spontaneous
 * SDK-initiated turn nobody submitted (`'notification'`), an adopted background-work wake turn
 * (`'task'`, R2), or an adopted peer-message turn (`'peer'`, session-peers block 2 — the peer
 * waiting on the reply is Izzy's other session, not Craig). Human pre-emption and escalation
 * (`routeIncoming`) and interrupted-turn continuation-note injection
 * (`injectContinuationNoteIfInterruptedBackgroundTurn`) treat all three identically — enqueue behind
 * them and arm the human-wait escalation, rather than interrupting immediately the way a
 * same-channel human turn is.
 */
function isBackgroundKind(kind: TurnKind): boolean {
    return kind === 'notification' || kind === 'task' || kind === 'peer';
}

/** `ledger.finishedTasks` keyed by task id, the LATEST record winning for a reused id (as {@link finishedTaskStatus} reads it). */
function latestFinishedTasks(ledger: Ledger): Map<string, LedgerTask> {
    return new Map(ledger.finishedTasks.map(task => [task.id, task] as const));
}

/**
 * Creates a long-lived session conductor.
 * @param params See {@link CreateConductorParams}.
 * @returns A {@link Conductor}.
 */
export function createConductor(params: CreateConductorParams): Conductor {
    const {
        role, queryFn, buildOptions, clock, readRss, ledgerStore, config, retryPolicy,
        journal, resumeStore, buildBootBundle, renderBootBundleFallback, logger, onTurnFrame, taskLaunches, onWakeTurnSettled,
    } = params;
    const classifyError = params.classifyError ?? classifyClaudeError;

    let opened = false;
    let shuttingDown = false;
    /**
     * Where the boot path last stood, for {@link currentLifecycle}: `'new'` before any
     * {@link open} call, `'opening'` from the start of one, `'failed'` once one rejected or a
     * reopen gave up. Deliberately not advanced to `'open'` when {@link open} succeeds: it is
     * reported only while no session handle is current, and a successful open always leaves one.
     */
    let bootPhase: Extract<ConductorLifecycle, 'new' | 'opening' | 'failed'> = 'new';
    /** True once {@link shutdown} has made its final close. */
    let closed = false;
    /** Populated once by {@link runBootRecovery} at the start of {@link open}; guards {@link deliver} against re-sending an envelope a prior process already delivered. */
    let deliveryGuard: DeliveryGuard | undefined;
    /** True from the moment a mid-life close is observed until a replacement session (resumed or fresh) has opened — or reopening has been given up on entirely, or `shutdown()` overtook the reopen, in which case it is simply left set (every reader tests {@link shuttingDown} first). Gates {@link processQueue}, {@link submitCompact} and {@link appendWithoutTurn} so no envelope is ever pushed into the dead handle's orphaned {@link InputQueue} while a reopen is in flight. */
    let reopening = false;
    /**
     * Monotonic count of `buildOptions()` calls — i.e. of queries this conductor has created. A
     * requested reopen is redundant once this has moved past the value captured when it was
     * requested, because some query has by then already been created from options built AFTER the
     * request, and therefore already carries whatever the request wanted applied.
     */
    // Stryker disable next-line NumberLiteralValue: only differences from a captured generation are observed, so any fixed initial offset cancels from both sides.
    let openGeneration = 0;
    /**
     * A controlled reopen the host asked for that has not started yet — see {@link requestReopen}.
     * `firstRequestedAt` is when the FIRST of an unbroken run of requests arrived; the
     * `config.reopenTaskWaitMs` bound on waiting for background work runs from it, so a string of
     * later requests cannot put the reopen off indefinitely. `deferralLogged` keeps the deferral
     * log to one line per request.
     */
    let pendingReopen: { reason: string, atGeneration: number, firstRequestedAt: number, deferralLogged: boolean } | undefined;
    /** The single timer that re-evaluates a held {@link pendingReopen} at its next boundary — see {@link maybeStartRequestedReopen}. */
    let reopenRecheckTimer: TimerHandle | undefined;
    /**
     * The last time a background task's result was plausibly set on its way to the model — see
     * {@link REOPEN_WAKE_SETTLE_MS}. `undefined` until the first such sign in the current session;
     * cleared when a new session opens, which has nothing left to wake.
     */
    let wakeSettleFrom: number | undefined;
    /**
     * Accumulate-only envelopes appended while a reopen was in flight, flushed onto the
     * replacement session's queue once it opens. Buffered rather than dropped because the caller's
     * dedupe key is burned the moment it hands one over (see `notification-bridge.ts`), so a
     * silent drop here is a permanently lost notification.
     */
    let bufferedAppends: SDKUserMessage[] = [];
    /**
     * The most recent reopen, so {@link shutdown} can await it instead of racing a replacement
     * child into existence.
     *
     * Deliberately never cleared on completion, only overwritten by the next reopen: a completing
     * reopen can START the next one before its own bookkeeping would run — `reopenReplacementSession`
     * sets `reopening = false` and calls `processQueue()` (which starts a pending requested reopen)
     * synchronously, and a replacement handle that dies immediately re-enters `handleMidLifeClosed`
     * the same way — so clearing here would erase the NEWER reopen's promise and let `shutdown`
     * finish without awaiting the session it is about to orphan. Awaiting an already-settled reopen
     * is a no-op, so holding the last one costs nothing.
     */
    let reopenInFlight: Promise<void> = Promise.resolve();
    let currentSessionId: string | undefined;
    let currentHandleRef: SessionHandle | undefined;
    let currentQueue: InputQueue | undefined;
    /** The handle whose `finishOpen` has dispatched `session_opened`, after which its acknowledgements' cost totals go straight to the ledger (see {@link noteAcknowledgedCost}). */
    let costBaselineHandle: SessionHandle | undefined;
    /** An acknowledgement's cost total from the current handle that landed before its `finishOpen`, applied there after the `session_opened` reset. */
    let earlyCostBaseline: number | undefined;
    let currentTurn: ActiveTurn | null = null;
    /** True only for the span of {@link afterResult} between nulling `currentTurn` and `guard.onTurnEnd()` resolving — blocks {@link onFrame} from spontaneously opening a notification turn for a frame that arrives in that window, which `submitCompact`'s `beginTurn` (driven by that very `onTurnEnd` call) would otherwise silently clobber. */
    let awaitingTurnEnd = false;
    const pendingQueue: QueuedItem[] = [];
    const turnSubscribers = new Set<(turnId: string, frame: SDKMessage) => void>();
    const turnEndedWaiters: (() => void)[] = [];
    let previousTasks = new Map(ledgerStore.get().tasks.map(task => [task.id, task] as const));
    let previousFinishedTasks = latestFinishedTasks(ledgerStore.get());
    let previousCompaction = ledgerStore.get().compaction;
    /**
     * Adoptions waiting for a spontaneous assistant frame to attach themselves to, OLDEST FIRST —
     * see {@link PendingAdoption} for why one ordered queue rather than a slot per kind, and
     * {@link adoptPeerTurn} for the cap. `setAt` (clock time) backs the
     * {@link PENDING_WAKE_TTL_MS} staleness sweep {@link onFrame} applies before adopting.
     */
    let pendingAdoptions: PendingAdoption[] = [];

    function now(): Date {
        return new Date(clock.now());
    }

    function resolveTurnEndedWaiters(): void {
        // Stryker disable next-line NumberLiteralValue: turnEndedWaiters holds at most one waiter (only shutdown's single waitForTurnEnd call pushes, behind the shuttingDown guard), so splice(-1) and splice(0) remove the same element
        const waiters = turnEndedWaiters.splice(0);
        for(const waiter of waiters) {
            waiter();
        }
    }

    function waitForTurnEnd(): Promise<void> {
        // The sole caller checks currentTurn synchronously immediately before calling.
        return new Promise((resolve) => {
            // Stryker disable next-line ArrayMethodSwap: shutdown sets shuttingDown before awaiting, so at most one turn-end waiter can exist and either insertion gives the same one-element array.
            turnEndedWaiters.push(resolve);
        });
    }

    /**
     * The id reported to `subscribeTurn`/`onTurnFrame` subscribers. Reads {@link ActiveTurn.id}
     * — never the kind — so a bare spontaneous turn reports the same `notification-<ms>` the
     * ledger holds, rather than the literal `'notification'` that no `turn_synopsis` could ever
     * match.
     */
    function turnIdFor(turn: ActiveTurn | null): string {
        return turn?.id ?? 'none';
    }

    function notifyTurnSubscribers(frame: SDKMessage): void {
        const turnId = turnIdFor(currentTurn);
        for(const handler of turnSubscribers) {
            handler(turnId, frame);
        }
        onTurnFrame?.(turnId, frame);
    }

    /**
     * Journals task lifecycle facts by diffing `previousTasks` against `ledger.tasks`. Reads the
     * causing {@link LedgerEvent} (not just the resulting snapshot) to tell WHY a task left
     * `ledger.tasks` — an explicit `task_lost` event, or `session_opened` resetting the task list
     * wholesale on a fallback reopen, both journal `task_lost`; anything else (normally a
     * `task_notification` frame) journals `task_finished` carrying the terminal status the ledger
     * gave the task on its way to `ledger.finishedTasks`. A task that had ALREADY finished before
     * this event but whose finished status the event changed — a `task_notification` landing after
     * `background_tasks_changed` dropped the task as `'stopped'`, or after a loss — journals another
     * `task_finished` with the corrected outcome (see {@link journalFinishedCorrections}).
     */
    function journalTaskLifecycle(ledger: Ledger, event: LedgerEvent): void {
        // Stryker disable next-line llm: LedgerTask.id is always a string (built from the SDK frame's task_id), so `task.id + ''` is the identity and the id set is unchanged
        const currentTaskIds = new Set(ledger.tasks.map(task => task.id));
        for(const task of ledger.tasks) {
            // Stryker disable next-line llm: previousTasks is keyed by LedgerTask.id strings, so String(task.id) is the identity and the lookup is unchanged
            if(!previousTasks.has(task.id)) {
                journal.append({ type: 'task_started', at: now(), taskId: task.id, description: task.description });
            }
        }
        const isReopen = event.type === 'session_opened';
        const explicitlyLostTaskId = event.type === 'task_lost' ? event.taskId : undefined;
        for(const [id, task] of previousTasks) {
            if(!currentTaskIds.has(id)) {
                // Stryker disable next-line llm: both operands are string | undefined, where == and === agree (an undefined taskId is falsy against a string key either way)
                const lost = isReopen || id === explicitlyLostTaskId;
                journal.append(lost
                    ? { type: 'task_lost', at: now(), taskId: id, description: task.description }
                    : { type: 'task_finished', at: now(), taskId: id, description: task.description, outcome: finishedOutcomeOf(ledger, id) });
            }
        }
        const currentFinishedTasks = latestFinishedTasks(ledger);
        journalFinishedCorrections(ledger, currentFinishedTasks);
        previousTasks = new Map(ledger.tasks.map(task => [task.id, task] as const));
        previousFinishedTasks = currentFinishedTasks;
    }

    /**
     * Journals a fresh `task_finished` for every task that was already finished (and not running)
     * before this event but whose latest finished status the event changed. The ledger corrects a
     * finished record in place when a task's `task_notification` arrives after the task left
     * `tasks`, so the row journaled when it left would otherwise stay wrong. A repeated identical
     * notification leaves the status unchanged and journals nothing; a record the event evicted
     * past the finished-tasks cap has no status to compare and journals nothing; a reused id that
     * was running again before this event is left to the running-set diff above.
     */
    function journalFinishedCorrections(ledger: Ledger, currentFinishedTasks: ReadonlyMap<string, LedgerTask>): void {
        for(const [id, before] of previousFinishedTasks) {
            const after = currentFinishedTasks.get(id);
            if(after !== undefined && after.status !== before.status && !previousTasks.has(id)) {
                journal.append({ type: 'task_finished', at: now(), taskId: id, description: after.description, outcome: finishedOutcomeOf(ledger, id) });
            }
        }
    }

    /**
     * The terminal status the ledger gave `taskId` as it moved it to `finishedTasks`. The reducer
     * appends that record before any subscriber runs, so it is normally there; the one way it is
     * not is more tasks than the ledger's finished-tasks cap finishing in a single event (a turn
     * end stopping that many foreground tasks, or one `background_tasks_changed` dropping that
     * many), which evicts the earliest of them on the spot. With the record gone this does not
     * guess from the event: it journals `'completed'`, the pre-#61 reading of every finished task,
     * and logs at debug.
     */
    function finishedOutcomeOf(ledger: Ledger, taskId: string): TaskFinishedOutcome {
        const outcome = finishedTaskStatus(ledger, taskId);
        if(outcome === undefined) {
            logger.debug({ taskId }, 'Conductor: finished task has no finished record in the ledger; journaling outcome completed');
            return 'completed';
        }
        return outcome;
    }

    /**
     * Journals the outcome of a compaction that just transitioned out of `'compacting'`, reading
     * a `compaction_failed` event's `reason` directly rather than losing it to the reducer's
     * write-only ledger state. On a `'timeout'` failure with the `/compact` turn still running,
     * also interrupts it — releasing the guard's own bookkeeping alone leaves `processQueue`
     * blocked on `currentTurn !== null` forever.
     */
    function journalCompactionOutcome(event: LedgerEvent): void {
        // Stryker disable next-line llm: event.type is a string-literal discriminant, so == and === agree
        if(event.type === 'compaction_failed') {
            journal.append({ type: 'compaction_failed', at: now(), error: event.reason ?? 'compaction attempt did not complete' });
            // Stryker disable next-line llm: reason is string | undefined, so == and === agree against a string literal
            if(event.reason === 'timeout' && currentTurn?.kind === 'compact') {
                void interruptCurrentTurnInternal('compaction_ceiling', 'compaction ceiling exceeded');
            }
            return;
        }
        journal.append({ type: 'compaction_completed', at: now() });
    }

    /**
     * All `pendingQueue`-external ledger bookkeeping this conductor derives from ledger changes:
     * task lifecycle journaling and releasing submits held for compaction.
     */
    /**
     * Feeds a held requested reopen (#97) from ledger changes; must run BEFORE
     * {@link journalTaskLifecycle}, which moves `previousTasks` on. A background task leaving the
     * running set other than by an explicit `task_lost` (a `background_tasks_changed` drop, or its
     * `task_notification`) starts (or restarts) the {@link REOPEN_WAKE_SETTLE_MS} window; a lost
     * task has no result to wait for. A `task_notification` frame restarts the window too, but
     * {@link onFrame} sees to that directly, since a ledger subscriber never hears of a notification
     * the ledger ignores. A `session_opened` reset also lands here, but {@link finishOpen} clears
     * the window straight after it.
     *
     * Any background task leaving also re-arms the recheck timer to fire at once, so the hold is
     * re-evaluated against the task set now rather than at the boundary the timer was armed for.
     * Only arms while a request is still pending and shutdown has not begun. A notification that
     * removes nothing needs no re-arm: it can only extend a hold, and the armed timer re-evaluates
     * at the boundary it already holds.
     */
    function noteBackgroundWorkChange(ledger: Ledger, event: LedgerEvent): void {
        const runningIds = new Set(ledger.tasks.map(task => task.id));
        const backgroundLeft = [...previousTasks.values()].some(task => task.background && !runningIds.has(task.id));
        if(backgroundLeft && event.type !== 'task_lost') {
            wakeSettleFrom = clock.now();
        }
        if(backgroundLeft && pendingReopen !== undefined && !shuttingDown) {
            armReopenRecheck(0);
        }
    }

    ledgerStore.subscribe((ledger, event) => {
        // Advance previousCompaction BEFORE any side effect: the store notifies synchronously and
        // reentrantly, and both side effects below can dispatch — processQueue's beginTurn
        // (turn_submitted) and a timeout's interrupt (interrupt_requested). A nested notification
        // that still saw 'compacting' here would journal the same transition a second time.
        const compactionEnded = previousCompaction === 'compacting' && ledger.compaction === 'none';
        previousCompaction = ledger.compaction;
        noteBackgroundWorkChange(ledger, event);
        journalTaskLifecycle(ledger, event);

        if(compactionEnded) {
            journalCompactionOutcome(event);
            processQueue();
        }
    });

    function getContextUsage(opts?: { detail?: 'summary' | 'full' }): ReturnType<SessionHandle['getContextUsage']> {
        const handle = currentHandleRef;
        if(handle === undefined) {
            return Promise.reject(new Error('Conductor has no active session'));
        }
        return handle.getContextUsage(opts);
    }

    function submitCompact(): Promise<void> {
        if(shuttingDown) {
            return Promise.reject(new Error('Conductor is shutting down'));
        }
        if(reopening) {
            return Promise.reject(new Error('Conductor is reopening its session'));
        }
        try {
            const at = now();
            journal.append({ type: 'compaction_started', at });
            beginTurn({ envelope: buildCompactEnvelope(at), priority: 'normal', attempts: 1, deferred: internalDeferred() });
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(toError(error, 'submitCompact failed'));
        }
    }

    /*
     * The compaction lifecycle: these three are the only dispatchers of compaction ledger events.
     * Each reducer is idempotent and the store notifies nobody on an unchanged ledger, so a second
     * start (the guard's `/compact` then the PreCompact hook) or a second completion (the
     * `compact_boundary` frame and the PostCompact hook, in either order) is invisible to every
     * subscriber — the journal, the queue gate, telemetry and the tuner hear each fact once.
     */
    function compactionStarted(trigger?: 'manual' | 'auto'): void {
        ledgerStore.dispatch({ type: 'compaction_started', trigger, at: now() });
    }

    function compactionFailed(reason: CompactionFailureReason): void {
        ledgerStore.dispatch({ type: 'compaction_failed', reason, at: now() });
    }

    const guard: CompactionGuard = createCompactionGuard({
        getContextUsage,
        submitCompact,
        compactionStarted,
        compactionFailed,
        ledgerStore,
        clock,
        thresholdPercent: config.compactThresholdPercent,
        logger,
    });

    function compactionCompleted(): void {
        guard.onCompactionFinished();
        ledgerStore.dispatch({ type: 'compaction_completed', at: now() });
    }

    function enqueue(item: QueuedItem): void {
        if(item.priority === 'urgent') {
            const firstOtherIndex = pendingQueue.findIndex(existing => existing.priority !== 'urgent');
            if(firstOtherIndex === -1) {
                pendingQueue.push(item);
            } else {
                // Stryker disable next-line NumberLiteralValue: splice clamps a negative deleteCount to 0, so splice(i, -1, item) inserts exactly like splice(i, 0, item)
                pendingQueue.splice(firstOtherIndex, 0, item);
            }
        } else {
            pendingQueue.push(item);
        }
        ledgerStore.dispatch({ type: 'envelope_queued', kind: item.envelope.kind, origin: item.envelope.origin, at: now() });
    }

    function beginTurn(item: QueuedItem): void {
        const queue = currentQueue;
        if(queue === undefined) {
            throw new InvariantViolationError('conductor.beginTurn', 'called before open() assigned currentQueue — every call site (processQueue, submitCompact) only runs once opened is true');
        }
        const at = now();
        currentTurn = {
            id: item.envelope.id, item, kind: item.envelope.kind, channelId: item.envelope.channelId, authorId: item.envelope.authorId, origin: item.envelope.origin, tracker: new StreamTracker(), escalationArmed: false,
        };
        const meta: EnvelopeMeta = {
            id: item.envelope.id, kind: item.envelope.kind, queuedAt: at, channelId: item.envelope.channelId, seed: item.envelope.synopsisSeed, origin: item.envelope.origin,
        };
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: meta, at });
        journal.append({
            type: 'envelope_submitted', at, envelopeId: item.envelope.id, kind: item.envelope.kind, ...(item.envelope.channelId === undefined ? {} : { channelId: item.envelope.channelId }),
        });
        currentTurn.wireUuid = queue.push(toSdkUserMessage(item.envelope));
    }

    function processQueue(): void {
        // `reopening` is deliberately NOT tested here: the check below covers it, and testing it
        // twice would narrow it to `false` for the rest of this function, hiding the fact that
        // `maybeStartRequestedReopen()` can flip it (TypeScript does not reset a `let`'s narrowing
        // across a call). `maybeStartRequestedReopen` is itself a no-op while `reopening`.
        if(currentTurn !== null || shuttingDown) {
            return;
        }
        // A controlled reopen the host is owed outranks starting anything new: the reopen is what
        // applies the new system prompt, and a busy queue -- or the perch driver's next slot,
        // which starts synchronously as the previous one ends -- could otherwise starve it
        // indefinitely. A no-op when nothing is owed.
        maybeStartRequestedReopen();
        if(pendingReopen !== undefined || reopening) {
            // Either still owed (waiting for the turn-end compaction check, for a handle to exist,
            // or — bounded by config.reopenTaskWaitMs — for the old session's background work to
            // finish and reach the model, #97), already in flight when we got here, or just started
            // by the call above. The SDK's own wake turns still run during that wait; they open
            // through onFrame, not through this queue.
            // Queued items are left untouched and play on the replacement session. Deliberately
            // NOT an early return before that call -- a request an intervening open already
            // satisfied is dropped by it, and the queue that open just refilled (a crash reopen
            // re-queues its interrupted turn) has to be serviced here rather than left to stall
            // until the next submit.
            return;
        }
        if(ledgerStore.get().compaction === 'compacting') {
            return;
        }
        const next = pendingQueue.shift();
        if(next === undefined) {
            return;
        }
        beginTurn(next);
    }

    /** Interrupts the running turn, recording `source` on it unless another source already asked (the first source wins). */
    async function interruptCurrentTurnInternal(source: CancellationSource, reason: string | undefined): Promise<void> {
        const handle = currentHandleRef;
        if(handle === undefined || currentTurn === null || currentTurn.interruptSource !== undefined) {
            return;
        }
        currentTurn.interruptSource = source;
        ledgerStore.dispatch({ type: 'interrupt_requested', at: now() });
        logger.debug({ reason, source }, 'Conductor requesting interrupt');
        try {
            await handle.interrupt();
        } catch (error) {
            logger.error({ error }, 'Conductor interrupt failed');
        }
    }

    function armHumanWaitEscalation(): void {
        if(currentTurn === null || currentTurn.escalationArmed) {
            return;
        }
        currentTurn.escalationArmed = true;
        currentTurn.escalationTimer = clock.setTimer(onHumanWaitTargetElapsed, config.humanWaitTargetMs);
    }

    function onHumanWaitTargetElapsed(): void {
        if(currentTurn === null) {
            return;
        }
        const progress = currentTurn.tracker.getProgress();
        if(progress.pendingToolUse !== null) {
            currentTurn.escalationTimer = clock.setTimer(() => {
                void interruptCurrentTurnInternal('human_wait', 'human wait ceiling elapsed');
            }, config.humanWaitCeilingMs - config.humanWaitTargetMs);
            return;
        }
        void interruptCurrentTurnInternal('human_wait', 'human wait target elapsed');
    }

    function routeIncoming(item: QueuedItem): void {
        // Stryker disable next-line llm: `x && true` is truthiness-preserving, so the early-return condition is unchanged
        if(item.withdrawnWhileWaiting) {
            return;
        }
        // Stryker disable next-line llm: currentTurn is ActiveTurn | null and is never assigned undefined, so == null and == undefined both match === null
        if(currentTurn === null) {
            enqueue(item);
            processQueue();
            return;
        }
        // Stryker disable next-line llm: `!== undefined` and the truthy test differ only for an empty-string channel id, which no discord caller can produce (both sides are non-empty snowflakes)
        const requestingChannelIsSet = item.requestingChannelId !== undefined;
        if(item.priority === 'urgent' && currentTurn.origin?.role === 'human'
          && requestingChannelIsSet && item.requestingChannelId === currentTurn.channelId) {
            enqueue(item);
            void interruptCurrentTurnInternal('human_preempt', 'human envelope for the running channel');
            return;
        }
        if(item.priority === 'urgent' && isBackgroundKind(currentTurn.kind)) {
            enqueue(item);
            armHumanWaitEscalation();
            return;
        }
        enqueue(item);
    }

    /** Injects a `continuation`-kind envelope ahead of everything else queued when an interrupted background turn (a spontaneous notification, or an adopted R2 task wake) left meaningful partial work behind. */
    function injectContinuationNoteIfInterruptedBackgroundTurn(turn: ActiveTurn, progress: StreamProgress): void {
        if(!isBackgroundKind(turn.kind) || turn.interruptSource === undefined) {
            return;
        }
        const note = buildContinuationNote(progress);
        if(note !== undefined) {
            pendingQueue.unshift({ envelope: buildContinuationEnvelope(note, now()), priority: 'urgent', attempts: 1, deferred: internalDeferred() });
        }
    }

    /** Retries `item` after `delayMs` on the injected clock (immediately when `delayMs` is `0`). */
    function scheduleRetry(item: QueuedItem, delayMs: number): void {
        if(delayMs > 0) {
            clock.setTimer(() => {
                routeIncoming(item);
            }, delayMs);
            return;
        }
        routeIncoming(item);
    }

    /** Removes `item`'s abort listener (added by `submit()` when a `signal` was given), a no-op when there is none. Called at every point a `QueuedItem` reaches its FINAL settlement — resolved or rejected — so a caller's `AbortSignal` is never held onto past that item's lifetime. */
    function clearAbortListener(item: QueuedItem): void {
        item.abortCleanup?.();
        item.abortCleanup = undefined;
    }

    /** Resolves `item`'s `submit()` promise as a non-retryable failure and journals `turn_failed`. */
    function failTurn(turn: ActiveTurn, item: QueuedItem, error: Error, contextUsagePercent: number): void {
        clearAbortListener(item);
        journal.append({ type: 'turn_failed', at: now(), envelopeId: item.envelope.id, kind: turn.kind, error: error.message });
        item.deferred.resolve({
            status: 'failed', envelopeId: item.envelope.id, response: null, sessionId: currentSessionId, contextUsagePercent, error,
        });
    }

    /** An `is_error` result: retries per `retryPolicy` when the classified error is transient/rate-limited and attempts remain, else fails the turn. */
    function settleErroredTurn(turn: ActiveTurn, item: QueuedItem, frame: ResultFrame, contextUsagePercent: number): void {
        const error = resultFrameToError(frame);
        const classification = classifyError(error);
        // Stryker disable next-line llm: attempts and maxAttempts are both integers (attempts starts at 1 and is only incremented; maxAttempts is z.int()), so `< maxAttempts` and `<= maxAttempts - 1` are the same comparison
        const canRetry = (classification.category === 'transient' || classification.category === 'rate_limited') && item.attempts < retryPolicy.maxAttempts;
        if(!canRetry) {
            failTurn(turn, item, error, contextUsagePercent);
            return;
        }
        item.attempts += 1;
        scheduleRetry(item, classification.retryAfterMs ?? computeBackoffDelayMs(retryPolicy, item.attempts - 1));
    }

    function settleTurn(turn: ActiveTurn, frame: ResultFrame): void {
        const { interruptSource } = turn;
        const progress = turn.tracker.getProgress();

        injectContinuationNoteIfInterruptedBackgroundTurn(turn, progress);

        if(turn.item === undefined) {
            return;
        }
        const { item } = turn;
        // The percentage most recently polled by the compaction guard's OWN onTurnEnd call, from
        // the end of the PREVIOUS turn — that poll for THIS turn always runs after this result has
        // already settled (see afterResult, below), so reading it here (rather than issuing a
        // second, blocking getContextUsage round trip) surfaces per-turn usage on every TurnResult
        // with no extra latency or SDK call.
        const contextUsagePercent = ledgerStore.get().context.percentage;

        if(interruptSource === undefined && frame.is_error) {
            settleErroredTurn(turn, item, frame, contextUsagePercent);
            return;
        }

        clearAbortListener(item);
        const response = interruptSource === undefined && frame.subtype === 'success' ? frame.result : null;
        const truncated = response !== null && response.length > TURN_RESPONSE_TEXT_CAP;
        journal.append({
            // Stryker disable next-line llm: TurnKind is the nonempty EnvelopeKind literal union, so the fallback cannot be selected.
            type: 'turn_completed', at: now(), envelopeId: item.envelope.id, kind: turn.kind,
            ...(response === null ? {} : { responseText: truncated ? response.slice(0, TURN_RESPONSE_TEXT_CAP) : response }),
            ...(truncated ? { truncated: true } : {}),
        });
        const settled = { envelopeId: item.envelope.id, sessionId: currentSessionId, contextUsagePercent };
        if(interruptSource !== undefined) {
            item.deferred.resolve({
                ...settled, status: 'interrupted', response: null, partialWork: progress, cancellationSource: interruptSource,
            });
            return;
        }
        if(frame.subtype === 'success') {
            item.deferred.resolve({ ...settled, status: 'completed', response: frame.result });
            return;
        }
        // A non-success result the SDK did not flag `is_error` (an `error_*` subtype): no reply,
        // and nothing retried it — a failure, journaled above as a reply-less `turn_completed`.
        item.deferred.resolve({
            ...settled, status: 'failed', response: null, error: resultFrameToError(frame),
        });
    }

    async function afterResult(frame: ResultFrame): Promise<void> {
        const turn = currentTurn;
        currentTurn = null;
        if(turn?.escalationTimer !== undefined) {
            clock.clearTimer(turn.escalationTimer);
        }
        if(wakeSettleFrom !== undefined) {
            // The SDK delivers a wake it deferred behind a running turn right after that turn
            // ends, so a background finish seen earlier in this session makes every turn end a
            // fresh reason for a held reopen (#97) to wait out REOPEN_WAKE_SETTLE_MS.
            wakeSettleFrom = clock.now();
        }
        resolveTurnEndedWaiters();
        // Stryker disable llm: turn is ActiveTurn | null, an object type, so `turn !== null` and the truthy check select the same branch for every possible value
        if(turn !== null) {
            settleTurn(turn, frame);
        }
        // Stryker restore llm
        // Stryker disable llm: readRss is backed by process.memoryUsage().rss, a non-negative integer, so `|| 0` cannot change the dispatched value
        ledgerStore.dispatch({ type: 'tick', rssBytes: readRss(), at: now() });
        // Stryker restore llm
        // Between here and guard.onTurnEnd() resolving, currentTurn is null but a `/compact` turn
        // may be about to begin (submitCompact -> beginTurn, driven from inside onTurnEnd itself).
        // awaitingTurnEnd blocks onFrame's spontaneous-notification-turn branch for exactly this
        // span, so a frame arriving in the window is not clobbered when beginTurn overwrites
        // currentTurn moments later (the one-turn invariant would otherwise be silently violated).
        awaitingTurnEnd = true;
        try {
            await guard.onTurnEnd({ queueEmpty: pendingQueue.length === 0 });
        } finally {
            awaitingTurnEnd = false;
        }
        processQueue();
    }

    /**
     * Settles the turn still running when {@link shutdown} closes the session handle (#120), as
     * `interrupted` with the source that first asked for the interrupt — or `'shutdown'` when the
     * hard deadline closed the session before any interrupt was sent. A no-op when no turn is
     * running, including when the turn's own result frame already settled it through
     * {@link afterResult} during shutdown's journal flush.
     *
     * Without this the turn never settles: on the real SDK, shutdown's interrupt is acknowledged
     * and the close runs ~2 ms later, before the interrupted turn's result frame arrives (#41
     * Part A, case A6); {@link handleMidLifeClosed} ignores closes while shutting down; and
     * {@link rejectAllQueued} only drains `pendingQueue`. The submitter's promise (or an adopted
     * wake's {@link CreateConductorParams.onWakeTurnSettled}) would stay pending forever.
     *
     * Journals the same reply-less `turn_completed` row an interrupted turn gets when its result
     * arrives in time. Also clears the turn's human-wait escalation timer and releases shutdown's
     * own turn-end waiter, so no timer outlives the conductor. Deliberately injects no
     * continuation note: `pendingQueue` never drains again once shutdown has begun.
     */
    function settleTurnCutOffByShutdown(): void {
        const turn = currentTurn;
        if(turn === null) {
            return;
        }
        currentTurn = null;
        if(turn.escalationTimer !== undefined) {
            clock.clearTimer(turn.escalationTimer);
        }
        resolveTurnEndedWaiters();
        const cancellationSource = turn.interruptSource ?? 'shutdown';
        logger.info({ turnId: turn.id, kind: turn.kind, cancellationSource }, 'Conductor shutdown settled the turn still running as interrupted');
        if(turn.item === undefined) {
            return;
        }
        const { item } = turn;
        clearAbortListener(item);
        journal.append({ type: 'turn_completed', at: now(), envelopeId: item.envelope.id, kind: turn.kind });
        item.deferred.resolve({
            status:              'interrupted',
            envelopeId:          item.envelope.id,
            response:            null,
            sessionId:           currentSessionId,
            contextUsagePercent: ledgerStore.get().context.percentage,
            partialWork:         turn.tracker.getProgress(),
            cancellationSource,
        });
    }

    /**
     * The {@link Deferred} for an adopted wake turn's synthesized {@link QueuedItem} (R2): no
     * external caller is waiting on a promise for this turn, so `resolve` routes the settled
     * {@link TurnResult} to {@link onWakeTurnSettled} instead (when one was provided). The
     * callback is still invoked synchronously, but through `Promise.try`, so a synchronous
     * throw becomes a rejection like an asynchronous one: both are caught and logged, never
     * surfacing as an unhandled rejection — and never escaping `resolve` itself, which a crash
     * reopen calls (via {@link settleCutOffAdoptedTurn}) after setting `reopening`, where a throw
     * would leave the queue wedged with no replacement session (#99 challenge).
     *
     * `reject` is a no-op because nothing ever calls it for this item: an adopted item is never
     * in `pendingQueue` (so `rejectAllQueued` cannot reach it), never retried, and never the
     * `inFlightItem` a crash reopen re-queues or rejects — a crash settles it as failed instead.
     */
    function buildWakeSettledDeferred(envelope: TaskQueryEnvelope): Deferred {
        return {
            resolve: (result: TurnResult) => {
                if(onWakeTurnSettled === undefined) {
                    return;
                }
                Promise.try(onWakeTurnSettled, envelope, result).catch((error: unknown) => {
                    logger.error({ error }, 'onWakeTurnSettled failed for an adopted wake turn');
                });
            },
            reject: () => undefined,
        };
    }

    /**
     * Consumes `wake` (R2): synthesizes a `task`-kind envelope — `channelId`/`authorId` from
     * {@link taskLaunches}'s lookup, when a launch record is found — and opens it as the current
     * turn exactly like {@link beginTurn} (ledger `turn_submitted`, journal
     * `envelope_submitted`), EXCEPT it pushes nothing to the SDK queue: the SDK already started
     * this turn on its own (the `<task-notification>` wake), so pushing again would submit a
     * second, unwanted user message. For the same reason, the synthesized item is seeded at
     * `retryPolicy.maxAttempts` (non-retryable): a transient `is_error` result on this turn must
     * fail immediately (`failTurn`) rather than retry through `settleErroredTurn` -> `scheduleRetry`
     * -> `beginTurn`, which WOULD push `wake.summary` into the SDK queue as a fresh, unframed user
     * message — exactly the second submission this function exists to avoid. Forgets the launch
     * record once adopted.
     */
    function beginAdoptedWakeTurn(wake: { taskId: string, toolUseId: string, summary: string }): void {
        const launch = taskLaunches?.lookup(wake);
        const at = now();
        const envelope: TaskQueryEnvelope = {
            id:           crypto.randomUUID(),
            mode:         'query',
            kind:         'task',
            text:         wake.summary,
            channelId:    launch?.channelId,
            authorId:     launch?.authorId,
            createdAt:    at,
            synopsisSeed: toSynopsisSeed(wake.summary),
        };
        const item: QueuedItem = {
            envelope, priority: 'normal', attempts: retryPolicy.maxAttempts, deferred: buildWakeSettledDeferred(envelope),
        };
        currentTurn = {
            id: envelope.id, item, kind: 'task', channelId: envelope.channelId, authorId: envelope.authorId, tracker: new StreamTracker(), escalationArmed: false,
        };
        const meta: EnvelopeMeta = {
            id: envelope.id, kind: envelope.kind, queuedAt: at, channelId: envelope.channelId, seed: envelope.synopsisSeed,
        };
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: meta, at });
        journal.append({
            type: 'envelope_submitted', at, envelopeId: envelope.id, kind: envelope.kind, ...(envelope.channelId === undefined ? {} : { channelId: envelope.channelId }),
        });
        taskLaunches?.forget(wake.taskId);
    }

    /**
     * A wake stays SINGLE-SLOT: a second one before the first is consumed replaces it, exactly as
     * before, since two wakes racing for one spontaneous turn means the first already missed its
     * own. The replacement takes a fresh place at the BACK of the queue, so its position still
     * reflects when it actually arrived relative to any pending peer message.
     */
    function adoptWakeTurn(input: { taskId: string, toolUseId: string, summary: string }): void {
        const previous = pendingAdoptions.find(entry => entry.kind === 'wake');
        if(previous !== undefined) {
            logger.warn({ previous: { ...previous.wake, setAt: previous.setAt }, next: input }, 'adoptWakeTurn called again before the previous pending wake turn was consumed; overwriting');
            pendingAdoptions = pendingAdoptions.filter(entry => entry !== previous);
        }
        pendingAdoptions.push({ kind: 'wake', wake: input, setAt: clock.now() });
    }

    /**
     * Consumes a pending peer message (session-peers block 2): opens `envelope` as the current
     * turn exactly like {@link beginAdoptedWakeTurn} — ledger `turn_submitted`, journal
     * `envelope_submitted`, nothing pushed to the SDK queue, and the item seeded at
     * `retryPolicy.maxAttempts` so a transient `is_error` fails immediately instead of retrying
     * through `beginTurn` (which WOULD push the envelope's rendered text as a second, unframed
     * user message). Its `deferred` is {@link internalDeferred}: no external caller is waiting on
     * this turn and there is no host-side delivery for it — Claude answers a peer with its own
     * `SendMessage` call.
     */
    function beginAdoptedPeerTurn(envelope: AdoptedPeerEnvelope): void {
        const at = now();
        const item: QueuedItem = {
            envelope, priority: 'normal', attempts: retryPolicy.maxAttempts, deferred: internalDeferred(),
        };
        currentTurn = {
            id: envelope.id, item, kind: 'peer', tracker: new StreamTracker(), escalationArmed: false,
        };
        ledgerStore.dispatch({
            type: 'turn_submitted', envelope: { id: envelope.id, kind: 'peer', queuedAt: at, seed: envelope.synopsisSeed }, at,
        });
        journal.append({ type: 'envelope_submitted', at, envelopeId: envelope.id, kind: 'peer' });
    }

    /**
     * Peer messages queue rather than overwrite: each one is a distinct message that the SDK has
     * already started a turn for, so dropping the first would erase that message from the ledger
     * and journal AND attach the second envelope to the first message's turn. Only the
     * {@link PENDING_PEER_QUEUE_MAX} cap loses one, oldest first, and says so.
     */
    function adoptPeerTurn(envelope: AdoptedPeerEnvelope): void {
        const peers = pendingAdoptions.filter((entry): entry is PendingPeerAdoption => entry.kind === 'peer');
        const overflowing = peers.length >= PENDING_PEER_QUEUE_MAX ? peers[0] : undefined;
        if(overflowing !== undefined) {
            pendingAdoptions = pendingAdoptions.filter(entry => entry !== overflowing);
            logger.warn({ dropped: overflowing.envelope.id, next: envelope.id, max: PENDING_PEER_QUEUE_MAX }, 'the pending peer queue is full; dropping the oldest peer message that never got a turn of its own');
        }
        pendingAdoptions.push({ kind: 'peer', envelope, setAt: clock.now() });
    }

    /** True once a pending adoption set at `setAt` has outlived {@link PENDING_WAKE_TTL_MS} — elapsed time, never a raw sum. */
    function isPendingAdoptionStale(setAt: number): boolean {
        return clock.now() - setAt > PENDING_WAKE_TTL_MS;
    }

    /** The expiry warning for one swept adoption, naming whichever thing was lost. */
    function warnPendingAdoptionExpired(entry: PendingAdoption): void {
        if(entry.kind === 'wake') {
            logger.warn({ pendingWake: { ...entry.wake, setAt: entry.setAt } }, 'a pending wake turn expired (PENDING_WAKE_TTL_MS) before it could be adopted; a later spontaneous turn will not be misattributed to it');
            return;
        }
        logger.warn({ envelopeId: entry.envelope.id }, 'a pending peer message expired (PENDING_WAKE_TTL_MS) before it could be adopted; a later spontaneous turn will not be misattributed to it');
    }

    /**
     * Opens the turn a spontaneous assistant frame belongs to, consuming the OLDEST pending
     * adoption of either kind — see {@link PendingAdoption} for why arrival order is the only
     * defensible rule — or a bare notification turn when nothing is pending.
     */
    function beginSpontaneousTurn(): void {
        const next = pendingAdoptions.shift();
        if(next === undefined) {
            const at = now();
            const turnId = bareNotificationTurnId(at);
            currentTurn = {
                id: turnId, kind: 'notification', tracker: new StreamTracker(), escalationArmed: false,
            };
            // Dispatched here — still inside onFrame, BEFORE notifyTurnSubscribers — so the
            // turn synopsis producer (which opens a handler from the ledger's turn) is live
            // for this turn's very first frame, and every `turn_synopsis` it dispatches carries
            // the id `reduceTurnSynopsis` compares against. Do not move it after the notify.
            ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId, at });
            return;
        }
        if(next.kind === 'wake') {
            beginAdoptedWakeTurn(next.wake);
            return;
        }
        beginAdoptedPeerTurn(next.envelope);
    }

    /**
     * True when `frame` names, in its client-uuid echo, only messages other than the one the
     * current host-pushed turn sent — a stale result from a discarded handle, or an
     * acknowledgement the queue did not claim. Such a frame must not settle the turn: by the SDK
     * contract a turn's own result always lists its uuid. A result that echoes nothing (a turn
     * the CLI started, an older producer, a delivery failure) is never "elsewhere", so a missing
     * echo cannot wedge a turn.
     */
    function resultBelongsElsewhere(turn: ActiveTurn, frame: ResultFrame): boolean {
        if(turn.wireUuid === undefined) {
            return false;
        }
        const echoed = echoedUserMessageUuids(frame);
        return echoed.length > 0 && !echoed.includes(turn.wireUuid);
    }

    function onFrame(frame: SDKMessage): void {
        if(closed) {
            // The session handle keeps forwarding frames until its stream ends, and a real SDK
            // stream can still hold frames buffered behind shutdown's close. Shutdown has already
            // settled the turn they belong to (#120), so any of them opening a spontaneous turn,
            // consuming a pending adoption, or settling anything would misattribute it.
            return;
        }
        if(frame.type === 'result' && currentTurn !== null && resultBelongsElsewhere(currentTurn, frame)) {
            logger.warn({ echoed: echoedUserMessageUuids(frame), turnId: currentTurn.id }, 'Ignoring a result frame that answers a different message than the current turn');
            return;
        }
        guard.onFrame(frame);
        pendingAdoptions = pendingAdoptions.filter((entry) => {
            // Stryker disable llm: PendingAdoption.setAt is always clock.now() at push time and never null/undefined, so `?? now()` is dead code
            if(!isPendingAdoptionStale(entry.setAt)) {
                return true;
            }
            // Stryker restore llm
            warnPendingAdoptionExpired(entry);
            return false;
        });
        if(currentTurn === null && isRootAssistantFrame(frame)) {
            if(awaitingTurnEnd) {
                // The conductor must NOT claim `currentTurn` here — a `/compact` turn may be
                // moments from taking it (see afterResult). The LEDGER has no such constraint,
                // and presence keys its synopsis handler off the ledger's turn, so open that
                // turn NOW, before notifyTurnSubscribers, rather than a frame later via the
                // sdk_frame dispatch below. Without this a turn whose only assistant frame lands
                // in this window never gets a handler at all and stays generic for its whole
                // life. `reduceSpontaneousTurnOpened` no-ops when a turn is already open, so the
                // dispatch is safe even though this branch cannot see the ledger's state.
                const at = now();
                ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId: bareNotificationTurnId(at), at });
            } else {
                beginSpontaneousTurn();
            }
        }
        currentTurn?.tracker.update(frame);
        notifyTurnSubscribers(frame);
        if(frame.type === 'system' && frame.subtype === 'task_notification') {
            // Every task_notification (re)starts the REOPEN_WAKE_SETTLE_MS window (#97), including
            // one for a task already finished, with an unchanged status, or whose finished record
            // was evicted past the ledger's cap: the SDK's wake follows the frame, not the ledger's
            // bookkeeping. Set here rather than in a ledger subscriber, which only hears of a
            // notification that changes the ledger.
            wakeSettleFrom = clock.now();
        }
        ledgerStore.dispatch({ type: 'sdk_frame', frame, at: now() });
        if(frame.type === 'system' && frame.subtype === 'compact_boundary') {
            // After the frame's own fold, so everything that hears of the completion (the journal,
            // processQueue, telemetry, the tuner) sees the ledger with this frame applied. The
            // guard has already released through guard.onFrame above, so compactionCompleted's
            // own guard release is a no-op here.
            compactionCompleted();
        }
        // Stryker disable llm: `void` is a compile-time-only marker here; dropping it does not change the runtime call or its fire-and-forget behavior
        if(frame.type === 'result') {
            void afterResult(frame);
        }
    }
    // Stryker restore llm

    /**
     * Opens exactly one fresh `queryFn` call, resolving once the session id is captured or
     * rejecting on an immediate throw. Assigns `currentQueue`/`currentHandleRef` synchronously as
     * part of settling, so a frame processed in the very same callback already sees the new
     * handle as current.
     *
     * `handshakeText` is pushed onto the new handle's queue as a `boot`-kind (`shouldQuery:false`)
     * envelope IMMEDIATELY, before any frame is awaited: with a streaming-input prompt the SDK CLI
     * emits nothing at all — not even `system/init`, the frame that carries the session id — until
     * it has read its first user message (verified against SDK 0.3.258 on 2026-09-06: a silent
     * open sat frameless past 30 s; a `shouldQuery:false` first message produced `init` plus a
     * bare `result` in under a second, with no model turn). Without this push, `open()` would
     * never resolve.
     *
     * That bare result is NOT reliably before the next user message: on SDK 0.3.280 it follows
     * init by 0.5-1.7 ms in a separate stdout read, and a querying message pushed in the meantime
     * (a submit right after open, or the held envelope a reopen plays at once) is read by the CLI
     * first. Every `shouldQuery:false` message — this handshake and every
     * {@link Conductor.appendWithoutTurn} — gets such a result, which the handle's
     * {@link InputQueue} claims by its echoed wire uuid before it can reach {@link onFrame} (see
     * `session.ts`); its running cost total comes back through {@link noteAcknowledgedCost},
     * flagged as the restored baseline only when it echoes this handshake's wire uuid.
     *
     * A `result` frame arriving before `system/init` settles this open is dropped: that is how a
     * failed resume reports itself (an `error_during_execution` result with no echo, then the
     * generator throws and `onClosed` rejects), and it is not the result of any turn.
     *
     * `cause` is handed to {@link CreateConductorParams.buildOptions} with the resume id, so the
     * query's own hooks know why it was opened (see that field's doc).
     */
    async function openWithHandle(resumeId: string | undefined, handshakeText: string, cause: SessionOpenCause): Promise<{ handle: SessionHandle, sessionId: string }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const queue = new InputQueue();
            const interrupting = createInterruptFlag();
            const options = buildOptions(resumeId, cause);
            // Counted here, at the single point where a query's options are actually built, so
            // `maybeStartRequestedReopen` can tell "a query already captured the new prompt" from
            // "every live query predates the request" without comparing handle identities.
            // Stryker disable next-line NumberLiteralValue: openGeneration is only compared with > against earlier snapshots, so any positive step decides identically (see the same reasoning on its initial 0)
            openGeneration += 1;
            const handshakeUuid = queue.push(toSdkUserMessage(buildBootEnvelope(handshakeText, now())));
            const handle = openSession({
                role,
                queryFn,
                options,
                queue,
                interrupting,
                onFrame: (frame) => {
                    if(!settled && frame.type === 'result') {
                        logger.warn({ subtype: frame.subtype }, 'Session emitted a result before system/init; not a turn result');
                        return;
                    }
                    onFrame(frame);
                    if(!settled) {
                        const id = handle.sessionId();
                        if(id !== undefined) {
                            settled = true;
                            currentQueue = queue;
                            currentHandleRef = handle;
                            resolve({ handle, sessionId: id });
                        }
                    }
                },
                onAcknowledgement: (frame) => {
                    noteAcknowledgedCost(handle, frame.total_cost_usd, echoedUserMessageUuids(frame).includes(handshakeUuid));
                },
                onClosed: (error) => {
                    if(!settled) {
                        // openSession calls onClosed once, after its terminal reader-loop exit;
                        // rejecting this one-shot Promise needs no additional local state change.
                        reject(toError(error, 'Session closed before it opened'));
                        return;
                    }
                    if(handle === currentHandleRef) {
                        void handleMidLifeClosed(error);
                    }
                },
            });
        });
    }

    /**
     * Folds the running `total_cost_usd` a `shouldQuery:false` acknowledgement from `handle`
     * carries into the ledger — never as a turn result. The handshake's acknowledgement
     * (`restoresBaseline`) is a `cost_baseline`: the only way a resumed session's restored total
     * (which `session_opened` zeroes) comes back before its first turn's result, so that turn is
     * charged only its own delta and the daily cost ceiling does not re-book history. Any later
     * acknowledgement is a `cost_update`: live spend (`total_cost_usd` includes background
     * subagent work that can land between turns), which the ceiling books. Ignored unless
     * `handle` is current (a discarded handle's late frames are not this session's). Held when it
     * lands between this handle's `system/init` and its `finishOpen`, whose `session_opened` reset
     * would otherwise wipe it; `finishOpen` applies it after that reset as a baseline, since no
     * query has run on the handle by then.
     */
    function noteAcknowledgedCost(handle: SessionHandle, cumulativeUsd: number, restoresBaseline: boolean): void {
        if(handle !== currentHandleRef) {
            return;
        }
        if(handle === costBaselineHandle) {
            ledgerStore.dispatch({ type: restoresBaseline ? 'cost_baseline' : 'cost_update', cumulativeUsd, at: now() });
            return;
        }
        earlyCostBaseline = cumulativeUsd;
    }

    async function finishOpen(sessionId: string, { outcome, cause }: { outcome: SessionOpenOutcome, cause: SessionOpenCause }): Promise<void> {
        currentSessionId = sessionId;
        opened = true;
        const at = now();
        journal.append({
            type: 'session_opened', at, role, sessionId, outcome, cause,
        });
        ledgerStore.dispatch({ type: 'session_opened', sessionId, at });
        costBaselineHandle = currentHandleRef;
        if(earlyCostBaseline !== undefined) {
            ledgerStore.dispatch({ type: 'cost_baseline', cumulativeUsd: earlyCostBaseline, at });
            earlyCostBaseline = undefined;
        }
        // After the dispatch, which resets the task list and so would restart the window: the new
        // session has no wake of the old one's left to wait for (#97).
        wakeSettleFrom = undefined;
        await resumeStore.save(role, sessionId);
    }

    /** The opening handshake for {@link open}: `bundle` (this attempt's {@link buildBoundedBundle}) when non-empty, else a bare open/resume marker. */
    function openHandshakeText(resuming: boolean, bundle: string): string {
        if(bundle !== '') {
            return bundle;
        }
        const verb = resuming ? 'resumed' : 'opened';
        return `[BOOT] Session ${verb} at ${now().toISOString()}. No boot context to report. Host handshake — nothing to do, no reply expected.`;
    }

    /**
     * Descriptions of the BACKGROUND tasks the ledger shows running, in start order. Taken
     * synchronously where a reopen starts, before the old handle is discarded or anything is
     * opened: the replacement's `finishOpen` dispatches `session_opened`, which clears the ledger's
     * task list (journaling each as `task_lost`). Foreground tasks are left out — they belong to the
     * turn a crash interrupted, which is either re-queued and re-run (a host-pushed turn) or named
     * in the handshake as cut off (an adopted one, #99) — and a requested reopen only ever starts
     * while idle, when no foreground task is left.
     */
    function runningBackgroundTaskDescriptions(): string[] {
        return ledgerStore.get().tasks.filter(task => task.background).map(task => task.description);
    }

    /**
     * The `[BOOT]` handshake for an in-process reopen. The model cannot see this code, so the text
     * spells the situation out: why the session was replaced, that the host process never stopped
     * (so nothing queued was lost), and — only when there were any — which background tasks the
     * old session process was running, which were most likely terminated with it.
     *
     * The task wording is deliberately cautious ("do not wait for a result from them"): the list is a snapshot,
     * and a task can still finish, and its notification still land, between the snapshot and the
     * replacement's open (a discarded reader keeps delivering already-buffered frames).
     *
     * When a crash cut off an adopted turn (#99), one more paragraph, right after the continuity
     * one, says so and that it will not be sent again: a resumed transcript already holds its
     * input, while a fresh one never saw it, so the fresh fallback quotes it.
     *
     * @param handshake `why` completes "Session reopened at <time> because …";
     *   `backgroundTasks` is {@link runningBackgroundTaskDescriptions}, taken where the reopen
     *   started; `cutOffTurn` is the adopted turn a crash cut off, when there was one
     * @param resumed Whether this attempt resumes the old transcript, or is the fresh fallback after that failed
     * @param bundle The fresh fallback's boot bundle (#98), appended as the last paragraph after
     *   the #62 explanation; `''` for a resume, or when the fallback's build produced nothing. The
     *   continuity sentence only claims a re-seed when there is one to read.
     */
    function reopenHandshakeText({ why, backgroundTasks, cutOffTurn }: ReopenHandshake, resumed: boolean, bundle = ''): string {
        let continuity = 'This same conversation was resumed, so this was not an offline gap: messages waiting for you were kept and will still be delivered, and no conversation was lost.';
        if(!resumed) {
            const reseed = bundle === ''
                ? 'so this is a new session transcript, and earlier context from it is not available to you.'
                : 'so this is a new session transcript. Your working memory is re-seeded below.';
            continuity = `The previous conversation could not be resumed, ${reseed} It was still not an offline gap: messages waiting for you were kept and will still be delivered.`;
        }
        const paragraphs = [
            `[BOOT] Session reopened at ${now().toISOString()} because ${why}. The host process kept running throughout; only the session process was replaced.`,
            continuity,
        ];
        if(cutOffTurn !== undefined) {
            paragraphs.push(cutOffTurnParagraph(cutOffTurn, resumed));
        }
        if(backgroundTasks.length > 0) {
            paragraphs.push([
                'Background tasks you had started in the previous session process were still running when it ended. They may have been stopped, or may still be running with no way to report back to you — either way, do not wait for a result from them:',
                ...backgroundTasks.map(description => `- ${description}`),
                'If you still need a result from one of them, check whether it finished and re-run it if needed. If one finished just before the reopen, its result may already be in the transcript.',
            ].join('\n'));
        }
        paragraphs.push('Host handshake — no reply expected.');
        if(bundle !== '') {
            paragraphs.push(bundle);
        }
        return paragraphs.join('\n\n');
    }

    function appendWithoutTurn(envelope: AccumulationEnvelope): boolean {
        // Tested BEFORE `reopening`: a shutting-down conductor must refuse rather than buffer,
        // because the buffer a reopen unwinding into `shutdown` discards is exactly the
        // "reported accepted, then silently dropped" loss the boolean exists to prevent.
        if(shuttingDown) {
            return false;
        }
        if(reopening) {
            // Held, not dropped, and reported as accepted: the caller burns its dedupe key on a
            // `true`, and a session being replaced is a transient state the envelope should
            // survive. Flushed onto the replacement queue by `reopenReplacementSession`.
            bufferedAppends.push(toSdkUserMessage(envelope));
            return true;
        }
        // Stryker disable llm: currentQueue is InputQueue | undefined and never null, so === undefined and == null match the same values
        if(currentQueue === undefined) {
            return false;
        }
        // Stryker restore llm
        // Deliberately does NOT dispatch `envelope_queued`: that ledger event is only ever
        // balanced by `turn_submitted` (see `enqueue`/`beginTurn`), and this seam by construction
        // never opens a turn — dispatching it here would permanently inflate `ledger.queued.other`
        // for the life of the process (see Q5 review finding).
        currentQueue.push(toSdkUserMessage(envelope));
        return true;
    }

    /**
     * Boot-time crash recovery (P8), run once at the start of {@link open}: reads the journal
     * window ending now, derives {@link import('./recovery').computeRecovery}'s lost tasks and
     * undelivered envelopes, journals a `task_lost` entry for each lost task (the process that
     * started them never got to), seeds {@link deliveryGuard} from the recovered
     * `deliveredEnvelopeIds` so {@link deliver} cannot re-send anything a prior process already
     * confirmed sent, and returns the recovered lost-task/undelivered descriptions for each open
     * attempt's {@link buildBoundedBundle}.
     *
     * Builds no bundle itself (#98): a builder failure must never reach this function's catch,
     * which would replace the recovery-seeded guard with an empty one and reopen the double-send
     * hole the guard exists to close.
     *
     * Never rejects: a `journal.readSince` failure (DynamoDB throttled/unavailable) is logged and
     * degrades to an empty-seeded {@link deliveryGuard} and empty recovery lists — the
     * conductor still opens rather than never starting at all. The accepted risk is a possible
     * double-send for whatever the crashed process had already delivered; that is far preferable
     * to `open()` never resolving.
     */
    async function runBootRecovery(): Promise<Pick<BootBundleRequest, 'lostTasks' | 'undelivered'>> {
        try {
            const entries = await journal.readSince(clock.now() - RECOVERY_WINDOW_MS);
            // Stryker disable next-line llm: computeRecovery is a pure readonly fold, so a shallow entries copy is unobservable
            const recovery = computeRecovery(entries);

            for(const lostTask of recovery.lostTasks) {
                journal.append({
                    type: 'task_lost', at: now(), taskId: lostTask.taskId, description: lostTask.description,
                });
            }

            deliveryGuard = createDeliveryGuard(recovery.deliveredEnvelopeIds);

            return {
                lostTasks:   recovery.lostTasks.map(task => task.description ?? task.taskId),
                // Stryker disable next-line llm: an unused shallow copy before this read-only map cannot affect output
                undelivered: recovery.undelivered.map(envelope => envelope.responseText ?? `${envelope.envelopeKind} envelope ${envelope.envelopeId}`),
            };
        } catch (error) {
            logger.error({ error }, 'Conductor boot recovery failed; opening with an empty-seeded delivery guard');
            deliveryGuard = createDeliveryGuard([]);
            return { lostTasks: [], undelivered: [] };
        }
    }

    /**
     * Runs {@link buildBootBundle} for one open attempt, bounded by
     * {@link BOOT_BUNDLE_BUILD_TIMEOUT_MS} on the injected clock (#98). Never rejects: a rejection,
     * a synchronous throw or the timeout is logged and answered with
     * {@link renderBootBundleFallback}'s recovery-only text, or `''` (the bare marker). The timer is
     * cleared as soon as the build settles; a result arriving after the timeout is ignored.
     */
    async function buildBoundedBundle(request: BootBundleRequest): Promise<string> {
        if(buildBootBundle === undefined) {
            return '';
        }
        const build = buildBootBundle;
        let timer!: TimerHandle;
        const timedOut = new Promise<never>((_resolve, reject) => {
            // Promise executors run synchronously, so this is assigned before the race below.
            timer = clock.setTimer(() => {
                reject(new Error(`Boot bundle build did not finish within ${BOOT_BUNDLE_BUILD_TIMEOUT_MS} ms`));
            }, BOOT_BUNDLE_BUILD_TIMEOUT_MS);
        });
        try {
            // The async wrapper turns a synchronous throw from `build` into a rejection.
            return await Promise.race([(async () => build(request))(), timedOut]);
        } catch (error) {
            logger.warn({ error, kind: request.kind, cause: request.cause }, 'Boot bundle build failed or timed out; opening with the recovery-only fallback');
            return renderBootBundleFallback?.(request) ?? '';
        } finally {
            clock.clearTimer(timer);
        }
    }

    /**
     * {@link openWithHandle} for {@link open} (#98). Refuses to spawn once shutdown has begun (the
     * bundle build before it is an await shutdown can overtake), and closes a handle that settles
     * after shutdown began: `shutdown()` only closes the handle current when it finishes, and never
     * waits for an initial open, so a child settling afterwards would outlive the process.
     */
    async function openForBoot(resumeId: string | undefined, handshakeText: string): Promise<{ handle: SessionHandle, sessionId: string }> {
        if(shuttingDown) {
            throw shutDownDuringOpenError();
        }
        const result = await openWithHandle(resumeId, handshakeText, 'boot');
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the await lets shutdown() set shuttingDown despite TypeScript retaining the narrowing from the check above
        if(shuttingDown) {
            discardHandle(result.handle);
            throw shutDownDuringOpenError();
        }
        return result;
    }

    /** Rejects the turn a crash interrupted when its reopen is abandoned; a no-op on the controlled path, which has none. */
    function rejectInFlightItem(inFlightItem: QueuedItem | undefined, error: Error): void {
        if(inFlightItem !== undefined) {
            clearAbortListener(inFlightItem);
            inFlightItem.deferred.reject(error);
        }
    }

    /** Rejects and drains every item still waiting in `pendingQueue`, in queue order. */
    function rejectAllQueued(error: Error): void {
        const queued = pendingQueue.splice(0);
        for(const item of queued) {
            clearAbortListener(item);
            item.deferred.reject(error);
        }
    }

    /**
     * Discards a handle this conductor is about to replace with another one, closing it without
     * letting its `onClosed` callback run {@link handleMidLifeClosed} again — that callback only
     * reopens when the closed handle is still `currentHandleRef`, so clearing the reference first
     * (when `handle` is in fact still current) makes the close a deliberate no-op from the
     * reopen machinery's point of view.
     */
    function discardHandle(handle: SessionHandle): void {
        if(currentHandleRef === handle) {
            currentHandleRef = undefined;
            currentQueue = undefined;
        }
        handle.close();
    }

    /**
     * Opens the replacement for a session that has gone away — resuming the old id, falling back
     * to a fresh session when the resume fails, and giving up (rejecting the in-flight and queued
     * work) when both fail. Shared by the crash path ({@link handleMidLifeClosed}) and the
     * controlled path ({@link startRequestedReopen}); the caller has already set `reopening` and
     * cleared any running turn.
     *
     * Carries over whatever the dying queue never delivered: messages still sitting in the old
     * {@link InputQueue} were by construction never read by the SDK (the iterator only hands one
     * out by shifting it off), and accumulate-only appends made during the reopen are buffered —
     * both are pushed onto the replacement's queue after its boot handshake, so a notification is
     * neither lost nor delivered twice.
     *
     * @param handshake What the `[BOOT]` text pushed onto the replacement's queue before any frame
     *   is awaited says — mandatory, because the SDK emits nothing at all (not even `system/init`)
     *   until it has read a first user message. Rendered per attempt by {@link reopenHandshakeText},
     *   so the fresh fallback does not claim the conversation was resumed; `backgroundTasks` is the
     *   caller's {@link runningBackgroundTaskDescriptions} snapshot, taken before any close or open,
     *   and `cutOffTurn` the adopted turn a crash already settled as failed (#99), if any.
     *   Only the fresh fallback builds a boot bundle (#98), after the resume has failed, and
     *   appends it to its handshake; if shutdown began during that build, nothing is spawned.
     * @param inFlightItem The host-pushed turn a crash interrupted, re-queued ahead of
     *   everything else on success and rejected if the reopen is abandoned or shutdown overtakes
     *   it (shutdown's own `rejectAllQueued` cannot reach it); `undefined` for an adopted or
     *   spontaneous turn (the SDK started those itself, so they are never re-sent — #99), when
     *   nothing was running, and on the controlled path, which only ever runs while idle.
     * @param carryOver Messages the dying queue never delivered, taken by the CALLER: the
     *   controlled path has to `discardHandle` the old handle first (so its `onClosed` is not read
     *   as a crash), and `discardHandle` clears `currentQueue`, so by the time this function runs
     *   there is no dying queue left to ask.
     * @param cause Which of the two paths this is, journaled on the replacement's `session_opened`.
     */
    async function reopenReplacementSession(handshake: ReopenHandshake, inFlightItem: QueuedItem | undefined, carryOver: SDKUserMessage[], cause: 'crash_reopen' | 'requested_reopen'): Promise<void> {
        try {
            try {
                const { handle, sessionId } = await openWithHandle(currentSessionId, reopenHandshakeText(handshake, true), cause);
                try {
                    await finishOpen(sessionId, { outcome: 'resumed', cause });
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
            } catch{
                // Built only now that the resume has failed: a resumed transcript needs no bundle.
                // The reopen handshake already names what the reopen cut off, so no recovery.
                const bundle = await buildBoundedBundle({ kind: 'fresh', cause, lostTasks: [], undelivered: [] });
                // If shutdown() began during the build, spawning now would only create a child to
                // close at once; the shutdown branch below abandons the reopen instead.
                if(!shuttingDown) {
                    const { sessionId } = await openWithHandle(undefined, reopenHandshakeText(handshake, false, bundle), cause);
                    await finishOpen(sessionId, { outcome: 'resume_fallback', cause });
                }
            }
        } catch (reopenError) {
            reopening = false;
            opened = false;
            bootPhase = 'failed';
            // The fresh-open fallback may itself have opened a live handle before its own
            // finishOpen rejected — close it rather than merely dropping the reference, which
            // would otherwise leak the CLI subprocess.
            if(currentHandleRef !== undefined) {
                discardHandle(currentHandleRef);
            }
            const failure = toError(reopenError, 'Conductor failed to reopen the session');
            logger.error({ error: failure }, 'Conductor could not reopen the session after it closed unexpectedly; giving up');
            rejectInFlightItem(inFlightItem, failure);
            rejectAllQueued(failure);
            logger.warn({ dropped: carryOver.length + bufferedAppends.length }, 'Giving up on a reopen; dropping input the dead session never delivered');
            bufferedAppends = [];
            return;
        }
        if(shuttingDown) {
            // shutdown() began while this open was in flight. discardHandle cleared
            // currentHandleRef before the close, so shutdown's own final close would find nothing
            // and this brand-new child would outlive the process it belongs to.
            if(currentHandleRef !== undefined) {
                discardHandle(currentHandleRef);
            }
            // The interrupted turn was taken out of currentTurn by the crash and is not in
            // pendingQueue, so shutdown()'s rejectAllQueued never reached it: settle it here, or
            // its submit() promise stays pending for the life of the process.
            rejectInFlightItem(inFlightItem, new Error('Conductor is shutting down'));
            // `reopening` is deliberately NOT cleared: `shuttingDown` is terminal, and every
            // reader of `reopening` (submitCompact, processQueue, appendWithoutTurn,
            // maybeStartRequestedReopen) tests `shuttingDown` first, so nothing consults it again.
            bufferedAppends = [];
            return;
        }
        reopening = false;
        // Only the carried-over shouldQuery:false messages are replayed. A querying message can
        // only have been pushed by beginTurn — the one place that pushes one — for the turn then in
        // flight, so an unread one is the crashed turn's own prompt, which re-queuing inFlightItem
        // below pushes again (under a fresh wire uuid); replaying it too would run that turn twice.
        // (An adopted turn in flight pushed nothing, so it leaves no querying message behind.)
        // A requested reopen only starts while idle, so its carry-over never holds one.
        for(const message of [...carryOver.filter(carried => carried.shouldQuery === false), ...bufferedAppends]) {
            currentQueue?.push(message);
        }
        bufferedAppends = [];
        if(inFlightItem !== undefined) {
            pendingQueue.unshift(inFlightItem);
        }
        // Stryker disable next-line llm: processQueue is a local function declaration and is always defined at this call site.
        processQueue();
    }

    /**
     * The item a crash reopen re-queues from the turn it interrupted: only a turn the host pushed
     * itself (`beginTurn` set its {@link ActiveTurn.wireUuid}), whose input the replacement
     * session must be sent again. `undefined` when nothing was running, for a bare spontaneous
     * turn, and for an adopted wake/peer turn (#99) — `mode`/`kind` cannot tell these apart, since
     * an adopted wake's envelope is a `mode: 'query'`, `kind: 'task'` one like a submitted task's.
     */
    function hostPushedItem(turn: ActiveTurn | null): QueuedItem | undefined {
        return turn?.wireUuid === undefined ? undefined : turn.item;
    }

    /**
     * Settles an adopted (SDK-started) turn a crash cut off (#99): the model already read its
     * input, so re-sending it would hand the model the same text a second time. It fails instead
     * (journaled `turn_failed`; an adopted wake's delivery sees a reply-less failure and sends
     * nothing), and the returned description goes into the reopen handshake. A no-op returning
     * `undefined` when nothing was running, for a bare spontaneous turn (no item to settle), and
     * for a host-pushed turn, which {@link hostPushedItem} re-queues instead.
     */
    function settleCutOffAdoptedTurn(turn: ActiveTurn | null): CutOffAdoptedTurn | undefined {
        if(turn?.item === undefined || turn.wireUuid !== undefined) {
            return undefined;
        }
        const { item } = turn;
        logger.warn({ envelopeId: item.envelope.id, kind: turn.kind }, 'A session crash cut off an SDK-started turn; settling it as failed and naming it in the reopen handshake instead of re-sending it');
        failTurn(turn, item, new Error(ADOPTED_TURN_CUT_OFF_ERROR), ledgerStore.get().context.percentage);
        return { description: describeAdoptedTurn(item.envelope), text: item.envelope.text };
    }

    async function handleMidLifeClosed(error: unknown): Promise<void> {
        if(shuttingDown) {
            return;
        }
        logger.error({ error }, 'Session ended unexpectedly; reopening');
        reopening = true;
        const interrupted = currentTurn;
        if(interrupted?.escalationTimer !== undefined) {
            clock.clearTimer(interrupted.escalationTimer);
        }
        currentTurn = null;
        // Stryker disable next-line CallExpression: turnEndedWaiters is only ever populated by shutdown()'s waitForTurnEnd(), which only runs once shuttingDown is true — and the check above already returns before this line whenever shuttingDown is true, so the array this splices is always empty here
        resolveTurnEndedWaiters();
        // Taken before any open: openWithHandle reassigns currentQueue as part of settling.
        const carryOver = currentQueue?.takePending() ?? [];
        // Also before any open: the replacement's finishOpen clears the ledger's task list. An
        // adopted turn is settled here, before any reopen attempt, so neither an abandoned reopen
        // nor a shutdown can leave it pending (#99).
        const handshake: ReopenHandshake = {
            why:             'the previous session process ended unexpectedly (it crashed or was killed)',
            backgroundTasks: runningBackgroundTaskDescriptions(),
            cutOffTurn:      settleCutOffAdoptedTurn(interrupted),
        };
        reopenInFlight = reopenReplacementSession(handshake, hostPushedItem(interrupted), carryOver, 'crash_reopen');
        // Stryker disable next-line AwaitDrop: onClosed discards this wrapper promise, while lifecycle synchronization observes the separately assigned reopenInFlight promise directly.
        await reopenInFlight;
    }

    /**
     * Runs a requested reopen against `handle`. `reopening` is set first so nothing is pushed into
     * the dying handle's queue, and `discardHandle` clears `currentHandleRef` BEFORE closing, so
     * the handle's own `onClosed` does not mistake this deliberate close for a crash.
     */
    async function startRequestedReopen(reason: string, handle: SessionHandle): Promise<void> {
        reopening = true;
        logger.info({ reason }, 'Reopening the session on request');
        // Both taken BEFORE discardHandle, which clears currentQueue along with currentHandleRef and
        // closes the session process the background tasks were running in.
        const carryOver = currentQueue?.takePending() ?? [];
        const backgroundTasks = runningBackgroundTaskDescriptions();
        discardHandle(handle);
        await reopenReplacementSession(
            { why: `the host deliberately closed the previous session process to apply ${reason}`, backgroundTasks },
            undefined,
            carryOver,
            'requested_reopen'
        );
    }

    /** (Re)arms the single {@link reopenRecheckTimer} to run {@link maybeStartRequestedReopen} after `delayMs`, replacing any timer already armed. */
    function armReopenRecheck(delayMs: number): void {
        clearReopenRecheck();
        reopenRecheckTimer = clock.setTimer(maybeStartRequestedReopen, delayMs);
    }

    function clearReopenRecheck(): void {
        // Stryker disable next-line ConditionalExpression: clearing with no timer armed is a no-op on every Clock (clearTimeout(undefined) and the fake's unknown-id lookup both do nothing), so an always-true guard is indistinguishable
        if(reopenRecheckTimer !== undefined) {
            clock.clearTimer(reopenRecheckTimer);
        }
    }

    /** Pending adoptions not yet past {@link PENDING_WAKE_TTL_MS}, oldest first: each is a turn the SDK has already started. */
    function freshPendingAdoptions(): PendingAdoption[] {
        return pendingAdoptions.filter(entry => !isPendingAdoptionStale(entry.setAt));
    }

    /** When the {@link REOPEN_WAKE_SETTLE_MS} window opened by {@link wakeSettleFrom} ends; `-Infinity` (so never running) before any sign in this session. The window is running while `now < ` this. */
    function wakeSettleEnd(): number {
        return (wakeSettleFrom ?? Number.NEGATIVE_INFINITY) + REOPEN_WAKE_SETTLE_MS;
    }

    /**
     * When a requested reopen should next be re-evaluated, or `undefined` if nothing holds it any
     * more (#97). Until `config.reopenTaskWaitMs` after the first request, it is held while any of:
     * - a background task is still running (released by the task leaving, which re-arms the recheck at once);
     * - a pending wake or peer adoption is still fresh: the SDK has started that turn but its first
     *   assistant frame has not arrived, and closing now would kill it (released when it goes stale,
     *   at `setAt + PENDING_WAKE_TTL_MS + 1`, the first instant {@link isPendingAdoptionStale} is true);
     * - the {@link REOPEN_WAKE_SETTLE_MS} window is running (released when it ends).
     *
     * Returns the EARLIEST of the active holds' boundaries, clamped to the deadline, so the one
     * recheck timer never fires later than the deadline; each recheck recomputes from scratch. A
     * hold that is not active contributes the deadline itself, which the clamp absorbs.
     */
    function reopenHoldUntil(pending: NonNullable<typeof pendingReopen>): number | undefined {
        const at = clock.now();
        const deadline = pending.firstRequestedAt + config.reopenTaskWaitMs;
        if(at >= deadline) {
            return undefined;
        }
        const tasksRunning = runningBackgroundTaskDescriptions().length > 0;
        const [oldestAdoption] = freshPendingAdoptions();
        const settleEnd = wakeSettleEnd();
        const settling = at < settleEnd;
        if(!tasksRunning && oldestAdoption === undefined && !settling) {
            return undefined;
        }
        return Math.min(
            deadline,
            oldestAdoption === undefined ? deadline : oldestAdoption.setAt + PENDING_WAKE_TTL_MS + 1,
            settling ? settleEnd : deadline
        );
    }

    /** One line per adoption for {@link warnIfReopenCutsWorkShort}'s log. */
    function describeAdoption(entry: PendingAdoption): Record<string, string | number> {
        if(entry.kind === 'wake') {
            return { kind: 'wake', ...entry.wake, setAt: entry.setAt };
        }
        return { kind: 'peer', envelopeId: entry.envelope.id, setAt: entry.setAt };
    }

    /**
     * Logs what a requested reopen starting now cuts short. Anything listed here only survives to
     * this point because `config.reopenTaskWaitMs` ran out ({@link reopenHoldUntil} holds for all of
     * it before then). Running background tasks are also named in the reopen handshake; a result
     * still on its way (a fresh pending adoption, or a task that finished within
     * {@link REOPEN_WAKE_SETTLE_MS}) is not, since the task itself is no longer running, so the log
     * is the only record of it.
     */
    function warnIfReopenCutsWorkShort(pending: NonNullable<typeof pendingReopen>): void {
        const at = clock.now();
        const waitedMs = at - pending.firstRequestedAt;
        const tasks = runningBackgroundTaskDescriptions();
        if(tasks.length > 0) {
            logger.warn({ reason: pending.reason, tasks, waitedMs }, 'Reopening the session with background tasks still running: the wait for them (reopenTaskWaitMs) ran out, so the reopen handshake lists them as cut off');
        }
        const adoptions = freshPendingAdoptions();
        const settling = at < wakeSettleEnd();
        if(adoptions.length > 0 || settling) {
            logger.warn(
                { reason: pending.reason, waitedMs, pendingAdoptions: adoptions.map(entry => describeAdoption(entry)), settling },
                'Reopening the session although a result may not have reached the model yet: the wait (reopenTaskWaitMs) ran out while a background task\'s wake or a peer message was still pending adoption, or within REOPEN_WAKE_SETTLE_MS of a task finishing; the reopen handshake does not mention it'
            );
        }
    }

    /**
     * Starts a pending controlled reopen if the session is idle and still needs one. Called from
     * {@link requestReopen}, from the end of {@link open}, from {@link processQueue} — which is
     * where every turn end and every completed reopen lands — and from the recheck timer.
     *
     * An idle session can still hold the reopen for its background work (#97; see
     * {@link reopenHoldUntil}): the recheck timer is then armed for the next boundary, and no new
     * turn starts meanwhile ({@link processQueue} keeps its gate), so this is a bounded
     * best-effort drain, not a guarantee that every result was delivered. Every call that gets past
     * the idle check clears the timer first, so none is left armed once the request is started,
     * dropped or re-held.
     */
    function maybeStartRequestedReopen(): void {
        const pending = pendingReopen;
        if(pending === undefined || currentTurn !== null || awaitingTurnEnd || shuttingDown || reopening) {
            return;
        }
        clearReopenRecheck();
        if(openGeneration > pending.atGeneration) {
            // A query has already been created from options built after the request — the initial
            // open, or a crash reopen that overtook it — so it already carries what was asked for.
            pendingReopen = undefined;
            logger.debug({ reason: pending.reason }, 'Dropping a requested reopen an intervening open already satisfied');
            return;
        }
        const handle = currentHandleRef;
        if(handle === undefined) {
            // Not open yet (or between handles); the end of open() calls back here.
            return;
        }
        const holdUntil = reopenHoldUntil(pending);
        if(holdUntil !== undefined) {
            armReopenRecheck(holdUntil - clock.now());
            if(!pending.deferralLogged) {
                pending.deferralLogged = true;
                logger.info(
                    { reason: pending.reason, tasks: runningBackgroundTaskDescriptions(), waitAtMostMs: pending.firstRequestedAt + config.reopenTaskWaitMs - clock.now() },
                    'Deferring a requested reopen until the old session\'s background work has finished and its result has had a chance to reach the model (bounded by reopenTaskWaitMs)'
                );
            }
            return;
        }
        warnIfReopenCutsWorkShort(pending);
        pendingReopen = undefined;
        reopenInFlight = startRequestedReopen(pending.reason, handle);
        void reopenInFlight;
    }

    function requestReopen(reason: string): void {
        if(shuttingDown) {
            return;
        }
        // Overwrites any earlier pending request rather than branching on one: a later request is
        // strictly newer, and its own generation is what decides redundancy. The wait bound keeps
        // running from the first request still pending (#97).
        pendingReopen = {
            reason, atGeneration: openGeneration, firstRequestedAt: pendingReopen?.firstRequestedAt ?? clock.now(), deferralLogged: false,
        };
        journal.append({ type: 'session_reopen_requested', at: now(), role, reason });
        maybeStartRequestedReopen();
    }

    /**
     * Boot open (#98): each attempt builds its own bundle just before its query — `restart_resume`
     * for the stored session, `fresh` for a fresh open or the fallback after that resume failed, so
     * a brand-new transcript is never handed a resume-only bundle. Shutdown during any of it rejects
     * rather than falling back (see {@link openForBoot}). Wrapped by {@link open}, which only
     * records {@link bootPhase} around it.
     */
    async function openBoot(): Promise<{ sessionId: string, resumed: boolean }> {
        const recovery = await runBootRecovery();
        const stored = await resumeStore.load(role);
        if(stored !== undefined) {
            try {
                const bundle = await buildBoundedBundle({ kind: 'restart_resume', cause: 'boot', ...recovery });
                const { handle, sessionId } = await openForBoot(stored, openHandshakeText(true, bundle));
                try {
                    await finishOpen(sessionId, { outcome: 'resumed', cause: 'boot' });
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
                maybeStartRequestedReopen();
                return { sessionId, resumed: true };
            } catch (error) {
                if(shuttingDown) {
                    throw error;
                }
                logger.warn({ error }, 'Resuming the stored session failed; opening a fresh session');
            }
        }
        const bundle = await buildBoundedBundle({ kind: 'fresh', cause: 'boot', ...recovery });
        const { sessionId } = await openForBoot(undefined, openHandshakeText(false, bundle));
        await finishOpen(sessionId, stored === undefined ? { outcome: 'fresh', cause: 'boot' } : { outcome: 'resume_fallback', cause: 'boot' });
        maybeStartRequestedReopen();
        return { sessionId, resumed: false };
    }

    /** {@link openBoot}, bracketed by the {@link bootPhase} bookkeeping {@link currentLifecycle} reads; the open itself is unchanged. */
    async function open(): Promise<{ sessionId: string, resumed: boolean }> {
        bootPhase = 'opening';
        try {
            return await openBoot();
        } catch (error) {
            bootPhase = 'failed';
            throw error;
        }
    }

    /** The `status: 'withdrawn'` {@link TurnResult} for an envelope that never reached the SDK because its `signal` aborted while it was still held — so it has no partial work, and only the caller's signal can have withdrawn it. */
    function withdrawnResult(item: QueuedItem): TurnResult {
        return {
            status:              'withdrawn',
            envelopeId:          item.envelope.id,
            response:            null,
            sessionId:           currentSessionId,
            contextUsagePercent: ledgerStore.get().context.percentage,
            cancellationSource:  'caller_signal',
        };
    }

    /**
     * Handles `item`'s `signal` firing `abort` (see {@link SubmitOptions.signal}): when `item` is
     * the turn currently running, interrupts it with source `'caller_signal'` (scoped to
     * `requestingChannelId` like any other interrupt), so {@link settleTurn} reports
     * `status: 'interrupted'` once it ends — unless another source interrupted it first, which
     * then stays the reported source; otherwise `item` is still only queued (whether idle, behind
     * this envelope's own channel's prior turn, or behind an unrelated channel's turn — the abort
     * contract withdraws rather than interrupting in every one of those cases) — removed from
     * `pendingQueue` and resolved `status: 'withdrawn'` without ever reaching `beginTurn`/the SDK.
     * A no-op if `item` has already settled by some other path (its listener is removed the
     * moment it does, so this only runs for an item still genuinely in flight).
     */
    function handleSubmitAbort(item: QueuedItem): void {
        clearAbortListener(item);
        if(currentTurn?.item === item) {
            void interruptCurrentTurnInternal('caller_signal', 'submit() signal aborted');
            return;
        }
        // Stryker disable next-line llm: a QueuedItem is enqueued at most once at a time (shifted out before beginTurn, re-queued only after), so indexOf === lastIndexOf over a queue of distinct references
        const index = pendingQueue.indexOf(item);
        // Stryker disable next-line llm: indexOf returns -1 or a non-negative integer, where `!== -1` and `> -1` agree
        if(index !== -1) {
            pendingQueue.splice(index, 1);
            item.deferred.resolve(withdrawnResult(item));
            return;
        }
        // Neither the running turn nor queued: either already settled by some other path (a
        // harmless no-op — resolving an already-settled deferred a second time is a no-op) or
        // waiting out a scheduleRetry backoff timer between attempts. Mark it so routeIncoming
        // (the timer's eventual callback) drops it instead of resubmitting a stale envelope whose
        // caller has already been told it was withdrawn.
        item.withdrawnWhileWaiting = true;
        item.deferred.resolve(withdrawnResult(item));
    }

    function submit(envelope: QueryEnvelope, options: SubmitOptions): Promise<TurnResult> {
        if(shuttingDown) {
            return Promise.reject(new Error('Conductor is shutting down'));
        }
        if(!opened) {
            return Promise.reject(new Error('Conductor is not open'));
        }
        return new Promise<TurnResult>((resolve, reject) => {
            const item: QueuedItem = {
                // Stryker disable next-line llm: priority is a required SubmitPriority and is only ever compared with 'urgent', which 0 (like undefined) never matches
                envelope, priority: options.priority, requestingChannelId: options.requestingChannelId, attempts: 1, deferred: { resolve, reject },
            };
            const { signal } = options;
            if(signal !== undefined) {
                // Stryker disable next-line llm: guarded by `signal !== undefined` two lines above, so the optional chain and `?? false` can never engage
                if(signal.aborted) {
                    resolve(withdrawnResult(item));
                    return;
                }
                const onAbort = (): void => {
                    handleSubmitAbort(item);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                item.abortCleanup = () => {
                    signal.removeEventListener('abort', onAbort);
                };
            }
            routeIncoming(item);
        });
    }

    async function deliver(envelopeId: string, send: () => Promise<SendOutcome>): Promise<DeliverResult> {
        if(deliveryGuard === undefined) {
            throw new InvariantViolationError('conductor.deliver', 'called before open() completed its boot recovery, which initialises the delivery guard');
        }
        if(deliveryGuard.alreadyDelivered(envelopeId)) {
            logger.info({ envelopeId }, 'Conductor.deliver: envelope already delivered; skipping send');
            return { outcome: 'already-committed' };
        }
        const outcome = await send();
        if(outcome.kind === 'skipped') {
            logger.info({ envelopeId, reason: outcome.reason }, 'Conductor.deliver: response skipped; not committing delivery');
            return { outcome: 'skipped' };
        }
        journal.append({
            type:        'response_delivered', at:          now(), envelopeId, channelId:   outcome.channelId,
            messageIds:  outcome.disposition === 'sent' ? outcome.messageIds : [], disposition: outcome.disposition,
        });
        await journal.flush();
        deliveryGuard.markDelivered(envelopeId);
        return { outcome: 'committed', disposition: outcome.disposition };
    }

    async function interruptCurrent(options: InterruptCurrentOptions = {}): Promise<void> {
        if(currentTurn === null) {
            return;
        }
        if(options.requestingChannelId !== undefined && currentTurn.channelId !== undefined && currentTurn.channelId !== options.requestingChannelId) {
            logger.warn({ requestingChannelId: options.requestingChannelId, turnChannelId: currentTurn.channelId }, 'interruptCurrent ignored: requesting channel does not own the running turn');
            return;
        }
        await interruptCurrentTurnInternal('interrupt_current', options.reason);
    }

    function subscribeTurn(handler: (turnId: string, frame: SDKMessage) => void): () => void {
        turnSubscribers.add(handler);
        return () => {
            turnSubscribers.delete(handler);
        };
    }

    /**
     * The {@link ConductorLifecycle} this conductor is in — a documented PROJECTION of its state,
     * not a state machine that forbids overlaps. Precedence, first match wins:
     *
     * 1. `'closed'` — {@link shutdown} has made its final close.
     * 2. `'closing'` — {@link shutdown} has begun. It can overtake a reopen still in flight, so
     *    it outranks `'reopening'`.
     * 3. `'reopening'` — a replacement for a session that went away is being opened.
     * 4. `'open'` — a session handle is current AND the `opened` flag {@link submit} gates on is
     *    set, so work can be owned. Both are needed: the handle alone is current from `system/init`
     *    on, a few continuations before `finishOpen` sets `opened`, and reporting `'open'` in that
     *    window would let a caller (the notification bridge) burn a dedupe key on a submit that
     *    rejects; the flag alone is left stale by a failed resume's discarded handle. A fresh open
     *    whose handle stayed live still reports `'open'` even if {@link open} then rejected (its
     *    `resumeStore.save` failed), since `finishOpen` set the flag before that save.
     * 5. {@link bootPhase} — `'new'`, `'opening'`, or `'failed'` (the last open rejected with no
     *    live handle, or a reopen gave up). `'failed'` is recoverable: calling {@link open}
     *    again moves it back through `'opening'`.
     */
    function currentLifecycle(): ConductorLifecycle {
        if(closed) {
            return 'closed';
        }
        if(shuttingDown) {
            return 'closing';
        }
        if(reopening) {
            return 'reopening';
        }
        if(currentHandleRef !== undefined && opened) {
            return 'open';
        }
        return bootPhase;
    }

    function status(): ConductorStatus {
        const lifecycle = currentLifecycle();
        return {
            role,
            sessionId:    currentSessionId,
            lifecycle,
            opened:       lifecycleAcceptsWork(lifecycle),
            shuttingDown: lifecycle === 'closing' || lifecycle === 'closed',
            queueLength:  pendingQueue.length,
            turn:         currentTurn === null
                ? null
                : {
                    kind: currentTurn.kind, channelId: currentTurn.channelId, envelopeId: currentTurn.item?.envelope.id, authorId: currentTurn.authorId,
                },
        };
    }

    /** Resolves after `ms` on `clock`, or as soon as `promise` settles — whichever comes first. */
    function raceAgainstTimeout(promise: Promise<void>, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = clock.setTimer(resolve, ms);
            void promise.then(() => {
                clock.clearTimer(timer);
                resolve();
                return undefined;
            });
        });
    }

    async function shutdown(options: ShutdownOptions): Promise<void> {
        if(shuttingDown) {
            return;
        }
        shuttingDown = true;
        // A requested reopen still waiting for background work (#97) never starts now; drop its
        // recheck so no timer outlives the conductor. Nothing re-arms it once shuttingDown is set.
        clearReopenRecheck();
        // Nothing still waiting in pendingQueue will ever be dequeued — processQueue() now
        // early-returns on shuttingDown forever — so settle those submit() promises now rather
        // than leaving them pending for the life of the process.
        rejectAllQueued(new Error('Conductor is shutting down'));

        let deadlineTimer!: TimerHandle;
        const deadline = new Promise<void>((resolve) => {
            // Promise executors run synchronously, so this is assigned before the race below.
            deadlineTimer = clock.setTimer(resolve, options.deadlineMs);
        });

        const graceful = (async (): Promise<void> => {
            // A replacement handle may be seconds from existing; awaiting the latest reopen
            // (inside the deadline race below) is what lets the final close find and close it.
            // Settled when no reopen ever ran, or when the last one is already done.
            await reopenInFlight;
            if(currentTurn !== null) {
                await raceAgainstTimeout(waitForTurnEnd(), options.turnWaitMs);
                // The turn may have ended while awaiting the waiter; avoid adding another await
                // on the no-op interrupt path because the hard-deadline race observes that turn.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- the await lets afterResult set currentTurn back to null despite TypeScript retaining the outer narrowing
                if(currentTurn !== null) {
                    await interruptCurrentTurnInternal('shutdown', 'shutdown turn-wait elapsed');
                }
            }
            if(currentSessionId !== undefined) {
                journal.append({ type: 'session_ended', at: now(), sessionId: currentSessionId });
            }
            journal.append({ type: 'shutdown', at: now() });
            try {
                await journal.flush();
            } catch (error) {
                // A rejecting flush must not prevent the close below — closing the handle is what
                // actually releases the CLI subprocess and the input queue, and a shutdown that
                // never reaches it hangs the host on exit.
                logger.error({ error }, 'Conductor shutdown: journal flush failed');
            }
        })();

        await Promise.race([graceful, deadline]);
        clock.clearTimer(deadlineTimer);
        currentHandleRef?.close();
        // Set before settling, so no frame the closed handle still forwards (see onFrame) can open
        // or settle a turn after this point.
        closed = true;
        settleTurnCutOffByShutdown();
    }

    return {
        open, submit, appendWithoutTurn, requestReopen, adoptWakeTurn, adoptPeerTurn, deliver, interruptCurrent, subscribeTurn, status, shutdown, compactionStarted, compactionCompleted,
        getCompactionThresholdPercent: () => guard.getThresholdPercent(),
        setCompactionThresholdPercent: (percent: number) => { guard.setThresholdPercent(percent); },
    };
}
