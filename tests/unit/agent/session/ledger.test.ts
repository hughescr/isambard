/**
 * Table-driven tests for the pure, clock-free ledger reducer (design doc section 7, P4).
 * Fake timers pin `Date.now()` to SENTINEL, far from every event's explicit `at`, so any output
 * Date that happens to equal SENTINEL proves the reducer read the clock instead of the event.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { SDKMessage, SDKPartialAssistantMessage, SDKToolProgressMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import * as frames from '../../../helpers/sdk-frames';
import { mockLogger } from '../../../setup';
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
    mockLogger.debug.mockClear();
});

afterEach(() => {
    jest.useRealTimers();
    mockLogger.debug.mockClear();
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
            role:          'conversation',
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
            id:           'env-1',
            kind:         'discord',
            startedAt:    T2,
            queuedAt:     T1,
            envelopeId:   'env-1',
            channelId:    'chan-1',
            phase:        null,
            interrupting: false,
        });
    });

    it('stamps turn.id from the envelope id', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope({ id: 'env-42' }), at: T2 }));

        expect(ledger.turn?.id).toBe('env-42');
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

    it('stamps a spontaneously-opened notification turn with a non-empty id', () => {
        const ledger = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('unsolicited'), at: T1 }));

        expect(typeof ledger.turn?.id).toBe('string');
        expect(ledger.turn?.id.length).toBeGreaterThan(0);
    });
});

describe('reduceLedger: phase_synopsis', () => {
    function openTurn(): Ledger {
        return reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'turn_submitted', envelope: envelope(), at: T1 }));
    }

    it('applies generatedStatus onto turn.phase when turnId and phaseType both match the current turn', () => {
        const thinking = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 }));
        expect(thinking.turn?.phase).toEqual({ type: 'responding', startedAt: T2 });

        const ledger = reduceLedger(thinking, frozenEvent({
            type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T3,
        }));

        expect(ledger.turn?.phase).toEqual({ type: 'responding', startedAt: T2, generatedStatus: 'writing a reply' });
    });

    it('drops the event (returns the same reference) when turnId does not match the current turn', () => {
        // Regression coverage: dispatch an sdk_frame first (as the phaseType-mismatch test below
        // does) so `turn.phase` is live and matches the event's `phaseType` — otherwise the earlier
        // `turn.phase === null` guard returns first and the turnId check below it is never reached.
        const thinking = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: T2 }));
        expect(thinking.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T2 });

        const result = reduceLedger(thinking, frozenEvent({
            type: 'phase_synopsis', turnId: 'stale-turn', phaseType: 'using_tool', text: 'irrelevant', at: T3,
        }));

        expect(result).toBe(thinking);
    });

    it('still applies the synopsis when the phase type moved on within the same turn: a digest describes the turn\'s recent activity, and tool calls flip thinking<->using_tool faster than Haiku resolves', () => {
        const usingTool = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: T2 }));
        expect(usingTool.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T2 });

        const result = reduceLedger(usingTool, frozenEvent({
            type: 'phase_synopsis', turnId: 'env-1', phaseType: 'thinking', text: 'reading the diff', at: T3,
        }));

        expect(result.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T2, generatedStatus: 'reading the diff' });
    });

    it('carries the digest across a phase change within the turn, until a fresh synopsis replaces it', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );
        expect(withDigest.turn?.phase).toEqual({ type: 'responding', startedAt: T2, generatedStatus: 'writing a reply' });

        const flipped = reduceLedger(withDigest, frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: T3 }));
        expect(flipped.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T3, generatedStatus: 'writing a reply' });

        const replaced = reduceLedger(flipped, frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'using_tool', text: 'running the tests', at: T3 }));
        expect(replaced.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T3, generatedStatus: 'running the tests' });
    });

    it('does not carry the digest past the end of the turn: a result frame clears the phase entirely', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );

        const ended = reduceLedger(withDigest, frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess(), at: T3 }));

        expect(ended.turn).toBeNull();
    });

    it('carries the digest onto a responding phase and from a thinking phase (every carrying kind, both directions)', () => {
        const thinkingWithDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T2 }, at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'thinking', text: 'mulling it over', at: T2 })
        );
        expect(thinkingWithDigest.turn?.phase).toEqual({ type: 'thinking', startedAt: T2, generatedStatus: 'mulling it over' });

        const responding = reduceLedger(thinkingWithDigest, frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T3 }));
        expect(responding.turn?.phase).toEqual({ type: 'responding', startedAt: T3, generatedStatus: 'mulling it over' });

        const usingTool = reduceLedger(responding, frozenEvent({ type: 'sdk_frame', frame: frames.assistantToolUse('Bash', {}, 'toolu_1'), at: T3 }));
        expect(usingTool.turn?.phase).toEqual({ type: 'using_tool', toolName: 'Bash', startedAt: T3, generatedStatus: 'mulling it over' });

        const backToThinking = reduceLedger(usingTool, frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T3 }, at: T3 }));
        expect(backToThinking.turn?.phase).toEqual({ type: 'thinking', startedAt: T3, generatedStatus: 'mulling it over' });
    });

    it('does not carry the digest onto a compacting phase, and a compacting phase carries none onward', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );

        const compacting = reduceLedger(withDigest, frozenEvent({ type: 'phase_changed', phase: { type: 'compacting', startedAt: T3, trigger: 'manual' }, at: T3 }));
        expect(compacting.turn?.phase).toEqual({ type: 'compacting', startedAt: T3, trigger: 'manual' });

        const afterwards = reduceLedger(compacting, frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T3 }, at: T3 }));
        expect(afterwards.turn?.phase).toEqual({ type: 'thinking', startedAt: T3 });
    });

    it('keeps a new phase\'s OWN digest rather than overwriting it with the carried one', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );

        const own = reduceLedger(withDigest, frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T3, generatedStatus: 'its own words' }, at: T3 }));

        expect(own.turn?.phase).toEqual({ type: 'thinking', startedAt: T3, generatedStatus: 'its own words' });
    });

    it('a phase_changed to null clears the phase, digest included', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );

        const cleared = reduceLedger(withDigest, frozenEvent({ type: 'phase_changed', phase: null, at: T3 }));

        expect(cleared.turn?.phase).toBeNull();
    });

    it('carries the digest across an explicit phase_changed event too', () => {
        const withDigest = reduceLedger(
            reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T2 })),
            frozenEvent({ type: 'phase_synopsis', turnId: 'env-1', phaseType: 'responding', text: 'writing a reply', at: T2 })
        );

        const changed = reduceLedger(withDigest, frozenEvent({ type: 'phase_changed', phase: { type: 'thinking', startedAt: T3 }, at: T3 }));

        expect(changed.turn?.phase).toEqual({ type: 'thinking', startedAt: T3, generatedStatus: 'writing a reply' });
    });

    it('drops the event (returns the same reference) when no turn is open', () => {
        const ledger = initialLedger('conversation');

        const result = reduceLedger(ledger, frozenEvent({
            type: 'phase_synopsis', turnId: 'env-1', phaseType: 'thinking', text: 'irrelevant', at: T1,
        }));

        expect(result).toBe(ledger);
    });

    it('a synopsis arriving before the first frame seeds a thinking placeholder carrying it, which the first frame then keeps', () => {
        // Production ordering: the conductor notifies turn subscribers (the stream handler, which
        // dispatches the pre-generated thinking synopsis) before folding the frame into the
        // ledger, so the synopsis reaches a turn whose phase is still null.
        const ledger = openTurn();
        expect(ledger.turn?.phase).toBeNull();

        const seeded = reduceLedger(ledger, frozenEvent({
            type: 'phase_synopsis', turnId: 'env-1', phaseType: 'thinking', text: 'reading the brief', at: T2,
        }));
        expect(seeded.turn?.phase).toEqual({ type: 'thinking', startedAt: T2, generatedStatus: 'reading the brief' });

        const firstFrame = reduceLedger(seeded, frozenEvent({ type: 'sdk_frame', frame: frames.assistantText('hi'), at: T3 }));
        expect(firstFrame.turn?.phase).toEqual({ type: 'responding', startedAt: T3, generatedStatus: 'reading the brief' });
    });

    it('still drops a synopsis for a phase-less turn when the turnId does not match', () => {
        const ledger = openTurn();

        const result = reduceLedger(ledger, frozenEvent({
            type: 'phase_synopsis', turnId: 'someone-else', phaseType: 'thinking', text: 'irrelevant', at: T2,
        }));

        expect(result).toBe(ledger);
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

    it('stamps lastTurnEndedAt with the result frame\'s own `at` when the turn closes', () => {
        const withCost = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));

        expect(withCost.lastTurnEndedAt).toEqual(T2);
    });

    it('leaves lastTurnEndedAt untouched for a bare result that closes no turn', () => {
        const afterTurn = reduceLedger(openTurn(), frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));

        const ledger = reduceLedger(afterTurn, frozenEvent({ type: 'sdk_frame', frame: frames.bareResult({ total_cost_usd: 0.07 }), at: T3 }));

        expect(ledger.lastTurnEndedAt).toEqual(T2);
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

    // A foreground sub-agent cannot outlive the turn that launched it: an interrupted turn ends
    // without the `tool_result` that would normally finish it, so the result frame does it here.
    it('stops every running foreground task when the turn closes, leaving background tasks running', () => {
        const withForeground = startTask(openTurn(), { task_id: 'fg-1', is_backgrounded: false, description: 'foreground work' }, T1);
        const withBoth = startTask(withForeground, { task_id: 'bg-1', is_backgrounded: true, description: 'background work' }, T1);

        const ledger = reduceLedger(withBoth, frozenEvent({ type: 'sdk_frame', frame: frames.resultInterrupted({ total_cost_usd: 0.02 }), at: T2 }));

        expect(ledger.tasks).toMatchObject([{ id: 'bg-1', status: 'running' }]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'fg-1', status: 'stopped', finishedAt: T2 }]);
    });

    it('keeps tasks and finishedTasks by reference when the closing turn had no foreground task', () => {
        const withBackground = startTask(openTurn(), { task_id: 'bg-1' }, T1);

        const ledger = reduceLedger(withBackground, frozenEvent({ type: 'sdk_frame', frame: frames.resultSuccess({ total_cost_usd: 0.05 }), at: T2 }));

        expect(ledger.tasks).toBe(withBackground.tasks);
        expect(ledger.finishedTasks).toBe(withBackground.finishedTasks);
    });

    it('leaves a running foreground task alone for a bare result that closes no turn', () => {
        const withForeground = startTask(initialLedger('conversation'), { task_id: 'fg-1', is_backgrounded: false }, T1);

        const ledger = reduceLedger(withForeground, frozenEvent({ type: 'sdk_frame', frame: frames.bareResult({ total_cost_usd: 0.07 }), at: T2 }));

        expect(ledger.tasks).toMatchObject([{ id: 'fg-1', status: 'running' }]);
        expect(ledger.finishedTasks).toEqual([]);
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

/** Folds a `task_started` frame built from `overrides` into `ledger`. */
function startTask(ledger: Ledger, overrides: Parameters<typeof frames.taskStarted>[0], at: Date): Ledger {
    return reduceLedger(ledger, frozenEvent({ type: 'sdk_frame', at, frame: frames.taskStarted(overrides) }));
}

/** A `user` frame carrying one `tool_result` block — the SDK's end-of-foreground-task signal. */
function toolResult(toolUseId: string, isError?: boolean): SDKUserMessage {
    return {
        type:               'user',
        message:            { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done', is_error: isError }] },
        parent_tool_use_id: null,
    };
}

/**
 * A `task_progress` frame carrying `workflow_progress` — a field the CLI emits on every workflow
 * progress frame but the SDK `.d.ts` does not declare, hence `Object.assign` rather than a literal.
 */
function workflowProgress(taskId: string, entries: unknown): SDKMessage {
    return Object.assign(frames.taskProgress({ task_id: taskId }), { workflow_progress: entries });
}

describe('reduceLedger: tasks', () => {
    it.each([
        ['local_agent', 'subagent'],
        ['local_workflow', 'workflow'],
        ['local_bash', 'shell'],
        ['monitor', 'monitor'],
        ['local_monitor', 'monitor'],
        ['something_else', 'other'],
    ] as const)('task_started maps task_type %s to kind %s', (taskType, kind) => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: taskType, description: 'do a thing' }, T1);

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', taskType, kind, description: 'do a thing', startedAt: T1 }]);
    });

    it('task_started records the whole task: tool_use_id, label, background, running status', () => {
        const ledger = startTask(initialLedger('conversation'), {
            task_id: 'task-1', tool_use_id: 'toolu-1', task_type: 'local_agent', subagent_type: 'sonnet-high', description: 'do a thing',
        }, T1);

        expect(ledger.tasks).toEqual([{
            id:          'task-1',
            toolUseId:   'toolu-1',
            taskType:    'local_agent',
            kind:        'subagent',
            description: 'do a thing',
            label:       'sonnet-high',
            background:  true,
            channelId:   undefined,
            turnId:      undefined,
            startedAt:   T1,
            progress:    undefined,
            workflow:    undefined,
            status:      'running',
            finishedAt:  undefined,
        }]);
        expect(ledger.finishedTasks).toEqual([]);
    });

    it('task_started with no task_type defaults taskType to \'unknown\' and kind to \'other\'', () => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: undefined, description: 'do a thing' }, T1);

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', taskType: 'unknown', kind: 'other', description: 'do a thing', startedAt: T1 }]);
    });

    it('task_started stamps channelId and turnId from the open turn', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({
            type: 'turn_submitted', at: T1, envelope: envelope({ id: 'turn-7', channelId: 'chan-9' }),
        }));

        const ledger = startTask(opened, { task_id: 'task-1' }, T2);

        expect(ledger.tasks[0]?.turnId).toBe('turn-7');
        expect(ledger.tasks[0]?.channelId).toBe('chan-9');
    });

    it('task_started leaves channelId and turnId unset when no turn is open', () => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        expect(ledger.tasks[0]?.turnId).toBeUndefined();
        expect(ledger.tasks[0]?.channelId).toBeUndefined();
    });

    it.each([
        ['local_workflow', 'plan-review', undefined, 'plan-review'],
        ['local_agent', undefined, 'gpt-terra-high', 'gpt-terra-high'],
        ['local_bash', 'plan-review', 'gpt-terra-high', undefined],
    ] as const)('task_started on %s labels from workflow_name/subagent_type', (taskType, workflowName, subagentType, label) => {
        const ledger = startTask(initialLedger('conversation'), {
            task_id: 'task-1', task_type: taskType, workflow_name: workflowName, subagent_type: subagentType,
        }, T1);

        expect(ledger.tasks[0]?.label).toBe(label);
    });

    it('tracks a foreground task (is_backgrounded false) with background false', () => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1', is_backgrounded: false }, T1);

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', background: false, status: 'running' }]);
    });

    it('treats a task_started with no is_backgrounded as foreground', () => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1', is_backgrounded: undefined }, T1);

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', background: false }]);
    });

    it('does not add an ambient task', () => {
        const ledger = startTask(initialLedger('conversation'), { task_id: 'task-1', ambient: true }, T1);

        expect(ledger.tasks).toEqual([]);
    });

    it('is idempotent (same reference) on a duplicate task_started', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const again = startTask(started, { task_id: 'task-1' }, T2);

        expect(again).toBe(started);
    });

    // The two frames race: `background_tasks_changed` can create the entry first, with only what
    // that payload carries. The later `task_started` fills the rest in rather than being dropped.
    it('task_started enriches an entry background_tasks_changed created first, overwriting nothing already set', () => {
        const created = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.backgroundTasksChanged([
                { task_id: 'task-1', task_type: 'local_agent', description: 'not this one' },
                { task_id: 'task-2', task_type: 'local_agent', description: 'from the payload' },
            ]),
        }));
        expect(created.tasks[1]).toMatchObject({ id: 'task-2', background: true });
        expect(created.tasks[1]?.toolUseId).toBeUndefined();
        expect(created.tasks[1]?.label).toBeUndefined();

        const ledger = startTask(created, {
            task_id:         'task-2',
            tool_use_id:     'toolu-1',
            task_type:       'local_agent',
            subagent_type:   'sonnet-high',
            description:     'from the start frame',
            is_backgrounded: false,
        }, T2);

        expect(ledger.tasks).toHaveLength(2);
        expect(ledger.tasks[0]).toBe(created.tasks[0]);
        expect(ledger.tasks[1]).toMatchObject({
            id:          'task-2',
            toolUseId:   'toolu-1',
            label:       'sonnet-high',
            description: 'from the payload',
            startedAt:   T1,
            background:  false,
            status:      'running',
        });
    });

    it('task_started fills the channel and turn of an entry created outside a turn', () => {
        const created = reduceLedger(initialLedger('conversation'), frozenEvent({
            type:  'sdk_frame', at:    T1,
            frame: frames.backgroundTasksChanged([{ task_id: 'task-1', task_type: 'local_agent', description: 'from the payload' }]),
        }));
        expect(created.tasks[0]?.channelId).toBeUndefined();

        const opened = reduceLedger(created, frozenEvent({
            type: 'turn_submitted', at: T2, envelope: envelope({ id: 'turn-7', channelId: 'chan-9' }),
        }));
        const ledger = startTask(opened, { task_id: 'task-1' }, T3);

        expect(ledger.tasks[0]).toMatchObject({ channelId: 'chan-9', turnId: 'turn-7' });
    });

    it('task_started never moves a tracked task onto the currently open turn', () => {
        const firstTurn = reduceLedger(initialLedger('conversation'), frozenEvent({
            type: 'turn_submitted', at: T1, envelope: envelope({ id: 'turn-7', channelId: 'chan-9' }),
        }));
        const started = startTask(firstTurn, { task_id: 'task-1' }, T1);
        const secondTurn = reduceLedger(started, frozenEvent({
            type: 'turn_submitted', at: T2, envelope: envelope({ id: 'turn-8', channelId: 'chan-4' }),
        }));

        const ledger = startTask(secondTurn, { task_id: 'task-1' }, T3);

        expect(ledger.tasks[0]).toMatchObject({ channelId: 'chan-9', turnId: 'turn-7' });
    });

    it.each(['completed', 'failed', 'stopped'] as const)('task_notification with status %s moves the task to finishedTasks', (status) => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskNotification(status, { task_id: 'task-1', usage: undefined }),
        }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status, finishedAt: T2 }]);
    });

    it('task_notification with no status treats the task as completed', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskNotification('completed', { task_id: 'task-1', status: undefined }),
        }));

        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'completed' }]);
    });

    it('task_notification merges its final usage into progress, keeping the last summary', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const progressed = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskProgress({ task_id: 'task-1', summary: 'Halfway', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }),
        }));

        const ledger = reduceLedger(progressed, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.taskNotification('completed', { task_id: 'task-1', usage: { total_tokens: 99, tool_uses: 7, duration_ms: 500 } }),
        }));

        expect(ledger.finishedTasks[0]?.progress).toEqual({ summary: 'Halfway', lastToolName: 'Bash', totalTokens: 99, toolUses: 7, durationMs: 500, at: T3 });
    });

    it('task_notification with no usage keeps the progress recorded so far', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const progressed = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskProgress({ task_id: 'task-1', summary: 'Halfway', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }),
        }));

        const ledger = reduceLedger(progressed, frozenEvent({
            type: 'sdk_frame', at: T3, frame: frames.taskNotification('completed', { task_id: 'task-1', usage: undefined }),
        }));

        expect(ledger.finishedTasks[0]?.progress).toEqual({ summary: 'Halfway', lastToolName: 'Bash', totalTokens: 10, toolUses: 1, durationMs: 5, at: T2 });
    });

    it('task_notification finishes only the task it names', () => {
        const first = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const both = startTask(first, { task_id: 'task-2' }, T1);

        const ledger = reduceLedger(both, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskNotification('failed', { task_id: 'task-2' }),
        }));

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', status: 'running' }]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-2', status: 'failed' }]);
    });

    // `background_tasks_changed` can drop a task from the payload a tick before its
    // `task_notification` arrives; the notification then corrects the finished row in place.
    it('task_notification corrects a task background_tasks_changed already finished, keeping its finishedAt', () => {
        const both = startTask(startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1), { task_id: 'task-2' }, T1);
        const progressed = reduceLedger(both, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.taskProgress({ task_id: 'task-2', summary: 'Halfway', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }),
        }));
        const vanished = reduceLedger(progressed, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.backgroundTasksChanged([]) }));
        expect(vanished.finishedTasks).toMatchObject([{ id: 'task-1', status: 'stopped' }, { id: 'task-2', status: 'stopped' }]);

        const ledger = reduceLedger(vanished, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.taskNotification('failed', { task_id: 'task-2', usage: { total_tokens: 99, tool_uses: 7, duration_ms: 500 } }),
        }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toHaveLength(2);
        expect(ledger.finishedTasks[0]).toBe(vanished.finishedTasks[0]);
        expect(ledger.finishedTasks[1]).toMatchObject({ id: 'task-2', status: 'failed', finishedAt: T2 });
        expect(ledger.finishedTasks[1]?.progress).toEqual({ summary: 'Halfway', lastToolName: 'Bash', totalTokens: 99, toolUses: 7, durationMs: 500, at: T3 });
    });

    it('task_notification for an id in neither list leaves the finished ones alone (same reference)', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const vanished = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.backgroundTasksChanged([]) }));

        const ledger = reduceLedger(vanished, frozenEvent({
            type: 'sdk_frame', at: T3, frame: frames.taskNotification('failed', { task_id: 'ghost' }),
        }));

        expect(ledger).toBe(vanished);
    });

    it('task_notification with no usage leaves an already-finished task\'s progress as it was', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const progressed = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.taskProgress({ task_id: 'task-1', summary: 'Halfway', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 } }),
        }));
        const vanished = reduceLedger(progressed, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.backgroundTasksChanged([]) }));

        const ledger = reduceLedger(vanished, frozenEvent({
            type: 'sdk_frame', at: T3, frame: frames.taskNotification('completed', { task_id: 'task-1', usage: undefined }),
        }));

        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'completed', finishedAt: T2 }]);
        expect(ledger.finishedTasks[0]?.progress).toEqual({ summary: 'Halfway', lastToolName: 'Bash', totalTokens: 10, toolUses: 1, durationMs: 5, at: T2 });
    });

    it('is idempotent (same reference) on a task_notification for an unknown id', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({
            type: 'sdk_frame', at: T1, frame: frames.taskNotification('completed', { task_id: 'unknown-task' }),
        }));

        expect(next).toBe(ledger);
    });

    it('finishedTasks keeps only the 20 most recent, newest last', () => {
        let ledger = initialLedger('conversation');
        for(let index = 0; index < 21; index++) {
            ledger = startTask(ledger, { task_id: `task-${index}` }, T1);
            ledger = reduceLedger(ledger, frozenEvent({
                type: 'sdk_frame', at: T2, frame: frames.taskNotification('completed', { task_id: `task-${index}` }),
            }));
        }

        expect(ledger.finishedTasks).toHaveLength(20);
        expect(ledger.finishedTasks[0]?.id).toBe('task-1');
        expect(ledger.finishedTasks[19]?.id).toBe('task-20');
    });

    it('task_progress records summary, last tool and usage on a running task', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.taskProgress({ task_id: 'task-1', summary: 'Reading files', last_tool_name: 'Read', usage: { total_tokens: 120, tool_uses: 3, duration_ms: 900 } }),
        }));

        expect(ledger.tasks[0]?.progress).toEqual({ summary: 'Reading files', lastToolName: 'Read', totalTokens: 120, toolUses: 3, durationMs: 900, at: T2 });
    });

    it('task_progress with no usage records the summary and leaves the usage numbers unset', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskProgress({ task_id: 'task-1', summary: 'Thinking', last_tool_name: undefined, usage: undefined }),
        }));

        expect(ledger.tasks[0]?.progress).toEqual({ summary: 'Thinking', lastToolName: undefined, totalTokens: undefined, toolUses: undefined, durationMs: undefined, at: T2 });
    });

    it('task_progress only touches the task it names', () => {
        const first = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const both = startTask(first, { task_id: 'task-2' }, T1);

        const ledger = reduceLedger(both, frozenEvent({
            type: 'sdk_frame', at: T2, frame: frames.taskProgress({ task_id: 'task-2', summary: 'Only mine' }),
        }));

        expect(ledger.tasks[0]?.progress).toBeUndefined();
        expect(ledger.tasks[1]?.progress?.summary).toBe('Only mine');
    });

    it('task_progress for an unknown task id is ignored (same reference, never creates a task)', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({
            type: 'sdk_frame', at: T1, frame: frames.taskProgress({ task_id: 'ghost' }),
        }));

        expect(next).toBe(ledger);
    });

    it('task_progress parses workflow_progress into phases and agents, mapping states and ignoring workflow_log', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: workflowProgress('task-1', [
                { type: 'workflow_phase', index: 0, title: 'Plan', kind: 'sequential' },
                { type: 'workflow_phase', index: 1, title: 'Build', kind: 'parallel' },
                { type: 'workflow_agent', index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 100, toolCalls: 3 },
                { type: 'workflow_agent', index: 1, label: 'builder', phaseIndex: 1, state: 'start', tokens: 50, toolCalls: 1 },
                { type: 'workflow_agent', index: 2, label: 'checker', phaseIndex: 1, state: 'error', tokens: 5, toolCalls: 0 },
                { type: 'workflow_log', message: 'ignored' },
            ]),
        }));

        expect(ledger.tasks[0]?.workflow).toEqual({
            phases: [{ index: 0, title: 'Plan' }, { index: 1, title: 'Build' }],
            agents: [
                { index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 100, toolCalls: 3 },
                { index: 1, label: 'builder', phaseIndex: 1, state: 'running', tokens: 50, toolCalls: 1 },
                { index: 2, label: 'checker', phaseIndex: 1, state: 'error', tokens: 5, toolCalls: 0 },
            ],
        });
    });

    it('task_progress keys workflow phases and agents by index, so a later entry replaces an earlier one', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: workflowProgress('task-1', [
                { type: 'workflow_phase', index: 0, title: 'Plan' },
                { type: 'workflow_phase', index: 0, title: 'Plan (renamed)' },
                { type: 'workflow_agent', index: 0, label: 'planner', phaseIndex: 0, state: 'start', tokens: 1, toolCalls: 0 },
                { type: 'workflow_agent', index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 9, toolCalls: 2 },
            ]),
        }));

        expect(ledger.tasks[0]?.workflow).toEqual({
            phases: [{ index: 0, title: 'Plan (renamed)' }],
            agents: [{ index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 9, toolCalls: 2 }],
        });
    });

    // An entry with no usable `index` cannot be keyed, and defaulting it to 0 silently overwrote
    // the real phase/agent 0. Everything else about an entry may still be defaulted.
    it('task_progress skips workflow_progress entries with no finite index and defaults their other fields', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: workflowProgress('task-1', [
                null,
                undefined,
                'not an entry',
                42,
                { notype: true },
                { type: 'workflow_phase', index: 0, title: 'Plan' },
                { type: 'workflow_agent', index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 5, toolCalls: 2 },
                { type: 'workflow_phase', index: 1, title: 7 },
                { type: 'workflow_agent', index: 1, state: 'who knows', tokens: 'lots' },
                { type: 'workflow_phase', title: 'no index' },
                { type: 'workflow_agent', label: 'no index' },
                { type: 'workflow_phase', index: 'nope' },
                { type: 'workflow_agent', index: Number.NaN },
                { type: 'workflow_phase', index: Number.POSITIVE_INFINITY },
                { type: 'workflow_agent', index: Number.NEGATIVE_INFINITY },
            ]),
        }));

        expect(ledger.tasks[0]?.workflow).toEqual({
            phases: [{ index: 0, title: 'Plan' }, { index: 1, title: '' }],
            agents: [
                { index: 0, label: 'planner', phaseIndex: 0, state: 'done', tokens: 5, toolCalls: 2 },
                { index: 1, label: '', phaseIndex: 0, state: 'running', tokens: 0, toolCalls: 0 },
            ],
        });
    });

    it('task_progress with a non-array workflow_progress leaves workflow unset', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T2, frame: workflowProgress('task-1', { phases: [] }),
        }));

        expect(ledger.tasks[0]?.workflow).toBeUndefined();
        expect(ledger.tasks[0]?.progress?.at).toBe(T2);
    });

    it('task_progress with no workflow_progress at all keeps the workflow parsed from an earlier frame', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);
        const withWorkflow = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: workflowProgress('task-1', [{ type: 'workflow_phase', index: 0, title: 'Plan' }]),
        }));

        const ledger = reduceLedger(withWorkflow, frozenEvent({
            type: 'sdk_frame', at: T3, frame: frames.taskProgress({ task_id: 'task-1' }),
        }));

        expect(ledger.tasks[0]?.workflow).toEqual({ phases: [{ index: 0, title: 'Plan' }], agents: [] });
    });

    it('logs the raw frame at debug level once per task id, the first time a workflow_progress array arrives', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_workflow' }, T1);
        // The two frames differ so the assertion below pins WHICH frame was logged, not merely that
        // exactly one was: logging the second frame instead of the first is a different bug.
        const first = workflowProgress('task-1', [{ type: 'workflow_phase', index: 0, title: 'Plan' }]);
        const second = workflowProgress('task-1', [{ type: 'workflow_phase', index: 0, title: 'Build' }]);

        const once = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: first }));
        reduceLedger(once, frozenEvent({ type: 'sdk_frame', at: T3, frame: second }));

        expect(mockLogger.debug).toHaveBeenCalledTimes(1);
        expect(mockLogger.debug).toHaveBeenCalledWith({ taskId: 'task-1', frame: first }, 'Ledger: first workflow_progress frame for a task');
    });

    it('does not log for a task_progress frame with no workflow_progress', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.taskProgress({ task_id: 'task-1' }) }));

        expect(mockLogger.debug).not.toHaveBeenCalled();
    });

    it('background_tasks_changed replaces the background set, drops ambient entries, keeps startedAt for known ids and stamps at for new ids', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', task_type: 'local_agent' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.backgroundTasksChanged([
                { task_id: 'task-1', task_type: 'local_agent', description: 'still running' },
                { task_id: 'task-2', task_type: 'local_bash', description: 'new task' },
                { task_id: 'task-3', task_type: 'local_bash', description: 'ambient one', ambient: true },
            ]),
        }));

        expect(ledger.tasks).toMatchObject([
            { id: 'task-1', taskType: 'local_agent', kind: 'subagent', description: 'still running', startedAt: T1, background: true, status: 'running' },
            { id: 'task-2', taskType: 'local_bash', kind: 'shell', description: 'new task', startedAt: T3, background: true, status: 'running' },
        ]);
    });

    it('background_tasks_changed leaves foreground tasks alone', () => {
        const withForeground = startTask(initialLedger('conversation'), { task_id: 'fg-1', is_backgrounded: false, description: 'foreground work' }, T1);
        const withBoth = startTask(withForeground, { task_id: 'bg-1', description: 'background work' }, T1);

        const ledger = reduceLedger(withBoth, frozenEvent({
            type:  'sdk_frame', at:    T3,
            frame: frames.backgroundTasksChanged([{ task_id: 'bg-1', task_type: 'local_agent', description: 'background work' }]),
        }));

        expect(ledger.tasks.map(task => task.id)).toEqual(['fg-1', 'bg-1']);
        expect(ledger.tasks[0]).toBe(withBoth.tasks[0]);
        expect(ledger.finishedTasks).toEqual([]);
    });

    it('background_tasks_changed backgrounds a foreground task that shows up in the payload', () => {
        const withForeground = startTask(initialLedger('conversation'), { task_id: 'fg-1', is_backgrounded: false, description: 'moved to background' }, T1);

        const ledger = reduceLedger(withForeground, frozenEvent({
            type:  'sdk_frame', at:    T2,
            frame: frames.backgroundTasksChanged([{ task_id: 'fg-1', task_type: 'local_agent', description: 'moved to background' }]),
        }));

        expect(ledger.tasks).toMatchObject([{ id: 'fg-1', background: true, startedAt: T1 }]);
    });

    // Changed from the pre-task-board behaviour: a background task that vanishes from the payload
    // with no task_notification used to be dropped silently; the board needs the finished row, so
    // it is now moved to finishedTasks as 'stopped'.
    it('background_tasks_changed stops a background task that vanished without a notification', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({
            type: 'sdk_frame', at: T3, frame: frames.backgroundTasksChanged([]),
        }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'stopped', finishedAt: T3 }]);
    });

    it('task_lost moves the task to finishedTasks as stopped', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);

        const ledger = reduceLedger(started, frozenEvent({ type: 'task_lost', taskId: 'task-1', at: T2 }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'stopped', finishedAt: T2 }]);
    });

    it('task_lost stops only the task it names', () => {
        const first = startTask(initialLedger('conversation'), { task_id: 'task-1' }, T1);
        const both = startTask(first, { task_id: 'task-2' }, T1);

        const ledger = reduceLedger(both, frozenEvent({ type: 'task_lost', taskId: 'task-2', at: T2 }));

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', status: 'running' }]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-2', status: 'stopped' }]);
    });

    it('task_lost on an unknown id is a no-op (same reference)', () => {
        const ledger = initialLedger('conversation');

        const next = reduceLedger(ledger, frozenEvent({ type: 'task_lost', taskId: 'unknown', at: T1 }));

        expect(next).toBe(ledger);
    });

    it('a tool_result for a running foreground task finishes it as completed', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);

        const ledger = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: toolResult('toolu-1') }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'completed', finishedAt: T2 }]);
    });

    it('a tool_result with is_error true finishes the foreground task as failed', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);

        const ledger = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: toolResult('toolu-1', true) }));

        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-1', status: 'failed', finishedAt: T2 }]);
    });

    it('a tool_result never finishes a background task with the same tool_use_id', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: true }, T1);

        const ledger = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: toolResult('toolu-1') }));

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', status: 'running' }]);
        expect(ledger.finishedTasks).toEqual([]);
    });

    it('a tool_result for an unknown tool_use_id is a no-op (same reference)', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);

        const next = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame: toolResult('toolu-other') }));

        expect(next).toBe(started);
    });

    it('a tool_result finishes only the task it names, leaving other foreground tasks running', () => {
        const first = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);
        const both = startTask(first, { task_id: 'task-2', tool_use_id: 'toolu-2', is_backgrounded: false }, T1);

        const ledger = reduceLedger(both, frozenEvent({ type: 'sdk_frame', at: T2, frame: toolResult('toolu-2') }));

        expect(ledger.tasks).toMatchObject([{ id: 'task-1', status: 'running' }]);
        expect(ledger.finishedTasks).toMatchObject([{ id: 'task-2', status: 'completed' }]);
    });

    it('a block that is not a tool_result never finishes a task, not even one launched with no tool_use_id', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: undefined, is_backgrounded: false }, T1);
        const frame: SDKUserMessage = {
            type:               'user',
            message:            { role: 'user', content: [{ type: 'text', text: 'no tool results here' }] },
            parent_tool_use_id: null,
        };

        const next = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame }));

        expect(next).toBe(started);
    });

    it('a user frame with string content is a no-op (same reference)', () => {
        const started = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);
        const frame: SDKUserMessage = { type: 'user', message: { role: 'user', content: 'just text' }, parent_tool_use_id: null };

        const next = reduceLedger(started, frozenEvent({ type: 'sdk_frame', at: T2, frame }));

        expect(next).toBe(started);
    });

    it('a user frame finishes every foreground task its tool_result blocks name', () => {
        const first = startTask(initialLedger('conversation'), { task_id: 'task-1', tool_use_id: 'toolu-1', is_backgrounded: false }, T1);
        const both = startTask(first, { task_id: 'task-2', tool_use_id: 'toolu-2', is_backgrounded: false }, T1);
        const frame: SDKUserMessage = {
            type:    'user',
            message: { role:    'user', content: [
                { type: 'text', text: 'here you go' },
                { type: 'tool_result', tool_use_id: 'toolu-1', content: 'ok' },
                { type: 'tool_result', tool_use_id: 'toolu-2', content: 'boom', is_error: true },
            ] },
            parent_tool_use_id: null,
        };

        const ledger = reduceLedger(both, frozenEvent({ type: 'sdk_frame', at: T2, frame }));

        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks.map(task => [task.id, task.status])).toEqual([['task-1', 'completed'], ['task-2', 'failed']]);
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

    // A new session id means the old session's tasks can never report again; they are stopped
    // rather than dropped, so the board still shows how the interrupted work ended.
    it('session_opened sets sessionId, stops every running task and resets cost.cumulativeUsd', () => {
        const withTasks = startTask(
            startTask(initialLedger('conversation'), { task_id: 'fg-1', is_backgrounded: false }, T1),
            { task_id: 'bg-1', is_backgrounded: true }, T1
        );
        const withState = reduceLedger(withTasks, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.resultSuccess({ total_cost_usd: 0.09 }) }));
        expect(withState.tasks).toHaveLength(2);
        expect(withState.cost.cumulativeUsd).toBeCloseTo(0.09);

        const ledger = reduceLedger(withState, frozenEvent({ type: 'session_opened', sessionId: 'sess-2', at: T3 }));

        expect(ledger.sessionId).toBe('sess-2');
        expect(ledger.tasks).toEqual([]);
        expect(ledger.finishedTasks).toMatchObject([
            { id: 'fg-1', status: 'stopped', finishedAt: T3 },
            { id: 'bg-1', status: 'stopped', finishedAt: T3 },
        ]);
        expect(ledger.cost.cumulativeUsd).toBe(0);
    });

    it('session_opened resets a non-zero cumulative cost even when the sessionId has not changed', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'session_opened', sessionId: 'sess-1', at: T1 }));
        const withCost = reduceLedger(opened, frozenEvent({ type: 'sdk_frame', at: T2, frame: frames.bareResult({ total_cost_usd: 0.09 }) }));
        expect(withCost.tasks).toEqual([]);
        expect(withCost.cost.cumulativeUsd).toBeCloseTo(0.09);

        const ledger = reduceLedger(withCost, frozenEvent({ type: 'session_opened', sessionId: 'sess-1', at: T3 }));

        expect(ledger.cost.cumulativeUsd).toBe(0);
    });

    it('session_opened keeps finishedTasks by reference when nothing was running', () => {
        const opened = reduceLedger(initialLedger('conversation'), frozenEvent({ type: 'session_opened', sessionId: 'sess-1', at: T1 }));

        const ledger = reduceLedger(opened, frozenEvent({ type: 'session_opened', sessionId: 'sess-2', at: T2 }));

        expect(ledger.sessionId).toBe('sess-2');
        expect(ledger.finishedTasks).toBe(opened.finishedTasks);
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
