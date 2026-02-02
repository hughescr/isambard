/**
 * Channel Registry Error Classes
 *
 * Hierarchical error classes for channel registry operations.
 * All errors extend ChannelRegistryError which provides error codes for programmatic handling.
 */

import type { WellKnownChannel } from './types';

/**
 * Base error class for all channel registry errors
 */
export class ChannelRegistryError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'ChannelRegistryError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when a channel lookup fails by name
 */
export class ChannelNotFoundError extends ChannelRegistryError {
    constructor(public readonly channelName: string) {
        super(`Channel not found: ${channelName}`, 'CHANNEL_NOT_FOUND');
        this.name = 'ChannelNotFoundError';
    }
}

/**
 * Error thrown when multiple channels match a name
 */
export class AmbiguousChannelError extends ChannelRegistryError {
    constructor(
        public readonly channelName: string,
        public readonly matchCount: number
    ) {
        super(`Ambiguous channel name '${channelName}': found ${matchCount} matches`, 'AMBIGUOUS_CHANNEL');
        this.name = 'AmbiguousChannelError';
    }
}

/**
 * Error thrown when a well-known channel is required but doesn't exist
 */
export class WellKnownChannelNotFoundError extends ChannelRegistryError {
    constructor(public readonly channelType: WellKnownChannel) {
        super(`Required well-known channel not found: ${channelType}`, 'WELL_KNOWN_CHANNEL_NOT_FOUND');
        this.name = 'WellKnownChannelNotFoundError';
    }
}
