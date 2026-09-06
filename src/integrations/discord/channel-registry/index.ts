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

// Resolve
export { resolveChannelId } from './resolve';

// Response router
export { ENVELOPE_KIND_TO_CHANNEL, ResponseRouter } from './response-router';
export type { EnvelopeRoutingResult, RoutingResult } from './response-router';

// Discovery
export { discoverAllChannels, setupChannelEventHandlers } from './discovery';
