/**
 * Catch-up session management module.
 *
 * Manages Discord bot catch-up sessions, including running agent catch-up,
 * handling interruptions, and tracking completion.
 */

export { buildCatchUpPrompt, buildCatchUpResumedPrompt } from './prompts';
export type { CatchUpResumedOptions } from './prompts';
export type {
    CatchUpSessionRunner,
    CatchUpSessionRunnerDeps,
    CatchUpCompletionSignal,
    CatchUpInProgressSignal,
    RunAgentSessionOptions,
    AgentSessionResult,
    InterruptingMessage
} from './session-runner';
export { createCatchUpSessionRunner } from './session-runner';
