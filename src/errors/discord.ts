/**
 * Discord Error Classes
 *
 * Hierarchical error classes for Discord integration, presence, channel registry,
 * message history, and state management operations.
 * All errors extend DiscordError which extends IsambardError.
 */

import { ErrorCode } from './codes';
import { IsambardError } from './base';
import type { OperationalMode } from '@/integrations/discord/state/types';
import type { WellKnownChannel } from '@/integrations/discord/channel-registry/types';

// ============================================================================
// Base Discord Error
// ============================================================================

/**
 * Base error class for all Discord integration errors.
 */
export class DiscordError extends IsambardError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.DISCORD_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'DiscordError';
    }
}

// ============================================================================
// Core Discord Errors
// ============================================================================

/**
 * Error thrown when the Discord bot token is invalid or expired.
 */
export class InvalidTokenError extends DiscordError {
    constructor() {
        super('Discord bot token is invalid or expired', ErrorCode.INVALID_TOKEN);
        this.name = 'InvalidTokenError';
    }
}

/**
 * Error thrown when the bot lacks required permissions for an action.
 */
export class PermissionError extends DiscordError {
    declare public readonly context: { action: string };

    constructor(action: string) {
        super(`Bot lacks permission to ${action}`, ErrorCode.PERMISSION_DENIED, { action });
        this.name = 'PermissionError';
    }
}

/**
 * Error thrown when a Discord channel cannot be found by ID.
 */
export class ChannelNotFoundByIdError extends DiscordError {
    declare public readonly context: { channelId: string };

    constructor(channelId: string) {
        super(`Discord channel not found: ${channelId}`, ErrorCode.CHANNEL_NOT_FOUND_BY_ID, { channelId });
        this.name = 'ChannelNotFoundByIdError';
    }
}

/**
 * Error thrown when a Discord channel cannot be accessed.
 * This can happen when the channel doesn't exist or the bot lacks permissions.
 */
export class ChannelNotAccessibleError extends DiscordError {
    declare public readonly context: { channelId: string };

    constructor(channelId: string) {
        super(`Discord channel not accessible: ${channelId}`, ErrorCode.CHANNEL_NOT_ACCESSIBLE, { channelId });
        this.name = 'ChannelNotAccessibleError';
    }
}

/**
 * Error thrown when Discord API rate limits are exceeded.
 */
export class RateLimitError extends DiscordError {
    declare public readonly context: { retryAfter: number };

    constructor(retryAfter: number) {
        super(
            `Discord rate limit exceeded. Retry after ${retryAfter}ms`,
            ErrorCode.RATE_LIMIT_EXCEEDED,
            { retryAfter }
        );
        this.name = 'RateLimitError';
    }
}

// ============================================================================
// Message History Errors
// ============================================================================

/**
 * Error thrown when message fetching fails.
 * Wraps generic errors during Discord API message fetch operations.
 */
export class MessageFetchError extends DiscordError {
    declare public readonly context: { channelId: string, reason: string };

    constructor(channelId: string, reason: string) {
        super(
            `Failed to fetch messages from channel ${channelId}: ${reason}`,
            ErrorCode.MESSAGE_FETCH_ERROR,
            { channelId, reason }
        );
        this.name = 'MessageFetchError';
    }
}

/**
 * Error thrown when a Discord snowflake ID is invalid.
 */
export class InvalidSnowflakeError extends DiscordError {
    declare public readonly context: { snowflake: string };

    constructor(snowflake: string) {
        super(`Invalid Discord snowflake: ${snowflake}`, ErrorCode.INVALID_SNOWFLAKE, { snowflake });
        this.name = 'InvalidSnowflakeError';
    }
}

// ============================================================================
// Channel Registry Errors
// ============================================================================

/**
 * Base error class for all channel registry errors.
 */
export class ChannelRegistryError extends DiscordError {
    constructor(
        message: string,
        code: ErrorCode = ErrorCode.CHANNEL_REGISTRY_ERROR,
        context?: Record<string, unknown>
    ) {
        super(message, code, context);
        this.name = 'ChannelRegistryError';
    }
}

/**
 * Error thrown when a channel lookup fails by name.
 */
export class ChannelNotFoundByNameError extends ChannelRegistryError {
    declare public readonly context: { channelName: string };

    constructor(channelName: string) {
        super(`Channel not found: ${channelName}`, ErrorCode.CHANNEL_NOT_FOUND_BY_NAME, { channelName });
        this.name = 'ChannelNotFoundByNameError';
    }
}

/**
 * Error thrown when multiple channels match a name.
 */
export class AmbiguousChannelError extends ChannelRegistryError {
    declare public readonly context: { channelName: string, matchCount: number };

    constructor(channelName: string, matchCount: number) {
        super(
            `Ambiguous channel name '${channelName}': found ${matchCount} matches`,
            ErrorCode.AMBIGUOUS_CHANNEL,
            { channelName, matchCount }
        );
        this.name = 'AmbiguousChannelError';
    }
}

/**
 * Error thrown when a well-known channel is required but doesn't exist.
 */
export class WellKnownChannelNotFoundError extends ChannelRegistryError {
    declare public readonly context: { channelType: WellKnownChannel };

    constructor(channelType: WellKnownChannel) {
        super(
            `Required well-known channel not found: ${channelType}`,
            ErrorCode.WELL_KNOWN_CHANNEL_NOT_FOUND,
            { channelType }
        );
        this.name = 'WellKnownChannelNotFoundError';
    }
}

// ============================================================================
// Presence Errors
// ============================================================================

/**
 * Base error class for presence-related errors.
 * Extends the Discord error hierarchy.
 */
export class PresenceError extends DiscordError {
    constructor(message: string, code: ErrorCode = ErrorCode.PRESENCE_ERROR, cause?: unknown) {
        super(message, code);
        this.name = 'PresenceError';
        this.cause = cause;
    }
}

/**
 * Error thrown when status text generation fails.
 * This includes failures from the AI status generator (Haiku).
 */
export class StatusGenerationError extends PresenceError {
    constructor(message: string, cause?: unknown) {
        super(message, ErrorCode.STATUS_GENERATION_ERROR, cause);
        this.name = 'StatusGenerationError';
    }
}

// ============================================================================
// State Errors
// ============================================================================

/**
 * Error thrown when an invalid state transition is attempted.
 */
export class TransitionError extends DiscordError {
    declare public readonly context: { fromMode: OperationalMode, toMode: OperationalMode };

    constructor(fromMode: OperationalMode, toMode: OperationalMode, message?: string) {
        super(
            message ?? `Invalid transition from ${fromMode} to ${toMode}`,
            ErrorCode.TRANSITION_ERROR,
            { fromMode, toMode }
        );
        this.name = 'TransitionError';
    }
}
