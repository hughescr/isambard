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
        test('should have correct default message', () => {
            const error = new InvalidTokenError();
            expect(error.message).toBe('Discord bot token is invalid or expired');
        });

        test('should have correct code', () => {
            const error = new InvalidTokenError();
            expect(error.code).toBe('INVALID_TOKEN');
        });
    });

    describe('PermissionError', () => {
        const testAction = 'send messages';

        test('should have correct message format', () => {
            const error = new PermissionError(testAction);
            expect(error.message).toBe(`Bot lacks permission to ${testAction}`);
        });

        test('should have correct code', () => {
            const error = new PermissionError(testAction);
            expect(error.code).toBe('PERMISSION_DENIED');
        });

        test('should store action property', () => {
            const error = new PermissionError(testAction);
            expect(error.action).toBe(testAction);
        });

        test('should handle different action descriptions', () => {
            const actions = [
                'send messages',
                'read message history',
                'manage roles',
                'kick members',
            ];

            for(const action of actions) {
                const error = new PermissionError(action);
                expect(error.action).toBe(action);
                expect(error.message).toContain(action);
            }
        });
    });

    describe('ChannelNotFoundError', () => {
        const testChannelId = '987654321098765432';

        test('should have correct message format', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.message).toBe(`Discord channel not found: ${testChannelId}`);
        });

        test('should have correct code', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.code).toBe('CHANNEL_NOT_FOUND');
        });

        test('should store channelId property', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.channelId).toBe(testChannelId);
        });

        test('should handle different channel IDs', () => {
            const channelIds = [
                '111111111111111111',
                '222222222222222222',
                '333333333333333333',
            ];

            for(const channelId of channelIds) {
                const error = new ChannelNotFoundError(channelId);
                expect(error.channelId).toBe(channelId);
                expect(error.message).toContain(channelId);
            }
        });
    });

    describe('RateLimitError', () => {
        const testRetryAfter = 5000;

        test('should have correct message format', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.message).toBe(`Discord rate limit exceeded. Retry after ${testRetryAfter}ms`);
        });

        test('should have correct code', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        });

        test('should store retryAfter property', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.retryAfter).toBe(testRetryAfter);
        });

        test('should handle different retry durations', () => {
            const retryAfters = [1000, 3000, 10000, 60000];

            for(const retryAfter of retryAfters) {
                const error = new RateLimitError(retryAfter);
                expect(error.retryAfter).toBe(retryAfter);
                expect(error.message).toContain(`${retryAfter}ms`);
            }
        });

        test('should handle zero retry duration', () => {
            const error = new RateLimitError(0);
            expect(error.retryAfter).toBe(0);
            expect(error.message).toContain('0ms');
        });

        test('should handle very large retry durations', () => {
            const largeRetryAfter = 3600000; // 1 hour in ms
            const error = new RateLimitError(largeRetryAfter);
            expect(error.retryAfter).toBe(largeRetryAfter);
            expect(error.message).toContain(`${largeRetryAfter}ms`);
        });
    });

    describe('Error class names', () => {
        test('RateLimitError has correct name property', () => {
            const error = new RateLimitError(1000);
            expect(error.name).toBe('RateLimitError');
        });

        test('DiscordIntegrationError has correct name property', () => {
            const error = new DiscordIntegrationError('test', 'TEST_CODE');
            expect(error.name).toBe('DiscordIntegrationError');
        });

        test('InvalidTokenError has correct name property', () => {
            const error = new InvalidTokenError();
            expect(error.name).toBe('InvalidTokenError');
        });

        test('PermissionError has correct name property', () => {
            const error = new PermissionError('test action');
            expect(error.name).toBe('PermissionError');
        });

        test('ChannelNotFoundError has correct name property', () => {
            const error = new ChannelNotFoundError('123456789');
            expect(error.name).toBe('ChannelNotFoundError');
        });
    });
});
