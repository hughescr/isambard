/**
 * Catch-up state management module.
 *
 * Manages Discord bot catch-up mode state transitions and tracking.
 */

export type { CatchUpState } from './types';
export type { CatchUpStateManager } from './state-manager';
export { createCatchUpStateManager } from './state-manager';
export { buildCatchUpPrompt, buildCatchUpInterruptedPrompt } from './prompts';
export type { CatchUpInterruptedOptions } from './prompts';
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
