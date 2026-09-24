/**
 * The long-lived session ledger: a pure, structurally-shared, clock-free reducer over raw SDK
 * frames and conductor-stamped events (design doc section 7). Every {@link LedgerEvent} carries
 * `at: Date`, stamped by the caller (the conductor, driven by a {@link Clock} from ./clock.ts);
 * this module never calls `Date.now()`/`new Date()` itself. {@link reduceLedger} returns the
 * exact same `Ledger` reference when an event changes nothing, and otherwise a new object that
 * shares every untouched sub-object with the input, so a subscriber (or React-style consumer)
 * can diff with `===`. The one exception to "pure" is a single `logger.debug` line in
 * {@link applyTaskProgress}, emitted once per task id for the first `workflow_progress` frame it
 * sees; it observes, never decides.
 *
 * @module agent/session/ledger
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger, type Logger } from '@hughescr/logger';
import type { ChannelId } from '../types';
import { type ActivityPhase, phaseFromFrame } from './activity-phase';
import type { ContextUsageSummary, EnvelopeKind, EnvelopeMeta, EnvelopeOrigin, SessionRole } from './types';

/**
 * How many finished tasks a {@link Ledger} keeps. The task board renders finished rows from them,
 * so a handful of boards' worth is plenty and the list must not grow without bound across a boot.
 */
const FINISHED_TASKS_CAP = 20;

/** One in-flight turn: opened by `turn_submitted`, or spontaneously by an unsolicited assistant frame. */
export interface LedgerTurn {
    /** Stable id for this turn: the submitting envelope's `id`, or a synthesized id for a spontaneously-opened notification turn. Matched against a {@link LedgerEvent} `turn_synopsis`'s `turnId` so a stale synopsis (from a turn that has since ended) is dropped rather than misapplied to whatever turn is open now. */
    id:            string
    kind:          EnvelopeKind
    startedAt:     Date
    queuedAt?:     Date
    envelopeId?:   string
    channelId?:    ChannelId
    /** The submitting envelope's {@link import('./types').Envelope.origin}, carried through for symmetry with {@link EnvelopeMeta.origin}. No current reader consumes this — the ledger's `queued.human` accounting reads {@link EnvelopeMeta.origin} directly, before this turn exists. */
    origin?:       EnvelopeOrigin
    phase:         ActivityPhase | null
    firstTokenAt?: Date
    interrupting:  boolean
    /** The submitting envelope's {@link import('./types').Envelope.synopsisSeed} — header-free, capped content the turn synopsis producer (`turn-synopsis.ts`) seeds its first Haiku generation from. Absent for a spontaneously-opened notification turn (no envelope exists) and for a seedless envelope. */
    seed?:         string
    /**
     * The turn synopsis: a one-line Haiku description of what this turn is doing, set by a
     * matching `turn_synopsis` event (`turn-synopsis.ts`'s producer). It is a turn-level fact, so
     * phase flips and compaction never touch it; a new turn starts without one. Read by Discord
     * presence (the custom status) and by the OTHER session's ambient line ("working on …").
     */
    synopsis?:     string
}

/** The latest `task_progress` payload for a task, plus the final `usage` a `task_notification` carries. */
export interface LedgerTaskProgress {
    summary?:      string
    lastToolName?: string
    totalTokens?:  number
    toolUses?:     number
    durationMs?:   number
    at:            Date
}

/** One declared phase of a running workflow, from a `workflow_phase` entry of `workflow_progress`. */
export interface LedgerWorkflowPhase {
    index: number
    title: string
}

/** One agent of a running workflow, from a `workflow_agent` entry of `workflow_progress`. */
export interface LedgerWorkflowAgent {
    index:      number
    label:      string
    phaseIndex: number
    state:      'running' | 'done' | 'error'
    tokens:     number
    toolCalls:  number
}

/** A workflow task's shape, derived from the `workflow_progress` array of each `task_progress`. */
export interface LedgerTaskWorkflow {
    phases: LedgerWorkflowPhase[]
    agents: LedgerWorkflowAgent[]
}

/**
 * One tracked task — foreground or background — from `task_started`, advanced by `task_progress`,
 * and finished by a `task_notification`, a `tool_result` for its `toolUseId` (foreground only),
 * disappearing from `background_tasks_changed`, or a `task_lost` event.
 */
export interface LedgerTask {
    id:          string
    /** The `tool_use_id` of the Task tool call that launched this task; the join key for a foreground task's finishing `tool_result`. */
    toolUseId?:  string
    taskType:    string
    kind:        'subagent' | 'workflow' | 'shell' | 'monitor' | 'other'
    description: string
    /** `subagent_type` for sub-agents, `workflow_name` for workflows. */
    label?:      string
    /** True when the SDK registered the task in the background (`is_backgrounded`); a foreground task blocks its spawning tool call. */
    background:  boolean
    /** Channel of the turn that was open when the task started; undefined for perch or turn-less launches. */
    channelId?:  ChannelId
    /** Id of the turn that was open at `task_started` — groups tasks into one board. */
    turnId?:     string
    startedAt:   Date
    /** Latest `task_progress` payload, when any has arrived. */
    progress?:   LedgerTaskProgress
    /** Workflows only: derived from `workflow_progress` on each `task_progress`. */
    workflow?:   LedgerTaskWorkflow
    status:      'running' | 'completed' | 'failed' | 'stopped'
    finishedAt?: Date
}

/**
 * One rate-limit window as the ledger holds it. `utilization` is normalised to a 0-100 PERCENT:
 * both sources report a 0-1 fraction (block-0 probe P4 — the CLI reads the
 * `anthropic-ratelimit-unified-*-utilization` headers through `n => Math.min(1, n)`), and the
 * ledger is the place that conversion happens exactly once.
 */
export interface QuotaWindow {
    /** Percent of the window consumed, 0-100. */
    utilization: number
    resetsAt?:   Date
}

/**
 * The set of rate-limit windows one quota update can carry. Every member is optional: a source
 * may know only some of them, and {@link reduceLedger} merges per window rather than replacing
 * the whole set, so a partial update never erases a window another source already established.
 */
export interface QuotaWindows {
    fiveHour?: QuotaWindow
    sevenDay?: QuotaWindow
    /**
     * Weekly per-model windows, keyed by the RAW rate-limit type (`seven_day_opus`,
     * `seven_day_sonnet`, …) rather than a trimmed model name, so an unrecognised
     * `seven_day_*` variant the API adds later still lands somewhere lossless.
     */
    perModel?: Record<string, QuotaWindow>
}

/** `'headers'` for an SDK `rate_limit_event`; `'poll'` for the usage-endpoint poller. */
export type QuotaSource = 'headers' | 'poll';

/**
 * One window as the ledger holds it, plus the provenance of that specific reading: which source
 * reported it, and when. `observedAt` is stamped with the source's OWN reading time — the `at`
 * the caller attached to the `rate_limit_event` frame or the `quota_polled` event that carried
 * this window — the instant this window's value or source last changed. A repeat reading from
 * the SAME source that says exactly the same thing (same `utilization`, same `resetsAt`) leaves
 * `observedAt` untouched, so `observedAt` promises "last actually moved", not "last polled" — see
 * {@link foldWindow}. Each unified window carries its OWN `observedAt`/`source` rather than one
 * stamp for the whole {@link LedgerQuota}, because a partial update (a `rate_limit_event` frame
 * naming only the window that tripped it, or a poll that reports only one window) genuinely
 * ages the two windows independently — stamping the whole ledger with one instant used to make a
 * retained, untouched window silently inherit a newer sibling's freshness.
 */
export type QuotaWindowObservation = QuotaWindow & {
    observedAt: Date
    source:     QuotaSource
};

/** {@link Ledger.quota}: the last known windows, each dated and sourced independently. */
export interface LedgerQuota {
    fiveHour?: QuotaWindowObservation
    sevenDay?: QuotaWindowObservation
    perModel?: Record<string, QuotaWindowObservation>
    /** When this ledger's quota was last touched by a fold that actually moved something. */
    revisedAt: Date
}

/** The full session ledger state, folded from a stream of {@link LedgerEvent}s by {@link reduceLedger}. */
export interface Ledger {
    role:             SessionRole
    sessionId?:       string
    turn:             LedgerTurn | null
    queued:           { human: number, other: number }
    /** Every task still running, foreground and background alike. */
    tasks:            LedgerTask[]
    /** The {@link FINISHED_TASKS_CAP} most recently finished tasks, newest last. */
    finishedTasks:    LedgerTask[]
    compaction:       'none' | 'compacting'
    context:          { used: number, window: number, percentage: number, lastCompactionAt?: Date }
    process:          { rssBytes: number }
    perch:            { slot?: string, endsAt?: Date }
    cost:             { cumulativeUsd: number, lastTurnUsd: number }
    latency:          { bySource: Partial<Record<EnvelopeKind, number>> }
    /** Subscription rate-limit utilization; absent until the first `rate_limit_event` or poll. */
    quota?:           LedgerQuota
    /**
     * When the last open turn closed (the `result` frame's own `at`), or absent while this
     * session has never finished a turn on this process. Read by the ambient other-session line
     * (./ambient-lines.ts) to render `idle since HH:mm`; a bare `result` that closes no turn
     * never touches it.
     */
    lastTurnEndedAt?: Date
}

/** Every fact the conductor can fold into a {@link Ledger}. Every member carries `at: Date`. */
export type LedgerEvent
    = | { type: 'sdk_frame', frame: SDKMessage, at: Date }
      | { type: 'envelope_queued', kind: EnvelopeKind, origin?: EnvelopeOrigin, at: Date }
      | { type: 'turn_submitted', envelope: EnvelopeMeta, at: Date }
      | { type: 'interrupt_requested', at: Date }
      /*
       * The three compaction lifecycle events. The conductor is their only dispatcher (its
       * `compactionStarted`/`compactionCompleted`/`compactionFailed`), and each reducer is
       * idempotent: a start while already `'compacting'`, or a completion/failure while already
       * `'none'`, returns the ledger by reference, so a second observation of the same fact
       * notifies nobody.
       */
      | { type: 'compaction_started', trigger?: 'manual' | 'auto', at: Date }
      | { type: 'compaction_completed', at: Date }
      | { type: 'compaction_failed', reason?: string, at: Date }
      | { type: 'context_usage_polled', usage: ContextUsageSummary, at: Date }
      | { type: 'tick', rssBytes: number, at: Date }
      | { type: 'task_lost', taskId: string, at: Date }
      | { type: 'session_opened', sessionId: string, at: Date }
      /**
       * The session's running `total_cost_usd` as reported by the bare result that acknowledges
       * the opening `[BOOT]` handshake (`conductor.ts`'s `noteAcknowledgedCost`). Not a turn's
       * result, so it sets only `cost.cumulativeUsd` — the baseline the next turn's
       * `lastTurnUsd` is measured against — and never closes a turn. On a resumed session it is
       * how the restored total (which `session_opened` zeroed) comes back without being billed to
       * the first turn; the daily cost ceiling re-baselines on it rather than booking it.
       */
      | { type: 'cost_baseline', cumulativeUsd: number, at: Date }
      /**
       * The session's running `total_cost_usd` as reported by the bare result that acknowledges
       * any LATER `shouldQuery:false` message (an append). Reduced exactly like `cost_baseline`,
       * but it is live spend — `total_cost_usd` includes background subagent work that can land
       * between turns — so the daily cost ceiling books its delta.
       */
      | { type: 'cost_update', cumulativeUsd: number, at: Date }
      | { type: 'phase_changed', phase: ActivityPhase | null, at: Date }
      /**
       * A bare spontaneous turn the conductor just opened (`conductor.ts`'s
       * `beginSpontaneousTurn`), dispatched BEFORE it notifies turn subscribers so the turn
       * synopsis producer already has a handler — carrying the conductor's own turn id — by the
       * time the first frame arrives. The conductor is the sole minter of that id; `turnId` is
       * what every later `turn_synopsis` for this turn must match. Ignored (ledger returned by
       * reference) when a turn is already open.
       */
      | { type: 'spontaneous_turn_opened', turnId: string, at: Date }
      /**
       * A turn synopsis generated for the currently-open turn (`synopsis-stream-handler.ts`'s
       * `createSynopsisStreamHandler`). Sets `turn.synopsis` when `turnId` matches `turn.id`, and
       * is matched on `turnId` ONLY; dropped when it does not match (design doc section 8) — a
       * synopsis resolving after its turn ended must never overwrite an unrelated turn's. It
       * describes the turn's recent activity as a whole, so it lives on the turn: phase flips
       * (thinking<->using_tool every few seconds, while a Haiku generation takes about five) and
       * compaction never touch it, and it stays until a fresher synopsis replaces it.
       */
      | { type: 'turn_synopsis', turnId: string, text: string, at: Date }
      /**
       * A quota reading from the usage-endpoint poller
       * (the app's quota poller), already normalised to
       * {@link QuotaWindow} units. Merged per window into {@link Ledger.quota} with
       * `source: 'poll'`; the SDK's own `rate_limit_event` frames fold in the same place with
       * `source: 'headers'`.
       */
      | { type: 'quota_polled', quota: QuotaWindows, at: Date };

/** A fresh {@link Ledger} for `role`, with every field at its zero value. */
export function initialLedger(role: SessionRole): Ledger {
    return {
        role,
        turn:          null,
        queued:        { human: 0, other: 0 },
        tasks:         [],
        finishedTasks: [],
        compaction:    'none',
        context:       { used: 0, window: 0, percentage: 0 },
        process:       { rssBytes: 0 },
        perch:         {},
        cost:          { cumulativeUsd: 0, lastTurnUsd: 0 },
        latency:       { bySource: {} },
    };
}

/** `task_type` -> ledger task kind. Everything not explicitly recognised is `'other'`. */
function taskKindFor(taskType: string | undefined): LedgerTask['kind'] {
    // Stryker disable next-line llm: taskType is string | undefined, where == and === agree against a string literal
    if(taskType === 'local_agent') {
        return 'subagent';
    }
    if(taskType === 'local_workflow') {
        return 'workflow';
    }
    if(taskType === 'local_bash') {
        return 'shell';
    }
    if(taskType === 'monitor' || taskType === 'local_monitor') {
        return 'monitor';
    }
    return 'other';
}

type ResultFrame = Extract<SDKMessage, { type: 'result' }>;
type AssistantFrame = Extract<SDKMessage, { type: 'assistant' }>;
type UserFrame = Extract<SDKMessage, { type: 'user' }>;
type TaskStartedFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_started' }>;
type TaskProgressFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_progress' }>;
type TaskNotificationFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_notification' }>;
type BackgroundTasksChangedFrame = Extract<SDKMessage, { type: 'system', subtype: 'background_tasks_changed' }>;

/**
 * A `task_progress` frame as the CLI actually emits it: the SDK `.d.ts` does not declare
 * `workflow_progress`, which every workflow progress frame carries, so it is read as `unknown`
 * and parsed defensively by {@link parseWorkflowProgress} — never cast into an assumed shape.
 */
type TaskProgressWithWorkflow = TaskProgressFrame & { workflow_progress?: unknown };

/** `task_notification`'s `usage`, and `task_progress`'s, read as all-optional: the CLI has shipped frames without it. */
interface OptionalTaskUsage {
    total_tokens?: number
    tool_uses?:    number
    duration_ms?:  number
}

/**
 * A `result` frame of any subtype closes an open turn and folds `total_cost_usd` into
 * `cost.cumulativeUsd`. `lastTurnUsd` is the delta against the running cumulative, clamped at 0,
 * and is only updated when a turn was actually open (a bare result with no turn open must not
 * misreport a turn cost — see design doc section 7). Closing the turn also finishes every running
 * FOREGROUND task: a foreground sub-agent blocks its spawning tool call, so it cannot outlive the
 * turn, and an interrupted turn ends without the `tool_result` that would otherwise finish it, and
 * stamps {@link Ledger.lastTurnEndedAt} with this frame's own `at` (a bare result, closing no
 * turn, leaves it at whatever the last real turn-close set).
 */
function reduceResultFrame(ledger: Ledger, frame: ResultFrame, at: Date): Ledger {
    const { total_cost_usd: cumulativeUsd } = frame;
    if(ledger.turn === null) {
        return reduceCostBaseline(ledger, cumulativeUsd);
    }
    const lastTurnUsd = Math.max(0, cumulativeUsd - ledger.cost.cumulativeUsd);
    const stopped = stopForegroundTasks(ledger, at);
    return { ...stopped, turn: null, lastTurnEndedAt: at, cost: { cumulativeUsd, lastTurnUsd } };
}

/**
 * Sets `cost.cumulativeUsd` to `cumulativeUsd`, leaving the turn and `lastTurnUsd` alone; returns
 * `ledger` by reference when it already holds that total. Shared by a `result` frame that closes no
 * turn and by the `cost_baseline` and `cost_update` events.
 */
function reduceCostBaseline(ledger: Ledger, cumulativeUsd: number): Ledger {
    if(cumulativeUsd === ledger.cost.cumulativeUsd) {
        return ledger;
    }
    return { ...ledger, cost: { ...ledger.cost, cumulativeUsd } };
}

/**
 * Moves every running foreground task onto `finishedTasks` as `'stopped'`, leaving background
 * tasks (which do outlive their turn) running. Returns `ledger` by reference when there is no
 * foreground task to stop, so the common case shares `tasks` and `finishedTasks`.
 */
function stopForegroundTasks(ledger: Ledger, at: Date): Ledger {
    const foreground = ledger.tasks.filter(task => !task.background);
    if(foreground.length === 0) {
        return ledger;
    }
    return {
        ...ledger,
        tasks:         ledger.tasks.filter(task => task.background),
        finishedTasks: appendAllStopped(ledger.finishedTasks, foreground, at),
    };
}

/**
 * A ROOT assistant frame with no turn open spontaneously opens a `'notification'` turn. A child
 * assistant frame (`parent_tool_use_id` non-null) cannot open the root ledger's turn: subagents
 * can emit their final assistant frame while the session is idle immediately before the native
 * task-notification wake starts its root turn. With a turn open, child and root assistant frames
 * both continue to update the turn: the first stamps `firstTokenAt` and, when the turn carries a
 * `queuedAt`, the queue-to-first-token latency for its `kind`; every frame updates `turn.phase`
 * via {@link phaseFromFrame}.
 *
 * The null-turn branch is now a defensive backstop rather than a routine path: `conductor.ts`
 * dispatches `spontaneous_turn_opened` before an assistant frame reaches this reducer for BOTH
 * ways a turn can start unbidden — the ordinary spontaneous open, and a frame landing in the
 * `awaitingTurnEnd` window where the conductor declines to claim `currentTurn`. Do not delete
 * it: a ledger fed frames by anything that does not observe that protocol (a future driver, a
 * replay) would otherwise silently drop the whole turn, and the phase it mints here is what
 * keeps presence honest in that case.
 */
function reduceAssistantFrame(ledger: Ledger, frame: AssistantFrame, at: Date): Ledger {
    if(ledger.turn === null) {
        if(frame.parent_tool_use_id !== null) {
            return ledger;
        }
        const phase = phaseFromFrame(frame, null, at);
        return { ...ledger, turn: { id: `notification-${at.getTime()}`, kind: 'notification', startedAt: at, phase, interrupting: false } };
    }

    const { turn } = ledger;
    const phase = phaseFromFrame(frame, turn.phase, at);
    const isFirstToken = turn.firstTokenAt === undefined;
    if(!isFirstToken && phase === turn.phase) {
        return ledger;
    }

    const firstTokenAt = isFirstToken ? at : turn.firstTokenAt;
    const latency = isFirstToken && turn.queuedAt !== undefined
        ? { bySource: { ...ledger.latency.bySource, [turn.kind]: at.getTime() - turn.queuedAt.getTime() } }
        : ledger.latency;
    return { ...ledger, turn: { ...turn, phase, firstTokenAt }, latency };
}

/** `subagent_type` for sub-agents, `workflow_name` for workflows, nothing for shells and monitors. */
function taskLabelFor(kind: LedgerTask['kind'], frame: { subagent_type?: string, workflow_name?: string }): string | undefined {
    if(kind === 'workflow') {
        return frame.workflow_name;
    }
    if(kind === 'subagent') {
        return frame.subagent_type;
    }
    return undefined;
}

/** Appends `task` to the finished list, keeping only the {@link FINISHED_TASKS_CAP} most recent (newest last). */
function appendFinished(finished: readonly LedgerTask[], task: LedgerTask): LedgerTask[] {
    return [...finished, task].slice(-FINISHED_TASKS_CAP);
}

/**
 * Appends every task of `tasks` to `finished` as `'stopped'`, in order. `finished` comes back by
 * reference when `tasks` is empty, so a caller that stops nothing shares its finished list.
 */
function appendAllStopped(finished: LedgerTask[], tasks: readonly LedgerTask[], at: Date): LedgerTask[] {
    let next = finished;
    for(const task of tasks) {
        next = appendFinished(next, { ...task, status: 'stopped', finishedAt: at });
    }
    return next;
}

/** Moves `finished` (already stamped with its terminal status) out of `tasks` and onto `finishedTasks`. */
function moveToFinished(ledger: Ledger, finished: LedgerTask): Ledger {
    return {
        ...ledger,
        tasks:         ledger.tasks.filter(task => task.id !== finished.id),
        finishedTasks: appendFinished(ledger.finishedTasks, finished),
    };
}

/** The fields a `task_started` can contribute to a task another frame created first. */
const TASK_STARTED_FIELDS = ['toolUseId', 'label', 'channelId', 'turnId', 'background'] as const;

/**
 * A `task_started` for an id that is already tracked — `background_tasks_changed` can create the
 * entry a tick earlier, carrying only what that payload holds — fills in the fields only the start
 * frame knows, and overwrites nothing already recorded (the payload's description, kind and
 * `startedAt` stay). `background` is the exception: the start frame is authoritative about it.
 * Returns `ledger` by reference when there is nothing to add, so a plain duplicate frame is a
 * no-op.
 */
function enrichStartedTask(ledger: Ledger, current: LedgerTask, frame: TaskStartedFrame): Ledger {
    const kind = taskKindFor(frame.task_type);
    const enriched: LedgerTask = {
        ...current,
        toolUseId:  current.toolUseId ?? frame.tool_use_id,
        label:      current.label ?? taskLabelFor(kind, frame),
        channelId:  current.channelId ?? ledger.turn?.channelId,
        turnId:     current.turnId ?? ledger.turn?.id,
        background: frame.is_backgrounded === true,
    };
    if(!TASK_STARTED_FIELDS.some(field => current[field] !== enriched[field])) {
        return ledger;
    }
    return { ...ledger, tasks: ledger.tasks.map(task => (task.id === enriched.id ? enriched : task)) };
}

/** Adds a non-ambient task — foreground or background — exactly once (enriching a repeated `task_id`). */
function applyTaskStarted(ledger: Ledger, frame: TaskStartedFrame, at: Date): Ledger {
    if(frame.ambient === true) {
        return ledger;
    }
    const current = ledger.tasks.find(task => task.id === frame.task_id);
    if(current !== undefined) {
        return enrichStartedTask(ledger, current, frame);
    }
    const kind = taskKindFor(frame.task_type);
    const task: LedgerTask = {
        id:          frame.task_id,
        toolUseId:   frame.tool_use_id,
        taskType:    frame.task_type ?? 'unknown',
        kind,
        description: frame.description,
        label:       taskLabelFor(kind, frame),
        background:  frame.is_backgrounded === true,
        channelId:   ledger.turn?.channelId,
        turnId:      ledger.turn?.id,
        startedAt:   at,
        status:      'running',
    };
    return { ...ledger, tasks: [...ledger.tasks, task] };
}

/** The usage numbers of a `task_progress`/`task_notification` frame, in {@link LedgerTaskProgress} terms. */
function usageFields(usage: OptionalTaskUsage | undefined): Pick<LedgerTaskProgress, 'totalTokens' | 'toolUses' | 'durationMs'> {
    return { totalTokens: usage?.total_tokens, toolUses: usage?.tool_uses, durationMs: usage?.duration_ms };
}

/** Reads `key` off `source` when `source` is a non-null object, assuming nothing else about its shape. */
function readField(source: unknown, key: string): unknown {
    if(source === null || typeof source !== 'object') {
        return undefined;
    }
    return (source as Record<string, unknown>)[key];
}

/** `source[key]` when it is a string, otherwise undefined. */
function readString(source: unknown, key: string): string | undefined {
    const value = readField(source, key);
    return typeof value === 'string' ? value : undefined;
}

/** `source[key]` when it is a number, otherwise 0 — a malformed entry is defaulted, never thrown on. */
function readNumber(source: unknown, key: string): number {
    const value = readField(source, key);
    return typeof value === 'number' ? value : 0;
}

/**
 * `source[key]` when it is a finite number, otherwise undefined. Phases and agents are keyed by
 * their index, so an entry with no usable one cannot be filed: defaulting it to 0 (as this once
 * did) silently overwrote the real phase or agent 0.
 */
function readIndex(source: unknown, key: string): number | undefined {
    const value = readField(source, key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `workflow_agent`'s `state`: `'done'`/`'error'` map through, and anything else (`'start'`, an unknown string, a missing field) is running. */
function workflowAgentState(state: unknown): LedgerWorkflowAgent['state'] {
    if(state === 'done') {
        return 'done';
    }
    if(state === 'error') {
        return 'error';
    }
    return 'running';
}

/**
 * Parses the CLI's `workflow_progress` array into {@link LedgerTaskWorkflow}. Everything is
 * optional and defensively read: a non-array payload yields undefined (leaving whatever the task
 * already had), and an entry that is not a recognised object is skipped rather than thrown on.
 * Phases and agents are keyed by `index`, so a later announcement of the same index replaces the
 * earlier one; both keep first-seen order. An entry whose `index` is not a finite number cannot be
 * keyed at all and is skipped; every other field still falls back to its default.
 */
function parseWorkflowProgress(raw: unknown): LedgerTaskWorkflow | undefined {
    if(!Array.isArray(raw)) {
        return undefined;
    }
    const phases = new Map<number, LedgerWorkflowPhase>();
    const agents = new Map<number, LedgerWorkflowAgent>();
    for(const entry of raw) {
        const type = readField(entry, 'type');
        const index = readIndex(entry, 'index');
        if(index === undefined) {
            continue;
        }
        if(type === 'workflow_phase') {
            phases.set(index, { index, title: readString(entry, 'title') ?? '' });
        }
        if(type === 'workflow_agent') {
            agents.set(index, {
                index,
                label:      readString(entry, 'label') ?? '',
                phaseIndex: readNumber(entry, 'phaseIndex'),
                state:      workflowAgentState(readField(entry, 'state')),
                tokens:     readNumber(entry, 'tokens'),
                toolCalls:  readNumber(entry, 'toolCalls'),
            });
        }
    }
    return { phases: [...phases.values()], agents: [...agents.values()] };
}

/**
 * Records the latest `task_progress` on a running task; an unknown `task_id` is ignored (progress
 * never creates a task). Workflow frames additionally refresh {@link LedgerTask.workflow}, and the
 * first `workflow_progress` array seen for a task id is logged raw at debug level so the shape the
 * CLI actually emits can be checked against `docs/plans/task-board.md` on the first real run. That
 * one debug line is this module's only side effect; the fold itself stays pure.
 */
function applyTaskProgress(ledger: Ledger, frame: TaskProgressWithWorkflow, at: Date): Ledger {
    const current = ledger.tasks.find(task => task.id === frame.task_id);
    if(current === undefined) {
        return ledger;
    }
    const workflow = parseWorkflowProgress(frame.workflow_progress);
    if(workflow !== undefined && current.workflow === undefined) {
        logger.debug({ taskId: frame.task_id, frame }, 'Ledger: first workflow_progress frame for a task');
    }
    const next: LedgerTask = {
        ...current,
        progress: { summary: frame.summary, lastToolName: frame.last_tool_name, ...usageFields(frame.usage), at },
        workflow: workflow ?? current.workflow,
    };
    return { ...ledger, tasks: ledger.tasks.map(task => (task.id === next.id ? next : task)) };
}

/** A `task_notification`'s terminal status, defaulting to `'completed'` for a missing or unrecognised value. */
function finishedStatusOf(status: string | undefined): Exclude<LedgerTask['status'], 'running'> {
    if(status === 'failed') {
        return 'failed';
    }
    if(status === 'stopped') {
        return 'stopped';
    }
    return 'completed';
}

/**
 * The terminal status `ledger` recorded for `taskId` in `finishedTasks`, or `undefined` when it
 * holds no finished record for that id (still running, never tracked, or already evicted past
 * the finished-tasks cap). The LATEST record wins, since the SDK can reuse a task id and the one
 * just finished is appended last. Lets a caller journal how a task ended without re-deriving
 * {@link finishedStatusOf}'s mapping.
 */
export function finishedTaskStatus(ledger: Ledger, taskId: string): Exclude<LedgerTask['status'], 'running'> | undefined {
    const finished = ledger.finishedTasks.findLast(task => task.id === taskId);
    return finished === undefined ? undefined : finishedStatusOf(finished.status);
}

/** The frame's final usage merged into the task's progress; the progress so far when it carries none. */
function notifiedProgress(task: LedgerTask, frame: TaskNotificationFrame, at: Date): LedgerTaskProgress | undefined {
    if(frame.usage === undefined) {
        return task.progress;
    }
    return { ...task.progress, ...usageFields(frame.usage), at };
}

/**
 * A `task_notification` for a task that already left `tasks` — `background_tasks_changed` can drop
 * it from the payload a tick before the notification arrives, and a closing turn or `task_lost`
 * stops it outright — corrects that finished row in place: the frame's status wins and its final
 * usage merges into `progress`, while `finishedAt` keeps the moment the task actually stopped.
 * An id in neither list is ignored (returned by reference).
 */
function correctFinishedTask(ledger: Ledger, frame: TaskNotificationFrame, at: Date): Ledger {
    const current = ledger.finishedTasks.find(task => task.id === frame.task_id);
    if(current === undefined) {
        return ledger;
    }
    const corrected: LedgerTask = { ...current, progress: notifiedProgress(current, frame, at), status: finishedStatusOf(frame.status) };
    return { ...ledger, finishedTasks: ledger.finishedTasks.map(task => (task.id === corrected.id ? corrected : task)) };
}

/** Moves a task to `finishedTasks` with the frame's status and its final usage, or corrects it there. */
function applyTaskNotification(ledger: Ledger, frame: TaskNotificationFrame, at: Date): Ledger {
    const current = ledger.tasks.find(task => task.id === frame.task_id);
    if(current === undefined) {
        return correctFinishedTask(ledger, frame, at);
    }
    return moveToFinished(ledger, { ...current, progress: notifiedProgress(current, frame, at), status: finishedStatusOf(frame.status), finishedAt: at });
}

/**
 * REPLACE semantics for the BACKGROUND subset only: the background tasks become exactly the
 * payload (minus ambient entries), while foreground tasks — which never appear in this frame —
 * are kept untouched. `startedAt` (and everything else already recorded) is preserved for an id
 * already tracked; a newly-seen id is stamped `at`. A tracked background task that vanishes from
 * the payload without a `task_notification` is finished as `'stopped'` rather than dropped.
 */
function applyBackgroundTasksChanged(ledger: Ledger, frame: BackgroundTasksChangedFrame, at: Date): Ledger {
    const entries = frame.tasks.filter(task => task.ambient !== true);
    const byId = new Map(entries.map(entry => [entry.task_id, entry] as const));
    const knownIds = new Set(ledger.tasks.map(task => task.id));
    const tasks: LedgerTask[] = [];
    let finishedTasks = ledger.finishedTasks;
    for(const task of ledger.tasks) {
        const entry = byId.get(task.id);
        if(entry !== undefined) {
            // Present in the payload: refresh from it, and mark it background — a foreground task
            // that was later backgrounded reaches us only through this frame.
            tasks.push({ ...task, background: true, taskType: entry.task_type, kind: taskKindFor(entry.task_type), description: entry.description });
        } else if(task.background) {
            finishedTasks = appendFinished(finishedTasks, { ...task, status: 'stopped', finishedAt: at });
        } else {
            tasks.push(task);
        }
    }
    for(const entry of entries) {
        if(!knownIds.has(entry.task_id)) {
            tasks.push({
                id:          entry.task_id,
                taskType:    entry.task_type,
                kind:        taskKindFor(entry.task_type),
                description: entry.description,
                background:  true,
                channelId:   ledger.turn?.channelId,
                turnId:      ledger.turn?.id,
                startedAt:   at,
                status:      'running',
            });
        }
    }
    return { ...ledger, tasks, finishedTasks };
}

/** One content block of a `user` frame's `MessageParam` (its `content` is `string | ContentBlockParam[]`). */
type UserContentBlock = Exclude<UserFrame['message']['content'], string>[number];
type ToolResultBlock = Extract<UserContentBlock, { type: 'tool_result' }>;

/**
 * A `tool_result` block, narrowed by reading `type` off the value rather than trusting its static
 * type: `content` may be a bare string, which flattens to one non-object element here, and
 * {@link readField} answers undefined for it just as it does for any other unrecognised block.
 */
function isToolResultBlock(block: string | UserContentBlock): block is ToolResultBlock {
    return readField(block, 'type') === 'tool_result';
}

/**
 * A foreground task ends when the `user` frame carrying the `tool_result` for its `toolUseId`
 * arrives (`is_error` on that block means it failed). A backgrounded task's `tool_result` is the
 * immediate placeholder the CLI writes while the task keeps running, so background tasks are
 * deliberately never finished here — they end on their `task_notification`.
 *
 * `[content].flat()` normalises the `string | ContentBlockParam[]` union without branching on it:
 * a string content becomes a single element that {@link isToolResultBlock} rejects.
 */
function applyToolResults(ledger: Ledger, frame: UserFrame, at: Date): Ledger {
    let next = ledger;
    for(const block of [frame.message.content].flat()) {
        if(isToolResultBlock(block)) {
            next = finishForegroundTask(next, block.tool_use_id, block.is_error === true, at);
        }
    }
    return next;
}

/** Finishes the running foreground task launched by `toolUseId`, if any is tracked. */
function finishForegroundTask(ledger: Ledger, toolUseId: string, failed: boolean, at: Date): Ledger {
    const current = ledger.tasks.find(task => !task.background && task.toolUseId === toolUseId);
    if(current === undefined) {
        return ledger;
    }
    return moveToFinished(ledger, { ...current, status: failed ? 'failed' : 'completed', finishedAt: at });
}

/**
 * Reads a raw reset stamp as epoch milliseconds. A number is unix SECONDS (block-0 probe P4's
 * verbatim `rate_limit_event`), not milliseconds; a string is an ISO-8601 instant, accepted
 * because the usage endpoint's shape is UNVERIFIED (probe P5) and a timestamp is the field most
 * likely to arrive rendered rather than numeric — without this a parsed poll window would silently
 * lose its rollover boundary, which is the one field `quota-notes.ts` opens a new window instance
 * on. Anything unparseable (a garbage string, a non-finite number, a boolean) is no stamp at all.
 */
function toResetsAtMs(resetsAt: unknown): number | undefined {
    if(typeof resetsAt === 'number') {
        return Number.isFinite(resetsAt) ? resetsAt * 1000 : undefined;
    }
    if(typeof resetsAt === 'string') {
        // Stryker disable next-line llm: new Date(string).getTime() uses the same parser as Date.parse(string), so the results are identical
        const parsed = Date.parse(resetsAt);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Normalises one raw rate-limit window into a {@link QuotaWindow}. Shared by the
 * `rate_limit_event` fold below and the usage-endpoint poller (src/app/quota-poller.ts) so the unit
 * conversion lives in exactly one place: `utilization` is a 0-1 fraction scaled to 0-100, and
 * `resetsAt` is read by {@link toResetsAtMs}. Both arguments are `unknown` because both call sites
 * read them off a payload the SDK does not declare; a window with no usable utilization is no
 * window at all.
 *
 * A value outside 0-1 is REJECTED rather than clamped. Clamping was a live hazard: the usage
 * endpoint (UNVERIFIED, probe P5) could plausibly report a percent, and an 87 clamped to 100 is
 * not a degraded reading but a fabricated one — it would pause perch at `perchPauseAtPercent`,
 * fire the 75%/90% threshold notes, and leave no trace of having been invented. The one source
 * whose units ARE verified always delivers a 0-1 fraction (probe P4: the CLI reads the
 * `anthropic-ratelimit-unified-*-utilization` headers through `n => Math.min(1, n)`), so nothing
 * legitimate is lost. `NaN` needs no separate test: it satisfies neither comparison.
 * @param utilization Raw 0-1 utilization fraction
 * @param resetsAt Raw reset stamp — unix seconds or an ISO-8601 string — when the source carries one
 * @returns The normalised window, or undefined when `utilization` is missing, unusable or out of range
 */
export function toQuotaWindow(utilization: unknown, resetsAt: unknown): QuotaWindow | undefined {
    if(typeof utilization !== 'number' || !(utilization >= 0 && utilization <= 1)) {
        return undefined;
    }
    const percent = utilization * 100;
    const resetsAtMs = toResetsAtMs(resetsAt);
    // Stryker disable next-line llm: toResetsAtMs returns number or undefined and never null, so loose and strict undefined checks coincide.
    if(resetsAtMs === undefined) {
        return { utilization: percent };
    }
    return { utilization: percent, resetsAt: new Date(resetsAtMs) };
}

/**
 * Files one normalised window into {@link QuotaWindows} under the slot its raw rate-limit type
 * names: `five_hour` and `seven_day` are the two unified windows, every other `seven_day_*`
 * variant lands in `perModel` under its raw type, and anything else (`overage`, an unknown
 * future type) is dropped. Returns `windows` by reference when the type is not one it tracks.
 */
export function fileQuotaWindow(windows: QuotaWindows, type: string, window: QuotaWindow): QuotaWindows {
    if(type === 'five_hour') {
        return { ...windows, fiveHour: window };
    }
    if(type === 'seven_day') {
        return { ...windows, sevenDay: window };
    }
    if(type.startsWith('seven_day_')) {
        return { ...windows, perModel: { ...windows.perModel, [type]: window } };
    }
    return windows;
}

/** True when `windows` carries at least one window worth folding into the ledger. */
export function hasQuotaWindow(windows: QuotaWindows): boolean {
    return windows.fiveHour !== undefined || windows.sevenDay !== undefined || windows.perModel !== undefined;
}

type RateLimitFrame = Extract<SDKMessage, { type: 'rate_limit_event' }>;

/**
 * Reads every window a `rate_limit_event` carries. `rate_limit_info.unifiedWindows` is undeclared
 * in `sdk.d.ts` (so it is read defensively, never cast into an assumed shape) but was present on
 * every frame the block-0 probe observed and carries BOTH windows, so one frame refreshes the
 * whole picture. The top-level `rateLimitType`/`utilization`/`resetsAt` names only the window
 * that tripped the emit, and is applied last so it wins for that one window.
 */
function quotaWindowsFromFrame(frame: RateLimitFrame): QuotaWindows {
    const info = frame.rate_limit_info;
    let windows: QuotaWindows = {};
    const unified = readField(info, 'unifiedWindows');
    if(unified !== null && typeof unified === 'object') {
        for(const [type, raw] of Object.entries(unified)) {
            const window = toQuotaWindow(readField(raw, 'utilization'), readField(raw, 'resetsAt'));
            if(window !== undefined) {
                windows = fileQuotaWindow(windows, type, window);
            }
        }
    }
    const { rateLimitType } = info;
    if(rateLimitType !== undefined) {
        const window = toQuotaWindow(info.utilization, info.resetsAt);
        if(window !== undefined) {
            windows = fileQuotaWindow(windows, rateLimitType, window);
        }
    }
    return windows;
}

/**
 * Two readings of one window carry the same VALUE when both numbers and the rollover stamp
 * agree. Deliberately excludes `source`/`observedAt` — those are provenance, folded separately by
 * {@link foldWindow} — so this is purely "did the number the window reports change".
 */
function sameQuotaValue(previous: QuotaWindow | undefined, next: QuotaWindow | undefined): boolean {
    return previous?.utilization === next?.utilization && previous?.resetsAt?.getTime() === next?.resetsAt?.getTime();
}

/**
 * Folds one freshly-reported window into its tracked {@link QuotaWindowObservation} — see that
 * type's docstring for the dedupe rule this implements. Returns `previous` BY REFERENCE when the
 * SAME source reports the SAME value again, which is what lets {@link reduceQuota} detect "this
 * window didn't move" with a `===` check rather than a deep comparison. A reading from a
 * DIFFERENT source always refreshes `observedAt`, even when the number itself didn't move,
 * because the provenance changed — two sources agreeing is itself new information.
 */
function foldWindow(previous: QuotaWindowObservation | undefined, next: QuotaWindow, source: QuotaSource, observedAt: Date): QuotaWindowObservation {
    if(previous?.source === source && sameQuotaValue(previous, next)) {
        return previous;
    }
    return { ...next, source, observedAt };
}

/**
 * Folds `next` — one source's freshly-reported per-model windows — into `previous`'s accumulated
 * map, key by key via {@link foldWindow}, so a source that names only one model leaves every
 * other tracked model exactly as it was (including its own `source`/`observedAt`). Returns
 * `previous` BY REFERENCE when `next` is absent — mirroring {@link foldWindow}'s own undefined
 * case — so a unified-window-only reading never turns an absent `perModel` into an allocated
 * empty map. The merged key set can only GROW: nothing here, or anywhere `QuotaWindows` is
 * produced, ever removes a key, so no key of `previous` is ever dropped.
 */
function foldPerModel(
    previous: Record<string, QuotaWindowObservation> | undefined,
    next: Record<string, QuotaWindow> | undefined,
    source: QuotaSource,
    observedAt: Date
): Record<string, QuotaWindowObservation> | undefined {
    if(next === undefined) {
        return previous;
    }
    const merged: Record<string, QuotaWindowObservation> = { ...previous };
    for(const [key, window] of Object.entries(next)) {
        merged[key] = foldWindow(previous?.[key], window, source, observedAt);
    }
    return merged;
}

/**
 * True when `merged` (this fold's {@link foldPerModel} result) holds any window whose OBJECT
 * REFERENCE differs from `previous`'s same key — an added key or a changed value/source alike,
 * since `foldWindow` already returns a stable reference for a key that did not move. `merged`'s
 * key set is always a superset of `previous`'s (see {@link foldPerModel}: no key is ever
 * removed), so iterating `merged` alone covers everything that could possibly have moved.
 */
function perModelMoved(previous: Record<string, QuotaWindowObservation> | undefined, merged: Record<string, QuotaWindowObservation> | undefined): boolean {
    if(merged === undefined) {
        return false;
    }
    return Object.keys(merged).some(key => merged[key] !== previous?.[key]);
}

/**
 * Merges `windows` into `ledger.quota` window by window — a source that knows only one window
 * leaves the others EXACTLY as they were, including their own already-stamped `source` and
 * `observedAt` (see {@link foldWindow} and {@link foldPerModel}). Returns `ledger` by reference
 * when `windows` carries nothing at all, so a frame naming only untracked window types (or a poll
 * that parsed to nothing) is a no-op rather than a bogus refresh.
 *
 * It also returns `ledger` by reference when the fold MOVED nothing: every tracked window, and
 * every per-model window, came back from its fold by the SAME REFERENCE it already held. The
 * poller repeats the same numbers every five minutes and every quota subscriber
 * (`quota-notes.ts`, presence, the ambient-line providers) is woken by a changed ledger reference,
 * so re-allocating on an identical reading is pure noise.
 *
 * `revisedAt` (the ledger's own last-actually-touched instant) is deliberately NOT bumped for a
 * deduped reading, mirroring each window's own `observedAt`. This per-window stamping is the fix
 * for the bug this module used to have: the OLD `LedgerQuota` shared one `source`/`at` pair
 * across the whole reading, so a partial update — a `rate_limit_event` frame naming only the
 * window that tripped it, or a poll reporting only one window — let a genuinely untouched window
 * silently INHERIT a newer sibling's stamp (or a different source). `ambient-lines.ts`'s
 * cross-ledger freshness merge could then prefer a stale retained reading over a genuinely
 * fresher one from the other ledger, and `sdkLedgerFallbackData` could null out an entire
 * ledger's SDK-only rendering because exactly one window in it happened to be poll-sourced. Now
 * every window carries its own provenance, so neither failure mode is reachable.
 */
function reduceQuota(ledger: Ledger, windows: QuotaWindows, source: QuotaSource, observedAt: Date): Ledger {
    if(!hasQuotaWindow(windows)) {
        return ledger;
    }
    const previous = ledger.quota;
    const fiveHour = windows.fiveHour === undefined ? previous?.fiveHour : foldWindow(previous?.fiveHour, windows.fiveHour, source, observedAt);
    const sevenDay = windows.sevenDay === undefined ? previous?.sevenDay : foldWindow(previous?.sevenDay, windows.sevenDay, source, observedAt);
    const perModel = foldPerModel(previous?.perModel, windows.perModel, source, observedAt);
    if(previous !== undefined && fiveHour === previous.fiveHour && sevenDay === previous.sevenDay && !perModelMoved(previous.perModel, perModel)) {
        return ledger;
    }
    return { ...ledger, quota: { fiveHour, sevenDay, perModel, revisedAt: observedAt } };
}

/**
 * Frame-type-specific effects that never depend on the open turn: tasks and quota. A
 * `compact_boundary` frame is deliberately not reduced here — the conductor observes it and
 * dispatches `compaction_completed`, the one event that ends a compaction.
 */
function applyFrameSideEffects(ledger: Ledger, frame: SDKMessage, at: Date): Ledger {
    if(frame.type === 'user') {
        return applyToolResults(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'task_started') {
        return applyTaskStarted(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'task_progress') {
        return applyTaskProgress(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'task_notification') {
        return applyTaskNotification(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'background_tasks_changed') {
        return applyBackgroundTasksChanged(ledger, frame, at);
    }
    if(frame.type === 'rate_limit_event') {
        return reduceQuota(ledger, quotaWindowsFromFrame(frame), 'headers', at);
    }
    return ledger;
}

/**
 * Runs {@link phaseFromFrame} against the open turn for every frame type other than `assistant`
 * (which computes its own phase transition as part of opening/advancing the turn). A no-op frame
 * (phase returned by reference) leaves the ledger reference unchanged.
 */
function applyPhaseToOpenTurn(ledger: Ledger, frame: SDKMessage, at: Date): Ledger {
    if(ledger.turn === null) {
        return ledger;
    }
    const phase = phaseFromFrame(frame, ledger.turn.phase, at);
    if(phase === ledger.turn.phase) {
        return ledger;
    }
    return { ...ledger, turn: { ...ledger.turn, phase } };
}

function reduceSdkFrame(ledger: Ledger, frame: SDKMessage, at: Date): Ledger {
    if(frame.type === 'result') {
        return reduceResultFrame(ledger, frame, at);
    }
    if(frame.type === 'assistant') {
        return reduceAssistantFrame(ledger, frame, at);
    }
    const afterSideEffects = applyFrameSideEffects(ledger, frame, at);
    return applyPhaseToOpenTurn(afterSideEffects, frame, at);
}

/** `origin?.role === 'human'` is the ledger's one "human" queue; every other envelope is `'other'`. */
function isHumanTurn(origin: EnvelopeOrigin | undefined): boolean {
    return origin?.role === 'human';
}

function reduceEnvelopeQueued(ledger: Ledger, origin: EnvelopeOrigin | undefined): Ledger {
    const queued = isHumanTurn(origin)
        ? { ...ledger.queued, human: ledger.queued.human + 1 }
        : { ...ledger.queued, other: ledger.queued.other + 1 };
    return { ...ledger, queued };
}

/**
 * Opens the bare notification turn the conductor just minted an id for. Returns `ledger` by
 * reference when a turn is already open: the conductor's one-turn-in-flight invariant makes that
 * unreachable in the ordinary path, but a frame that arrived during `awaitingTurnEnd` can have
 * opened a turn through {@link reduceAssistantFrame} already — in which case the ledger's turn
 * (which presence reads) stays authoritative and the conductor's newer id is simply unused.
 */
function reduceSpontaneousTurnOpened(ledger: Ledger, turnId: string, at: Date): Ledger {
    if(ledger.turn !== null) {
        return ledger;
    }
    return { ...ledger, turn: { id: turnId, kind: 'notification', startedAt: at, phase: null, interrupting: false } };
}

function reduceTurnSubmitted(ledger: Ledger, envelope: EnvelopeMeta, at: Date): Ledger {
    const queued = isHumanTurn(envelope.origin)
        ? { ...ledger.queued, human: Math.max(0, ledger.queued.human - 1) }
        : { ...ledger.queued, other: Math.max(0, ledger.queued.other - 1) };
    const turn: LedgerTurn = {
        id:           envelope.id,
        kind:         envelope.kind,
        startedAt:    at,
        queuedAt:     envelope.queuedAt,
        envelopeId:   envelope.id,
        channelId:    envelope.channelId,
        origin:       envelope.origin,
        phase:        null,
        interrupting: false,
        seed:         envelope.seed,
    };
    const perch = envelope.kind === 'perch' && envelope.perch !== undefined
        ? { slot: envelope.perch.slot, endsAt: envelope.perch.endsAt }
        : ledger.perch;
    return { ...ledger, queued, turn, perch };
}

function reduceInterruptRequested(ledger: Ledger): Ledger {
    if(ledger.turn === null || ledger.turn.interrupting) {
        return ledger;
    }
    return { ...ledger, turn: { ...ledger.turn, interrupting: true } };
}

/**
 * A compaction started. Touches only `compaction` — never `turn.phase`: `Ledger.compaction` is
 * the single "compacting" authority. A no-op (same reference) when one is already in progress.
 */
function reduceCompactionStarted(ledger: Ledger): Ledger {
    if(ledger.compaction === 'compacting') {
        return ledger;
    }
    return { ...ledger, compaction: 'compacting' };
}

/** A compaction completed: back to `'none'`, stamping `lastCompactionAt`. A no-op (same reference) when none is in progress. */
function reduceCompactionCompleted(ledger: Ledger, at: Date): Ledger {
    if(ledger.compaction === 'none') {
        return ledger;
    }
    return { ...ledger, compaction: 'none', context: { ...ledger.context, lastCompactionAt: at } };
}

/** A failed compaction attempt returns `compaction` to `'none'` — no `lastCompactionAt` stamp, since nothing actually compacted. */
function reduceCompactionFailed(ledger: Ledger): Ledger {
    if(ledger.compaction === 'none') {
        return ledger;
    }
    return { ...ledger, compaction: 'none' };
}

function reduceContextUsagePolled(ledger: Ledger, usage: ContextUsageSummary): Ledger {
    const { context } = ledger;
    if(context.used === usage.totalTokens && context.window === usage.maxTokens && context.percentage === usage.percentage) {
        return ledger;
    }
    return { ...ledger, context: { ...context, used: usage.totalTokens, window: usage.maxTokens, percentage: usage.percentage } };
}

function reduceTick(ledger: Ledger, rssBytes: number): Ledger {
    if(ledger.process.rssBytes === rssBytes) {
        return ledger;
    }
    return { ...ledger, process: { rssBytes } };
}

/** A task the conductor could not account for is finished as `'stopped'` — the board still shows how it ended. */
function reduceTaskLost(ledger: Ledger, taskId: string, at: Date): Ledger {
    const current = ledger.tasks.find(task => task.id === taskId);
    if(current === undefined) {
        return ledger;
    }
    return moveToFinished(ledger, { ...current, status: 'stopped', finishedAt: at });
}

/**
 * A new session id means nothing the old session was running can ever report again, so every
 * tracked task — foreground and background alike — is finished as `'stopped'` rather than dropped:
 * the board still shows how the interrupted work ended. Any open `turn` is closed too (#99) — even
 * when the session id is unchanged, as after a crash reopen that resumes — since the process that
 * would have sent its result is gone; a re-sent turn opens again with its own `turn_submitted`.
 */
function reduceSessionOpened(ledger: Ledger, sessionId: string, at: Date): Ledger {
    if(ledger.sessionId === sessionId && ledger.tasks.length === 0 && ledger.cost.cumulativeUsd === 0 && ledger.turn === null) {
        return ledger;
    }
    return {
        ...ledger,
        sessionId,
        // A new session process has no turn in flight: one the dead process left open (a crash
        // mid-turn never sees that turn's result) would otherwise read as busy forever (#99).
        turn:          null,
        tasks:         [],
        finishedTasks: appendAllStopped(ledger.finishedTasks, ledger.tasks, at),
        cost:          { ...ledger.cost, cumulativeUsd: 0 },
    };
}

function reducePhaseChanged(ledger: Ledger, phase: ActivityPhase | null): Ledger {
    if(ledger.turn === null) {
        return ledger;
    }
    return { ...ledger, turn: { ...ledger.turn, phase } };
}

/**
 * Sets `turn.synopsis` from a `turn_synopsis` event when the event's `turnId` matches the
 * currently open turn's `id`. Returns `ledger` unchanged by reference when the event is stale (its
 * turn ended, or none is open yet) and when the text is what the turn already carries, so a
 * repeated synopsis notifies no subscriber. The phase is never touched (see the `turn_synopsis`
 * doc on {@link LedgerEvent}).
 */
function reduceTurnSynopsis(ledger: Ledger, event: Extract<LedgerEvent, { type: 'turn_synopsis' }>): Ledger {
    const { turn } = ledger;
    if(turn === null) {
        return ledger;
    }
    if(turn.id !== event.turnId) {
        return ledger;
    }
    if(turn.synopsis === event.text) {
        return ledger;
    }
    return { ...ledger, turn: { ...turn, synopsis: event.text } };
}

/**
 * Folds one {@link LedgerEvent} into `ledger`, pure and clock-free: `event.at` is the only source
 * of time. Returns `ledger` itself, by reference, when the event changes nothing.
 */
// eslint-disable-next-line complexity -- an exhaustive switch over LedgerEvent's discriminated union where every arm is a single delegating call; the metric here counts the union's member count, not branching logic
export function reduceLedger(ledger: Ledger, event: LedgerEvent): Ledger {
    switch(event.type) {
        case 'sdk_frame': {
            return reduceSdkFrame(ledger, event.frame, event.at);
        }
        case 'envelope_queued': {
            return reduceEnvelopeQueued(ledger, event.origin);
        }
        case 'turn_submitted': {
            return reduceTurnSubmitted(ledger, event.envelope, event.at);
        }
        case 'interrupt_requested': {
            return reduceInterruptRequested(ledger);
        }
        case 'compaction_started': {
            return reduceCompactionStarted(ledger);
        }
        case 'compaction_completed': {
            return reduceCompactionCompleted(ledger, event.at);
        }
        case 'compaction_failed': {
            return reduceCompactionFailed(ledger);
        }
        case 'context_usage_polled': {
            return reduceContextUsagePolled(ledger, event.usage);
        }
        case 'tick': {
            // Stryker disable next-line llm: the sole producer is process.memoryUsage().rss, whose non-negative integer output makes the fallback unreachable.
            return reduceTick(ledger, event.rssBytes);
        }
        case 'task_lost': {
            return reduceTaskLost(ledger, event.taskId, event.at);
        }
        case 'session_opened': {
            return reduceSessionOpened(ledger, event.sessionId, event.at);
        }
        case 'cost_baseline':
        case 'cost_update': {
            return reduceCostBaseline(ledger, event.cumulativeUsd);
        }
        case 'phase_changed': {
            return reducePhaseChanged(ledger, event.phase);
        }
        case 'spontaneous_turn_opened': {
            return reduceSpontaneousTurnOpened(ledger, event.turnId, event.at);
        }
        case 'turn_synopsis': {
            return reduceTurnSynopsis(ledger, event);
        }
        case 'quota_polled': {
            return reduceQuota(ledger, event.quota, 'poll', event.at);
        }
    }
}

/** Dependencies {@link createLedgerStore} needs beyond the reducer itself. */
export interface LedgerStoreDeps {
    logger: Pick<Logger, 'error'>
}

/** A minimal store wrapping {@link reduceLedger} with subscriber notification. */
export interface LedgerStore {
    /** Folds `event` into the current ledger and, if it changed, notifies every subscriber. */
    dispatch:  (event: LedgerEvent) => void
    /** The current ledger. */
    get:       () => Ledger
    /**
     * Registers `listener` to be called with the new ledger, and the {@link LedgerEvent} that
     * produced it, on every change; returns an unsubscribe function. The causing event lets a
     * listener distinguish facts the resulting `Ledger` snapshot alone cannot (for example: a
     * task disappearing from `ledger.tasks` because of an explicit `task_lost` event or a
     * `session_opened` reset, versus a normal `task_notification` frame).
     */
    subscribe: (listener: (ledger: Ledger, event: LedgerEvent) => void) => () => void
}

/**
 * Wraps {@link reduceLedger} in a tiny store: `dispatch` notifies subscribers only when the
 * ledger reference actually changed. A throwing subscriber is caught and logged via
 * `deps.logger.error({ error }, 'Ledger subscriber threw')` — once per throw — without blocking
 * the remaining subscribers (same isolation pattern as `state/manager.ts`'s notifySubscribers).
 */
export function createLedgerStore(role: SessionRole, deps: LedgerStoreDeps): LedgerStore {
    let ledger = initialLedger(role);
    const listeners = new Set<(ledger: Ledger, event: LedgerEvent) => void>();

    return {
        dispatch(event: LedgerEvent): void {
            const next = reduceLedger(ledger, event);
            if(next === ledger) {
                return;
            }
            ledger = next;
            // Snapshot before notifying: a subscriber may dispatch reentrantly, which reassigns
            // the `ledger` closure variable above before this loop reaches its later listeners.
            // Notifying from `snapshot` (fixed at this dispatch's outcome) rather than the mutable
            // `ledger` variable keeps every listener's delivery for THIS dispatch consistent, so a
            // listener that diffs consecutive ledgers by `===` never misses an intermediate state.
            const snapshot = ledger;
            for(const listener of listeners) {
                try {
                    listener(snapshot, event);
                } catch (error) {
                    deps.logger.error({ error }, 'Ledger subscriber threw');
                }
            }
        },
        get(): Ledger {
            return ledger;
        },
        subscribe(listener: (ledger: Ledger, event: LedgerEvent) => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
