/**
 * Task board: a live-edited Discord embed showing the sub-agents, workflows and background shell
 * commands one turn launched in one channel.
 *
 * This barrel is the Discord manager's whole view of the package — composition, rendering, the
 * view type it holds between ticks, the rendered shape it maps onto an `EmbedBuilder`, the ledger
 * shape it feeds in, and the three stripe colours.
 *
 * @module integrations/discord/task-board
 */
export { composeTaskBoards } from './compose.js';
export { TaskBoardManager } from './manager.js';
export type { TaskBoardLogger, TaskBoardManagerDeps } from './manager.js';
export { setupTaskBoard } from './setup.js';
export type { SetupTaskBoardParams, TaskBoardSetupResult } from './setup.js';
export {
    renderTaskBoardEmbed,
    BOARD_COLOR_RUNNING,
    BOARD_COLOR_DONE,
    BOARD_COLOR_FAILED
} from './render.js';
export type {
    BoardLedgerInput,
    RenderedEmbed,
    TaskBoardView
} from './types.js';
