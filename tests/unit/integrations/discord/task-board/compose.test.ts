import { describe, test, expect } from 'bun:test';
import { composeTaskBoards } from '@/integrations/discord/task-board/compose';
import type { BoardLedgerInput, BoardTaskInput } from '@/integrations/discord/task-board/types';

const T0 = new Date('2026-09-09T20:36:43.000Z');

/** Milliseconds after {@link T0}. */
function at(seconds: number): Date {
    return new Date(T0.getTime() + (seconds * 1000));
}

function task(overrides: Partial<BoardTaskInput> = {}): BoardTaskInput {
    return {
        id:          'task-1',
        kind:        'subagent',
        description: 'do a thing',
        channelId:   'chan-1',
        turnId:      'turn-1',
        startedAt:   T0,
        status:      'running',
        ...overrides,
    };
}

function ledger(tasks: BoardTaskInput[], finishedTasks: BoardTaskInput[] = []): BoardLedgerInput {
    return { role: 'conversation', tasks, finishedTasks };
}

describe('composeTaskBoards', () => {
    describe('grouping', () => {
        test('keys a board by channel id and turn id, and carries both', () => {
            const boards = composeTaskBoards([ledger([task()])], at(1));

            expect(boards).toHaveLength(1);
            expect(boards[0].key).toBe('chan-1:turn-1');
            expect(boards[0].channelId).toBe('chan-1');
            expect(boards[0].turnId).toBe('turn-1');
        });

        test('tasks with no channelId produce no board', () => {
            const boards = composeTaskBoards([ledger([task({ channelId: undefined })])], at(1));

            expect(boards).toEqual([]);
        });

        test('tasks with no turnId produce no board', () => {
            const boards = composeTaskBoards([ledger([task({ turnId: undefined })])], at(1));

            expect(boards).toEqual([]);
        });

        test('two turns in one channel produce two boards', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', turnId: 'turn-1' }),
                task({ id: 'b', turnId: 'turn-2', startedAt: at(5) }),
            ])], at(10));

            expect(boards.map(board => board.key)).toEqual(['chan-1:turn-1', 'chan-1:turn-2']);
        });

        test('one turn id seen in two channels produces two boards', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', channelId: 'chan-1' }),
                task({ id: 'b', channelId: 'chan-2', startedAt: at(5) }),
            ])], at(10));

            expect(boards.map(board => board.key)).toEqual(['chan-1:turn-1', 'chan-2:turn-1']);
        });

        test('running and finished tasks of one turn land on one board', () => {
            const boards = composeTaskBoards([ledger(
                [task({ id: 'b', startedAt: at(5) })],
                [task({ id: 'a', status: 'completed', finishedAt: at(3) })]
            )], at(10));

            expect(boards).toHaveLength(1);
            expect(boards[0].tasks.map(entry => entry.id)).toEqual(['a', 'b']);
        });

        test('tasks from several ledgers merge into one board when the key matches', () => {
            const boards = composeTaskBoards([
                ledger([task({ id: 'a' })]),
                { role: 'perch', tasks: [task({ id: 'b', startedAt: at(2) })], finishedTasks: [] },
            ], at(10));

            expect(boards).toHaveLength(1);
            expect(boards[0].tasks.map(entry => entry.id)).toEqual(['a', 'b']);
        });

        test('no ledgers produce no boards', () => {
            expect(composeTaskBoards([], at(1))).toEqual([]);
        });
    });

    describe('ordering', () => {
        // The ids run against the launch order on purpose, so a composer that sorted by id alone
        // would fail this test.
        test('tasks are in launch order by startedAt', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', startedAt: at(9) }),
                task({ id: 'b', startedAt: at(1) }),
            ])], at(10));

            expect(boards[0].tasks.map(entry => entry.id)).toEqual(['b', 'a']);
        });

        test('tasks launched at the same instant are ordered by id', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'task-2' }),
                task({ id: 'task-1' }),
            ])], at(10));

            expect(boards[0].tasks.map(entry => entry.id)).toEqual(['task-1', 'task-2']);
        });

        test('id ordering is stable when already sorted', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'task-1' }),
                task({ id: 'task-2' }),
            ])], at(10));

            expect(boards[0].tasks.map(entry => entry.id)).toEqual(['task-1', 'task-2']);
        });

        // The turn ids run against the launch order on purpose, so a composer that sorted by key
        // alone would fail this test.
        test('boards are returned in startedAt order', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', turnId: 'alpha', startedAt: at(30) }),
                task({ id: 'b', turnId: 'zulu', startedAt: at(2) }),
            ])], at(60));

            expect(boards.map(board => board.key)).toEqual(['chan-1:zulu', 'chan-1:alpha']);
        });

        test('boards started at the same instant are ordered by key', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', turnId: 'zulu' }),
                task({ id: 'b', turnId: 'alpha' }),
            ])], at(60));

            expect(boards.map(board => board.key)).toEqual(['chan-1:alpha', 'chan-1:zulu']);
        });

        test('board key ordering is stable when already sorted', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'a', turnId: 'alpha' }),
                task({ id: 'b', turnId: 'zulu' }),
            ])], at(60));

            expect(boards.map(board => board.key)).toEqual(['chan-1:alpha', 'chan-1:zulu']);
        });
    });

    describe('board timing and state', () => {
        test('startedAt is the earliest task start', () => {
            const boards = composeTaskBoards([ledger([
                task({ id: 'b', startedAt: at(9) }),
                task({ id: 'a', startedAt: at(1) }),
            ])], at(10));

            expect(boards[0].startedAt).toEqual(at(1));
        });

        test('a board with a running task is running and has no finishedAt', () => {
            const boards = composeTaskBoards([ledger(
                [task({ id: 'b' })],
                [task({ id: 'a', status: 'completed', finishedAt: at(3) })]
            )], at(10));

            expect(boards[0].state).toBe('running');
            expect(boards[0].finishedAt).toBeUndefined();
        });

        test('a running task keeps the board running even when another failed', () => {
            const boards = composeTaskBoards([ledger(
                [task({ id: 'b' })],
                [task({ id: 'a', status: 'failed', finishedAt: at(3) })]
            )], at(10));

            expect(boards[0].state).toBe('running');
        });

        test('all completed: state done, finishedAt is the latest finish', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ id: 'a', status: 'completed', finishedAt: at(3) }),
                task({ id: 'b', status: 'completed', finishedAt: at(8) }),
            ])], at(10));

            expect(boards[0].state).toBe('done');
            expect(boards[0].finishedAt).toEqual(at(8));
        });

        test('a failed task makes a settled board failed', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ id: 'a', status: 'completed', finishedAt: at(3) }),
                task({ id: 'b', status: 'failed', finishedAt: at(8) }),
            ])], at(10));

            expect(boards[0].state).toBe('failed');
        });

        test('a stopped task makes a settled board failed', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ id: 'a', status: 'stopped', finishedAt: at(8) }),
            ])], at(10));

            expect(boards[0].state).toBe('failed');
        });

        test('a settled board with no finish timestamps has no finishedAt', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ id: 'a', status: 'completed' }),
            ])], at(10));

            expect(boards[0].state).toBe('done');
            expect(boards[0].finishedAt).toBeUndefined();
        });
    });

    describe('per-task derivation', () => {
        test('a running task measures elapsed from now', () => {
            const boards = composeTaskBoards([ledger([task({ startedAt: at(2) })])], at(9));

            expect(boards[0].tasks[0].elapsedMs).toBe(7000);
        });

        test('a finished task measures elapsed from its finish', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ status: 'completed', startedAt: at(2), finishedAt: at(5) }),
            ])], at(90));

            expect(boards[0].tasks[0].elapsedMs).toBe(3000);
        });

        test('progress fields are carried onto the view', () => {
            const boards = composeTaskBoards([ledger([task({
                progress: { summary: 'Reading files', totalTokens: 1234, toolUses: 7, at: at(3) },
            })])], at(9));

            const view = boards[0].tasks[0];
            expect(view.summary).toBe('Reading files');
            expect(view.totalTokens).toBe(1234);
            expect(view.toolUses).toBe(7);
        });

        test('a task with no progress reports zero tokens, zero tool uses and no summary', () => {
            const boards = composeTaskBoards([ledger([task()])], at(9));

            const view = boards[0].tasks[0];
            expect(view.summary).toBeUndefined();
            expect(view.totalTokens).toBe(0);
            expect(view.toolUses).toBe(0);
        });

        test('a progress frame with no usage numbers reports zeroes', () => {
            const boards = composeTaskBoards([ledger([task({
                progress: { at: at(3) },
            })])], at(9));

            const view = boards[0].tasks[0];
            expect(view.totalTokens).toBe(0);
            expect(view.toolUses).toBe(0);
        });

        test('identity fields are carried through', () => {
            const boards = composeTaskBoards([ledger([task({
                id: 'task-9', kind: 'workflow', label: 'review-changes', description: 'go', status: 'running',
            })])], at(9));

            const view = boards[0].tasks[0];
            expect(view.id).toBe('task-9');
            expect(view.kind).toBe('workflow');
            expect(view.label).toBe('review-changes');
            expect(view.description).toBe('go');
            expect(view.status).toBe('running');
            expect(view.startedAt).toEqual(T0);
            expect(view.finishedAt).toBeUndefined();
        });

        test('a finished task carries its finishedAt', () => {
            const boards = composeTaskBoards([ledger([], [
                task({ status: 'completed', finishedAt: at(4) }),
            ])], at(9));

            expect(boards[0].tasks[0].finishedAt).toEqual(at(4));
        });

        test('a task with no workflow block has no workflow on the view', () => {
            const boards = composeTaskBoards([ledger([task()])], at(9));

            expect(boards[0].tasks[0].workflow).toBeUndefined();
        });
    });

    describe('workflow meter fraction', () => {
        test('no agents seen yields fraction 0 and the phases are carried through', () => {
            const workflow = { phases: [{ index: 0, title: 'Review' }], agents: [] };
            const boards = composeTaskBoards([ledger([task({ kind: 'workflow', workflow })])], at(9));

            expect(boards[0].tasks[0].workflow).toEqual({
                phases:        [{ index: 0, title: 'Review' }],
                agents:        [],
                meterFraction: 0,
            });
        });

        test('fraction is agents done over agents seen', () => {
            const agents = [
                { index: 0, label: 'a', phaseIndex: 0, state: 'done' as const, tokens: 1, toolCalls: 1 },
                { index: 1, label: 'b', phaseIndex: 0, state: 'running' as const, tokens: 2, toolCalls: 2 },
                { index: 2, label: 'c', phaseIndex: 1, state: 'running' as const, tokens: 3, toolCalls: 3 },
                { index: 3, label: 'd', phaseIndex: 1, state: 'error' as const, tokens: 4, toolCalls: 4 },
            ];
            const boards = composeTaskBoards([ledger([task({ kind: 'workflow', workflow: { phases: [], agents } })])], at(9));

            expect(boards[0].tasks[0].workflow?.meterFraction).toBe(0.25);
            expect(boards[0].tasks[0].workflow?.agents).toEqual(agents);
        });

        test('every agent done yields fraction 1', () => {
            const agents = [
                { index: 0, label: 'a', phaseIndex: 0, state: 'done' as const, tokens: 1, toolCalls: 1 },
                { index: 1, label: 'b', phaseIndex: 0, state: 'done' as const, tokens: 2, toolCalls: 2 },
            ];
            const boards = composeTaskBoards([ledger([task({ kind: 'workflow', workflow: { phases: [], agents } })])], at(9));

            expect(boards[0].tasks[0].workflow?.meterFraction).toBe(1);
        });
    });
});
