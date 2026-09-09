import { describe, test, expect } from 'bun:test';
import {
    renderTaskBoardEmbed,
    BOARD_COLOR_RUNNING,
    BOARD_COLOR_DONE,
    BOARD_COLOR_FAILED
} from '@/integrations/discord/task-board/render';
import type { TaskBoardTask, TaskBoardView, BoardWorkflowAgentInput } from '@/integrations/discord/task-board/types';

const T0 = new Date('2026-09-09T20:36:43.000Z');

/** A `Date` `seconds` after {@link T0}. */
function at(seconds: number): Date {
    return new Date(T0.getTime() + (seconds * 1000));
}

function boardTask(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
    return {
        id:          'task-1',
        kind:        'subagent',
        description: 'do a thing',
        status:      'running',
        startedAt:   T0,
        elapsedMs:   4000,
        totalTokens: 0,
        toolUses:    0,
        ...overrides,
    };
}

function board(tasks: TaskBoardTask[], overrides: Partial<TaskBoardView> = {}): TaskBoardView {
    return {
        key:       'chan-1:turn-1',
        channelId: 'chan-1',
        turnId:    'turn-1',
        tasks,
        state:     'running',
        startedAt: T0,
        ...overrides,
    };
}

function agent(overrides: Partial<BoardWorkflowAgentInput> = {}): BoardWorkflowAgentInput {
    return { index: 0, label: 'agent', phaseIndex: 0, state: 'running', tokens: 0, toolCalls: 0, ...overrides };
}

const REVIEW_PHASES = [{ index: 0, title: 'Review' }, { index: 1, title: 'Verify' }];

/**
 * The mockup's five workflow agents at the frame-2 moment: phase 0 finished, phase 1 running.
 * The agents arrive in announcement order, so the *last* running entry is the newest one and is
 * the one whose label the `↳` line names.
 */
const FRAME_2_AGENTS: BoardWorkflowAgentInput[] = [
    agent({ index: 0, label: 'review:presence-view.ts', phaseIndex: 0, state: 'done', tokens: 30_000, toolCalls: 9 }),
    agent({ index: 1, label: 'review:manager.ts', phaseIndex: 0, state: 'done', tokens: 25_000, toolCalls: 7 }),
    agent({ index: 2, label: 'review:setup.ts', phaseIndex: 0, state: 'done', tokens: 22_000, toolCalls: 6 }),
    agent({ index: 3, label: 'verify:bot.ts', phaseIndex: 1, state: 'running', tokens: 20_000, toolCalls: 4 }),
    agent({ index: 4, label: 'verify:presence-setup.ts', phaseIndex: 1, state: 'running', tokens: 21_000, toolCalls: 3 }),
];

const FINISHED_SUBAGENT = boardTask({
    id:          'task-2',
    kind:        'subagent',
    label:       'opus-high',
    description: 'trace the presence throttle',
    status:      'completed',
    startedAt:   T0,
    finishedAt:  at(79),
    elapsedMs:   79_000,
    totalTokens: 41_000,
    toolUses:    12,
});

describe('renderTaskBoardEmbed', () => {
    // The three frames of the approved mockup
    // (https://claude.ai/code/artifact/a37143aa-57d5-4dc2-b9b2-180a99993f79), rendered from the
    // view a ledger of that shape composes. The workflow row's name reads
    // `🪾 Workflow · review-changes` in the mockup, which is `emoji label · description` with the
    // ledger's `label` holding `Workflow`; frame 3's board duration is 2:41 rather than the
    // mockup's 2:47 because the board's `finishedAt` is defined as the latest task finish and the
    // mockup's own rows put that at 2:41.
    describe('mockup frames', () => {
        test('frame 1: just launched', () => {
            const workflow = boardTask({
                id:          'task-1',
                kind:        'workflow',
                label:       'Workflow',
                description: 'review-changes',
                workflow:    { phases: REVIEW_PHASES, agents: [], meterFraction: 0 },
            });
            const subagent = boardTask({
                id:          'task-2',
                label:       'opus-high',
                description: 'trace the presence throttle',
            });

            expect(renderTaskBoardEmbed(board([workflow, subagent]), at(4))).toEqual({
                title:  '⏳ Working in the background · 2 running',
                color:  BOARD_COLOR_RUNNING,
                fields: [
                    { name: '🪾 Workflow · review-changes', value: '▱▱▱▱▱▱▱▱▱▱ 0 / 2 phases\nStarting · Review' },
                    { name: '🔬 opus-high · trace the presence throttle', value: 'Starting up · 0 tokens · 0:04' },
                ],
                footer: 'Updates every few seconds · Last update 8:36:47 PM',
            });
        });

        test('frame 2: mid-run, one sub-agent done, workflow at 3/5 agents in phase 2 of 2', () => {
            const workflow = boardTask({
                id:          'task-1',
                kind:        'workflow',
                label:       'Workflow',
                description: 'review-changes',
                elapsedMs:   96_000,
                totalTokens: 118_000,
                summary:     'Checking whether the bypass path records the throttle',
                workflow:    { phases: REVIEW_PHASES, agents: FRAME_2_AGENTS, meterFraction: 0.6 },
            });

            expect(renderTaskBoardEmbed(board([workflow, FINISHED_SUBAGENT]), at(96))).toEqual({
                title:  '⏳ Working in the background · 1 running, 1 done',
                color:  BOARD_COLOR_RUNNING,
                fields: [
                    {
                        name:  '🪾 Workflow · review-changes',
                        value: '▰▰▰▰▰▰▱▱▱▱ 1 / 2 phases · 3 / 5 agents finished\n'
                          + 'Review ✓ · Verify running · 118k tokens so far\n'
                          + '↳ verify:presence-setup.ts · Checking whether the bypass path records the throttle',
                    },
                    { name: '✅ opus-high · trace the presence throttle', value: '41k tokens · 12 tool calls · 1:19' },
                ],
                footer: 'Updates every few seconds · Last update 8:38:19 PM',
            });
        });

        test('frame 3: all finished, board frozen', () => {
            const workflow = boardTask({
                id:          'task-1',
                kind:        'workflow',
                label:       'Workflow',
                description: 'review-changes',
                status:      'completed',
                finishedAt:  at(161),
                elapsedMs:   161_000,
                totalTokens: 203_000,
                workflow:    {
                    phases:        REVIEW_PHASES,
                    agents:        FRAME_2_AGENTS.map(entry => ({ ...entry, state: 'done' as const })),
                    meterFraction: 1,
                },
            });
            const view = board([workflow, FINISHED_SUBAGENT], { state: 'done', finishedAt: at(161) });

            expect(renderTaskBoardEmbed(view, at(170))).toEqual({
                title:  '✅ Background work finished · 2 tasks · 2:41',
                color:  BOARD_COLOR_DONE,
                fields: [
                    { name: '✅ Workflow · review-changes', value: '▰▰▰▰▰▰▰▰▰▰ 2 / 2 phases · 5 agents · 203k tokens · 2:41' },
                    { name: '✅ opus-high · trace the presence throttle', value: '41k tokens · 12 tool calls · 1:19' },
                ],
                footer: 'Finished 8:39:24 PM',
            });
        });
    });

    describe('title and colour', () => {
        test('a running board with no finished task omits the done count', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask()]), at(4));

            expect(rendered.title).toBe('⏳ Working in the background · 1 running');
            expect(rendered.color).toBe(BOARD_COLOR_RUNNING);
        });

        test('a failed board reads stopped, in red', () => {
            const view = board([boardTask({ status: 'failed', finishedAt: at(9), elapsedMs: 9000 })], {
                state:      'failed',
                finishedAt: at(9),
            });
            const rendered = renderTaskBoardEmbed(view, at(20));

            expect(rendered.title).toBe('❌ Background work stopped · 1 task · 0:09');
            expect(rendered.color).toBe(BOARD_COLOR_FAILED);
        });

        test('a settled board with no finishedAt measures its duration to now', () => {
            const view = board([boardTask({ status: 'completed', elapsedMs: 9000 })], { state: 'done' });

            expect(renderTaskBoardEmbed(view, at(65)).title).toBe('✅ Background work finished · 1 task · 1:05');
        });
    });

    describe('field names', () => {
        test.each([
            ['subagent' as const, '🔬'],
            ['workflow' as const, '🪾'],
            ['monitor' as const, '⌚'],
            ['shell' as const, '🐚'],
            ['other' as const, '🔧'],
        ])('a running %s task uses %s', (kind, emoji) => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ kind, description: 'x' })]), at(4));

            expect(rendered.fields[0].name).toBe(`${emoji} x`);
        });

        test('a completed task uses ✅ instead of the kind emoji', () => {
            const view = board([boardTask({ status: 'completed', description: 'x' })], { state: 'done' });

            expect(renderTaskBoardEmbed(view, at(4)).fields[0].name).toBe('✅ x');
        });

        test.each([['failed' as const], ['stopped' as const]])('a %s task uses ❌', (status) => {
            const view = board([boardTask({ status, description: 'x' })], { state: 'failed' });

            expect(renderTaskBoardEmbed(view, at(4)).fields[0].name).toBe('❌ x');
        });

        test('a label sits between the emoji and the description', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ label: 'opus-high', description: 'x' })]), at(4));

            expect(rendered.fields[0].name).toBe('🔬 opus-high · x');
        });

        test('an empty description leaves the name at emoji and label', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ label: 'opus-high', description: '' })]), at(4));

            expect(rendered.fields[0].name).toBe('🔬 opus-high');
        });

        test('no label and no description leaves the name at the emoji alone', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ description: '' })]), at(4));

            expect(rendered.fields[0].name).toBe('🔬');
        });

        test('a description of exactly 60 characters is kept whole', () => {
            const description = 'd'.repeat(60);
            const rendered = renderTaskBoardEmbed(board([boardTask({ description })]), at(4));

            expect(rendered.fields[0].name).toBe(`🔬 ${description}`);
        });

        test('a longer description is capped at 60 characters with an ellipsis', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ description: 'd'.repeat(61) })]), at(4));

            expect(rendered.fields[0].name).toBe(`🔬 ${'d'.repeat(59)}…`);
        });
    });

    describe('sub-agent and shell values', () => {
        test('a running task with no summary reads Starting up', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask()]), at(4));

            expect(rendered.fields[0].value).toBe('Starting up · 0 tokens · 0:04');
        });

        test('a running task shows its summary, tokens and elapsed time', () => {
            const task = boardTask({ summary: 'Reading files', totalTokens: 12_400, elapsedMs: 65_000 });

            expect(renderTaskBoardEmbed(board([task]), at(65)).fields[0].value).toBe('Reading files · 12k tokens · 1:05');
        });

        test('a finished task shows tokens, tool calls and elapsed time', () => {
            const task = boardTask({ status: 'completed', totalTokens: 41_000, toolUses: 12, elapsedMs: 79_000 });
            const view = board([task], { state: 'done' });

            expect(renderTaskBoardEmbed(view, at(90)).fields[0].value).toBe('41k tokens · 12 tool calls · 1:19');
        });

        test('a single tool call is singular', () => {
            const task = boardTask({ status: 'completed', totalTokens: 41_000, toolUses: 1, elapsedMs: 79_000 });
            const view = board([task], { state: 'done' });

            expect(renderTaskBoardEmbed(view, at(90)).fields[0].value).toBe('41k tokens · 1 tool call · 1:19');
        });
    });

    describe('token formatting', () => {
        test.each([
            [0, '0'],
            [1, '<1k'],
            [999, '<1k'],
            [1000, '1k'],
            [1499, '1k'],
            [1500, '2k'],
            [118_000, '118k'],
            [999_400, '999k'],
            [999_500, '1.0M'],
            [1_240_000, '1.2M'],
        ])('%d tokens renders as %s', (totalTokens, expected) => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ totalTokens })]), at(4));

            expect(rendered.fields[0].value).toBe(`Starting up · ${expected} tokens · 0:04`);
        });
    });

    describe('duration formatting', () => {
        test.each([
            [-5000, '0:00'],
            [0, '0:00'],
            [4000, '0:04'],
            [9000, '0:09'],
            [59_999, '0:59'],
            [60_000, '1:00'],
            [3_599_000, '59:59'],
            [3_600_000, '1:00:00'],
            [3_661_000, '1:01:01'],
            [45_296_000, '12:34:56'],
        ])('%d ms renders as %s', (elapsedMs, expected) => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ elapsedMs })]), at(4));

            expect(rendered.fields[0].value).toBe(`Starting up · 0 tokens · ${expected}`);
        });
    });

    describe('workflow values', () => {
        function workflowBoard(agents: BoardWorkflowAgentInput[], overrides: Partial<TaskBoardTask> = {}, phases = REVIEW_PHASES): TaskBoardView {
            const done = agents.filter(entry => entry.state === 'done').length;
            const task = boardTask({
                kind:     'workflow',
                workflow: { phases, agents, meterFraction: agents.length === 0 ? 0 : done / agents.length },
                ...overrides,
            });
            return board([task], overrides.status === undefined || overrides.status === 'running' ? {} : { state: 'done' });
        }

        test('no agents seen: empty meter, zero phases done, Starting plus the first phase', () => {
            const rendered = renderTaskBoardEmbed(workflowBoard([]), at(4));

            expect(rendered.fields[0].value).toBe('▱▱▱▱▱▱▱▱▱▱ 0 / 2 phases\nStarting · Review');
        });

        test('no agents and no phases: Starting alone', () => {
            const rendered = renderTaskBoardEmbed(workflowBoard([], {}, []), at(4));

            expect(rendered.fields[0].value).toBe('▱▱▱▱▱▱▱▱▱▱ 0 / 0 phases\nStarting');
        });

        test('a running agent with no task summary omits the ↳ line', () => {
            const agents = [agent({ index: 0, label: 'verify:bot.ts', phaseIndex: 0 })];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents), at(4));

            expect(rendered.fields[0].value).toBe('▱▱▱▱▱▱▱▱▱▱ 0 / 2 phases · 0 / 1 agents finished\nReview running · 0 tokens so far');
        });

        test('a task summary with no running agent omits the ↳ line', () => {
            const agents = [agent({ index: 0, state: 'done', phaseIndex: 0 })];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents, { summary: 'Wrapping up' }), at(4));

            expect(rendered.fields[0].value).toBe('▰▰▰▰▰▰▰▰▰▰ 2 / 2 phases · 1 / 1 agents finished\nReview ✓ · Verify ✓ · 0 tokens so far');
        });

        test('the ↳ line names the most recently announced running agent', () => {
            const agents = [
                agent({ index: 0, label: 'first', phaseIndex: 1 }),
                agent({ index: 1, label: 'second', phaseIndex: 1 }),
                agent({ index: 2, label: 'third', phaseIndex: 1 }),
            ];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents, { summary: 'Still going' }), at(4));

            expect(rendered.fields[0].value.split('\n')[2]).toBe('↳ third · Still going');
        });

        test('the running phase is the lowest phase index still running', () => {
            const agents = [
                agent({ index: 0, label: 'late', phaseIndex: 1 }),
                agent({ index: 1, label: 'early', phaseIndex: 0 }),
            ];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents), at(4));

            expect(rendered.fields[0].value.split('\n')[1]).toBe('Review running · 0 tokens so far');
        });

        test('a phase index beyond the declared phases is clamped to the phase count', () => {
            const agents = [agent({ index: 0, label: 'stray', phaseIndex: 5 })];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents), at(4));

            expect(rendered.fields[0].value.split('\n')[0]).toBe('▱▱▱▱▱▱▱▱▱▱ 2 / 2 phases · 0 / 1 agents finished');
            expect(rendered.fields[0].value.split('\n')[1]).toBe('Review ✓ · Verify ✓ · 0 tokens so far');
        });

        test('a finished workflow collapses to one line with the agent count', () => {
            const agents = [
                agent({ index: 0, state: 'done', phaseIndex: 0 }),
                agent({ index: 1, state: 'done', phaseIndex: 1 }),
            ];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents, {
                status: 'completed', totalTokens: 203_000, elapsedMs: 161_000,
            }), at(170));

            expect(rendered.fields[0].value).toBe('▰▰▰▰▰▰▰▰▰▰ 2 / 2 phases · 2 agents · 203k tokens · 2:41');
        });

        test('a finished workflow with a single agent is singular', () => {
            const agents = [agent({ index: 0, state: 'done', phaseIndex: 0 })];
            const rendered = renderTaskBoardEmbed(workflowBoard(agents, { status: 'completed', elapsedMs: 1000 }), at(170));

            expect(rendered.fields[0].value).toBe('▰▰▰▰▰▰▰▰▰▰ 2 / 2 phases · 1 agent · 0 tokens · 0:01');
        });
    });

    describe('meter', () => {
        test.each([
            [-0.5, '▱▱▱▱▱▱▱▱▱▱'],
            [0, '▱▱▱▱▱▱▱▱▱▱'],
            [0.05, '▱▱▱▱▱▱▱▱▱▱'],
            [0.1, '▰▱▱▱▱▱▱▱▱▱'],
            [0.6, '▰▰▰▰▰▰▱▱▱▱'],
            [0.99, '▰▰▰▰▰▰▰▰▰▱'],
            [1, '▰▰▰▰▰▰▰▰▰▰'],
            [1.5, '▰▰▰▰▰▰▰▰▰▰'],
        ])('fraction %d fills the meter as %s', (meterFraction, expected) => {
            const task = boardTask({ kind: 'workflow', workflow: { phases: [], agents: [], meterFraction } });
            const rendered = renderTaskBoardEmbed(board([task]), at(4));

            expect(rendered.fields[0].value.split('\n')[0]).toBe(`${expected} 0 / 0 phases`);
        });
    });

    describe('footer', () => {
        test('a running board promises updates and stamps now', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask()]), at(4));

            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM');
        });

        test('a settled board stamps its finish', () => {
            const view = board([boardTask({ status: 'completed' })], { state: 'done', finishedAt: at(161) });

            expect(renderTaskBoardEmbed(view, at(400)).footer).toBe('Finished 8:39:24 PM');
        });

        test('a settled board with no finishedAt stamps now', () => {
            const view = board([boardTask({ status: 'completed' })], { state: 'done' });

            expect(renderTaskBoardEmbed(view, at(4)).footer).toBe('Finished 8:36:47 PM');
        });

        // `tests/setup.ts` replaces `Intl.DateTimeFormat` with a fixed-offset stub, so Los Angeles
        // is UTC-8 here all year; the real zone database applies in production.
        test('the clock is rendered in the requested time zone', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask()]), at(4), { timeZone: 'America/Los_Angeles' });

            expect(rendered.footer).toBe('Updates every few seconds · Last update 12:36:47 PM');
        });

        test('midnight UTC renders as 12:00:00 AM', () => {
            const view = board([boardTask()], { startedAt: new Date('2026-09-10T00:00:00.000Z') });
            const rendered = renderTaskBoardEmbed(view, new Date('2026-09-10T00:00:00.000Z'));

            expect(rendered.footer).toBe('Updates every few seconds · Last update 12:00:00 AM');
        });
    });

    describe('discord limits', () => {
        function manyTasks(count: number, finishedCount: number): TaskBoardTask[] {
            return Array.from({ length: count }, (_unused, index) => boardTask({
                id:          `t${index}`,
                description: `task ${index}`,
                status:      index < finishedCount ? 'completed' : 'running',
                ...(index < finishedCount ? { finishedAt: at(index) } : {}),
            }));
        }

        test('25 tasks fit without a more marker', () => {
            const rendered = renderTaskBoardEmbed(board(manyTasks(25, 0)), at(4));

            expect(rendered.fields).toHaveLength(25);
            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM');
        });

        test('the oldest finished task is dropped first and counted in the footer', () => {
            const rendered = renderTaskBoardEmbed(board(manyTasks(26, 3)), at(4));

            expect(rendered.fields).toHaveLength(25);
            expect(rendered.fields.map(field => field.name)).not.toContain('✅ task 0');
            expect(rendered.fields[0].name).toBe('✅ task 1');
            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM · +1 more');
        });

        // The finished row sits *after* several running ones, so dropping "the oldest" and
        // dropping "the oldest finished" pick different rows.
        test('a finished task is dropped ahead of older running ones', () => {
            const tasks = manyTasks(26, 0).map((task, index) => (index === 10
                ? boardTask({ ...task, status: 'completed', finishedAt: at(index) })
                : task));

            const rendered = renderTaskBoardEmbed(board(tasks), at(4));

            expect(rendered.fields).toHaveLength(25);
            expect(rendered.fields.map(field => field.name)).not.toContain('✅ task 10');
            expect(rendered.fields[0].name).toBe('🔬 task 0');
            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM · +1 more');
        });

        test('with no finished task the oldest running one is dropped', () => {
            const rendered = renderTaskBoardEmbed(board(manyTasks(26, 0)), at(4));

            expect(rendered.fields).toHaveLength(25);
            expect(rendered.fields[0].name).toBe('🔬 task 1');
            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM · +1 more');
        });

        test('finished tasks go first, then the oldest running ones', () => {
            const rendered = renderTaskBoardEmbed(board(manyTasks(30, 2)), at(4));

            expect(rendered.fields).toHaveLength(25);
            expect(rendered.fields[0].name).toBe('🔬 task 5');
            expect(rendered.footer).toBe('Updates every few seconds · Last update 8:36:47 PM · +5 more');
        });

        test('the more marker also lands on a settled board footer', () => {
            const view = board(manyTasks(26, 26), { state: 'done', finishedAt: at(161) });
            const rendered = renderTaskBoardEmbed(view, at(400));

            expect(rendered.footer).toBe('Finished 8:39:24 PM · +1 more');
        });

        test('a value longer than 1024 characters is truncated with an ellipsis', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ summary: 'S'.repeat(1200) })]), at(4));

            expect(rendered.fields[0].value).toHaveLength(1024);
            expect(rendered.fields[0].value.endsWith('…')).toBe(true);
            expect(rendered.fields[0].value.startsWith('SSS')).toBe(true);
        });

        test('a value of exactly 1024 characters is kept whole', () => {
            const summary = 'S'.repeat(1024 - ' · 0 tokens · 0:04'.length);
            const rendered = renderTaskBoardEmbed(board([boardTask({ summary })]), at(4));

            expect(rendered.fields[0].value).toHaveLength(1024);
            expect(rendered.fields[0].value.endsWith('0:04')).toBe(true);
        });

        test('the whole embed is held under 6000 characters, truncating the last values first', () => {
            const tasks = Array.from({ length: 7 }, (_unused, index) => boardTask({
                id:      `t${index}`,
                summary: 'S'.repeat(1200),
            }));
            const rendered = renderTaskBoardEmbed(board(tasks), at(4));

            const total = rendered.title.length + rendered.footer.length
              + rendered.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
            expect(total).toBeLessThanOrEqual(6000);
            expect(rendered.fields[0].value).toHaveLength(1024);
            expect(rendered.fields[6].value.endsWith('…')).toBe(true);
            expect(rendered.fields[6].value.length).toBeLessThan(1024);
        });

        test('a field name longer than 256 characters is truncated with an ellipsis', () => {
            const rendered = renderTaskBoardEmbed(board([boardTask({ label: 'L'.repeat(400) })]), at(4));

            expect(rendered.fields[0].name).toHaveLength(256);
            expect(rendered.fields[0].name.endsWith('…')).toBe(true);
            expect(rendered.fields[0].name.startsWith('🔬 LLL')).toBe(true);
        });

        test('a field name of exactly 256 characters is kept whole', () => {
            const label = 'L'.repeat(256 - '🔬  · do a thing'.length);
            const rendered = renderTaskBoardEmbed(board([boardTask({ label })]), at(4));

            expect(rendered.fields[0].name).toHaveLength(256);
            expect(rendered.fields[0].name.endsWith('do a thing')).toBe(true);
        });

        test('an overflow larger than the last value empties it and eats into the one before', () => {
            const tasks = Array.from({ length: 7 }, (_unused, index) => boardTask({
                id:      `t${index}`,
                summary: 'S'.repeat(1200),
            }));

            const rendered = renderTaskBoardEmbed(board(tasks), at(4));

            expect(rendered.fields[6].value).toBe('…');
            expect(rendered.fields[5].value.endsWith('…')).toBe(true);
            expect(rendered.fields[5].value.length).toBeLessThan(1024);
            expect(rendered.fields[4].value).toHaveLength(1024);
        });

        // Names are capped at 256 apiece, so 25 of them alone can still overrun the 6000 budget.
        test('an overflow larger than every value leaves each value as an ellipsis', () => {
            const tasks = Array.from({ length: 25 }, (_unused, index) => boardTask({
                id:    `t${index}`,
                label: 'L'.repeat(300),
            }));

            const rendered = renderTaskBoardEmbed(board(tasks), at(4));

            expect(rendered.fields.map(field => field.value)).toEqual(Array.from({ length: 25 }, () => '…'));
        });
    });

    test('rendering is a pure function of view, now and options', () => {
        const view = board([boardTask({ label: 'opus-high', summary: 'Reading files', totalTokens: 12_400 })]);

        expect(renderTaskBoardEmbed(view, at(4))).toEqual(renderTaskBoardEmbed(view, at(4)));
    });
});
