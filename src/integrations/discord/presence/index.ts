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
} from './errors.js';

export { createActiveStatusGenerator } from './status-generator-active.js';
export { createDynamicStatusGenerator, resetDebounceState } from './status-generator-dynamic.js';
export { createIdleStatusGenerator, type IdleStatusGeneratorDeps } from './status-generator-idle.js';
export { createPresenceManager, type PresenceManager } from './manager.js';
export { createStatusMiddleware } from './middleware.js';
export { createStreamEventHandler, type StreamEventHandler, type StreamEventHandlerDeps } from './stream-event-handler.js';
