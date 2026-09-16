/**
 * Board composition: turns the session ledgers' task lists into one {@link TaskBoardView} per
 * board — the tasks a single turn launched in a single channel.
 *
 * Pure over its inputs and the injected `now`: no clock, no I/O, no LLM. A task with no `turnId`
 * (one made outside a turn) has nowhere to post and produces no board. A task with a turn but no
 * `channelId` — launched from a turn the SDK started on its own, such as a bare `notification`
 * turn or a background-work wake whose launch record was never found — posts to the caller's
 * fallback channel for its ledger role (the same rule wake delivery applies to such a turn's
 * reply), and is dropped when that role has no fallback.
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

/** Options the wiring layer supplies to {@link composeTaskBoards}. */
export interface ComposeTaskBoardsOptions {
    /** Channel for a role's channel-less tasks, keyed by `BoardLedgerInput.role`; a role absent here drops them. */
    readonly fallbackChannelIds?: Readonly<Record<string, string | undefined>>
}

/** Files one task under its `${channelId}:${turnId}` key, dropping tasks that have no board. */
function addTask(groups: Map<string, BoardGroup>, task: BoardTaskInput, fallbackChannelId: string | undefined): void {
    const { turnId } = task;
    const channelId = task.channelId ?? fallbackChannelId;
    // Stryker disable next-line llm: channelId and turnId are each string | undefined (every source is ??/?.-guarded, never null), so loose and strict undefined checks coincide.
    if(channelId === undefined || turnId === undefined) {
        return;
    }

    const key = `${channelId}:${turnId}`;
    // Stryker disable next-line llm: Map.get already yields undefined for an absent key, key is a string, and every stored value is a truthy BoardGroup, so a has-guard, template key or || undefined fallback changes nothing.
    const group = groups.get(key);
    if(group === undefined) {
        // Stryker disable next-line llm: key is already a string, so key + '' is the same Map key.
        groups.set(key, { key, channelId, turnId, tasks: [task] });
        return;
    }
    // Stryker disable next-line llm: BoardGroup never escapes this module, so pushing onto its private task array and replacing the entry with a copied group compose identical boards.
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
        // Stryker disable next-line llm: equivalent — with no agents `done` is necessarily 0, so `0 / (0 || 1) === 0`; otherwise `agents.length || 1` is `agents.length`.
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
        // Stryker disable next-line llm: adding 0 to a getTime() number (NaN included) is the identity.
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

    // Stryker disable next-line llm: some(...) returning true implies ordered.length > 0, while false short-circuits an added && length check, so the extra condition is redundant.
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
 * reshuffled as they finish. A channel-less task takes `options.fallbackChannelIds[ledger.role]`
 * as its channel, so a turn's fallback board is a separate board from any channelled one.
 */
export function composeTaskBoards(ledgers: readonly BoardLedgerInput[], now: Date, options: ComposeTaskBoardsOptions = {}): TaskBoardView[] {
    const groups = new Map<string, BoardGroup>();
    for(const ledger of ledgers) {
        // Stryker disable next-line llm: fallbackChannelIds is a record object or undefined (never null or another falsy value), so && and ?. index to the same value.
        const fallbackChannelId = options.fallbackChannelIds?.[ledger.role];
        for(const task of [...ledger.tasks, ...ledger.finishedTasks]) {
            addTask(groups, task, fallbackChannelId);
        }
    }

    // Stryker disable next-line llm: array spread and Array.from consume the same Map values iterator into the same ordered array.
    const boards = [...groups.values()]
        .map(group => composeBoard(group, now));
    // Stryker disable next-line llm: compareBoards reads no `this`, so a null-bound comparator orders identically.
    return boards.toSorted(compareBoards);
}
