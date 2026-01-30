/**
 * Perch Time Module
 *
 * Autonomous "Perch Time" scheduling for time-based activities.
 * Izzy wakes up hourly (with jitter) to pursue time-appropriate exploration.
 *
 * @module agent/perch
 */

// Types
export {
    type PerchSlot,
    type SuggestionLevel,
    type PerchSlotConfig,
    type PerchTestModeConfig,
    type PerchConfig,
    type PerchSchedulerState,
    PerchSlotSchema,
    SuggestionLevelSchema,
    PerchSlotConfigSchema,
    PerchConfigSchema,
    PerchSchedulerStateSchema
} from './types';

// Schedule
export {
    SLOT_CONFIGS,
    getSlotForHour,
    getSlotConfig
} from './schedule';

// Prompts
export {
    BASE_PROMPT,
    buildPerchPrompt,
    buildTestPerchPrompt,
    getSuggestionLevelDescription
} from './prompts';

// Scheduler
export {
    type PerchSchedulerDeps,
    type PerchScheduler,
    createPerchScheduler
} from './scheduler';

// Session Runner
export {
    type RunAgentSessionOptions,
    type AgentSessionResult,
    type PerchSessionRunnerDeps,
    type PerchSessionRunner,
    createPerchSessionRunner
} from './session-runner';
