import { describe, it, expect, beforeEach } from 'bun:test';
import type { Client } from 'discord.js';
import { mockLogger } from '../../../setup';
import {
    createReadyHandler,
    createErrorHandler
} from '@/integrations/discord/handlers';

describe('Discord Event Handlers', () => {
    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        mockLogger.debug.mockClear();
        mockLogger.warn.mockClear();
    });

    describe('createReadyHandler', () => {
        it('should log bot user tag when ready event fires', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#1234'
                }
            } as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1] as unknown[];
            const message = lastCall[0] as string;
            expect(message.includes('TestBot#1234')).toBe(true);
        });

        it('should log "ready" or "logged in" message', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#9999'
                }
            } as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const logMessage = (mockLogger.info.mock.calls[0] as unknown[])[0] as string;
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = logMessage.toLowerCase();

            expect(lower.includes('ready') || lower.includes('logged in')).toBe(true);
        });

        it('should handle client without user gracefully', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            // Should not throw
            expect(() => handler(mockClient)).not.toThrow();
            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should log fallback message when client.user is null', () => {
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            handler(mockClient);

            expect(mockLogger.info).toHaveBeenCalled();
            const lastCall = mockLogger.info.mock.calls[mockLogger.info.mock.calls.length - 1] as unknown[];
            expect((lastCall[0] as string).includes('not available')).toBe(true);
        });
    });

    describe('createErrorHandler', () => {
        it('should log error when error event fires', () => {
            const handler = createErrorHandler();

            const testError = new Error('Test error message');
            handler(testError);

            expect(mockLogger.error).toHaveBeenCalled();
            const firstCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = firstCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            expect(loggedObject.msg.includes('Test error message')).toBe(true);
        });

        it('should log error with context about Discord', () => {
            const handler = createErrorHandler();

            const testError = new Error('Connection failed');
            handler(testError);

            expect(mockLogger.error).toHaveBeenCalled();
            const lastCall = mockLogger.error.mock.calls[mockLogger.error.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = loggedObject.msg.toLowerCase();

            expect(lower.includes('discord') || lower.includes('error')).toBe(true);
        });

        it('should handle non-Error objects', () => {
            const handler = createErrorHandler();

            // Discord.js might emit string errors or other types
            handler('String error' as unknown as Error);

            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
});
