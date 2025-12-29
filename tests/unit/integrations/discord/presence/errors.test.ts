import { describe, expect, it } from 'bun:test';
import _ from 'lodash';
import {
    PresenceError,
    StatusGenerationError
} from '@/integrations/discord/presence/errors';
import { DiscordIntegrationError } from '@/integrations/discord/errors';

describe('Presence Error Classes', () => {
    describe('PresenceError', () => {
        describe('constructor with default code', () => {
            it('should be an instance of PresenceError', () => {
                const error = new PresenceError('Test presence error');
                expect(error).toBeInstanceOf(PresenceError);
            });

            it('should be an instance of DiscordIntegrationError', () => {
                const error = new PresenceError('Test presence error');
                expect(error).toBeInstanceOf(DiscordIntegrationError);
            });

            it('should be an instance of Error', () => {
                const error = new PresenceError('Test presence error');
                expect(error).toBeInstanceOf(Error);
            });

            it('should have name equal to "PresenceError"', () => {
                const error = new PresenceError('Test presence error');
                expect(error.name).toBe('PresenceError');
            });

            it('should have message stored correctly', () => {
                const error = new PresenceError('Test presence error');
                expect(error.message).toBe('Test presence error');
            });

            it('should have default code equal to "PRESENCE_ERROR"', () => {
                const error = new PresenceError('Test presence error');
                expect(error.code).toBe('PRESENCE_ERROR');
            });

            it('should have cause as undefined when not provided', () => {
                const error = new PresenceError('Test presence error');
                expect(error.cause).toBeUndefined();
            });
        });

        describe('constructor with custom code', () => {
            it('should have custom code when provided', () => {
                const error = new PresenceError('Test error', 'CUSTOM_CODE');
                expect(error.code).toBe('CUSTOM_CODE');
            });

            it('should still have correct name with custom code', () => {
                const error = new PresenceError('Test error', 'CUSTOM_CODE');
                expect(error.name).toBe('PresenceError');
            });
        });

        describe('constructor with cause', () => {
            it('should have cause stored correctly when provided as Error', () => {
                const originalError = new Error('Original error');
                const error = new PresenceError('Test error', 'PRESENCE_ERROR', originalError);
                expect(error.cause).toBe(originalError);
            });

            it('should have cause stored correctly when provided as string', () => {
                const error = new PresenceError('Test error', 'PRESENCE_ERROR', 'string cause');
                expect(error.cause).toBe('string cause');
            });

            it('should have cause stored correctly when provided as object', () => {
                const causeObj = { reason: 'test reason', code: 123 };
                const error = new PresenceError('Test error', 'PRESENCE_ERROR', causeObj);
                expect(error.cause).toBe(causeObj);
            });

            it('should have cause stored correctly when provided as null', () => {
                const error = new PresenceError('Test error', 'PRESENCE_ERROR', null);
                expect(error.cause).toBeNull();
            });
        });

        describe('constructor with all parameters', () => {
            it('should correctly set all properties simultaneously', () => {
                const cause = new Error('Underlying cause');
                const error = new PresenceError('Full test message', 'FULL_TEST_CODE', cause);

                expect(error.name).toBe('PresenceError');
                expect(error.message).toBe('Full test message');
                expect(error.code).toBe('FULL_TEST_CODE');
                expect(error.cause).toBe(cause);
            });
        });

        describe('stack trace', () => {
            it('should preserve stack trace', () => {
                const error = new PresenceError('Test error');
                expect(error.stack).toBeDefined();
                expect(error.stack).toContain('PresenceError');
            });
        });
    });

    describe('StatusGenerationError', () => {
        describe('constructor without cause', () => {
            it('should be an instance of StatusGenerationError', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error).toBeInstanceOf(StatusGenerationError);
            });

            it('should be an instance of PresenceError', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error).toBeInstanceOf(PresenceError);
            });

            it('should be an instance of DiscordIntegrationError', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error).toBeInstanceOf(DiscordIntegrationError);
            });

            it('should be an instance of Error', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error).toBeInstanceOf(Error);
            });

            it('should have name equal to "StatusGenerationError"', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error.name).toBe('StatusGenerationError');
            });

            it('should have message stored correctly', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error.message).toBe('Status generation failed');
            });

            it('should have code equal to "STATUS_GENERATION_ERROR"', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error.code).toBe('STATUS_GENERATION_ERROR');
            });

            it('should have cause as undefined when not provided', () => {
                const error = new StatusGenerationError('Status generation failed');
                expect(error.cause).toBeUndefined();
            });
        });

        describe('constructor with cause', () => {
            it('should have cause passed through correctly when provided as Error', () => {
                const originalError = new Error('API timeout');
                const error = new StatusGenerationError('Status generation failed', originalError);
                expect(error.cause).toBe(originalError);
            });

            it('should have cause passed through correctly when provided as string', () => {
                const error = new StatusGenerationError('Status generation failed', 'network error');
                expect(error.cause).toBe('network error');
            });

            it('should have cause passed through correctly when provided as object', () => {
                const causeObj = { apiResponse: 500, message: 'Server error' };
                const error = new StatusGenerationError('Status generation failed', causeObj);
                expect(error.cause).toBe(causeObj);
            });

            it('should have cause passed through correctly when provided as null', () => {
                const error = new StatusGenerationError('Status generation failed', null);
                expect(error.cause).toBeNull();
            });

            it('should still have correct name when cause is provided', () => {
                const error = new StatusGenerationError('Test', new Error('cause'));
                expect(error.name).toBe('StatusGenerationError');
            });

            it('should still have correct code when cause is provided', () => {
                const error = new StatusGenerationError('Test', new Error('cause'));
                expect(error.code).toBe('STATUS_GENERATION_ERROR');
            });
        });

        describe('constructor with all parameters', () => {
            it('should correctly set all properties simultaneously', () => {
                const cause = new Error('Haiku API error');
                const error = new StatusGenerationError('Failed to generate status text', cause);

                expect(error.name).toBe('StatusGenerationError');
                expect(error.message).toBe('Failed to generate status text');
                expect(error.code).toBe('STATUS_GENERATION_ERROR');
                expect(error.cause).toBe(cause);
            });
        });

        describe('stack trace', () => {
            it('should preserve stack trace', () => {
                const error = new StatusGenerationError('Test error');
                expect(error.stack).toBeDefined();
                expect(error.stack).toContain('StatusGenerationError');
            });
        });

        describe('edge cases', () => {
            it('should handle empty message', () => {
                const error = new StatusGenerationError('');
                expect(error.message).toBe('');
                expect(error.code).toBe('STATUS_GENERATION_ERROR');
                expect(error.name).toBe('StatusGenerationError');
            });

            it('should handle very long message', () => {
                const longMessage = _.repeat('A', 10000);
                const error = new StatusGenerationError(longMessage);
                expect(error.message).toBe(longMessage);
            });
        });
    });

    describe('Error hierarchy verification', () => {
        it('should maintain correct prototype chain for PresenceError', () => {
            const error = new PresenceError('Test');
            // Verify inheritance via instanceof - PresenceError extends DiscordIntegrationError
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);
            // Verify the prototype is not directly Error
            expect(Object.getPrototypeOf(Object.getPrototypeOf(error))).not.toBe(Error.prototype);
        });

        it('should maintain correct prototype chain for StatusGenerationError', () => {
            const error = new StatusGenerationError('Test');
            // Verify inheritance via instanceof - StatusGenerationError extends PresenceError
            expect(error).toBeInstanceOf(StatusGenerationError);
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);
        });
    });
});
