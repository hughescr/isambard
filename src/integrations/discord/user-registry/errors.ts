/**
 * User Registry Error Classes
 *
 * Hierarchical error classes for user registry operations.
 * All errors extend UserRegistryError which provides error codes for programmatic handling.
 */

import type { UserId } from '../types';

/**
 * Base error class for all user registry errors
 */
export class UserRegistryError extends Error {
    constructor(
        message: string,
        public readonly code: string
    ) {
        super(message);
        this.name = 'UserRegistryError';

        // Maintain proper stack trace for where our error was thrown (only available on V8)
        if(Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

/**
 * Error thrown when a user lookup fails by ID
 */
export class UserNotFoundError extends UserRegistryError {
    constructor(public readonly userId: UserId) {
        super(`User not found: ${userId}`, 'USER_NOT_FOUND');
        this.name = 'UserNotFoundError';
    }
}

/**
 * Error thrown when multiple users share a username
 */
export class AmbiguousUsernameError extends UserRegistryError {
    constructor(
        public readonly username: string,
        public readonly matchingUserIds: UserId[]
    ) {
        super(`Ambiguous username '${username}': found ${matchingUserIds.length} matching users`, 'AMBIGUOUS_USERNAME');
        this.name = 'AmbiguousUsernameError';
    }
}
