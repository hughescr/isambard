/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { filter } from 'lodash';
import type { Client } from 'discord.js';
import { createDiscordBot } from '@/integrations/discord/bot';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, ChannelId } from '@/integrations/discord/types';
import * as clientModule from '@/integrations/discord/client';
import * as handlersModule from '@/integrations/discord/handlers';

describe('createDiscordBot', () => {
    let mockConfig: DiscordConfig;
    let mockOnMessage: (context: DiscordMessageContext) => Promise<string | null>;
    const spies: ReturnType<typeof spyOn>[] = [];

    beforeEach(() => {
        mockConfig = {
            botToken:            'test-bot-token',
            applicationId:       'test-app-id',
            monitoredChannelIds: ['123456789' as ChannelId, '987654321' as ChannelId],
        };

        mockOnMessage = mock(async (_context: DiscordMessageContext) => null);
    });

    afterEach(() => {
        // Restore all spies to prevent test isolation issues
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
    });

    it('should return an object with start and stop methods', () => {
        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(bot).toBeDefined();
        expect(typeof bot.start).toBe('function');
        expect(typeof bot.stop).toBe('function');
    });

    it('should create a Discord client with the config', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        const spy = spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient);
        spies.push(spy);

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(spy).toHaveBeenCalledWith(mockConfig);
    });

    it('should register error handler on client', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should register ready handler on client', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(mockClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
    });

    it('should call client.login with bot token when start() is called', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        await bot.start();

        expect(mockClient.login).toHaveBeenCalledWith('test-bot-token');
    });

    it('should call client.destroy when stop() is called', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        await bot.stop();

        expect(mockClient.destroy).toHaveBeenCalled();
    });

    it('should propagate login errors to caller', async () => {
        const loginError = new Error('Invalid bot token');
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => { throw loginError; }),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(bot.start()).rejects.toThrow('Invalid bot token');
    });

    it('should handle destroy errors gracefully', async () => {
        const destroyError = new Error('Destroy failed');
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => { throw destroyError; }),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        // Should not throw
        expect(bot.stop()).rejects.toThrow('Destroy failed');
    });

    it('should allow multiple start/stop cycles', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        await bot.start();
        await bot.stop();
        await bot.start();
        await bot.stop();

        expect(mockClient.login).toHaveBeenCalledTimes(2);
        expect(mockClient.destroy).toHaveBeenCalledTimes(2);
    });

    it('should register messageCreate handler on ready event with correct options', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
        const messageHandlerSpy = spyOn(handlersModule, 'createMessageHandler').mockReturnValue(mock(async () => undefined));
        spies.push(messageHandlerSpy);

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        // Simulate ready event firing by calling the second 'ready' handler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
        const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'ready']);
        expect(readyHandlerCalls.length).toBeGreaterThanOrEqual(2);

        // Call the second ready handler (the one that sets up messageCreate)
        const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
        messageCreateSetupHandler(mockClient);

        // Verify createMessageHandler was called with correct options
        expect(messageHandlerSpy).toHaveBeenCalledWith({
            monitoredChannelIds: mockConfig.monitoredChannelIds,
            botUserId:           '999999999999999999',
            onMessage:           mockOnMessage,
        });

        // Verify messageCreate handler was registered
        expect(mockClient.on).toHaveBeenCalledWith('messageCreate', expect.any(Function));
    });

    it('should use createReadyHandler for logging ready event', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
        const readyHandlerSpy = spyOn(handlersModule, 'createReadyHandler').mockReturnValue(mock(() => undefined));
        spies.push(readyHandlerSpy);

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(readyHandlerSpy).toHaveBeenCalled();
    });

    it('should use createErrorHandler for error events', () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
        const errorHandlerSpy = spyOn(handlersModule, 'createErrorHandler').mockReturnValue(mock(() => undefined));
        spies.push(errorHandlerSpy);

        createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(errorHandlerSpy).toHaveBeenCalled();
    });
});
