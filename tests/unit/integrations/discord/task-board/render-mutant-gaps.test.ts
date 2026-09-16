import { describe, expect, test } from 'bun:test';
import { renderTaskBoardEmbed } from '@/integrations/discord/task-board/render';
import type { BoardWorkflowAgentInput, TaskBoardTask, TaskBoardView } from '@/integrations/discord/task-board/types';

const NOW = new Date('2026-09-09T20:36:43.000Z');

function renderTokens(totalTokens: number): string {
    const task: TaskBoardTask = {
        id:          'task', kind:        'subagent', description: 'work', status:      'running', startedAt:   NOW,
        elapsedMs:   0, totalTokens, toolUses:    0,
    };
    const view: TaskBoardView = {
        key: 'channel:turn', channelId: 'channel', turnId: 'turn', tasks: [task], state: 'running', startedAt: NOW,
    };
    return renderTaskBoardEmbed(view, NOW).fields[0].value;
}

function workflowTask(phases: { index: number, title: string }[], agents: BoardWorkflowAgentInput[]): TaskBoardTask {
    return {
        id:          'workflow', kind:        'workflow', description: 'work', status:      'running', startedAt:   NOW,
        elapsedMs:   0, totalTokens: 0, toolUses:    0,
        workflow:    { phases, agents, meterFraction: 0 },
    };
}

describe('task board renderer mutation boundaries', () => {
    test.each([
        [1_049_999, '1.0M'],
        [1_050_000, '1.1M'],
    ])('rounds %d tokens against an exact million', (tokens, formatted) => {
        expect(renderTokens(tokens)).toBe(`Starting up · ${formatted} tokens · 0:00`);
    });

    test('uses the complete 6000-character Discord budget before clipping', () => {
        const tasks = Array.from({ length: 7 }, (_unused, index): TaskBoardTask => ({
            id:          `task-${index}`, kind:        'subagent', description: 'work', status:      'running', startedAt:   NOW,
            elapsedMs:   0, totalTokens: 0, toolUses:    0, summary:     'S'.repeat(1200),
        }));
        const view: TaskBoardView = {
            key: 'channel:turn', channelId: 'channel', turnId: 'turn', tasks, state: 'running', startedAt: NOW,
        };

        const rendered = renderTaskBoardEmbed(view, NOW);
        const total = rendered.title.length + rendered.footer.length
          + rendered.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
        expect(total).toBe(6000);
    });

    test('renders completed fractional phase indexes accepted by the ledger parser', () => {
        const task = workflowTask(
            [{ index: 0.25, title: 'Quarter' }, { index: 0.75, title: 'Later' }],
            [{ index: 0, label: 'runner', phaseIndex: 0.5, state: 'running', tokens: 0, toolCalls: 0 }]
        );

        expect(renderTaskBoardEmbed({
            key: 'channel:turn', channelId: 'channel', turnId: 'turn', tasks: [task], state: 'running', startedAt: NOW,
        }, NOW).fields[0].value).toContain('Quarter ✓ · 0 tokens so far');
    });

    test('does not invent a running phase when finite negative indexes have all settled', () => {
        const task = workflowTask(
            [{ index: -1, title: 'Sentinel' }, { index: 0, title: 'First' }],
            [{ index: 0, label: 'done', phaseIndex: 0, state: 'done', tokens: 0, toolCalls: 0 }]
        );

        expect(renderTaskBoardEmbed({
            key: 'channel:turn', channelId: 'channel', turnId: 'turn', tasks: [task], state: 'running', startedAt: NOW,
        }, NOW).fields[0].value).not.toContain('Sentinel running');
    });
});
