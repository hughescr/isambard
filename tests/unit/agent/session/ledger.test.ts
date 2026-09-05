/**
 * Table-driven tests for the pure, clock-free ledger reducer (design doc section 7, P4).
 * Fake timers pin `Date.now()` to SENTINEL, far from every event's explicit `at`, so any output
 * Date that happens to equal SENTINEL proves the reducer read the clock instead of the event.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { SDKPartialAssistantMessage, SDKToolProgressMessage } from '@anthropic-ai/claude-agent-sdk';
import * as frames from '../../../helpers/sdk-frames';
import {
    type Ledger,
    type LedgerEvent,
    initialLedger,
    reduceLedger
} from '@/agent/session/ledger';
import { ENVELOPE_KINDS, type EnvelopeMeta } from '@/agent/session/types';

const SENTINEL = new Date('2099-01-01T00:00:00Z');
const T1 = new Date('2026-09-04T12:00:00Z');
const T2 = new Date('2026-09-04T12:00:01Z');
const T3 = new Date('2026-09-04T12:00:02Z');

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(SENTINEL);
});

afterEach(() => {
    jest.useRealTimers();
});

/** Recursively freezes an object graph so mutation shows up as a thrown TypeError in strict mode. */
function deepFreeze<T>(value: T): T {
    if(value !== null && (typeof value === 'object')) {
        for(const key of Object.getOwnPropertyNames(value)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic recursive freeze walks arbitrary object graphs
            deepFreeze((value as any)[key]);
        }
        Object.freeze(value);
    }
    return value;
}

function envelope(overrides: Partial<EnvelopeMeta> = {}): EnvelopeMeta {
    return deepFreeze({ id: 'env-1', kind: 'discord', queuedAt: T1, ...overrides });
}

function frozenEvent(event: LedgerEvent): LedgerEvent {
    return deepFreeze(event);
}

describe('initialLedger', () => {
    it('sets role and an all-zero empty state', () => {
        expect(initialLedger('conversation')).toEqual({
            role:       'conversation',
            turn:       null,
            queued:     { human: 0, other: 0 },
            tasks:      [],
            compaction: 'none',
            context:    { used: 0, window: 0, percentage: 0 },
            process:    { rssBytes: 0 },
            perch:      {},
            cost:       { cumulativeUsd: 0, lastTurnUsd: 0 },
            latency:    { bySource: {} },
        });
    });

    it('uses the role parameter (not hardcoded)', () => {
        expect(initialLedger('perch').role).toBe('perch');
    });
});

describe('reduceLedger: envelope_queued', () => {
    it('increments queued.human for kind discord', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'envelope_queued', kind: 'discord', at: T1 }));

        expect(ledger.queued).toEqual({ human: 1, other: 0 });
    });

    it.each(ENVELOPE_KINDS.filter(kind => kind !== 'discord'))('increments queued.other for kind %s', (kind) => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'envelope_queued', kind, at: T1 }));

        expect(ledger.queued).toEqual({ human: 0, other: 1 });
    });
});

describe('reduceLedger: turn_submitted', () => {
    it('decrements queued.human for a discord envelope and opens the turn', () => {
        const queued = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'envelope_queued', kind: 'discord', at: T1 }));

        const ledger = reduceLedger(queued, frozenEvent({ type: 'turn_submitted', envelope: envelope({ queuedAt: T1, channelId: 'chan-1' }), at: T2 }));

        expect(ledger.queued).toEqual({ human: 0, other: 0 });
        expect(ledger.turn).toEqual({
            kind:         'discord',
            startedAt:    T2,
            queuedAt:     T1,
            envelopeId:   'env-1',
            channelId:    'chan-1',
            phase:        null,
            interrupting: false,
        });
    });

    it('floors queued.human at 0 when nothing was queued', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T2 }));

        expect(ledger.queued.human).toBe(0);
    });

    it('floors queued.other at 0 for a non-discord kind when nothing was queued', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope({ kind: 'notification' }), at: T2 }));

        expect(ledger.queued.other).toBe(0);
    });

    it('sets perch.slot/endsAt from the envelope for kind perch', () => {
        const endsAt = new Date('2026-09-04T19:00:00Z');
        const ledger = reduceLedger(initialLedger('perch'), frozenEvent({
            type:     'turn_submitted', at:       T2,
            envelope: envelope({ kind: 'perch', perch: { slot: 'evening', endsAt } }),
        }));

        expect(ledger.perch).toEqual({ slot: 'evening', endsAt });
    });

    it('leaves perch untouched for a non-perch kind', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T2 }));

        expect(ledger.perch).toEqual({});
    });

    it('leaves perch untouched for a discord envelope that happens to carry perch metadata', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:     'turn_submitted', at:       T2,
            envelope: envelope({ kind: 'discord', perch: { slot: 'evening', endsAt: T3 } }),
        }));

        expect(ledger.perch).toEqual({});
    });

    it('does not throw and leaves perch unchanged for a perch envelope with no perch metadata', () => {
        expect(() => {
            const ledger = reduceLedger(initialLedger('perch'), frozenEvent({
                type:     'turn_submitted', at:       T2,
                envelope: envelope({ kind: 'perch', perch: undefined }),
            }));
            expect(ledger.perch).toEqual({});
        }).not.toThrow();
    });
});

describe('reduceLedger: sdk_frame assistant + latency', () => {
    function submitted(): Ledger {
        return reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope({ queuedAt: T1 }), at: T2 }));
    }

    it('sets firstTokenAt and latency.bySource[kind] on the first assistant frame', () => {
        const ledger = reduceLedger(submitted(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T3 }));

        expect(ledger.turn?.firstTokenAt).toEqual(T3);
        expect(ledger.latency.bySource.discord).toBe(T3.getTime() - T1.getTime());
        expect(ledger.turn?.phase).toEqual({ type: 'responding', startedAt: T3 });
    });

    it('leaves firstTokenAt unchanged on a second assistant frame', () => {
        const afterFirst = reduceLedger(submitted(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T3 }));
        const T4 = new Date('2026-09-04T12:00:03Z');

        const afterSecond = reduceLedger(afterFirst, frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('more'), at: T4 }));

        expect(afterSecond.turn?.firstTokenAt).toEqual(T3);
    });

    it('returns the same reference for a second assistant tool_use frame naming the same tool (phase short-circuit)', () => {
        const first = reduceLedger(submitted(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: T3 }));
        expect(first.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T3 });

        const second = reduceLedger(first, frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_2'), at: new Date('2026-09-04T12:00:03Z') }));

        expect(second).toBe(first);
    });

    it('does not set a latency entry when the turn has no queuedAt (e.g. a notification turn)', () => {
        const notification = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('unsolicited'), at: T1 }));

        const ledger = reduceLedger(notification, frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('more'), at: T2 }));

        expect(ledger.latency.bySource).toEqual({});
    });

    it('opens a notification turn with startedAt === at when an assistant frame arrives with no turn open', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('unsolicited'), at: T1 }));

        expect(ledger.turn).toMatchObject({ kind: 'notification', startedAt: T1, interrupting: false, phase: { type: 'responding', startedAt: T1 } });
        expect(ledger.latency.bySource).toEqual({});
    });
});

describe('reduceLedger: phaseFromFrame wiring on sdk_frame (non-assistant frames)', () => {
    function openTurn(): Ledger {
        return reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));
    }

    it('sets turn.phase to using_tool from a tool_progress frame', () => {
        const frame: SDKToolProgressMessage = {
            type:                 'tool_progress',
            tool_use_id:          'toolu_1',
            tool_name:            'Bash',
            parent_tool_use_id:   null,
            elapsed_time_seconds: 3,
            uuid:                 'uuid-1' as SDKToolProgressMessage['uuid'],
            session_id:           'sess-1',
        };

        const ledger = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame, at: T2 }));

        expect(ledger.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T2 });
    });

    it('sets turn.phase to responding from a stream_event content_block_delta text_delta frame', () => {
        const frame: SDKPartialAssistantMessage = {
            type:               'stream_event',
            event:              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
            parent_tool_use_id: null,
            uuid:               'uuid-1' as SDKPartialAssistantMessage['uuid'],
            session_id:         'sess-1',
        };

        const ledger = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame, at: T2 }));

        expect(ledger.turn?.phase).toEqual({ type: 'responding', startedAt: T2 });
    });

    it('sets turn.phase to thinking from a task_progress frame with a summary when no phase was open', () => {
        const ledger = reduceLedger(openTurn(), frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskProgress({ summary: 'Almost done' }),
        }));

        expect(ledger.turn?.phase).toEqual({ type: 'thinking', startedAt: T2 });
    });
});

describe('reduceLedger: sdk_frame result', () => {
    function openTurn(): Ledger {
        return reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));
    }

    it('closes the turn and sets lastTurnUsd from the cost delta on a success result', () => {
        const withCost = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));

        expect(withCost.turn).toBeNull();
        expect(withCost.cost).toEqual({ cumulativeUsd: 0.05, lastTurnUsd: 0.05 });
    });

    it('closes the turn on any result subtype, including error_during_execution', () => {
        const ledger = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultInterrupted({ total_cost_usd: 0.02 }), at: T2 }));

        expect(ledger.turn).toBeNull();
        expect(ledger.cost.cumulativeUsd).toBeCloseTo(0.02);
    });

    it('closes an interrupting turn on a success result with terminal_reason aborted_streaming', () => {
        const interrupting = reduceLedger(openTurn(), frozenEvent({ type: 'interrupt_requested', at: T2 }));
        expect(interrupting.turn?.interrupting).toBe(true);

        const ledger = reduceLedger(interrupting, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.resultSuccess({ terminal_reason: 'aborted_streaming', total_cost_usd: 0.03 }),
        }));

        expect(ledger.turn).toBeNull();
    });

    it('computes the delta against the running cumulative total, not against zero', () => {
        const afterFirstTurn = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));
        const secondTurn = reduceLedger(afterFirstTurn, frozenEvent({ type: 'turn_submitted', envelope: envelope({ id: 'env-2' }), at: T2 }));

        const ledger = reduceLedger(secondTurn, frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.08 }), at: T3 }));

        expect(ledger.cost).toEqual({ cumulativeUsd: 0.08, lastTurnUsd: 0.03 });
    });

    it('updates cumulativeUsd only, leaving lastTurnUsd untouched, when no turn is open (a bare result)', () => {
        // A real turn first, so lastTurnUsd is non-zero and cumulativeUsd is non-zero before the
        // bare result arrives — this is the only way to prove line 115 (the actual bare-result
        // update) runs, rather than the ledger.turn === null && cumulativeUsd === cost.cumulativeUsd
        // early-return at line 112-114 (which a cumulative-0-against-0 bare result would take
        // instead, without ever exercising the update or lastTurnUsd's preservation).
        const afterTurn = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));
        expect(afterTurn.turn).toBeNull();
        expect(afterTurn.cost).toEqual({ cumulativeUsd: 0.05, lastTurnUsd: 0.05 });

        const ledger = reduceLedger(afterTurn, frozenEvent({ type: 'sdk_frame', frame: frames.bareResult({ total_cost_usd: 0.07 }), at: T3 }));

        expect(ledger.turn).toBeNull();
        expect(ledger.cost).toEqual({ cumulativeUsd: 0.07, lastTurnUsd: 0.05 });
    });

    it('is a no-op (same reference) for a bare result whose cost matches the running cumulative', () => {
        const afterTurn = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));

        const ledger = reduceLedger(afterTurn, frozenEvent({ type: 'sdk_frame', frame: frames.bareResult({ total_cost_usd: 0.05 }), at: T3 }));

        expect(ledger).toBe(afterTurn);
    });
});

describe('reduceLedger: interrupt_requested', () => {
    it('is a no-op (same reference) when no turn is open', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'interrupt_requested', at: T1 }));

        expect(next).toBe(ledger);
    });

    it('sets turn.interrupting when a turn is open', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));

        const ledger = reduceLedger(opened, frozenEvent({ type: 'interrupt_requested', at: T2 }));

        expect(ledger.turn?.interrupting).toBe(true);
    });
});

describe('reduceLedger: background tasks', () => {
    it.each([
        ['local_agent', 'subagent'],
        ['local_workflow', 'workflow'],
        ['local_bash', 'shell'],
        ['something_else', 'other'],
    ] as const)('task_started maps task_type %s to kind %s', (taskType, kind) => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1', task_type: taskType, description: 'do a thing' }),
        }));

        expect(ledger.tasks).toEqual([{ id: 'task-1', taskType, kind, description: 'do a thing', startedAt: T1 }]);
    });

    it('task_started with no task_type defaults taskType to \'unknown\' and kind to \'other\'', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1', task_type: undefined, description: 'do a thing' }),
        }));

        expect(ledger.tasks).toEqual([{ id: 'task-1', taskType: 'unknown', kind: 'other', description: 'do a thing', startedAt: T1 }]);
    });

    it('does not add a foreground task (is_backgrounded false)', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1', is_backgrounded: false }),
        }));

        expect(ledger.tasks).toEqual([]);
    });

    it('does not add an ambient task', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1', ambient: true }),
        }));

        expect(ledger.tasks).toEqual([]);
    });

    it('is idempotent (same reference) on a duplicate task_started', () => {
        const started = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1' }),
        }));

        const again = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.taskStarted({ task_id: 'task-1' }),
        }));

        expect(again).toBe(started);
    });

    it.each(['completed', 'failed', 'stopped'] as const)('task_notification with status %s removes the task', (status) => {
        const started = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1' }),
        }));

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.taskNotification(status, { task_id: 'task-1' }),
        }));

        expect(ledger.tasks).toEqual([]);
    });

    it('is idempotent (same reference) on a duplicate task_notification', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskNotification('completed', { task_id: 'unknown-task' }),
        }));

        expect(next).toBe(ledger);
    });

    it('background_tasks_changed replaces wholesale, drops ambient entries, keeps startedAt for known ids and stamps at for new ids', () => {
        const started = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1', task_type: 'local_agent' }),
        }));

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.backgroundTasksChanged([
                { task_id: 'task-1', task_type: 'local_agent', description: 'still running' },
                { task_id: 'task-2', task_type: 'local_bash', description: 'new task' },
                { task_id: 'task-3', task_type: 'local_bash', description: 'ambient one', ambient: true },
            ]),
        }));

        expect(ledger.tasks).toEqual([
            { id: 'task-1', taskType: 'local_agent', kind: 'subagent', description: 'still running', startedAt: T1 },
            { id: 'task-2', taskType: 'local_bash', kind: 'shell', description: 'new task', startedAt: T3 },
        ]);
    });

    it('task_lost removes the task', () => {
        const started = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.taskStarted({ task_id: 'task-1' }),
        }));

        const ledger = reduceLedger(started, frozenEvent({ type: 'task_lost', taskId: 'task-1', at: T2 }));

        expect(ledger.tasks).toEqual([]);
    });

    it('task_lost on an unknown id is a no-op (same reference)', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'task_lost', taskId: 'unknown', at: T1 }));

        expect(next).toBe(ledger);
    });
});

describe('reduceLedger: compaction', () => {
    it('compaction_started sets compaction to compacting and, with a turn open, sets turn.phase to compacting{trigger}', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));

        const ledger = reduceLedger(opened, frozenEvent({ type: 'compaction_started', trigger: 'auto', at: T2 }));

        expect(ledger.compaction).toBe('compacting');
        expect(ledger.turn?.phase).toEqual({ type: 'compacting', startedAt: T2, trigger: 'auto' });
    });

    it('compaction_started with no turn open just flips the compaction flag', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'compaction_started', at: T1 }));

        expect(ledger.compaction).toBe('compacting');
        expect(ledger.turn).toBeNull();
    });

    it('compaction_started is a no-op (same reference) when already compacting with no turn open', () => {
        const compacting = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'compaction_started', at: T1 }));

        const next = reduceLedger(compacting, frozenEvent({ type: 'compaction_started', at: T2 }));

        expect(next).toBe(compacting);
    });

    it('compaction_finished sets compaction to none and stamps lastCompactionAt', () => {
        const compacting = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'compaction_started', at: T1 }));

        const ledger = reduceLedger(compacting, frozenEvent({ type: 'compaction_finished', at: T2 }));

        expect(ledger.compaction).toBe('none');
        expect(ledger.context.lastCompactionAt).toEqual(T2);
    });

    it('compaction_finished is a no-op (same reference) when compaction is already none', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'compaction_finished', at: T1 }));

        expect(next).toBe(ledger);
    });

    it('sdk_frame compact_boundary sets compaction to none and stamps lastCompactionAt', () => {
        const compacting = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'compaction_started', at: T1 }));

        const ledger = reduceLedger(compacting, frozenEvent({ type: 'sdk_frame', frame: frames.compactBoundary(), at: T2 }));

        expect(ledger.compaction).toBe('none');
        expect(ledger.context.lastCompactionAt).toEqual(T2);
    });

    it('compaction_failed returns compaction to none without stamping lastCompactionAt', () => {
        const compacting = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'compaction_started', at: T1 }));

        const ledger = reduceLedger(compacting, frozenEvent({ type: 'compaction_failed', reason: 'timeout', at: T2 }));

        expect(ledger.compaction).toBe('none');
        expect(ledger.context.lastCompactionAt).toBeUndefined();
    });

    it('compaction_failed is a no-op (same reference) when compaction is already none', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'compaction_failed', at: T1 }));

        expect(next).toBe(ledger);
    });
});

describe('reduceLedger: context, process, phase, session', () => {
    it('context_usage_polled sets used/window/percentage', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'context_usage_polled', at:    T1,
            usage: { totalTokens: 1000, maxTokens: 200_000, percentage: 0.5 },
        }));

        expect(ledger.context).toEqual({ used: 1000, window: 200_000, percentage: 0.5 });
    });

    it('context_usage_polled is a no-op (same reference) when the usage is unchanged', () => {
        const usage = { totalTokens: 1000, maxTokens: 200_000, percentage: 0.5 };
        const polled = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'context_usage_polled', at: T1, usage }));

        const next = reduceLedger(polled, frozenEvent({ type: 'context_usage_polled', at: T2, usage: { ...usage } }));

        expect(next).toBe(polled);
    });

    it('tick sets process.rssBytes', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'tick', rssBytes: 123_456, at: T1 }));

        expect(ledger.process).toEqual({ rssBytes: 123_456 });
    });

    it('tick is a no-op (same reference) when rssBytes is unchanged', () => {
        const ticked = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'tick', rssBytes: 42, at: T1 }));

        const next = reduceLedger(ticked, frozenEvent({ type: 'tick', rssBytes: 42, at: T2 }));

        expect(next).toBe(ticked);
    });

    it('phase_changed with no turn open is a no-op (same reference)', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T1 }, at: T1 }));

        expect(next).toBe(ledger);
    });

    it('phase_changed with a turn open sets turn.phase', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));

        const ledger = reduceLedger(opened, frozenEvent({ type: 'phase_changed', phase: { type: 'responding', startedAt: T2 }, at: T2 }));

        expect(ledger.turn?.phase).toEqual({ type: 'responding', startedAt: T2 });
    });

    it('session_opened sets sessionId, empties tasks and resets cost.cumulativeUsd', () => {
        const withState = reduceLedger(
            reduceLedger(initialLedger('conversation'), frozenEvent({
                type: 'sdk_frame', at: T1, frame: frames.taskStarted({ task_id: 'task-1' }),
            })),
            frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.resultSuccess({ total_cost_usd: 0.09 }) })
        );
        expect(withState.tasks).toHaveLength(1);
        expect(withState.cost.cumulativeUsd).toBeCloseTo(0.09);

        const ledger = reduceLedger(withState, frozenEvent({ type: 'session_opened', sessionId: 'sess-2', at: T3 }));

        expect(ledger.sessionId).toBe('sess-2');
        expect(ledger.tasks).toEqual([]);
        expect(ledger.cost.cumulativeUsd).toBe(0);
    });

    it('session_opened is a no-op (same reference) when sessionId is unchanged and there is nothing to reset', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'session_opened', sessionId: 'sess-1', at: T1 }));

        const next = reduceLedger(opened, frozenEvent({ type: 'session_opened', sessionId: 'sess-1', at: T2 }));

        expect(next).toBe(opened);
    });
});

describe('reduceLedger: unrelated frames and structural sharing', () => {
    it('returns the same reference for an unrelated sdk frame when no turn is open', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'sdk_frame', frame: frames.hookStarted(), at: T1 }));

        expect(next).toBe(ledger);
    });

    it('returns the same reference for an unrelated sdk frame when a turn is open and the phase does not change', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));

        const next = reduceLedger(opened, frozenEvent({ type: 'sdk_frame', frame: frames.hookStarted(), at: T2 }));

        expect(next).toBe(opened);
    });

    it('keeps unrelated sub-objects by reference after an unrelated event (tick does not touch tasks/cost/queued)', () => {
        const started = reduceLedger(initialLedger('conversation'), frozenEvent({
            type: 'sdk_frame', at: T1, frame: frames.taskStarted({ task_id: 'task-1' }),
        }));

        const ledger = reduceLedger(started, frozenEvent({ type: 'tick', rssBytes: 42, at: T2 }));

        expect(ledger.tasks).toBe(started.tasks);
        expect(ledger.cost).toBe(started.cost);
        expect(ledger.queued).toBe(started.queued);
    });
});

/** Recursively collects every `Date` instance anywhere in an object graph (arrays and plain objects). */
function collectDates(value: unknown, acc: Date[] = []): Date[] {
    if(value instanceof Date) {
        acc.push(value);
    } else if(Array.isArray(value)) {
        for(const item of value) {
            collectDates(item, acc);
        }
    } else if(value !== null && typeof value === 'object') {
        for(const key of Object.keys(value)) {
            collectDates((value as Record<string, unknown>)[key], acc);
        }
    }
    return acc;
}

describe('reduceLedger: clock-free', () => {
    it('never reads Date.now()/new Date(): no Date anywhere in a fully-populated ledger (open turn, tasks, perch) equals SENTINEL', () => {
        let ledger = initialLedger('perch');
        const events: LedgerEvent[] = [
            { type: 'session_opened', sessionId: 'sess-1', at: T1 },
            { type: 'envelope_queued', kind: 'perch', at: T1 },
            { type: 'turn_submitted', envelope: envelope({ kind: 'perch', queuedAt: T1, perch: { slot: 'evening', endsAt: T2 } }), at: T2 },
            { type: 'sdk_frame', frame: frames.assistantText('hi'), at: T3 },
            { type: 'sdk_frame', frame: frames.taskStarted({ task_id: 't1' }), at: T3 },
            { type: 'compaction_started', trigger: 'auto', at: T1 },
            { type: 'compaction_finished', at: T2 },
            { type: 'context_usage_polled', at: T1, usage: { totalTokens: 1, maxTokens: 2, percentage: 0.5 } },
            { type: 'tick', rssBytes: 1, at: T1 },
        ];

        for(const event of events) {
            ledger = reduceLedger(ledger, frozenEvent(event));
        }

        // Prove the sequence actually leaves the interesting sub-objects populated, otherwise the
        // Date scan below would trivially pass by finding nothing.
        expect(ledger.turn).not.toBeNull();
        expect(ledger.tasks.length).toBeGreaterThan(0);
        expect(ledger.perch.slot).toBeDefined();

        const dates = collectDates(ledger);
        expect(dates.length).toBeGreaterThan(0);
        for(const d of dates) {
            expect(d.getTime()).not.toBe(SENTINEL.getTime());
        }
    });

    it('never mutates a deep-frozen ledger or event', () => {
        const ledger = deepFreeze(reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'envelope_queued', kind: 'discord', at: T1 })));

        expect(() => reduceLedger(ledger, frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T2 }))).not.toThrow();
    });
});
