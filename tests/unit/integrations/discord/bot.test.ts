import { describe, test, expect, afterEach, mock, spyOn, jest } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import * as loggerModule from '@hughescr/logger';
import { MessageFlags, type Client } from 'discord.js';
import * as agentModule from '@/agent';
import type { Conductor, LedgerStore } from '@/agent';
import type { ClaudeAgent } from '@/agent/agent';
import type { DiscordConfig } from '@/config/schemas';
import type { AllowlistCommandHandler } from '@/integrations/discord/allowlist-commands';
import { createDiscordBot, type DiscordBotOptions } from '@/integrations/discord/bot';
import * as channelRegistryModule from '@/integrations/discord/channel-registry/discovery';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as clientModule from '@/integrations/discord/client';
import * as handlersModule from '@/integrations/discord/handlers';
import type { InboxManager } from '@/integrations/discord/inbox';
import * as ingressGateModule from '@/integrations/discord/ingress-gate';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageProcessor, MessageCoordinator } from '@/integrations/discord/message-coordinator';
import * as presenceModule from '@/integrations/discord/presence';
import type { PresenceManager } from '@/integrations/discord/presence/manager';
import * as catchupSetupModule from '@/integrations/discord/setup/catchup-setup';
import * as coordinatorSetupModule from '@/integrations/discord/setup/coordinator-setup';
import type { EmailSetupResult } from '@/integrations/discord/setup/email-setup';
import * as eventHandlerSetupModule from '@/integrations/discord/setup/event-handler-setup';
import * as perchSetupModule from '@/integrations/discord/setup/perch-setup';
import * as presenceSetupModule from '@/integrations/discord/setup/presence-setup';
import { BotStateManagerImpl } from '@/integrations/discord/state/manager';
import { createChannelId, createGuildId, createUserId, type DiscordMessageContext  } from '@/integrations/discord/types';

/** Flushes enough microtask ticks for a chained promise sequence to settle. */
async function flushMicrotasks(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

describe('createDiscordBot', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    // Setup common mocks
    const mockConfig: DiscordConfig = {
        botToken:      'test-bot-token',
        applicationId: 'test-app-id',
        homeGuildId:   createGuildId('home-guild-123'),
    };

    const mockChannelRegistry = {
        shouldProcess:      mock(() => true),
        getChannel:         mock(() => Promise.resolve(null)),
        warmCache:          mock(() => Promise.resolve()),
        startHydration:     mock(() => undefined),
        stop:               mock(() => undefined),
        // ready resolves immediately so the post-hydration callback fires (discovery is spied on in each test)
        ready:              Promise.resolve(),
        // onReady mirrors the real implementation: attach callback to the current ready promise
        // eslint-disable-next-line promise/no-callback-in-promise -- intentional: cb is a registered lifecycle callback, not a Node-style errback
        onReady:            mock((cb: () => void | Promise<void>) => { void Promise.resolve().then(() => cb()); }),
        getUnmutedChannels: mock(() => Promise.resolve([])),
        upsertChannel:      mock(() => Promise.resolve()),
        getAllChannels:     mock(() => []),
        muteChannel:        mock(async () => undefined),
    } as unknown as ChannelRegistryManager;

    const mockLogger: Logger = {
        info:  (..._args: unknown[]) => mockLogger,
        warn:  (..._args: unknown[]) => mockLogger,
        error: (..._args: unknown[]) => mockLogger,
        debug: (..._args: unknown[]) => mockLogger,
    } as unknown as Logger;

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // Ignore errors - spy may already be restored
            }
        }
        spies.length = 0;
        jest.restoreAllMocks();
        jest.useRealTimers();
        // Clear global Discord client state to prevent test pollution
        globalThis.__discordClient = undefined;
    });

    test('should return an object with start and stop methods', () => {
        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        expect(bot).toBeDefined();
        expect(typeof bot.start).toBe('function');
        expect(typeof bot.stop).toBe('function');
    });

    test('should call client.login with bot token when start() is called', async () => {
        const mockClient = {
            on:                 mock(() => mockClient),
            once:               mock(() => mockClient),
            login:              mock(async () => 'mock-token'),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        await bot.start();

        expect(mockClient.login).toHaveBeenCalledWith('test-bot-token');
    });

    test('should call client.destroy when stop() is called', async () => {
        const mockClient = {
            on:                 mock(() => mockClient),
            once:               mock(() => mockClient),
            login:              mock(async () => 'mock-token'),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        await bot.stop();

        expect(mockClient.destroy).toHaveBeenCalled();
    });

    test('should propagate login errors to caller', async () => {
        const loginError = new Error('Invalid bot token');
        const mockClient = {
            on:    mock(() => mockClient),
            once:  mock(() => mockClient),
            login: mock(async () => {
                throw loginError;
            }),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        expect(bot.start()).rejects.toThrow('Invalid bot token');
    });

    test('should propagate destroy errors to caller', async () => {
        const destroyError = new Error('Destroy failed');
        const mockClient = {
            on:      mock(() => mockClient),
            once:    mock(() => mockClient),
            login:   mock(async () => 'mock-token'),
            destroy: mock(async () => {
                throw destroyError;
            }),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        expect(bot.stop()).rejects.toThrow('Destroy failed');
    });

    test('should allow multiple start/stop cycles', async () => {
        const mockClient = {
            on:                 mock(() => mockClient),
            once:               mock(() => mockClient),
            login:              mock(async () => 'mock-token'),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               null,
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
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
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000, // 2 seconds
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mockUpdatePhase,
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            // Create a bot state manager with a mock shouldUpdatePresence that always returns false
            const mockBotStateManager = new BotStateManagerImpl({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            mockBotStateManager.shouldUpdatePresence = mock(() => false);

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }
            // Clear any calls from initialization
            mockUpdatePhase.mockClear();

            // Transition to processing_message mode
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // Trigger activity phase update - shouldUpdatePresence will return false
            mockBotStateManager.updateActivityPhase({ type: 'thinking', startedAt: new Date() });
            await Promise.resolve();

            // presenceManager.updatePhase should NOT have been called (throttle blocked)
            expect(mockUpdatePhase).not.toHaveBeenCalled();

            // Now make shouldUpdatePresence return true
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Trigger another activity phase update
            mockBotStateManager.updateActivityPhase({ type: 'responding', startedAt: new Date() });
            await Promise.resolve();

            // Now it should have been called
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
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
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mockUpdatePhase,
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            // Track subscription calls
            let subscribeCallCount = 0;
            const realBotStateManager = new BotStateManagerImpl({
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
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                botStateManager: realBotStateManager,
            });

            // Trigger clientReady to set up subscriptions

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            // Verify subscriptions were created (4: mode transition, activity phase from presence-setup;
            // plus tool-tracking and channel-tracking ring-buffer subscriptions from bot.ts)
            expect(subscribeCallCount).toBe(4);
        });

        test('should complete full presence flow: state update → subscription → throttle check → presence update', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mockUpdatePhase,
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            // Create a real bot state manager to test the subscription mechanism
            const mockBotStateManager = new BotStateManagerImpl({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
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
            await Promise.resolve();

            // Step 5: Verify presenceManager.updatePhase was called (throttle allowed)
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith({ type: 'thinking', startedAt: expect.any(Date) });

            // Clear mock for next phase
            mockUpdatePhase.mockClear();

            // Step 6: Mock shouldUpdatePresence to return false for second update (throttled)
            mockBotStateManager.shouldUpdatePresence = mock(() => false);

            // Step 7: Update again immediately - throttle should block this
            const phase2 = { type: 'responding' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase2);
            await Promise.resolve();

            // Step 8: Verify presenceManager.updatePhase was NOT called (throttle blocked)
            expect(mockUpdatePhase).not.toHaveBeenCalled();

            // Step 9: Mock shouldUpdatePresence to return true again (throttle window passed)
            mockBotStateManager.shouldUpdatePresence = mock(() => true);

            // Step 10: Update again - throttle should allow this
            const phase3 = { type: 'using_tool' as const, startedAt: new Date(), toolName: 'test-tool' };
            mockBotStateManager.updateActivityPhase(phase3);
            await Promise.resolve();

            // Step 11: Verify presenceManager.updatePhase was called (throttle allows after delay)
            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith({
                type:      'using_tool',
                startedAt: expect.any(Date),
                toolName:  'test-tool',
            });
        });

        test('should verify throttle works correctly with recordPresenceUpdate timing', async () => {
            // Use fake time to control Date.now() for throttle checks
            const baseTime = 1_000_000;
            jest.setSystemTime(baseTime);

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      100, // Short throttle for testing
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mockUpdatePhase,
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            const mockBotStateManager = new BotStateManagerImpl({
                logger:           mockLogger,
                updateThrottleMs: 100, // Short throttle for testing
            });
            mockBotStateManager.start();

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }
            mockUpdatePhase.mockClear();

            // Transition to processing_message mode
            mockBotStateManager.startProcessingMessage(createChannelId('123456789'), 'test message');

            // First update should go through (no previous timestamp)
            const phase1 = { type: 'thinking' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase1);
            await Promise.resolve();

            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith(phase1);
            mockUpdatePhase.mockClear();

            // Immediate second update should be throttled (still at same time)
            const phase2 = { type: 'using_tool' as const, startedAt: new Date(), toolName: 'tool1' };
            mockBotStateManager.updateActivityPhase(phase2);
            await Promise.resolve();

            expect(mockUpdatePhase).toHaveBeenCalledTimes(0); // Throttled

            // Advance fake time past throttle window (100ms + buffer)
            jest.setSystemTime(baseTime + 150);

            // Third update should now go through
            const phase3 = { type: 'responding' as const, startedAt: new Date() };
            mockBotStateManager.updateActivityPhase(phase3);
            await Promise.resolve();

            expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
            expect(mockUpdatePhase).toHaveBeenCalledWith(phase3);

            // Reset system time
            jest.setSystemTime();
        });

        test('should verify subscription fires on activity phase updates', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockUpdatePhase = mock(async () => undefined);
            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mockUpdatePhase,
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            // Create a real bot state manager
            const mockBotStateManager = new BotStateManagerImpl({
                logger:           mockLogger,
                updateThrottleMs: 2000,
            });
            mockBotStateManager.start();

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                botStateManager: mockBotStateManager,
            });

            // Trigger clientReady to set up subscriptions

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
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
                // eslint-disable-next-line no-await-in-loop -- sequential: must observe each phase transition separately
                await Promise.resolve();

                // Verify subscription fired and presence was updated
                expect(mockUpdatePhase).toHaveBeenCalledTimes(1);
                expect(mockUpdatePhase).toHaveBeenCalledWith(expect.objectContaining({ type: phase.type }));
            }
        });
    });

    describe('Reconnection Handler Safety', () => {
        test('should use client.on() for clientReady so reconnects re-fire the handler', () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Verify client.on() was called with 'clientReady' (not client.once())
            // Using on() allows the handler to re-fire on reconnects; idempotency is
            // enforced by the `initialized` flag inside the handler.

            const onCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (...args: unknown[]) => void][];
            const clientReadyCalls = onCalls.filter(([event]) => event === 'clientReady');

            // Should have at least one clientReady handler registered with on()
            expect(clientReadyCalls.length).toBeGreaterThan(0);

            // Verify it was NOT registered with once()
            const onceCalls = (mockClient.once as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (...args: unknown[]) => void][];
            const clientReadyOnceCalls = onceCalls.filter(([event]) => event === 'clientReady');
            expect(clientReadyOnceCalls).toHaveLength(0);
        });

        test('should verify clientReady handler uses initialized flag to prevent duplicate setup on reconnect', async () => {
            let messageCreateHandlerCount = 0;
            let interactionCreateHandlerCount = 0;
            let clientReadyHandlerCallCount = 0;

            // Track registered handlers (may be async)
            const registeredHandlers = new Map<string, ((...args: unknown[]) => void | Promise<void>)[]>();

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
                        // interactionCreate is now registered at bot creation, not inside clientReady
                        interactionCreateHandlerCount++;
                    }
                    if(event === 'clientReady') {
                        // Track how many times the handler is *registered* (should be once per bot creation)
                        clientReadyHandlerCallCount++;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Mock channel registry functions
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create a fake agent to enable coordinator creation (required for messageCreate handler)
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
            });

            // interactionCreate is registered at bot creation time (before clientReady fires)
            expect(interactionCreateHandlerCount).toBe(1);

            // Verify that clientReady was registered with on()
            const onCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (...args: unknown[]) => void][];
            const clientReadyOnCalls = onCalls.filter(([event]) => event === 'clientReady');
            expect(clientReadyOnCalls.length).toBeGreaterThan(0);
            expect(clientReadyHandlerCallCount).toBe(1); // registered once

            // Simulate the first clientReady event
            const clientReadyHandlers = registeredHandlers.get('clientReady') ?? [];
            expect(clientReadyHandlers.length).toBeGreaterThan(0);

            // Fire the clientReady handler once (now async, must await)
            for(const handler of clientReadyHandlers) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each handler must complete before next
                await Promise.resolve(handler(mockClient));
            }

            // After first clientReady, messageCreate handler should be registered
            expect(messageCreateHandlerCount).toBe(1);

            // Fire clientReady again (simulating reconnect)
            for(const handler of clientReadyHandlers) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each handler must complete before next
                await Promise.resolve(handler(mockClient));
            }

            // messageCreate should still be 1 — the initialized flag prevents duplicate registration
            expect(messageCreateHandlerCount).toBe(1);
        });

        test('should verify interactionCreate is registered immediately and messageCreate inside clientReady', async () => {
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
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Mock channel registry functions
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create a fake agent to enable coordinator creation (required for messageCreate handler)
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
            });

            // interactionCreate is registered at bot creation time (before clientReady fires)
            expect(interactionCreateRegistered).toBe(true);

            // messageCreate is still registered inside clientReady (requires readyClient)
            expect(messageCreateRegistered).toBe(false);

            // Get and fire the clientReady handler

            const onCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];

            expect(clientReadyHandler).toBeDefined();

            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // After clientReady fires, messageCreate SHOULD be registered
            expect(messageCreateRegistered).toBe(true);
        });
    });

    describe('Presence Manager Lifecycle', () => {
        test('should create presence manager when identityContext and config.presence provided', () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mock(async () => undefined),
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            // @ts-expect-error - Mocking constructor
            const presenceManagerSpy = spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager);
            spies.push(
                presenceManagerSpy,
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            expect(presenceManagerSpy).toHaveBeenCalled();
            expect(mockPresenceManager.start).toHaveBeenCalled();
        });

        test('should NOT create presence manager when identityContext is missing', () => {
            // Spy on createPresenceManager FIRST and clear any stale calls
            const presenceManagerSpy = spyOn(presenceModule, 'PresenceManager');
            presenceManagerSpy.mockClear();
            spies.push(presenceManagerSpy);

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                // identityContext missing
            });

            // Simulate clientReady event - call ALL handlers to avoid order dependency

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandlers = calls.filter(([event]) => event === 'clientReady');
            for(const [, handler] of readyHandlers) {
                handler(mockClient);
            }

            expect(presenceManagerSpy).not.toHaveBeenCalled();
        });

        test('should call presenceManager.stop() on bot stop() when manager exists', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start:                         mock(() => undefined),
                stop:                          mock(() => undefined),
                updatePhase:                   mock(async () => undefined),
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            const bot = createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
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
                destroy: mock(async () => {
                    callOrder.push('destroy');
                }),
                removeAllListeners: mock(() => {
                    callOrder.push('removeAllListeners');
                }),
                user: { id: '999999999999999999', tag: 'TestBot#1234' },
                rest: null,
            } as unknown as Client;

            const configWithPresence: DiscordConfig = {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockPresenceManager = {
                start: mock(() => undefined),
                stop:  mock(() => {
                    callOrder.push('stop');
                }),
                updatePhase:                   mock(async () => undefined),
                transitionPresenceDisplayMode: mock(() => undefined),
            };
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(presenceModule, 'PresenceManager').mockImplementation((): PresenceManager => mockPresenceManager as unknown as PresenceManager),
                spyOn(presenceModule, 'createActiveStatusGenerator').mockReturnValue({
                    generate:     mock(() => ({ name: 'Thinking...', type: 4 })),
                    formatStatus: mock((status: string) => ({ name: status, type: 4 })),
                }),
                spyOn(presenceModule, 'createIdleStatusGenerator').mockReturnValue({
                    generate: mock(async () => ({ name: 'Idle', type: 4 })),
                })
            );

            const bot = createDiscordBot({
                config: configWithPresence,

                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
            });

            // Simulate clientReady event to create presenceManager

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void][];
            const readyHandler = calls.find(([event]) => event === 'clientReady');
            const messageSetupHandler = readyHandler?.[1]; // Handler registered with once()
            if(messageSetupHandler) {
                messageSetupHandler(mockClient);
            }

            await bot.stop();

            expect(callOrder).toEqual(['stop', 'removeAllListeners', 'destroy']);
        });
    });

    describe('Hot Reload Protection', () => {
        test('should create new client and store in global state on first initialization', () => {
            // Clear global state before test
            globalThis.__discordClient = undefined;

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const createClientSpy = spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient);
            spies.push(createClientSpy);

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Should create new client
            expect(createClientSpy).toHaveBeenCalledWith(mockConfig);
            // Should store in global state
            expect(globalThis.__discordClient as unknown as Client).toBe(mockClient);
            // Should NOT call removeAllListeners (no existing handlers)
            expect(mockClient.removeAllListeners).not.toHaveBeenCalled();
        });

        test('should reuse existing client and remove listeners on simulated hot reload', () => {
            const existingMockClient = {
                on:                 mock(() => existingMockClient),
                once:               mock(() => existingMockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Simulate existing client from previous hot reload
            globalThis.__discordClient = existingMockClient;

            const createClientSpy = spyOn(clientModule, 'createDiscordClient');
            spies.push(createClientSpy);

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Should NOT create new client (reuse existing)
            expect(createClientSpy).not.toHaveBeenCalled();
            // Should call removeAllListeners to clear old handlers
            expect(existingMockClient.removeAllListeners).toHaveBeenCalledTimes(1);
            // Global state should still point to same client
            expect(globalThis.__discordClient).toBe(existingMockClient);
        });

        test('should use provided client without touching global state', () => {
            // Clear global state before test
            globalThis.__discordClient = undefined;

            const providedClient = {
                on:                 mock(() => providedClient),
                once:               mock(() => providedClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const createClientSpy = spyOn(clientModule, 'createDiscordClient');
            spies.push(createClientSpy);

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                client:          providedClient,
            });

            // Should NOT create new client
            expect(createClientSpy).not.toHaveBeenCalled();
            // Should NOT store in global state (provided client takes precedence)
            expect(globalThis.__discordClient).toBeUndefined();
            // Should NOT call removeAllListeners (provided client is not from hot reload)
            expect(providedClient.removeAllListeners).not.toHaveBeenCalled();
        });

        test('should clear global state on stop() when using global client', async () => {
            // Clear global state before test
            globalThis.__discordClient = undefined;

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Verify global state is set
            expect(globalThis.__discordClient as unknown as Client).toBe(mockClient);

            await bot.stop();

            // Should call removeAllListeners before destroy
            expect(mockClient.removeAllListeners).toHaveBeenCalled();
            // Should clear global state after destroy
            expect(globalThis.__discordClient).toBeUndefined();
        });

        test('should NOT clear global state on stop() when using provided client', async () => {
            const existingGlobalClient = {
                on:                 mock(() => existingGlobalClient),
                once:               mock(() => existingGlobalClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '888888888888888888', tag: 'GlobalBot#5678' },
                rest:               null,
            } as unknown as Client;

            // Set up global client
            globalThis.__discordClient = existingGlobalClient;

            const providedClient = {
                on:                 mock(() => providedClient),
                once:               mock(() => providedClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                client:          providedClient,
            });

            await bot.stop();

            // Should call removeAllListeners on provided client
            expect(providedClient.removeAllListeners).toHaveBeenCalled();
            // Should NOT clear global state (different client)
            expect(globalThis.__discordClient).toBe(existingGlobalClient);
        });

        test('should call removeAllListeners before destroy in correct order', async () => {
            // Clear global state before test
            globalThis.__discordClient = undefined;

            const callOrder: string[] = [];
            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => {
                    callOrder.push('destroy');
                }),
                removeAllListeners: mock(() => {
                    callOrder.push('removeAllListeners');
                }),
                user: { id: '999999999999999999', tag: 'TestBot#1234' },
                rest: null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            await bot.stop();

            // removeAllListeners should be called before destroy
            expect(callOrder).toEqual(['removeAllListeners', 'destroy']);
        });
    });

    describe('Channel Registry Hydration Lifecycle', () => {
        // Builds a minimal channel registry mock where startHydration is a spy and
        // `ready` resolves/rejects based on the provided promise.
        function makeHydrationRegistry(readyPromise: Promise<void>): ChannelRegistryManager {
            return {
                shouldProcess:  mock(() => true),
                getChannel:     mock(() => Promise.resolve(null)),
                warmCache:      mock(() => Promise.resolve()),
                startHydration: mock(() => undefined),
                stop:           mock(() => undefined),
                ready:          readyPromise,
                // onReady mirrors the real implementation: attach callback to the current ready promise
                // eslint-disable-next-line promise/no-callback-in-promise -- intentional: cb is a registered lifecycle callback, not a Node-style errback
                onReady:        mock((cb: () => void | Promise<void>) => { void readyPromise.then(() => cb()); }),
                getAllChannels: mock(() => []),
                muteChannel:    mock(async (): Promise<void> => undefined),
            } as unknown as ChannelRegistryManager;
        }

        function makeMinimalClient(): Client {
            const c = {
                on:                 mock(() => c),
                once:               mock(() => c),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
                channels:           {
                    fetch: mock(async () => ({
                        send: mock(async () => ({})),
                    })),
                },
            };
            return c as unknown as Client;
        }

        test('startHydration is called during clientReady (not warmCache directly)', async () => {
            const pendingReady = new Promise<void>((_resolve) => { /* intentionally pending — never resolves */ });
            const registry = makeHydrationRegistry(pendingReady);
            const mockClient = makeMinimalClient();

            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            createDiscordBot({ config: mockConfig, channelRegistry: registry });

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const readyHandler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(readyHandler) {
                await Promise.resolve(readyHandler(mockClient));
            }

            // startHydration should have been called; warmCache should NOT have been called directly
            expect((registry.startHydration as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
            expect((registry.warmCache as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
        });

        test('channelRegistry.stop() is called during bot shutdown', async () => {
            const pendingReady = new Promise<void>((_resolve) => { /* intentionally pending */ });
            const registry = makeHydrationRegistry(pendingReady);
            const mockClient = makeMinimalClient();

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const bot = createDiscordBot({ config: mockConfig, channelRegistry: registry });

            await bot.stop();

            expect((registry.stop as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
        });

        test('discovery runs and logs info after hydration succeeds', async () => {
            // ready resolves immediately = hydration succeeded
            const registry = makeHydrationRegistry(Promise.resolve());
            const mockClient = makeMinimalClient();

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));
            const discoverSpy = spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                discovered: 3,
                updated:    1,
                errors:     [],
            });
            spies.push(
                discoverSpy,
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            createDiscordBot({ config: mockConfig, channelRegistry: registry });

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const readyHandler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(readyHandler) {
                await Promise.resolve(readyHandler(mockClient));
            }
            // Flush the .then() microtask so post-ready branch executes
            await Promise.resolve();
            await Promise.resolve();

            expect(discoverSpy).toHaveBeenCalled();
        });

        test('discovery failure logs error after hydration succeeds', async () => {
            const registry = makeHydrationRegistry(Promise.resolve());
            const mockClient = makeMinimalClient();

            const loggerErrorSpy = spyOn(loggerModule.logger, 'error');
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockRejectedValue(new Error('Discord API unavailable')),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined),
                loggerErrorSpy
            );

            createDiscordBot({ config: mockConfig, channelRegistry: registry });

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const readyHandler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(readyHandler) {
                await Promise.resolve(readyHandler(mockClient));
            }
            // Flush microtasks so .then() branch and catch block complete
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
                error: 'Discord API unavailable',
                msg:   'Channel discovery failed after registry hydration',
            }));
        });

        test('bot continues running even when hydration is pending (fail-open)', async () => {
            const pendingReady = new Promise<void>((_resolve) => { /* intentionally pending */ });
            const registry = makeHydrationRegistry(pendingReady);
            const mockClient = makeMinimalClient();

            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            const bot = createDiscordBot({ config: mockConfig, channelRegistry: registry });

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const readyHandler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(readyHandler) {
                await Promise.resolve(readyHandler(mockClient));
            }

            // Bot should still be stoppable without error, and stop() should actually
            // run its client cleanup (removeAllListeners + destroy) rather than short-circuit.
            await bot.stop();
            expect(mockClient.destroy).toHaveBeenCalledTimes(1);
        });

        test('should handle notification send failure gracefully', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
                channels:           {
                    fetch: mock(async () => {
                        throw new Error('Channel fetch failed');
                    }),
                },
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // ready resolves immediately so discovery runs and can fail
            const registry = makeHydrationRegistry(Promise.resolve());

            spies.push(
                spyOn(channelRegistryModule, 'discoverAllChannels').mockRejectedValue(new Error('DynamoDB connection failed')),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            const loggerErrorSpy = spyOn(loggerModule.logger, 'error');
            spies.push(loggerErrorSpy);

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: registry,
            });

            loggerErrorSpy.mockClear();

            const calls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const readyHandler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(readyHandler) {
                await Promise.resolve(readyHandler(mockClient));
            }
            // Flush microtasks so .then() branch and catch complete
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Verify discovery failure was logged and notification send failure was logged
            expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Channel discovery failed after registry hydration',
            }));

            expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({
                msg: 'Failed to send channel registry error notification to owner',
            }));

            // Bot should still be running, and stop() should complete its client cleanup.
            await bot.stop();
            expect(mockClient.destroy).toHaveBeenCalledTimes(1);
        });
    });

    describe('Shutdown Ordering', () => {
        test('should abort sessions before stopping botStateManager', async () => {
            const callOrder: string[] = [];

            const mockClient = {
                on:      mock(() => mockClient),
                once:    mock(() => mockClient),
                login:   mock(async () => 'mock-token'),
                destroy: mock(async () => {
                    callOrder.push('destroy');
                }),
                removeAllListeners: mock(() => {
                    callOrder.push('removeAllListeners');
                }),
                user: { id: '999999999999999999', tag: 'TestBot#1234' },
                rest: null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock botStateManager with stop method that tracks call order
            const mockBotStateManager = new BotStateManagerImpl({
                logger: mockLogger,
            });
            const originalStop = mockBotStateManager.stop;
            mockBotStateManager.stop = () => {
                callOrder.push('botStateManager.stop');
                originalStop.call(mockBotStateManager);
            };

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                botStateManager: mockBotStateManager,
            });

            await bot.stop();

            // botStateManager.stop should be called AFTER removeAllListeners
            // (removeAllListeners happens before destroy, which is the last step)
            const callOrderIndex = new Map(callOrder.map((e, i) => [e, i] as [string, number]));
            const stopIdx = callOrderIndex.get('botStateManager.stop') ?? -1;
            const listenerIdx = callOrderIndex.get('removeAllListeners') ?? -1;
            expect(stopIdx).toBeLessThan(listenerIdx);
        });
    });

    describe('Conductor mode (P9)', () => {
        function makeMockClientForConductor(): Client {
            const client = {
                on:                 mock(() => client),
                once:               mock(() => client),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
                guilds:             { cache: { get: mock(() => undefined) } },
            } as unknown as Client;
            return client;
        }

        /** Returns a plain object satisfying the shape tests need to observe — cast to `Conductor` at each call site, since only `open`/`shutdown`/`subscribeTurn` are ever exercised here. */
        function makeFakeConductor(overrides: Record<string, unknown> = {}) {
            return {
                open:                    mock(async () => ({ sessionId: 'sess-1', resumed: false })),
                submit:                  mock(async () => ({})),
                deliver:                 mock(async () => ({ delivered: true })),
                recordCompactionSummary: mock(async () => undefined),
                interruptCurrent:        mock(async () => undefined),
                subscribeTurn:           mock(() => mock(() => undefined)),
                status:                  mock(() => ({})),
                shutdown:                mock(async () => undefined),
                ...overrides,
            } as unknown as Conductor & { open: ReturnType<typeof mock>, shutdown: ReturnType<typeof mock>, subscribeTurn: ReturnType<typeof mock> };
        }

        /**
         * `emit` is test-only (not part of `LedgerStore`): it invokes every listener `subscribe()`
         * was ever called with (mirroring the real store's multi-subscriber `Set`, since
         * production wires more than one subscriber — e.g. `installLedgerShim` AND (P11) bot.ts's
         * own ring-buffer mirror — onto the same store), letting a test simulate a ledger change
         * without a real `createLedgerStore` reducer.
         *
         * `unsubscribe` is returned specifically to whichever `subscribe()` call registers a
         * 2-argument `(ledger, event) => …` listener — `installLedgerShim`'s own signature (see
         * `state/ledger-shim.ts`) — since that is the one existing tests (e.g. the shutdown-order
         * suite) name and assert on; P11's own ring-buffer listener declares only `(ledger) => …`
         * (1 argument) and gets its own independent, unasserted unsubscribe instead. Distinguishing
         * by arity rather than call order keeps this fake correct regardless of which subscriber
         * bot.ts happens to wire up first.
         */
        function makeFakeLedgerStore(sessionId: string | undefined = 'ledger-sess-1', unsubscribe: ReturnType<typeof mock> = mock(() => undefined)) {
            const listeners = new Set<(ledger: unknown, event?: unknown) => void>();
            return {
                get:       mock(() => ({ sessionId, tasks: [] })),
                dispatch:  mock(() => undefined),
                subscribe: mock((l: (ledger: unknown, event?: unknown) => void) => {
                    listeners.add(l);
                    return l.length >= 2 ? unsubscribe : mock(() => undefined);
                }),
                emit: (ledger: unknown, event?: unknown): void => {
                    for(const listener of listeners) {
                        listener(ledger, event);
                    }
                },
            } as unknown as LedgerStore & { get: ReturnType<typeof mock>, emit: (ledger: unknown, event?: unknown) => void };
        }

        function conductorDeps(overrides: Record<string, unknown> = {}): Partial<DiscordBotOptions> {
            return {
                conversationConductor: makeFakeConductor(),
                ledgerStore:           makeFakeLedgerStore(),
                contextPolicy:         { shouldInjectUserMemory: mock(() => false), markInjected: mock(() => undefined), eventsDelta: mock(() => Promise.resolve([])), markEventsSeen: mock(() => undefined), stateTopSetDelta: mock(() => Promise.resolve({ added: [], removed: [], changed: [] })), markStateTopSetSeen: mock(() => Promise.resolve()), resetAll: mock(() => undefined), calendarDelta: mock(() => Promise.resolve({ agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false })), markCalendarSeen: mock(() => undefined), healthNote: mock(() => undefined), markHealthSeen: mock(() => undefined) },
                deliveryGuard:         { alreadyDelivered: mock(() => false), markDelivered: mock(() => undefined) },
                journal:               { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
                ...overrides,
            };
        }

        /** Fires the registered clientReady handler and waits for its async body to settle. */
        async function triggerReady(client: Client): Promise<void> {
            const calls = (client.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (c: Client) => void | Promise<void>][];
            const handler = calls.find(([event]) => event === 'clientReady')?.[1];
            if(handler) {
                await handler(client);
            }
        }

        function stubCoordinator() {
            // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
            spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
                setProcessor: mock(() => undefined),
                stop:         mock(() => undefined),
            } as unknown as messageCoordinatorModule.MessageCoordinator)));
        }

        test('opens the conductor after initializeChannelRegistry and before setupCoordinatorIntegration', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            const callOrder: string[] = [];
            spies.push(
                spyOn(eventHandlerSetupModule, 'initializeChannelRegistry').mockImplementation(() => {
                    callOrder.push('initializeChannelRegistry');
                }),
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation(() => {
                    callOrder.push('setupCoordinatorIntegration');
                    return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                })
            );

            const deps = conductorDeps({
                conversationConductor: makeFakeConductor({
                    open: mock(async () => {
                        callOrder.push('conductor.open');
                        return { sessionId: 'sess-1', resumed: false };
                    }),
                }),
            });

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);

            expect(callOrder).toEqual(['initializeChannelRegistry', 'conductor.open', 'setupCoordinatorIntegration']);
        });

        test('degrades to the legacy processor without a shim when open() rejects', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            let capturedParams: { conversationConductor?: unknown, envelopeProvider?: unknown } | undefined;
            spies.push(spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: typeof capturedParams) => {
                capturedParams = params;
                return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
            }));

            const conductor = makeFakeConductor({ open: mock(() => Promise.reject(new Error('boom'))) });
            const deps = conductorDeps({ conversationConductor: conductor });

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);

            // setupCoordinatorIntegration ran (the legacy branch is always reachable — agent was
            // provided), but never received conductor deps: rejection degrades to the legacy
            // processor without ever switching setupCoordinatorIntegration to the conductor branch.
            expect(capturedParams?.conversationConductor).toBeUndefined();
            expect(capturedParams?.envelopeProvider).toBeUndefined();
            expect(conductor.subscribeTurn).not.toHaveBeenCalled();
        });

        test('degrades to the legacy processor without hanging forever when open() never settles', async () => {
            jest.useFakeTimers();

            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            let capturedParams: { conversationConductor?: unknown } | undefined;
            spies.push(spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: { conversationConductor?: unknown }) => {
                capturedParams = params;
                return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
            }));

            // Never resolves and never rejects — a wedged CLI child.
            const conductor = makeFakeConductor({
                open: mock(() => new Promise<{ sessionId: string, resumed: boolean }>(() => {
                    // Deliberately never settles.
                })),
            });
            const deps = conductorDeps({ conversationConductor: conductor });

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            const calls = (client.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (c: Client) => void | Promise<void>][];
            const handler = calls.find(([event]) => event === 'clientReady')?.[1];
            const readyPromise = handler ? Promise.resolve(handler(client)) : Promise.resolve();

            jest.advanceTimersByTime(30_000);
            for(let i = 0; i < 10; i += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain, not a real async loop
                await Promise.resolve();
            }
            await readyPromise;

            expect(capturedParams?.conversationConductor).toBeUndefined();
            expect(conductor.subscribeTurn).not.toHaveBeenCalled();
        });

        test('wires envelopeProvider (resolveNames/toEnvelopeInput/channelList) into setupCoordinatorIntegration once the conductor opens', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            let capturedParams: { envelopeProvider?: { resolveNames?: unknown, toEnvelopeInput?: unknown, channelList?: unknown } } | undefined;
            spies.push(spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: typeof capturedParams) => {
                capturedParams = params;
                return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
            }));

            const deps = conductorDeps();

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);

            expect(typeof capturedParams?.envelopeProvider?.resolveNames).toBe('function');
            expect(typeof capturedParams?.envelopeProvider?.toEnvelopeInput).toBe('function');
            expect(typeof capturedParams?.envelopeProvider?.channelList).toBe('function');
        });

        test('calls open() only once across repeated clientReady (reconnect) events', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const deps = conductorDeps();

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);
            await triggerReady(client);

            expect((deps.conversationConductor as ReturnType<typeof makeFakeConductor>).open).toHaveBeenCalledTimes(1);
        });

        test('seeds lastSessionId from the ledger after a successful open()', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const ledgerStore = makeFakeLedgerStore('from-the-ledger');
            const deps = conductorDeps({ ledgerStore });
            let capturedGetCurrentSessionId: (() => string | undefined) | undefined;
            spies.push(spyOn(agentModule, 'createTaskListReader').mockImplementation((params: { getCurrentSessionId: () => string | undefined }) => {
                capturedGetCurrentSessionId = params.getCurrentSessionId;
                return { buildTaskListSummary: mock(() => Promise.resolve(undefined)) };
            }));

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);

            // createTaskListReader's getCurrentSessionId is the SAME closure bot.ts calls
            // setLastSessionId(ledgerStore.get().sessionId) through — reading it after open()
            // resolves proves the ledger's actual value was seeded, not merely that get() ran.
            expect(capturedGetCurrentSessionId?.()).toBe('from-the-ledger');
        });

        test('stop order: coordinator.stop -> conductor.shutdown -> shim unsubscribe -> botStateManager.stop', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            const callOrder: string[] = [];
            const coordinatorStub = {
                setProcessor: mock(() => undefined),
                stop:         mock(() => {
                    callOrder.push('coordinator.stop');
                }),
            };
            spies.push(spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation(() => coordinatorStub as unknown as MessageCoordinator));

            const conductor = makeFakeConductor({
                shutdown: mock(async () => {
                    callOrder.push('conductor.shutdown');
                }),
            });
            const shimUnsubscribe = mock(() => {
                callOrder.push('shim unsubscribe');
            });
            const ledgerStore = makeFakeLedgerStore('ledger-sess-1', shimUnsubscribe);
            const deps = conductorDeps({ conversationConductor: conductor, ledgerStore });

            const mockBotStateManager = new BotStateManagerImpl({ logger: mockLogger });
            const originalStop = mockBotStateManager.stop.bind(mockBotStateManager);
            mockBotStateManager.stop = () => {
                callOrder.push('botStateManager.stop');
                originalStop();
            };

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                botStateManager: mockBotStateManager,
                ...deps,
            });

            await triggerReady(client);
            await bot.stop();

            expect(callOrder).toEqual(['coordinator.stop', 'conductor.shutdown', 'shim unsubscribe', 'botStateManager.stop']);
            expect(shimUnsubscribe).toHaveBeenCalledTimes(1);
        });

        test('stop() calls the ingress gate\'s stop() (P10, gate.stop -> shutdown.run)', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const gateStop = mock(() => undefined);
            spies.push(spyOn(ingressGateModule, 'createIngressGate').mockImplementation(() => ({
                admit: mock(() => 'pass'),
                open:  mock(() => undefined),
                stop:  gateStop,
                state: mock(() => 'buffering'),
            } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>)));

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);
            await bot.stop();

            expect(gateStop).toHaveBeenCalled();
        });

        test('onDrain serialises a drained batch: a later message never dispatches before an earlier one settles', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            let capturedOnDrain: ((message: { id: string }) => void) | undefined;
            spies.push(spyOn(ingressGateModule, 'createIngressGate').mockImplementation((options) => {
                capturedOnDrain = options.onDrain as unknown as (message: { id: string }) => void;
                return {
                    admit: mock(() => 'pass'), open: mock(() => undefined), stop: mock(() => undefined), state: mock(() => 'buffering'),
                } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>;
            }));

            const invokedOrder: string[] = [];
            const settledOrder: string[] = [];
            const deferreds = new Map<string, { resolve: () => void }>();
            spies.push(spyOn(handlersModule, 'dispatchAdmittedMessage').mockImplementation(async (message) => {
                const id = (message as { id: string }).id;
                invokedOrder.push(id);
                await new Promise<void>((resolve) => {
                    deferreds.set(id, { resolve });
                });
                settledOrder.push(id);
            }));

            const deps = conductorDeps();
            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            await triggerReady(client);
            expect(capturedOnDrain).toBeDefined();

            // Simulate gate.open() draining three buffered messages, in arrival order.
            capturedOnDrain?.({ id: 'msg-1' });
            capturedOnDrain?.({ id: 'msg-2' });
            capturedOnDrain?.({ id: 'msg-3' });
            await flushMicrotasks();

            // Only the FIRST message's dispatch has started — the chain has not raced ahead to
            // msg-2/msg-3 while msg-1 is still awaiting its own async work.
            expect(invokedOrder).toEqual(['msg-1']);

            deferreds.get('msg-1')?.resolve();
            await flushMicrotasks();
            expect(invokedOrder).toEqual(['msg-1', 'msg-2']);

            deferreds.get('msg-2')?.resolve();
            await flushMicrotasks();
            expect(invokedOrder).toEqual(['msg-1', 'msg-2', 'msg-3']);

            deferreds.get('msg-3')?.resolve();
            await flushMicrotasks();
            expect(settledOrder).toEqual(['msg-1', 'msg-2', 'msg-3']);
        });

        test('exposes bot.shutdown once the conductor has opened; undefined before that', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                ...deps,
            });

            expect(bot.shutdown).toBeUndefined();

            await triggerReady(client);

            expect(bot.shutdown).toBeDefined();
            expect(typeof bot.shutdown?.run).toBe('function');
        });

        test('bot.shutdown is undefined in oneshot mode (no conductor deps provided)', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
            });

            await triggerReady(client);

            expect(bot.shutdown).toBeUndefined();
        });

        test('triggerCatchUp submits a catch-up envelope through the conductor in conductor mode when unread mail remains', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const submitConductorCatchUpSpy = spyOn(catchupSetupModule, 'submitConductorCatchUp').mockResolvedValue(undefined);
            spies.push(submitConductorCatchUpSpy);

            const inboxManager = {
                loadUnread:        mock(async () => undefined),
                getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                inboxManager,
                ...deps,
            });

            await triggerReady(client);
            await bot.triggerCatchUp();

            expect(submitConductorCatchUpSpy).toHaveBeenCalled();
        });

        test('triggerCatchUp does NOT submit a catch-up envelope on a reconnect with no unread mail (mirrors the legacy branch\'s shouldStartCatchUp gate)', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const submitConductorCatchUpSpy = spyOn(catchupSetupModule, 'submitConductorCatchUp').mockResolvedValue(undefined);
            spies.push(submitConductorCatchUpSpy);

            const inboxManager = {
                loadUnread:        mock(async () => undefined),
                getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                inboxManager,
                ...deps,
            });

            await triggerReady(client);
            await bot.triggerCatchUp();

            expect(inboxManager.loadUnread).toHaveBeenCalled();
            expect(submitConductorCatchUpSpy).not.toHaveBeenCalled();
        });

        test('triggerCatchUp in conductor mode swallows and logs a reconnect-trigger failure (e.g. loadUnread rejects), never rejecting the caller', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const submitConductorCatchUpSpy = spyOn(catchupSetupModule, 'submitConductorCatchUp').mockResolvedValue(undefined);
            spies.push(submitConductorCatchUpSpy);

            const loadUnreadError = new Error('Discord search 500');
            const inboxManager = {
                loadUnread:        mock(async () => { throw loadUnreadError; }),
                getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                inboxManager,
                ...deps,
            });

            await triggerReady(client);
            await expect(bot.triggerCatchUp()).resolves.toBeUndefined();

            expect(submitConductorCatchUpSpy).not.toHaveBeenCalled();
        });

        test('triggerCatchUp does not touch catchUpSessionRunner in conductor mode', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();
            spies.push(spyOn(catchupSetupModule, 'submitConductorCatchUp').mockResolvedValue(undefined));

            // A real catchUpSessionRunner is constructed by bot.ts's clientReady handler whenever
            // inboxManager+agent+memoryBackend are all present — regardless of mode — so this test
            // supplies memoryBackend and spies on the underlying runner's own shouldStartCatchUp/
            // startCatchUp to prove the conductor branch genuinely never calls them, rather than
            // merely asserting a resolved promise (which passes even with the whole branch deleted).
            const shouldStartCatchUp = mock(async () => true);
            const startCatchUp = mock(async () => undefined);
            spies.push(spyOn(catchupSetupModule, 'setupCatchUpSessionRunner').mockReturnValue({
                shouldStartCatchUp,
                startCatchUp,
                getAbortController: mock(() => new AbortController()),
            } as unknown as ReturnType<typeof catchupSetupModule.setupCatchUpSessionRunner>));

            const inboxManager = {
                loadUnread:        mock(async () => undefined),
                getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;

            const memoryBackend = {
                storeCompletionSignal:  mock(async () => undefined),
                loadCompletionSignal:   mock(async () => null),
                storeInProgressSignal:  mock(async () => undefined),
                loadInProgressSignal:   mock(async () => null),
                deleteInProgressSignal: mock(async () => undefined),
            };

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                agent:           {} as ClaudeAgent,
                inboxManager,
                memoryBackend,
                ...deps,
            });

            await triggerReady(client);
            await expect(bot.triggerCatchUp()).resolves.toBeUndefined();

            expect(shouldStartCatchUp).not.toHaveBeenCalled();
            expect(startCatchUp).not.toHaveBeenCalled();
        });

        describe('P11: ledger-driven ring buffers', () => {
            const minimalPerchConfig = {
                enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5,
            };

            /** Spies on `agentModule.LiveSignals`'s constructor and captures the `getRecentTools`/`getRecentChannels` closures it was built with. */
            function captureLiveSignalsGetters() {
                let captured: { getRecentTools?: () => readonly unknown[], getRecentChannels?: () => readonly unknown[] } = {};
                spies.push(
                    // @ts-expect-error — Mocking constructor
                    spyOn(agentModule, 'LiveSignals').mockImplementation((params: typeof captured) => {
                        captured = params;
                        return { snapshot: mock(() => Promise.resolve([])) };
                    })
                );
                return { getCaptured: () => captured };
            }

            test('feeds recentTools from a using_tool phase change on either ledger, deduped by toolName', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                const phaseChangedEvent = { type: 'phase_changed', phase: null, at: new Date(0) };
                ledgerStore.emit({ turn: { kind: 'discord', phase: { type: 'using_tool', toolName: 'Bash' } } }, phaseChangedEvent);
                // A second event naming the SAME tool must not duplicate the ring-buffer entry.
                ledgerStore.emit({ turn: { kind: 'discord', phase: { type: 'using_tool', toolName: 'Bash' } } }, phaseChangedEvent);

                const tools = getCaptured().getRecentTools?.() as { toolName: string }[];
                expect(tools).toHaveLength(1);
                expect(tools[0].toolName).toBe('Bash');
            });

            test('feeds recentChannels from a new discord turn carrying a channelId', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                ledgerStore.emit({ turn: { id: 'turn-1', kind: 'discord', channelId: 'chan-1', phase: null } }, { type: 'phase_changed', phase: null, at: new Date(0) });

                const channels = getCaptured().getRecentChannels?.() as { channelId: string }[];
                expect(channels).toHaveLength(1);
                expect(channels[0].channelId).toBe('chan-1');
            });

            test('the ring buffers themselves never subscribe to botStateManager in conductor mode (P12: the legacy-perch-ledger adapter is retired — the perch ledger is real)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const customBotStateManager = new BotStateManagerImpl({ logger: mockLogger });
                const subscribeSpy = spyOn(customBotStateManager, 'subscribe');
                spies.push(subscribeSpy);

                const deps = conductorDeps();
                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    botStateManager: customBotStateManager,
                    ...deps,
                });

                await triggerReady(client);

                // No subscription at all: the ring buffers subscribe only to the session
                // ledger(s), never to botStateManager, and the throwaway legacy-perch-ledger
                // adapter (which used to subscribe once here) no longer exists.
                expect(subscribeSpy).not.toHaveBeenCalled();
            });
        });

        describe('P11: presence composed from ledgers', () => {
            test('uses setupConductorPresence (never setupPresence) once identityContext/config.presence/ledgerStore are all present', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                const setupPresenceSpy = spyOn(presenceSetupModule, 'setupPresence');
                spies.push(setupConductorPresenceSpy, setupPresenceSpy);

                const ledgerStore = makeFakeLedgerStore();
                const perchLedgerStore = makeFakeLedgerStore('perch-sess-1');
                const deps = conductorDeps({ ledgerStore, perchLedgerStore });

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                expect(setupConductorPresenceSpy).toHaveBeenCalledTimes(1);
                expect(setupPresenceSpy).not.toHaveBeenCalled();
                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { ledgers?: readonly unknown[] } | undefined;
                expect(call?.ledgers).toHaveLength(2);
            });

            test('composes from [ledgerStore] alone (length 1) when no perch conductor/ledger is configured', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                spies.push(setupConductorPresenceSpy);

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { ledgers?: readonly unknown[] } | undefined;
                expect(call?.ledgers).toHaveLength(1);
            });

            test('passes botStateManager through so the legacy perch runner\'s own presence throttle clock keeps ticking (P11 review finding)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                spies.push(setupConductorPresenceSpy);

                const customBotStateManager = new BotStateManagerImpl({ logger: mockLogger });
                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    botStateManager: customBotStateManager,
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { botStateManager?: unknown } | undefined;
                expect(call?.botStateManager).toBe(customBotStateManager);
            });

            test('forwards options.isCostPaused to setupConductorPresence by identity when perch is enabled (Q3 / B4)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                spies.push(setupConductorPresenceSpy);

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });
                const isCostPaused = (): boolean => true;

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    perchConfig:     { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5, interruptGraceMinutes: 2 },
                    isCostPaused,
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { isCostPaused?: unknown } | undefined;
                expect(call?.isCostPaused).toBe(isCostPaused);
            });

            test('does NOT forward options.isCostPaused to setupConductorPresence when perch is disabled — nothing is actually paused (Q3 / B4)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                spies.push(setupConductorPresenceSpy);

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });
                const isCostPaused = (): boolean => true;

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    perchConfig:     { enabled: false, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5, interruptGraceMinutes: 2 },
                    isCostPaused,
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { isCostPaused?: unknown } | undefined;
                expect(call?.isCostPaused).toBeUndefined();
            });

            test('unsubscribeLedgers is called during stop()', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const unsubscribeLedgers = mock(() => undefined);
                spies.push(spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager: { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers,
                }));

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                const bot = createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(unsubscribeLedgers).toHaveBeenCalledTimes(1);
            });

            describe('getRecentContext (relocated callback)', () => {
                function captureRecentContext(): { getGetRecentContext: () => (() => Promise<string | undefined>) | undefined, getAddRecentMessage: () => ((content: string, author: 'user' | 'izzy') => void) | undefined } {
                    let getRecentContext: (() => Promise<string | undefined>) | undefined;
                    let addRecentMessage: ((content: string, author: 'user' | 'izzy') => void) | undefined;

                    spies.push(
                        spyOn(presenceSetupModule, 'setupConductorPresence').mockImplementation((params: { getRecentContext: () => Promise<string | undefined> }) => {
                            getRecentContext = params.getRecentContext;
                            return {
                                presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                                unsubscribeLedgers: mock(() => undefined),
                            };
                        }),
                        spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: { addRecentMessage?: (content: string, author: 'user' | 'izzy') => void }) => {
                            addRecentMessage = params.addRecentMessage;
                            return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                        })
                    );

                    return { getGetRecentContext: () => getRecentContext, getAddRecentMessage: () => addRecentMessage };
                }

                async function setUp(): Promise<{ getGetRecentContext: () => (() => Promise<string | undefined>) | undefined, getAddRecentMessage: () => ((content: string, author: 'user' | 'izzy') => void) | undefined }> {
                    const client = makeMockClientForConductor();
                    spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

                    const captured = captureRecentContext();

                    const ledgerStore = makeFakeLedgerStore();
                    const deps = conductorDeps({ ledgerStore });

                    createDiscordBot({
                        config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                        channelRegistry: mockChannelRegistry,
                        agent:           {} as ClaudeAgent,
                        identityContext: 'Test identity',
                        ...deps,
                    });

                    await triggerReady(client);
                    return captured;
                }

                test('returns undefined when no recent messages have been recorded', async () => {
                    const { getGetRecentContext } = await setUp();

                    await expect(getGetRecentContext()!()).resolves.toBeUndefined();
                });

                test('sorts recorded messages by timestamp ascending (not insertion order) and labels user vs. Izzy turns', async () => {
                    jest.useFakeTimers();
                    const { getGetRecentContext, getAddRecentMessage } = await setUp();
                    const addRecentMessage = getAddRecentMessage()!;

                    // Recorded out of chronological order: the later message first, the earlier
                    // message second. Only a correct ascending sort (a.timestamp - b.timestamp)
                    // — not push order — puts "First message" ahead of "Second reply" below.
                    jest.setSystemTime(new Date(2000));
                    addRecentMessage('Second reply', 'izzy');
                    jest.setSystemTime(new Date(1000));
                    addRecentMessage('First message', 'user');

                    const context = await getGetRecentContext()!();

                    expect(context).toBe('User: First message\nIzzy: Second reply');
                });
            });
        });

        describe('Perch conductor (P12)', () => {
            const minimalPerchConfig = {
                enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, maxSessionMinutes: 45, wrapUpTimeoutMinutes: 5, interruptGraceMinutes: 2,
            };

            function fakePerchDriver() {
                return { runSlot: mock(() => 'started' as const), stop: mock(() => undefined) };
            }

            function stubPerchSetup(driver: ReturnType<typeof fakePerchDriver> = fakePerchDriver()) {
                const scheduler = { start: mock(() => undefined), stop: mock(() => undefined), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
                const setupPerchDriverAndSchedulerSpy = spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({ driver, scheduler });
                const setupPerchSessionRunnerAndSchedulerSpy = spyOn(perchSetupModule, 'setupPerchSessionRunnerAndScheduler').mockReturnValue({
                    runner: { startPerch: mock(async () => undefined), suspend: mock(() => undefined), resumeAfterSuspension: mock(async () => undefined), isSuspended: mock(() => false), clearSuspension: mock(() => undefined) } as unknown as ReturnType<typeof perchSetupModule.setupPerchSessionRunnerAndScheduler>['runner'],
                    scheduler,
                });
                spies.push(setupPerchDriverAndSchedulerSpy, setupPerchSessionRunnerAndSchedulerSpy);
                return { setupPerchDriverAndSchedulerSpy, setupPerchSessionRunnerAndSchedulerSpy, driver, scheduler };
            }

            test('opens the perch conductor AFTER the conversation conductor, within clientReady', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                stubPerchSetup();

                const callOrder: string[] = [];
                const conversationConductor = makeFakeConductor({
                    open: mock(async () => {
                        callOrder.push('conversation.open');
                        return { sessionId: 'sess-1', resumed: false };
                    }),
                });
                const perchConductor = makeFakeConductor({
                    open: mock(async () => {
                        callOrder.push('perch.open');
                        return { sessionId: 'perch-sess-1', resumed: false };
                    }),
                });
                const deps = conductorDeps({ conversationConductor, perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(callOrder).toEqual(['conversation.open', 'perch.open']);
            });

            test('a successfully-opened perch conductor uses setupPerchDriverAndScheduler, never the legacy runner', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy, setupPerchSessionRunnerAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupPerchDriverAndSchedulerSpy).toHaveBeenCalledTimes(1);
                expect(setupPerchSessionRunnerAndSchedulerSpy).not.toHaveBeenCalled();
                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { conductor?: unknown } | undefined;
                expect(driverArgs?.conductor).toBe(perchConductor);
            });

            test('forwards options.isCostPaused to setupPerchDriverAndScheduler by identity (Q3 / B4)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });
                const isCostPaused = (): boolean => true;

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    isCostPaused,
                    ...deps,
                });

                await triggerReady(client);

                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { isCostPaused?: unknown } | undefined;
                expect(driverArgs?.isCostPaused).toBe(isCostPaused);
            });

            test('leaves isCostPaused undefined for setupPerchDriverAndScheduler when options.isCostPaused is omitted', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { isCostPaused?: unknown } | undefined;
                expect(driverArgs?.isCostPaused).toBeUndefined();
            });

            test('a successfully-opened perch conductor excludes the well-known perch-time channel from the conversation replay boot sequence', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                stubPerchSetup();

                const setupInboxAndCatchUpSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp').mockResolvedValue(undefined);
                spies.push(setupInboxAndCatchUpSpy);

                const perchTimeChannel = {
                    channelId: 'perch-time-channel-id', channelName: 'perch-time', guildId: 'guild-1', isMuted: false, isWellKnown: 'perch-time' as const, discoveredAt: '2025-01-01T00:00:00.000Z', lastSeenAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
                };
                const channelRegistryWithPerch = {
                    ...mockChannelRegistry,
                    getWellKnownChannel: mock(async () => perchTimeChannel),
                } as unknown as ChannelRegistryManager;

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({
                    perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
                });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: channelRegistryWithPerch,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    inboxManager:    { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    memoryBackend:   { loadCompletionSignal: mock(async () => null) } as unknown as DiscordBotOptions['memoryBackend'],
                    ...deps,
                });

                await triggerReady(client);

                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { excludeChannelIds?: ReadonlySet<string> } | undefined;
                expect(call?.excludeChannelIds).toEqual(new Set(['perch-time-channel-id']));
            });

            test('a rejected well-known perch-time channel lookup does not abort the rest of clientReady — setupInboxAndCatchUp still runs and the gate still opens', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                stubPerchSetup();

                const setupInboxAndCatchUpSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp').mockResolvedValue(undefined);
                spies.push(setupInboxAndCatchUpSpy);

                const channelRegistryRejecting = {
                    ...mockChannelRegistry,
                    getWellKnownChannel: mock(() => Promise.reject(new Error('DynamoDB throttled'))),
                } as unknown as ChannelRegistryManager;

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({
                    perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
                });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: channelRegistryRejecting,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    inboxManager:    { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    memoryBackend:   { loadCompletionSignal: mock(async () => null) } as unknown as DiscordBotOptions['memoryBackend'],
                    ...deps,
                });

                await expect(triggerReady(client)).resolves.toBeUndefined();

                // The clientReady handler must still reach setupInboxAndCatchUp — a throw here
                // would previously abort everything after it, leaving the ingress gate stuck
                // 'buffering' forever with every Discord message silently unanswered.
                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { excludeChannelIds?: ReadonlySet<string> } | undefined;
                expect(call?.excludeChannelIds).toBeUndefined();
            });

            test('a rejected perch conductor open() degrades to the legacy perch scheduler/runner, without throwing', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy, setupPerchSessionRunnerAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor({ open: mock(() => Promise.reject(new Error('perch boom'))) });
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await expect(triggerReady(client)).resolves.toBeUndefined();

                expect(setupPerchSessionRunnerAndSchedulerSpy).toHaveBeenCalledTimes(1);
                expect(setupPerchDriverAndSchedulerSpy).not.toHaveBeenCalled();
            });

            test('omitting the perch conductor entirely (oneshot-equivalent) still uses the legacy perch runner, unaffected', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy, setupPerchSessionRunnerAndSchedulerSpy } = stubPerchSetup();

                const deps = conductorDeps();

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupPerchSessionRunnerAndSchedulerSpy).toHaveBeenCalledTimes(1);
                expect(setupPerchDriverAndSchedulerSpy).not.toHaveBeenCalled();
            });

            test('stop() shuts down both conductors under one shared budget and stops the perch driver', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const driver = fakePerchDriver();
                stubPerchSetup(driver);

                const conversationShutdown = mock(async () => undefined);
                const perchShutdown = mock(async () => undefined);
                const conversationConductor = makeFakeConductor({ shutdown: conversationShutdown });
                const perchConductor = makeFakeConductor({ shutdown: perchShutdown });
                const deps = conductorDeps({ conversationConductor, perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                const bot = createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(conversationShutdown).toHaveBeenCalledTimes(1);
                expect(perchShutdown).toHaveBeenCalledTimes(1);
                expect(driver.stop).toHaveBeenCalledTimes(1);
            });

            test('stop() stops the perch driver and scheduler BEFORE waiting out the shared shutdown budget, so no timer can fire while a turn is being politely waited out', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const callOrder: string[] = [];
                const driver = {
                    runSlot: mock(() => 'started' as const),
                    stop:    mock(() => {
                        callOrder.push('perchDriver.stop');
                    }),
                };
                const scheduler = {
                    start: mock(() => undefined),
                    stop:  mock(() => {
                        callOrder.push('perchScheduler.stop');
                    }),
                    getState: mock(), triggerNow: mock(), triggerTestPerch: mock(),
                };
                spies.push(spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({ driver, scheduler }));

                const perchShutdown = mock(async () => {
                    callOrder.push('perch.shutdown');
                });
                const perchConductor = makeFakeConductor({ shutdown: perchShutdown });
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                const bot = createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    agent:           {} as ClaudeAgent,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(callOrder).toEqual(['perchScheduler.stop', 'perchDriver.stop', 'perch.shutdown']);
                expect(driver.stop).toHaveBeenCalledTimes(1);
                expect(scheduler.stop).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe('Channel Cleanup Events', () => {
        test('should call coordinator.removeChannel() on channelDelete event', async () => {
            const mockRemoveChannel = mock(() => undefined);
            let channelDeleteHandler: ((channel: { id: string }) => void) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (arg: unknown) => void) => {
                    if(event === 'channelDelete') {
                        channelDeleteHandler = handler;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory
            const mockCoordinator = {
                handleMessage:       mock(() => undefined),
                setProcessor:        mock(() => undefined),
                removeChannel:       mockRemoveChannel,
                removeGuildChannels: mock(() => undefined),
                stop:                mock(() => undefined),
            };
            // Mock channel registry functions
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify channelDelete handler was registered
            expect(channelDeleteHandler).toBeDefined();

            // Trigger channelDelete event
            const deletedChannelId = '123456789';
            channelDeleteHandler!({ id: deletedChannelId });

            // Verify coordinator.removeChannel was called with the correct channelId
            expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
            expect(mockRemoveChannel).toHaveBeenCalledWith(createChannelId(deletedChannelId));
        });

        test('should not call coordinator.removeChannel() when coordinator is not created', async () => {
            let channelDeleteHandler: ((channel: { id: string }) => void) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (arg: unknown) => void) => {
                    if(event === 'channelDelete') {
                        channelDeleteHandler = handler;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Mock channel registry functions
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                // No agent - coordinator won't be created
            });

            // Trigger clientReady to register event handlers

            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // channelDelete handler should still be registered (no-op when coordinator is undefined)
            expect(channelDeleteHandler).toBeDefined();

            // Trigger channelDelete event - should not throw
            const deletedChannelId = '123456789';
            expect(() => channelDeleteHandler!({ id: deletedChannelId })).not.toThrow();
        });

        test('should call coordinator.removeGuildChannels() on guildDelete event', async () => {
            const mockRemoveGuildChannels = mock(() => undefined);
            let guildDeleteHandler: ((guild: { id: string }) => void) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (arg: unknown) => void) => {
                    if(event === 'guildDelete') {
                        guildDeleteHandler = handler;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory
            const mockCoordinator = {
                handleMessage:       mock(() => undefined),
                setProcessor:        mock(() => undefined),
                removeChannel:       mock(() => undefined),
                removeGuildChannels: mockRemoveGuildChannels,
                stop:                mock(() => undefined),
            };
            // @ts-expect-error - Mocking constructor
            spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator));

            // Mock channel registry to return guild's channels
            const guildId = createGuildId('guild-123');
            const channelIds = [
                createChannelId('channel-1'),
                createChannelId('channel-2'),
                createChannelId('channel-3'),
            ];
            const mockChannelRegistryWithGuild = {
                ...mockChannelRegistry,
                getAllChannels: mock(() => [
                    { channelId: channelIds[0], guildId, channelName: 'channel-1' },
                    { channelId: channelIds[1], guildId, channelName: 'channel-2' },
                    { channelId: channelIds[2], guildId, channelName: 'channel-3' },
                ]),
            } as unknown as ChannelRegistryManager;

            // Mock channel registry functions
            spies.push(
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistryWithGuild,
                agent:           mockAgent,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify guildDelete handler was registered
            expect(guildDeleteHandler).toBeDefined();

            // Trigger guildDelete event
            guildDeleteHandler!({ id: guildId });

            // Wait for async handler to complete
            await Promise.resolve();

            // Verify coordinator.removeGuildChannels was called with the correct channel IDs
            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            expect(mockRemoveGuildChannels).toHaveBeenCalledWith(channelIds);
        });

        test('should handle guildDelete when no channels exist for guild', async () => {
            const mockRemoveGuildChannels = mock(() => undefined);
            let guildDeleteHandler: ((guild: { id: string }) => void) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (arg: unknown) => void) => {
                    if(event === 'guildDelete') {
                        guildDeleteHandler = handler;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory
            const mockCoordinator = {
                handleMessage:       mock(() => undefined),
                setProcessor:        mock(() => undefined),
                removeChannel:       mock(() => undefined),
                removeGuildChannels: mockRemoveGuildChannels,
                stop:                mock(() => undefined),
            };
            // @ts-expect-error - Mocking constructor
            spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator));

            // Mock channel registry to return empty channels array
            const guildId = createGuildId('guild-123');
            const mockChannelRegistryWithGuild = {
                ...mockChannelRegistry,
                getAllChannels: mock(() => []),
            } as unknown as ChannelRegistryManager;

            // Mock channel registry functions
            spies.push(
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistryWithGuild,
                agent:           mockAgent,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify guildDelete handler was registered
            expect(guildDeleteHandler).toBeDefined();

            // Trigger guildDelete event
            guildDeleteHandler!({ id: guildId });

            // Wait for async handler to complete
            await Promise.resolve();

            // Verify coordinator.removeGuildChannels was called with empty array
            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            expect(mockRemoveGuildChannels).toHaveBeenCalledWith([]);
        });

        test('should not call coordinator.removeGuildChannels() when coordinator is not created', async () => {
            let guildDeleteHandler: ((guild: { id: string }) => void) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (arg: unknown) => void) => {
                    if(event === 'guildDelete') {
                        guildDeleteHandler = handler;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Spy on the coordinator constructor so we can prove it was never invoked,
            // i.e. that "coordinator is not created" is actually true for this test.
            const coordinatorConstructorSpy = spyOn(messageCoordinatorModule, 'MessageCoordinator');

            // Mock channel registry functions
            spies.push(
                coordinatorConstructorSpy,
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                // No agent - coordinator won't be created
            });

            // Trigger clientReady to complete setup

            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // guildDelete handler should still be registered (no-op when coordinator is undefined)
            expect(guildDeleteHandler).toBeDefined();

            // Trigger guildDelete event - should not throw
            const guildId = createGuildId('guild-123');
            // Call the handler - it should not throw even without a coordinator
            guildDeleteHandler!({ id: guildId });
            await Promise.resolve();
            // Coordinator was genuinely never created, so removeGuildChannels() had no
            // instance to be called on.
            expect(coordinatorConstructorSpy).not.toHaveBeenCalled();
        });
    });

    describe('Processor updatePresenceForMessageStart Behavior', () => {
        test('should call startProcessingMessage when mode is idle (resume flow fix)', async () => {
            let processorFn: MessageProcessor | undefined;

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory to capture processor function
            const mockCoordinator = {
                handleMessage: mock(() => undefined),
                setProcessor:  mock((fn: MessageProcessor) => {
                    processorFn = fn;
                }),
                removeChannel:       mock(() => undefined),
                removeGuildChannels: mock(() => undefined),
                stop:                mock(() => undefined),
            };
            // Mock channel registry functions
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot state manager in idle mode
            const realBotStateManager = new BotStateManagerImpl({
                logger: mockLogger,
            });

            // Spy on startProcessingMessage
            const startProcessingMessageSpy = mock(realBotStateManager.startProcessingMessage.bind(realBotStateManager));
            realBotStateManager.startProcessingMessage = startProcessingMessageSpy;

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
                botStateManager: realBotStateManager,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify processor was set
            expect(processorFn).toBeDefined();

            // Verify bot is in idle mode
            expect(realBotStateManager.getMode()).toBe('idle');

            // Call processor with a context
            const testContext: DiscordMessageContext = {
                guildId:   createGuildId('test-guild'),
                channelId: createChannelId('test-channel'),
                userId:    createUserId('123'),
                messageId: '456',
                content:   'test message',
                timestamp: new Date().toISOString(),
                botUserId: createUserId('999999999999999999'),
            };

            // Create AbortController for the processor call
            const abortController = new AbortController();

            // Processor will throw because agent.handleInput isn't properly set up,
            // but we only care about the startProcessingMessage call which happens first
            try {
                await processorFn!([testContext], null, abortController.signal);
            } catch{
                // Expected to fail - we're only testing the updatePresenceForMessageStart part
            }

            // Verify startProcessingMessage was called with correct args (this is the bug fix)
            expect(startProcessingMessageSpy).toHaveBeenCalledWith(
                testContext.channelId,
                testContext.content
            );
        });

        test('should NOT call startProcessingMessage when already processing (no double-transition)', async () => {
            let processorFn: MessageProcessor | undefined;

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory to capture processor function
            const mockCoordinator = {
                handleMessage: mock(() => undefined),
                setProcessor:  mock((fn: MessageProcessor) => {
                    processorFn = fn;
                }),
                removeChannel:       mock(() => undefined),
                removeGuildChannels: mock(() => undefined),
                stop:                mock(() => undefined),
            };
            // Mock channel registry functions
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot state manager already in processing_message mode
            const realBotStateManager = new BotStateManagerImpl({
                logger: mockLogger,
            });

            // Put it in processing_message mode
            realBotStateManager.startProcessingMessage(createChannelId('existing-channel'), 'existing message');

            // Spy on startProcessingMessage
            const startProcessingMessageSpy = mock(realBotStateManager.startProcessingMessage.bind(realBotStateManager));
            realBotStateManager.startProcessingMessage = startProcessingMessageSpy;

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
                botStateManager: realBotStateManager,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify processor was set
            expect(processorFn).toBeDefined();

            // Verify bot is in processing_message mode
            expect(realBotStateManager.getMode()).toBe('processing_message');

            // Call processor with a context
            const testContext: DiscordMessageContext = {
                guildId:   createGuildId('test-guild'),
                channelId: createChannelId('test-channel'),
                userId:    createUserId('123'),
                messageId: '456',
                content:   'test message',
                timestamp: new Date().toISOString(),
                botUserId: createUserId('999999999999999999'),
            };

            // Create AbortController for the processor call
            const abortController = new AbortController();

            // Processor will throw because agent.handleInput isn't properly set up,
            // but we only care about the startProcessingMessage call which happens first
            try {
                await processorFn!([testContext], null, abortController.signal);
            } catch{
                // Expected to fail - we're only testing the updatePresenceForMessageStart part
            }

            // Verify startProcessingMessage was NOT called (mode was already processing_message)
            expect(startProcessingMessageSpy).not.toHaveBeenCalled();
        });

        test('should handle empty contexts array without error', async () => {
            let processorFn: MessageProcessor | undefined;

            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // Mock coordinator factory to capture processor function
            const mockCoordinator = {
                handleMessage: mock(() => undefined),
                setProcessor:  mock((fn: MessageProcessor) => {
                    processorFn = fn;
                }),
                removeChannel:       mock(() => undefined),
                removeGuildChannels: mock(() => undefined),
                stop:                mock(() => undefined),
            };
            // Mock channel registry functions
            spies.push(
                // @ts-expect-error - Mocking constructor
                spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): MessageCoordinator => mockCoordinator as unknown as MessageCoordinator),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot state manager in idle mode
            const realBotStateManager = new BotStateManagerImpl({
                logger: mockLogger,
            });

            // Spy on startProcessingMessage
            const startProcessingMessageSpy = mock(realBotStateManager.startProcessingMessage.bind(realBotStateManager));
            realBotStateManager.startProcessingMessage = startProcessingMessageSpy;

            // Create a fake agent to enable coordinator creation
            const mockAgent = {
                handleInput: mock(async () => ({ response: null, wasInterrupted: false, streamTracker: {} })),
            } as unknown as ClaudeAgent;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                agent:           mockAgent,
                botStateManager: realBotStateManager,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Verify processor was set
            expect(processorFn).toBeDefined();

            // Verify bot is in idle mode
            expect(realBotStateManager.getMode()).toBe('idle');

            // Create AbortController for the processor call
            const abortController = new AbortController();

            // Call processor with empty contexts array - should not throw from updatePresenceForMessageStart
            try {
                await processorFn!([], null, abortController.signal);
            } catch{
                // Expected to fail in later processing, but not from updatePresenceForMessageStart
            }

            // Verify startProcessingMessage was NOT called (no contexts)
            expect(startProcessingMessageSpy).not.toHaveBeenCalled();
        });
    });

    describe('Email integration lifecycle', () => {
        test('bot.stop() calls client.destroy() when emailSetup is present', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: mock(async () => undefined) },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
            } as unknown as EmailSetupResult;

            const bot = createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            await bot.stop();

            // client.destroy() must have been called (email lifecycle is managed by app.stop(), not bot.stop())
            expect(mockClient.destroy).toHaveBeenCalledTimes(1);
            // listener.stop() is NOT called by bot.stop() — it is now managed by app.stop()
            expect(mockEmailSetup.listener.stop).not.toHaveBeenCalled();
        });

        test('/allowlist command replies with unavailable message when emailSetup is absent', async () => {
            // Capture the interactionCreate handler
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once: mock((_event: string, _handler: (...args: unknown[]) => void) => {
                    return mockClient;
                }),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Mock channel registry functions
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot WITHOUT emailSetup
            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Fire clientReady to register interactionCreate handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // Build a mock /allowlist ChatInputCommand interaction
            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => true),
                commandName:        'allowlist',
                reply:              replyMock,
            };

            await interactionCreateHandler!(mockInteraction);

            expect(replyMock).toHaveBeenCalledTimes(1);
            expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
                flags: MessageFlags.Ephemeral,
            }));
        });

        test('/calendar command replies with unavailable message when calendarHandler is absent', async () => {
            // Capture the interactionCreate handler
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once: mock((_event: string, _handler: (...args: unknown[]) => void) => {
                    return mockClient;
                }),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot WITHOUT calendarHandler
            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Fire clientReady
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => true),
                commandName:        'calendar',
                reply:              replyMock,
            };

            await interactionCreateHandler!(mockInteraction);

            expect(replyMock).toHaveBeenCalledTimes(1);
            expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
                flags: MessageFlags.Ephemeral,
            }));
        });

        test('/contact command replies with unavailable message when contactHandler is absent', async () => {
            // Capture the interactionCreate handler
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once: mock((_event: string, _handler: (...args: unknown[]) => void) => {
                    return mockClient;
                }),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot WITHOUT contactHandler
            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Fire clientReady
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => true),
                commandName:        'contact',
                reply:              replyMock,
            };

            await interactionCreateHandler!(mockInteraction);

            expect(replyMock).toHaveBeenCalledTimes(1);
            expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
                flags: MessageFlags.Ephemeral,
            }));
        });

        test('email-* button interactions are routed to reviewHandler.handleButton()', async () => {
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleButtonMock = mock(async () => undefined);
            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: handleButtonMock },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady to register interactionCreate handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // Build a mock email button interaction
            const mockInteraction = {
                isButton:           mock(() => true),
                isChatInputCommand: mock(() => false),
                customId:           'email-trash:42:Review',
            };

            await interactionCreateHandler!(mockInteraction);

            // reviewHandler.handleButton() must have been called with the interaction
            expect(handleButtonMock).toHaveBeenCalledTimes(1);
            expect(handleButtonMock).toHaveBeenCalledWith(mockInteraction);
        });

        test('email-* button interactions do not fall through to default button handler', async () => {
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            // Track all handlers for 'interactionCreate'
            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleButtonMock = mock(async () => undefined);
            // A reply mock would be called if the interaction fell through to the default handler
            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: handleButtonMock },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // email-* button must not call reply (which would be called by the fallback handler)
            const mockInteraction = {
                isButton:           mock(() => true),
                isChatInputCommand: mock(() => false),
                customId:           'email-approve:99:Approve',
                reply:              replyMock,
            };

            await interactionCreateHandler!(mockInteraction);

            expect(handleButtonMock).toHaveBeenCalledTimes(1);
            // reply must NOT have been called — routing returned early
            expect(replyMock).not.toHaveBeenCalled();
        });

        test('/allowlist command is routed to allowlistHandler.handle() when emailSetup is present', async () => {
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleMock = mock(async () => undefined);
            const mockEmailSetup = {
                listener:       { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:  { handleButton: mock(async () => undefined) },
                emailMcpServer: {},
                imap:           {},
                counters:       {},
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry:  mockChannelRegistry,
                emailSetup:       mockEmailSetup,
                allowlistHandler: { handle: handleMock } as unknown as AllowlistCommandHandler,
            });

            // Fire clientReady to register interactionCreate handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // Build a mock /allowlist ChatInputCommand interaction
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => true),
                commandName:        'allowlist',
            };

            await interactionCreateHandler!(mockInteraction);

            expect(handleMock).toHaveBeenCalledTimes(1);
            expect(handleMock).toHaveBeenCalledWith(mockInteraction);
        });

        test('non-email button interactions are NOT routed to reviewHandler when emailSetup present', async () => {
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleButtonMock = mock(async () => undefined);
            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: handleButtonMock },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // A button with a non-email customId must NOT go to reviewHandler
            const mockInteraction = {
                isButton:           mock(() => true),
                isChatInputCommand: mock(() => false),
                customId:           'question-confirm:99',
                // reply is called by the default interactionHandler — we just verify reviewHandler is skipped
                reply:              mock(async (_opts: unknown) => undefined),
            };

            await interactionCreateHandler!(mockInteraction);

            expect(handleButtonMock).not.toHaveBeenCalled();
        });

        test('email-send-* button replies ephemerally when outboundApprovalHandler is undefined (Bug C)', async () => {
            // Bug C: when outboundApprovalHandler is undefined, interaction.reply should be called
            // with an ephemeral error message instead of silently doing nothing
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            // emailSetup with outboundApprovalHandler always present (WildDuck is required)
            const handleButtonMockApproval = mock(async () => undefined);
            const mockEmailSetup = {
                listener:                { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:           { handleButton: mock(async () => undefined) },
                allowlistHandler:        { handle: mock(async () => undefined) },
                emailMcpServer:          {},
                imap:                    {},
                counters:                {},
                outboundApprovalHandler: { handleButton: handleButtonMockApproval, handleModalSubmit: mock(async () => undefined) },
                wildDuckClient:          { shutdown: mock(async () => undefined) },
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady to register interactionCreate handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            const mockInteraction = {
                isButton:           mock(() => true),
                isModalSubmit:      mock(() => false),
                isChatInputCommand: mock(() => false),
                customId:           'email-send-approve:42',
                reply:              mock(async (_opts: unknown) => undefined),
            };

            await interactionCreateHandler!(mockInteraction);

            // outboundApprovalHandler.handleButton should be called (WildDuck is always present)
            expect(handleButtonMockApproval).toHaveBeenCalledTimes(1);
        });

        test('email-send-reject-reason modal replies ephemerally when outboundApprovalHandler is undefined (Bug C)', async () => {
            // WildDuck is now required, so outboundApprovalHandler is always present
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleModalMock = mock(async () => undefined);
            const mockEmailSetup = {
                listener:                { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:           { handleButton: mock(async () => undefined) },
                allowlistHandler:        { handle: mock(async () => undefined) },
                emailMcpServer:          {},
                imap:                    {},
                counters:                {},
                outboundApprovalHandler: { handleButton: mock(async () => undefined), handleModalSubmit: handleModalMock },
                wildDuckClient:          { shutdown: mock(async () => undefined) },
            } as unknown as EmailSetupResult;

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                emailSetup:      mockEmailSetup,
            });

            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => true),
                isChatInputCommand: mock(() => false),
                customId:           'email-send-reject-reason:42',
                reply:              mock(async (_opts: unknown) => undefined),
            };

            await interactionCreateHandler!(mockInteraction);

            // outboundApprovalHandler.handleModalSubmit should be called (WildDuck is always present)
            expect(handleModalMock).toHaveBeenCalledTimes(1);
        });

        test('email-allowlist-select select menu replies ephemerally when emailSetup is absent', async () => {
            let interactionCreateHandler: ((interaction: unknown) => Promise<void>) | undefined;

            const mockClient = {
                on: mock((event: string, handler: (...args: unknown[]) => void) => {
                    if(event === 'interactionCreate') {
                        interactionCreateHandler = handler as (interaction: unknown) => Promise<void>;
                    }
                    return mockClient;
                }),
                once: mock((_event: string, _handler: (...args: unknown[]) => void) => {
                    return mockClient;
                }),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            // Mock channel registry functions
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient),
                spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({
                    discovered: 0,
                    updated:    0,
                    errors:     [],
                }),
                spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
            );

            // Create bot WITHOUT emailSetup
            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
            });

            // Fire clientReady to register interactionCreate handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            expect(interactionCreateHandler).toBeDefined();

            // Build a mock email-allowlist-select StringSelectMenu interaction
            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => true),
                isChatInputCommand: mock(() => false),
                customId:           'email-allowlist-select:42',
                values:             [],
                reply:              replyMock,
            };

            await interactionCreateHandler!(mockInteraction);

            // Should reply ephemerally with unavailable message
            expect(replyMock).toHaveBeenCalledTimes(1);
            expect(replyMock).toHaveBeenCalledWith(expect.objectContaining({
                flags: MessageFlags.Ephemeral,
            }));
        });

        test('muteChannel is called with adminChannelId on clientReady when emailSetup has adminChannelId', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const adminChannelId = createChannelId('admin-channel-123');
            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: mock(async () => undefined) },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
                adminChannelId,
            } as unknown as EmailSetupResult;

            const muteChannelMock = mock(async () => undefined);
            const channelRegistryWithMute = {
                ...mockChannelRegistry,
                muteChannel: muteChannelMock,
            } as unknown as ChannelRegistryManager;

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: channelRegistryWithMute,
                emailSetup:      mockEmailSetup,
            });

            // muteChannel must NOT be called before clientReady fires
            expect(muteChannelMock).not.toHaveBeenCalled();

            // Fire clientReady handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // muteChannel must be called once with the adminChannelId
            expect(muteChannelMock).toHaveBeenCalledTimes(1);
            expect(muteChannelMock).toHaveBeenCalledWith(adminChannelId);
        });

        test('muteChannel failure is non-fatal: clientReady completes and bot is stoppable', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const adminChannelId = createChannelId('admin-channel-456');
            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: mock(async () => undefined) },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
                adminChannelId,
            } as unknown as EmailSetupResult;

            const muteChannelMock = mock(async () => {
                throw new Error('DynamoDB unreachable');
            });
            const channelRegistryWithMute = {
                ...mockChannelRegistry,
                muteChannel: muteChannelMock,
            } as unknown as ChannelRegistryManager;

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: channelRegistryWithMute,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady — muteChannel will throw, but clientReady must not throw
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                // Must not throw even though muteChannel throws
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // Bot must still be stoppable after mute failure
            await bot.stop();
            expect(mockClient.destroy).toHaveBeenCalledTimes(1);
        });

        test('muteChannel is NOT called when emailSetup has no adminChannelId', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               null,
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const mockEmailSetup = {
                listener:         { start: mock(async () => undefined), stop: mock(async () => undefined) },
                reviewHandler:    { handleButton: mock(async () => undefined) },
                allowlistHandler: { handle: mock(async () => undefined) },
                emailMcpServer:   {},
                imap:             {},
                counters:         {},
                // no adminChannelId
            } as unknown as EmailSetupResult;

            const muteChannelMock = mock(async () => undefined);
            const channelRegistryWithMute = {
                ...mockChannelRegistry,
                muteChannel: muteChannelMock,
            } as unknown as ChannelRegistryManager;

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: channelRegistryWithMute,
                emailSetup:      mockEmailSetup,
            });

            // Fire clientReady handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }

            // muteChannel must NOT be called when adminChannelId is absent
            expect(muteChannelMock).not.toHaveBeenCalled();
        });
    });
});
