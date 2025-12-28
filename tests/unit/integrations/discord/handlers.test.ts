/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */

/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';
import type { Client, Message, User, Guild, TextChannel, DMChannel } from 'discord.js';
import { logger } from '@hughescr/logger';
import {
    createReadyHandler,
    createErrorHandler,
    createMessageHandler
} from '@/integrations/discord/handlers';
import type { DiscordMessageContext, UserId, ChannelId } from '@/integrations/discord/types';

describe('Discord Event Handlers', () => {
    describe('createReadyHandler', () => {
        it('should return a function', () => {
            const handler = createReadyHandler();
            expect(typeof handler).toBe('function');
        });

        it('should log bot user tag when ready event fires', () => {
            const loggerSpy = spyOn(logger, 'info');
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#1234'
                }
            } as Client;

            handler(mockClient);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            const message = lastCall[0] as string;
            expect(message.includes('TestBot#1234')).toBe(true);
        });

        it('should log "ready" or "logged in" message', () => {
            const loggerSpy = spyOn(logger, 'info');
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#9999'
                }
            } as Client;

            handler(mockClient);

            expect(loggerSpy).toHaveBeenCalled();
            const logMessage = (loggerSpy.mock.calls[0] as unknown[])[0] as string;
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = logMessage.toLowerCase();

            expect(lower.includes('ready') || lower.includes('logged in')).toBe(true);
        });

        it('should handle client without user gracefully', () => {
            const loggerSpy = spyOn(logger, 'info');
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            // Should not throw
            expect(() => handler(mockClient)).not.toThrow();
            expect(loggerSpy).toHaveBeenCalled();
        });

        it('should log fallback message when client.user is null', () => {
            const loggerSpy = spyOn(logger, 'info');
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            handler(mockClient);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            expect((lastCall[0] as string).includes('not available')).toBe(true);
        });
    });

    describe('createErrorHandler', () => {
        it('should return a function', () => {
            const handler = createErrorHandler();
            expect(typeof handler).toBe('function');
        });

        it('should log error when error event fires', () => {
            const loggerSpy = spyOn(logger, 'error');
            const handler = createErrorHandler();

            const testError = new Error('Test error message');
            handler(testError);

            expect(loggerSpy).toHaveBeenCalled();
            const firstCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = firstCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            expect(loggedObject.msg.includes('Test error message')).toBe(true);
        });

        it('should log error with context about Discord', () => {
            const loggerSpy = spyOn(logger, 'error');
            const handler = createErrorHandler();

            const testError = new Error('Connection failed');
            handler(testError);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - single object with error and msg properties
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject).toHaveProperty('error', testError);
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = loggedObject.msg.toLowerCase();

            expect(lower.includes('discord') || lower.includes('error')).toBe(true);
        });

        it('should handle non-Error objects', () => {
            const loggerSpy = spyOn(logger, 'error');
            const handler = createErrorHandler();

            // Discord.js might emit string errors or other types
            handler('String error' as unknown as Error);

            expect(loggerSpy).toHaveBeenCalled();
        });
    });

    describe('createMessageHandler', () => {
        let mockOnMessage: ReturnType<typeof mock>;
        let mockMessage: Message;
        let mockTextChannel: TextChannel;
        let mockDMChannel: DMChannel;

        beforeEach(() => {
            mockOnMessage = mock(async (_context: DiscordMessageContext) => null);

            const mockUser = {
                id:  '111111111111111111',
                bot: false,
            } as User;

            const mockGuild = {
                id: '222222222222222222',
            } as Guild;

            mockTextChannel = {
                id:         '333333333333333333',
                type:       0, // GuildText
                sendTyping: mock(async () => undefined),
            } as unknown as TextChannel;

            mockDMChannel = {
                id:   '444444444444444444',
                type: 1, // DM
            } as DMChannel;

            mockMessage = {
                id:        '555555555555555555',
                content:   'Test message',
                author:    mockUser,
                guild:     mockGuild,
                channel:   mockTextChannel,
                createdAt: new Date('2025-01-15T12:00:00.000Z'),
                reply:     mock(async () => ({})),
            } as unknown as Message;
        });

        it('should return a function', () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            expect(typeof handler).toBe('function');
        });

        it('should ignore messages from bots', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.bot = true;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should ignore bot messages even in monitored channels', async () => {
            const channelId = '333333333333333333';
            const handler = createMessageHandler({
                monitoredChannelIds: [channelId as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.bot = true;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should ignore messages from the bot itself', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.id = botId;
            mockMessage.author.bot = false;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should ignore self messages even in monitored channels', async () => {
            const botId = '999999999999999999';
            const channelId = '333333333333333333';
            const handler = createMessageHandler({
                monitoredChannelIds: [channelId as ChannelId],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.author.id = botId;
            mockMessage.author.bot = false;
            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should process DM messages', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const dmMessage = {
                ...mockMessage,
                channel: mockDMChannel,
                guild:   null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockOnMessage).toHaveBeenCalled();
            const context = mockOnMessage.mock.calls[0][0];
            expect(context.channelId).toBe('444444444444444444');
            expect(context.userId).toBe('111111111111111111');
        });

        it('should process messages with bot mentions', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            mockMessage.content = `<@${botId}> hello there`;

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should process messages in monitored channels', async () => {
            const channelId = '333333333333333333';
            const handler = createMessageHandler({
                monitoredChannelIds: [channelId as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should ignore messages in non-monitored channels without mention', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['777777777777777777' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).not.toHaveBeenCalled();
        });

        it('should pass correct context to onMessage callback', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalledTimes(1);
            const context = mockOnMessage.mock.calls[0][0];

            expect(context.guildId).toBe('222222222222222222');
            expect(context.channelId).toBe('333333333333333333');
            expect(context.userId).toBe('111111111111111111');
            expect(context.messageId).toBe('555555555555555555');
            expect(context.content).toBe('Test message');
            expect(context.timestamp).toBe('2025-01-15T12:00:00.000Z');
        });

        it('should reply with message when onMessage returns string', async () => {
            mockOnMessage = mock(async () => 'Response message');

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockMessage.reply).toHaveBeenCalledWith('Response message');
        });

        it('should not reply when onMessage returns null', async () => {
            mockOnMessage = mock(async () => null);

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockMessage.reply).not.toHaveBeenCalled();
        });

        it('should handle errors in onMessage callback gracefully', async () => {
            const loggerSpy = spyOn(logger, 'error');
            mockOnMessage = mock(async () => {
                throw new Error('Callback error');
            });

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - check msg property in object
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject.msg.includes('Callback error')).toBe(true);
        });

        it('should handle errors in reply gracefully', async () => {
            const loggerSpy = spyOn(logger, 'error');
            mockOnMessage = mock(async () => 'Response');
            mockMessage.reply = mock(async () => {
                throw new Error('Reply failed');
            });

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(loggerSpy).toHaveBeenCalled();
            const lastCall = loggerSpy.mock.calls[loggerSpy.mock.calls.length - 1] as unknown[];
            // logger.error({ error, msg }) - check msg property in object
            const loggedObject = lastCall[0] as { error: Error, msg: string };
            expect(loggedObject.msg.includes('Reply failed')).toBe(true);
        });

        it('should handle DM messages with null guild', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const dmMessage = {
                ...mockMessage,
                channel: mockDMChannel,
                guild:   null,
            } as unknown as Message;

            await handler(dmMessage);

            expect(mockOnMessage).toHaveBeenCalled();
            const context = mockOnMessage.mock.calls[0][0];
            // DM messages should use a default or special guildId
            expect(context.guildId).toBeDefined();
        });

        it('should format timestamp as ISO datetime', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            const timestampMessage = {
                ...mockMessage,
                createdAt: new Date('2025-12-24T15:30:45.123Z'),
            } as unknown as Message;

            await handler(timestampMessage);

            const context = mockOnMessage.mock.calls[0][0];
            expect(context.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
            expect(context.timestamp).toBe('2025-12-24T15:30:45.123Z');
        });

        it('should handle messages with alternative mention format', async () => {
            const botId = '999999999999999999';
            const handler = createMessageHandler({
                monitoredChannelIds: [],
                botUserId:           botId as UserId,
                onMessage:           mockOnMessage,
            });

            // Some clients use <@!userId> format
            mockMessage.content = `<@!${botId}> hello`;

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });

        it('should accept optional presenceManager and agent in options', async () => {
            const mockPresenceManager = {
                start:       mock(() => undefined),
                stop:        mock(() => undefined),
                updatePhase: mock(async () => undefined),
            };

            const mockAgent = {
                chat: mock(async () => 'agent response'),
            };

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                presenceManager:     mockPresenceManager as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mock type doesn't match interface exactly
                agent:               mockAgent as any,
            });

            await handler(mockMessage);

            // When presenceManager and agent are provided, middleware calls agent.chat instead of onMessage
            expect(mockAgent.chat).toHaveBeenCalled();
            expect(mockMessage.reply).toHaveBeenCalledWith('agent response');
        });

        it('should work without optional presenceManager and agent', async () => {
            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(mockOnMessage).toHaveBeenCalled();
        });
    });
});
