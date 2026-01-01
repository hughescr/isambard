/**
 * Discord Presence System
 *
 * Public exports for managing Discord bot presence/status updates.
 * The presence system automatically updates bot status based on agent activity.
 */

export * from './types.js';
export * from './errors.js';
export { createActiveStatusGenerator } from './status-generator-active.js';
export { createDynamicStatusGenerator, resetDebounceState } from './status-generator-dynamic.js';
export { createIdleStatusGenerator } from './status-generator-idle.js';
export { createPresenceManager, type PresenceManager } from './manager.js';
export { createStatusMiddleware } from './middleware.js';
