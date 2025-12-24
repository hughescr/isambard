/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, it, expect, beforeEach, spyOn, mock } from 'bun:test';
import type { Client, Message, User, Guild, TextChannel, DMChannel } from 'discord.js';
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
            const consoleSpy = spyOn(console, 'log');
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#1234'
                }
            } as Client;

            handler(mockClient);

            expect(consoleSpy).toHaveBeenCalled();
            const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];

            expect(lastCall[0]).toContain('TestBot#1234');
        });

        it('should log "ready" or "logged in" message', () => {
            const consoleSpy = spyOn(console, 'log');
            const handler = createReadyHandler();

            const mockClient = {
                user: {
                    tag: 'TestBot#9999'
                }
            } as Client;

            handler(mockClient);

            expect(consoleSpy).toHaveBeenCalled();
            const logMessage = consoleSpy.mock.calls[0][0];
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = logMessage.toLowerCase();
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Boolean OR is correct here
            expect(lower.includes('ready') || lower.includes('logged in')).toBe(true);
        });

        it('should handle client without user gracefully', () => {
            const consoleSpy = spyOn(console, 'log');
            const handler = createReadyHandler();

            const mockClient = {
                user: null
            } as unknown as Client;

            // Should not throw
            expect(() => handler(mockClient)).not.toThrow();
            expect(consoleSpy).toHaveBeenCalled();
        });
    });

    describe('createErrorHandler', () => {
        it('should return a function', () => {
            const handler = createErrorHandler();
            expect(typeof handler).toBe('function');
        });

        it('should log error when error event fires', () => {
            const consoleSpy = spyOn(console, 'error');
            const handler = createErrorHandler();

            const testError = new Error('Test error message');
            handler(testError);

            expect(consoleSpy).toHaveBeenCalled();
            const firstCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
            expect(firstCall[0]).toContain('Test error message');
        });

        it('should log error with context about Discord', () => {
            const consoleSpy = spyOn(console, 'error');
            const handler = createErrorHandler();

            const testError = new Error('Connection failed');
            handler(testError);

            expect(consoleSpy).toHaveBeenCalled();
            const errorMessage = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0];
            // eslint-disable-next-line lodash/prefer-lodash-method -- Simple string check
            const lower = errorMessage.toLowerCase();
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- Boolean OR is correct here
            expect(lower.includes('discord') || lower.includes('error')).toBe(true);
        });

        it('should handle non-Error objects', () => {
            const consoleSpy = spyOn(console, 'error');
            const handler = createErrorHandler();

            // Discord.js might emit string errors or other types
            handler('String error' as unknown as Error);

            expect(consoleSpy).toHaveBeenCalled();
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
                id:   '333333333333333333',
                type: 0, // GuildText
            } as TextChannel;

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
            const consoleSpy = spyOn(console, 'error');
            mockOnMessage = mock(async () => {
                throw new Error('Callback error');
            });

            const handler = createMessageHandler({
                monitoredChannelIds: ['333333333333333333' as ChannelId],
                botUserId:           '999999999999999999' as UserId,
                onMessage:           mockOnMessage,
            });

            await handler(mockMessage);

            expect(consoleSpy).toHaveBeenCalled();
            const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
            expect(lastCall[0]).toContain('Callback error');
        });

        it('should handle errors in reply gracefully', async () => {
            const consoleSpy = spyOn(console, 'error');
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

            expect(consoleSpy).toHaveBeenCalled();
            const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
            expect(lastCall[0]).toContain('Reply failed');
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
    });
});
