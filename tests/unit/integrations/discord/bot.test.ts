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
import * as presenceModule from '@/integrations/discord/presence';

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

    it('should register clientReady handler on client', () => {
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

        expect(mockClient.on).toHaveBeenCalledWith('clientReady', expect.any(Function));
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

    it('should propagate destroy errors to caller', async () => {
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

        // Simulate clientReady event firing by calling the second 'clientReady' handler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
        const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
        expect(readyHandlerCalls.length).toBeGreaterThanOrEqual(2);

        // Call the second clientReady handler (the one that sets up messageCreate)
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

    describe('Presence Manager Integration', () => {
        it('should accept optional presence dependencies without errors', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };
            const mockAgent = { chat: mock(async () => 'response') };

            // Should not throw when optional presence dependencies are provided
            // (even without config.presence, which prevents actual presence creation)
            expect(() => createDiscordBot({
                config:          mockConfig,
                onMessage:       mockOnMessage,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                anthropicClient: mockAnthropicClient as any,
                identityContext: 'Test identity',
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                agent:           mockAgent as any,
            })).not.toThrow();
        });

        it('should accept agent option without anthropicClient or identityContext', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockAgent = { chat: mock(async () => 'response') };

            // Should not throw when only agent is provided (partial presence deps)
            expect(() => createDiscordBot({
                config:    mockConfig,
                onMessage: mockOnMessage,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                agent:     mockAgent as any,
            })).not.toThrow();
        });

        describe('Presence manager creation conditions', () => {
            it('should NOT create presence manager when anthropicClient is missing', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
                const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager');
                spies.push(presenceManagerSpy);

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // anthropicClient missing
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(presenceManagerSpy).not.toHaveBeenCalled();
            });

            it('should NOT create presence manager when identityContext is missing', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
                const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager');
                spies.push(presenceManagerSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    // identityContext missing
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(presenceManagerSpy).not.toHaveBeenCalled();
            });

            it('should NOT create presence manager when config.presence is missing', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
                const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager');
                spies.push(presenceManagerSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          mockConfig, // no presence config
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(presenceManagerSpy).not.toHaveBeenCalled();
            });

            it('should create presence manager when ALL three deps are present', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager);
                spies.push(presenceManagerSpy);

                const activeGenSpy = spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                });
                spies.push(activeGenSpy);

                const idleGenSpy = spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                });
                spies.push(idleGenSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(presenceManagerSpy).toHaveBeenCalled();
            });
        });

        describe('Presence manager lifecycle', () => {
            it('should call presenceManager.start() after creation', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(mockPresenceManager.start).toHaveBeenCalled();
            });

            it('should call presenceManager.stop() on bot stop() when manager exists', async () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                const bot = createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event to create presenceManager
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                await bot.stop();

                expect(mockPresenceManager.stop).toHaveBeenCalled();
                expect(mockClient.destroy).toHaveBeenCalled();
            });

            it('should NOT call presenceManager.stop() when manager does not exist', async () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const bot = createDiscordBot({
                    config:    mockConfig, // no presence config
                    onMessage: mockOnMessage,
                });

                // Don't simulate clientReady - presenceManager won't be created

                await bot.stop();

                // Should only call destroy, no presence stop
                expect(mockClient.destroy).toHaveBeenCalled();
            });

            it('should call presenceManager.stop() before client.destroy()', async () => {
                const callOrder: string[] = [];

                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => { callOrder.push('destroy'); }),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => { callOrder.push('stop'); }),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                const bot = createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event to create presenceManager
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                await bot.stop();

                expect(callOrder).toEqual(['stop', 'destroy']);
            });
        });

        describe('Status generator creation', () => {
            it('should create active status generator with ActivityType.Custom', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                const activeGenSpy = spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                });
                spies.push(activeGenSpy);

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(activeGenSpy).toHaveBeenCalledWith(expect.objectContaining({
                    activityType: 4, // ActivityType.Custom
                }));
            });

            it('should create idle status generator with anthropicClient and identityContext', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                const idleGenSpy = spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                });
                spies.push(idleGenSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(idleGenSpy).toHaveBeenCalledWith(expect.objectContaining({
                    anthropic:       mockAnthropicClient,
                    identityContext: 'Test identity',
                    activityType:    4,
                }));
            });

            it('should create presence manager with config.presence', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager);
                spies.push(presenceManagerSpy);

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(presenceManagerSpy).toHaveBeenCalledWith(expect.objectContaining({
                    discordClient: mockClient,
                    config:        configWithPresence.presence,
                }));
            });
        });

        describe('Message handler with presence manager', () => {
            it('should pass presenceManager to createMessageHandler when created', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const messageHandlerSpy = spyOn(handlersModule, 'createMessageHandler').mockReturnValue(mock(async () => undefined));
                spies.push(messageHandlerSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(messageHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({
                    presenceManager: mockPresenceManager,
                }));
            });

            it('should pass agent to createMessageHandler when provided', () => {
                const mockClient = {
                    on:      mock(() => mockClient),
                    login:   mock(async () => 'mock-token'),
                    destroy: mock(async () => undefined),
                    user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                } as unknown as Client;

                const configWithPresence: DiscordConfig = {
                    ...mockConfig,
                    presence: {
                        updateDebounceMs:      2000,
                        idleTimeoutMs:         60000,
                        idleRefreshIntervalMs: 300000,
                    },
                };

                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

                const mockPresenceManager = {
                    start:       mock(() => undefined),
                    stop:        mock(() => undefined),
                    updatePhase: mock(async () => undefined),
                };
                spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

                spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate: mock(() => ({ name: 'Thinking...', type: 4 })),
                }));

                spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                }));

                const messageHandlerSpy = spyOn(handlersModule, 'createMessageHandler').mockReturnValue(mock(async () => undefined));
                spies.push(messageHandlerSpy);

                const mockAnthropicClient = { messages: { create: mock(async () => ({})) } };
                const mockAgent = { chat: mock(async () => 'response') };

                createDiscordBot({
                    config:          configWithPresence,
                    onMessage:       mockOnMessage,
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    anthropicClient: mockAnthropicClient as any,
                    identityContext: 'Test identity',
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- Mock type doesn't match interface exactly
                    agent:           mockAgent as any,
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(messageHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({
                    agent: mockAgent,
                }));
            });

            it('should pass undefined presenceManager when not created', () => {
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
                    config:    mockConfig, // no presence config
                    onMessage: mockOnMessage,
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(messageHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({
                    presenceManager: undefined,
                }));
            });

            it('should pass undefined agent when not provided', () => {
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
                    // no agent
                });

                // Simulate clientReady event
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
                const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
                const messageCreateSetupHandler = readyHandlerCalls[1][1] as (client: unknown) => void;
                messageCreateSetupHandler(mockClient);

                expect(messageHandlerSpy).toHaveBeenCalledWith(expect.objectContaining({
                    agent: undefined,
                }));
            });
        });
    });

    describe('Handler registration', () => {
        it('should register TWO clientReady handlers', () => {
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

            // Count clientReady handler registrations
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const readyHandlerCalls = filter((mockClient.on as any).mock.calls as [string, unknown][], ['0', 'clientReady']);
            expect(readyHandlerCalls.length).toBe(2);
        });

        it('should register error handler first, then clientReady handlers', () => {
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

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.on as any).mock.calls as [string, unknown][];
            expect(calls[0][0]).toBe('error');
            expect(calls[1][0]).toBe('clientReady');
            expect(calls[2][0]).toBe('clientReady');
        });
    });
});
