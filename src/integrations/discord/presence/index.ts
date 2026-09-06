/**
 * Discord Presence System
 *
 * Public exports for managing Discord bot presence/status updates.
 * The presence system automatically updates bot status based on agent activity.
 */

export {
    type PresencePhase,
    type PresenceDisplayMode,
    type SynopsisContext,
    type CatchUpSynopsisContext,
    type StatusUpdate,
    ToolStatusMap,
    ToolDescriptions,
    getToolDescription,
    PresenceConfigSchema,
    type PresenceConfig
} from './types.js';

export {
    PresenceError,
    StatusGenerationError
} from '@/errors';

export { createActiveStatusGenerator } from './status-generator-active.js';
export { createDynamicStatusGenerator, resetCooldownState } from './status-generator-dynamic.js';
export { createIdleStatusGenerator, type IdleStatusGeneratorDeps, type IdleStatusOptions } from './status-generator-idle.js';
export { PresenceManager, type PresenceManagerDeps } from './manager.js';
export {
    buildLedgerThinkingSynopsis,
    buildThinkingSynopsis,
    createLedgerStreamEventHandler,
    createStreamEventHandler,
    type CreateLedgerStreamEventHandlerDeps,
    type LedgerSink,
    type LedgerStreamEventHandler,
    type StreamEventHandler
} from './stream-event-handler.js';

// P11: presence composed from the conversation and perch ledgers
export {
    composePresence,
    renderPresenceText,
    renderPrefixedText,
    createPresenceThrottle,
    planPresenceUpdate,
    type PresenceRole,
    type PresenceView,
    type PresenceThrottle,
    type PresencePlan,
    type RenderedPrefixedText
} from './presence-view.js';
