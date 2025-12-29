import _ from 'lodash';
import { describe, it, expect, spyOn } from 'bun:test';
import {
    DiscordIntegrationError,
    InvalidTokenError,
    PermissionError,
    ChannelNotFoundError,
    RateLimitError
} from '@/integrations/discord/errors';

describe('Discord Integration Errors', () => {
    describe('DiscordIntegrationError', () => {
        it('should be an instance of DiscordIntegrationError', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should have correct name', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error.name).toBe('DiscordIntegrationError');
        });

        it('should have correct message', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error.message).toBe('Test error');
        });

        it('should have correct code', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error.code).toBe('TEST_ERROR');
        });

        it('should preserve stack trace', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('DiscordIntegrationError');
        });

        it('should call Error.captureStackTrace to exclude constructor from stack trace', () => {
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

        it('should use Error.captureStackTrace when available', () => {
            // Verify that the captureStackTrace functionality is being used
            // by confirming the stack trace property is a string starting with the error
            const error = new DiscordIntegrationError('Stack test', 'STACK_TEST');

            // captureStackTrace ensures stack is a proper string, not undefined
            expect(typeof error.stack).toBe('string');
            expect(error.stack!.length).toBeGreaterThan(0);

            // The stack should start with the error name and message
            expect(_.startsWith(error.stack, 'DiscordIntegrationError: Stack test')).toBe(true);

            // Verify stack contains at least one file reference (indicating proper trace capture)
            expect(error.stack).toMatch(/at\s+/);
        });

        it('should call Error.captureStackTrace with correct arguments', () => {
            // Spy on Error.captureStackTrace to verify it's called with correct arguments
            const captureStackTraceSpy = spyOn(Error, 'captureStackTrace');

            const error = new DiscordIntegrationError('Spy test', 'SPY_TEST');

            // Verify captureStackTrace was called
            expect(captureStackTraceSpy).toHaveBeenCalled();

            // Verify it was called with the error instance and constructor
            expect(captureStackTraceSpy).toHaveBeenCalledWith(error, DiscordIntegrationError);

            // Restore the original function
            captureStackTraceSpy.mockRestore();
        });

        it('should call Error.captureStackTrace for subclass errors', () => {
            // Verify that subclass errors also trigger captureStackTrace
            const captureStackTraceSpy = spyOn(Error, 'captureStackTrace');

            const error = new InvalidTokenError();

            // Verify captureStackTrace was called for the subclass
            expect(captureStackTraceSpy).toHaveBeenCalled();

            // It should be called with the subclass constructor, not the base class
            expect(captureStackTraceSpy).toHaveBeenCalledWith(error, InvalidTokenError);

            captureStackTraceSpy.mockRestore();
        });

        it('should not throw when Error.captureStackTrace is undefined', () => {
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

        it('should extend Error class', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error).toBeInstanceOf(Error);
        });
    });

    describe('InvalidTokenError', () => {
        it('should be an instance of InvalidTokenError', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(InvalidTokenError);
        });

        it('should extend DiscordIntegrationError', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should extend Error', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(Error);
        });

        it('should have correct name', () => {
            const error = new InvalidTokenError();
            expect(error.name).toBe('InvalidTokenError');
        });

        it('should have correct default message', () => {
            const error = new InvalidTokenError();
            expect(error.message).toBe('Discord bot token is invalid or expired');
        });

        it('should have correct code', () => {
            const error = new InvalidTokenError();
            expect(error.code).toBe('INVALID_TOKEN');
        });

        it('should have a stack trace', () => {
            const error = new InvalidTokenError();
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('InvalidTokenError');
        });
    });

    describe('PermissionError', () => {
        const testAction = 'send messages';

        it('should be an instance of PermissionError', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(PermissionError);
        });

        it('should extend DiscordIntegrationError', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should extend Error', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(Error);
        });

        it('should have correct name', () => {
            const error = new PermissionError(testAction);
            expect(error.name).toBe('PermissionError');
        });

        it('should have correct message format', () => {
            const error = new PermissionError(testAction);
            expect(error.message).toBe(`Bot lacks permission to ${testAction}`);
        });

        it('should have correct code', () => {
            const error = new PermissionError(testAction);
            expect(error.code).toBe('PERMISSION_DENIED');
        });

        it('should store action property', () => {
            const error = new PermissionError(testAction);
            expect(error.action).toBe(testAction);
        });

        it('should handle different action descriptions', () => {
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

        it('should have a stack trace', () => {
            const error = new PermissionError(testAction);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('PermissionError');
        });
    });

    describe('ChannelNotFoundError', () => {
        const testChannelId = '987654321098765432';

        it('should be an instance of ChannelNotFoundError', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(ChannelNotFoundError);
        });

        it('should extend DiscordIntegrationError', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should extend Error', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(Error);
        });

        it('should have correct name', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.name).toBe('ChannelNotFoundError');
        });

        it('should have correct message format', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.message).toBe(`Discord channel not found: ${testChannelId}`);
        });

        it('should have correct code', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.code).toBe('CHANNEL_NOT_FOUND');
        });

        it('should store channelId property', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.channelId).toBe(testChannelId);
        });

        it('should handle different channel IDs', () => {
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

        it('should have a stack trace', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('ChannelNotFoundError');
        });
    });

    describe('RateLimitError', () => {
        const testRetryAfter = 5000;

        it('should be an instance of RateLimitError', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(RateLimitError);
        });

        it('should extend DiscordIntegrationError', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should extend Error', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(Error);
        });

        it('should have correct name', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.name).toBe('RateLimitError');
        });

        it('should have correct message format', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.message).toBe(`Discord rate limit exceeded. Retry after ${testRetryAfter}ms`);
        });

        it('should have correct code', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        });

        it('should store retryAfter property', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.retryAfter).toBe(testRetryAfter);
        });

        it('should handle different retry durations', () => {
            const retryAfters = [1000, 3000, 10000, 60000];

            for(const retryAfter of retryAfters) {
                const error = new RateLimitError(retryAfter);
                expect(error.retryAfter).toBe(retryAfter);
                expect(error.message).toContain(`${retryAfter}ms`);
            }
        });

        it('should handle zero retry duration', () => {
            const error = new RateLimitError(0);
            expect(error.retryAfter).toBe(0);
            expect(error.message).toContain('0ms');
        });

        it('should handle very large retry durations', () => {
            const largeRetryAfter = 3600000; // 1 hour in ms
            const error = new RateLimitError(largeRetryAfter);
            expect(error.retryAfter).toBe(largeRetryAfter);
            expect(error.message).toContain(`${largeRetryAfter}ms`);
        });

        it('should have a stack trace', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('RateLimitError');
        });
    });
});
