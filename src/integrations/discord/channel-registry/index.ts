/**
 * Channel Registry Module
 *
 * Provides dynamic channel management for Discord bot:
 * - Channel discovery and tracking
 * - Custom muting system
 * - Name resolution (#channel-name format)
 * - Response routing by session type
 */

// Errors
export {
    WellKnownChannelNotFoundError
} from '@/errors';

// Backend
export { ChannelRegistryBackend } from './backend';

// Manager
export { ChannelRegistryManager } from './manager';

// DM tracker
export { DMTracker } from './dm-tracker';
export type { ResolvedUser, UserResolveResult } from './dm-tracker';

// Resolve
export { resolveChannelId } from './resolve';

// Response router
export { ResponseRouter } from './response-router';
export type { RoutingResult } from './response-router';

// Discovery
export { discoverAllChannels, setupChannelEventHandlers } from './discovery';
