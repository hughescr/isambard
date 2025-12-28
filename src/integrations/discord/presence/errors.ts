/**
 * Error hierarchy for Discord presence management
 *
 * Provides structured error types for handling presence-related failures.
 */

import { DiscordIntegrationError } from '../errors.js';

/**
 * Base error class for presence-related errors.
 * Extends the Discord integration error hierarchy.
 */
export class PresenceError extends DiscordIntegrationError {
    constructor(message: string, code = 'PRESENCE_ERROR', cause?: unknown) {
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
        super(message, 'STATUS_GENERATION_ERROR', cause);
        this.name = 'StatusGenerationError';
    }
}
