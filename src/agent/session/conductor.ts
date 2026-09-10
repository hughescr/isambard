/**
 * The long-lived session conductor (design doc section 6): the only writer into a session's
 * {@link InputQueue}. Owns resume-or-fresh session opening, a host-side priority queue of
 * {@link Envelope}s, the one-turn-in-flight invariant, the Discord human-wait/interrupt rows,
 * the host-driven `/compact` submission (via {@link CompactionGuard}), `is_error` retry per the
 * injected `retryPolicy`, and a bounded shutdown sequence. Every timing decision goes through the
 * injected {@link Clock} — this module never reads a real timer.
 *
 * `bootBundle`/hook wiring for post-compaction re-injection and PostCompact->
 * `guard.onCompactionFinished()` plumbing belong to whoever builds the session's `Options`
 * (P9's `src/app/sessions.ts`) — this module only pushes the initial boot envelope once, as the opening
 * handshake of {@link Conductor.open} (the SDK emits no frame until it has read one), and drives the guard from every raw frame it observes,
 * which already covers every frame-observable release path (`compact_boundary`, the `/compact`
 * turn's own result, the `error-compacting-conversation` notification, and the clock ceiling).
 * Compaction summaries are deliberately NOT persisted anywhere (Craig, 2026-09-06): the summary
 * already lives in the transcript and the SDK transcript file, and a memory copy would be
 * embedded and pollute search. The journal keeps only the compaction's metadata.
 *
 * @module agent/session/conductor
 */
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import { classifyClaudeError } from '../claude-retry';
import { buildResumeNote } from '../resume-prompt-builder';
import { StreamTracker, type StreamProgress  } from '../stream-tracker';
import type { AgentStreamEvent } from '../types';
import type { BuildBootBundleInput } from './boot-bundle';
import { createCompactionGuard, type CompactionGuard } from './compaction-guard';
import { createDeliveryGuard, type DeliveryGuard } from './delivery-guard';
import {
    buildBootEnvelope,
    buildCompactEnvelope,
    buildResumeEnvelope,
    toSdkUserMessage,
    toSynopsisSeed
} from './envelope';
import { InputQueue } from './input-queue';
import { createInterruptFlag } from './interrupt-flag';
import type { Ledger, LedgerEvent, LedgerStore } from './ledger';
import type { SessionJournal, ResumeStore } from './ports';
import { computeRecovery } from './recovery';
import { resultFrameToError } from './result-frame-error';
import { openSession, type SessionHandle } from './session';
import type { TaskLaunchRegistry } from './task-launch-registry';
import type {
    Clock,
    Envelope,
    EnvelopeMeta,
    SessionQueryFn,
    SessionRole,
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
 * `currentTurn` and the ledger's turn. One expression so the two can never drift: presence
 * matches every `phase_synopsis` against the LEDGER's id, and a mismatch is a silent drop —
 * `turnIdFor` reporting the literal `'notification'` while the ledger held `notification-<ms>`
 * is exactly how spontaneous turns lost their synopsis before.
 * @param at The instant the turn opened
 * @returns The turn id
 */
function bareNotificationTurnId(at: Date): string {
    return `notification-${at.getTime()}`;
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
    envelope: Envelope
    setAt:    number
}

type PendingAdoption = PendingWakeAdoption | PendingPeerAdoption;

/** Priority the host queues an envelope at: `'human'` before `'other'` (design section 6). */
export type SubmitPriority = 'human' | 'other';

/** Options accepted by {@link Conductor.submit}. */
export interface SubmitOptions {
    priority:             SubmitPriority
    requestingChannelId?: string
    /**
     * Ties this submission to the caller's abort contract (P9, design section 6): aborting while
     * the envelope is still held host-side (queued behind another turn) withdraws it — `submit()`
     * resolves `{ wasInterrupted: true, response: null, outcome: 'withdrawn' }` and nothing ever
     * reaches the SDK; aborting while this envelope's own turn is already running calls
     * {@link Conductor.interruptCurrent} scoped to `requestingChannelId` and resolves with
     * `outcome: 'interrupted'`; aborting while a DIFFERENT channel's turn is running never
     * interrupts that turn — this envelope is still only queued, so it is withdrawn like any
     * other held envelope.
     */
    signal?:              AbortSignal
}

/** Options accepted by {@link Conductor.interruptCurrent}. */
export interface InterruptCurrentOptions {
    requestingChannelId?: string
    reason?:              string
}

/** Options accepted by {@link Conductor.shutdown}. */
export interface ShutdownOptions {
    turnWaitMs: number
    deadlineMs: number
}

/** The outcome of one submitted turn, resolved by {@link Conductor.submit}. */
export interface TurnResult {
    envelopeId:          string
    /** The final assistant text, or `null` when the turn errored or was interrupted before producing one. */
    response:            string | null
    wasInterrupted:      boolean
    partialWork:         StreamProgress
    sessionId:           string | undefined
    isError:             boolean
    /**
     * The context-usage percentage most recently known to the conductor's ledger at the moment
     * this turn settled (design 3.3/P9: 'every result logs the getContextUsage percentage'). This
     * is the value as of the END of the PREVIOUS turn's {@link CompactionGuard.onTurnEnd} poll,
     * not a fresh poll for this specific turn: that poll always runs after this result has
     * already settled (see `afterResult`), so fetching a same-turn value here would delay every
     * `submit()` resolution on an extra SDK round trip. `0` before any turn has ever completed.
     */
    contextUsagePercent: number
    /**
     * Set only when this turn ended via the caller's {@link SubmitOptions.signal}: `'withdrawn'`
     * when the envelope was still queued and never reached the SDK, `'interrupted'` when its turn
     * was already running. Absent for an ordinary completion, a retry-exhausted failure, or an
     * interrupt from any other source (a same-channel human envelope, the human-wait ceiling, a
     * shutdown) — those are already fully described by `wasInterrupted`/`isError`.
     */
    outcome?:            'withdrawn' | 'interrupted'
}

/** A snapshot of the conductor's current state, returned by {@link Conductor.status}. */
export interface ConductorStatus {
    role:         SessionRole
    sessionId:    string | undefined
    opened:       boolean
    shuttingDown: boolean
    queueLength:  number
    turn: {
        kind:        TurnKind
        channelId?:  string
        envelopeId?: string
        /** The turn's originating envelope author (R2) — `undefined` for a bare spontaneous `notification` turn, or a `task` turn whose {@link CreateConductorParams.taskLaunches} lookup found no launch record. */
        authorId?:   string
    } | null
}

/** Dependencies and configuration for {@link createConductor}. */
export interface CreateConductorParams {
    role:               SessionRole
    queryFn:            SessionQueryFn
    /** Builds full Agent SDK `Options` for a fresh (`undefined`) or resumed (session id) open. */
    buildOptions:       (resume?: string) => Options
    clock:              Clock
    /** Reads the process's current resident set size, in bytes. */
    readRss:            () => number
    ledgerStore:        LedgerStore
    config:             SessionConfig
    /** `config.retry.claude` — drives `is_error` resubmission, on the injected `clock`. */
    retryPolicy:        RetryPolicy
    journal:            SessionJournal
    resumeStore:        ResumeStore
    /**
     * Pre-formatted boot bundle text, pushed once as the `boot`-kind opening handshake (see
     * `openWithHandle`) on every fresh or resumed `open()`. Ignored when {@link buildBootBundle} is provided.
     */
    bootBundle?:        string
    /**
     * Builds the boot bundle text from boot-time crash recovery (P8): `open()` reads the
     * journal window ending now, computes {@link import('./recovery').computeRecovery}, and
     * (when this is provided) calls it with the recovery-derived lost-task and
     * undelivered-envelope descriptions — the same shape P6's boot-bundle builder input takes —
     * to produce the text pushed as the boot envelope, taking precedence over the static
     * {@link bootBundle} string.
     */
    buildBootBundle?:   (input: Pick<BuildBootBundleInput, 'lostTasks' | 'undelivered'>) => string | Promise<string>
    logger:             Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
    /** Observes every raw frame alongside {@link Conductor.subscribeTurn} subscribers. */
    onTurnFrame?:       (turnId: string, frame: SDKMessage) => void
    /** Classifies an `is_error` result's adapted error. Defaults to `classifyClaudeError`. */
    classifyError?:     (error: unknown) => ErrorClassification
    /**
     * Resolves the launch record for an adopted wake turn (R2) — see
     * {@link Conductor.adoptWakeTurn}. `undefined` (the default) when no launch registry is
     * wired; the adopted turn then carries no channelId/authorId.
     */
    taskLaunches?:      Pick<TaskLaunchRegistry, 'lookup' | 'forget'>
    /**
     * Called once an adopted wake turn (R2) settles, with the synthesized `task`-kind envelope
     * and its {@link TurnResult} — the composition root's hook for delivering that reply to its
     * origin channel (or a fallback, for a turn with no channel). A rejection is caught and
     * logged; it never affects the conductor or any other caller.
     */
    onWakeTurnSettled?: (envelope: Envelope, result: TurnResult) => void | Promise<void>
}

/** The outcome of a {@link Conductor.deliver} call. */
export interface DeliverResult {
    /** `false` when the envelope was already delivered (seeded at boot or marked earlier this process) and `send` was never called. */
    delivered: boolean
}

/** The long-lived session conductor returned by {@link createConductor}. */
export interface Conductor {
    open:                          () => Promise<{ sessionId: string, resumed: boolean }>
    /** Throws {@link InvariantViolationError} if `envelope.shouldQuery !== true` — `submit()` always opens a turn; a `shouldQuery:false` envelope belongs on {@link Conductor.appendWithoutTurn} instead. */
    submit:                        (envelope: Envelope, options: SubmitOptions) => Promise<TurnResult>
    /**
     * Pushes `envelope` onto the live SDK queue without opening a turn — mirrors the private
     * boot-bundle push (`pushBootBundle`). A no-op when there is no live queue yet (before
     * `open()` has assigned one), or while shutting down or reopening. Never reads or writes
     * {@link ConductorStatus.turn} and never calls `beginTurn`/`processQueue`: this is the
     * accumulate-only seam for `shouldQuery:false` notifications, which the SDK appends to the
     * transcript without triggering an assistant turn (no result frame), so routing one through
     * `submit()` would wedge the one-turn-in-flight invariant forever. Throws
     * {@link InvariantViolationError} if `envelope.shouldQuery !== false`.
     */
    appendWithoutTurn:             (envelope: Envelope) => void
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
     */
    adoptWakeTurn:                 (input: { taskId: string, toolUseId: string, summary: string }) => void
    /**
     * Adopts a pending peer-message turn (session-peers block 2): the NEXT spontaneous assistant
     * frame — the one the SDK's own `<cross-session-message>` delivery produces — opens a real
     * `peer`-kind turn carrying `envelope` instead of falling through to the bare `notification`
     * fallback. Takes an already-built {@link Envelope} (see {@link
     * import('./envelope').buildPeerEnvelope}) rather than the raw `{ from, fromName, text }`
     * triple because the rendering needs a timezone and a time header, neither of which the
     * conductor has — the same division of labour `createNotificationBridge` already uses for
     * `buildNotificationEnvelope`. Throws {@link InvariantViolationError} unless
     * `envelope.kind === 'peer'`.
     *
     * Nothing is ever pushed to the SDK queue for this turn, for the same reason
     * {@link Conductor.adoptWakeTurn}'s is not: the SDK already started it from the peer's raw
     * prompt. Unlike a wake, an adopted peer turn has no host-side delivery at all — Claude
     * answers a peer by calling `SendMessage` itself, which the envelope's own text instructs.
     *
     * A peer message that lands while this session is ALREADY mid-turn never reaches here at
     * all: the SDK folds it into the running turn and fires no `UserPromptSubmit` hook (block-0
     * probe P3, 2026-09-09), so no new turn exists for the host to adopt and nothing is recorded
     * — deliberately, rather than reconstructing one from the undeclared `command_lifecycle`
     * frame, which carries neither the sender nor the text and is also emitted for the host's own
     * {@link Conductor.appendWithoutTurn} pushes. A second call before the first pending peer
     * message is consumed overwrites it and logs a warning.
     */
    adoptPeerTurn:                 (envelope: Envelope) => void
    /**
     * Delivers `envelopeId`'s response exactly once (P8): if the delivery guard already knows
     * this id, `send` is skipped entirely; otherwise `send` runs, `response_delivered` is
     * journaled and the journal is flushed (awaiting the write's durability, not just its
     * issuance) before the id is marked delivered and this call resolves — so a crash between
     * `send` resolving and the flush settling is the sole re-send window, and even that window is
     * closed by the journal itself: {@link import('./recovery').computeRecovery} at the next boot
     * replays `response_delivered` rows into a fresh guard, so a `response_delivered` row that
     * did land is never re-sent even if this call never got to return.
     */
    deliver:                       (envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => Promise<DeliverResult>
    interruptCurrent:              (options?: InterruptCurrentOptions) => Promise<void>
    subscribeTurn:                 (handler: (turnId: string, frame: SDKMessage) => void) => () => void
    status:                        () => ConductorStatus
    shutdown:                      (options: ShutdownOptions) => Promise<void>
    /** The compaction guard's live threshold percentage — see {@link CompactionGuard.getThresholdPercent}. */
    getCompactionThresholdPercent: () => number
    /** Changes the compaction guard's live threshold percentage — see {@link CompactionGuard.setThresholdPercent}. */
    setCompactionThresholdPercent: (percent: number) => void
}

/** How a caller's `submit()` promise is settled once its turn is resolved one way or another. */
interface Deferred {
    resolve: (result: TurnResult) => void
    reject:  (error: unknown) => void
}

/** One envelope waiting in the host-side priority queue, or already promoted to the active turn. */
interface QueuedItem {
    envelope:               Envelope
    priority:               SubmitPriority
    requestingChannelId?:   string
    attempts:               number
    deferred:               Deferred
    /** Removes this item's `abort` listener from the caller's {@link SubmitOptions.signal}, when one was given. Set by `submit()`, cleared once run so it fires at most once per item — including across retries, which reuse the same `QueuedItem`. */
    abortCleanup?:          () => void
    /** True once `handleSubmitAbort` has called {@link interruptCurrentTurnInternal} for this item's own running turn — distinguishes an interrupt this signal caused from one triggered by any other source, so only the former settles with `outcome: 'interrupted'`. */
    abortedViaSignal?:      boolean
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
    id:                 string
    /** `undefined` for a spontaneous SDK-initiated turn nobody submitted. */
    item?:              QueuedItem
    kind:               TurnKind
    channelId?:         string
    /** The turn's originating envelope author (R2) — see {@link ConductorStatus.turn}. */
    authorId?:          string
    tracker:            StreamTracker
    interruptRequested: boolean
    escalationArmed:    boolean
    escalationTimer?:   TimerHandle
}

/** A no-op {@link Deferred} for envelopes the conductor submits to itself (`/compact`, a resume note). */
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
 * (`routeIncoming`) and interrupted-turn resume-note injection
 * (`injectResumeNoteIfInterruptedBackgroundTurn`) treat all three identically — enqueue behind
 * them and arm the human-wait escalation, rather than interrupting immediately the way a
 * same-channel `discord` turn is.
 */
function isBackgroundKind(kind: TurnKind): boolean {
    return kind === 'notification' || kind === 'task' || kind === 'peer';
}

/**
 * Creates a long-lived session conductor.
 * @param params See {@link CreateConductorParams}.
 * @returns A {@link Conductor}.
 */
export function createConductor(params: CreateConductorParams): Conductor {
    const {
        role, queryFn, buildOptions, clock, readRss, ledgerStore, config, retryPolicy,
        journal, resumeStore, bootBundle, buildBootBundle, logger, onTurnFrame, taskLaunches, onWakeTurnSettled,
    } = params;
    const classifyError = params.classifyError ?? classifyClaudeError;

    let opened = false;
    let shuttingDown = false;
    /** Populated once by {@link runBootRecovery} at the start of {@link open}; guards {@link deliver} against re-sending an envelope a prior process already delivered. */
    let deliveryGuard: DeliveryGuard | undefined;
    /** The text {@link openHandshakeText} returns — the static {@link bootBundle} until {@link runBootRecovery} replaces it with {@link buildBootBundle}'s output, when provided. */
    let resolvedBootBundle = bootBundle;
    /** True from the moment a mid-life close is observed until a replacement session (resumed or fresh) has opened — or reopening has been given up on entirely. Gates {@link processQueue} and {@link submitCompact} so no envelope is ever pushed into the dead handle's orphaned {@link InputQueue} while a reopen is in flight. */
    let reopening = false;
    let currentSessionId: string | undefined;
    let currentHandleRef: SessionHandle | undefined;
    let currentQueue: InputQueue | undefined;
    let currentTurn: ActiveTurn | null = null;
    /** True only for the span of {@link afterResult} between nulling `currentTurn` and `guard.onTurnEnd()` resolving — blocks {@link onFrame} from spontaneously opening a notification turn for a frame that arrives in that window, which `submitCompact`'s `beginTurn` (driven by that very `onTurnEnd` call) would otherwise silently clobber. */
    let awaitingTurnEnd = false;
    const pendingQueue: QueuedItem[] = [];
    const turnSubscribers = new Set<(turnId: string, frame: SDKMessage) => void>();
    const turnEndedWaiters: (() => void)[] = [];
    let previousTasks = new Map(ledgerStore.get().tasks.map(task => [task.id, task] as const));
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
        const waiters = turnEndedWaiters.splice(0);
        for(const waiter of waiters) {
            waiter();
        }
    }

    function waitForTurnEnd(): Promise<void> {
        // Stryker disable next-line BlockStatement: defensive fallback — the sole caller (shutdown's
        // graceful cleanup, below) already checks `currentTurn !== null` synchronously immediately
        // before calling this, with no `await` between the check and this call, so `currentTurn`
        // cannot have changed; unreachable in practice, kept in case another caller is ever added.
        if(currentTurn === null) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            turnEndedWaiters.push(resolve);
        });
    }

    /**
     * The id reported to `subscribeTurn`/`onTurnFrame` subscribers. Reads {@link ActiveTurn.id}
     * — never the kind — so a bare spontaneous turn reports the same `notification-<ms>` the
     * ledger holds, rather than the literal `'notification'` that no `phase_synopsis` could ever
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
     * `task_notification` frame) journals the ordinary `task_completed`.
     */
    function journalTaskLifecycle(ledger: Ledger, event: LedgerEvent): void {
        const currentTaskIds = new Set(ledger.tasks.map(task => task.id));
        for(const task of ledger.tasks) {
            if(!previousTasks.has(task.id)) {
                journal.append({ type: 'task_started', at: now(), taskId: task.id, description: task.description });
            }
        }
        const isReopen = event.type === 'session_opened';
        const explicitlyLostTaskId = event.type === 'task_lost' ? event.taskId : undefined;
        for(const [id, task] of previousTasks) {
            if(!currentTaskIds.has(id)) {
                const lost = isReopen || id === explicitlyLostTaskId;
                journal.append(lost
                    ? { type: 'task_lost', at: now(), taskId: id, description: task.description }
                    : { type: 'task_completed', at: now(), taskId: id, description: task.description });
            }
        }
        previousTasks = new Map(ledger.tasks.map(task => [task.id, task] as const));
    }

    /**
     * Journals the outcome of a compaction that just transitioned out of `'compacting'`, reading
     * a `compaction_failed` event's `reason` directly rather than losing it to the reducer's
     * write-only ledger state. On a `'timeout'` failure with the `/compact` turn still running,
     * also interrupts it — releasing the guard's own bookkeeping alone leaves `processQueue`
     * blocked on `currentTurn !== null` forever.
     */
    function journalCompactionOutcome(event: LedgerEvent): void {
        if(event.type === 'compaction_failed') {
            journal.append({ type: 'compaction_failed', at: now(), error: event.reason ?? 'compaction attempt did not complete' });
            if(event.reason === 'timeout' && currentTurn?.kind === 'compact') {
                void interruptCurrentTurnInternal('compaction ceiling exceeded');
            }
            return;
        }
        journal.append({ type: 'compaction_completed', at: now() });
    }

    /**
     * All `pendingQueue`-external ledger bookkeeping this conductor derives from ledger changes:
     * task lifecycle journaling and releasing submits held for compaction.
     */
    ledgerStore.subscribe((ledger, event) => {
        journalTaskLifecycle(ledger, event);

        if(previousCompaction === 'compacting' && ledger.compaction === 'none') {
            journalCompactionOutcome(event);
            processQueue();
        }
        previousCompaction = ledger.compaction;
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
            beginTurn({ envelope: buildCompactEnvelope(at), priority: 'other', attempts: 1, deferred: internalDeferred() });
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(toError(error, 'submitCompact failed'));
        }
    }

    const guard: CompactionGuard = createCompactionGuard({
        getContextUsage,
        submitCompact,
        ledgerStore,
        clock,
        thresholdPercent: config.compactThresholdPercent,
        logger,
    });

    function enqueue(item: QueuedItem): void {
        if(item.priority === 'human') {
            const firstOtherIndex = pendingQueue.findIndex(existing => existing.priority !== 'human');
            if(firstOtherIndex === -1) {
                pendingQueue.push(item);
            } else {
                pendingQueue.splice(firstOtherIndex, 0, item);
            }
        } else {
            pendingQueue.push(item);
        }
        ledgerStore.dispatch({ type: 'envelope_queued', kind: item.envelope.kind, at: now() });
    }

    function beginTurn(item: QueuedItem): void {
        const queue = currentQueue;
        if(queue === undefined) {
            throw new InvariantViolationError('conductor.beginTurn', 'called before open() assigned currentQueue — every call site (processQueue, submitCompact) only runs once opened is true');
        }
        const at = now();
        currentTurn = {
            id: item.envelope.id, item, kind: item.envelope.kind, channelId: item.envelope.channelId, authorId: item.envelope.authorId, tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false,
        };
        const meta: EnvelopeMeta = {
            id: item.envelope.id, kind: item.envelope.kind, queuedAt: at, channelId: item.envelope.channelId, seed: item.envelope.synopsisSeed,
        };
        ledgerStore.dispatch({ type: 'turn_submitted', envelope: meta, at });
        journal.append({
            type: 'envelope_submitted', at, envelopeId: item.envelope.id, kind: item.envelope.kind, ...(item.envelope.channelId === undefined ? {} : { channelId: item.envelope.channelId }),
        });
        queue.push(toSdkUserMessage(item.envelope));
    }

    function processQueue(): void {
        if(currentTurn !== null || shuttingDown || reopening) {
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

    async function interruptCurrentTurnInternal(reason: string | undefined): Promise<void> {
        const handle = currentHandleRef;
        if(handle === undefined || currentTurn === null || currentTurn.interruptRequested) {
            return;
        }
        currentTurn.interruptRequested = true;
        ledgerStore.dispatch({ type: 'interrupt_requested', at: now() });
        logger.debug({ reason }, 'Conductor requesting interrupt');
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
                void interruptCurrentTurnInternal('human wait ceiling elapsed');
            }, config.humanWaitCeilingMs - config.humanWaitTargetMs);
            return;
        }
        void interruptCurrentTurnInternal('human wait target elapsed');
    }

    function routeIncoming(item: QueuedItem): void {
        if(item.withdrawnWhileWaiting) {
            return;
        }
        if(currentTurn === null) {
            enqueue(item);
            processQueue();
            return;
        }
        if(item.priority === 'human' && currentTurn.kind === 'discord'
          && item.requestingChannelId !== undefined && item.requestingChannelId === currentTurn.channelId) {
            enqueue(item);
            void interruptCurrentTurnInternal('human envelope for the running channel');
            return;
        }
        if(item.priority === 'human' && isBackgroundKind(currentTurn.kind)) {
            enqueue(item);
            armHumanWaitEscalation();
            return;
        }
        enqueue(item);
    }

    /** Injects a `resume`-kind envelope ahead of everything else queued when an interrupted background turn (a spontaneous notification, or an adopted R2 task wake) left meaningful partial work behind. */
    function injectResumeNoteIfInterruptedBackgroundTurn(turn: ActiveTurn, progress: StreamProgress): void {
        if(!isBackgroundKind(turn.kind) || !turn.interruptRequested) {
            return;
        }
        const note = buildResumeNote(progress);
        if(note !== undefined) {
            pendingQueue.unshift({ envelope: buildResumeEnvelope(note, now()), priority: 'human', attempts: 1, deferred: internalDeferred() });
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
    function failTurn(turn: ActiveTurn, item: QueuedItem, progress: StreamProgress, error: Error, contextUsagePercent: number): void {
        clearAbortListener(item);
        journal.append({ type: 'turn_failed', at: now(), envelopeId: item.envelope.id, kind: turn.kind, error: error.message });
        item.deferred.resolve({ envelopeId: item.envelope.id, response: null, wasInterrupted: false, partialWork: progress, sessionId: currentSessionId, isError: true, contextUsagePercent });
    }

    /** An `is_error` result: retries per `retryPolicy` when the classified error is transient/rate-limited and attempts remain, else fails the turn. */
    function settleErroredTurn(turn: ActiveTurn, item: QueuedItem, progress: StreamProgress, frame: ResultFrame, contextUsagePercent: number): void {
        const error = resultFrameToError(frame);
        const classification = classifyError(error);
        const canRetry = (classification.category === 'transient' || classification.category === 'rate_limited') && item.attempts < retryPolicy.maxAttempts;
        if(!canRetry) {
            failTurn(turn, item, progress, error, contextUsagePercent);
            return;
        }
        item.attempts += 1;
        scheduleRetry(item, classification.retryAfterMs ?? computeBackoffDelayMs(retryPolicy, item.attempts - 1));
    }

    function settleTurn(turn: ActiveTurn, frame: ResultFrame): void {
        const wasInterrupted = turn.interruptRequested;
        const progress = turn.tracker.getProgress();

        injectResumeNoteIfInterruptedBackgroundTurn(turn, progress);

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

        if(!wasInterrupted && frame.is_error) {
            settleErroredTurn(turn, item, progress, frame, contextUsagePercent);
            return;
        }

        clearAbortListener(item);
        const response = !wasInterrupted && frame.subtype === 'success' ? frame.result : null;
        const truncated = response !== null && response.length > TURN_RESPONSE_TEXT_CAP;
        journal.append({
            type: 'turn_completed', at: now(), envelopeId: item.envelope.id, kind: turn.kind,
            ...(response === null ? {} : { responseText: truncated ? response.slice(0, TURN_RESPONSE_TEXT_CAP) : response }),
            ...(truncated ? { truncated: true } : {}),
        });
        item.deferred.resolve({
            envelopeId: item.envelope.id, response, wasInterrupted, partialWork: progress, sessionId: currentSessionId, isError: false, contextUsagePercent,
            ...(item.abortedViaSignal === true ? { outcome: 'interrupted' as const } : {}),
        });
    }

    async function afterResult(frame: ResultFrame): Promise<void> {
        const turn = currentTurn;
        currentTurn = null;
        if(turn?.escalationTimer !== undefined) {
            clock.clearTimer(turn.escalationTimer);
        }
        resolveTurnEndedWaiters();
        if(turn !== null) {
            settleTurn(turn, frame);
        }
        ledgerStore.dispatch({ type: 'tick', rssBytes: readRss(), at: now() });
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
     * The {@link Deferred} for an adopted wake turn's synthesized {@link QueuedItem} (R2): no
     * external caller is waiting on a promise for this turn, so `resolve` routes the settled
     * {@link TurnResult} to {@link onWakeTurnSettled} instead (when one was provided), catching
     * and logging a rejection so a failing delivery callback never surfaces as an unhandled
     * rejection. `reject` should never legitimately fire for this item (see `rejectAllQueued`
     * and the reopen-failure path, whose callers only ever `resolve` a wake item's deferred), but
     * is still logged defensively rather than silently swallowed.
     */
    function buildWakeSettledDeferred(envelope: Envelope): Deferred {
        return {
            resolve: (result: TurnResult) => {
                if(onWakeTurnSettled === undefined) {
                    return;
                }
                Promise.resolve(onWakeTurnSettled(envelope, result)).catch((error: unknown) => {
                    logger.error({ error }, 'onWakeTurnSettled failed for an adopted wake turn');
                });
            },
            reject: (error: unknown) => {
                logger.error({ error }, 'An adopted wake turn was rejected before it could settle');
            },
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
        const envelope: Envelope = {
            id:           crypto.randomUUID(),
            kind:         'task',
            text:         wake.summary,
            channelId:    launch?.channelId,
            authorId:     launch?.authorId,
            hostPriority: 'wake',
            shouldQuery:  true,
            createdAt:    at,
            synopsisSeed: toSynopsisSeed(wake.summary),
        };
        const item: QueuedItem = {
            envelope, priority: 'other', attempts: retryPolicy.maxAttempts, deferred: buildWakeSettledDeferred(envelope),
        };
        currentTurn = {
            id: envelope.id, item, kind: 'task', channelId: envelope.channelId, authorId: envelope.authorId, tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false,
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
    function beginAdoptedPeerTurn(envelope: Envelope): void {
        const at = now();
        const item: QueuedItem = {
            envelope, priority: 'other', attempts: retryPolicy.maxAttempts, deferred: internalDeferred(),
        };
        currentTurn = {
            id: envelope.id, item, kind: 'peer', tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false,
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
    function adoptPeerTurn(envelope: Envelope): void {
        if(envelope.kind !== 'peer') {
            throw new InvariantViolationError('conductor.adoptPeerTurn', 'called with a non peer-kind envelope — the adopted turn IS this envelope, so its kind is what the ledger and journal record');
        }
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
                id: turnId, kind: 'notification', tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false,
            };
            // Dispatched here — still inside onFrame, BEFORE notifyTurnSubscribers — so the
            // presence synopsis attachment (which opens a handler from the ledger's turn) is live
            // for this turn's very first frame, and every `phase_synopsis` it dispatches carries
            // the id `reducePhaseSynopsis` compares against. Do not move it after the notify.
            ledgerStore.dispatch({ type: 'spontaneous_turn_opened', turnId, at });
            return;
        }
        if(next.kind === 'wake') {
            beginAdoptedWakeTurn(next.wake);
            return;
        }
        beginAdoptedPeerTurn(next.envelope);
    }

    function onFrame(frame: SDKMessage): void {
        guard.onFrame(frame);
        pendingAdoptions = pendingAdoptions.filter((entry) => {
            if(!isPendingAdoptionStale(entry.setAt)) {
                return true;
            }
            warnPendingAdoptionExpired(entry);
            return false;
        });
        if(currentTurn === null && frame.type === 'assistant') {
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
        // boundary cast: AgentStreamEvent is the one-shot path's narrower observability-only view of a stream event; every SDKMessage shape StreamTracker.update switches on (system/task_started, assistant) is a subset of AgentStreamEvent's fields, matching the identical cast already documented in ./session.ts
        currentTurn?.tracker.update(frame as unknown as AgentStreamEvent);
        notifyTurnSubscribers(frame);
        ledgerStore.dispatch({ type: 'sdk_frame', frame, at: now() });
        if(frame.type === 'result') {
            void afterResult(frame);
        }
    }

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
     */
    async function openWithHandle(resumeId: string | undefined, handshakeText: string): Promise<{ handle: SessionHandle, sessionId: string }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const queue = new InputQueue();
            const interrupting = createInterruptFlag();
            const options = buildOptions(resumeId);
            queue.push(toSdkUserMessage(buildBootEnvelope(handshakeText, now())));
            const handle = openSession({
                role,
                queryFn,
                options,
                queue,
                interrupting,
                onFrame: (frame) => {
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
                onClosed: (error) => {
                    if(!settled) {
                        settled = true;
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

    async function finishOpen(sessionId: string, resumed: boolean, fallback: boolean): Promise<void> {
        currentSessionId = sessionId;
        opened = true;
        const at = now();
        journal.append({
            type: 'session_opened', at, role, sessionId, resumed, ...(fallback ? { fallback: true as const } : {}),
        });
        ledgerStore.dispatch({ type: 'session_opened', sessionId, at });
        await resumeStore.save(role, sessionId);
    }

    /** The opening handshake for {@link open}: the boot bundle when there is one, else a bare open/resume marker. */
    function openHandshakeText(resuming: boolean): string {
        if(resolvedBootBundle !== undefined && resolvedBootBundle !== '') {
            return resolvedBootBundle;
        }
        const verb = resuming ? 'resumed' : 'opened';
        return `[BOOT] Session ${verb} at ${now().toISOString()}. No boot context to report. Host handshake — nothing to do, no reply expected.`;
    }

    function appendWithoutTurn(envelope: Envelope): void {
        if(envelope.shouldQuery !== false) {
            throw new InvariantViolationError('conductor.appendWithoutTurn', 'called with a shouldQuery:true envelope — this seam is accumulate-only; use submit() for shouldQuery:true envelopes');
        }
        if(currentQueue === undefined || shuttingDown || reopening) {
            return;
        }
        // Deliberately does NOT dispatch `envelope_queued`: that ledger event is only ever
        // balanced by `turn_submitted` (see `enqueue`/`beginTurn`), and this seam by construction
        // never opens a turn — dispatching it here would permanently inflate `ledger.queued.other`
        // for the life of the process (see Q5 review finding).
        currentQueue.push(toSdkUserMessage(envelope));
    }

    /**
     * Boot-time crash recovery (P8), run once at the start of {@link open}: reads the journal
     * window ending now, derives {@link import('./recovery').computeRecovery}'s lost tasks and
     * undelivered envelopes, journals a `task_lost` entry for each lost task (the process that
     * started them never got to), seeds {@link deliveryGuard} from the recovered
     * `deliveredEnvelopeIds` so {@link deliver} cannot re-send anything a prior process already
     * confirmed sent, and — when {@link buildBootBundle} is provided — resolves
     * {@link resolvedBootBundle} from the recovered lost-task/undelivered descriptions.
     *
     * Never rejects: a `journal.readSince` failure (DynamoDB throttled/unavailable) is logged and
     * degrades to an empty-seeded {@link deliveryGuard} and the static {@link bootBundle} — the
     * conductor still opens rather than never starting at all. The accepted risk is a possible
     * double-send for whatever the crashed process had already delivered; that is far preferable
     * to `open()` never resolving.
     */
    async function runBootRecovery(): Promise<void> {
        try {
            const entries = await journal.readSince(clock.now() - RECOVERY_WINDOW_MS);
            const recovery = computeRecovery(entries);

            for(const lostTask of recovery.lostTasks) {
                journal.append({
                    type: 'task_lost', at: now(), taskId: lostTask.taskId, description: lostTask.description,
                });
            }

            deliveryGuard = createDeliveryGuard(recovery.deliveredEnvelopeIds);

            if(buildBootBundle !== undefined) {
                resolvedBootBundle = await buildBootBundle({
                    lostTasks:   recovery.lostTasks.map(task => task.description ?? task.taskId),
                    undelivered: recovery.undelivered.map(envelope => envelope.responseText ?? `${envelope.envelopeKind} envelope ${envelope.envelopeId}`),
                });
            }
        } catch (error) {
            logger.error({ error }, 'Conductor boot recovery failed; opening with an empty-seeded delivery guard');
            deliveryGuard = createDeliveryGuard([]);
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

    async function handleMidLifeClosed(error: unknown): Promise<void> {
        if(shuttingDown) {
            return;
        }
        logger.error({ error }, 'Session ended unexpectedly; reopening');
        reopening = true;
        const inFlightItem = currentTurn?.item;
        if(currentTurn?.escalationTimer !== undefined) {
            clock.clearTimer(currentTurn.escalationTimer);
        }
        currentTurn = null;
        resolveTurnEndedWaiters();
        const lastSessionId = currentSessionId;
        const handshake = `[BOOT] Session reopened at ${now().toISOString()} after the previous session ended unexpectedly. Host handshake — nothing to do, no reply expected.`;
        try {
            try {
                const { handle, sessionId } = await openWithHandle(lastSessionId, handshake);
                try {
                    await finishOpen(sessionId, true, false);
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
            } catch{
                const { sessionId } = await openWithHandle(undefined, handshake);
                await finishOpen(sessionId, false, true);
            }
        } catch (reopenError) {
            reopening = false;
            opened = false;
            // The fresh-open fallback may itself have opened a live handle before its own
            // finishOpen rejected — close it rather than merely dropping the reference, which
            // would otherwise leak the CLI subprocess.
            if(currentHandleRef !== undefined) {
                discardHandle(currentHandleRef);
            }
            const failure = toError(reopenError, 'Conductor failed to reopen the session');
            logger.error({ error: failure }, 'Conductor could not reopen the session after it closed unexpectedly; giving up');
            if(inFlightItem !== undefined) {
                clearAbortListener(inFlightItem);
                inFlightItem.deferred.reject(failure);
            }
            rejectAllQueued(failure);
            return;
        }
        reopening = false;
        if(inFlightItem !== undefined) {
            pendingQueue.unshift(inFlightItem);
        }
        processQueue();
    }

    async function open(): Promise<{ sessionId: string, resumed: boolean }> {
        await runBootRecovery();
        const stored = await resumeStore.load(role);
        if(stored !== undefined) {
            try {
                const { handle, sessionId } = await openWithHandle(stored, openHandshakeText(true));
                try {
                    await finishOpen(sessionId, true, false);
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
                return { sessionId, resumed: true };
            } catch (error) {
                logger.warn({ error }, 'Resuming the stored session failed; opening a fresh session');
            }
        }
        const { sessionId } = await openWithHandle(undefined, openHandshakeText(false));
        await finishOpen(sessionId, false, stored !== undefined);
        return { sessionId, resumed: false };
    }

    /** The `TurnResult` for an envelope withdrawn (never reached the SDK) because its `signal` aborted while it was still held. */
    function withdrawnResult(item: QueuedItem): TurnResult {
        return {
            envelopeId:          item.envelope.id,
            response:            null,
            wasInterrupted:      true,
            partialWork:         new StreamTracker().getProgress(),
            sessionId:           currentSessionId,
            isError:             false,
            contextUsagePercent: ledgerStore.get().context.percentage,
            outcome:             'withdrawn',
        };
    }

    /**
     * Handles `item`'s `signal` firing `abort` (see {@link SubmitOptions.signal}): when `item` is
     * the turn currently running, interrupts it (scoped to `requestingChannelId` like any other
     * interrupt) and marks it so {@link settleTurn} reports `outcome: 'interrupted'` once it ends;
     * otherwise `item` is still only queued (whether idle, behind this envelope's own channel's
     * prior turn, or behind an unrelated channel's turn — the abort contract withdraws rather than
     * interrupting in every one of those cases) — removed from `pendingQueue` and resolved as
     * `'withdrawn'` without ever reaching `beginTurn`/the SDK. A no-op if `item` has already
     * settled by some other path (its listener is removed the moment it does, so this only runs
     * for an item still genuinely in flight).
     */
    function handleSubmitAbort(item: QueuedItem): void {
        clearAbortListener(item);
        if(currentTurn?.item === item) {
            item.abortedViaSignal = true;
            void interruptCurrentTurnInternal('submit() signal aborted');
            return;
        }
        const index = pendingQueue.indexOf(item);
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

    function submit(envelope: Envelope, options: SubmitOptions): Promise<TurnResult> {
        if(envelope.shouldQuery !== true) {
            throw new InvariantViolationError('conductor.submit', 'called with a shouldQuery:false envelope — submit() always opens a turn; use appendWithoutTurn() for shouldQuery:false envelopes');
        }
        if(shuttingDown) {
            return Promise.reject(new Error('Conductor is shutting down'));
        }
        if(!opened) {
            return Promise.reject(new Error('Conductor is not open'));
        }
        return new Promise<TurnResult>((resolve, reject) => {
            const item: QueuedItem = {
                envelope, priority: options.priority, requestingChannelId: options.requestingChannelId, attempts: 1, deferred: { resolve, reject },
            };
            const { signal } = options;
            if(signal !== undefined) {
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

    async function deliver(envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>): Promise<DeliverResult> {
        if(deliveryGuard === undefined) {
            throw new InvariantViolationError('conductor.deliver', 'called before open() completed its boot recovery, which initialises the delivery guard');
        }
        if(deliveryGuard.alreadyDelivered(envelopeId)) {
            logger.info({ envelopeId }, 'Conductor.deliver: envelope already delivered; skipping send');
            return { delivered: false };
        }
        const { channelId, messageIds } = await send();
        journal.append({
            type: 'response_delivered', at: now(), envelopeId, channelId, messageIds,
        });
        // Awaited so the response_delivered row is durable (not merely issued) before this call
        // reports the envelope done — closing the crash window between an unawaited fire-and-forget
        // append and its DynamoDB write actually landing.
        await journal.flush();
        deliveryGuard.markDelivered(envelopeId);
        return { delivered: true };
    }

    async function interruptCurrent(options: InterruptCurrentOptions = {}): Promise<void> {
        if(currentTurn === null) {
            return;
        }
        if(options.requestingChannelId !== undefined && currentTurn.channelId !== undefined && currentTurn.channelId !== options.requestingChannelId) {
            logger.warn({ requestingChannelId: options.requestingChannelId, turnChannelId: currentTurn.channelId }, 'interruptCurrent ignored: requesting channel does not own the running turn');
            return;
        }
        await interruptCurrentTurnInternal(options.reason);
    }

    function subscribeTurn(handler: (turnId: string, frame: SDKMessage) => void): () => void {
        turnSubscribers.add(handler);
        return () => {
            turnSubscribers.delete(handler);
        };
    }

    function status(): ConductorStatus {
        return {
            role,
            sessionId:   currentSessionId,
            opened,
            shuttingDown,
            queueLength: pendingQueue.length,
            turn:        currentTurn === null
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
        // Nothing still waiting in pendingQueue will ever be dequeued — processQueue() now
        // early-returns on shuttingDown forever — so settle those submit() promises now rather
        // than leaving them pending for the life of the process.
        rejectAllQueued(new Error('Conductor is shutting down'));

        let deadlineTimer: TimerHandle | undefined;
        const deadline = new Promise<void>((resolve) => {
            deadlineTimer = clock.setTimer(resolve, options.deadlineMs);
        });

        const graceful = (async (): Promise<void> => {
            if(currentTurn !== null) {
                await raceAgainstTimeout(waitForTurnEnd(), options.turnWaitMs);
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/different-types-comparison -- TS narrows currentTurn from the outer check, but the await above lets afterResult() (running from a frame observed while we waited) set it back to null concurrently; re-checking is deliberate, not redundant
                if(currentTurn !== null) {
                    await interruptCurrentTurnInternal('shutdown turn-wait elapsed');
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
        if(deadlineTimer !== undefined) {
            clock.clearTimer(deadlineTimer);
        }
        currentHandleRef?.close();
    }

    return {
        open, submit, appendWithoutTurn, adoptWakeTurn, adoptPeerTurn, deliver, interruptCurrent, subscribeTurn, status, shutdown,
        getCompactionThresholdPercent: () => guard.getThresholdPercent(),
        setCompactionThresholdPercent: (percent: number) => { guard.setThresholdPercent(percent); },
    };
}
