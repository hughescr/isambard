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
 * (P9's `src/app/sessions.ts`) — this module only pushes the initial boot envelope once, right
 * after {@link Conductor.open} resolves, and drives the guard from every raw frame it observes,
 * which already covers every frame-observable release path (`compact_boundary`, the `/compact`
 * turn's own result, the `error-compacting-conversation` notification, and the clock ceiling).
 * {@link Conductor.recordCompactionSummary} is the one exception: it is a public entry point this
 * module exposes so P9's PostCompact hook wiring has somewhere to hand the SDK's raw
 * `compact_summary` text, since the summary itself never arrives on a stream frame this module
 * can observe.
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
import { logCompactionSummary, type LogCompactionSummaryDeps } from './compaction-log';
import { createDeliveryGuard, type DeliveryGuard } from './delivery-guard';
import {
    buildBootEnvelope,
    buildCompactEnvelope,
    buildResumeEnvelope,
    toSdkUserMessage
} from './envelope';
import { InputQueue } from './input-queue';
import { createInterruptFlag } from './interrupt-flag';
import type { Ledger, LedgerEvent, LedgerStore } from './ledger';
import type { SessionJournal, ResumeStore } from './ports';
import { computeRecovery } from './recovery';
import { resultFrameToError } from './result-frame-error';
import { openSession, type SessionHandle } from './session';
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
    } | null
}

/** Dependencies and configuration for {@link createConductor}. */
export interface CreateConductorParams {
    role:             SessionRole
    queryFn:          SessionQueryFn
    /** Builds full Agent SDK `Options` for a fresh (`undefined`) or resumed (session id) open. */
    buildOptions:     (resume?: string) => Options
    clock:            Clock
    /** Reads the process's current resident set size, in bytes. */
    readRss:          () => number
    ledgerStore:      LedgerStore
    config:           SessionConfig
    /** `config.retry.claude` — drives `is_error` resubmission, on the injected `clock`. */
    retryPolicy:      RetryPolicy
    journal:          SessionJournal
    resumeStore:      ResumeStore
    /**
     * Pre-formatted boot bundle text, pushed once as a `boot`-kind envelope right after
     * `open()` succeeds. Ignored when {@link buildBootBundle} is provided.
     */
    bootBundle?:      string
    /**
     * Builds the boot bundle text from boot-time crash recovery (P8): `open()` reads the
     * journal window ending now, computes {@link import('./recovery').computeRecovery}, and
     * (when this is provided) calls it with the recovery-derived lost-task and
     * undelivered-envelope descriptions — the same shape P6's boot-bundle builder input takes —
     * to produce the text pushed as the boot envelope, taking precedence over the static
     * {@link bootBundle} string.
     */
    buildBootBundle?: (input: Pick<BuildBootBundleInput, 'lostTasks' | 'undelivered'>) => string | Promise<string>
    /**
     * Backs {@link Conductor.recordCompactionSummary} (P8, design 3.3): when provided, a PostCompact
     * summary reported through that method is logged to `/events/compaction/<ts>` via
     * {@link import('./compaction-log').logCompactionSummary}, and the returned path rides the next
     * `compaction_completed` journal entry. Wiring an actual PostCompact hook to call
     * `recordCompactionSummary` is P9's job (see the module doc); omitted, `compaction_completed`
     * carries no `summaryPath`.
     */
    memoryBackend?:   LogCompactionSummaryDeps['memoryBackend']
    logger:           Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
    /** Observes every raw frame alongside {@link Conductor.subscribeTurn} subscribers. */
    onTurnFrame?:     (turnId: string, frame: SDKMessage) => void
    /** Classifies an `is_error` result's adapted error. Defaults to `classifyClaudeError`. */
    classifyError?:   (error: unknown) => ErrorClassification
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
    /**
     * Reports a just-finished compaction's PostCompact summary (design 3.3, P8): logs it via
     * {@link import('./compaction-log').logCompactionSummary} when {@link CreateConductorParams.memoryBackend}
     * was provided, and stashes the returned path so the next `compaction_completed` journal
     * entry carries it. A no-op (logged) when `memoryBackend` was not provided. The caller
     * (P9's hook wiring — see the module doc) is responsible for calling this from an actual
     * PostCompact hook with the SDK's `compact_summary`.
     */
    recordCompactionSummary:       (summary: string) => Promise<void>
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
    /** `undefined` for a spontaneous SDK-initiated turn nobody submitted. */
    item?:              QueuedItem
    kind:               TurnKind
    channelId?:         string
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
 * Creates a long-lived session conductor.
 * @param params See {@link CreateConductorParams}.
 * @returns A {@link Conductor}.
 */
export function createConductor(params: CreateConductorParams): Conductor {
    const {
        role, queryFn, buildOptions, clock, readRss, ledgerStore, config, retryPolicy,
        journal, resumeStore, bootBundle, buildBootBundle, memoryBackend, logger, onTurnFrame,
    } = params;
    const classifyError = params.classifyError ?? classifyClaudeError;

    let opened = false;
    let shuttingDown = false;
    /** Populated once by {@link runBootRecovery} at the start of {@link open}; guards {@link deliver} against re-sending an envelope a prior process already delivered. */
    let deliveryGuard: DeliveryGuard | undefined;
    /** Set by {@link recordCompactionSummary} when it successfully logs a summary; consumed (and cleared) the next time {@link journalCompactionOutcome} journals a successful `compaction_completed`. */
    let pendingCompactionSummaryPath: string | undefined;
    /** The text {@link pushBootBundle} pushes — the static {@link bootBundle} until {@link runBootRecovery} replaces it with {@link buildBootBundle}'s output, when provided. */
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

    function turnIdFor(turn: ActiveTurn | null): string {
        return turn?.item?.envelope.id ?? turn?.kind ?? 'none';
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
        journal.append({
            type: 'compaction_completed', at: now(), ...(pendingCompactionSummaryPath === undefined ? {} : { summaryPath: pendingCompactionSummaryPath }),
        });
        pendingCompactionSummaryPath = undefined;
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
            item, kind: item.envelope.kind, channelId: item.envelope.channelId, tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false,
        };
        const meta: EnvelopeMeta = { id: item.envelope.id, kind: item.envelope.kind, queuedAt: at, channelId: item.envelope.channelId };
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
        if(item.priority === 'human' && currentTurn.kind === 'notification') {
            enqueue(item);
            armHumanWaitEscalation();
            return;
        }
        enqueue(item);
    }

    /** Injects a `resume`-kind envelope ahead of everything else queued when an interrupted spontaneous notification turn left meaningful partial work behind. */
    function injectResumeNoteIfInterruptedNotification(turn: ActiveTurn, progress: StreamProgress): void {
        if(turn.kind !== 'notification' || !turn.interruptRequested) {
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

        injectResumeNoteIfInterruptedNotification(turn, progress);

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

    function onFrame(frame: SDKMessage): void {
        guard.onFrame(frame);
        if(currentTurn === null && !awaitingTurnEnd && frame.type === 'assistant') {
            currentTurn = { kind: 'notification', tracker: new StreamTracker(), interruptRequested: false, escalationArmed: false };
        }
        // boundary cast: AgentStreamEvent is the one-shot path's narrower observability-only view of a stream event; every SDKMessage shape StreamTracker.update switches on (system/task_started, assistant) is a subset of AgentStreamEvent's fields, matching the identical cast already documented in ./session.ts
        currentTurn?.tracker.update(frame as unknown as AgentStreamEvent);
        notifyTurnSubscribers(frame);
        ledgerStore.dispatch({ type: 'sdk_frame', frame, at: now() });
        if(frame.type === 'result') {
            void afterResult(frame);
        }
    }

    /** Opens exactly one fresh `queryFn` call, resolving once the session id is captured or rejecting on an immediate throw. Assigns `currentQueue`/`currentHandleRef` synchronously as part of settling, so a frame processed in the very same callback already sees the new handle as current. */
    async function openWithHandle(resumeId: string | undefined): Promise<{ handle: SessionHandle, sessionId: string }> {
        return new Promise((resolve, reject) => {
            let settled = false;
            const queue = new InputQueue();
            const interrupting = createInterruptFlag();
            const options = buildOptions(resumeId);
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

    function pushBootBundle(): void {
        if(resolvedBootBundle === undefined || resolvedBootBundle === '' || currentQueue === undefined) {
            return;
        }
        currentQueue.push(toSdkUserMessage(buildBootEnvelope(resolvedBootBundle, now())));
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
        try {
            try {
                const { handle, sessionId } = await openWithHandle(lastSessionId);
                try {
                    await finishOpen(sessionId, true, false);
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
            } catch{
                const { sessionId } = await openWithHandle(undefined);
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
                const { handle, sessionId } = await openWithHandle(stored);
                try {
                    await finishOpen(sessionId, true, false);
                } catch (finishError) {
                    discardHandle(handle);
                    throw finishError;
                }
                pushBootBundle();
                return { sessionId, resumed: true };
            } catch (error) {
                logger.warn({ error }, 'Resuming the stored session failed; opening a fresh session');
            }
        }
        const { sessionId } = await openWithHandle(undefined);
        await finishOpen(sessionId, false, stored !== undefined);
        pushBootBundle();
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

    async function recordCompactionSummary(summary: string): Promise<void> {
        if(memoryBackend === undefined) {
            logger.warn({ role }, 'Conductor.recordCompactionSummary: no memoryBackend configured; summary dropped');
            return;
        }
        const path = await logCompactionSummary({ memoryBackend, clock }, { role, summary });
        pendingCompactionSummaryPath = path;
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
            turn:        currentTurn === null ? null : { kind: currentTurn.kind, channelId: currentTurn.channelId, envelopeId: currentTurn.item?.envelope.id },
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
        open, submit, appendWithoutTurn, deliver, recordCompactionSummary, interruptCurrent, subscribeTurn, status, shutdown,
        getCompactionThresholdPercent: () => guard.getThresholdPercent(),
        setCompactionThresholdPercent: (percent: number) => { guard.setThresholdPercent(percent); },
    };
}
