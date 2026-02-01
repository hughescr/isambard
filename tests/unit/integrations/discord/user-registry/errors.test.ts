/**
 * User Registry Error Classes Tests
 *
 * Tests for hierarchical error classes for user registry operations.
 * Verifies error construction, messages, codes, and inheritance.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import {
    UserRegistryError,
    UserNotFoundError,
    AmbiguousUsernameError
} from '@/integrations/discord/user-registry/errors';
import type { UserId } from '@/integrations/discord/types';

describe('UserRegistryError', () => {
    it('should construct with message and code', () => {
        const error = new UserRegistryError('Test error', 'TEST_CODE');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(UserRegistryError);
        expect(error.message).toBe('Test error');
        expect(error.code).toBe('TEST_CODE');
        expect(error.name).toBe('UserRegistryError');
    });

    it('should capture stack trace', () => {
        const error = new UserRegistryError('Test error', 'TEST_CODE');
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('UserRegistryError');
    });
});

describe('UserNotFoundError', () => {
    it('should construct with user ID', () => {
        const userId = '123456789012345678' as UserId;
        const error = new UserNotFoundError(userId);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(UserRegistryError);
        expect(error).toBeInstanceOf(UserNotFoundError);
        expect(error.userId).toBe(userId);
        expect(error.message).toBe('User not found: 123456789012345678');
        expect(error.code).toBe('USER_NOT_FOUND');
        expect(error.name).toBe('UserNotFoundError');
    });

    it('should capture stack trace', () => {
        const userId = '123456789012345678' as UserId;
        const error = new UserNotFoundError(userId);
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('UserNotFoundError');
    });

    it('should work with different user IDs', () => {
        const userId = '987654321098765432' as UserId;
        const error = new UserNotFoundError(userId);
        expect(error.userId).toBe(userId);
        expect(error.message).toBe('User not found: 987654321098765432');
    });
});

describe('AmbiguousUsernameError', () => {
    it('should construct with username and matching user IDs', () => {
        const userIds = [
            '123456789012345678' as UserId,
            '234567890123456789' as UserId,
            '345678901234567890' as UserId
        ];
        const error = new AmbiguousUsernameError('john', userIds);
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(UserRegistryError);
        expect(error).toBeInstanceOf(AmbiguousUsernameError);
        expect(error.username).toBe('john');
        expect(error.matchingUserIds).toEqual(userIds);
        expect(error.message).toBe("Ambiguous username 'john': found 3 matching users");
        expect(error.code).toBe('AMBIGUOUS_USERNAME');
        expect(error.name).toBe('AmbiguousUsernameError');
    });

    it('should capture stack trace', () => {
        const userIds = ['123456789012345678' as UserId, '234567890123456789' as UserId];
        const error = new AmbiguousUsernameError('jane', userIds);
        expect(error.stack).toBeDefined();
        expect(error.stack).toContain('AmbiguousUsernameError');
    });

    it('should work with different match counts', () => {
        const userIds = ['123456789012345678' as UserId, '234567890123456789' as UserId];
        const error = new AmbiguousUsernameError('bob', userIds);
        expect(error.username).toBe('bob');
        expect(error.matchingUserIds).toEqual(userIds);
        expect(error.message).toBe("Ambiguous username 'bob': found 2 matching users");
    });

    it('should handle single match count correctly', () => {
        const userIds = ['123456789012345678' as UserId];
        const error = new AmbiguousUsernameError('alice', userIds);
        expect(error.message).toBe("Ambiguous username 'alice': found 1 matching users");
    });
});

describe('Error instanceof checks', () => {
    it('should correctly identify UserNotFoundError instance', () => {
        const error = new UserNotFoundError('123456789012345678' as UserId);
        expect(error instanceof UserRegistryError).toBe(true);
        expect(error instanceof UserNotFoundError).toBe(true);
        expect(error instanceof AmbiguousUsernameError).toBe(false);
    });

    it('should correctly identify AmbiguousUsernameError instance', () => {
        const error = new AmbiguousUsernameError('test', ['123456789012345678' as UserId]);
        expect(error instanceof UserRegistryError).toBe(true);
        expect(error instanceof AmbiguousUsernameError).toBe(true);
        expect(error instanceof UserNotFoundError).toBe(false);
    });
});

describe('Error.captureStackTrace handling', () => {
    it('should call Error.captureStackTrace when it exists', () => {
        // Track if captureStackTrace is actually called
        let captureWasCalled = false;
        let receivedTarget: Error | undefined;
        let receivedConstructor: (new (...args: never[]) => Error) | undefined;

        const spy = spyOn(Error, 'captureStackTrace').mockImplementation(
            (target: object, constructorOpt?: (new (...args: never[]) => object)) => {
                captureWasCalled = true;
                receivedTarget = target as Error;
                receivedConstructor = constructorOpt as (new (...args: never[]) => Error) | undefined;
            }
        );

        const error = new UserRegistryError('Test error', 'TEST_CODE');

        // Verify captureStackTrace was called (kills mutant that changes condition to false)
        expect(captureWasCalled).toBe(true);
        expect(receivedTarget).toBe(error);
        expect(receivedConstructor).toBe(UserRegistryError);

        spy.mockRestore();
    });

    it('should not throw when Error.captureStackTrace is undefined', () => {
        // Save the original captureStackTrace
        const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');

        // Temporarily remove captureStackTrace to simulate non-V8 environments
        Object.defineProperty(Error, 'captureStackTrace', {
            value:        undefined,
            writable:     true,
            configurable: true,
        });

        try {
            // Creating an error should not throw when captureStackTrace is undefined
            // This kills the mutant that changes `if(Error.captureStackTrace)` to `if(true)`
            // because `if(true)` would try to call undefined(), throwing a TypeError
            const error = new UserRegistryError('No captureStackTrace', 'NO_CAPTURE');

            // Verify the error is still valid
            expect(error.message).toBe('No captureStackTrace');
            expect(error.code).toBe('NO_CAPTURE');
            expect(error.name).toBe('UserRegistryError');
        } finally {
            // Restore the original captureStackTrace
            if(descriptor) {
                Object.defineProperty(Error, 'captureStackTrace', descriptor);
            }
        }
    });
});
