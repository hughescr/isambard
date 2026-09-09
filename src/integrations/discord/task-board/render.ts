/**
 * Task board rendering: turns one {@link TaskBoardView} into the plain object the Discord layer
 * maps onto an `EmbedBuilder`.
 *
 * Every export here is a pure function of `(view, now, options)` — no clock, no locale defaults,
 * no I/O — so the manager can compare two rendered embeds and skip an edit when nothing changed.
 * Text follows the approved mockup
 * (https://claude.ai/code/artifact/a37143aa-57d5-4dc2-b9b2-180a99993f79) and `docs/plans/task-board.md`.
 *
 * @module integrations/discord/task-board/render
 */
import { DateTime } from 'luxon';
import type {
    BoardTaskKind,
    RenderedEmbed,
    RenderedEmbedField,
    RenderTaskBoardOptions,
    TaskBoardState,
    TaskBoardTask,
    TaskBoardView,
    TaskBoardWorkflow
} from './types.js';

/** Embed stripe while any task is still running. */
export const BOARD_COLOR_RUNNING = 0x4E_8F_E6;
/** Embed stripe once every task finished cleanly. */
export const BOARD_COLOR_DONE = 0x3B_A5_5C;
/** Embed stripe once everything settled and something failed or was stopped. */
export const BOARD_COLOR_FAILED = 0xDA_37_3C;

const BOARD_COLORS: Record<TaskBoardState, number> = {
    running: BOARD_COLOR_RUNNING,
    done:    BOARD_COLOR_DONE,
    failed:  BOARD_COLOR_FAILED,
};

/**
 * Emoji per task kind. The first three are the same table presence renders its counts from —
 * `TASK_KIND_EMOJI` in `src/integrations/discord/presence/presence-view.ts`, kept in step by hand
 * — plus the two kinds presence deliberately never shows: shell commands and anything unrecognised.
 */
const KIND_EMOJI: Record<BoardTaskKind, string> = {
    subagent: '🔬',
    workflow: '🪾',
    monitor:  '⌚',
    shell:    '🐚',
    other:    '🔧',
};

const COMPLETED_EMOJI = '✅';
const FAILED_EMOJI = '❌';

/** Joins segments within a title, a field name, or a field value line. */
const SEPARATOR = ' · ';

/** The progress meter is always ten cells wide, whatever the workflow's size. */
const METER_CELLS = 10;
const METER_FILLED = '▰';
const METER_EMPTY = '▱';

/** Task descriptions are cut to this many characters (ellipsis included) in a field name. */
const DESCRIPTION_MAX = 60;

/** Discord's embed limits. */
const MAX_FIELDS = 25;
const MAX_NAME_CHARS = 256;
const MAX_VALUE_CHARS = 1024;
const MAX_TOTAL_CHARS = 6000;

const ELLIPSIS = '…';

/** Footer clock zone used when the caller does not supply one. */
const DEFAULT_TIME_ZONE = 'UTC';

/** Cuts `text` to at most `max` characters, marking a cut with an ellipsis. */
function clip(text: string, max: number): string {
    if(text.length <= max) {
        return text;
    }
    return `${text.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
}

/** `1 agent` / `2 agents`. */
function plural(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

/** `m:ss`, or `h:mm:ss` once past an hour. Negative input reads as zero. */
function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if(hours > 0) {
        return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
    }
    return `${minutes}:${pad2(seconds)}`;
}

/** `0`, `<1k`, `118k`, `1.2M` — enough precision to watch a number move, never more. */
function formatTokens(tokens: number): string {
    if(tokens === 0) {
        return '0';
    }
    if(tokens < 1000) {
        return '<1k';
    }

    const thousands = Math.round(tokens / 1000);
    if(thousands < 1000) {
        return `${thousands}k`;
    }
    return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** `h:mm:ss AM/PM` in `timeZone` — Luxon, as everywhere else that renders a wall clock here. */
function formatClock(at: Date, timeZone: string): string {
    return DateTime.fromJSDate(at).setZone(timeZone).toFormat('h:mm:ss a');
}

/** Ten cells, `Math.floor(fraction * 10)` of them filled, saturating at both ends. */
function renderMeter(fraction: number): string {
    const filled = Math.max(0, Math.min(METER_CELLS, Math.floor(fraction * METER_CELLS)));
    return `${METER_FILLED.repeat(filled)}${METER_EMPTY.repeat(METER_CELLS - filled)}`;
}

/** What the renderer needs to know about a workflow's phases and agents, derived once. */
interface WorkflowSummary {
    readonly completedPhases: number
    readonly totalPhases:     number
    readonly agentsDone:      number
    readonly agentsSeen:      number
    readonly completedTitles: readonly string[]
    readonly firstPhase?:     string
    readonly runningPhase?:   string
    readonly runningAgent?:   string
}

/**
 * Derives phase progress from the agents: the running phase is the lowest phase index with an
 * agent still running, and every phase before it counts as complete. With no agent running, a
 * workflow that has seen agents at all is treated as through all of its phases. A phase index
 * beyond the declared phases (a malformed frame) clamps to the phase count.
 */
function summariseWorkflow(workflow: TaskBoardWorkflow): WorkflowSummary {
    const runningAgents = workflow.agents.filter(agent => agent.state === 'running');
    const runningPhaseIndex = runningAgents.length === 0
        ? undefined
        : Math.min(...runningAgents.map(agent => agent.phaseIndex));

    const totalPhases = workflow.phases.length;
    const reachedPhase = runningPhaseIndex ?? (workflow.agents.length === 0 ? 0 : totalPhases);
    const completedPhases = Math.min(reachedPhase, totalPhases);

    return {
        completedPhases,
        totalPhases,
        agentsDone:      workflow.agents.filter(agent => agent.state === 'done').length,
        agentsSeen:      workflow.agents.length,
        completedTitles: workflow.phases.filter(phase => phase.index < completedPhases).map(phase => phase.title),
        firstPhase:      workflow.phases.at(0)?.title,
        runningPhase:    workflow.phases.find(phase => phase.index === runningPhaseIndex)?.title,
        runningAgent:    runningAgents.at(-1)?.label,
    };
}

/** Second line of a running workflow: where the run has got to, and its token spend so far. */
function renderPhaseLine(summary: WorkflowSummary, totalTokens: number): string {
    if(summary.agentsSeen === 0) {
        return summary.firstPhase === undefined ? 'Starting' : `Starting${SEPARATOR}${summary.firstPhase}`;
    }

    const parts = summary.completedTitles.map(title => `${title} ✓`);
    if(summary.runningPhase !== undefined) {
        parts.push(`${summary.runningPhase} running`);
    }
    parts.push(`${formatTokens(totalTokens)} tokens so far`);
    return parts.join(SEPARATOR);
}

/** Meter, phase line, and — when there is both a running agent and a summary — the `↳` line. */
function renderRunningWorkflowValue(task: TaskBoardTask, workflow: TaskBoardWorkflow): string {
    const summary = summariseWorkflow(workflow);
    const agentCounts = summary.agentsSeen === 0
        ? ''
        : `${SEPARATOR}${summary.agentsDone} / ${summary.agentsSeen} agents finished`;

    const lines = [
        `${renderMeter(workflow.meterFraction)} ${summary.completedPhases} / ${summary.totalPhases} phases${agentCounts}`,
        renderPhaseLine(summary, task.totalTokens),
    ];
    if(summary.runningAgent !== undefined && task.summary !== undefined) {
        lines.push(`↳ ${summary.runningAgent}${SEPARATOR}${task.summary}`);
    }
    return lines.join('\n');
}

/** A settled workflow collapses to one line: meter, phases, agents, tokens, wall time. */
function renderFinishedWorkflowValue(task: TaskBoardTask, workflow: TaskBoardWorkflow): string {
    const summary = summariseWorkflow(workflow);
    return [
        `${renderMeter(workflow.meterFraction)} ${summary.completedPhases} / ${summary.totalPhases} phases`,
        plural(summary.agentsSeen, 'agent'),
        `${formatTokens(task.totalTokens)} tokens`,
        formatDuration(task.elapsedMs),
    ].join(SEPARATOR);
}

/** Sub-agents, shells and monitors: the SDK's own progress line while running, totals once done. */
function renderTaskValue(task: TaskBoardTask): string {
    if(task.status === 'running') {
        return [
            task.summary ?? 'Starting up',
            `${formatTokens(task.totalTokens)} tokens`,
            formatDuration(task.elapsedMs),
        ].join(SEPARATOR);
    }
    return [
        `${formatTokens(task.totalTokens)} tokens`,
        plural(task.toolUses, 'tool call'),
        formatDuration(task.elapsedMs),
    ].join(SEPARATOR);
}

function renderValue(task: TaskBoardTask): string {
    if(task.workflow === undefined) {
        return renderTaskValue(task);
    }
    return task.status === 'running'
        ? renderRunningWorkflowValue(task, task.workflow)
        : renderFinishedWorkflowValue(task, task.workflow);
}

/** Kind emoji while a task runs; ✅ or ❌ once it has settled. */
function renderTaskEmoji(task: TaskBoardTask): string {
    if(task.status === 'running') {
        return KIND_EMOJI[task.kind];
    }
    return task.status === 'completed' ? COMPLETED_EMOJI : FAILED_EMOJI;
}

/** Kind emoji while running, ✅/❌ once settled, then the label and the capped description. */
function renderName(task: TaskBoardTask): string {
    const emoji = renderTaskEmoji(task);
    const description = clip(task.description, DESCRIPTION_MAX);
    const segments: string[] = [];
    if(task.label !== undefined) {
        segments.push(task.label);
    }
    if(description.length > 0) {
        segments.push(description);
    }
    return segments.length === 0 ? emoji : `${emoji} ${segments.join(SEPARATOR)}`;
}

function renderTitle(view: TaskBoardView, now: Date): string {
    if(view.state === 'running') {
        const running = view.tasks.filter(task => task.status === 'running').length;
        const done = view.tasks.length - running;
        const doneSuffix = done === 0 ? '' : `, ${done} done`;
        return `⏳ Working in the background · ${running} running${doneSuffix}`;
    }

    const headline = view.state === 'failed' ? '❌ Background work stopped' : '✅ Background work finished';
    const elapsedMs = (view.finishedAt ?? now).getTime() - view.startedAt.getTime();
    return `${headline}${SEPARATOR}${plural(view.tasks.length, 'task')}${SEPARATOR}${formatDuration(elapsedMs)}`;
}

function renderFooter(view: TaskBoardView, now: Date, timeZone: string, droppedTasks: number): string {
    const stamp = view.state === 'running'
        ? `Updates every few seconds${SEPARATOR}Last update ${formatClock(now, timeZone)}`
        : `Finished ${formatClock(view.finishedAt ?? now, timeZone)}`;

    return droppedTasks === 0 ? stamp : `${stamp}${SEPARATOR}+${droppedTasks} more`;
}

/** Tasks that fit in the embed's 25 fields: the oldest finished rows go first, then the oldest. */
function limitFields(tasks: readonly TaskBoardTask[]): { kept: readonly TaskBoardTask[], dropped: number } {
    const dropCount = Math.max(0, tasks.length - MAX_FIELDS);
    const dropped = new Set<string>();
    for(const task of tasks) {
        if(dropped.size === dropCount) {
            break;
        }
        if(task.status !== 'running') {
            dropped.add(task.id);
        }
    }
    for(const task of tasks) {
        if(dropped.size === dropCount) {
            break;
        }
        dropped.add(task.id);
    }

    return { kept: tasks.filter(task => !dropped.has(task.id)), dropped: dropCount };
}

/**
 * Holds the whole embed under Discord's 6000-character budget by truncating values from the end,
 * so the newest rows lose detail before the oldest do. Names count towards the budget alongside
 * the values, the title and the footer, but are never themselves cut here (they are already capped
 * at {@link MAX_NAME_CHARS} apiece): a board whose names alone exceed the budget is beyond saving
 * and is left as short as truncating every value can make it.
 */
function enforceTotalLimit(title: string, footer: string, fields: readonly RenderedEmbedField[]): RenderedEmbedField[] {
    const total = title.length + footer.length
      + fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);

    const limited: RenderedEmbedField[] = [];
    let excess = total - MAX_TOTAL_CHARS;
    for(const field of fields.toReversed()) {
        const value = clip(field.value, field.value.length - excess);
        excess -= field.value.length - value.length;
        limited.unshift({ name: field.name, value });
    }
    return limited;
}

/**
 * Renders one board into `{ title, color, fields, footer }`, within Discord's embed limits.
 * Deterministic for a given `(view, now, options)`, so an unchanged board renders byte-identically
 * and the manager can skip the edit.
 */
export function renderTaskBoardEmbed(view: TaskBoardView, now: Date, options: RenderTaskBoardOptions = {}): RenderedEmbed {
    const { kept, dropped } = limitFields(view.tasks);
    const fields = kept.map(task => ({
        name:  clip(renderName(task), MAX_NAME_CHARS),
        value: clip(renderValue(task), MAX_VALUE_CHARS),
    }));

    const title = renderTitle(view, now);
    const footer = renderFooter(view, now, options.timeZone ?? DEFAULT_TIME_ZONE, dropped);

    return { title, color: BOARD_COLORS[view.state], fields: enforceTotalLimit(title, footer, fields), footer };
}
