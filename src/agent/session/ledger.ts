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
import { type ActivityPhase, phaseFromFrame } from './activity-phase';
import type { ContextUsageSummary, EnvelopeKind, EnvelopeMeta, SessionRole } from './types';

/**
 * How many finished tasks a {@link Ledger} keeps. The task board renders finished rows from them,
 * so a handful of boards' worth is plenty and the list must not grow without bound across a boot.
 */
const FINISHED_TASKS_CAP = 20;

/** One in-flight turn: opened by `turn_submitted`, or spontaneously by an unsolicited assistant frame. */
export interface LedgerTurn {
    /** Stable id for this turn: the submitting envelope's `id`, or a synthesized id for a spontaneously-opened notification turn. Matched against a {@link LedgerEvent} `phase_synopsis`'s `turnId` so a stale synopsis (from a turn that has since ended) is dropped rather than misapplied to whatever turn is open now. */
    id:            string
    kind:          EnvelopeKind
    startedAt:     Date
    queuedAt?:     Date
    envelopeId?:   string
    channelId?:    string
    phase:         ActivityPhase | null
    firstTokenAt?: Date
    interrupting:  boolean
    /** The submitting envelope's {@link import('./types').Envelope.synopsisSeed} — header-free, capped content the Discord presence synopsis attachment (`presence/turn-synopsis.ts`) seeds its first Haiku generation from. Absent for a spontaneously-opened notification turn (no envelope exists) and for a seedless envelope. */
    seed?:         string
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
    channelId?:  string
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

/** {@link Ledger.quota}: the last known windows, plus which source produced them and when. */
export type LedgerQuota = QuotaWindows & {
    /** `'headers'` for an SDK `rate_limit_event`; `'poll'` for the usage-endpoint poller. */
    source: 'headers' | 'poll'
    at:     Date
};

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
      | { type: 'envelope_queued', kind: EnvelopeKind, at: Date }
      | { type: 'turn_submitted', envelope: EnvelopeMeta, at: Date }
      | { type: 'interrupt_requested', at: Date }
      | { type: 'compaction_started', trigger?: 'manual' | 'auto', at: Date }
      | { type: 'compaction_finished', at: Date }
      | { type: 'compaction_failed', reason?: string, at: Date }
      | { type: 'context_usage_polled', usage: ContextUsageSummary, at: Date }
      | { type: 'tick', rssBytes: number, at: Date }
      | { type: 'task_lost', taskId: string, at: Date }
      | { type: 'session_opened', sessionId: string, at: Date }
      | { type: 'phase_changed', phase: ActivityPhase | null, at: Date }
      /**
       * A bare spontaneous turn the conductor just opened (`conductor.ts`'s
       * `beginSpontaneousTurn`), dispatched BEFORE it notifies turn subscribers so the presence
       * synopsis attachment already has a handler — carrying the conductor's own turn id — by the
       * time the first frame arrives. The conductor is the sole minter of that id; `turnId` is
       * what every later `phase_synopsis` for this turn must match. Ignored (ledger returned by
       * reference) when a turn is already open.
       */
      | { type: 'spontaneous_turn_opened', turnId: string, at: Date }
      /**
       * A synopsis generated for the currently-open turn (`presence/stream-event-handler.ts`'s
       * `createLedgerStreamEventHandler`). Applied as `turn.phase.generatedStatus` when `turnId`
       * matches `turn.id`; dropped when it does not (design doc section 8) — a synopsis resolving
       * after its turn ended must never overwrite an unrelated turn's status. `phaseType` records
       * which phase it was generated FOR but is deliberately NOT a match condition: a digest
       * describes the turn's recent activity as a whole, and tool calls flip
       * thinking<->using_tool every few seconds while a Haiku generation takes about five, so
       * matching on it dropped almost every digest in production (first conductor-mode soak,
       * 2026-09-06). The digest then rides along every phase change within the turn (see
       * `carryDigest`) until a fresher synopsis replaces it.
       */
      | { type: 'phase_synopsis', turnId: string, phaseType: ActivityPhase['type'], text: string, at: Date }
      /**
       * A quota reading from the usage-endpoint poller
       * ({@link import('./quota-poller').createQuotaPoller}), already normalised to
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
        if(cumulativeUsd === ledger.cost.cumulativeUsd) {
            return ledger;
        }
        return { ...ledger, cost: { ...ledger.cost, cumulativeUsd } };
    }
    const lastTurnUsd = Math.max(0, cumulativeUsd - ledger.cost.cumulativeUsd);
    const stopped = stopForegroundTasks(ledger, at);
    return { ...stopped, turn: null, lastTurnEndedAt: at, cost: { cumulativeUsd, lastTurnUsd } };
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
 * An assistant frame with no turn open spontaneously opens a `'notification'` turn. With a turn
 * open, the first assistant frame stamps `firstTokenAt` and, when the turn carries a `queuedAt`,
 * the queue-to-first-token latency for its `kind`. Every assistant frame also updates
 * `turn.phase` via {@link phaseFromFrame}.
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
        const phase = phaseFromFrame(frame, null, at);
        return { ...ledger, turn: { id: `notification-${at.getTime()}`, kind: 'notification', startedAt: at, phase, interrupting: false } };
    }

    const { turn } = ledger;
    const phase = carryDigest(turn.phase, phaseFromFrame(frame, turn.phase, at));
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
        const parsed = Date.parse(resetsAt);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/**
 * Normalises one raw rate-limit window into a {@link QuotaWindow}. Shared by the
 * `rate_limit_event` fold below and the usage-endpoint poller (./quota-poller.ts) so the unit
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

/** Per-model maps merge key by key, so a source that reports only one model keeps the others. */
function mergePerModel(previous: Record<string, QuotaWindow> | undefined, next: Record<string, QuotaWindow> | undefined): Record<string, QuotaWindow> | undefined {
    if(previous === undefined) {
        return next;
    }
    return { ...previous, ...next };
}

/** Two readings of one window are the same reading when both numbers and the rollover stamp agree. */
function sameQuotaWindow(previous: QuotaWindow | undefined, next: QuotaWindow | undefined): boolean {
    return previous?.utilization === next?.utilization && previous?.resetsAt?.getTime() === next?.resetsAt?.getTime();
}

/**
 * Per-model maps compare key by key. `next` is always the merge of `previous` with whatever the
 * source carried, so its key set can only GROW — iterating `next`'s keys therefore covers every
 * key of both, and a window type `previous` never had compares its own (absent) reading against a
 * real window and fails. No size check is needed, and adding one would be unreachable code.
 */
function samePerModel(previous: Record<string, QuotaWindow> | undefined, next: Record<string, QuotaWindow> | undefined): boolean {
    return Object.keys(next ?? {}).every(key => sameQuotaWindow(previous?.[key], next?.[key]));
}

/** Whether a merged reading says exactly what the ledger already holds — see {@link reduceQuota}. */
function sameQuotaReading(previous: LedgerQuota, next: LedgerQuota): boolean {
    return previous.source === next.source
      && sameQuotaWindow(previous.fiveHour, next.fiveHour)
      && sameQuotaWindow(previous.sevenDay, next.sevenDay)
      && samePerModel(previous.perModel, next.perModel);
}

/**
 * Merges `windows` into `ledger.quota` window by window — a source that knows only one window
 * leaves the others at their last known value — stamping `source` and `at`. Returns `ledger` by
 * reference when `windows` carries nothing at all, so a frame naming only untracked window types
 * (or a poll that parsed to nothing) is a no-op rather than a bogus refresh of the timestamp.
 *
 * It also returns `ledger` by reference when the merge MOVED nothing: same windows, same rollover
 * stamps, same source. The poller repeats the same numbers every five minutes and every quota
 * subscriber (`quota-notes.ts`, presence, the ambient-line providers) is woken by a changed ledger
 * reference, so re-allocating on an identical reading is pure noise.
 *
 * `at` is deliberately NOT bumped for a deduped reading, which is what makes the dedupe a pure
 * reference test. `ambient-lines.ts` merges the two roles' ledgers by taking, per window, the
 * reading with the later `quota.at` — and that merge is unaffected here, because a deduped
 * reading agrees with the value already filed: the losing ledger's stale-looking `at` is attached
 * to the very number the fresher reading would have written. (The two sources cannot mask each
 * other either: `source` is part of the comparison, so a poll landing on a headers reading always
 * refreshes.) The one behaviour that does change is `quota-notes.ts`'s retry of a note the bridge
 * refused at boot: it now waits for the next reading that actually moved rather than the next
 * identical repeat — which is the same wait, one poll later, for a note that is `wake: false`
 * anyway.
 */
function reduceQuota(ledger: Ledger, windows: QuotaWindows, source: LedgerQuota['source'], at: Date): Ledger {
    if(!hasQuotaWindow(windows)) {
        return ledger;
    }
    const previous = ledger.quota;
    const quota: LedgerQuota = {
        fiveHour: windows.fiveHour ?? previous?.fiveHour,
        sevenDay: windows.sevenDay ?? previous?.sevenDay,
        perModel: mergePerModel(previous?.perModel, windows.perModel),
        source,
        at,
    };
    if(previous !== undefined && sameQuotaReading(previous, quota)) {
        return ledger;
    }
    return { ...ledger, quota };
}

/** Frame-type-specific effects that never depend on the open turn: tasks and the compact boundary. */
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
    if(frame.type === 'system' && frame.subtype === 'compact_boundary') {
        return { ...ledger, compaction: 'none', context: { ...ledger.context, lastCompactionAt: at } };
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
    const phase = carryDigest(ledger.turn.phase, phaseFromFrame(frame, ledger.turn.phase, at));
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

/** `kind === 'discord'` is the ledger's one "human" queue; every other kind is `'other'`. */
function isHumanKind(kind: EnvelopeKind): boolean {
    return kind === 'discord';
}

function reduceEnvelopeQueued(ledger: Ledger, kind: EnvelopeKind): Ledger {
    const queued = isHumanKind(kind)
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
    const queued = isHumanKind(envelope.kind)
        ? { ...ledger.queued, human: Math.max(0, ledger.queued.human - 1) }
        : { ...ledger.queued, other: Math.max(0, ledger.queued.other - 1) };
    const turn: LedgerTurn = {
        id:           envelope.id,
        kind:         envelope.kind,
        startedAt:    at,
        queuedAt:     envelope.queuedAt,
        envelopeId:   envelope.id,
        channelId:    envelope.channelId,
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

function reduceCompactionStarted(ledger: Ledger, trigger: 'manual' | 'auto' | undefined, at: Date): Ledger {
    if(ledger.turn === null) {
        if(ledger.compaction === 'compacting') {
            return ledger;
        }
        return { ...ledger, compaction: 'compacting' };
    }
    const phase: ActivityPhase = { type: 'compacting', startedAt: at, trigger };
    return { ...ledger, compaction: 'compacting', turn: { ...ledger.turn, phase } };
}

function reduceCompactionFinished(ledger: Ledger, at: Date): Ledger {
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
 * the board still shows how the interrupted work ended.
 */
function reduceSessionOpened(ledger: Ledger, sessionId: string, at: Date): Ledger {
    if(ledger.sessionId === sessionId && ledger.tasks.length === 0 && ledger.cost.cumulativeUsd === 0) {
        return ledger;
    }
    return {
        ...ledger,
        sessionId,
        tasks:         [],
        finishedTasks: appendAllStopped(ledger.finishedTasks, ledger.tasks, at),
        cost:          { ...ledger.cost, cumulativeUsd: 0 },
    };
}

/**
 * Carries `prev`'s `generatedStatus` (the Haiku digest) onto a `next` phase that has none of its
 * own, so a phase flip within a turn (thinking -> using_tool -> thinking, every few seconds)
 * does not blank the presence text back to the static placeholder between digests. Returns
 * `next` by reference when there is nothing to carry (no `prev` digest, `next` already carries
 * one, `next` is `null` = turn over, or `next` is a phase kind that never carries one), so
 * callers' identity checks (`phase === turn.phase`) keep working.
 */
function carryDigest(prev: ActivityPhase | null, next: ActivityPhase | null): ActivityPhase | null {
    if(next === null) {
        return next;
    }
    const digest = digestOf(prev);
    if(digest === undefined) {
        return next;
    }
    if(next.type !== 'thinking' && next.type !== 'using_tool' && next.type !== 'responding') {
        return next;
    }
    if(next.generatedStatus !== undefined) {
        return next;
    }
    return { ...next, generatedStatus: digest };
}

/** The Haiku digest a phase carries, if it is a phase kind that can carry one. */
function digestOf(phase: ActivityPhase | null): string | undefined {
    if(phase === null) {
        return undefined;
    }
    switch(phase.type) {
        case 'thinking':
        case 'using_tool':
        case 'responding': {
            return phase.generatedStatus;
        }
        case 'compacting': {
            return undefined;
        }
    }
}

function reducePhaseChanged(ledger: Ledger, phase: ActivityPhase | null): Ledger {
    if(ledger.turn === null) {
        return ledger;
    }
    return { ...ledger, turn: { ...ledger.turn, phase: carryDigest(ledger.turn.phase, phase) } };
}

/**
 * Applies a `phase_synopsis` event's `text` as `turn.phase.generatedStatus` when the event's
 * `turnId` matches the currently open turn's `id` — otherwise the event is a stale synopsis (its
 * turn ended, or none is open yet) and is dropped, returning `ledger` unchanged by reference. A
 * matching turn with no phase yet gets a `thinking` placeholder phase carrying the digest. The event's `phaseType` is deliberately not compared (see the
 * `phase_synopsis` doc on {@link LedgerEvent}).
 */
function reducePhaseSynopsis(ledger: Ledger, event: Extract<LedgerEvent, { type: 'phase_synopsis' }>): Ledger {
    const { turn } = ledger;
    if(turn === null) {
        return ledger;
    }
    if(turn.id !== event.turnId) {
        return ledger;
    }
    if(turn.phase === null) {
        // The turn is open but no SDK frame has set a phase yet — this is where the pre-generated
        // thinking synopsis lands, because the conductor notifies turn subscribers (the stream
        // handler that dispatches it) BEFORE it folds the same frame into this ledger. Seed the
        // same 'thinking' placeholder the presence composer would synthesize for a phase-less
        // turn, carrying the digest, so the first frame's phase (via carryDigest) keeps it.
        return { ...ledger, turn: { ...turn, phase: { type: 'thinking', startedAt: event.at, generatedStatus: event.text } } };
    }
    return { ...ledger, turn: { ...turn, phase: { ...turn.phase, generatedStatus: event.text } as ActivityPhase } };
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
            return reduceEnvelopeQueued(ledger, event.kind);
        }
        case 'turn_submitted': {
            return reduceTurnSubmitted(ledger, event.envelope, event.at);
        }
        case 'interrupt_requested': {
            return reduceInterruptRequested(ledger);
        }
        case 'compaction_started': {
            return reduceCompactionStarted(ledger, event.trigger, event.at);
        }
        case 'compaction_finished': {
            return reduceCompactionFinished(ledger, event.at);
        }
        case 'compaction_failed': {
            return reduceCompactionFailed(ledger);
        }
        case 'context_usage_polled': {
            return reduceContextUsagePolled(ledger, event.usage);
        }
        case 'tick': {
            return reduceTick(ledger, event.rssBytes);
        }
        case 'task_lost': {
            return reduceTaskLost(ledger, event.taskId, event.at);
        }
        case 'session_opened': {
            return reduceSessionOpened(ledger, event.sessionId, event.at);
        }
        case 'phase_changed': {
            return reducePhaseChanged(ledger, event.phase);
        }
        case 'spontaneous_turn_opened': {
            return reduceSpontaneousTurnOpened(ledger, event.turnId, event.at);
        }
        case 'phase_synopsis': {
            return reducePhaseSynopsis(ledger, event);
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
