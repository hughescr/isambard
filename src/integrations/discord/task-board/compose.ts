/**
 * Board composition: turns the session ledgers' task lists into one {@link TaskBoardView} per
 * board — the tasks a single turn launched in a single channel.
 *
 * Pure over its inputs and the injected `now`: no clock, no I/O, no LLM. A task with no
 * `channelId` or no `turnId` (a perch launch, or one made outside a turn) has nowhere to post, so
 * it produces no board at all.
 *
 * @module integrations/discord/task-board/compose
 */
import type {
    BoardLedgerInput,
    BoardTaskInput,
    BoardWorkflowInput,
    TaskBoardState,
    TaskBoardTask,
    TaskBoardView,
    TaskBoardWorkflow
} from './types.js';

/** Tasks accumulated under one board key, before they are ordered and derived. */
interface BoardGroup {
    readonly key:       string
    readonly channelId: string
    readonly turnId:    string
    readonly tasks:     BoardTaskInput[]
}

/** Launch order: `startedAt` first, then id so simultaneous launches have one stable order. */
function compareTasks(a: BoardTaskInput, b: BoardTaskInput): number {
    const byStart = a.startedAt.getTime() - b.startedAt.getTime();
    if(byStart !== 0) {
        return byStart;
    }
    return a.id.localeCompare(b.id);
}

/** Boards are listed oldest first, then by key so two boards opened together have one order. */
function compareBoards(a: TaskBoardView, b: TaskBoardView): number {
    const byStart = a.startedAt.getTime() - b.startedAt.getTime();
    if(byStart !== 0) {
        return byStart;
    }
    return a.key.localeCompare(b.key);
}

/** Files one task under its `${channelId}:${turnId}` key, dropping tasks that have no board. */
function addTask(groups: Map<string, BoardGroup>, task: BoardTaskInput): void {
    const { channelId, turnId } = task;
    if(channelId === undefined || turnId === undefined) {
        return;
    }

    const key = `${channelId}:${turnId}`;
    const group = groups.get(key);
    if(group === undefined) {
        groups.set(key, { key, channelId, turnId, tasks: [task] });
        return;
    }
    group.tasks.push(task);
}

/** Carries a workflow's phases and agents through, with the meter fraction the renderer draws. */
function composeWorkflow(workflow: BoardWorkflowInput | undefined): TaskBoardWorkflow | undefined {
    if(workflow === undefined) {
        return undefined;
    }

    const done = workflow.agents.filter(agent => agent.state === 'done').length;
    return {
        phases:        workflow.phases,
        agents:        workflow.agents,
        meterFraction: workflow.agents.length === 0 ? 0 : done / workflow.agents.length,
    };
}

/** One board row: the ledger's task, plus elapsed time measured against `now` while it runs. */
function composeTask(task: BoardTaskInput, now: Date): TaskBoardTask {
    return {
        id:          task.id,
        kind:        task.kind,
        label:       task.label,
        description: task.description,
        status:      task.status,
        startedAt:   task.startedAt,
        finishedAt:  task.finishedAt,
        elapsedMs:   (task.finishedAt ?? now).getTime() - task.startedAt.getTime(),
        summary:     task.progress?.summary,
        totalTokens: task.progress?.totalTokens ?? 0,
        toolUses:    task.progress?.toolUses ?? 0,
        workflow:    composeWorkflow(task.workflow),
    };
}

/** A board runs until every task settles, and only then reports a failure. */
function boardState(running: boolean, failed: boolean): TaskBoardState {
    if(running) {
        return 'running';
    }
    if(failed) {
        return 'failed';
    }
    return 'done';
}

/**
 * Derives one board from its tasks. A board stays `'running'` until every task has settled — a
 * failure alongside still-running work does not end the board — and only then reads `'failed'`
 * (any task failed or stopped) or `'done'`.
 */
function composeBoard(group: BoardGroup, now: Date): TaskBoardView {
    const ordered = group.tasks.toSorted(compareTasks);

    const running = ordered.some(task => task.status === 'running');
    const failed = ordered.some(task => task.status === 'failed' || task.status === 'stopped');
    const state: TaskBoardState = boardState(running, failed);

    const finishes = ordered.flatMap(task => (task.finishedAt === undefined ? [] : [task.finishedAt.getTime()]));
    const finishedAt = running || finishes.length === 0 ? undefined : new Date(Math.max(...finishes));

    return {
        key:       group.key,
        channelId: group.channelId,
        turnId:    group.turnId,
        tasks:     ordered.map(task => composeTask(task, now)),
        state,
        startedAt: new Date(Math.min(...ordered.map(task => task.startedAt.getTime()))),
        finishedAt,
    };
}

/**
 * Composes one {@link TaskBoardView} per `${channelId}:${turnId}` over every ledger's running and
 * finished tasks, oldest board first. Tasks keep their launch order within a board and are never
 * reshuffled as they finish.
 */
export function composeTaskBoards(ledgers: readonly BoardLedgerInput[], now: Date): TaskBoardView[] {
    const groups = new Map<string, BoardGroup>();
    for(const ledger of ledgers) {
        for(const task of [...ledger.tasks, ...ledger.finishedTasks]) {
            addTask(groups, task);
        }
    }

    return [...groups.values()]
        .map(group => composeBoard(group, now))
        .toSorted(compareBoards);
}
