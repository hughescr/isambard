import { describe, expect, test } from 'bun:test';
import _ from 'lodash';
import {
    PresenceError,
    StatusGenerationError
} from '@/integrations/discord/presence/errors';
import { DiscordIntegrationError } from '@/integrations/discord/errors';

describe.concurrent('Presence Error Classes', () => {
    describe('PresenceError', () => {
        test('should have correct inheritance chain and properties', () => {
            const error = new PresenceError('Test presence error');

            // Check instanceof chain
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);

            // Check properties
            expect(error.name).toBe('PresenceError');
            expect(error.message).toBe('Test presence error');
            expect(error.code).toBe('PRESENCE_ERROR');
            expect(error.cause).toBeUndefined();
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('PresenceError');
        });

        test('should support custom code', () => {
            const error = new PresenceError('Test error', 'CUSTOM_CODE');
            expect(error.code).toBe('CUSTOM_CODE');
            expect(error.name).toBe('PresenceError');
        });

        test.each([
            ['Error', new Error('Original error')],
            ['string', 'string cause'],
            ['object', { reason: 'test reason', code: 123 }],
            ['null', null],
        ])('should support cause: %s', (_label, causeValue) => {
            const error = new PresenceError('Test error', 'PRESENCE_ERROR', causeValue);
            expect(error.cause).toBe(causeValue);
        });

        test('should maintain correct prototype chain', () => {
            const error = new PresenceError('Test');
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);
            // Verify the prototype is not directly Error
            expect(Object.getPrototypeOf(Object.getPrototypeOf(error))).not.toBe(Error.prototype);
        });
    });

    describe('StatusGenerationError', () => {
        test('should have correct inheritance chain and properties', () => {
            const error = new StatusGenerationError('Status generation failed');

            // Check instanceof chain
            expect(error).toBeInstanceOf(StatusGenerationError);
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);

            // Check properties
            expect(error.name).toBe('StatusGenerationError');
            expect(error.message).toBe('Status generation failed');
            expect(error.code).toBe('STATUS_GENERATION_ERROR');
            expect(error.cause).toBeUndefined();
            expect(error.stack).toBeDefined();
            expect(error.stack).toContain('StatusGenerationError');
        });

        test.each([
            ['Error', new Error('API timeout')],
            ['string', 'network error'],
            ['object', { apiResponse: 500, message: 'Server error' }],
            ['null', null],
        ])('should support cause: %s', (_label, causeValue) => {
            const error = new StatusGenerationError('Status generation failed', causeValue);
            expect(error.cause).toBe(causeValue);
            expect(error.name).toBe('StatusGenerationError');
            expect(error.code).toBe('STATUS_GENERATION_ERROR');
        });

        test.each([
            ['empty message', ''],
            ['very long message', _.repeat('A', 10000)],
        ])('should handle edge case: %s', (_label, message) => {
            const error = new StatusGenerationError(message);
            expect(error.message).toBe(message);
            expect(error.code).toBe('STATUS_GENERATION_ERROR');
            expect(error.name).toBe('StatusGenerationError');
        });

        test('should maintain correct prototype chain', () => {
            const error = new StatusGenerationError('Test');
            // Verify inheritance via instanceof
            expect(error).toBeInstanceOf(StatusGenerationError);
            expect(error).toBeInstanceOf(PresenceError);
            expect(error).toBeInstanceOf(DiscordIntegrationError);
            expect(error).toBeInstanceOf(Error);
        });
    });
});
