/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, test, expect, afterEach, mock, spyOn } from 'bun:test';
import { filter as _filter } from 'lodash';
import type { Client } from 'discord.js';
import { createDiscordBot } from '@/integrations/discord/bot';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, ChannelId } from '@/integrations/discord/types';
import * as clientModule from '@/integrations/discord/client';
import * as presenceModule from '@/integrations/discord/presence';

describe.concurrent('createDiscordBot', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    // Setup common mocks
    const mockConfig: DiscordConfig = {
        botToken:            'test-bot-token',
        applicationId:       'test-app-id',
        monitoredChannelIds: ['123456789' as ChannelId, '987654321' as ChannelId],
    };

    const mockOnMessage = mock(async (_context: DiscordMessageContext) => null);

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
    });

    test('should return an object with start and stop methods', () => {
        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(bot).toBeDefined();
        expect(typeof bot.start).toBe('function');
        expect(typeof bot.stop).toBe('function');
    });

    test('should call client.login with bot token when start() is called', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:    null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        await bot.start();

        expect(mockClient.login).toHaveBeenCalledWith('test-bot-token');
    });

    test('should call client.destroy when stop() is called', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:    null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        await bot.stop();

        expect(mockClient.destroy).toHaveBeenCalled();
    });

    test('should propagate login errors to caller', async () => {
        const loginError = new Error('Invalid bot token');
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => { throw loginError; }),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:    null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(bot.start()).rejects.toThrow('Invalid bot token');
    });

    test('should propagate destroy errors to caller', async () => {
        const destroyError = new Error('Destroy failed');
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => { throw destroyError; }),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:    null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config:    mockConfig,
            onMessage: mockOnMessage,
        });

        expect(bot.stop()).rejects.toThrow('Destroy failed');
    });

    test('should allow multiple start/stop cycles', async () => {
        const mockClient = {
            on:      mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => undefined),
            user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:    null,
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

    describe('Presence Manager Lifecycle', () => {
        test('should create presence manager when identityContext and config.presence provided', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start:          mock(() => undefined),
                stop:           mock(() => undefined),
                shouldUpdate:   mock(() => true),
                updatePhase:    mock(async () => undefined),
                setCatchUpMode: mock(() => undefined),
            };
            const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager);
            spies.push(presenceManagerSpy);

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate: mock(() => ({ name: 'Thinking...', type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event (find the SECOND clientReady handler)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.on as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[1]?.[1]; // Second handler is for message setup
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            expect(presenceManagerSpy).toHaveBeenCalled();
            expect(mockPresenceManager.start).toHaveBeenCalled();
        });

        test('should NOT create presence manager when identityContext is missing', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
            const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager');
            spies.push(presenceManagerSpy);

            createDiscordBot({
                config:    configWithPresence,
                onMessage: mockOnMessage,
                // identityContext missing
            });

            // Simulate clientReady event (find the SECOND clientReady handler)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.on as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[1]?.[1]; // Second handler is for message setup
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            expect(presenceManagerSpy).not.toHaveBeenCalled();
        });

        test('should call presenceManager.stop() on bot stop() when manager exists', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start:          mock(() => undefined),
                stop:           mock(() => undefined),
                shouldUpdate:   mock(() => true),
                updatePhase:    mock(async () => undefined),
                setCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate: mock(() => ({ name: 'Thinking...', type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            const bot = createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager (find the SECOND clientReady handler)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.on as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[1]?.[1]; // Second handler is for message setup
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            await bot.stop();

            expect(mockPresenceManager.stop).toHaveBeenCalled();
            expect(mockClient.destroy).toHaveBeenCalled();
        });

        test('should call presenceManager.stop() before client.destroy()', async () => {
            const callOrder: string[] = [];

            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => { callOrder.push('destroy'); }),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start:          mock(() => undefined),
                stop:           mock(() => { callOrder.push('stop'); }),
                shouldUpdate:   mock(() => true),
                updatePhase:    mock(async () => undefined),
                setCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate: mock(() => ({ name: 'Thinking...', type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            const bot = createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager (find the SECOND clientReady handler)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.on as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[1]?.[1]; // Second handler is for message setup
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            await bot.stop();

            expect(callOrder).toEqual(['stop', 'destroy']);
        });
    });
});
