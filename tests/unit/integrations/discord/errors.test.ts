import { describe, it, expect } from 'bun:test';
import {
    DiscordIntegrationError,
    InvalidTokenError,
    PermissionError,
    ChannelNotFoundError,
    RateLimitError
} from '@/integrations/discord/errors';

describe('Discord Integration Errors', () => {
    describe('DiscordIntegrationError', () => {
        it('should be an instance of Error', () => {
            const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
            expect(error).toBeInstanceOf(Error);
        });

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

        it('should call Error.captureStackTrace when available', () => {
            const originalCaptureStackTrace = Error.captureStackTrace?.bind(Error);

            let captureStackTraceCalled = false;
            Error.captureStackTrace = (target: Error, constructor: ErrorConstructor) => {
                captureStackTraceCalled = true;
                if(originalCaptureStackTrace) {
                    originalCaptureStackTrace(target, constructor);
                }
            };

            try {
                new DiscordIntegrationError('Test error', 'TEST_ERROR');
                expect(captureStackTraceCalled).toBe(true);
            } finally {
                if(originalCaptureStackTrace) {
                    Error.captureStackTrace = originalCaptureStackTrace;
                }
            }
        });

        it('should handle missing Error.captureStackTrace gracefully', () => {
            const originalCaptureStackTrace = Error.captureStackTrace?.bind(Error);

            Object.defineProperty(Error, 'captureStackTrace', {
                value:        undefined,
                writable:     true,
                configurable: true,
            });

            try {
                const error = new DiscordIntegrationError('Test error', 'TEST_ERROR');
                expect(error.stack).toBeDefined();
                expect(error.message).toBe('Test error');
            } finally {
                if(originalCaptureStackTrace) {
                    Error.captureStackTrace = originalCaptureStackTrace;
                }
            }
        });
    });

    describe('InvalidTokenError', () => {
        it('should be an instance of Error', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(Error);
        });

        it('should be an instance of DiscordIntegrationError', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should be an instance of InvalidTokenError', () => {
            const error = new InvalidTokenError();
            expect(error).toBeInstanceOf(InvalidTokenError);
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

        it('should preserve stack trace', () => {
            const error = new InvalidTokenError();
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('InvalidTokenError');
        });
    });

    describe('PermissionError', () => {
        const testAction = 'send messages';

        it('should be an instance of Error', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(Error);
        });

        it('should be an instance of DiscordIntegrationError', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should be an instance of PermissionError', () => {
            const error = new PermissionError(testAction);
            expect(error).toBeInstanceOf(PermissionError);
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

        it('should preserve stack trace', () => {
            const error = new PermissionError(testAction);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('PermissionError');
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
    });

    describe('ChannelNotFoundError', () => {
        const testChannelId = '987654321098765432';

        it('should be an instance of Error', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(Error);
        });

        it('should be an instance of DiscordIntegrationError', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should be an instance of ChannelNotFoundError', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error).toBeInstanceOf(ChannelNotFoundError);
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

        it('should preserve stack trace', () => {
            const error = new ChannelNotFoundError(testChannelId);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('ChannelNotFoundError');
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
    });

    describe('RateLimitError', () => {
        const testRetryAfter = 5000;

        it('should be an instance of Error', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(Error);
        });

        it('should be an instance of DiscordIntegrationError', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
        });

        it('should be an instance of RateLimitError', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error).toBeInstanceOf(RateLimitError);
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

        it('should preserve stack trace', () => {
            const error = new RateLimitError(testRetryAfter);
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('RateLimitError');
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
    });
});
