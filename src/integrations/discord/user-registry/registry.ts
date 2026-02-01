/**
 * User Registry
 *
 * Provides bidirectional username ↔ userId mapping for Discord users.
 * Supports lazy population from message events and handles username conflicts.
 */

import _ from 'lodash';
import type { UserId } from '../types';
import type { UserMetadata } from './types';
import { UserNotFoundError, AmbiguousUsernameError } from './errors';

/**
 * UserRegistry provides bidirectional lookup between usernames and Discord user IDs.
 *
 * Key features:
 * - Bidirectional mapping: username → userId(s) and userId → username
 * - Handles multiple users with the same username (Discord allows this)
 * - Lazy population from message events
 * - Metadata tracking (discovery time, last seen, etc.)
 *
 * Usage:
 * ```typescript
 * const registry = new UserRegistry();
 *
 * // Register users as they're discovered
 * registry.registerUser(userId, username, displayName);
 *
 * // Resolve username to userId (throws if ambiguous or not found)
 * const userId = registry.resolveUsername('john');
 *
 * // Look up username by userId
 * const username = registry.lookupUsername(userId);
 *
 * // Get all users with a specific username
 * const userIds = registry.getUsersWithUsername('john');
 * ```
 */
export class UserRegistry {
    /** Map from username to array of user IDs (multiple users can share username) */
    private usernameToIds = new Map<string, UserId[]>();

    /** Map from user ID to username */
    private idToUsername = new Map<UserId, string>();

    /** Map from user ID to full metadata */
    private metadata = new Map<UserId, UserMetadata>();

    /**
     * Registers or updates a user in the registry.
     *
     * If the user already exists and the username has changed,
     * the old username mapping is removed.
     *
     * @param userId - Discord user ID
     * @param username - Discord username
     * @param displayName - Discord display name or global name
     */
    registerUser(userId: UserId, username: string, displayName: string): void {
        const now = new Date().toISOString();
        const existingMetadata = this.metadata.get(userId);
        const oldUsername = this.idToUsername.get(userId);

        // If username changed, remove old mapping
        if(oldUsername && oldUsername !== username) {
            const oldUserIds = this.usernameToIds.get(oldUsername);
            if(oldUserIds) {
                const filtered = _.filter(oldUserIds, id => id !== userId);
                if(filtered.length === 0) {
                    this.usernameToIds.delete(oldUsername);
                } else {
                    this.usernameToIds.set(oldUsername, filtered);
                }
            }
        }

        // Update username → userId mapping
        if(!this.usernameToIds.has(username)) {
            this.usernameToIds.set(username, []);
        }
        const userIds = this.usernameToIds.get(username)!;
        if(!userIds.includes(userId)) {
            userIds.push(userId);
        }

        // Update userId → username mapping
        this.idToUsername.set(userId, username);

        // Update metadata
        this.metadata.set(userId, {
            userId,
            username,
            displayName,
            discoveredAt: existingMetadata?.discoveredAt ?? now,
            lastSeenAt:   now,
            updatedAt:    now,
        });
    }

    /**
     * Resolves a username to a user ID.
     *
     * @param username - The username to resolve
     * @returns The user ID
     * @throws {UserNotFoundError} If no user with this username exists
     * @throws {AmbiguousUsernameError} If multiple users share this username
     */
    resolveUsername(username: string): UserId {
        const userIds = this.usernameToIds.get(username);

        if(!userIds || userIds.length === 0) {
            throw new UserNotFoundError(username as UserId);
        }

        if(userIds.length > 1) {
            throw new AmbiguousUsernameError(username, userIds);
        }

        return userIds[0];
    }

    /**
     * Looks up the username for a given user ID.
     *
     * @param userId - The user ID to look up
     * @returns The username
     * @throws {UserNotFoundError} If the user ID is not registered
     */
    lookupUsername(userId: UserId): string {
        const username = this.idToUsername.get(userId);
        if(!username) {
            throw new UserNotFoundError(userId);
        }
        return username;
    }

    /**
     * Gets all user IDs that share a specific username.
     *
     * @param username - The username to search for
     * @returns Array of user IDs (may be empty)
     */
    getUsersWithUsername(username: string): UserId[] {
        return this.usernameToIds.get(username) ?? [];
    }

    /**
     * Gets the full metadata for a user.
     *
     * @param userId - The user ID
     * @returns The user metadata
     * @throws {UserNotFoundError} If the user is not registered
     */
    getUserMetadata(userId: UserId): UserMetadata {
        const meta = this.metadata.get(userId);
        if(!meta) {
            throw new UserNotFoundError(userId);
        }
        return meta;
    }

    /**
     * Checks if a user is registered.
     *
     * @param userId - The user ID to check
     * @returns True if the user is registered
     */
    hasUser(userId: UserId): boolean {
        return this.metadata.has(userId);
    }

    /**
     * Clears all registered users.
     * Useful for testing or reset scenarios.
     */
    clear(): void {
        this.usernameToIds.clear();
        this.idToUsername.clear();
        this.metadata.clear();
    }
}
