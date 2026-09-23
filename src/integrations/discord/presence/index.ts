/**
 * Discord Presence System
 *
 * Public exports for managing Discord bot presence/status updates.
 * The presence system renders bot status from the session ledgers; the turn synopsis it shows is
 * produced by the session core (`src/agent/session/turn-synopsis.ts`), not here.
 */

export {
    type PresencePhase,
    type StatusUpdate,
    ToolStatusMap,
    PresenceConfigSchema,
    type PresenceConfig
} from './types.js';

export {
    PresenceError,
    StatusGenerationError
} from '@/errors';

export { createActiveStatusGenerator } from './status-generator-active.js';
export { createIdleStatusGenerator, type IdleStatusGeneratorDeps, type IdleStatusOptions } from './status-generator-idle.js';
export { PresenceManager, type PresenceManagerDeps } from './manager.js';

// P11: presence composed from the conversation and perch ledgers
export {
    composePresence,
    renderPresenceText,
    renderPrefixedText,
    createPresenceThrottle,
    planPresenceUpdate,
    type PresenceView,
    type PresenceThrottle,
    type PresencePlan,
    type RenderedPrefixedText
} from './presence-view.js';
