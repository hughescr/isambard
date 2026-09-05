/**
 * The long-lived session ledger: a pure, structurally-shared, clock-free reducer over raw SDK
 * frames and conductor-stamped events (design doc section 7). Every {@link LedgerEvent} carries
 * `at: Date`, stamped by the caller (the conductor, driven by a {@link Clock} from ./clock.ts);
 * this module never calls `Date.now()`/`new Date()` itself. {@link reduceLedger} returns the
 * exact same `Ledger` reference when an event changes nothing, and otherwise a new object that
 * shares every untouched sub-object with the input, so a subscriber (or React-style consumer)
 * can diff with `===`.
 *
 * @module agent/session/ledger
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@hughescr/logger';
import { type ActivityPhase, phaseFromFrame } from './activity-phase';
import type { ContextUsageSummary, EnvelopeKind, EnvelopeMeta, SessionRole } from './types';

/** One in-flight turn: opened by `turn_submitted`, or spontaneously by an unsolicited assistant frame. */
export interface LedgerTurn {
    kind:          EnvelopeKind
    startedAt:     Date
    queuedAt?:     Date
    envelopeId?:   string
    channelId?:    string
    phase:         ActivityPhase | null
    firstTokenAt?: Date
    interrupting:  boolean
}

/** One live background task, tracked from `task_started`/`task_notification`/`background_tasks_changed`. */
export interface LedgerTask {
    id:          string
    taskType:    string
    kind:        'subagent' | 'workflow' | 'shell' | 'other'
    description: string
    startedAt:   Date
}

/** The full session ledger state, folded from a stream of {@link LedgerEvent}s by {@link reduceLedger}. */
export interface Ledger {
    role:       SessionRole
    sessionId?: string
    turn:       LedgerTurn | null
    queued:     { human: number, other: number }
    tasks:      LedgerTask[]
    compaction: 'none' | 'compacting'
    context:    { used: number, window: number, percentage: number, lastCompactionAt?: Date }
    process:    { rssBytes: number }
    perch:      { slot?: string, endsAt?: Date }
    cost:       { cumulativeUsd: number, lastTurnUsd: number }
    latency:    { bySource: Partial<Record<EnvelopeKind, number>> }
}

/** Every fact the conductor can fold into a {@link Ledger}. Every member carries `at: Date`. */
export type LedgerEvent
    = | { type: 'sdk_frame', frame: SDKMessage, at: Date }
      | { type: 'envelope_queued', kind: EnvelopeKind, at: Date }
      | { type: 'turn_submitted', envelope: EnvelopeMeta, at: Date }
      | { type: 'interrupt_requested', at: Date }
      | { type: 'compaction_started', trigger?: 'manual' | 'auto', at: Date }
      | { type: 'compaction_finished', at: Date }
      | { type: 'context_usage_polled', usage: ContextUsageSummary, at: Date }
      | { type: 'tick', rssBytes: number, at: Date }
      | { type: 'task_lost', taskId: string, at: Date }
      | { type: 'session_opened', sessionId: string, at: Date }
      | { type: 'phase_changed', phase: ActivityPhase | null, at: Date };

/** A fresh {@link Ledger} for `role`, with every field at its zero value. */
export function initialLedger(role: SessionRole): Ledger {
    return {
        role,
        turn:       null,
        queued:     { human: 0, other: 0 },
        tasks:      [],
        compaction: 'none',
        context:    { used: 0, window: 0, percentage: 0 },
        process:    { rssBytes: 0 },
        perch:      {},
        cost:       { cumulativeUsd: 0, lastTurnUsd: 0 },
        latency:    { bySource: {} },
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
    return 'other';
}

type ResultFrame = Extract<SDKMessage, { type: 'result' }>;
type AssistantFrame = Extract<SDKMessage, { type: 'assistant' }>;
type TaskStartedFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_started' }>;
type TaskNotificationFrame = Extract<SDKMessage, { type: 'system', subtype: 'task_notification' }>;
type BackgroundTasksChangedFrame = Extract<SDKMessage, { type: 'system', subtype: 'background_tasks_changed' }>;

/**
 * A `result` frame of any subtype closes an open turn and folds `total_cost_usd` into
 * `cost.cumulativeUsd`. `lastTurnUsd` is the delta against the running cumulative, clamped at 0,
 * and is only updated when a turn was actually open (a bare result with no turn open must not
 * misreport a turn cost — see design doc section 7).
 */
function reduceResultFrame(ledger: Ledger, frame: ResultFrame): Ledger {
    const { total_cost_usd: cumulativeUsd } = frame;
    if(ledger.turn === null) {
        if(cumulativeUsd === ledger.cost.cumulativeUsd) {
            return ledger;
        }
        return { ...ledger, cost: { ...ledger.cost, cumulativeUsd } };
    }
    const lastTurnUsd = Math.max(0, cumulativeUsd - ledger.cost.cumulativeUsd);
    return { ...ledger, turn: null, cost: { cumulativeUsd, lastTurnUsd } };
}

/**
 * An assistant frame with no turn open spontaneously opens a `'notification'` turn. With a turn
 * open, the first assistant frame stamps `firstTokenAt` and, when the turn carries a `queuedAt`,
 * the queue-to-first-token latency for its `kind`. Every assistant frame also updates
 * `turn.phase` via {@link phaseFromFrame}.
 */
function reduceAssistantFrame(ledger: Ledger, frame: AssistantFrame, at: Date): Ledger {
    if(ledger.turn === null) {
        const phase = phaseFromFrame(frame, null, at);
        return { ...ledger, turn: { kind: 'notification', startedAt: at, phase, interrupting: false } };
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

/** Adds a backgrounded, non-ambient task exactly once (idempotent on a repeated `task_id`). */
function applyTaskStarted(ledger: Ledger, frame: TaskStartedFrame, at: Date): Ledger {
    if(frame.is_backgrounded !== true || frame.ambient === true) {
        return ledger;
    }
    if(ledger.tasks.some(task => task.id === frame.task_id)) {
        return ledger;
    }
    const task: LedgerTask = {
        id:          frame.task_id,
        taskType:    frame.task_type ?? 'unknown',
        kind:        taskKindFor(frame.task_type),
        description: frame.description,
        startedAt:   at,
    };
    return { ...ledger, tasks: [...ledger.tasks, task] };
}

/** Removes a task by id (idempotent when the id is not tracked). */
function applyTaskNotification(ledger: Ledger, frame: TaskNotificationFrame): Ledger {
    if(!ledger.tasks.some(task => task.id === frame.task_id)) {
        return ledger;
    }
    return { ...ledger, tasks: ledger.tasks.filter(task => task.id !== frame.task_id) };
}

/**
 * REPLACE semantics: the task list becomes exactly the payload (minus ambient entries).
 * `startedAt` is preserved for an id already tracked; a newly-seen id is stamped `at`.
 */
function applyBackgroundTasksChanged(ledger: Ledger, frame: BackgroundTasksChangedFrame, at: Date): Ledger {
    const known = new Map(ledger.tasks.map(task => [task.id, task] as const));
    const tasks = frame.tasks
        .filter(task => task.ambient !== true)
        .map((task): LedgerTask => ({
            id:          task.task_id,
            taskType:    task.task_type,
            kind:        taskKindFor(task.task_type),
            description: task.description,
            startedAt:   known.get(task.task_id)?.startedAt ?? at,
        }));
    return { ...ledger, tasks };
}

/** Frame-type-specific effects that never depend on the open turn: tasks and the compact boundary. */
function applyFrameSideEffects(ledger: Ledger, frame: SDKMessage, at: Date): Ledger {
    if(frame.type === 'system' && frame.subtype === 'task_started') {
        return applyTaskStarted(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'task_notification') {
        return applyTaskNotification(ledger, frame);
    }
    if(frame.type === 'system' && frame.subtype === 'background_tasks_changed') {
        return applyBackgroundTasksChanged(ledger, frame, at);
    }
    if(frame.type === 'system' && frame.subtype === 'compact_boundary') {
        return { ...ledger, compaction: 'none', context: { ...ledger.context, lastCompactionAt: at } };
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
        return reduceResultFrame(ledger, frame);
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

function reduceTurnSubmitted(ledger: Ledger, envelope: EnvelopeMeta, at: Date): Ledger {
    const queued = isHumanKind(envelope.kind)
        ? { ...ledger.queued, human: Math.max(0, ledger.queued.human - 1) }
        : { ...ledger.queued, other: Math.max(0, ledger.queued.other - 1) };
    const turn: LedgerTurn = {
        kind:         envelope.kind,
        startedAt:    at,
        queuedAt:     envelope.queuedAt,
        envelopeId:   envelope.id,
        channelId:    envelope.channelId,
        phase:        null,
        interrupting: false,
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

function reduceTaskLost(ledger: Ledger, taskId: string): Ledger {
    if(!ledger.tasks.some(task => task.id === taskId)) {
        return ledger;
    }
    return { ...ledger, tasks: ledger.tasks.filter(task => task.id !== taskId) };
}

function reduceSessionOpened(ledger: Ledger, sessionId: string): Ledger {
    if(ledger.sessionId === sessionId && ledger.tasks.length === 0 && ledger.cost.cumulativeUsd === 0) {
        return ledger;
    }
    return { ...ledger, sessionId, tasks: [], cost: { ...ledger.cost, cumulativeUsd: 0 } };
}

function reducePhaseChanged(ledger: Ledger, phase: ActivityPhase | null): Ledger {
    if(ledger.turn === null) {
        return ledger;
    }
    return { ...ledger, turn: { ...ledger.turn, phase } };
}

/**
 * Folds one {@link LedgerEvent} into `ledger`, pure and clock-free: `event.at` is the only source
 * of time. Returns `ledger` itself, by reference, when the event changes nothing.
 */
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
        case 'context_usage_polled': {
            return reduceContextUsagePolled(ledger, event.usage);
        }
        case 'tick': {
            return reduceTick(ledger, event.rssBytes);
        }
        case 'task_lost': {
            return reduceTaskLost(ledger, event.taskId);
        }
        case 'session_opened': {
            return reduceSessionOpened(ledger, event.sessionId);
        }
        case 'phase_changed': {
            return reducePhaseChanged(ledger, event.phase);
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
    /** Registers `listener` to be called with the new ledger on every change; returns an unsubscribe function. */
    subscribe: (listener: (ledger: Ledger) => void) => () => void
}

/**
 * Wraps {@link reduceLedger} in a tiny store: `dispatch` notifies subscribers only when the
 * ledger reference actually changed. A throwing subscriber is caught and logged via
 * `deps.logger.error({ error }, 'Ledger subscriber threw')` — once per throw — without blocking
 * the remaining subscribers (same isolation pattern as `state/manager.ts`'s notifySubscribers).
 */
export function createLedgerStore(role: SessionRole, deps: LedgerStoreDeps): LedgerStore {
    let ledger = initialLedger(role);
    const listeners = new Set<(ledger: Ledger) => void>();

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
                    listener(snapshot);
                } catch (error) {
                    deps.logger.error({ error }, 'Ledger subscriber threw');
                }
            }
        },
        get(): Ledger {
            return ledger;
        },
        subscribe(listener: (ledger: Ledger) => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
