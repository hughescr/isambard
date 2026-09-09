/**
 * Behavioural tests for {@link createTaskLaunchRegistry}, {@link parseTaskNotification} and
 * {@link launchIdFromToolResponse} (R2).
 */
import { describe, expect, it } from 'bun:test';
import { FakeJournal } from '../../../helpers/fake-journal';
import {
    createTaskLaunchRegistry,
    launchIdFromToolResponse,
    parseTaskNotification,
    type TaskLaunch
} from '@/agent/session/task-launch-registry';

function launch(overrides: Partial<TaskLaunch> = {}): TaskLaunch {
    return {
        taskId:     'task-1',
        toolUseId:  'tool-1',
        toolName:   'Agent',
        envelopeId: 'env-1',
        kind:       'discord',
        channelId:  'chan-1',
        authorId:   'user-1',
        launchedAt: new Date('2026-09-08T00:00:00Z'),
        ...overrides,
    };
}

describe('createTaskLaunchRegistry', () => {
    describe('record()/lookup()', () => {
        it('records a launch and finds it by toolUseId', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch());

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toEqual(launch());
        });

        it('finds a recorded launch by toolUseId even when the queried taskId is wrong', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch());

            expect(registry.lookup({ taskId: 'wrong-task', toolUseId: 'tool-1' })).toEqual(launch());
        });

        it('falls back to matching by taskId when toolUseId does not match', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch());

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'wrong-tool' })).toEqual(launch());
        });

        it('returns undefined when neither taskId nor toolUseId match anything recorded', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch());

            expect(registry.lookup({ taskId: 'nope', toolUseId: 'nope' })).toBeUndefined();
        });

        it('appends a task_launched journal row with optional fields present when given', () => {
            const journal = new FakeJournal();
            const registry = createTaskLaunchRegistry({ journal });

            registry.record(launch({ description: 'run the thing' }));

            expect(journal.byKind('task_launched')).toEqual([
                {
                    type: 'task_launched', at: new Date('2026-09-08T00:00:00Z'), taskId: 'task-1', toolUseId: 'tool-1', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1', authorId: 'user-1', description: 'run the thing',
                },
            ]);
        });

        it('appends a task_launched journal row with optional fields omitted when absent', () => {
            const journal = new FakeJournal();
            const registry = createTaskLaunchRegistry({ journal });

            registry.record(launch({ channelId: undefined, authorId: undefined, description: undefined }));

            const [entry] = journal.byKind('task_launched');
            expect(entry).not.toHaveProperty('channelId');
            expect(entry).not.toHaveProperty('authorId');
            expect(entry).not.toHaveProperty('description');
        });

        it('does not append to the journal when none was given', () => {
            const registry = createTaskLaunchRegistry();

            expect(() => {
                registry.record(launch());
            }).not.toThrow();
        });

        it('a second record() for the same taskId with a DIFFERENT toolUseId removes the stale toolUseId index entry, so a lookup by the old toolUseId (with a non-matching taskId) misses', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch({ taskId: 'task-A', toolUseId: 'tool-T1' }));
            registry.record(launch({ taskId: 'task-A', toolUseId: 'tool-T2' }));

            expect(registry.lookup({ taskId: 'unrelated-task', toolUseId: 'tool-T1' })).toBeUndefined();
            expect(registry.lookup({ taskId: 'task-A', toolUseId: 'tool-T2' })?.toolUseId).toBe('tool-T2');
        });

        it('a second record() for the same taskId overwrites without duplicating the FIFO order slot', () => {
            const registry = createTaskLaunchRegistry({ capacity: 2 });
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1' }));
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1', description: 'updated' }));
            registry.record(launch({ taskId: 'task-2', toolUseId: 'tool-2' }));

            // capacity 2 with task-1 re-recorded (not re-pushed to the order) then task-2 added
            // must still leave BOTH task-1 and task-2 present — if the re-record had duplicated
            // task-1's order slot, task-2 would have evicted task-1's OWN original slot instead of
            // nothing, but eviction only fires past capacity, so this proves no double-push.
            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })?.description).toBe('updated');
            expect(registry.lookup({ taskId: 'task-2', toolUseId: 'tool-2' })).toBeDefined();
        });
    });

    describe('capacity eviction', () => {
        it('evicts the oldest taskId once past capacity, dropping its toolUseId index too', () => {
            const registry = createTaskLaunchRegistry({ capacity: 2 });
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1' }));
            registry.record(launch({ taskId: 'task-2', toolUseId: 'tool-2' }));
            registry.record(launch({ taskId: 'task-3', toolUseId: 'tool-3' }));

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toBeUndefined();
            expect(registry.lookup({ taskId: 'task-2', toolUseId: 'tool-2' })).toBeDefined();
            expect(registry.lookup({ taskId: 'task-3', toolUseId: 'tool-3' })).toBeDefined();
        });

        it('eviction removes the evicted toolUseId index entry too, so a later launch that reuses the evicted taskId under a NEW toolUseId is not falsely reachable via the OLD, evicted toolUseId', () => {
            const registry = createTaskLaunchRegistry({ capacity: 2 });
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1' }));
            registry.record(launch({ taskId: 'task-2', toolUseId: 'tool-2' }));
            registry.record(launch({ taskId: 'task-3', toolUseId: 'tool-3' })); // evicts task-1

            // task-1 is reused by a later, unrelated launch under a DIFFERENT toolUseId — if
            // eviction had left the old tool-1 -> task-1 mapping behind, a query for the stale
            // tool-1 would incorrectly resolve through it to this new, unrelated launch.
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-4', description: 'reused' }));

            expect(registry.lookup({ taskId: 'unrelated-task', toolUseId: 'tool-1' })).toBeUndefined();
            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-4' })?.description).toBe('reused');
        });
    });

    describe('seed()', () => {
        it('folds task_launched rows into the registry without re-appending to the journal', () => {
            const journal = new FakeJournal();
            const registry = createTaskLaunchRegistry({ journal });

            registry.seed([
                {
                    type: 'task_launched', at: new Date('2026-09-08T00:00:00Z'), taskId: 'task-1', toolUseId: 'tool-1', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1', authorId: 'user-1',
                },
                { type: 'session_opened', at: new Date('2026-09-08T00:00:01Z'), role: 'conversation', sessionId: 'sess-1', resumed: false },
            ]);

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toEqual(launch());
            expect(journal.entries()).toEqual([]);
        });

        it('seeded entries are subject to the same capacity eviction as record()', () => {
            const registry = createTaskLaunchRegistry({ capacity: 1 });

            registry.seed([
                {
                    type: 'task_launched', at: new Date(0), taskId: 'task-1', toolUseId: 'tool-1', toolName: 'Agent', envelopeId: 'env-1', kind: 'discord',
                },
                {
                    type: 'task_launched', at: new Date(0), taskId: 'task-2', toolUseId: 'tool-2', toolName: 'Agent', envelopeId: 'env-2', kind: 'discord',
                },
            ]);

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toBeUndefined();
            expect(registry.lookup({ taskId: 'task-2', toolUseId: 'tool-2' })).toBeDefined();
        });
    });

    describe('forget()', () => {
        it('removes a launch so a subsequent lookup by either key misses', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch());

            registry.forget('task-1');

            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toBeUndefined();
        });

        it('clears the toolUseId index too: a later launch that reuses the SAME taskId under a NEW toolUseId is not falsely reachable via the OLD, forgotten toolUseId', () => {
            const registry = createTaskLaunchRegistry();
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1' }));

            registry.forget('task-1');
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-2' }));

            expect(registry.lookup({ taskId: 'wrong-task', toolUseId: 'tool-1' })).toBeUndefined();
            expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-2' })?.toolUseId).toBe('tool-2');
        });

        it('forgetting an unknown taskId is a no-op, not a throw', () => {
            const registry = createTaskLaunchRegistry();

            expect(() => {
                registry.forget('never-recorded');
            }).not.toThrow();
        });

        it('after forgetting, the freed FIFO slot lets capacity accommodate a new launch without evicting an unrelated one', () => {
            const registry = createTaskLaunchRegistry({ capacity: 1 });
            registry.record(launch({ taskId: 'task-1', toolUseId: 'tool-1' }));
            registry.forget('task-1');
            registry.record(launch({ taskId: 'task-2', toolUseId: 'tool-2' }));

            expect(registry.lookup({ taskId: 'task-2', toolUseId: 'tool-2' })).toBeDefined();
        });

        it('forgetting a MIDDLE entry removes it from the FIFO order immediately, so a later insert that fits within capacity does not evict an unrelated still-live entry', () => {
            const registry = createTaskLaunchRegistry({ capacity: 3 });
            registry.record(launch({ taskId: 'A', toolUseId: 'tool-A' }));
            registry.record(launch({ taskId: 'B', toolUseId: 'tool-B' }));
            registry.record(launch({ taskId: 'C', toolUseId: 'tool-C' }));

            registry.forget('B');
            registry.record(launch({ taskId: 'D', toolUseId: 'tool-D' }));

            // Exactly 3 live launches (A, C, D) fit within capacity 3 — if forget() left a stale
            // 'B' slot behind in the FIFO order, this 4th insert would look like 4 live entries
            // and evict the still-live, oldest 'A' to make room, even though only 3 real launches
            // exist.
            expect(registry.lookup({ taskId: 'A', toolUseId: 'tool-A' })).toBeDefined();
            expect(registry.lookup({ taskId: 'C', toolUseId: 'tool-C' })).toBeDefined();
            expect(registry.lookup({ taskId: 'D', toolUseId: 'tool-D' })).toBeDefined();
        });
    });

    it('a default-constructed registry (no params) works with no journal and default capacity', () => {
        const registry = createTaskLaunchRegistry();

        expect(() => {
            registry.record(launch());
        }).not.toThrow();
        expect(registry.lookup({ taskId: 'task-1', toolUseId: 'tool-1' })).toBeDefined();
    });
});

describe('parseTaskNotification', () => {
    it('parses the real probed shape into { taskId, toolUseId }', () => {
        const prompt = '<task-notification>\n<task-id>agent-abc-123</task-id>\n<tool-use-id>toolu_01XYZ</tool-use-id>\n<status>completed</status>\n<output-file></output-file>\nBG-AGENT-5533\n</task-notification>';

        expect(parseTaskNotification(prompt)).toEqual({ taskId: 'agent-abc-123', toolUseId: 'toolu_01XYZ' });
    });

    it('returns undefined for a prompt that does not start with <task-notification>', () => {
        expect(parseTaskNotification('hello, this is a normal message')).toBeUndefined();
    });

    it('returns undefined when both tags are present and well-formed but the prompt does not START with <task-notification> (e.g. quoted mid-message)', () => {
        const prompt = 'quoting a prior wake for debugging: <task-notification><task-id>agent-X</task-id><tool-use-id>tool-T</tool-use-id></task-notification>';

        expect(parseTaskNotification(prompt)).toBeUndefined();
    });

    it('returns undefined when the task-id tag is missing', () => {
        expect(parseTaskNotification('<task-notification><tool-use-id>t1</tool-use-id></task-notification>')).toBeUndefined();
    });

    it('returns undefined when the tool-use-id tag is missing', () => {
        expect(parseTaskNotification('<task-notification><task-id>a1</task-id></task-notification>')).toBeUndefined();
    });

    it('returns undefined when the task-id tag is present but empty', () => {
        expect(parseTaskNotification('<task-notification><task-id></task-id><tool-use-id>t1</tool-use-id></task-notification>')).toBeUndefined();
    });

    it('returns undefined when the tool-use-id tag is present but empty', () => {
        expect(parseTaskNotification('<task-notification><task-id>a1</task-id><tool-use-id></tool-use-id></task-notification>')).toBeUndefined();
    });

    it('captures non-greedily: a value must not swallow past its OWN closing tag even when a later, same-shaped tag appears further in the prompt', () => {
        const prompt = '<task-notification><task-id>a1</task-id><tool-use-id>t1</tool-use-id>trailing body mentioning <task-id>decoy</task-id> and <tool-use-id>decoy2</tool-use-id></task-notification>';

        expect(parseTaskNotification(prompt)).toEqual({ taskId: 'a1', toolUseId: 't1' });
    });

    it(String.raw`captures a value spanning a newline ([\s\S], not a dot, so it is not limited to a single line)`, () => {
        const prompt = '<task-notification><task-id>a1\nb2</task-id><tool-use-id>t1\nt2</tool-use-id></task-notification>';

        expect(parseTaskNotification(prompt)).toEqual({ taskId: 'a1\nb2', toolUseId: 't1\nt2' });
    });
});

describe('launchIdFromToolResponse', () => {
    it('extracts agentId from an Agent tool_response object', () => {
        expect(launchIdFromToolResponse('Agent', { agentId: 'agent-1', status: 'async_launched' })).toBe('agent-1');
    });

    it('extracts agentId from an Agent tool_response given as a JSON string', () => {
        expect(launchIdFromToolResponse('Agent', JSON.stringify({ agentId: 'agent-2', status: 'async_launched' }))).toBe('agent-2');
    });

    it('extracts taskId from a Workflow tool_response object', () => {
        expect(launchIdFromToolResponse('Workflow', { taskId: 'wf-1', runId: 'run-1', status: 'async_launched' })).toBe('wf-1');
    });

    it('extracts taskId from a Workflow tool_response given as a JSON string', () => {
        expect(launchIdFromToolResponse('Workflow', JSON.stringify({ taskId: 'wf-2', runId: 'run-2', status: 'async_launched' }))).toBe('wf-2');
    });

    it('extracts backgroundTaskId from a Bash tool_response object', () => {
        expect(launchIdFromToolResponse('Bash', { backgroundTaskId: 'bg-1' })).toBe('bg-1');
    });

    it('extracts backgroundTaskId from a Bash tool_response given as a JSON string', () => {
        expect(launchIdFromToolResponse('Bash', JSON.stringify({ backgroundTaskId: 'bg-2' }))).toBe('bg-2');
    });

    it('returns undefined for a non-launch tool', () => {
        expect(launchIdFromToolResponse('Read', { content: 'file contents' })).toBeUndefined();
    });

    it('returns undefined for a synchronous Agent response with no agentId (not a background launch)', () => {
        expect(launchIdFromToolResponse('Agent', { result: 'done synchronously' })).toBeUndefined();
    });

    it('returns undefined when a non-Agent tool response happens to carry an agentId field (mismatched tool name)', () => {
        expect(launchIdFromToolResponse('Bash', { agentId: 'agent-1' })).toBeUndefined();
    });

    it('returns undefined when a non-Workflow tool response happens to carry a taskId field (mismatched tool name)', () => {
        expect(launchIdFromToolResponse('Agent', { taskId: 'wf-1' })).toBeUndefined();
    });

    it('returns undefined when a non-Bash tool response happens to carry a backgroundTaskId field (mismatched tool name)', () => {
        expect(launchIdFromToolResponse('Workflow', { backgroundTaskId: 'bg-1' })).toBeUndefined();
    });

    it('returns undefined when tool_response is an unparseable JSON string', () => {
        expect(launchIdFromToolResponse('Agent', 'not json {')).toBeUndefined();
    });

    it('returns undefined when tool_response is null', () => {
        expect(launchIdFromToolResponse('Agent', null)).toBeUndefined();
    });

    it('returns undefined when tool_response is a primitive', () => {
        expect(launchIdFromToolResponse('Agent', 42)).toBeUndefined();
    });

    it('returns undefined when tool_response is undefined', () => {
        expect(launchIdFromToolResponse('Agent', undefined)).toBeUndefined();
    });

    it('returns undefined when tool_response is a JSON string that parses to null', () => {
        expect(launchIdFromToolResponse('Agent', JSON.stringify(null))).toBeUndefined();
    });

    it('returns undefined when tool_response is a JSON string that parses to a primitive (not an object)', () => {
        expect(launchIdFromToolResponse('Agent', JSON.stringify(42))).toBeUndefined();
    });
});
