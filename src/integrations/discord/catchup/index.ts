/**
 * Catch-up session management module.
 *
 * Manages Discord bot catch-up sessions, including running agent catch-up,
 * handling interruptions, and tracking completion.
 */

export type {
    CatchUpSessionRunner,
    CatchUpCompletionSignal,
    CatchUpInProgressSignal
} from './session-runner';
export { createCatchUpSessionRunner } from './session-runner';
