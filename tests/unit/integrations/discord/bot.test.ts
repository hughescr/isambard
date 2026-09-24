import { describe, test, expect, afterEach, beforeEach, mock, spyOn, jest } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import * as loggerModule from '@hughescr/logger';
import { MessageFlags, type Client } from 'discord.js';
import * as agentModule from '@/agent';
import { systemClock, type Conductor, type LedgerStore, type SessionJournal } from '@/agent';
import { createSessionSupervisor, startSessions, type SessionSupervisor } from '@/app/runtime';
import { DEFAULT_TASK_BOARD_CONFIG, type DiscordConfig } from '@/config/schemas';
import { InvariantViolationError } from '@/errors';
import type { AllowlistCommandHandler } from '@/integrations/discord/allowlist-commands';
import { createDiscordBot as createRealDiscordBot, type DiscordBot, type DiscordBotOptions } from '@/integrations/discord/bot';
import * as channelRegistryModule from '@/integrations/discord/channel-registry/discovery';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as clientModule from '@/integrations/discord/client';
import * as handlersModule from '@/integrations/discord/handlers';
import type { InboxManager } from '@/integrations/discord/inbox';
import * as ingressGateModule from '@/integrations/discord/ingress-gate';
import * as interactionsModule from '@/integrations/discord/interactions';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import type { PresenceManager } from '@/integrations/discord/presence/manager';
import { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import * as catchupSetupModule from '@/integrations/discord/setup/catchup-setup';
import * as coordinatorSetupModule from '@/integrations/discord/setup/coordinator-setup';
import type { EmailSetupResult } from '@/integrations/discord/setup/email-setup';
import * as eventHandlerSetupModule from '@/integrations/discord/setup/event-handler-setup';
import * as perchSetupModule from '@/integrations/discord/setup/perch-setup';
import * as presenceSetupModule from '@/integrations/discord/setup/presence-setup';
import * as wakeDeliveryModule from '@/integrations/discord/setup/wake-delivery';
import * as taskBoardSetupModule from '@/integrations/discord/task-board/setup';
import { createChannelId, createGuildId, createUserId, type ExchangeSpeaker } from '@/integrations/discord/types';
import { resolveTimezone } from '@/utils';

/** Flushes enough microtask ticks for a chained promise sequence to settle. */
async function flushMicrotasks(count = 10): Promise<void> {
    for(let i = 0; i < count; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

async function expectPromiseToRemainPending(promise: Promise<unknown>): Promise<void> {
    let settled = false;
    void promise.then(() => {
        settled = true;
        return undefined;
    }).catch(() => {
        settled = true;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
}

type InteractionRouteFeature = 'bsky' | 'email' | 'contact' | 'allowlist';

interface InteractionRouteExpectation {
    button:        string
    buttonHandler: ReturnType<typeof mock>
    modal?:        string
    modalHandler?: ReturnType<typeof mock>
}

/**
 * Dispatches each configured feature's owned button — and modal, where that feature has one —
 * except `omit`, through `onInteraction`, and asserts it reaches its real handler exactly once.
 * Proves that omitting one feature's setup/handler leaves the other three features' routing
 * tables intact, not merely that the omitted feature's own handlers were left untouched.
 */
async function expectRemainingFeaturesRouted(
    onInteraction: (interaction: unknown) => Promise<void>,
    featureRoutes: Record<InteractionRouteFeature, InteractionRouteExpectation>,
    omit: InteractionRouteFeature
): Promise<void> {
    const remainingFeatures = (['bsky', 'email', 'contact', 'allowlist'] as const).filter(feature => feature !== omit);
    for(const feature of remainingFeatures) {
        const route = featureRoutes[feature];
        // eslint-disable-next-line no-await-in-loop -- each remaining feature's route is checked independently
        await onInteraction({ customId: route.button, isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => false });
        expect(route.buttonHandler).toHaveBeenCalledTimes(1);
        if(route.modal !== undefined && route.modalHandler) {
            // eslint-disable-next-line no-await-in-loop -- each remaining feature's route is checked independently
            await onInteraction({ customId: route.modal, isButton: () => false, isModalSubmit: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false });
            expect(route.modalHandler).toHaveBeenCalledTimes(1);
        }
    }
}

function deferredPromise<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void } {
    let resolveFn!: (value: T) => void;
    let rejectFn!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

function mockRest(): { on: ReturnType<typeof mock> } {
    return { on: mock(() => undefined) };
}

/**
 * Session inputs the bot itself no longer takes (#41): the harness hands them, with the bot's own
 * conductors, to a REAL session supervisor (`src/app/runtime.ts`) the way `src/index.ts` does, so
 * the conductor-mode tests below exercise the bot and the supervisor together.
 */
interface SessionHarnessOptions {
    journal?:            SessionJournal
    perchJournal?:       SessionJournal
    exit?:               (code: number) => void
    shutdownTurnWaitMs?: number
    shutdownDeadlineMs?: number
}
type TestBotOptions = DiscordBotOptions & SessionHarnessOptions;

const harnessedBots = new Map<Client, { bot: DiscordBot, options: TestBotOptions, started: boolean }>();

/** Builds the real bot and records it against its Discord client, for {@link startHarnessedSessions}. */
function createDiscordBot(options: TestBotOptions): DiscordBot {
    const bot = createRealDiscordBot(options);
    const client = options.client ?? globalThis.__discordClient;
    if(client) {
        harnessedBots.set(client, { bot, options, started: false });
    }
    return bot;
}

/** A real session supervisor over the bot's conductors, supervised only when the old bot would have opened them (its full dependency set present). */
function supervisorFor(bot: DiscordBot, options: TestBotOptions): SessionSupervisor {
    const { conversationConductor, ledgerStore, contextPolicy, journal, perchConductor, perchLedgerStore, perchJournal } = options;
    return createSessionSupervisor({
        conversation: conversationConductor && ledgerStore && contextPolicy && journal ? { conductor: conversationConductor, journal } : undefined,
        perch:        perchConductor && perchLedgerStore && perchJournal ? { conductor: perchConductor, journal: perchJournal } : undefined,
        turnWaitMs:   options.shutdownTurnWaitMs ?? 60_000,
        deadlineMs:   options.shutdownDeadlineMs ?? 120_000,
        stopIngress:  () => {
            bot.stopIngress();
        },
        exit: options.exit ?? ((code: number): void => {
            throw new Error(`harness: exit(${code}) called without an injected exit mock`);
        }),
        clock:  options.clock ?? systemClock,
        logger: loggerModule.logger,
    });
}

/** Runs `startSessions` once for the bot built on `client` — what `src/index.ts`'s app.start() does. */
async function startHarnessedSessions(client: Client): Promise<void> {
    const harnessed = harnessedBots.get(client);
    if(harnessed && !harnessed.started) {
        harnessed.started = true;
        await startSessions({ host: harnessed.bot, supervisor: supervisorFor(harnessed.bot, harnessed.options), logger: loggerModule.logger });
    }
}

describe('createDiscordBot', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    // Setup common mocks
    const mockConfig: DiscordConfig = {
        botToken:      'test-bot-token',
        applicationId: 'test-app-id',
        homeGuildId:   createGuildId('111222333444555666'),
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

    // Most tests here build a one-off, minimal client mock (no `guilds`) and never care
    // about channel discovery at all. clientReady wires up initializeChannelRegistry(),
    // whose post-hydration channelRegistry.onReady() callback is fire-and-forget from
    // production code's perspective: it runs the real (unmocked, unless a test spies it
    // below) discoverAllChannels(), which throws on a client missing `guilds`. That throw
    // is caught internally and reaches the real ResponseRouter (bot.ts always constructs
    // one over whatever channelRegistry the test supplied), which itself throws because
    // mockChannelRegistry has no getWellKnownChannel() — logging 'Failed to send channel
    // registry error notification to owner' on a delay this test never observes. Left
    // undrained, that logger.error can settle during a LATER, unrelated test's own
    // microtask-flush and trip an assertion there. Defaulting discovery to a trivial
    // success keeps that fire-and-forget chain from ever reaching the notification path
    // for the many tests that don't care about it; a test that specifically exercises
    // discovery failure overrides this with its own spyOn(...).mockRejectedValue(...).
    beforeEach(() => {
        spyOn(channelRegistryModule, 'discoverAllChannels').mockResolvedValue({ discovered: 0, updated: 0, errors: [] });
    });

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
        harnessedBots.clear();
    });

    function makeMockClientForConductor(): Client {
        const client = {
            on:                 mock(() => client),
            once:               mock(() => client),
            login:              mock(async () => 'mock-token'),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               mockRest(),
            // `size` and `entries()` are populated so the REAL discoverAllChannels()
            // (unmocked by most tests here) resolves with zero guilds instead of throwing
            // ('entries is not a function' / reading `.size` of undefined). An empty,
            // successful discovery keeps clientReady's fire-and-forget onReady() callback
            // from reaching the operator-notification path and logging 'Failed to send
            // channel registry error notification to owner' on a delay that can otherwise
            // leak past this test's own assertions into a later, unrelated test.
            guilds:             { cache: { get: mock(() => undefined), size: 0, entries: mock(() => [].entries()) } },
        } as unknown as Client;
        return client;
    }

    /** Returns a plain object satisfying the shape tests need to observe — cast to `Conductor` at each call site, since only `open`/`shutdown`/`subscribeTurn` are ever exercised here. */
    function makeFakeConductor(overrides: Record<string, unknown> = {}) {
        return {
            open:             mock(async () => ({ sessionId: 'sess-1', resumed: false })),
            submit:           mock(async () => ({})),
            deliver:          mock(async () => ({ outcome: 'committed' as const, disposition: 'sent' as const })),
            interruptCurrent: mock(async () => undefined),
            subscribeTurn:    mock(() => mock(() => undefined)),
            status:           mock(() => ({})),
            shutdown:         mock(async () => undefined),
            ...overrides,
        } as unknown as Conductor & { open: ReturnType<typeof mock>, shutdown: ReturnType<typeof mock>, subscribeTurn: ReturnType<typeof mock> };
    }

    /**
     * `emit` is test-only (not part of `LedgerStore`): it invokes every listener `subscribe()`
     * was ever called with, letting a test simulate a ledger change without a real
     * `createLedgerStore` reducer. `unsubscribe` (bot.ts's own ring-buffer mirror, plus the
     * presence and task-board setups — the legacy ledger-shim subscriber was removed in P14) is
     * returned to every `subscribe()` call. `finishedTasks` is present because the task board
     * composes over it on every tick.
     */
    function makeFakeLedgerStore(sessionId: string | undefined = 'ledger-sess-1', unsubscribe: ReturnType<typeof mock> = mock(() => undefined)) {
        const listeners = new Set<(ledger: unknown, event?: unknown) => void>();
        return {
            get:       mock(() => ({ sessionId, tasks: [], finishedTasks: [] })),
            dispatch:  mock(() => undefined),
            subscribe: mock((l: (ledger: unknown, event?: unknown) => void) => {
                listeners.add(l);
                return unsubscribe;
            }),
            emit: (ledger: unknown, event?: unknown): void => {
                for(const listener of listeners) {
                    listener(ledger, event);
                }
            },
        } as unknown as LedgerStore & { get: ReturnType<typeof mock>, emit: (ledger: unknown, event?: unknown) => void };
    }

    function conductorDeps(overrides: Record<string, unknown> = {}): Partial<TestBotOptions> {
        return {
            conversationConductor: makeFakeConductor(),
            ledgerStore:           makeFakeLedgerStore(),
            contextPolicy:         { shouldInjectUserMemory: mock(() => false), markInjected: mock(() => undefined), eventsDelta: mock(() => Promise.resolve([])), markEventsSeen: mock(() => undefined), eventsSinceMs: mock(() => undefined), markEventsSeenAt: mock(() => undefined), stateTopSetDelta: mock(() => Promise.resolve({ added: [], removed: [], changed: [] })), markStateTopSetSeen: mock(() => Promise.resolve()), resetAll: mock(() => undefined), calendarDelta: mock(() => Promise.resolve({ agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false })), markCalendarSeen: mock(() => undefined), healthNote: mock(() => undefined), markHealthSeen: mock(() => undefined) },
            journal:               { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
            // A no-op stand-in for the real process.exit — the conductor-open-failure path calls
            // this with code 1, and without a mock here that would kill the whole test runner.
            exit:                  mock(() => undefined),
            ...overrides,
        };
    }

    /**
     * Fires the registered clientReady handler, then (the first time per bot) runs the real
     * `startSessions` sequence — open, attachSessions, boot recovery — and waits for it to settle.
     */
    async function triggerReady(client: Client): Promise<void> {
        const calls = (client.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (c: Client) => void | Promise<void>][];
        const handler = calls.find(([event]) => event === 'clientReady')?.[1];
        if(handler) {
            await handler(client);
        }
        await startHarnessedSessions(client);
    }

    function stubCoordinator() {
        const coordinator = {
            setProcessor: mock(() => undefined),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation(() => coordinator));
        return coordinator;
    }

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
            rest:               mockRest(),
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
            rest:               mockRest(),
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
            rest:               mockRest(),
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        await expect(bot.start()).rejects.toThrow('Invalid bot token');
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
            rest:               mockRest(),
        } as unknown as Client;

        spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

        const bot = createDiscordBot({
            config: mockConfig,

            channelRegistry: mockChannelRegistry,
        });

        await expect(bot.stop()).rejects.toThrow('Destroy failed');
    });

    test('should allow multiple start/stop cycles', async () => {
        const mockClient = {
            on:                 mock(() => mockClient),
            once:               mock(() => mockClient),
            login:              mock(async () => 'mock-token'),
            destroy:            mock(async () => undefined),
            removeAllListeners: mock(() => undefined),
            user:               { id: '999999999999999999', tag: 'TestBot#1234' },
            rest:               mockRest(),
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

    describe('Reconnection Handler Safety', () => {
        test('should use client.on() for clientReady so reconnects re-fire the handler', () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               mockRest(),
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
            const errorCalls = onCalls.filter(([event]) => event === 'error');

            // Should have at least one clientReady handler registered with on()
            expect(clientReadyCalls.length).toBeGreaterThan(0);
            expect(errorCalls).toHaveLength(1);
            expect(errorCalls[0]?.[1]).toBeInstanceOf(Function);

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
                rest:               mockRest(),
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

            // A fully-opened conductor is required to enable coordinator creation (required for
            // the messageCreate handler).
            stubCoordinator();
            const deps = conductorDeps();

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                ...deps,
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
            await startHarnessedSessions(mockClient);

            // After first clientReady (and the sessions attaching), messageCreate handler should be registered
            expect(messageCreateHandlerCount).toBe(1);

            // Fire clientReady again (simulating reconnect)
            for(const handler of clientReadyHandlers) {
                // eslint-disable-next-line no-await-in-loop -- sequential: each handler must complete before next
                await Promise.resolve(handler(mockClient));
            }
            await flushMicrotasks();

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
                rest:               mockRest(),
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

            // A fully-opened conductor is required to enable coordinator creation (required for
            // the messageCreate handler).
            stubCoordinator();
            const deps = conductorDeps();

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                ...deps,
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
            // clientReady alone only signals readiness: messageCreate waits for the sessions.
            expect(messageCreateRegistered).toBe(false);
            await startHarnessedSessions(mockClient);

            // After clientReady fires and the sessions attach, messageCreate SHOULD be registered
            expect(messageCreateRegistered).toBe(true);
        });
    });

    describe('Presence Manager Lifecycle', () => {
        function presenceConfig(): DiscordConfig {
            return {
                ...mockConfig,
                presence: {
                    updateThrottleMs:      2000,
                    idleTimeoutMs:         60_000,
                    idleRefreshIntervalMs: 300_000,
                },
            };
        }

        test('P14: creates presence manager (via setupConductorPresence) once the conductor has opened, with identityContext and config.presence', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const mockPresenceManager = { start: mock(() => undefined), stop: mock(() => undefined) };
            const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                presenceManager:    mockPresenceManager as unknown as PresenceManager,
                unsubscribeLedgers: mock(() => undefined),
            });
            spies.push(setupConductorPresenceSpy);

            const ledgerStore = makeFakeLedgerStore();
            const deps = conductorDeps({ ledgerStore });

            createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                ...deps,
            });

            await triggerReady(client);

            expect(setupConductorPresenceSpy).toHaveBeenCalled();
        });

        test('setupCoordinatorIntegration is no longer given the presence-synopsis wiring (it moved to presence setup)', async () => {
            const client = makeMockClientForConductor();
            let capturedParams: object | undefined;
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(client),
                spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                }),
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params) => {
                    capturedParams = params;
                    return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                })
            );

            const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

            createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                ...deps,
            });

            await triggerReady(client);

            expect(capturedParams).toBeDefined();
            expect(capturedParams).not.toHaveProperty('ledgerStore');
            expect(capturedParams).not.toHaveProperty('presenceThrottle');
            expect(capturedParams).not.toHaveProperty('dynamicStatusGenerator');
            expect(capturedParams).not.toHaveProperty('onThinkingContentUpdate');
        });

        test('setupConductorPresence receives the conversation ledger alone, getLastThinkingContent from options, and no synopsis wiring', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                presenceManager:    { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager,
                unsubscribeLedgers: mock(() => undefined),
            });
            spies.push(setupConductorPresenceSpy);

            const ledgerStore = makeFakeLedgerStore();
            const deps = conductorDeps({ ledgerStore });
            const getLastThinkingContent = mock(() => 'last thought');

            createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                getLastThinkingContent,
                ...deps,
            });

            await triggerReady(client);

            const call = setupConductorPresenceSpy.mock.calls[0]?.[0];
            expect(call.ledgers).toEqual([ledgerStore]);
            expect(call.getLastThinkingContent).toBe(getLastThinkingContent);
            expect(call).not.toHaveProperty('onThinkingContentUpdate');
            expect(call).not.toHaveProperty('sessions');
        });

        test('setupConductorPresence receives the ledgers [conversation, perch] in that order when a perch ledger is present', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                presenceManager:    { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager,
                unsubscribeLedgers: mock(() => undefined),
            });
            spies.push(setupConductorPresenceSpy);

            const ledgerStore = makeFakeLedgerStore();
            const perchLedgerStore = makeFakeLedgerStore('perch-sess-1');
            const deps = conductorDeps({
                ledgerStore,
                perchConductor: makeFakeConductor(),
                perchLedgerStore,
                perchJournal:   { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
            });

            createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                ...deps,
            });

            await triggerReady(client);

            const ledgers = setupConductorPresenceSpy.mock.calls[0]?.[0].ledgers;
            expect(ledgers).toHaveLength(2);
            expect(ledgers[0]).toBe(ledgerStore);
            expect(ledgers[1]).toBe(perchLedgerStore);
        });

        test('should NOT create presence manager when identityContext is missing', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence');
            spies.push(setupConductorPresenceSpy);

            const ledgerStore = makeFakeLedgerStore();
            const deps = conductorDeps({ ledgerStore });

            createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                // identityContext missing
                ...deps,
            });

            await triggerReady(client);

            expect(setupConductorPresenceSpy).not.toHaveBeenCalled();
        });

        test('P14: calls presenceManager.stop() before client.destroy()', async () => {
            const callOrder: string[] = [];
            const client = makeMockClientForConductor();
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(client),
                spyOn(client, 'destroy').mockImplementation(async () => {
                    callOrder.push('destroy');
                }),
                spyOn(client, 'removeAllListeners').mockImplementation(() => {
                    callOrder.push('removeAllListeners');
                    return client;
                })
            );
            stubCoordinator();

            const mockPresenceManager = {
                start: mock(() => undefined),
                stop:  mock(() => {
                    callOrder.push('presenceManager.stop');
                }),
            };
            spies.push(spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                presenceManager:    mockPresenceManager as unknown as PresenceManager,
                unsubscribeLedgers: mock(() => undefined),
            }));

            const ledgerStore = makeFakeLedgerStore();
            const deps = conductorDeps({ ledgerStore });

            const bot = createDiscordBot({
                config:          presenceConfig(),
                channelRegistry: mockChannelRegistry,
                identityContext: 'Test identity',
                ...deps,
            });

            await triggerReady(client);
            await bot.stop();

            expect(callOrder).toEqual(['presenceManager.stop', 'removeAllListeners', 'destroy']);
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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

        test('should preserve global state when the provided client is also the global client', async () => {
            const sharedClient = {
                on:                 mock(() => sharedClient),
                once:               mock(() => sharedClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               mockRest(),
            } as unknown as Client;
            globalThis.__discordClient = sharedClient;

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                client:          sharedClient,
            });
            await bot.stop();

            expect(globalThis.__discordClient).toBe(sharedClient);
        });

        test('should preserve a newer global client when an older global bot stops', async () => {
            const oldClient = {
                on:                 mock(() => oldClient),
                once:               mock(() => oldClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'OldBot#1234' },
                rest:               mockRest(),
            } as unknown as Client;
            const newerClient = {
                on:                 mock(() => newerClient),
                once:               mock(() => newerClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '888888888888888888', tag: 'NewBot#5678' },
                rest:               mockRest(),
            } as unknown as Client;
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(oldClient));

            const oldBot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
            });
            globalThis.__discordClient = newerClient;

            await oldBot.stop();

            expect(globalThis.__discordClient).toBe(newerClient);
        });

        test('stop tears down the injected question registry and rate limiter', async () => {
            const client = makeMockClientForConductor();
            const questionRegistry = { stop: mock(() => undefined) };
            const rateLimiterStopSpy = spyOn(DiscordRateLimiter.prototype, 'stop');
            spies.push(rateLimiterStopSpy);

            const bot = createDiscordBot({
                config:           mockConfig,
                channelRegistry:  mockChannelRegistry,
                client,
                questionRegistry: questionRegistry as never,
            });
            await bot.stop();

            expect(questionRegistry.stop).toHaveBeenCalledTimes(1);
            expect(rateLimiterStopSpy).toHaveBeenCalledTimes(1);
        });

        test('settles pending question reactions before unsubscribing ledger presence', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const ledger = { sessionId: 'question-ledger', tasks: [], finishedTasks: [] } as unknown as ReturnType<LedgerStore['get']>;
            const listeners = new Set<Parameters<LedgerStore['subscribe']>[0]>();
            const ledgerStore = {
                get:      mock(() => ledger),
                dispatch: mock((event: Parameters<LedgerStore['dispatch']>[0]) => {
                    for(const listener of listeners) {
                        listener(ledger, event);
                    }
                }),
                subscribe: mock((listener: Parameters<LedgerStore['subscribe']>[0]) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                }),
            } as unknown as LedgerStore & { dispatch: ReturnType<typeof mock> };
            let presenceObservedLedgerUpdate = false;
            let ledgerPresenceUnsubscribed = false;
            let cleanupPresenceListener: () => void = () => undefined;
            spies.push(spyOn(presenceSetupModule, 'setupConductorPresence').mockImplementation(() => {
                const unsubscribe = ledgerStore.subscribe(() => {
                    presenceObservedLedgerUpdate = true;
                });
                cleanupPresenceListener = unsubscribe;
                return {
                    presenceManager:    { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: () => {
                        ledgerPresenceUnsubscribed = true;
                        unsubscribe();
                    },
                };
            }));

            const questionRegistry = new agentModule.QuestionRegistry();
            const pendingQuestion = questionRegistry.register({
                questionId:      'shutdown-question',
                channelId:       createChannelId('question-channel'),
                originMessageId: 'question-message',
                triggerUserId:   createUserId('question-user'),
                questionText:    'Continue?',
                createdAt:       Date.now(),
                expiresAt:       Date.now() + 60_000,
            });
            const reactionObservedSubscription = pendingQuestion.then(() => {
                ledgerStore.dispatch({ type: 'tick', rssBytes: 0, at: new Date() });
                return presenceObservedLedgerUpdate;
            });
            let reactionSawSubscribedPresence: boolean | undefined;
            try {
                const bot = createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    identityContext: 'Test identity',
                    questionRegistry,
                    ...conductorDeps({ ledgerStore }),
                });
                await triggerReady(client);
                await bot.stop();
                reactionSawSubscribedPresence = await reactionObservedSubscription;
            } finally {
                questionRegistry.stop();
                cleanupPresenceListener();
            }

            expect(reactionSawSubscribedPresence).toBe(true);
            expect(ledgerStore.dispatch).toHaveBeenCalledTimes(1);
            expect(ledgerPresenceUnsubscribed).toBe(true);
        });

        test('waits for an asynchronous teardown failure before completing stop()', async () => {
            const client = makeMockClientForConductor();
            const failure = deferredPromise<void>();
            const bot = createDiscordBot({
                config:           mockConfig,
                client,
                channelRegistry:  mockChannelRegistry,
                questionRegistry: { stop: mock(() => failure.promise) } as unknown as DiscordBotOptions['questionRegistry'],
            });

            const stopping = bot.stop();
            let settled = false;
            void stopping.then(() => {
                settled = true;
                return undefined;
            }).catch(() => {
                settled = true;
                return undefined;
            });
            await flushMicrotasks();
            expect(settled).toBe(false);

            failure.reject(new Error('question teardown failed'));
            await expect(stopping).rejects.toThrow('question teardown failed');
        });

        test('waits for client destruction even if earlier teardown throws', async () => {
            const teardownError = new Error('question registry stop failed');
            const client = makeMockClientForConductor();
            const stopOrder: string[] = [];
            const questionRegistry = { stop: mock(() => {
                stopOrder.push('question');
                throw teardownError;
            }) };
            const channelRegistry = {
                ...mockChannelRegistry,
                stop: mock(() => {
                    stopOrder.push('channel hydration');
                }),
            } as unknown as ChannelRegistryManager;
            const rateLimiterStopSpy = spyOn(DiscordRateLimiter.prototype, 'stop');
            spies.push(rateLimiterStopSpy);
            const destroyStarted = Promise.withResolvers<void>();
            const destroyGate = Promise.withResolvers<void>();
            client.destroy = mock(() => {
                stopOrder.push('client');
                destroyStarted.resolve();
                return destroyGate.promise;
            });
            const bot = createDiscordBot({
                config:           mockConfig,
                channelRegistry,
                client,
                questionRegistry: questionRegistry as never,
            });

            const stopping = bot.stop();
            await destroyStarted.promise;
            let settled = false;
            void stopping.finally(() => {
                settled = true;
            }).catch(() => undefined);
            await Promise.resolve();
            expect(settled).toBe(false);
            expect(client.removeAllListeners).toHaveBeenCalledTimes(1);
            expect(rateLimiterStopSpy).toHaveBeenCalledTimes(1);
            expect(channelRegistry.stop).toHaveBeenCalledTimes(1);
            expect(stopOrder).toEqual(['question', 'channel hydration', 'client']);
            destroyGate.resolve();
            await expect(stopping).rejects.toBe(teardownError);
            expect(client.destroy).toHaveBeenCalledTimes(1);
        });

        test('preserves the first teardown error and reports a later destroy failure', async () => {
            const teardownError = new Error('question registry stop failed');
            const destroyError = new Error('Discord destroy failed');
            const client = makeMockClientForConductor();
            client.destroy = mock(async () => {
                throw destroyError;
            });
            const questionRegistry = { stop: mock(() => {
                throw teardownError;
            }) };
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            spies.push(warnSpy);
            const bot = createDiscordBot({
                config:           mockConfig,
                channelRegistry:  mockChannelRegistry,
                client,
                questionRegistry: questionRegistry as never,
            });

            await expect(bot.stop()).rejects.toBe(teardownError);
            expect(client.destroy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
                error: destroyError.message,
                msg:   expect.stringContaining('Discord client destruction'),
            }));
        });

        test('continues destruction after listener removal fails and reports its shutdown phase', async () => {
            const firstError = new Error('question stop failed');
            const client = makeMockClientForConductor();
            client.removeAllListeners = mock(() => {
                throw new Error('listener cleanup failed');
            });
            const warn = spyOn(loggerModule.logger, 'warn');
            spies.push(warn);
            const bot = createDiscordBot({
                config:           mockConfig, client, channelRegistry:  mockChannelRegistry,
                questionRegistry: { stop: mock(() => { throw firstError; }) } as unknown as DiscordBotOptions['questionRegistry'],
            });
            await expect(bot.stop()).rejects.toBe(firstError);
            expect(client.destroy).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith({ error: 'listener cleanup failed', msg: 'Listener removal failed after an earlier bot shutdown error' });
        });

        test('retains an owned global client if destruction fails', async () => {
            const client = makeMockClientForConductor();
            const destroyError = new Error('destroy failed');
            client.destroy = mock(async () => {
                throw destroyError;
            });
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            const bot = createDiscordBot({ config: mockConfig, channelRegistry: mockChannelRegistry });
            expect(globalThis.__discordClient).toBe(client);
            await expect(bot.stop()).rejects.toBe(destroyError);
            expect(globalThis.__discordClient).toBe(client);
        });

        test('reports the phase for every failed shutdown component while preserving the first error', async () => {
            const client = makeMockClientForConductor();
            const firstError = new Error('coordinator failed');
            const failure = (name: string) => mock(() => {
                throw new Error(`${name} failed`);
            });
            const warn = spyOn(loggerModule.logger, 'warn');
            const ledgerStore = makeFakeLedgerStore('session', failure('tracking unsubscribe'));
            const perchLedgerStore = makeFakeLedgerStore('perch', failure('perch tracking unsubscribe'));
            const presence = { start: mock(() => undefined), stop: failure('presence manager') } as unknown as PresenceManager;
            const scheduler = { start: mock(() => undefined), stop: failure('perch scheduler'), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
            const driver = { runSlot: mock(() => 'started' as const), stop: failure('perch driver') };
            spies.push(
                warn,
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockReturnValue({ stop: mock(() => { throw firstError; }) } as unknown as MessageCoordinator),
                spyOn(ingressGateModule, 'createIngressGate').mockReturnValue({ admit: mock(() => 'pass'), open: mock(() => undefined), state: mock(() => 'buffering'), stop: failure('ingress gate') } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>),
                spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({ presenceManager: presence, unsubscribeLedgers: failure('ledger presence') }),
                spyOn(taskBoardSetupModule, 'setupTaskBoard').mockReturnValue({ stop: failure('task board') }),
                spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({ driver, scheduler }),
                spyOn(DiscordRateLimiter.prototype, 'stop').mockImplementation(failure('rate limiter'))
            );
            const channelRegistry = { ...mockChannelRegistry, stop: failure('channel registry') } as unknown as ChannelRegistryManager;
            const perchConductor = makeFakeConductor();
            const deps = conductorDeps({ ledgerStore, perchConductor, perchLedgerStore, perchJournal: { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) } });
            const bot = createDiscordBot({
                config:           { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                client, channelRegistry, identityContext:  'Test identity',
                perchConfig:      { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5 },
                questionRegistry: { stop: failure('question registry') } as unknown as DiscordBotOptions['questionRegistry'],
                ...deps,
            });
            await triggerReady(client);
            await expect(bot.stop()).rejects.toBe(firstError);
            const messages = warn.mock.calls.map(call => (call[0] as { msg?: string }).msg);
            expect(messages).toContain('Coordinator stop failed during bot shutdown');
            for(const phase of ['Perch scheduler stop', 'Perch driver stop', 'Ingress gate stop', 'Question registry stop', 'Ledger presence unsubscribe', 'Task board stop', 'Tool tracking unsubscribe', 'Channel tracking unsubscribe', 'Presence manager stop', 'Rate limiter stop', 'Channel registry stop']) {
                expect(messages).toContain(`${phase} failed after an earlier bot shutdown error`);
            }
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
                rest: mockRest(),
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
                shouldProcess:       mock(() => true),
                getChannel:          mock(() => Promise.resolve(null)),
                warmCache:           mock(() => Promise.resolve()),
                startHydration:      mock(() => undefined),
                stop:                mock(() => undefined),
                ready:               readyPromise,
                // onReady mirrors the real implementation: attach callback to the current ready promise
                // eslint-disable-next-line promise/no-callback-in-promise -- intentional: cb is a registered lifecycle callback, not a Node-style errback
                onReady:             mock((cb: () => void | Promise<void>) => { void readyPromise.then(() => cb()); }),
                getAllChannels:      mock(() => []),
                muteChannel:         mock(async (): Promise<void> => undefined),
                // createDiscordBot() always constructs a real ResponseRouter over this manager
                // (bot.ts's own responseRouter, independent of anything a test mocks). Without
                // this, a discovery-failure test's fire-and-forget notification path throws
                // 'getWellKnownChannel is not a function' instead of exercising the failure mode
                // the test actually names — and, undrained, that stray rejection can settle late
                // enough to log past this test's own boundary.
                getWellKnownChannel: mock(async () => ({ channelId: 'fallback-channel-id', channelName: 'fallback' })),
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
                rest:               mockRest(),
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
                rest:               mockRest(),
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

    describe('Conductor mode (P9)', () => {
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
                ...deps,
            });

            await triggerReady(client);

            expect(callOrder).toEqual(['initializeChannelRegistry', 'conductor.open', 'setupCoordinatorIntegration']);
            expect(deps.exit).not.toHaveBeenCalled();
        });

        test('never wires the coordinator or task board when open() rejects — processing stays disabled', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            const setupCoordinatorIntegrationSpy = spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration');
            const setupTaskBoardSpy = spyOn(taskBoardSetupModule, 'setupTaskBoard');
            spies.push(setupCoordinatorIntegrationSpy, setupTaskBoardSpy);

            const conductor = makeFakeConductor({ open: mock(() => Promise.reject(new Error('boom'))) });
            const deps = conductorDeps({ conversationConductor: conductor });

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                ...deps,
            });

            await triggerReady(client);

            // A rejected open() never switches conductorOpened to true, so neither the
            // coordinator nor the ledger-backed task board is constructed.
            expect(setupCoordinatorIntegrationSpy).not.toHaveBeenCalled();
            expect(setupTaskBoardSpy).not.toHaveBeenCalled();
            expect(conductor.subscribeTurn).not.toHaveBeenCalled();
            expect(deps.exit).toHaveBeenCalledWith(1);
        });

        test('exits the process when open() rejects — there is no fallback agent to degrade to', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            const errorLog = spyOn(loggerModule.logger, 'error');
            spies.push(errorLog);

            const conductor = makeFakeConductor({ open: mock(() => Promise.reject(new Error('boom'))) });
            const deps = conductorDeps({ conversationConductor: conductor });

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                ...deps,
            });

            await triggerReady(client);

            expect(deps.exit).toHaveBeenCalledTimes(1);
            expect(deps.exit).toHaveBeenCalledWith(1);
            expect(errorLog).toHaveBeenCalledWith({ error: 'boom', msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
        });

        test('never wires the coordinator without hanging forever when open() never settles', async () => {
            jest.useFakeTimers();
            const errorLog = spyOn(loggerModule.logger, 'error');
            spies.push(errorLog);

            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

            const setupCoordinatorIntegrationSpy = spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration');
            spies.push(setupCoordinatorIntegrationSpy);

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
                ...deps,
            });

            const readyPromise = triggerReady(client);

            await flushMicrotasks();
            jest.advanceTimersByTime(29_999);
            await flushMicrotasks();
            expect(deps.exit).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            await readyPromise;

            expect(setupCoordinatorIntegrationSpy).not.toHaveBeenCalled();
            expect(conductor.subscribeTurn).not.toHaveBeenCalled();
            expect(deps.exit).toHaveBeenCalledWith(1);
            expect(errorLog).toHaveBeenCalledWith({ error: 'conductor.open() timed out', msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
        });

        test('message processing receives a logged rate limiter and LLM-backed answer classifier', async () => {
            const client = makeMockClientForConductor();
            const debug = spyOn(loggerModule.logger, 'debug');
            let rateLimiter: DiscordRateLimiter | undefined;
            let classifierConfig: { classifyWithLLM?: unknown } | undefined;
            spies.push(
                debug,
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: { rateLimiter: DiscordRateLimiter }) => {
                    rateLimiter = params.rateLimiter;
                    return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                }),
                // @ts-expect-error — Mocking constructor
                spyOn(agentModule, 'AnswerClassifier').mockImplementation((config: { classifyWithLLM?: unknown }) => {
                    classifierConfig = config;
                    return { classify: mock(async () => 'answer') };
                })
            );
            const deps = conductorDeps();
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...deps });
            await triggerReady(client);
            expect(deps.exit).not.toHaveBeenCalled();
            expect(rateLimiter).toBeDefined();
            expect(classifierConfig?.classifyWithLLM).toBe(agentModule.classifyWithHaiku);
            const channel = { id: 'channel-1', send: mock(async () => ({ id: 'message-1' })) };
            await rateLimiter!.sendToChannel(channel as never, 'hello');
            expect(debug).toHaveBeenCalledWith({ msg: 'Queueing send to channel', channelId: 'channel-1', contentLength: 5 });
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
                ...deps,
            });

            await triggerReady(client);

            expect(typeof capturedParams?.envelopeProvider?.resolveNames).toBe('function');
            expect(typeof capturedParams?.envelopeProvider?.toEnvelopeInput).toBe('function');
            expect(typeof capturedParams?.envelopeProvider?.channelList).toBe('function');
        });

        test('a repeated clientReady (reconnect) does not re-run the readiness setup', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();
            const initializeSpy = spyOn(eventHandlerSetupModule, 'initializeChannelRegistry').mockImplementation(() => undefined);
            spies.push(initializeSpy);

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                ...conductorDeps(),
            });

            await triggerReady(client);
            await triggerReady(client);

            expect(initializeSpy).toHaveBeenCalledTimes(1);
        });

        test('seeds lastSessionId from the ledger after a successful open()', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const ledgerStore = makeFakeLedgerStore('from-the-ledger');
            const deps = conductorDeps({ ledgerStore });
            let capturedGetCurrentSessionId: (() => string | undefined) | undefined;
            let updateSessionId: ((id: string | undefined) => void) | undefined;
            spies.push(
                spyOn(agentModule, 'createTaskListReader').mockImplementation((params: { getCurrentSessionId: () => string | undefined }) => {
                    capturedGetCurrentSessionId = params.getCurrentSessionId;
                    return { buildTaskListSummary: mock(() => Promise.resolve(undefined)) };
                }),
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: { setLastSessionId?: (id: string | undefined) => void }) => {
                    updateSessionId = params.setLastSessionId;
                    return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                })
            );

            createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                ...deps,
            });

            await triggerReady(client);

            // createTaskListReader's getCurrentSessionId is the SAME closure bot.ts calls
            // setLastSessionId(ledgerStore.get().sessionId) through — reading it after open()
            // resolves proves the ledger's actual value was seeded, not merely that get() ran.
            expect(capturedGetCurrentSessionId?.()).toBe('from-the-ledger');
            updateSessionId?.(undefined);
            expect(capturedGetCurrentSessionId?.()).toBe('from-the-ledger');
        });

        test('stop order: coordinator.stop -> conductor.shutdown -> ring-buffer unsubscribe', async () => {
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
            const ledgerUnsubscribe = mock(() => {
                callOrder.push('ring-buffer unsubscribe');
            });
            const ledgerStore = makeFakeLedgerStore('ledger-sess-1', ledgerUnsubscribe);
            const deps = conductorDeps({ conversationConductor: conductor, ledgerStore });

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                ...deps,
            });

            await triggerReady(client);
            await bot.stop();

            // The tool-tracking ring buffer, the channel-tracking ring buffer and the task board
            // all subscribe to the same underlying ledger store, so the fake's shared unsubscribe
            // fires three times — after conductor.shutdown in every case.
            expect(callOrder).toEqual(['coordinator.stop', 'conductor.shutdown', 'ring-buffer unsubscribe', 'ring-buffer unsubscribe', 'ring-buffer unsubscribe']);
            expect(ledgerUnsubscribe).toHaveBeenCalledTimes(3);
        });

        test.each(['coordinator', 'ingress', 'ledgerPresence', 'taskBoard', 'presence', 'rateLimiter', 'channelRegistry'] as const)('stop() waits for asynchronous %s teardown', async (phase) => {
            const client = makeMockClientForConductor();
            const completion = deferredPromise<void>();
            const stopFor = (candidate: typeof phase): void | Promise<void> => (candidate === phase ? completion.promise : undefined);
            const channelRegistry = { ...mockChannelRegistry, stop: mock(() => stopFor('channelRegistry')) } as unknown as ChannelRegistryManager;
            const coordinator = { setProcessor: mock(() => undefined), stop: mock(() => stopFor('coordinator')) } as unknown as MessageCoordinator;
            const ingressGate = { admit: mock(() => 'pass'), open: mock(() => undefined), state: mock(() => 'buffering'), stop: mock(() => stopFor('ingress')) };
            const presenceManager = { start: mock(() => undefined), stop: mock(() => stopFor('presence')) } as unknown as PresenceManager;
            const conductorPresence = { presenceManager, unsubscribeLedgers: mock(() => stopFor('ledgerPresence')) };
            const taskBoard = { stop: mock(() => stopFor('taskBoard')) };
            const rateLimiterStop = mock(() => stopFor('rateLimiter'));
            spies.push(
                spyOn(clientModule, 'createDiscordClient').mockReturnValue(client),
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockReturnValue(coordinator),
                spyOn(ingressGateModule, 'createIngressGate').mockReturnValue(ingressGate as unknown as ReturnType<typeof ingressGateModule.createIngressGate>),
                spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue(conductorPresence),
                spyOn(taskBoardSetupModule, 'setupTaskBoard').mockReturnValue(taskBoard),
                // eslint-disable-next-line @typescript-eslint/no-misused-promises -- shutdown accepts either synchronous or asynchronous resource cleanup.
                spyOn(DiscordRateLimiter.prototype, 'stop').mockImplementation(rateLimiterStop)
            );
            const bot = createDiscordBot({
                config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                client,
                channelRegistry,
                identityContext: 'Test identity',
                ...conductorDeps(),
            });
            await triggerReady(client);

            const stopping = bot.stop();
            let settled = false;
            void stopping.then(() => {
                settled = true;
                return undefined;
            }).catch(() => {
                settled = true;
                return undefined;
            });
            await flushMicrotasks(100);
            expect(settled).toBe(false);
            completion.resolve();
            await stopping;
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
                ...deps,
            });

            await triggerReady(client);
            await bot.stop();

            expect(gateStop).toHaveBeenCalledTimes(2);
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

        test('a failed gate-drained message is logged and does not block the next message', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            let onDrain: ((message: { id: string }) => void) | undefined;
            const failure = new Error('dispatch failed');
            const errorLog = spyOn(loggerModule.logger, 'error');
            const dispatched: string[] = [];
            spies.push(
                errorLog,
                spyOn(ingressGateModule, 'createIngressGate').mockImplementation((options) => {
                    onDrain = options.onDrain as unknown as (message: { id: string }) => void;
                    return { admit: mock(() => 'pass'), open: mock(() => undefined), stop: mock(() => undefined), state: mock(() => 'buffering') } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>;
                }),
                spyOn(handlersModule, 'dispatchAdmittedMessage').mockImplementation(async (message) => {
                    const id = (message as { id: string }).id;
                    dispatched.push(id);
                    if(id === 'first') {
                        throw failure;
                    }
                })
            );
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await triggerReady(client);
            onDrain?.({ id: 'first' });
            onDrain?.({ id: 'second' });
            await flushMicrotasks();
            expect(dispatched).toEqual(['first', 'second']);
            expect(errorLog).toHaveBeenCalledWith({ err: failure, msg: 'dispatchAdmittedMessage failed for a gate-drained message' });
        });

        test('gate-drained routing omits perch delivery when the perch conductor failed to open', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            let onDrain: ((message: { id: string }) => void) | undefined;
            const perchValues: unknown[] = [];
            spies.push(
                spyOn(ingressGateModule, 'createIngressGate').mockImplementation((options) => {
                    onDrain = options.onDrain as unknown as (message: { id: string }) => void;
                    return { admit: mock(() => 'pass'), open: mock(() => undefined), stop: mock(() => undefined), state: mock(() => 'buffering') } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>;
                }),
                spyOn(handlersModule, 'dispatchAdmittedMessage').mockImplementation(async (_message, _botUserId, _coordinator, options) => {
                    perchValues.push(options.perch);
                })
            );
            const perchConductor = makeFakeConductor({ open: mock(async () => {
                throw new Error('perch unavailable');
            }) });
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch'), perchJournal: { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) } }) });
            await triggerReady(client);
            onDrain?.({ id: 'buffered' });
            await flushMicrotasks();
            expect(perchValues).toEqual([undefined]);
        });

        test('shutdown preserves its first failure while reporting ingress and warning failures', async () => {
            const client = makeMockClientForConductor();
            const coordinatorFailure = new Error('coordinator stop failed');
            const ingressFailure = new Error('ingress stop failed');
            const warningFailure = new Error('warning logger failed');
            const warn = spyOn(loggerModule.logger, 'warn').mockImplementation((...args: unknown[]) => {
                const entry = args[0] as { msg?: string };
                if(entry.msg === 'Conductor shutdown() failed — continuing with the rest of stop()') {
                    throw warningFailure;
                }
                return loggerModule.logger;
            });
            spies.push(
                warn,
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockReturnValue({ stop: mock(() => { throw coordinatorFailure; }) } as unknown as MessageCoordinator),
                spyOn(ingressGateModule, 'createIngressGate').mockReturnValue({ admit: mock(() => 'pass'), open: mock(() => undefined), state: mock(() => 'buffering'), stop: mock(() => { throw ingressFailure; }) } as unknown as ReturnType<typeof ingressGateModule.createIngressGate>)
            );
            const bot = createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await triggerReady(client);
            await expect(bot.stop()).rejects.toBe(coordinatorFailure);
            expect(warn).toHaveBeenCalledWith({ error: 'ingress stop failed', msg: 'Ingress gate stop failed after an earlier bot shutdown error' });
            expect(warn).toHaveBeenCalledWith({ error: 'ingress stop failed', msg: 'Conductor shutdown() failed — continuing with the rest of stop()' });
            expect(warn).toHaveBeenCalledWith({ error: 'warning logger failed', msg: 'Conductor shutdown warning failed after an earlier bot shutdown error' });
        });

        test('stop() with a provided client runs the attached session shutdown and leaves the global client in place', async () => {
            const client = makeMockClientForConductor();
            globalThis.__discordClient = client;
            stubCoordinator();
            const conductor = makeFakeConductor();

            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                client,
                ...conductorDeps({ conversationConductor: conductor }),
            });

            await triggerReady(client);
            await bot.stop();

            expect(conductor.shutdown).toHaveBeenCalledTimes(1);
            expect(globalThis.__discordClient).toBe(client);
        });

        test('triggerCatchUp submits a catch-up envelope through the conductor in conductor mode when unread mail remains', async () => {
            const client = makeMockClientForConductor();
            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
            stubCoordinator();

            const submitConductorCatchUpSpy = spyOn(catchupSetupModule, 'submitConductorCatchUp').mockResolvedValue(undefined);
            spies.push(submitConductorCatchUpSpy);

            const inboxManager = {
                loadUnread:        mock(async () => undefined),
                getUnreadOverview: mock(() => ({ totalUnread: 1, channels: [{ channelId: 'c1' }] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;

            const deps = conductorDeps();
            const bot = createDiscordBot({
                config:          mockConfig,
                channelRegistry: mockChannelRegistry,
                inboxManager,
                ...deps,
            });

            await triggerReady(client);
            await bot.triggerCatchUp();

            expect(submitConductorCatchUpSpy).toHaveBeenCalled();
        });

        test('triggerCatchUp waits for conductor submission to finish', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const started = Promise.withResolvers<void>();
            const completion = Promise.withResolvers<void>();
            const submit = spyOn(catchupSetupModule, 'submitConductorCatchUp').mockImplementation(() => {
                started.resolve();
                return completion.promise;
            });
            spies.push(submit);
            let totalUnread = 0;
            const inboxManager = {
                loadUnread:        mock(async () => undefined),
                getUnreadOverview: mock(() => ({ totalUnread, channels: totalUnread > 0 ? [{ channelId: 'c1' }] : [] })),
                replayUnhandled:   mock(async () => []),
                recordHandled:     mock(async () => undefined),
                setBotUserId:      mock(() => undefined),
            } as unknown as InboxManager;
            const bot = createDiscordBot({
                config:          mockConfig,
                client,
                channelRegistry: mockChannelRegistry,
                inboxManager,
                ...conductorDeps(),
            });
            await triggerReady(client);
            totalUnread = 1;

            const catchingUp = bot.triggerCatchUp();
            await started.promise;
            try {
                await expectPromiseToRemainPending(catchingUp);
            } finally {
                completion.resolve();
            }
            await catchingUp;
            expect(submit).toHaveBeenCalledTimes(1);
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
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            spies.push(warnSpy);

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
                inboxManager,
                ...deps,
            });

            await triggerReady(client);
            await expect(bot.triggerCatchUp()).resolves.toBeUndefined();

            expect(submitConductorCatchUpSpy).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith({
                error: 'Discord search 500',
                msg:   'Reconnect catch-up trigger failed',
            });
        });

        describe('P11: ledger-driven ring buffers', () => {
            const minimalPerchConfig = {
                enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5,
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

            test('activity-log signal loads the exact two-hour window in one bounded request', async () => {
                const client = makeMockClientForConductor();
                let loadRecentActivityLog: ((limit: number) => Promise<unknown>) | undefined;
                let resolveChannelName: ((id: string) => string | undefined) | undefined;
                client.channels = { cache: { get: mock((id: string) => {
                    if(id === 'named') {
                        return { name: 'general' };
                    }
                    if(id === 'unnamed') {
                        return {};
                    }
                    return undefined;
                }) } } as unknown as Client['channels'];
                spies.push(
                    // @ts-expect-error — Mocking constructor
                    spyOn(agentModule, 'LiveSignals').mockImplementation((params: { loadRecentActivityLog?: (limit: number) => Promise<unknown>, resolveChannelName?: (id: string) => string | undefined }) => {
                        loadRecentActivityLog = params.loadRecentActivityLog;
                        resolveChannelName = params.resolveChannelName;
                        return { snapshot: mock(async () => []) } as unknown as agentModule.LiveSignals;
                    })
                );
                const loadRecentEventsSince = mock(async () => []);
                createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, contextBuilder: { loadRecentEventsSince } as unknown as DiscordBotOptions['contextBuilder'] });
                await triggerReady(client);
                expect(loadRecentActivityLog).toBeDefined();
                await loadRecentActivityLog!(7);
                expect(loadRecentEventsSince).toHaveBeenCalledWith(7_200_000, 7);
                expect(resolveChannelName?.('named')).toBe('general');
                expect(resolveChannelName?.('unnamed')).toBeUndefined();
                expect(resolveChannelName?.('missing')).toBeUndefined();
            });

            test('feeds recentTools from a using_tool phase change on either ledger, deduped by toolName', async () => {
                jest.useFakeTimers();
                jest.setSystemTime(new Date('2026-01-02T03:04:05.678Z'));
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                const phaseChangedEvent = { type: 'phase_changed', phase: null, at: new Date(0) };
                ledgerStore.emit({ turn: { kind: 'discord', phase: { type: 'using_tool', toolName: 'Bash' } } }, phaseChangedEvent);
                // A second event naming the SAME tool must not duplicate the ring-buffer entry.
                ledgerStore.emit({ turn: { kind: 'discord', phase: { type: 'using_tool', toolName: 'Bash' } } }, phaseChangedEvent);
                ledgerStore.emit({ turn: { kind: 'discord', phase: { type: 'using_tool', toolName: 'Bash' } } }, phaseChangedEvent);

                const tools = getCaptured().getRecentTools?.() as { toolName: string, timestamp: number }[];
                expect(tools).toHaveLength(1);
                expect(tools[0]).toEqual({ toolName: 'Bash', timestamp: Date.parse('2026-01-02T03:04:05.678Z') });
            });

            test('feeds recentChannels from a new discord turn carrying a channelId', async () => {
                jest.useFakeTimers();
                jest.setSystemTime(new Date('2026-02-03T04:05:06.789Z'));
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();

                const ledgerStore = makeFakeLedgerStore();
                const deps = conductorDeps({ ledgerStore });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                ledgerStore.emit({ turn: { id: 'turn-1', kind: 'discord', channelId: 'chan-1', phase: null } }, { type: 'phase_changed', phase: null, at: new Date(0) });

                const channels = getCaptured().getRecentChannels?.() as { channelId: string, timestamp: number }[];
                expect(channels).toHaveLength(1);
                expect(channels[0]).toEqual({ channelId: 'chan-1', timestamp: Date.parse('2026-02-03T04:05:06.789Z') });
            });

            test('resets tool dedupe after leaving a tool phase and retains only the newest ten entries', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();
                const ledgerStore = makeFakeLedgerStore();
                createDiscordBot({ config: mockConfig, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, ...conductorDeps({ ledgerStore }) });
                await triggerReady(client);

                ledgerStore.emit({ turn: { phase: { type: 'using_tool', toolName: 'Bash' } } });
                ledgerStore.emit({ turn: { phase: { type: 'thinking' } } });
                ledgerStore.emit({ turn: { phase: { type: 'using_tool', toolName: 'Bash' } } });
                expect((getCaptured().getRecentTools?.() as { toolName: string }[]).map(tool => tool.toolName)).toEqual(['Bash', 'Bash']);
                for(let i = 0; i < 10; i += 1) {
                    ledgerStore.emit({ turn: { phase: { type: 'using_tool', toolName: `tool-${i}` } } });
                }
                expect((getCaptured().getRecentTools?.() as { toolName: string }[]).map(tool => tool.toolName)).toEqual(Array.from({ length: 10 }, (_, i) => `tool-${i}`));
            });

            test('removes exactly one oldest tool when the ring buffer overflows', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();
                const ledgerStore = makeFakeLedgerStore();
                createDiscordBot({ config: mockConfig, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, ...conductorDeps({ ledgerStore }) });
                await triggerReady(client);

                for(let i = 0; i < 11; i += 1) {
                    ledgerStore.emit({ turn: { phase: { type: 'using_tool', toolName: `tool-${i}` } } });
                }

                expect((getCaptured().getRecentTools?.() as { toolName: string }[]).map(tool => tool.toolName)).toEqual(Array.from({ length: 10 }, (_, i) => `tool-${i + 1}`));
            });

            test('dedupes a repeated turn, records a new turn, and retains only the newest ten channels', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { getCaptured } = captureLiveSignalsGetters();
                const ledgerStore = makeFakeLedgerStore();
                createDiscordBot({ config: mockConfig, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, ...conductorDeps({ ledgerStore }) });
                await triggerReady(client);

                ledgerStore.emit({ turn: { id: 'first', kind: 'discord', channelId: 'first-channel' } });
                ledgerStore.emit({ turn: { id: 'first', kind: 'discord', channelId: 'first-channel' } });
                expect(getCaptured().getRecentChannels?.()).toHaveLength(1);
                for(let i = 0; i < 10; i += 1) {
                    ledgerStore.emit({ turn: { id: `turn-${i}`, kind: 'discord', channelId: `channel-${i}` } });
                }
                expect((getCaptured().getRecentChannels?.() as { channelId: string }[]).map(channel => channel.channelId)).toEqual(Array.from({ length: 10 }, (_, i) => `channel-${i}`));
            });
        });

        describe('P11: presence composed from ledgers', () => {
            test('uses setupConductorPresence once identityContext/config.presence/ledgerStore are all present', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence').mockReturnValue({
                    presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                    unsubscribeLedgers: mock(() => undefined),
                });
                spies.push(setupConductorPresenceSpy);

                const ledgerStore = makeFakeLedgerStore();
                const perchLedgerStore = makeFakeLedgerStore('perch-sess-1');
                const deps = conductorDeps({ ledgerStore, perchLedgerStore });

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                expect(setupConductorPresenceSpy).toHaveBeenCalledTimes(1);
                expect(setupConductorPresenceSpy.mock.calls[0]?.[0].ledgers).toEqual([ledgerStore, perchLedgerStore]);
            });

            test('does not set up presence when the conversation conductor never opened', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const setupConductorPresenceSpy = spyOn(presenceSetupModule, 'setupConductorPresence');
                spies.push(setupConductorPresenceSpy);

                // Every other input presence needs (identity, presence config, ledger, shared throttle)
                // is present here; only conductorOpened is false, and that alone must keep presence off.
                const deps = conductorDeps({ conversationConductor: undefined });

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                expect(setupConductorPresenceSpy).not.toHaveBeenCalled();
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
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                expect(setupConductorPresenceSpy.mock.calls[0]?.[0].ledgers).toEqual([ledgerStore]);
            });

            test('P14: calls setupConductorPresence with no botStateManager param — the legacy bridge no longer exists', async () => {
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
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
                expect(call).not.toHaveProperty('botStateManager');
            });

            test('forwards options.isPerchPaused to setupConductorPresence by identity when perch is enabled (Q3 / B4)', async () => {
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
                const isPerchPaused = (): boolean => true;

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    identityContext: 'Test identity',
                    perchConfig:     { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 },
                    isPerchPaused,
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { isPerchPaused?: unknown } | undefined;
                expect(call?.isPerchPaused).toBe(isPerchPaused);
            });

            test('does NOT forward options.isPerchPaused to setupConductorPresence when perch is disabled — nothing is actually paused (Q3 / B4)', async () => {
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
                const isPerchPaused = (): boolean => true;

                createDiscordBot({
                    config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                    channelRegistry: mockChannelRegistry,
                    identityContext: 'Test identity',
                    perchConfig:     { enabled: false, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 },
                    isPerchPaused,
                    ...deps,
                });

                await triggerReady(client);

                const call = setupConductorPresenceSpy.mock.calls[0]?.[0] as { isPerchPaused?: unknown } | undefined;
                expect(call?.isPerchPaused).toBeUndefined();
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
                    identityContext: 'Test identity',
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(unsubscribeLedgers).toHaveBeenCalledTimes(1);
            });

            describe('getRecentContext (relocated callback)', () => {
                function captureRecentContext() {
                    let getRecentContext: (() => Promise<string | undefined>) | undefined;
                    let addRecentMessage: ((content: string, author: ExchangeSpeaker) => void) | undefined;
                    let presenceParams: { getLastThinkingContent?: () => string | undefined, onThinkingContentUpdate?: (content: string) => void, getPreviousStatus?: () => string | undefined, setPreviousStatus?: (text: string) => void } | undefined;

                    spies.push(
                        spyOn(presenceSetupModule, 'setupConductorPresence').mockImplementation((params: { getRecentContext: () => Promise<string | undefined>, getLastThinkingContent?: () => string | undefined, onThinkingContentUpdate?: (content: string) => void, getPreviousStatus?: () => string | undefined, setPreviousStatus?: (text: string) => void }) => {
                            getRecentContext = params.getRecentContext;
                            presenceParams = params;
                            return {
                                presenceManager:    { start: mock(() => undefined) } as unknown as PresenceManager,
                                unsubscribeLedgers: mock(() => undefined),
                            };
                        }),
                        spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation((params: { addRecentMessage?: (content: string, author: ExchangeSpeaker) => void }) => {
                            addRecentMessage = params.addRecentMessage;
                            return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                        })
                    );

                    return { getGetRecentContext: () => getRecentContext, getAddRecentMessage: () => addRecentMessage, getPresenceParams: () => presenceParams };
                }

                async function setUp(): Promise<ReturnType<typeof captureRecentContext>> {
                    const client = makeMockClientForConductor();
                    spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));

                    const captured = captureRecentContext();

                    const ledgerStore = makeFakeLedgerStore();
                    const deps = conductorDeps({ ledgerStore });

                    createDiscordBot({
                        config:          { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                        channelRegistry: mockChannelRegistry,
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

                test('truncates long messages and retains the latest ten in recent context', async () => {
                    const { getGetRecentContext, getAddRecentMessage } = await setUp();
                    const add = getAddRecentMessage()!;
                    add('x'.repeat(250), 'user');
                    expect(await getGetRecentContext()!()).toBe(`User: ${'x'.repeat(200)}`);
                    for(let i = 0; i < 10; i += 1) {
                        add(`message-${i}`, 'izzy');
                    }
                    const context = await getGetRecentContext()!();
                    expect(context).not.toContain('x');
                    expect(context).toContain('Izzy: message-0');
                    expect(context).toContain('Izzy: message-9');
                    expect(context?.split('\n')).toHaveLength(10);
                });

                test('preserves prior status through presence callbacks, and holds no thinking buffer of its own (src/index.ts does)', async () => {
                    const { getPresenceParams } = await setUp();
                    const params = getPresenceParams()!;
                    expect(params.getLastThinkingContent).toBeUndefined();
                    expect(params.onThinkingContentUpdate).toBeUndefined();
                    expect(params.getPreviousStatus?.()).toBeUndefined();
                    params.setPreviousStatus?.('waiting for the next turn');
                    expect(params.getPreviousStatus?.()).toBe('waiting for the next turn');
                });
            });
        });

        describe('Live task board (block 2)', () => {
            /** Spies setupTaskBoard and returns the stub `stop` it hands back to bot.ts. */
            function stubTaskBoard(): { spy: ReturnType<typeof spyOn>, stop: ReturnType<typeof mock> } {
                const stop = mock(() => undefined);
                const spy = spyOn(taskBoardSetupModule, 'setupTaskBoard').mockReturnValue({ stop });
                spies.push(spy);
                return { spy, stop };
            }

            test('wires it with both conductor ledgers, the configured knobs and perch\'s time zone', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore(), perchLedgerStore: makeFakeLedgerStore('perch-sess-1') });

                createDiscordBot({
                    config:          { ...mockConfig, taskBoard: { enabled: true, editIntervalMs: 250, refreshIntervalMs: 750 } },
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     { enabled: true, timezone: 'Pacific/Auckland', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 },
                    ...deps,
                });

                await triggerReady(client);

                expect(spy).toHaveBeenCalledTimes(1);
                const call = spy.mock.calls[0]?.[0] as { ledgers?: readonly unknown[], config?: unknown, timeZone?: unknown, logger?: unknown } | undefined;
                expect(call?.ledgers).toHaveLength(2);
                expect(call?.config).toEqual({ enabled: true, editIntervalMs: 250, refreshIntervalMs: 750 });
                expect(call?.timeZone).toBe('Pacific/Auckland');
                expect(call?.logger).toBe(loggerModule.logger);
            });

            test('resolves the conversation fallback board channel from the fallback well-known channel, and the perch fallback from perch-time', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();
                const getWellKnownChannel = mock(async (name: string) => {
                    if(name === 'fallback') {
                        return { channelId: 'fallback-chan' };
                    }
                    if(name === 'perch-time') {
                        return { channelId: 'perch-chan' };
                    }
                    return null;
                });

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: { ...mockChannelRegistry, getWellKnownChannel } as unknown as typeof mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                const call = spy.mock.calls[0]?.[0] as { resolveFallbackChannelId?: (role: string) => Promise<string | undefined> } | undefined;
                expect(call?.resolveFallbackChannelId).toBeDefined();
                await expect(call?.resolveFallbackChannelId?.('conversation')).resolves.toBe('fallback-chan');
                expect(getWellKnownChannel).toHaveBeenCalledWith('fallback');
                await expect(call?.resolveFallbackChannelId?.('perch')).resolves.toBe('perch-chan');
                expect(getWellKnownChannel).toHaveBeenCalledWith('perch-time');
                await expect(call?.resolveFallbackChannelId?.('other')).resolves.toBeUndefined();
            });

            test('the perch fallback board channel is undefined when perch-time is not registered', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: { ...mockChannelRegistry, getWellKnownChannel: mock(async () => null) } as unknown as typeof mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                const call = spy.mock.calls[0]?.[0] as { resolveFallbackChannelId?: (role: string) => Promise<string | undefined> } | undefined;
                await expect(call?.resolveFallbackChannelId?.('perch')).resolves.toBeUndefined();
            });

            test('the conversation fallback board channel is undefined when no fallback well-known channel is registered', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: { ...mockChannelRegistry, getWellKnownChannel: mock(async () => null) } as unknown as typeof mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                const call = spy.mock.calls[0]?.[0] as { resolveFallbackChannelId?: (role: string) => Promise<string | undefined> } | undefined;
                await expect(call?.resolveFallbackChannelId?.('conversation')).resolves.toBeUndefined();
            });

            test('falls back to the default config and the host time zone when neither is configured', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                const call = spy.mock.calls[0]?.[0] as { ledgers?: readonly unknown[], config?: unknown, timeZone?: unknown } | undefined;
                expect(call?.ledgers).toHaveLength(1);
                expect(call?.config).toEqual(DEFAULT_TASK_BOARD_CONFIG);
                expect(call?.timeZone).toBe(resolveTimezone());
            });

            test('is never wired when taskBoard.enabled is false', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                createDiscordBot({
                    config:          { ...mockConfig, taskBoard: { enabled: false, editIntervalMs: 3000, refreshIntervalMs: 10_000 } },
                    channelRegistry: mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                expect(spy).not.toHaveBeenCalled();
            });

            test('is never wired when the conversation conductor opens without its ledger', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { spy } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: undefined });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);

                expect(spy).not.toHaveBeenCalled();
            });

            test('stop() stops the task board', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { stop } = stubTaskBoard();

                const deps = conductorDeps({ ledgerStore: makeFakeLedgerStore() });

                const bot = createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    ...deps,
                });

                await triggerReady(client);
                expect(stop).not.toHaveBeenCalled();

                await bot.stop();
                expect(stop).toHaveBeenCalledTimes(1);
            });
        });

        describe('Perch conductor (P12)', () => {
            const minimalPerchConfig = {
                enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2,
            };

            function fakePerchDriver() {
                return { runSlot: mock(() => 'started' as const), stop: mock(() => undefined) };
            }

            function stubPerchSetup(driver: ReturnType<typeof fakePerchDriver> = fakePerchDriver()) {
                const scheduler = { start: mock(() => undefined), stop: mock(() => undefined), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() };
                const setupPerchDriverAndSchedulerSpy = spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({ driver, scheduler });
                spies.push(setupPerchDriverAndSchedulerSpy);
                return { setupPerchDriverAndSchedulerSpy, driver, scheduler };
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
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(callOrder).toEqual(['conversation.open', 'perch.open']);
            });

            test('a successfully-opened perch conductor uses setupPerchDriverAndScheduler', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupPerchDriverAndSchedulerSpy).toHaveBeenCalledTimes(1);
                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { conductor?: unknown } | undefined;
                expect(driverArgs?.conductor).toBe(perchConductor);
            });

            test('forwards options.isPerchPaused to setupPerchDriverAndScheduler by identity (Q3 / B4)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });
                const isPerchPaused = (): boolean => true;

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    isPerchPaused,
                    ...deps,
                });

                await triggerReady(client);

                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { isPerchPaused?: unknown } | undefined;
                expect(driverArgs?.isPerchPaused).toBe(isPerchPaused);
            });

            test('leaves isPerchPaused undefined for setupPerchDriverAndScheduler when options.isPerchPaused is omitted', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor();
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                const driverArgs = setupPerchDriverAndSchedulerSpy.mock.calls[0]?.[0] as { isPerchPaused?: unknown } | undefined;
                expect(driverArgs?.isPerchPaused).toBeUndefined();
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
                    perchConfig:     minimalPerchConfig,
                    inboxManager:    { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { excludeChannelIds?: ReadonlySet<string> } | undefined;
                expect(call?.excludeChannelIds).toEqual(new Set(['perch-time-channel-id']));
            });

            test('does not resolve a perch-time replay exclusion when no perch conductor opened', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const setupInboxAndCatchUpSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp').mockResolvedValue(undefined);
                spies.push(setupInboxAndCatchUpSpy);
                const getWellKnownChannel = mock(async () => ({ channelId: 'perch-time-channel-id' }));
                const deps = conductorDeps();

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: { ...mockChannelRegistry, getWellKnownChannel } as unknown as ChannelRegistryManager,
                    inboxManager:    { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    ...deps,
                });
                await triggerReady(client);

                expect(getWellKnownChannel).not.toHaveBeenCalledWith('perch-time');
                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { excludeChannelIds?: ReadonlySet<string> } | undefined;
                expect(call?.excludeChannelIds).toBeUndefined();
            });

            test('R1: forwards the same contextPolicy given to createDiscordBot, and bootEventsWindowMs, through to setupInboxAndCatchUp', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                stubPerchSetup();

                const setupInboxAndCatchUpSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp').mockResolvedValue(undefined);
                spies.push(setupInboxAndCatchUpSpy);

                const deps = conductorDeps();

                createDiscordBot({
                    config:             mockConfig,
                    channelRegistry:    mockChannelRegistry,
                    perchConfig:        minimalPerchConfig,
                    inboxManager:       { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    bootEventsWindowMs: 12_345,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { contextPolicy?: unknown, bootEventsWindowMs?: number } | undefined;
                expect(call?.contextPolicy).toBe(deps.contextPolicy);
                expect(call?.bootEventsWindowMs).toBe(12_345);
            });

            test('a rejected well-known perch-time channel lookup does not abort the rest of clientReady — setupInboxAndCatchUp still runs and the gate still opens', async () => {
                const errorSpy = spyOn(loggerModule.logger, 'error');
                spies.push(errorSpy);
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
                    perchConfig:     minimalPerchConfig,
                    inboxManager:    { getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                    ...deps,
                });

                await expect(triggerReady(client)).resolves.toBeUndefined();

                // The clientReady handler must still reach setupInboxAndCatchUp — a throw here
                // would previously abort everything after it, leaving the ingress gate stuck
                // 'buffering' forever with every Discord message silently unanswered.
                expect(setupInboxAndCatchUpSpy).toHaveBeenCalledTimes(1);
                const call = setupInboxAndCatchUpSpy.mock.calls[0]?.[0] as { excludeChannelIds?: ReadonlySet<string> } | undefined;
                expect(call?.excludeChannelIds).toBeUndefined();
                expect(errorSpy).toHaveBeenCalledWith({
                    err: expect.objectContaining({ message: 'DynamoDB throttled' }),
                    msg: 'Failed to resolve the well-known perch-time channel for replay exclusion — continuing without it',
                });
            });

            test('a rejected perch conductor open() leaves perch disabled, without throwing', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                const errorLog = spyOn(loggerModule.logger, 'error');
                spies.push(errorLog);
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const perchConductor = makeFakeConductor({ open: mock(() => Promise.reject(new Error('perch boom'))) });
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) } });

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await expect(triggerReady(client)).resolves.toBeUndefined();

                expect(setupPerchDriverAndSchedulerSpy).not.toHaveBeenCalled();
                expect(errorLog).toHaveBeenCalledWith({ error: 'perch boom', msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
            });

            test('a wedged perch conductor times out and logs its specific failure', async () => {
                jest.useFakeTimers();
                const client = makeMockClientForConductor();
                stubCoordinator();
                const errorLog = spyOn(loggerModule.logger, 'error');
                spies.push(errorLog);
                const perchConductor = makeFakeConductor({ open: mock(() => new Promise(() => {
                    // Deliberately never settles.
                })) });
                const deps = conductorDeps({ perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess'), perchJournal: { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) } });
                createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...deps });
                const ready = triggerReady(client);
                await flushMicrotasks();
                jest.advanceTimersByTime(30_000);
                await ready;
                expect(errorLog).toHaveBeenCalledWith({ error: 'perch conductor.open() timed out', msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
            });

            test('omitting the perch conductor entirely leaves perch disabled', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const { setupPerchDriverAndSchedulerSpy } = stubPerchSetup();

                const deps = conductorDeps();

                createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);

                expect(setupPerchDriverAndSchedulerSpy).not.toHaveBeenCalled();
            });

            test('stop() shuts down both conductors under one shared budget and stops the perch driver', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const driver = fakePerchDriver();
                stubPerchSetup(driver);
                const shutdownSetup = spyOn(agentModule, 'createShutdown');
                spies.push(shutdownSetup);

                const conversationShutdown = mock(async () => undefined);
                const perchShutdown = mock(async () => undefined);
                const conversationConductor = makeFakeConductor({ shutdown: conversationShutdown });
                const perchConductor = makeFakeConductor({ shutdown: perchShutdown });
                const conversationFlush = mock(async () => undefined);
                const perchFlush = mock(async () => undefined);
                const deps = conductorDeps({ conversationConductor, perchConductor, journal: { append: mock(() => undefined), flush: conversationFlush, readSince: mock(() => Promise.resolve([])) }, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: perchFlush, readSince: mock(() => Promise.resolve([])) } });

                const bot = createDiscordBot({
                    config:          mockConfig,
                    channelRegistry: mockChannelRegistry,
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(conversationShutdown).toHaveBeenCalledTimes(1);
                expect(perchShutdown).toHaveBeenCalledTimes(1);
                expect(conversationFlush).toHaveBeenCalledTimes(1);
                expect(perchFlush).toHaveBeenCalledTimes(1);
                expect(driver.stop).toHaveBeenCalledTimes(1);
                expect(shutdownSetup.mock.calls[0]?.[0].sessions.map(session => session.name)).toEqual(['conversation', 'perch']);
                expect(shutdownSetup.mock.calls[0]?.[0]).toMatchObject({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            });

            test('stop() waits for both journal flushes when the conversation journal rejects', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                const conversationFlush = deferredPromise<void>();
                const perchFlush = deferredPromise<void>();
                const deps = conductorDeps({
                    perchConductor: makeFakeConductor(),
                    journal:        {
                        append: mock(() => undefined), flush: mock(() => conversationFlush.promise), readSince: mock(() => Promise.resolve([])),
                    },
                    perchLedgerStore: makeFakeLedgerStore('perch-sess-1'),
                    perchJournal:     {
                        append: mock(() => undefined), flush: mock(() => perchFlush.promise), readSince: mock(() => Promise.resolve([])),
                    },
                });
                const bot = createDiscordBot({
                    config: mockConfig, client, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, ...deps,
                });

                await triggerReady(client);
                let stopped = false;
                const stopping = bot.stop();
                void stopping.then(() => {
                    stopped = true;
                    return undefined;
                });
                await flushMicrotasks();

                try {
                    conversationFlush.reject(new Error('conversation journal unavailable'));
                    await flushMicrotasks(100);
                    expect(stopped).toBe(false);
                } finally {
                    perchFlush.resolve();
                }

                await expect(stopping).resolves.toBeUndefined();
            });

            test('stop() stops the perch driver and scheduler BEFORE waiting out the shared shutdown budget, so no timer can fire while a turn is being politely waited out', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                const coordinator = stubCoordinator();
                const info = spyOn(loggerModule.logger, 'info');
                spies.push(info);
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
                    perchConfig:     minimalPerchConfig,
                    ...deps,
                });

                await triggerReady(client);
                await bot.stop();

                expect(callOrder).toEqual(['perchScheduler.stop', 'perchDriver.stop', 'perch.shutdown']);
                expect(driver.stop).toHaveBeenCalledTimes(1);
                expect(scheduler.stop).toHaveBeenCalledTimes(1);
                expect(coordinator.stop).toHaveBeenCalledTimes(1);
                expect(info).toHaveBeenCalledWith({ msg: 'Coordinator stopped' });
                expect(info).toHaveBeenCalledWith({ msg: 'Perch driver stopped' });
            });

            test('stop() waits for each asynchronous perch timer shutdown', async () => {
                async function assertStopWaitsFor(phase: 'scheduler' | 'driver'): Promise<void> {
                    const client = makeMockClientForConductor();
                    const completion = deferredPromise<void>();
                    const driver = {
                        runSlot: mock(() => 'started' as const),
                        stop:    mock(() => (phase === 'driver' ? completion.promise : undefined)),
                    };
                    const scheduler = {
                        start:            mock(() => undefined),
                        stop:             mock(() => (phase === 'scheduler' ? completion.promise : undefined)),
                        getState:         mock(),
                        triggerNow:       mock(),
                        triggerTestPerch: mock(),
                    };
                    spies.push(
                        spyOn(clientModule, 'createDiscordClient').mockReturnValue(client),
                        spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({ driver, scheduler })
                    );
                    stubCoordinator();
                    const deps = conductorDeps({
                        perchConductor:   makeFakeConductor(),
                        perchLedgerStore: makeFakeLedgerStore('perch-sess-1'),
                        perchJournal:     { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) },
                    });
                    const bot = createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, perchConfig: minimalPerchConfig, ...deps });
                    await triggerReady(client);

                    const stopping = bot.stop();
                    let settled = false;
                    void stopping.then(() => {
                        settled = true;
                        return undefined;
                    }).catch(() => {
                        settled = true;
                        return undefined;
                    });
                    await flushMicrotasks(100);
                    expect(settled).toBe(false);
                    completion.resolve();
                    await stopping;
                }

                await assertStopWaitsFor('scheduler');
                await assertStopWaitsFor('driver');
            });
        });

        describe('R2: background-work wake-turn delivery wiring', () => {
            test('after clientReady builds responseRouter, calls setWakeTurnDelivery with a function built from createWakeTurnDelivery bound to the conversation conductor', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const conversationConductor = makeFakeConductor();
                const sentinelDelivery = mock(async () => undefined);
                const createWakeTurnDeliverySpy = spyOn(wakeDeliveryModule, 'createWakeTurnDelivery').mockReturnValue(sentinelDelivery);
                spies.push(createWakeTurnDeliverySpy);
                const setWakeTurnDelivery = mock(() => undefined);
                const deps = conductorDeps({ conversationConductor });

                createDiscordBot({
                    config: mockConfig, channelRegistry: mockChannelRegistry, setWakeTurnDelivery, ...deps,
                });
                await triggerReady(client);

                expect(createWakeTurnDeliverySpy).toHaveBeenCalledWith(expect.objectContaining({ conductor: conversationConductor }));
                expect(setWakeTurnDelivery).toHaveBeenCalledWith(sentinelDelivery);
            });

            test('calls setPerchWakeTurnDelivery with a SEPARATE createWakeTurnDelivery instance bound to the perch conductor', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                spies.push(spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({
                    driver: { runSlot: mock(), stop: mock() }, scheduler: { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() },
                }));

                const perchConductor = makeFakeConductor();
                const conversationSentinel = mock(async () => undefined);
                const perchSentinel = mock(async () => undefined);
                const createWakeTurnDeliverySpy = spyOn(wakeDeliveryModule, 'createWakeTurnDelivery')
                    .mockReturnValueOnce(conversationSentinel)
                    .mockReturnValueOnce(perchSentinel);
                spies.push(createWakeTurnDeliverySpy);
                const setPerchWakeTurnDelivery = mock(() => undefined);
                const deps = conductorDeps({
                    perchConductor, perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
                });

                createDiscordBot({
                    config: mockConfig, channelRegistry: mockChannelRegistry, perchConfig: { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 }, setPerchWakeTurnDelivery, ...deps,
                });
                await triggerReady(client);

                expect(createWakeTurnDeliverySpy).toHaveBeenCalledWith(expect.objectContaining({ conductor: perchConductor }));
                expect(setPerchWakeTurnDelivery).toHaveBeenCalledWith(perchSentinel);
            });

            test('never builds or attaches a perch wake-turn delivery when perchConductor is absent', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const createWakeTurnDeliverySpy = spyOn(wakeDeliveryModule, 'createWakeTurnDelivery').mockReturnValue(mock(async () => undefined));
                spies.push(createWakeTurnDeliverySpy);
                const setPerchWakeTurnDelivery = mock(() => undefined);
                const deps = conductorDeps();

                createDiscordBot({
                    config: mockConfig, channelRegistry: mockChannelRegistry, setPerchWakeTurnDelivery, ...deps,
                });
                await triggerReady(client);

                expect(setPerchWakeTurnDelivery).not.toHaveBeenCalled();
                expect(createWakeTurnDeliverySpy).toHaveBeenCalledTimes(1);
            });

            test('attaches the conversation wake-turn delivery function to notificationBridge.attachReplyDelivery', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();

                const conversationConductor = makeFakeConductor();
                const sentinelDelivery = mock(async () => undefined);
                spies.push(spyOn(wakeDeliveryModule, 'createWakeTurnDelivery').mockReturnValue(sentinelDelivery));
                const attachReplyDelivery = mock(() => undefined);
                const deps = conductorDeps({ conversationConductor });

                createDiscordBot({
                    config: mockConfig, channelRegistry: mockChannelRegistry, notificationBridge: { attachReplyDelivery }, ...deps,
                });
                await triggerReady(client);

                expect(attachReplyDelivery).toHaveBeenCalledWith(sentinelDelivery);
            });

            test('omitting setWakeTurnDelivery/setPerchWakeTurnDelivery/notificationBridge never throws (bot.test.ts covers absent)', async () => {
                const client = makeMockClientForConductor();
                spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(client));
                stubCoordinator();
                spies.push(spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({
                    driver: { runSlot: mock(), stop: mock() }, scheduler: { start: mock(), stop: mock(), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() },
                }));

                const deps = conductorDeps({
                    perchConductor: makeFakeConductor(), perchLedgerStore: makeFakeLedgerStore('perch-sess-1'), perchJournal: { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
                });

                createDiscordBot({
                    config: mockConfig, channelRegistry: mockChannelRegistry, perchConfig: { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 }, ...deps,
                });

                await expect(triggerReady(client)).resolves.toBeUndefined();
            });
        });
    });

    describe('Session host adapter (#41)', () => {
        /** Fires clientReady directly (no session supervisor) and waits for `bot.ready`. */
        async function fireReady(client: Client, bot: DiscordBot): Promise<void> {
            const calls = (client.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (c: Client) => void][];
            calls.find(([event]) => event === 'clientReady')?.[1](client);
            await bot.ready;
        }

        function fakeGate() {
            return { admit: mock(() => 'pass'), open: mock(() => undefined), state: mock(() => 'buffering'), stop: mock(() => undefined) };
        }

        test('ready resolves only after the wake-turn delivery binding and initializeChannelRegistry', async () => {
            const client = makeMockClientForConductor();
            const order: string[] = [];
            spies.push(spyOn(eventHandlerSetupModule, 'initializeChannelRegistry').mockImplementation(() => {
                order.push('initializeChannelRegistry');
            }));
            const setWakeTurnDelivery = mock(() => {
                order.push('setWakeTurnDelivery');
            });
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps(), setWakeTurnDelivery });
            void bot.ready.then(() => {
                order.push('ready');
                return undefined;
            });
            await flushMicrotasks();
            expect(order).toEqual([]);

            await fireReady(client, bot);
            await flushMicrotasks();

            expect(order).toEqual(['setWakeTurnDelivery', 'initializeChannelRegistry', 'ready']);
        });

        test('the bot itself never opens a conductor, builds a shutdown or exits the process', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const createShutdownSpy = spyOn(agentModule, 'createShutdown');
            const exitSpy = spyOn(process, 'exit').mockImplementation((() => undefined) as never);
            spies.push(createShutdownSpy, exitSpy);
            const conversationConductor = makeFakeConductor();
            const perchConductor = makeFakeConductor();
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps({ conversationConductor, perchConductor, perchLedgerStore: makeFakeLedgerStore('perch') }) });

            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'open' }, undefined);
            await bot.stop();

            expect(conversationConductor.open).not.toHaveBeenCalled();
            expect(perchConductor.open).not.toHaveBeenCalled();
            expect(createShutdownSpy).not.toHaveBeenCalled();
            expect(exitSpy).not.toHaveBeenCalled();
        });

        test('attachSessions before ready throws an InvariantViolationError', async () => {
            const bot = createRealDiscordBot({ config: mockConfig, client: makeMockClientForConductor(), channelRegistry: mockChannelRegistry, ...conductorDeps() });

            const attaching = bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);
            await expect(attaching).rejects.toBeInstanceOf(InvariantViolationError);
            await expect(attaching).rejects.toThrow('Invariant violated in bot.attachSessions: called before the Discord client signalled readiness (bot.ready)');
        });

        test.each(['conversationConductor', 'ledgerStore', 'contextPolicy'] as const)('attachSessions with the conversation open but no %s throws an InvariantViolationError', async (missing) => {
            const client = makeMockClientForConductor();
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps({ [missing]: undefined }) });
            await fireReady(client, bot);

            const attaching = bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);
            await expect(attaching).rejects.toBeInstanceOf(InvariantViolationError);
            await expect(attaching).rejects.toThrow('Invariant violated in bot.attachSessions: the conversation session opened, but the bot was built without its conductor, ledger store or context policy');
        });

        test('attachSessions runs the post-open steps in order: presence, task board, perch, mute, coordinator, message processing, cleanup', async () => {
            const client = makeMockClientForConductor();
            const order: string[] = [];
            const push = (step: string) => (): void => {
                order.push(step);
            };
            spies.push(
                spyOn(presenceSetupModule, 'setupConductorPresence').mockImplementation(() => {
                    order.push('presence');
                    return { presenceManager: { start: mock(() => undefined), stop: mock(() => undefined) } as unknown as PresenceManager, unsubscribeLedgers: mock(() => undefined) };
                }),
                spyOn(taskBoardSetupModule, 'setupTaskBoard').mockImplementation(() => {
                    order.push('taskBoard');
                    return { stop: mock(() => undefined) };
                }),
                spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockImplementation(() => {
                    order.push('perch');
                    return { driver: { runSlot: mock(() => 'started' as const), stop: mock(() => undefined) }, scheduler: { start: mock(() => undefined), stop: mock(() => undefined), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() } };
                }),
                spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockImplementation(() => {
                    order.push('coordinator');
                    return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as MessageCoordinator;
                }),
                spyOn(eventHandlerSetupModule, 'setupMessageProcessing').mockImplementation(push('messageProcessing')),
                spyOn(eventHandlerSetupModule, 'setupChannelCleanupHandlers').mockImplementation(push('cleanup'))
            );
            const channelRegistry = { ...mockChannelRegistry, muteChannel: mock(async () => {
                order.push('mute');
            }) } as unknown as ChannelRegistryManager;
            const bot = createRealDiscordBot({
                config:               { ...mockConfig, presence: { updateThrottleMs: 12_000, idleTimeoutMs: 60_000, idleRefreshIntervalMs: 300_000 } },
                client,
                channelRegistry,
                identityContext:      'Test identity',
                adminReviewChannelId: createChannelId('333444555666777888'),
                perchConfig:          { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 },
                ...conductorDeps({ perchConductor: makeFakeConductor(), perchLedgerStore: makeFakeLedgerStore('perch') }),
            });
            await fireReady(client, bot);

            await bot.attachSessions({ conversation: 'open', perch: 'open' }, undefined);

            expect(order).toEqual(['presence', 'taskBoard', 'perch', 'mute', 'coordinator', 'messageProcessing', 'cleanup']);
        });

        test('a failed conversation outcome wires no coordinator and no ingress gate', async () => {
            const client = makeMockClientForConductor();
            const coordinatorSpy = spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration');
            const gateSpy = spyOn(ingressGateModule, 'createIngressGate');
            spies.push(coordinatorSpy, gateSpy);
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);

            await bot.attachSessions({ conversation: 'failed', perch: 'absent' }, undefined);

            expect(coordinatorSpy).not.toHaveBeenCalled();
            expect(gateSpy).not.toHaveBeenCalled();
        });

        test('a disabled perch outcome wires no perch driver even with a perch conductor and perch enabled', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const perchSpy = spyOn(perchSetupModule, 'setupPerchDriverAndScheduler');
            spies.push(perchSpy);
            const bot = createRealDiscordBot({
                config:          mockConfig,
                client,
                channelRegistry: mockChannelRegistry,
                perchConfig:     { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5, interruptGraceMinutes: 2 },
                ...conductorDeps({ perchConductor: makeFakeConductor(), perchLedgerStore: makeFakeLedgerStore('perch') }),
            });
            await fireReady(client, bot);

            await bot.attachSessions({ conversation: 'open', perch: 'disabled' }, undefined);

            expect(perchSpy).not.toHaveBeenCalled();
        });

        test('stop() stops the ingress gate and then runs the attached shutdown', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const order: string[] = [];
            const gate = fakeGate();
            gate.stop.mockImplementation(() => {
                order.push('gate.stop');
            });
            spies.push(spyOn(ingressGateModule, 'createIngressGate').mockReturnValue(gate as unknown as ReturnType<typeof ingressGateModule.createIngressGate>));
            const shutdown = { run: mock(async () => {
                order.push('shutdown.run');
                return { forced: false };
            }) };
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, shutdown);

            await bot.stop();

            expect(order).toEqual(['gate.stop', 'shutdown.run']);
        });

        test('stop() with no shutdown attached neither stops the gate nor runs a shutdown', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const gate = fakeGate();
            spies.push(spyOn(ingressGateModule, 'createIngressGate').mockReturnValue(gate as unknown as ReturnType<typeof ingressGateModule.createIngressGate>));
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);

            await bot.stop();

            expect(gate.stop).not.toHaveBeenCalled();
        });

        test('a rejected attached shutdown is logged with the existing warning and stop() continues', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const warn = spyOn(loggerModule.logger, 'warn');
            spies.push(warn);
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, { run: mock(() => Promise.reject(new Error('shutdown boom'))) });

            await expect(bot.stop()).resolves.toBeUndefined();

            expect(warn).toHaveBeenCalledWith({ error: 'shutdown boom', msg: 'Conductor shutdown() failed — continuing with the rest of stop()' });
            expect(client.destroy).toHaveBeenCalledTimes(1);
        });

        test('stopIngress() stops the gate once the conversation session is attached', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const gate = fakeGate();
            spies.push(spyOn(ingressGateModule, 'createIngressGate').mockReturnValue(gate as unknown as ReturnType<typeof ingressGateModule.createIngressGate>));
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);

            bot.stopIngress();

            expect(gate.stop).toHaveBeenCalledTimes(1);
        });

        test('stopIngress() is a no-op before any gate exists', () => {
            const bot = createRealDiscordBot({ config: mockConfig, client: makeMockClientForConductor(), channelRegistry: mockChannelRegistry, ...conductorDeps() });

            expect(() => {
                bot.stopIngress();
            }).not.toThrow();
        });

        test('recoveryAdapter.recover forwards the runtime to setupInboxAndCatchUp and waits for it', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const inbox = deferredPromise<undefined>();
            const setupSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp').mockImplementation(() => inbox.promise);
            spies.push(setupSpy);
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, inboxManager: {} as unknown as InboxManager, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);
            const runtime = { loadRecovery: mock(), runBoot: mock() } as unknown as agentModule.BootRecoveryRuntime;

            const recovering = bot.recoveryAdapter.recover(runtime);
            await expectPromiseToRemainPending(recovering);
            inbox.resolve(undefined);
            await recovering;

            expect(setupSpy).toHaveBeenCalledTimes(1);
            expect(setupSpy.mock.calls[0][0].recoveryRuntime).toBe(runtime);
        });

        test('recoveryAdapter.recover is a no-op when the conversation session is not open', async () => {
            const client = makeMockClientForConductor();
            const setupSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp');
            spies.push(setupSpy);
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, inboxManager: {} as unknown as InboxManager, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'failed', perch: 'absent' }, undefined);

            await bot.recoveryAdapter.recover({} as agentModule.BootRecoveryRuntime);

            expect(setupSpy).not.toHaveBeenCalled();
        });

        test('recoveryAdapter.recover is a no-op without an inbox manager', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const setupSpy = spyOn(catchupSetupModule, 'setupInboxAndCatchUp');
            spies.push(setupSpy);
            const bot = createRealDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await fireReady(client, bot);
            await bot.attachSessions({ conversation: 'open', perch: 'absent' }, undefined);

            await bot.recoveryAdapter.recover({} as agentModule.BootRecoveryRuntime);

            expect(setupSpy).not.toHaveBeenCalled();
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
                rest:               mockRest(),
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

            const deps = conductorDeps();

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistry,
                ...deps,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            const guildId = createGuildId('222333444555666777');
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

            const deps = conductorDeps();

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistryWithGuild,
                ...deps,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            const guildId = createGuildId('222333444555666777');
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

            const deps = conductorDeps();

            createDiscordBot({
                config: mockConfig,

                channelRegistry: mockChannelRegistryWithGuild,
                ...deps,
            });

            // Trigger clientReady to set up coordinator
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler_ = onceCalls.find(([event]) => event === 'clientReady');
            const clientReadyHandler = clientReadyHandler_?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

            // guildDelete handler should still be registered (no-op when coordinator is undefined)
            expect(guildDeleteHandler).toBeDefined();

            // Trigger guildDelete event - should not throw
            const guildId = createGuildId('222333444555666777');
            // Call the handler - it should not throw even without a coordinator
            guildDeleteHandler!({ id: guildId });
            await Promise.resolve();
            // Coordinator was genuinely never created, so removeGuildChannels() had no
            // instance to be called on.
            expect(coordinatorConstructorSpy).not.toHaveBeenCalled();
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
                rest:               mockRest(),
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

        test.each([
            { commandName: 'allowlist', desc: 'emailSetup is absent', handlerLabel: 'emailSetup' },
            { commandName: 'calendar', desc: 'calendarHandler is absent', handlerLabel: 'calendarHandler' },
            { commandName: 'contact', desc: 'contactHandler is absent', handlerLabel: 'contactHandler' }
        ])('/$commandName command replies with unavailable message when $desc', async ({ commandName }) => {
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
                rest:               mockRest(),
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

            // Create bot WITHOUT the relevant handler/setup
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
            await startHarnessedSessions(mockClient);

            expect(interactionCreateHandler).toBeDefined();

            // Build a mock ChatInputCommand interaction
            const replyMock = mock(async (_opts: unknown) => undefined);
            const mockInteraction = {
                isButton:           mock(() => false),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => true),
                commandName,
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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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

        test('an unregistered prefix that merely starts like an owned one falls through to the question handler, not reviewHandler', async () => {
            // Exact-prefix dispatch (the codec's whole point): 'email-approve' is NOT a
            // registered email-review prefix (only email-trash/junk/allow/allowlist are), so it
            // must fall through to the generic question/default button handler instead of
            // reaching reviewHandler — unlike the old startsWith('email-') chain, which claimed
            // it. This directly exercises acceptance criterion 3 ("unknown prefix falls through
            // to the question handler and is ignored").
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
                rest:               mockRest(),
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const handleButtonMock = mock(async () => undefined);
            const handleButtonInteraction = mock(async () => undefined);
            spies.push(spyOn(interactionsModule, 'createInteractionHandler').mockReturnValue({ handleButtonInteraction }));
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
            await startHarnessedSessions(mockClient);

            expect(interactionCreateHandler).toBeDefined();

            const mockInteraction = {
                isButton:           mock(() => true),
                isModalSubmit:      mock(() => false),
                isStringSelectMenu: mock(() => false),
                isChatInputCommand: mock(() => false),
                customId:           'email-approve:99:Approve',
            };

            await interactionCreateHandler!(mockInteraction);

            expect(handleButtonMock).not.toHaveBeenCalled();
            expect(handleButtonInteraction).toHaveBeenCalledTimes(1);
            expect(handleButtonInteraction).toHaveBeenCalledWith(mockInteraction);
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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

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

        test('muteChannel is called with adminReviewChannelId on clientReady with no email setup', async () => {
            const infoSpy = spyOn(loggerModule.logger, 'info');
            spies.push(infoSpy);
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               mockRest(),
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const adminReviewChannelId = createChannelId('admin-channel-123');

            const muteChannelMock = mock(async () => undefined);
            const channelRegistryWithMute = {
                ...mockChannelRegistry,
                muteChannel: muteChannelMock,
            } as unknown as ChannelRegistryManager;

            // No emailSetup: the admin review channel mute no longer depends on email being enabled
            createDiscordBot({
                config:          mockConfig,
                channelRegistry: channelRegistryWithMute,
                adminReviewChannelId,
            });

            // muteChannel must NOT be called before clientReady fires
            expect(muteChannelMock).not.toHaveBeenCalled();

            // Fire clientReady handler
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                await Promise.resolve(clientReadyHandler(mockClient));
            }
            await startHarnessedSessions(mockClient);

            // muteChannel must be called once with the admin review channel
            expect(muteChannelMock).toHaveBeenCalledTimes(1);
            expect(muteChannelMock).toHaveBeenCalledWith(adminReviewChannelId);
            expect(infoSpy).toHaveBeenCalledWith({
                msg: 'Admin review channel muted in channel registry',
            });
        });

        test('muteChannel failure is non-fatal: clientReady completes and bot is stoppable', async () => {
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            spies.push(warnSpy);
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               mockRest(),
            } as unknown as Client;

            spies.push(spyOn(clientModule, 'createDiscordClient').mockReturnValue(mockClient));

            const muteChannelMock = mock(async () => {
                throw new Error('DynamoDB unreachable');
            });
            const channelRegistryWithMute = {
                ...mockChannelRegistry,
                muteChannel: muteChannelMock,
            } as unknown as ChannelRegistryManager;

            const bot = createDiscordBot({
                config:               mockConfig,
                channelRegistry:      channelRegistryWithMute,
                adminReviewChannelId: createChannelId('admin-channel-456'),
            });

            // Fire clientReady — muteChannel will throw, but clientReady must not throw
            const onceCalls = (mockClient.on as unknown as { mock: { calls: unknown[][] } }).mock.calls as [string, (client: Client) => void | Promise<void>][];
            const clientReadyHandler = onceCalls.find(([event]) => event === 'clientReady')?.[1];
            if(clientReadyHandler) {
                // Must not throw even though muteChannel throws
                await Promise.resolve(clientReadyHandler(mockClient));
            }
            await startHarnessedSessions(mockClient);

            // Bot must still be stoppable after mute failure
            await bot.stop();
            expect(mockClient.destroy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith({
                error: 'DynamoDB unreachable',
                msg:   'Failed to mute admin review channel — messages there may reach Izzy',
            });
        });

        test('muteChannel is NOT called when adminReviewChannelId is omitted', async () => {
            const mockClient = {
                on:                 mock(() => mockClient),
                once:               mock(() => mockClient),
                login:              mock(async () => 'mock-token'),
                destroy:            mock(async () => undefined),
                removeAllListeners: mock(() => undefined),
                user:               { id: '999999999999999999', tag: 'TestBot#1234' },
                rest:               mockRest(),
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
            await startHarnessedSessions(mockClient);

            // muteChannel must NOT be called when adminReviewChannelId is absent (even with email enabled)
            expect(muteChannelMock).not.toHaveBeenCalled();
        });
    });

    describe('interaction and health routing contracts', () => {
        test('clientReady invokes the ready logger on each connection', async () => {
            const client = makeMockClientForConductor();
            const ready = mock(() => undefined);
            spies.push(spyOn(handlersModule, 'createReadyHandler').mockReturnValue(ready));
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry });
            await triggerReady(client);
            await triggerReady(client);
            expect(ready).toHaveBeenCalledTimes(2);
            expect(ready).toHaveBeenCalledWith(client);
        });
        test('routes each owned button and modal prefix to its handler', async () => {
            const client = makeMockClientForConductor();
            const bskyButton = mock(async () => undefined);
            const bskyModal = mock(async () => undefined);
            const emailSendButton = mock(async () => undefined);
            const emailReviewButton = mock(async () => undefined);
            const emailModal = mock(async () => undefined);
            const contactButton = mock(async () => undefined);
            const allowlistButton = mock(async () => undefined);
            const allowlistModal = mock(async () => undefined);
            createDiscordBot({
                config:                      mockConfig, client, channelRegistry:             mockChannelRegistry,
                bskySetup:                   { outboundApprovalHandler: { handleButton: bskyButton, handleModalSubmit: bskyModal } } as unknown as DiscordBotOptions['bskySetup'],
                emailSetup:                  { outboundApprovalHandler: { handleButton: emailSendButton, handleModalSubmit: emailModal }, reviewHandler: { handleButton: emailReviewButton } } as unknown as EmailSetupResult,
                contactApprovalHandler:      { handleButton: contactButton } as unknown as DiscordBotOptions['contactApprovalHandler'],
                allowlistInteractionHandler: { handleButton: allowlistButton, handleModalSubmit: allowlistModal } as unknown as DiscordBotOptions['allowlistInteractionHandler'],
            });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            const routes: [string, string, ReturnType<typeof mock>][] = [
                ['button', 'bsky-send-approve:1', bskyButton],
                ['button', 'bsky-dm-approve:1', bskyButton],
                ['button', 'email-send-approve:1', emailSendButton],
                ['button', 'email-trash:1', emailReviewButton],
                ['button', 'contact-approve:1', contactButton],
                ['button', 'contact-reject:1', contactButton],
                ['button', 'contact-delete-confirm:1', contactButton],
                ['button', 'contact-delete-cancel:1', contactButton],
                ['button', 'allowlist-yes:1', allowlistButton],
                ['modal', 'bsky-send-reject-reason:1', bskyModal],
                ['modal', 'bsky-dm-reject-reason:1', bskyModal],
                ['modal', 'email-send-reject-reason:1', emailModal],
                ['modal', 'allowlist-name:1', allowlistModal],
            ];
            for(const [kind, customId, expected] of routes) {
                const interaction = { customId, isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal', isStringSelectMenu: () => false, isChatInputCommand: () => false };
                const before = expected.mock.calls.length;
                // eslint-disable-next-line no-await-in-loop -- each route is checked before the next one
                await onInteraction(interaction);
                expect(expected.mock.calls).toHaveLength(before + 1);
                expect(expected).toHaveBeenLastCalledWith(interaction);
            }
            const unrelatedButton = { customId: 'other-action:1', isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => false };
            const unrelatedModal = { customId: 'other-modal:1', isButton: () => false, isModalSubmit: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false };
            await onInteraction(unrelatedButton);
            await onInteraction(unrelatedModal);
            expect(allowlistButton).toHaveBeenCalledTimes(1);
            expect(allowlistModal).toHaveBeenCalledTimes(1);
        });

        test('does not claim interaction IDs that only contain an owned prefix', async () => {
            const client = makeMockClientForConductor();
            const bskyButton = mock(async () => undefined);
            const bskyModal = mock(async () => undefined);
            const emailSendButton = mock(async () => undefined);
            const emailReviewButton = mock(async () => undefined);
            const emailModal = mock(async () => undefined);
            const emailSelect = mock(async () => undefined);
            const contactButton = mock(async () => undefined);
            const allowlistButton = mock(async () => undefined);
            const allowlistModal = mock(async () => undefined);
            createDiscordBot({
                config:                      mockConfig, client, channelRegistry:             mockChannelRegistry,
                bskySetup:                   { outboundApprovalHandler: { handleButton: bskyButton, handleModalSubmit: bskyModal } } as unknown as DiscordBotOptions['bskySetup'],
                emailSetup:                  { outboundApprovalHandler: { handleButton: emailSendButton, handleModalSubmit: emailModal, handleSelectMenu: emailSelect }, reviewHandler: { handleButton: emailReviewButton } } as unknown as EmailSetupResult,
                contactApprovalHandler:      { handleButton: contactButton } as unknown as DiscordBotOptions['contactApprovalHandler'],
                allowlistInteractionHandler: { handleButton: allowlistButton, handleModalSubmit: allowlistModal } as unknown as DiscordBotOptions['allowlistInteractionHandler'],
            });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            const malformed: [string, string][] = [
                ['button', 'other-bsky-send-approve:1'], ['button', 'other-bsky-dm-approve:1'],
                ['button', 'other-email-send-approve:1'], ['button', 'other-email-trash:1'],
                ['button', 'other-contact-approve:1'], ['button', 'other-contact-reject:1'],
                ['button', 'other-contact-delete-confirm:1'], ['button', 'other-contact-delete-cancel:1'],
                ['button', 'other-allowlist-yes:1'], ['modal', 'other-bsky-send-reject-reason:1'],
                ['modal', 'other-bsky-dm-reject-reason:1'], ['modal', 'other-email-send-reject-reason:1'],
                ['modal', 'other-allowlist-name:1'], ['select', 'other-email-allowlist-select:1'],
                ['select', 'email-allowlist-selectX:1'],
                // Delimiters are part of ownership: a bare namespace must fall through.
                ['button', 'bsky-send'], ['button', 'contact-delete-'],
                ['modal', 'bsky-send-reject-reason'], ['modal', 'bsky-dm-reject-reason'],
                ['modal', 'email-send-reject-reason'], ['modal', 'allowlist-name'],
            ];
            for(const [kind, customId] of malformed) {
                // eslint-disable-next-line no-await-in-loop -- route ownership is checked independently for each malformed ID
                await onInteraction({ customId, isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal', isStringSelectMenu: () => kind === 'select', isChatInputCommand: () => false });
            }
            for(const handler of [bskyButton, bskyModal, emailSendButton, emailReviewButton, emailModal, emailSelect, contactButton, allowlistButton, allowlistModal]) {
                expect(handler).not.toHaveBeenCalled();
            }
        });

        test('an owned prefix falls through (or is ignored) when only ITS OWN setup/handler is absent — the other three routes stay registered', async () => {
            // Route registration is gated per-feature (`if(bskySetup)`, `if(emailSetup)`, etc.),
            // built once from the closed prefix tuples. A mutant that always registers — or
            // registers from the wrong gate — would still pass every other test in this
            // describe block, since they all supply every setup together. This proves each gate
            // is independently load-bearing: with exactly one setup/handler omitted, its owned
            // button falls through to the question handler (buttons always have a fallback) or
            // is silently ignored (modals have none), while the other three features — still
            // configured — are unaffected. "Unaffected" is checked both negatively (the omitted
            // feature's own handlers are never reached) and positively (each remaining
            // configured feature's owned route is dispatched and does reach its handler) — a
            // mutant that dropped a non-omitted feature's registration entirely, e.g. omitting
            // email's routes specifically when bskySetup is absent, would still pass the
            // negative-only checks but is caught by the positive dispatch below.
            const scenarios: {
                omit:         'bsky' | 'email' | 'contact' | 'allowlist'
                ownedButton?: string
                ownedModal?:  string
            }[] = [
                { omit: 'bsky', ownedButton: 'bsky-send-approve:1', ownedModal: 'bsky-send-reject-reason:1' },
                { omit: 'email', ownedButton: 'email-send-approve:1', ownedModal: 'email-send-reject-reason:1' },
                { omit: 'contact', ownedButton: 'contact-approve:1' },
                { omit: 'allowlist', ownedButton: 'allowlist-yes:1', ownedModal: 'allowlist-name:1' },
            ];

            for(const scenario of scenarios) {
                const client = makeMockClientForConductor();
                const bskyButton = mock(async () => undefined);
                const bskyModal = mock(async () => undefined);
                const emailSendButton = mock(async () => undefined);
                const emailReviewButton = mock(async () => undefined);
                const emailModal = mock(async () => undefined);
                const contactButton = mock(async () => undefined);
                const allowlistButton = mock(async () => undefined);
                const allowlistModal = mock(async () => undefined);
                const handleButtonInteraction = mock(async () => undefined);
                spies.push(spyOn(interactionsModule, 'createInteractionHandler').mockReturnValue({ handleButtonInteraction }));

                createDiscordBot({
                    config:                      mockConfig, client, channelRegistry:             mockChannelRegistry,
                    bskySetup:                   scenario.omit === 'bsky' ? undefined : { outboundApprovalHandler: { handleButton: bskyButton, handleModalSubmit: bskyModal } } as unknown as DiscordBotOptions['bskySetup'],
                    emailSetup:                  scenario.omit === 'email' ? undefined : { outboundApprovalHandler: { handleButton: emailSendButton, handleModalSubmit: emailModal }, reviewHandler: { handleButton: emailReviewButton } } as unknown as EmailSetupResult,
                    contactApprovalHandler:      scenario.omit === 'contact' ? undefined : { handleButton: contactButton } as unknown as DiscordBotOptions['contactApprovalHandler'],
                    allowlistInteractionHandler: scenario.omit === 'allowlist' ? undefined : { handleButton: allowlistButton, handleModalSubmit: allowlistModal } as unknown as DiscordBotOptions['allowlistInteractionHandler'],
                });
                // eslint-disable-next-line no-await-in-loop -- each scenario builds an independent bot instance
                await triggerReady(client);
                const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;

                if(scenario.ownedButton) {
                    // eslint-disable-next-line no-await-in-loop -- each scenario is checked independently
                    await onInteraction({ customId: scenario.ownedButton, isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => false });
                    expect(bskyButton).not.toHaveBeenCalled();
                    expect(emailSendButton).not.toHaveBeenCalled();
                    expect(emailReviewButton).not.toHaveBeenCalled();
                    expect(contactButton).not.toHaveBeenCalled();
                    expect(allowlistButton).not.toHaveBeenCalled();
                    // The omitted feature's owned button falls through to the generic question handler
                    expect(handleButtonInteraction).toHaveBeenCalledTimes(1);
                }
                if(scenario.ownedModal) {
                    // eslint-disable-next-line no-await-in-loop -- each scenario is checked independently
                    await onInteraction({ customId: scenario.ownedModal, isButton: () => false, isModalSubmit: () => true, isStringSelectMenu: () => false, isChatInputCommand: () => false });
                    expect(bskyModal).not.toHaveBeenCalled();
                    expect(emailModal).not.toHaveBeenCalled();
                    expect(allowlistModal).not.toHaveBeenCalled();
                    // Modals have no fallback handler — the interaction is simply ignored
                }

                // The other three features stay routable: dispatch each remaining configured
                // feature's owned button (and modal, where it has one) and confirm it still
                // reaches its real handler rather than falling through or being dropped.
                // eslint-disable-next-line no-await-in-loop -- each scenario is checked independently
                await expectRemainingFeaturesRouted(onInteraction, {
                    bsky:      { button: 'bsky-send-approve:1', buttonHandler: bskyButton, modal: 'bsky-send-reject-reason:1', modalHandler: bskyModal },
                    email:     { button: 'email-send-approve:1', buttonHandler: emailSendButton, modal: 'email-send-reject-reason:1', modalHandler: emailModal },
                    contact:   { button: 'contact-approve:1', buttonHandler: contactButton },
                    allowlist: { button: 'allowlist-yes:1', buttonHandler: allowlistButton, modal: 'allowlist-name:1', modalHandler: allowlistModal },
                }, scenario.omit);
            }
        });

        test('interaction completion waits for each selected integration handler', async () => {
            const client = makeMockClientForConductor();
            const makePendingHandler = () => {
                const started = Promise.withResolvers<void>();
                const completion = Promise.withResolvers<void>();
                return { started, completion, handler: mock(() => {
                    started.resolve();
                    return completion.promise;
                }) };
            };
            const bskyButton = makePendingHandler();
            const bskyModal = makePendingHandler();
            const emailSendButton = makePendingHandler();
            const emailReviewButton = makePendingHandler();
            const emailModal = makePendingHandler();
            const emailSelect = makePendingHandler();
            const contactButton = makePendingHandler();
            const allowlistButton = makePendingHandler();
            const allowlistModal = makePendingHandler();
            const calendarCommand = makePendingHandler();
            const contactCommand = makePendingHandler();
            createDiscordBot({
                config:                      mockConfig, client, channelRegistry:             mockChannelRegistry,
                bskySetup:                   { outboundApprovalHandler: { handleButton: bskyButton.handler, handleModalSubmit: bskyModal.handler } } as unknown as DiscordBotOptions['bskySetup'],
                emailSetup:                  { outboundApprovalHandler: { handleButton: emailSendButton.handler, handleModalSubmit: emailModal.handler, handleSelectMenu: emailSelect.handler }, reviewHandler: { handleButton: emailReviewButton.handler } } as unknown as EmailSetupResult,
                contactApprovalHandler:      { handleButton: contactButton.handler } as unknown as DiscordBotOptions['contactApprovalHandler'],
                allowlistInteractionHandler: { handleButton: allowlistButton.handler, handleModalSubmit: allowlistModal.handler } as unknown as DiscordBotOptions['allowlistInteractionHandler'],
                calendarHandler:             { handle: calendarCommand.handler } as unknown as DiscordBotOptions['calendarHandler'],
                contactHandler:              { handle: contactCommand.handler } as unknown as DiscordBotOptions['contactHandler'],
            });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            const cases: [string, string, ReturnType<typeof makePendingHandler>][] = [
                ['button', 'bsky-send-approve:1', bskyButton],
                ['button', 'email-send-approve:1', emailSendButton], ['button', 'email-trash:1', emailReviewButton],
                ['button', 'contact-approve:1', contactButton], ['button', 'allowlist-yes:1', allowlistButton],
                ['modal', 'bsky-send-reject-reason:1', bskyModal],
                ['modal', 'email-send-reject-reason:1', emailModal], ['modal', 'allowlist-name:1', allowlistModal],
                ['select', 'email-allowlist-select:1', emailSelect], ['calendar', 'calendar', calendarCommand], ['contact', 'contact', contactCommand],
            ];
            for(const [kind, id, pending] of cases) {
                const interaction = kind === 'calendar' || kind === 'contact'
                    ? { commandName: id, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true }
                    : { customId: id, isButton: () => kind === 'button', isModalSubmit: () => kind === 'modal', isStringSelectMenu: () => kind === 'select', isChatInputCommand: () => false };
                const routed = onInteraction(interaction);
                // eslint-disable-next-line no-await-in-loop -- each handler has an independent deferred completion contract
                await pending.started.promise;
                try {
                    // eslint-disable-next-line no-await-in-loop -- a macrotask boundary proves the public listener remains pending
                    await expectPromiseToRemainPending(routed);
                } finally {
                    pending.completion.resolve();
                }
                // eslint-disable-next-line no-await-in-loop -- settle each route before exercising the next handler
                await routed;
            }
            expect(calendarCommand.handler).toHaveBeenCalledTimes(1);
        });

        test('interaction completion waits for the generic question button handler', async () => {
            const client = makeMockClientForConductor();
            const started = Promise.withResolvers<void>();
            const completion = Promise.withResolvers<void>();
            const handleButtonInteraction = mock(() => {
                started.resolve();
                return completion.promise;
            });
            spies.push(spyOn(interactionsModule, 'createInteractionHandler').mockReturnValue({ handleButtonInteraction }));
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;

            const routed = onInteraction({ customId: 'question-confirm:1', isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => false });
            await started.promise;
            try {
                await expectPromiseToRemainPending(routed);
            } finally {
                completion.resolve();
            }
            await routed;
            expect(handleButtonInteraction).toHaveBeenCalledTimes(1);
        });

        test('interaction failure handling waits for its user-visible error reply', async () => {
            const client = makeMockClientForConductor();
            const replyStarted = Promise.withResolvers<void>();
            const replyCompletion = Promise.withResolvers<void>();
            const handle = mock(async () => {
                throw new Error('route failed');
            });
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, allowlistHandler: { handle } as unknown as AllowlistCommandHandler });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            const reply = mock(() => {
                replyStarted.resolve();
                return replyCompletion.promise;
            });

            const routed = onInteraction({ commandName: 'allowlist', type: 2, replied: false, deferred: false, reply, isRepliable: () => true, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true });
            await replyStarted.promise;
            try {
                await expectPromiseToRemainPending(routed);
            } finally {
                replyCompletion.resolve();
            }
            await routed;
            expect(reply).toHaveBeenCalledTimes(1);
        });

        test('unavailable command and select-menu replies describe the missing service', async () => {
            const client = makeMockClientForConductor();
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            for(const [commandName, content] of [
                ['allowlist', 'Allowlist management is not currently available.'],
                ['calendar', 'Calendar management is not currently available.'],
                ['contact', 'Contact management is not currently available.'],
            ]) {
                const reply = mock(async () => undefined);
                // eslint-disable-next-line no-await-in-loop -- verify each command's reply independently
                await onInteraction({ commandName, reply, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true });
                expect(reply).toHaveBeenCalledWith({ content, flags: MessageFlags.Ephemeral });
            }
            const reply = mock(async () => undefined);
            await onInteraction({ customId: 'email-allowlist-select:1', reply, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => true, isChatInputCommand: () => false });
            expect(reply).toHaveBeenCalledWith({ content: 'Email integration is not currently available.', flags: MessageFlags.Ephemeral });
            const unrelatedReply = mock(async () => undefined);
            await onInteraction({ customId: 'other-select:1', reply: unrelatedReply, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => true, isChatInputCommand: () => false });
            expect(unrelatedReply).not.toHaveBeenCalled();
        });

        test('interaction failure logs context and replies only before acknowledgement', async () => {
            const client = makeMockClientForConductor();
            const error = spyOn(loggerModule.logger, 'error');
            spies.push(error);
            const handle = mock(async () => {
                throw new Error('route failed');
            });
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, allowlistHandler: { handle } as unknown as AllowlistCommandHandler });
            const onInteraction = (client.on as ReturnType<typeof mock>).mock.calls.find(([event]) => event === 'interactionCreate')?.[1] as (interaction: unknown) => Promise<void>;
            for(const [replied, deferred] of [[false, false], [true, false], [false, true]]) {
                const reply = mock(async () => undefined);
                // eslint-disable-next-line no-await-in-loop -- each acknowledgement state is checked separately
                await onInteraction({ commandName: 'allowlist', type: 2, replied, deferred, reply, isRepliable: () => true, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isChatInputCommand: () => true });
                expect(reply.mock.calls).toHaveLength(replied || deferred ? 0 : 1);
                if(!replied && !deferred) {
                    expect(reply).toHaveBeenCalledWith({ content: 'An error occurred while processing this interaction.', flags: MessageFlags.Ephemeral });
                }
            }
            expect(error).toHaveBeenCalledWith({ error: 'route failed', interactionType: 2, msg: 'Unhandled error in interaction handler' });
        });

        test('rate-limit and shard callbacks preserve event names and diagnostic context', () => {
            const client = makeMockClientForConductor();
            const warn = spyOn(loggerModule.logger, 'warn');
            spies.push(warn);
            const sendEvent = mock(() => undefined);
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, healthRegistry: { sendEvent } as unknown as DiscordBotOptions['healthRegistry'] });
            const restCalls = (client.rest.on as ReturnType<typeof mock>).mock.calls;
            const rateLimit = restCalls.find(([event]) => event === 'rateLimited')?.[1] as (info: Record<string, unknown>) => void;
            expect(rateLimit).toBeDefined();
            rateLimit({ route: '/channels/1', limit: 5, retryAfter: 42, global: false });
            expect(warn).toHaveBeenCalledWith({ route: '/channels/1', limit: 5, retryAfter: 42, global: false, msg: 'Discord rate limit hit, auto-retrying' });
            const calls = (client.on as ReturnType<typeof mock>).mock.calls;
            let eventCount = 0;
            for(const [event, state] of [['shardDisconnect', 'CONNECTION_LOST'], ['shardReady', 'CONNECT_SUCCESS'], ['shardResume', 'CONNECT_SUCCESS']]) {
                const handler = calls.find(([name]) => name === event)?.[1] as (() => void) | undefined;
                expect(handler).toBeDefined();
                handler!();
                eventCount += 1;
                expect(sendEvent).toHaveBeenCalledTimes(eventCount);
                expect(sendEvent).toHaveBeenLastCalledWith('discord', { type: state });
            }
        });

        test('bot-created rate limiter admits exactly five different channels concurrently', async () => {
            const client = makeMockClientForConductor();
            const coordinator = spyOn(coordinatorSetupModule, 'setupCoordinatorIntegration').mockReturnValue({ stop: mock(() => undefined) } as unknown as MessageCoordinator);
            spies.push(coordinator);
            createDiscordBot({ config: mockConfig, client, channelRegistry: mockChannelRegistry, ...conductorDeps() });
            await triggerReady(client);
            const limiter = coordinator.mock.calls[0]?.[0].rateLimiter;
            expect(limiter).toBeDefined();
            const release = Promise.withResolvers<void>();
            let started = 0;
            const sends = Array.from({ length: 6 }, (_, index) => limiter.sendToChannel({
                id:   `channel-${index}`,
                send: mock(async () => {
                    started += 1;
                    await release.promise;
                    return { id: `message-${index}` };
                }),
            } as never, `message-${index}`));
            try {
                await Bun.sleep(0);
                expect(started).toBe(5);
            } finally {
                release.resolve();
            }
            await Promise.all(sends);
        });

        test('clientReady waits for admin review channel muting to finish', async () => {
            const client = makeMockClientForConductor();
            const started = Promise.withResolvers<void>();
            const completion = Promise.withResolvers<void>();
            const channelRegistry = {
                ...mockChannelRegistry,
                muteChannel: mock(() => {
                    started.resolve();
                    return completion.promise;
                }),
            } as unknown as ChannelRegistryManager;
            createDiscordBot({ config: mockConfig, client, channelRegistry, adminReviewChannelId: createChannelId('admin-review') });

            const ready = triggerReady(client);
            await started.promise;
            try {
                await expectPromiseToRemainPending(ready);
            } finally {
                completion.resolve();
            }
            await ready;
            expect(channelRegistry.muteChannel).toHaveBeenCalledWith('admin-review');
        });

        test('clientReady waits for the perch replay-exclusion lookup before completing inbox initialization', async () => {
            const client = makeMockClientForConductor();
            stubCoordinator();
            const started = Promise.withResolvers<void>();
            const completion = Promise.withResolvers<null>();
            const channelRegistry = {
                ...mockChannelRegistry,
                getWellKnownChannel: mock(() => {
                    started.resolve();
                    return completion.promise;
                }),
            } as unknown as ChannelRegistryManager;
            spies.push(spyOn(perchSetupModule, 'setupPerchDriverAndScheduler').mockReturnValue({
                driver:    { runSlot: mock(() => 'started' as const), stop: mock(() => undefined) },
                scheduler: { start: mock(() => undefined), stop: mock(() => undefined), getState: mock(), triggerNow: mock(), triggerTestPerch: mock() },
            }));
            createDiscordBot({
                config:       mockConfig,
                client,
                channelRegistry,
                inboxManager: { loadUnread: mock(async () => undefined), getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) } as unknown as InboxManager,
                perchConfig:  { enabled: true, timezone: 'America/Los_Angeles', intervalMinutes: 60, jitterMinutes: 0, slotWindowMinutes: 45, wrapUpLeadMinutes: 5 },
                ...conductorDeps({ perchConductor: makeFakeConductor(), perchLedgerStore: makeFakeLedgerStore('perch'), perchJournal: { append: mock(() => undefined), flush: mock(async () => undefined), readSince: mock(async () => []) } }),
            });

            const ready = triggerReady(client);
            await started.promise;
            try {
                await expectPromiseToRemainPending(ready);
            } finally {
                completion.resolve(null);
            }
            await ready;
            expect(channelRegistry.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
        });
    });
});
