/**
 * User Registry Tests
 *
 * Tests for the UserRegistry class that provides bidirectional
 * username ↔ userId mapping.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { useFakeTimers } from 'sinon';
import { UserRegistry } from '@/integrations/discord/user-registry/registry';
import { UserNotFoundError, AmbiguousUsernameError } from '@/integrations/discord/user-registry/errors';
import type { UserId } from '@/integrations/discord/types';

describe('UserRegistry', () => {
    let registry: UserRegistry;

    beforeEach(() => {
        registry = new UserRegistry();
    });

    describe('registerUser', () => {
        it('should register a new user', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';
            const displayName = 'John Doe';

            registry.registerUser(userId, username, displayName);

            // Verify user was registered by looking up username
            const result = registry.lookupUsername(userId);
            expect(result).toBe(username);
        });

        it('should update existing user when re-registered', () => {
            const userId = '123456789012345678' as UserId;
            const oldUsername = 'john_old';
            const newUsername = 'john_new';
            const displayName = 'John Doe';

            registry.registerUser(userId, oldUsername, displayName);
            registry.registerUser(userId, newUsername, displayName);

            // Should return new username
            const result = registry.lookupUsername(userId);
            expect(result).toBe(newUsername);
        });

        it('should allow multiple users with the same username', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            // Both should be registered
            expect(registry.lookupUsername(userId1)).toBe(sharedUsername);
            expect(registry.lookupUsername(userId2)).toBe(sharedUsername);
        });

        it('should update metadata timestamps on re-registration', () => {
            const clock = useFakeTimers();
            try {
                const userId = '123456789012345678' as UserId;
                const username = 'john';
                const displayName = 'John Doe';

                // First registration
                registry.registerUser(userId, username, displayName);
                const metadata1 = registry.getUserMetadata(userId);

                // Advance time to ensure different timestamp
                clock.tick(1000);

                // Re-register
                registry.registerUser(userId, username, 'John Updated');
                const metadata2 = registry.getUserMetadata(userId);

                // updatedAt should be different, discoveredAt should be the same
                expect(metadata2.discoveredAt).toBe(metadata1.discoveredAt);
                expect(metadata2.updatedAt).not.toBe(metadata1.updatedAt);
            } finally {
                clock.restore();
            }
        });
    });

    describe('resolveUsername', () => {
        it('should resolve username to userId for unique match', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';

            registry.registerUser(userId, username, 'John Doe');

            const result = registry.resolveUsername(username);
            expect(result).toBe(userId);
        });

        it('should throw UserNotFoundError when username is not registered', () => {
            expect(() => registry.resolveUsername('nonexistent')).toThrow(UserNotFoundError);
        });

        it('should throw AmbiguousUsernameError when multiple users share username', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            expect(() => registry.resolveUsername(sharedUsername)).toThrow(AmbiguousUsernameError);
        });

        it('should include matching user IDs in AmbiguousUsernameError', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            try {
                registry.resolveUsername(sharedUsername);
                expect.unreachable('Should have thrown AmbiguousUsernameError');
            } catch (error) {
                expect(error).toBeInstanceOf(AmbiguousUsernameError);
                if(error instanceof AmbiguousUsernameError) {
                    expect(error.matchingUserIds).toHaveLength(2);
                    expect(error.matchingUserIds).toContain(userId1);
                    expect(error.matchingUserIds).toContain(userId2);
                }
            }
        });

        it('should be case-sensitive', () => {
            const userId = '123456789012345678' as UserId;
            registry.registerUser(userId, 'John', 'John Doe');

            expect(() => registry.resolveUsername('john')).toThrow(UserNotFoundError);
        });
    });

    describe('lookupUsername', () => {
        it('should return username for registered userId', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';

            registry.registerUser(userId, username, 'John Doe');

            const result = registry.lookupUsername(userId);
            expect(result).toBe(username);
        });

        it('should throw UserNotFoundError for unregistered userId', () => {
            const userId = '999999999999999999' as UserId;
            expect(() => registry.lookupUsername(userId)).toThrow(UserNotFoundError);
        });

        it('should return updated username after re-registration', () => {
            const userId = '123456789012345678' as UserId;

            registry.registerUser(userId, 'old_username', 'User');
            registry.registerUser(userId, 'new_username', 'User');

            const result = registry.lookupUsername(userId);
            expect(result).toBe('new_username');
        });
    });

    describe('getUsersWithUsername', () => {
        it('should return all user IDs matching a username', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const userId3 = '345678901234567890' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');
            registry.registerUser(userId3, sharedUsername, 'John Johnson');

            const result = registry.getUsersWithUsername(sharedUsername);
            expect(result).toHaveLength(3);
            expect(result).toContain(userId1);
            expect(result).toContain(userId2);
            expect(result).toContain(userId3);
        });

        it('should return empty array for non-existent username', () => {
            const result = registry.getUsersWithUsername('nonexistent');
            expect(result).toEqual([]);
        });

        it('should return single userId when only one match', () => {
            const userId = '123456789012345678' as UserId;
            registry.registerUser(userId, 'john', 'John Doe');

            const result = registry.getUsersWithUsername('john');
            expect(result).toEqual([userId]);
        });

        it('should be case-sensitive', () => {
            const userId = '123456789012345678' as UserId;
            registry.registerUser(userId, 'John', 'John Doe');

            const result = registry.getUsersWithUsername('john');
            expect(result).toEqual([]);
        });
    });

    describe('getUserMetadata', () => {
        it('should return metadata for registered user', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';
            const displayName = 'John Doe';

            registry.registerUser(userId, username, displayName);
            const metadata = registry.getUserMetadata(userId);

            expect(metadata.userId).toBe(userId);
            expect(metadata.username).toBe(username);
            expect(metadata.displayName).toBe(displayName);
            expect(metadata.discoveredAt).toBeDefined();
            expect(metadata.lastSeenAt).toBeDefined();
            expect(metadata.updatedAt).toBeDefined();
        });

        it('should throw UserNotFoundError for unregistered user', () => {
            const userId = '999999999999999999' as UserId;
            expect(() => registry.getUserMetadata(userId)).toThrow(UserNotFoundError);
        });

        it('should update lastSeenAt on repeated lookups', () => {
            const clock = useFakeTimers();
            try {
                const userId = '123456789012345678' as UserId;
                registry.registerUser(userId, 'john', 'John Doe');

                const metadata1 = registry.getUserMetadata(userId);

                // Advance time to ensure different timestamp
                clock.tick(1000);

                // Access metadata again to update lastSeenAt
                registry.registerUser(userId, 'john', 'John Doe');
                const metadata2 = registry.getUserMetadata(userId);

                expect(metadata2.lastSeenAt).not.toBe(metadata1.lastSeenAt);
            } finally {
                clock.restore();
            }
        });
    });

    describe('hasUser', () => {
        it('should return true for registered user', () => {
            const userId = '123456789012345678' as UserId;
            registry.registerUser(userId, 'john', 'John Doe');

            expect(registry.hasUser(userId)).toBe(true);
        });

        it('should return false for unregistered user', () => {
            const userId = '999999999999999999' as UserId;
            expect(registry.hasUser(userId)).toBe(false);
        });
    });

    describe('clear', () => {
        it('should remove all users', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;

            registry.registerUser(userId1, 'john', 'John Doe');
            registry.registerUser(userId2, 'jane', 'Jane Smith');

            registry.clear();

            expect(registry.hasUser(userId1)).toBe(false);
            expect(registry.hasUser(userId2)).toBe(false);
        });

        it('should allow re-registration after clear', () => {
            const userId = '123456789012345678' as UserId;

            registry.registerUser(userId, 'john', 'John Doe');
            registry.clear();
            registry.registerUser(userId, 'john', 'John Doe');

            expect(registry.hasUser(userId)).toBe(true);
        });
    });

    describe('edge cases', () => {
        it('should handle username changes correctly', () => {
            const userId = '123456789012345678' as UserId;

            registry.registerUser(userId, 'old_name', 'User');

            // Should find by old username
            expect(registry.resolveUsername('old_name')).toBe(userId);

            // Change username
            registry.registerUser(userId, 'new_name', 'User');

            // Should no longer find by old username
            expect(() => registry.resolveUsername('old_name')).toThrow(UserNotFoundError);

            // Should find by new username
            expect(registry.resolveUsername('new_name')).toBe(userId);
        });

        it('should handle removing user from shared username when username changes', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            // Should have 2 users with this username
            expect(registry.getUsersWithUsername(sharedUsername)).toHaveLength(2);

            // Change userId1's username
            registry.registerUser(userId1, 'different_name', 'John Doe');

            // Should now have only 1 user with shared username
            expect(registry.getUsersWithUsername(sharedUsername)).toEqual([userId2]);

            // Can now resolve unambiguously
            expect(registry.resolveUsername(sharedUsername)).toBe(userId2);
        });
    });

    describe('mutation killing tests', () => {
        // Kill mutant on line 65: ConditionalExpression -> true
        // Tests that we only remove old username mapping when username actually changed
        it('should NOT remove old username mapping when username stays the same', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';

            registry.registerUser(userId, username, 'John Doe');

            // Verify user is in the username mapping
            expect(registry.getUsersWithUsername(username)).toEqual([userId]);

            // Re-register with SAME username
            registry.registerUser(userId, username, 'John Updated');

            // User should STILL be in the username mapping (not removed and re-added)
            expect(registry.getUsersWithUsername(username)).toEqual([userId]);
            expect(registry.resolveUsername(username)).toBe(userId);
        });

        it('should ONLY remove old username mapping when username actually changed', () => {
            const userId = '123456789012345678' as UserId;
            const oldUsername = 'john_old';
            const newUsername = 'john_new';

            registry.registerUser(userId, oldUsername, 'John Doe');

            // Verify old username mapping exists
            expect(registry.getUsersWithUsername(oldUsername)).toEqual([userId]);

            // Change username
            registry.registerUser(userId, newUsername, 'John Updated');

            // Old username mapping should be gone
            expect(registry.getUsersWithUsername(oldUsername)).toEqual([]);
            // New username mapping should exist
            expect(registry.getUsersWithUsername(newUsername)).toEqual([userId]);
        });

        // Kill mutant on line 67: ConditionalExpression -> true
        // The mutant changes `if(oldUserIds)` to always true
        // This would crash if oldUserIds is undefined (trying to filter undefined)
        // While we can't create undefined oldUserIds via public API (defensive check),
        // we test that username changes work correctly in all scenarios
        it('should handle username changes when user was the last one with that username', () => {
            const userId = '123456789012345678' as UserId;

            // Register user
            registry.registerUser(userId, 'alice', 'Alice User');
            expect(registry.getUsersWithUsername('alice')).toEqual([userId]);

            // Change username - user was the ONLY one with "alice"
            // This path: oldUsername="alice", oldUserIds=["u1"], filtered=[], delete mapping
            registry.registerUser(userId, 'bob', 'Alice User');

            // Old username should be completely removed
            expect(registry.getUsersWithUsername('alice')).toEqual([]);
            expect(registry.getUsersWithUsername('bob')).toEqual([userId]);

            // Verify we can resolve by new username
            expect(registry.resolveUsername('bob')).toBe(userId);

            // Verify old username is gone
            expect(() => registry.resolveUsername('alice')).toThrow(UserNotFoundError);
        });

        it('should handle username changes when multiple users share the username', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;

            // Two users with same username
            registry.registerUser(userId1, 'alex', 'Alex One');
            registry.registerUser(userId2, 'alex', 'Alex Two');
            expect(registry.getUsersWithUsername('alex')).toEqual([userId1, userId2]);

            // First user changes username
            // This path: oldUsername="alex", oldUserIds=[u1,u2], filtered=[u2], update mapping
            registry.registerUser(userId1, 'alexander', 'Alex One');

            // "alex" should still exist but only have userId2
            expect(registry.getUsersWithUsername('alex')).toEqual([userId2]);
            expect(registry.getUsersWithUsername('alexander')).toEqual([userId1]);

            // Both usernames should resolve correctly
            expect(registry.resolveUsername('alex')).toBe(userId2);
            expect(registry.resolveUsername('alexander')).toBe(userId1);
        });

        it('should properly filter old username when multiple users share it and one changes', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            // Two users with same username
            registry.registerUser(userId1, sharedUsername, 'John Doe');
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            expect(registry.getUsersWithUsername(sharedUsername)).toHaveLength(2);

            // Change userId1's username - this exercises the filtering logic at line 68
            registry.registerUser(userId1, 'different_name', 'John Doe');

            // Only userId2 should remain with sharedUsername
            const remaining = registry.getUsersWithUsername(sharedUsername);
            expect(remaining).toEqual([userId2]);
            expect(remaining).not.toContain(userId1);
        });

        // Kill mutant on line 82: ConditionalExpression -> true
        // Tests that we only add userId if it's not already in the array
        it('should NOT add duplicate userId when re-registering with same username', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';

            registry.registerUser(userId, username, 'John Doe');

            // First registration - userId should be in array once
            expect(registry.getUsersWithUsername(username)).toEqual([userId]);

            // Re-register with same username
            registry.registerUser(userId, username, 'John Updated');

            // Should still only have ONE instance of userId, not duplicates
            const userIds = registry.getUsersWithUsername(username);
            expect(userIds).toEqual([userId]);
            expect(userIds).toHaveLength(1);
        });

        it('should add userId when registering new user with existing username', () => {
            const userId1 = '123456789012345678' as UserId;
            const userId2 = '234567890123456789' as UserId;
            const sharedUsername = 'john';

            registry.registerUser(userId1, sharedUsername, 'John Doe');

            // First user should be in the array
            expect(registry.getUsersWithUsername(sharedUsername)).toEqual([userId1]);

            // Register DIFFERENT user with same username - should ADD to array
            registry.registerUser(userId2, sharedUsername, 'John Smith');

            // Should have both users now
            const userIds = registry.getUsersWithUsername(sharedUsername);
            expect(userIds).toHaveLength(2);
            expect(userIds).toContain(userId1);
            expect(userIds).toContain(userId2);
        });

        // Kill mutant on line 111: ConditionalExpression -> false
        // The mutant changes `if(!userIds || userIds.length === 0)` to always false
        // This means it would SKIP the error throw and try to access userIds[0]
        // When userIds is undefined, this causes a crash trying to access property on undefined
        // Our test expects UserNotFoundError, but mutant would throw TypeError/crash
        it('should throw UserNotFoundError when username does not exist (userIds undefined)', () => {
            const username = 'nonexistent';

            // Resolving non-existent username makes userIds undefined
            // Original: throws UserNotFoundError
            // Mutant: skips check, crashes on line 115/119 accessing undefined.length or undefined[0]
            expect(() => registry.resolveUsername(username)).toThrow(UserNotFoundError);
        });

        it('should throw UserNotFoundError with correct message for missing username', () => {
            const username = 'nonexistent';

            // Be more explicit about expecting the specific error
            try {
                registry.resolveUsername(username);
                expect.unreachable('Should have thrown UserNotFoundError');
            } catch (error) {
                expect(error).toBeInstanceOf(UserNotFoundError);
                expect((error as UserNotFoundError).message).toContain(username);
            }
        });

        it('should successfully resolve when username mapping has exactly one user', () => {
            const userId = '123456789012345678' as UserId;
            const username = 'john';

            registry.registerUser(userId, username, 'John Doe');

            // This ensures userIds is NOT undefined and has length > 0
            const result = registry.resolveUsername(username);
            expect(result).toBe(userId);
        });
    });
});
