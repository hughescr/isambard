/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
/* eslint-disable @typescript-eslint/unbound-method -- Test mocks */
/* eslint-disable lodash/prefer-constant -- Test callbacks */
import { describe, test, expect, afterEach, mock, spyOn, jest } from 'bun:test';
import { filter as _filter, noop as _noop } from 'lodash';
import type { Client } from 'discord.js';
import { createDiscordBot } from '@/integrations/discord/bot';
import type { DiscordConfig } from '@/config/schemas';
import type { DiscordMessageContext, ChannelId } from '@/integrations/discord/types';
import { createChannelId } from '@/integrations/discord/types';
import * as clientModule from '@/integrations/discord/client';
import * as presenceModule from '@/integrations/discord/presence';
import { createBotStateManager } from '@/integrations/discord/state';

describe.concurrent('createDiscordBot', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    // Setup common mocks
    const mockConfig: DiscordConfig = {
        botToken:            'test-bot-token',
        applicationId:       'test-app-id',
        monitoredChannelIds: ['123456789' as ChannelId, '987654321' as ChannelId],
    };

    const mockOnMessage = mock(async (_context: DiscordMessageContext) => null);

    const mockLogger = {
        info:  _noop,
        warn:  _noop,
        error: _noop,
        debug: _noop,
    };

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
            once:    mock(() => mockClient),
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
            once:    mock(() => mockClient),
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
            once:    mock(() => mockClient),
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
            once:    mock(() => mockClient),
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
            once:    mock(() => mockClient),
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

    describe('BotStateManager Throttle Integration', () => {
        test('should NOT call presenceManager.updatePhase when shouldUpdatePresence returns false', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000, // 2 seconds
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mockUpdatePhase,
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            // Create a bot state manager with a mock shouldUpdatePresence that always returns false
            const mockBotStateManager = createBotStateManager({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            mockBotStateManager.shouldUpdatePresence = mock(() => false);

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }
            // Clear any calls from initialization
            mockUpdatePhase.mockClear();

            // Transition to processing_message mode
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // Trigger activity phase update - shouldUpdatePresence will return false
            mockBotStateManager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });
            await new Promise(resolve => setImmediate(resolve));

            // presenceManager.updatePhase should NOT have been called (throttle blocked)
            expect(mockUpdatePhase).not.toHaveBeenCalled();

            // Now make shouldUpdatePresence return true
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Trigger another activity phase update
            mockBotStateManager.updateActivityPhase({ type: 'responding', startedAt: new Date() });
            await new Promise(resolve => setImmediate(resolve));

            // Now it should have been called
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any is safe here
            expect(mockUpdatePhase).toHaveBeenCalledWith({ type: 'responding', startedAt: expect.any(Date) });
        });

        // NOTE: Real timing-based throttle tests are not feasible with current architecture.
        // The issue: updateActivityPhase() sets lastPresenceUpdateTime BEFORE notifying subscribers,
        // so shouldUpdatePresence() always sees ~0ms elapsed time and throttles the update.
        // The mock-based tests above verify the throttle logic is correctly wired (check is called,
        // true allows update, false blocks it). Timing verification would require architectural
        // changes to set lastPresenceUpdateTime AFTER the throttle check passes.
    });

    describe('Presence Flow Integration', () => {
        test('should set up activity phase subscription when presence manager is created', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mockUpdatePhase,
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            // Track subscription calls
            let subscribeCallCount = 0;
            const realBotStateManager = createBotStateManager({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            const originalSubscribe = realBotStateManager.subscribe;
            realBotStateManager.subscribe = (listener) => {
                subscribeCallCount++;
                return originalSubscribe.call(realBotStateManager, listener);
            };
            realBotStateManager.start();

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
                botStateManager: realBotStateManager,
            });

            // Trigger clientReady to set up subscriptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            // Verify subscriptions were created (2: one for mode transition, one for activity phase)
            expect(subscribeCallCount).toBe(2);
        });

        test('should complete full presence flow: state update → subscription → throttle check → presence update', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mockUpdatePhase,
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            // Create a real bot state manager to test the subscription mechanism
            const mockBotStateManager = createBotStateManager({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            // Clear any calls from initialization
            mockUpdatePhase.mockClear();

            // Step 1: Transition to processing_message mode
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // Step 2: Mock shouldUpdatePresence to return true for first update
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Step 3: Update activity phase to 'thinking'
            const phase1 = { type: 'thinking' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase1);

            // Step 4: Allow event loop to process subscription callbacks
            await new Promise(resolve => setImmediate(resolve));

            // Step 5: Verify presenceManager.updatePhase was called (throttle allowed)
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any is safe here
            expect(mockUpdatePhase).toHaveBeenCalledWith({ type: 'thinking', startedAt: expect.any(Date) });

            // Clear mock for next phase
            mockUpdatePhase.mockClear();

            // Step 6: Mock shouldUpdatePresence to return false for second update (throttled)
            mockBotStateManager.shouldUpdatePresence = mock(() => false);

            // Step 7: Update again immediately - throttle should block this
            const phase2 = { type: 'responding' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase2);
            await new Promise(resolve => setImmediate(resolve));

            // Step 8: Verify presenceManager.updatePhase was NOT called (throttle blocked)
            expect(mockUpdatePhase).not.toHaveBeenCalled();

            // Step 9: Mock shouldUpdatePresence to return true again (throttle window passed)
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Step 10: Update again - throttle should allow this
            const phase3 = { type: 'using_tool' as const, startedAt: new Date(), toolName: 'test-tool' };
            mockBotStateManager.updateActivityPhase(phase3);
            await new Promise(resolve => setImmediate(resolve));

            // Step 11: Verify presenceManager.updatePhase was called (throttle allows after delay)
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith({
                type:      'using_tool',
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- expect.any is safe here
                startedAt: expect.any(Date),
                toolName:  'test-tool',
            });
        });

        test('should verify throttle works correctly with recordPresenceUpdate timing', async () => {
            // Use fake time to control Date.now() for throttle checks
            const baseTime = 1000000;
            jest.setSystemTime(baseTime);

            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      100, // Short throttle for testing
                    idleTimeoutMs:         60000,
                    idleRefreshIntervalMs: 300000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mockUpdatePhase,
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            const mockBotStateManager = createBotStateManager({
                logger:           mockLogger,
                updateThrottleMs: 100, // Short throttle for testing
            });
            mockBotStateManager.start();

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }
            mockUpdatePhase.mockClear();

            // Transition to processing_message mode
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // First update should go through (no previous timestamp)
            const phase1 = { type: 'thinking' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase1);
            await new Promise(resolve => setImmediate(resolve));

            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith(phase1);
            mockUpdatePhase.mockClear();

            // Immediate second update should be throttled (still at same time)
            const phase2 = { type: 'using_tool' as const, startedAt: new Date(), toolName: 'tool1' };
            mockBotStateManager.updateActivityPhase(phase2);
            await new Promise(resolve => setImmediate(resolve));

            expect(mockUpdatePhase).toHaveBeenCalledTimes(0); // Throttled

            // Advance fake time past throttle window (100ms + buffer)
            jest.setSystemTime(baseTime + 150);

            // Third update should now go through
            const phase3 = { type: 'responding' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase3);
            await new Promise(resolve => setImmediate(resolve));

            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith(phase3);

            // Reset system time
            jest.setSystemTime();
        });

        test('should verify subscription fires on activity phase updates', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mockUpdatePhase,
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            // Create a real bot state manager
            const mockBotStateManager = createBotStateManager({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            // Clear any calls from initialization
            mockUpdatePhase.mockClear();

            // Transition to processing_message
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // Mock shouldUpdatePresence to return true to allow update
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Update activity phase to different types and verify each triggers subscription
            const phases = [
                { type: 'thinking' as const, startedAt: new Date() },
                { type: 'responding' as const, startedAt: new Date() },
                { type: 'using_tool' as const, startedAt: new Date(), toolName: 'test-tool' },
            ];

            for(const phase of phases) {
                mockUpdatePhase.mockClear();
                mockBotStateManager.updateActivityPhase(phase);
                await new Promise(resolve => setImmediate(resolve));

                // Verify subscription fired and presence was updated
                expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
                expect(mockUpdatePhase).toHaveBeenCalledWith(expect.objectContaining({ type: phase.type }));
            }
        });
    });

    describe('Reconnection Handler Safety', () => {
        test('should use client.once() for clientReady to prevent duplicate handler registration on reconnects', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            createDiscordBot({
                config:    mockConfig,
                onMessage: mockOnMessage,
            });

            // Verify client.once() was called with 'clientReady' (not client.on())
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const onceCalls = (mockClient.once as any).mock.calls as [string, (...args: unknown[]) => void][];
            const clientReadyCalls = _filter(onceCalls, ([event]) => event === 'clientReady');

            // Should have at least one clientReady handler registered with once()
            expect(clientReadyCalls.length).toBeGreaterThan(0);
        });

        test('should verify clientReady handler uses once() to prevent re-registration on reconnect', () => {
            let messageCreateHandlerCount = 0;
            let interactionCreateHandlerCount = 0;
            let clientReadyHandlerCallCount = 0;

            // Track registered handlers
            const registeredHandlers = new Map<string, ((...args: unknown[]) => void)[]>();

            // Create a mock client that behaves like the real Discord client
            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(!registeredHandlers.has(event)) {
                        registeredHandlers.set(event, []);
                    }
                    registeredHandlers.get(event)!.push(handler);

                    if(event === 'messageCreate') {
                        messageCreateHandlerCount++;
                    }
                    if(event === 'interactionCreate') {
                        interactionCreateHandlerCount++;
                    }
                    return mockClient;
                }),
                once: mock((event: string, handler: (...args: unknown[]) => void) => {
                    // once() should only fire the handler once
                    const wrappedHandler = (...args: unknown[]) => {
                        clientReadyHandlerCallCount++;
                        handler(...args);
                    };
                    if(!registeredHandlers.has(event)) {
                        registeredHandlers.set(event, []);
                    }
                    registeredHandlers.get(event)!.push(wrappedHandler);
                    return mockClient;
                }),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            createDiscordBot({
                config:    mockConfig,
                onMessage: mockOnMessage,
            });

            // Verify that clientReady was registered with once()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const onceCalls = (mockClient.once as any).mock.calls as [string, (...args: unknown[]) => void][];
            const clientReadyOnceCalls = _filter(onceCalls, ([event]) => event === 'clientReady');
            expect(clientReadyOnceCalls.length).toBeGreaterThan(0);

            // Simulate the first clientReady event
            const clientReadyHandlers = registeredHandlers.get('clientReady') ?? [];
            expect(clientReadyHandlers.length).toBeGreaterThan(0);

            // Fire the clientReady handler once
            for(const handler of clientReadyHandlers) {
                handler(mockClient);
            }

            // After first clientReady, should have handlers registered
            expect(messageCreateHandlerCount).toBe(1);
            expect(interactionCreateHandlerCount).toBe(1);
            expect(clientReadyHandlerCallCount).toBe(1);

            // Verify that the fix prevents duplicate registrations
            // With once(), the handler shouldn't be called again on reconnect
            // But even if Discord.js allowed it, we verify the pattern is correct
            // The key protection is using once() instead of on()
        });

        test('should verify messageCreate and interactionCreate handlers are registered inside clientReady', () => {
            let messageCreateRegistered = false;
            let interactionCreateRegistered = false;

            const mockClient = {
                on: mock((event: string) => {
                    if(event === 'messageCreate') {
                        messageCreateRegistered = true;
                    }
                    if(event === 'interactionCreate') {
                        interactionCreateRegistered = true;
                    }
                    return mockClient;
                }),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => undefined),
                user:    { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:    null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            createDiscordBot({
                config:    mockConfig,
                onMessage: mockOnMessage,
            });

            // Before clientReady fires, handlers should NOT be registered
            expect(messageCreateRegistered).toBe(false);
            expect(interactionCreateRegistered).toBe(false);

            // Get and fire the clientReady handler
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const onceCalls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const clientReadyHandlers = _filter(onceCalls, ([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandlers[0]?.[1];

            expect(clientReadyHandler).toBeDefined();

            if(clientReadyHandler) {
                clientReadyHandler(mockClient);
            }

            // After clientReady fires, handlers SHOULD be registered
            expect(messageCreateRegistered).toBe(true);
            expect(interactionCreateRegistered).toBe(true);
        });
    });

    describe('Presence Manager Lifecycle', () => {
        test('should create presence manager when identityContext and config.presence provided', () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mock(async () => undefined),
                transitionCatchUpMode: mock(() => undefined),
            };
            const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager);
            spies.push(presenceManagerSpy);

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            expect(presenceManagerSpy).toHaveBeenCalled();
            expect(mockPresenceManager.start).toHaveBeenCalled();
        });

        test('should NOT create presence manager when identityContext is missing', () => {
            // Spy on createPresenceManager FIRST and clear any stale calls
            const presenceManagerSpy = spyOn(presenceModule, 'createPresenceManager');
            presenceManagerSpy.mockClear();
            spies.push(presenceManagerSpy);

            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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

            createDiscordBot({
                config:    configWithPresence,
                onMessage: mockOnMessage,
                // identityContext missing
            });

            // Simulate clientReady event - call ALL handlers to avoid order dependency
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            for(const [, handler] of readyHandlers) {
                handler(mockClient);
            }

            expect(presenceManagerSpy).not.toHaveBeenCalled();
        });

        test('should call presenceManager.stop() on bot stop() when manager exists', async () => {
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
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
                start:                 mock(() => undefined),
                stop:                  mock(() => undefined),
                updatePhase:           mock(async () => undefined),
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            const bot = createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
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
                once:    mock(() => mockClient),
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
                start:                 mock(() => undefined),
                stop:                  mock(() => { callOrder.push('stop'); }),
                updatePhase:           mock(async () => undefined),
                transitionCatchUpMode: mock(() => undefined),
            };
            spies.push(spyOn(presenceModule, 'createPresenceManager').mockReturnValue(mockPresenceManager));

            spies.push(spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                formatStatus: mock((status: string) => ({ name: status, type: 4 })),
            }));

            spies.push(spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                generate: mock(async () => ({ name: 'Idle', type: 4 })),
            }));

            const bot = createDiscordBot({
                config:          configWithPresence,
                onMessage:       mockOnMessage,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Test mock call inspection
            const calls = (mockClient.once as any).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = _filter(calls, ([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandlers[0]?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            await bot.stop();

            expect(callOrder).toEqual(['stop', 'destroy']);
        });
    });
});
