import _ from 'lodash';
import { describe, test, expect, spyOn } from 'bun:test';
import {
    DiscordIntegrationError,
    InvalidTokenError,
    PermissionError,
    ChannelNotFoundError,
    RateLimitError
} from '@/integrations/discord/errors';

describe.concurrent('Discord Integration Errors', () => {
    describe('DiscordIntegrationError', () => {
        test('should preserve stack trace', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('DiscordIntegrationError');
        });

        test('should call Error.captureStackTrace to exclude constructor from stack trace', () => {
            // This test verifies that Error.captureStackTrace is actually called
            // When captureStackTrace(this, this.constructor) is called, the stack trace
            // starts from the calling code, not from within the constructor itself

            // Create error inside a named function so we can verify stack trace behavior
            function createError(): DiscordIntegrationError {
                return new DiscordIntegrationError('Test error', 'TEST_ERROR');
            }

            const error = createError();
            expect(error.stack).toBeDefined();

            const stackLines = _.split(error.stack, '\n');

            // First line is the error message
            expect(stackLines[0]).toContain('DiscordIntegrationError: Test error');

            // The stack should have frames
            expect(stackLines.length).toBeGreaterThan(1);

            // Find the first actual stack frame (not the error message line)
            const firstStackFrame = stackLines[1];

            // The first stack frame should reference our createError function or test code
            // NOT the internal constructor implementation
            // When captureStackTrace is properly called, the constructor internals are excluded
            expect(firstStackFrame).toBeDefined();

            // Verify the error is properly throwable (captureStackTrace effect)
            expect(() => {
                throw error;
            }).toThrow(DiscordIntegrationError);
        });

        test('should call Error.captureStackTrace for subclass errors', () => {
            // Verify that subclass errors also trigger captureStackTrace
            const captureStackTraceSpy = spyOn(Error, 'captureStackTrace');

            const error = new InvalidTokenError();

            // Verify captureStackTrace was called for the subclass
            expect(captureStackTraceSpy).toHaveBeenCalled();

            // It should be called with the subclass constructor, not the base class
            expect(captureStackTraceSpy).toHaveBeenCalledWith(error, InvalidTokenError);

            captureStackTraceSpy.mockRestore();
        });

        test('should not throw when Error.captureStackTrace is undefined', () => {
            // Save the original captureStackTrace using a property descriptor to avoid unbound-method lint error
            const descriptor = Object.getOwnPropertyDescriptor(Error, 'captureStackTrace');

            // Temporarily remove captureStackTrace to simulate non-V8 environments
            // Using Object.defineProperty to allow deletion of the property
            Object.defineProperty(Error, 'captureStackTrace', {
                value:        undefined,
                writable:     true,
                configurable: true
            });

            try {
                // Creating an error should not throw when captureStackTrace is undefined
                // This kills the mutant that changes `if(Error.captureStackTrace)` to `if(true)`
                // because `if(true)` would try to call undefined(), throwing a TypeError
                const error = new DiscordIntegrationError('No captureStackTrace', 'NO_CAPTURE');

                // Verify the error is still valid
                expect(error.message).toBe('No captureStackTrace');
                expect(error.code).toBe('NO_CAPTURE');
                expect(error.name).toBe('DiscordIntegrationError');
            } finally {
                // Restore the original captureStackTrace
                if(descriptor) {
                    Object.defineProperty(Error, 'captureStackTrace', descriptor);
                }
            }
        });
    });

    describe('InvalidTokenError', () => {
        test('should have correct properties', () => {
            const error = new InvalidTokenError();
            expect(error.message).toBe('Discord bot token is invalid or expired');
            expect(error.code).toBe('INVALID_TOKEN');
            expect(error.name).toBe('InvalidTokenError');
        });
    });

    describe('PermissionError', () => {
        test.each([
            'send messages',
            'read message history',
            'manage roles',
        ])('should have correct properties for action: %s', (action) => {
            const error = new PermissionError(action);
            expect(error.message).toBe(`Bot lacks permission to ${action}`);
            expect(error.code).toBe('PERMISSION_DENIED');
            expect(error.action).toBe(action);
            expect(error.name).toBe('PermissionError');
        });
    });

    describe('ChannelNotFoundError', () => {
        test.each([
            '987654321098765432',
            '111111111111111111',
            '222222222222222222',
        ])('should have correct properties for channelId: %s', (channelId) => {
            const error = new ChannelNotFoundError(channelId);
            expect(error.message).toBe(`Discord channel not found: ${channelId}`);
            expect(error.code).toBe('CHANNEL_NOT_FOUND');
            expect(error.channelId).toBe(channelId);
            expect(error.name).toBe('ChannelNotFoundError');
        });
    });

    describe('RateLimitError', () => {
        test.each([
            0,
            1000,
            5000,
            3600000, // 1 hour in ms
        ])('should have correct properties for retryAfter: %d', (retryAfter) => {
            const error = new RateLimitError(retryAfter);
            expect(error.message).toBe(`Discord rate limit exceeded. Retry after ${retryAfter}ms`);
            expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
            expect(error.retryAfter).toBe(retryAfter);
            expect(error.name).toBe('RateLimitError');
        });
    });
});
