/**
 * Task board types: the ledger-shaped inputs {@link composeTaskBoards} reads, the view it
 * produces, and the plain object {@link renderTaskBoardEmbed} hands to the Discord layer.
 *
 * The input types are deliberately declared here rather than imported from
 * `src/agent/session/ledger.ts`: they are a structural *subset* of `Ledger` / `LedgerTask` (only
 * the fields the board reads, all `readonly`), so a real ledger is assignable to them without the
 * board package depending on the session module's shape. Anything the ledger adds later — tool use
 * ids, task types, the background flag — is simply ignored here.
 *
 * @module integrations/discord/task-board/types
 */

/** Task kinds the board can render; the same set as `LedgerTask['kind']`. */
export type BoardTaskKind = 'subagent' | 'workflow' | 'shell' | 'monitor' | 'other';

/** Task lifecycle, as the ledger records it. */
export type BoardTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** A board is running until every task settles, then failed if any task failed or was stopped. */
export type TaskBoardState = 'running' | 'done' | 'failed';

/** One declared workflow phase, as announced up front on the first `task_progress`. */
export interface BoardWorkflowPhaseInput {
    readonly index: number
    readonly title: string
}

/** One workflow agent. Unknown SDK states are normalised to `'running'` by the ledger. */
export interface BoardWorkflowAgentInput {
    readonly index:      number
    readonly label:      string
    readonly phaseIndex: number
    readonly state:      'running' | 'done' | 'error'
    readonly tokens:     number
    readonly toolCalls:  number
}

/** Workflow shape derived from `workflow_progress`; workflow tasks only. */
export interface BoardWorkflowInput {
    readonly phases: readonly BoardWorkflowPhaseInput[]
    readonly agents: readonly BoardWorkflowAgentInput[]
}

/** The latest `task_progress` payload for a task, when any has arrived. */
export interface BoardTaskProgressInput {
    readonly summary?:      string
    readonly lastToolName?: string
    readonly totalTokens?:  number
    readonly toolUses?:     number
    readonly durationMs?:   number
    readonly at:            Date
}

/** The subset of `LedgerTask` the board reads. */
export interface BoardTaskInput {
    readonly id:          string
    readonly kind:        BoardTaskKind
    readonly description: string
    /** `subagent_type` for sub-agents, `workflow_name` for workflows. */
    readonly label?:      string
    /** Channel of the turn open when the task started; a task without one gets no board. */
    readonly channelId?:  string
    /** Turn open at `task_started`; groups tasks into one board. */
    readonly turnId?:     string
    readonly startedAt:   Date
    readonly progress?:   BoardTaskProgressInput
    readonly workflow?:   BoardWorkflowInput
    readonly status:      BoardTaskStatus
    readonly finishedAt?: Date
}

/** The subset of `Ledger` the board reads. */
export interface BoardLedgerInput {
    readonly role:          string
    /** Running tasks. */
    readonly tasks:         readonly BoardTaskInput[]
    /** Settled tasks, most recent last, capped by the ledger. */
    readonly finishedTasks: readonly BoardTaskInput[]
}

/** A workflow task's progress, with the meter fraction the renderer draws. */
export interface TaskBoardWorkflow {
    readonly phases:        readonly BoardWorkflowPhaseInput[]
    readonly agents:        readonly BoardWorkflowAgentInput[]
    /** Agents done over agents seen; 0 when none has been seen yet. */
    readonly meterFraction: number
}

/** One row of a board: everything the renderer needs about a single task. */
export interface TaskBoardTask {
    readonly id:          string
    readonly kind:        BoardTaskKind
    readonly label?:      string
    readonly description: string
    readonly status:      BoardTaskStatus
    readonly startedAt:   Date
    readonly finishedAt?: Date
    /** `(finishedAt ?? now) - startedAt`. */
    readonly elapsedMs:   number
    readonly summary?:    string
    readonly totalTokens: number
    readonly toolUses:    number
    readonly workflow?:   TaskBoardWorkflow
}

/** One Discord message's worth of board: the tasks launched by a single turn in a single channel. */
export interface TaskBoardView {
    /** `${channelId}:${turnId}`. */
    readonly key:         string
    readonly channelId:   string
    readonly turnId:      string
    /** Launch order (`startedAt`, then id); never reordered. */
    readonly tasks:       readonly TaskBoardTask[]
    readonly state:       TaskBoardState
    /** The earliest task start on the board. */
    readonly startedAt:   Date
    /** The latest task finish, once no task is running. */
    readonly finishedAt?: Date
}

/** One embed field, as Discord's `EmbedBuilder.addFields` takes it. */
export interface RenderedEmbedField {
    name:  string
    value: string
}

/** The plain object the Discord layer maps onto an `EmbedBuilder`. */
export interface RenderedEmbed {
    title:  string
    color:  number
    fields: RenderedEmbedField[]
    footer: string
}

/** Rendering knobs the wiring layer supplies from config. */
export interface RenderTaskBoardOptions {
    /** IANA zone for the footer clock; defaults to `'UTC'`. */
    readonly timeZone?: string
}
