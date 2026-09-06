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
    type PerchConfig
} from './types';

// Scheduler
export {
    type PerchScheduler,
    createPerchScheduler
} from './scheduler';

// Session Runner
export {
    type PerchSessionRunner,
    createPerchSessionRunner
} from './session-runner';

// Perch driver (conductor mode): owns slot-turn lifecycle, wrap-up/interrupt timers, overlap deferral
export {
    type PerchDriver,
    type PerchDriverDeps,
    type RunSlotOutcome,
    createPerchDriver
} from './perch-driver';

// computeSlotEndsAt: pure helper shared with anything else that needs a slot's endsAt
export { computeSlotEndsAt } from './envelope';
