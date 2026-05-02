/**
 * Tests for event-handler-setup.ts
 *
 * Covers:
 * - initializeChannelRegistry: startHydration wiring, post-ready discovery, error handling
 * - setupChannelCleanupHandlers: channelDelete and guildDelete event handling
 */

import { describe, test, expect, mock, spyOn, afterEach, beforeEach, jest } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import type { Client, Message } from 'discord.js';
import * as channelRegistryModule from '@/integrations/discord/channel-registry/discovery';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import type { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { initializeChannelRegistry, setupChannelCleanupHandlers } from '@/integrations/discord/setup/event-handler-setup';
import { createChannelId, createGuildId } from '@/integrations/discord/types';
import type { ServiceHealthRegistry } from '@/services';

// ============================================================================
// initializeChannelRegistry
// ============================================================================

describe('initializeChannelRegistry', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    function makeRegistry(readyPromise: Promise<void>): ChannelRegistryManager {
        // onReady must attach the callback to the ready promise so discovery fires.
        // This mirrors the real implementation: each onReady call attaches a .then() handler.
        return {
            warmCache:      mock(() => Promise.resolve()),
            startHydration: mock(() => undefined),
            stop:           mock(() => undefined),
            ready:          readyPromise,
            // eslint-disable-next-line promise/no-callback-in-promise -- intentional: cb is a registered lifecycle callback, not a Node-style errback
            onReady:        mock((cb: () => void | Promise<void>) => { void readyPromise.then(() => cb()); }),
        } as unknown as ChannelRegistryManager;
    }

    function makeClient(): Client {
        return {
            channels: {
                fetch: mock(async () => ({ send: mock(async () => ({})) })),
            },
        } as unknown as Client;
    }

    function makeResponseRouter(): Parameters<typeof initializeChannelRegistry>[2] {
        return {
            routeResponse: mock(() => Promise.resolve({
                shouldSend:      true,
                targetChannelId: 'fallback-ch',
                content:         'error message',
            })),
        } as unknown as Parameters<typeof initializeChannelRegistry>[2];
    }

    // Helper: a Promise that never resolves (simulates pending hydration)
    function neverResolves(): Promise<void> {
        return new Promise<void>((_resolve) => { /* intentionally pending */ });
    }

    test('calls startHydration (not warmCache) on the registry', () => {
        const registry = makeRegistry(neverResolves());
        const client   = makeClient();

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        expect((registry.startHydration as ReturnType<typeof mock>).mock.calls.length).toBe(1);
        expect((registry.warmCache as ReturnType<typeof mock>).mock.calls.length).toBe(0);
    });

    test('startHydration receives a ReconnectionLoop-shaped object', () => {
        const registry = makeRegistry(neverResolves());
        const client   = makeClient();

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        // The loop must expose start / stop / restart / triggerNow / isRunning
        expect(typeof receivedLoop.start).toBe('function');
        expect(typeof receivedLoop.stop).toBe('function');
        expect(typeof receivedLoop.restart).toBe('function');
    });

    test('initializeChannelRegistry returns undefined synchronously', () => {
        // Verify the function is synchronous — it must not be async.
        const registry = makeRegistry(neverResolves());
        const client   = makeClient();

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        // Call and immediately check: if the function were async, result would be a Promise
        // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression -- explicitly testing that the return value is void/undefined
        const result: void = initializeChannelRegistry(client, registry, makeResponseRouter());
        expect(result).toBeUndefined();
    });

    test('discovery runs after ready resolves', async () => {
        const registry = makeRegistry(Promise.resolve());
        const client   = makeClient();

        const discoverSpy = spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 2, updated: 0, errors: [] });
        spies.push(
            discoverSpy,
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        // Allow the .then() microtask to execute
        await Promise.resolve();
        await Promise.resolve();

        expect(discoverSpy).toHaveBeenCalledWith(client, registry);
    });

    test('setupChannelEventHandlers is called after discovery succeeds', async () => {
        const registry = makeRegistry(Promise.resolve());
        const client   = makeClient();

        const setupSpy = spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined);
        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            setupSpy
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(setupSpy).toHaveBeenCalledWith(client, registry);
    });

    test('setupChannelEventHandlers is still called even when discovery throws', async () => {
        const registry = makeRegistry(Promise.resolve());
        const client   = makeClient();

        const setupSpy = spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined);
        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockRejectedValue(new Error('network error')),
            setupSpy
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        // Flush through catch block and then the finally-style setup call
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(setupSpy).toHaveBeenCalledWith(client, registry);
    });

    test('discovery does not run while hydration is pending', async () => {
        const registry = makeRegistry(neverResolves());
        const client   = makeClient();

        const discoverSpy = spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] });
        spies.push(
            discoverSpy,
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, makeResponseRouter());

        await Promise.resolve();
        await Promise.resolve();

        expect(discoverSpy).not.toHaveBeenCalled();
    });

    test('when discovery fails and rateLimiter provided, notificationContent includes the error message', async () => {
        const registry       = makeRegistry(Promise.resolve());
        const client         = makeClient();
        const responseRouter = makeResponseRouter();

        const discoverError = new Error('dns failure');
        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockRejectedValue(discoverError),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        const mockSendToChannel = mock(async () => ({} as Message));
        const rateLimiter = { sendToChannel: mockSendToChannel } as unknown as DiscordRateLimiter;

        initializeChannelRegistry(client, registry, responseRouter, rateLimiter);

        // Flush: ready → discovery catch → sendRegistryErrorNotification
        for(let i = 0; i < 8; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask draining; each await is independent and order matters
            await Promise.resolve();
        }

        // routeResponse is called with content that includes the error message text
        const routeResponseMock = responseRouter.routeResponse as ReturnType<typeof mock>;
        expect(routeResponseMock).toHaveBeenCalledTimes(1);
        const calledContent: string = routeResponseMock.mock.calls[0]?.[1] ?? '';
        expect(calledContent).toContain('dns failure');
        expect(calledContent).toContain('Channel Registry Error');
    });

    // ---------------------------------------------------------------------------
    // Bug 1: Health-service name isolation
    // ---------------------------------------------------------------------------

    function makeHealthRegistry(): ServiceHealthRegistry {
        return {
            getState:           mock(() => 'offline' as const),
            getEntry:           mock(() => ({ state: 'offline' as const, epoch: 0, failureCount: 0 })),
            getAll:             mock(() => ({} as ReturnType<ServiceHealthRegistry['getAll']>)),
            isAvailable:        mock(() => false),
            isWriteAvailable:   mock(() => false),
            sendEvent:          mock(() => undefined),
            subscribe:          mock(() => () => undefined),
            buildStatusSummary: mock(() => undefined),
            stop:               mock(() => undefined),
        };
    }

    test('Bug 1: reconnection loop uses discord-channel-registry service name, not discord', () => {
        // When warmCache() fails, sendEvent must be called with 'discord-channel-registry'
        // — NOT 'discord' — so the gateway service health stays unaffected.
        const registry = makeRegistry(new Promise<void>((_resolve) => { /* pending */ }));
        const client   = makeClient();
        const healthRegistry = makeHealthRegistry();

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, makeResponseRouter(), undefined, healthRegistry);

        // The loop was passed to startHydration — extract it and start it manually
        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        (receivedLoop.start as () => void)();

        // sendEvent must have been called with 'discord-channel-registry', not 'discord'
        const sendEventMock = healthRegistry.sendEvent as ReturnType<typeof mock>;
        const calledServices = sendEventMock.mock.calls.map((args: unknown[]) => args[0]);
        expect(calledServices).not.toContain('discord');
        expect(calledServices).toContain('discord-channel-registry');

        // Clean up loop
        (receivedLoop.stop as () => void)();
    });

    test('Bug 1: a warmCache() failure does NOT affect discord gateway health', async () => {
        // The discord service state is completely separate from the channel-registry loop.
        // Simulating: warmCache fails → CONNECT_FAIL is sent → only discord-channel-registry goes offline.
        const registry = makeRegistry(new Promise<void>((_resolve) => { /* pending */ }));
        const client   = makeClient();
        const healthRegistry = makeHealthRegistry();

        // Track which services receive CONNECT_FAIL
        const connectFailServices: string[] = [];
        (healthRegistry.sendEvent as ReturnType<typeof mock>).mockImplementation(
            (service: string, event: string) => {
                if(event === 'CONNECT_FAIL') {
                    connectFailServices.push(service);
                }
            }
        );

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        // Make warmCache throw (simulating DynamoDB failure)
        (registry.warmCache as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB offline'));

        initializeChannelRegistry(client, registry, makeResponseRouter(), undefined, healthRegistry);

        // Start the loop manually (since startHydration is mocked to no-op)
        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        (receivedLoop.start as () => void)();

        // Flush the connect attempt
        await Promise.resolve();
        await Promise.resolve();

        // CONNECT_FAIL must have gone to 'discord-channel-registry' — NOT 'discord'
        expect(connectFailServices).not.toContain('discord');
        expect(connectFailServices).toContain('discord-channel-registry');

        // Clean up loop
        (receivedLoop.stop as () => void)();
    });

    // ---------------------------------------------------------------------------
    // Bug 2: Hydration failure notification after 3 consecutive CONNECT_FAILs
    // ---------------------------------------------------------------------------

    test('Bug 2: sends operator notification exactly once after 3 consecutive CONNECT_FAILs', async () => {
        // Build a ChannelRegistryManager whose warmCache always fails
        const registry       = makeRegistry(new Promise<void>((_resolve) => { /* pending */ }));
        const client         = makeClient();
        const responseRouter = makeResponseRouter();
        const healthRegistry = makeHealthRegistry();

        // warmCache always throws
        (registry.warmCache as ReturnType<typeof mock>).mockRejectedValue(new Error('DynamoDB down'));

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        const mockSendToChannel = mock(async () => ({} as Message));
        const rateLimiter = { sendToChannel: mockSendToChannel } as unknown as DiscordRateLimiter;

        initializeChannelRegistry(client, registry, responseRouter, rateLimiter, healthRegistry);

        // Start the loop manually (startHydration is mocked to no-op)
        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        (receivedLoop.start as () => void)();

        // Flush attempt #1
        await Promise.resolve();
        await Promise.resolve();

        // Advance timers for retry delay and flush attempt #2
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();

        // Advance timers for retry delay and flush attempt #3
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
        await Promise.resolve();

        // Flush the notification async path
        for(let i = 0; i < 8; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask draining
            await Promise.resolve();
        }

        // Notification must have been sent exactly once (not once per failure)
        const routeResponseMock = responseRouter.routeResponse as ReturnType<typeof mock>;
        expect(routeResponseMock).toHaveBeenCalledTimes(1);
        const calledContent: string = routeResponseMock.mock.calls[0]?.[1] ?? '';
        expect(calledContent).toContain('Channel Registry Error');

        // Clean up
        (receivedLoop.stop as () => void)();
    });

    test('Bug 2: no notification before 3 CONNECT_FAILs', async () => {
        const registry       = makeRegistry(new Promise<void>((_resolve) => { /* pending */ }));
        const client         = makeClient();
        const responseRouter = makeResponseRouter();
        const healthRegistry = makeHealthRegistry();

        // warmCache throws exactly twice then succeeds
        let callCount = 0;
        (registry.warmCache as ReturnType<typeof mock>).mockImplementation(async () => {
            callCount += 1;
            if(callCount <= 2) {
                throw new Error('transient failure');
            }
            // Success on 3rd call
        });

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        const mockSendToChannel = mock(async () => ({} as Message));
        const rateLimiter = { sendToChannel: mockSendToChannel } as unknown as DiscordRateLimiter;

        initializeChannelRegistry(client, registry, responseRouter, rateLimiter, healthRegistry);

        // Start the loop manually
        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;
        (receivedLoop.start as () => void)();

        // Flush attempt #1 (fail)
        await Promise.resolve();
        await Promise.resolve();

        // Retry attempt #2 (fail)
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
        await Promise.resolve();

        // Retry attempt #3 (succeed)
        jest.advanceTimersByTime(4000);
        await Promise.resolve();
        await Promise.resolve();

        // Flush any async paths
        for(let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask draining
            await Promise.resolve();
        }

        // No notification — hydration succeeded before hitting 3 consecutive failures
        const routeResponseMock = responseRouter.routeResponse as ReturnType<typeof mock>;
        expect(routeResponseMock).not.toHaveBeenCalled();
    });

    // ---------------------------------------------------------------------------
    // Fix 1: notificationSent resets on success so failures-again can re-notify
    // ---------------------------------------------------------------------------

    test('Fix 1: second wave of failures after recovery sends a second notification', async () => {
        // Sequence: 3 failures → 1 success (resets notificationSent) → 3 more failures → 2nd notification
        // The ReconnectionLoop auto-stops after success; restart() re-engages it.
        // Wave 2 uses triggerNow() to bypass retry timers (attemptCount carries over, so delays would be large).
        const registry       = makeRegistry(new Promise<void>((_resolve) => { /* pending */ }));
        const client         = makeClient();
        const responseRouter = makeResponseRouter();
        const healthRegistry = makeHealthRegistry();

        let callCount = 0;
        (registry.warmCache as ReturnType<typeof mock>).mockImplementation(async () => {
            callCount += 1;
            if(callCount <= 3) {
                throw new Error('wave 1 failure');
            }
            if(callCount === 4) {
                return; // Success — resets notificationSent and consecutiveFailureCount
            }
            throw new Error('wave 2 failure'); // Calls 5, 6, 7+
        });

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        const mockSendToChannel = mock(async () => ({} as Message));
        const rateLimiter = { sendToChannel: mockSendToChannel } as unknown as DiscordRateLimiter;

        initializeChannelRegistry(client, registry, responseRouter, rateLimiter, healthRegistry);

        const receivedLoop = (registry.startHydration as ReturnType<typeof mock>).mock.calls[0]?.[0] as Record<string, unknown>;

        // Wave 1 — 3 failures trigger first notification, then attempt 4 succeeds
        (receivedLoop.start as () => void)();
        await Promise.resolve(); // attempt 1 (fail)
        await Promise.resolve();
        jest.advanceTimersByTime(2000);
        await Promise.resolve(); // attempt 2 (fail)
        await Promise.resolve();
        jest.advanceTimersByTime(4000);
        await Promise.resolve(); // attempt 3 (fail, triggers notify)
        await Promise.resolve();
        for(let i = 0; i < 8; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask draining
            await Promise.resolve();
        }

        const routeResponseMock = responseRouter.routeResponse as ReturnType<typeof mock>;
        expect(routeResponseMock).toHaveBeenCalledTimes(1);

        // Success — resets notificationSent and consecutiveFailureCount (loop auto-stops)
        jest.advanceTimersByTime(8000);
        await Promise.resolve(); // attempt 4 (success, loop stops)
        await Promise.resolve();
        // Drain any remaining async state from the success path
        for(let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop -- flush remaining microtasks
            await Promise.resolve();
        }

        // Wave 2 — restart() re-engages the loop (stopped=false after auto-stop, so restart is valid).
        // Use triggerNow() to bypass the large retry timers (attemptCount carries over from wave 1).
        // restart() fires attempt 5 immediately; triggerNow() joins the in-flight attempt.
        (receivedLoop.restart as () => void)();
        await (receivedLoop.triggerNow as () => Promise<boolean>)(); // attempt 5 (fail, consecutiveFailureCount=1)
        for(let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop -- flush microtasks between attempts
            await Promise.resolve();
        }
        await (receivedLoop.triggerNow as () => Promise<boolean>)(); // attempt 6 (fail, consecutiveFailureCount=2)
        for(let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop -- flush microtasks between attempts
            await Promise.resolve();
        }
        await (receivedLoop.triggerNow as () => Promise<boolean>)(); // attempt 7 (fail, consecutiveFailureCount=3 → notify)
        for(let i = 0; i < 8; i++) {
            // eslint-disable-next-line no-await-in-loop -- flush sendRegistryErrorNotification async path
            await Promise.resolve();
        }

        // Must fire a second notification since notificationSent was reset on success after wave 1
        expect(routeResponseMock).toHaveBeenCalledTimes(2);

        (receivedLoop.stop as () => void)();
    });

    // ---------------------------------------------------------------------------
    // Fix 3: logger.warn when rateLimiter is undefined
    // ---------------------------------------------------------------------------

    test('Fix 3: emits logger.warn at startup when rateLimiter is omitted', () => {
        const registry = makeRegistry(neverResolves());
        const client   = makeClient();

        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(
            warnSpy,
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        // No rateLimiter passed
        initializeChannelRegistry(client, registry, makeResponseRouter());

        // At least one warn call must include the "no rate limiter" message
        const rateLimiterWarns = (warnSpy.mock.calls as [{ msg?: string }][]).filter(
            ([arg]) => arg.msg?.includes('no rate limiter configured')
        );
        expect(rateLimiterWarns.length).toBeGreaterThanOrEqual(1);
    });

    test('Fix 3: does NOT emit logger.warn about missing rateLimiter when rateLimiter is provided', () => {
        const registry    = makeRegistry(neverResolves());
        const client      = makeClient();
        const rateLimiter = { sendToChannel: mock(async () => ({} as Message)) } as unknown as DiscordRateLimiter;

        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(
            warnSpy,
            spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] }),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        // Capture pre-call count to isolate from cross-test async leaks (other tests call
        // initializeChannelRegistry without rateLimiter, whose warn may settle asynchronously).
        const callsBefore = warnSpy.mock.calls.length;

        initializeChannelRegistry(client, registry, makeResponseRouter(), rateLimiter);

        // initializeChannelRegistry checks rateLimiter synchronously — any warn for
        // "no rate limiter" must have appeared immediately after the call returns.
        // Slice from callsBefore to exclude any calls that leaked from prior tests.
        const newCalls = warnSpy.mock.calls.slice(callsBefore) as [{ msg?: string }][];
        const rateLimiterWarns = newCalls.filter(([arg]) => arg.msg?.includes('no rate limiter configured'));
        expect(rateLimiterWarns).toHaveLength(0);
    });

    // ---------------------------------------------------------------------------
    // Fix 4: SYNTHETIC_FALLBACK_CHANNEL_ID is used in routeResponse call
    // ---------------------------------------------------------------------------

    test('Fix 4: routeResponse is called with synthetic-channel sentinel ChannelId for error routing', async () => {
        const registry       = makeRegistry(Promise.resolve());
        const client         = makeClient();
        const responseRouter = makeResponseRouter();
        const rateLimiter    = { sendToChannel: mock(async () => ({} as Message)) } as unknown as DiscordRateLimiter;

        spies.push(
            spyOn(channelRegistryModule, 'discoverAllChannels').mockRejectedValue(new Error('boom')),
            spyOn(channelRegistryModule, 'setupChannelEventHandlers').mockReturnValue(undefined)
        );

        initializeChannelRegistry(client, registry, responseRouter, rateLimiter);

        // Flush through the error path
        for(let i = 0; i < 8; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask draining
            await Promise.resolve();
        }

        const routeResponseMock = responseRouter.routeResponse as ReturnType<typeof mock>;
        expect(routeResponseMock).toHaveBeenCalledTimes(1);
        // Third argument must be the synthetic sentinel channel id string
        const calledChannelId = routeResponseMock.mock.calls[0]?.[2] as string;
        expect(calledChannelId).toBe('synthetic-channel');
    });
});

// ============================================================================
// setupChannelCleanupHandlers
// ============================================================================

// Helper to build a minimal Client mock that captures event handlers
function makeClientMock() {
    const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};

    const client = {
        on: mock((event: string, handler: (...args: unknown[]) => unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- handlers[event] may not exist yet
            if(!handlers[event]) {
                handlers[event] = [];
            }
            handlers[event].push(handler);
            return client;
        }),
    } as unknown as Client;

    const emit = (event: string, ...args: unknown[]): void => {
        for(const handler of (handlers[event] ?? [])) {
            handler(...args);
        }
    };

    const emitAsync = async (event: string, ...args: unknown[]): Promise<void> => {
        for(const handler of (handlers[event] ?? [])) {
            handler(...args);
        }
        // Flush microtasks so async safeAsyncHandler bodies complete
        await Promise.resolve();
    };

    return { client, emit, emitAsync };
}

describe('setupChannelCleanupHandlers', () => {
    describe('channelDelete handler', () => {
        test('calls coordinator.removeChannel() with channel id when channel has id', () => {
            const mockRemoveChannel = mock(() => undefined);
            const mockCoordinator = { removeChannel: mockRemoveChannel } as unknown as MessageCoordinator;
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            const channelId = '123456789012345678';
            emit('channelDelete', { id: channelId });

            expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
            expect(mockRemoveChannel).toHaveBeenCalledWith(createChannelId(channelId));
        });

        test('does NOT call coordinator.removeChannel() when channel lacks id property', () => {
            // This test kills the ConditionalExpression mutant (if(!('id' in channel)) → if(false))
            // With the mutant, the guard is skipped, then channel.id access would throw or produce wrong result
            const mockRemoveChannel = mock(() => undefined);
            const mockCoordinator = { removeChannel: mockRemoveChannel } as unknown as MessageCoordinator;
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            // Channel without 'id' property (e.g. PartialGroupDMChannel in some Discord.js versions)
            emit('channelDelete', { name: 'some-channel' });

            // Guard should trigger early return — coordinator.removeChannel should NOT be called
            expect(mockRemoveChannel).not.toHaveBeenCalled();
        });

        test('does not throw when coordinator is undefined', () => {
            const mockRegistry = { getAllChannels: mock(() => []) } as unknown as ChannelRegistryManager;
            const { client, emit } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: undefined, channelRegistry: mockRegistry });

            expect(() => emit('channelDelete', { id: '123456789012345678' })).not.toThrow();
        });
    });

    describe('guildDelete handler', () => {
        test('calls coordinator.removeGuildChannels() with only matching guild channel IDs', async () => {
            // This test kills the MethodExpression mutant:
            // _(allChannels).filter(['guildId', guildId]).map('channelId').value() → _(allChannels)
            // With the mutant, a lodash wrapper is passed instead of a ChannelId array
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId       = createGuildId('guild-abc');
            const otherGuildId  = createGuildId('guild-xyz');
            const channelId1    = createChannelId('ch-1');
            const channelId2    = createChannelId('ch-2');
            const otherChannelId = createChannelId('ch-other');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId: channelId1,    guildId,      channelName: 'chan-1' },
                    { channelId: channelId2,    guildId,      channelName: 'chan-2' },
                    { channelId: otherChannelId, guildId: otherGuildId, channelName: 'chan-other' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            // Should only contain the 2 channels from the deleted guild — NOT the other guild's channel
            const calledWith = (mockRemoveGuildChannels.mock.calls as unknown as [string[]][])[0]?.[0] ?? [];
            expect(calledWith).toHaveLength(2);
            expect(calledWith).toContain(channelId1);
            expect(calledWith).toContain(channelId2);
            expect(calledWith).not.toContain(otherChannelId);
        });

        test('calls coordinator.removeGuildChannels() with empty array when no matching channels', async () => {
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId      = createGuildId('guild-abc');
            const otherGuildId = createGuildId('guild-xyz');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId: createChannelId('ch-other'), guildId: otherGuildId, channelName: 'other' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            expect(mockRemoveGuildChannels).toHaveBeenCalledTimes(1);
            expect(mockRemoveGuildChannels).toHaveBeenCalledWith([]);
        });

        test('does not call coordinator.removeGuildChannels() when coordinator is undefined', async () => {
            const mockRegistry = {
                getAllChannels: mock(() => []),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: undefined, channelRegistry: mockRegistry });

            // Should not throw even without a coordinator
            await emitAsync('guildDelete', { id: 'guild-abc' });

            expect(mockRegistry.getAllChannels).not.toHaveBeenCalled();
        });

        test('filters channel IDs only (not full channel objects)', async () => {
            // Additional check: the result is an array of ChannelId strings, not channel metadata objects
            const mockRemoveGuildChannels = mock(() => undefined);
            const mockCoordinator = { removeGuildChannels: mockRemoveGuildChannels } as unknown as MessageCoordinator;

            const guildId   = createGuildId('guild-abc');
            const channelId = createChannelId('ch-1');

            const mockRegistry = {
                getAllChannels: mock(() => [
                    { channelId, guildId, channelName: 'chan-1', someOtherProp: 'extra' },
                ]),
            } as unknown as ChannelRegistryManager;

            const { client, emitAsync } = makeClientMock();

            setupChannelCleanupHandlers({ client, coordinator: mockCoordinator, channelRegistry: mockRegistry });

            await emitAsync('guildDelete', { id: guildId });

            const calledWith = (mockRemoveGuildChannels.mock.calls as unknown as [unknown[]][])[0]?.[0] ?? [];
            // Each entry should be the channelId string, not the full channel metadata object
            expect(calledWith).toHaveLength(1);
            expect(calledWith[0]).toBe(channelId);
            expect(calledWith.filter(item => typeof item === 'object' && item !== null)).toHaveLength(0);
        });
    });
});
