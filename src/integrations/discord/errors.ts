/**
 * Discord Integration Error Classes
 *
 * Hierarchical error classes for Discord integration operations.
 * All errors extend DiscordIntegrationError which provides error codes for programmatic handling.
 */

/**
 * Base error class for all Discord integration errors
 */
export class DiscordIntegrationError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'DiscordIntegrationError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when the Discord bot token is invalid or expired
 */
export class InvalidTokenError extends DiscordIntegrationError {
    constructor() {
        super('Discord bot token is invalid or expired', 'INVALID_TOKEN');
        this.name = 'InvalidTokenError';
    }
}

/**
 * Error thrown when the bot lacks required permissions for an action
 */
export class PermissionError extends DiscordIntegrationError {
    constructor(public readonly action: string) {
        super(`Bot lacks permission to ${action}`, 'PERMISSION_DENIED');
        this.name = 'PermissionError';
    }
}

/**
 * Error thrown when a Discord channel cannot be found
 */
export class ChannelNotFoundError extends DiscordIntegrationError {
    constructor(public readonly channelId: string) {
        super(`Discord channel not found: ${channelId}`, 'CHANNEL_NOT_FOUND');
        this.name = 'ChannelNotFoundError';
    }
}

/**
 * Error thrown when Discord API rate limits are exceeded
 */
export class RateLimitError extends DiscordIntegrationError {
    constructor(public readonly retryAfter: number) {
        super(`Discord rate limit exceeded. Retry after ${retryAfter}ms`, 'RATE_LIMIT_EXCEEDED');
        this.name = 'RateLimitError';
    }
}
