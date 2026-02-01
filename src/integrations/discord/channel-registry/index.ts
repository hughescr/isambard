/**
 * Channel Registry Module
 *
 * Provides dynamic channel management for Discord bot:
 * - Channel discovery and tracking
 * - Custom muting system
 * - Name resolution (#channel-name format)
 * - Response routing by session type
 */

// Types
export {
    wellKnownChannelSchema,
    channelMetadataSchema,
    channelReferenceSchema,
    WELL_KNOWN_CHANNELS,
    createChannelMetadata,
    isChannelMetadata
} from './types';
export type { WellKnownChannel, ChannelMetadata, ChannelReference } from './types';

// Errors
export {
    ChannelRegistryError,
    ChannelNotFoundError,
    AmbiguousChannelError,
    WellKnownChannelMissingError,
    ChannelMutedError
} from './errors';

// Key generator
export { ChannelRegistryKeyGenerator } from './key-generator';
export type { ChannelRegistryKeys } from './key-generator';

// Backend
export { ChannelRegistryBackend } from './backend';

// Manager
export { ChannelRegistryManager } from './manager';
export type { ChannelRegistryManagerConfig } from './manager';

// Name resolver
export { normalizeChannelName, formatChannelReference, ChannelNameResolver } from './name-resolver';

// DM tracker
export { formatDMChannelName, extractUsernameFromDM, isDMChannelName, DMTracker } from './dm-tracker';

// Sentinel
export { NO_RESPONSE_SENTINEL, hasSentinel, stripSentinel, processResponse } from './sentinel';

// Response router
export { ResponseRouter } from './response-router';
export type { SessionType, RoutingResult, ResponseRouterConfig } from './response-router';

// Discovery
export { discoverAllChannels, setupChannelEventHandlers } from './discovery';
export type { DiscoveryResult } from './discovery';
