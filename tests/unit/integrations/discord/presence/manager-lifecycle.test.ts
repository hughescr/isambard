import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { type Client, ActivityType  } from 'discord.js';
import { PresenceManager, type PresenceManagerDeps  } from '@/integrations/discord/presence/manager';
import type { PresenceView } from '@/integrations/discord/presence/presence-view';
import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';

// Typed mock shapes that expose both real interface and bun mock methods
type MockWithCalls = ReturnType<typeof mock> & { mock: { calls: unknown[][] } };
interface MockedClient { user: { setActivity: MockWithCalls } }
interface MockedActiveGenerator { generate: MockWithCalls }
interface MockedIdleGenerator { generate: MockWithCalls }

const idleView: PresenceView = {
    live:       [],
    prefix:     '💤 • 1 🪾',
    compacting: false,
    phase:      { type: 'idle', since: new Date(0) },
    activeRole: null,
};

const activeView: PresenceView = {
    live:       ['conversation'],
    prefix:     '💬 • 1 🪾',
    compacting: false,
    phase:      { type: 'thinking', startedAt: new Date(0) },
    activeRole: 'conversation',
};

const respondingView: PresenceView = { ...activeView, phase: { type: 'responding', startedAt: new Date(0) } };

const thinkingActivity = { name: '💬 • 1 🪾 • Status for thinking', type: ActivityType.Custom };

describe('PresenceManager Lifecycle', () => {
    let mockClient: MockedClient;
    let mockActiveGenerator: MockedActiveGenerator;
    let mockIdleGenerator: MockedIdleGenerator;
    let mockLogger: PresenceManagerDeps['logger'];
    let config: PresenceConfig;

    function createManager(overrides: Partial<PresenceManagerDeps> = {}): PresenceManager {
        return new PresenceManager({
            discordClient:         mockClient as unknown as Client,
            activeStatusGenerator: mockActiveGenerator,
            idleStatusGenerator:   mockIdleGenerator,
            config,
            logger:                mockLogger,
            ...overrides,
        });
    }

    /** Lets a fired interval callback's refresh (generate → retry wrapper → setActivity) settle. */
    async function drainMicrotasks(): Promise<void> {
        for(let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop -- each turn must land one microtask tick later than the last (a chain, not a parallel batch)
            await Promise.resolve();
        }
    }

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        jest.setSystemTime(1000);

        mockClient = {
            user: {
                setActivity: mock(() => undefined),
            },
        };

        mockActiveGenerator = {
            generate: mock((phase: PresencePhase) => ({
                name: `Status for ${phase.type}`,
                type: ActivityType.Custom,
            })),
        };

        mockIdleGenerator = {
            generate: mock(async () => ({
                name: 'Dozing peacefully',
                type: ActivityType.Custom,
            })),
        };

        mockLogger = {
            debug: mock(() => undefined),
            error: mock(() => undefined),
            info:  mock(() => undefined),
        };

        config = {
            updateThrottleMs:      100,
            idleTimeoutMs:         100,
            idleRefreshIntervalMs: 200,
        };
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    describe('null/undefined client.user', () => {
        it('an active view with a null client.user neither throws nor reports a success or failure', async () => {
            const manager = createManager({ discordClient: { user: null } as unknown as Client });

            await manager.applyView(activeView);

            // Nothing reached Discord, so neither a success nor a failure is reported.
            expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), 'Updated Discord presence');
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('an idle view with an undefined client.user neither throws nor reports a success or failure', async () => {
            const manager = createManager({ discordClient: { user: undefined } as unknown as Client });

            await manager.applyView(idleView);

            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(1);
            expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), 'Updated Discord presence');
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });

    describe('idle refresh guard once no longer idle', () => {
        it('an interval callback queued before an active view arrives generates no idle line and leaves the active status in place', async () => {
            const intervalSpy = spyOn(globalThis, 'setInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            const queuedCallback = intervalSpy.mock.calls[0]?.[0] as (() => void) | undefined;
            expect(queuedCallback).toBeDefined();
            const idleCalls = mockIdleGenerator.generate.mock.calls.length;

            await manager.applyView(activeView);
            queuedCallback?.();
            await drainMicrotasks();

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCalls);
            expect(mockClient.user.setActivity).toHaveBeenLastCalledWith(thinkingActivity);
            intervalSpy.mockRestore();
        });

        it('the idle refresh interval stops firing once an active view arrives', async () => {
            const manager = createManager();

            await manager.applyView(idleView);
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(1);

            // One tick while still idle: the loop is live.
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainMicrotasks();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(2);

            await manager.applyView(activeView);
            expect(jest.getTimerCount()).toBe(0);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs * 5);
            await drainMicrotasks();

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(2);
        });
    });

    describe('start()', () => {
        it('start() logs exactly the starting message', () => {
            const manager = createManager();

            manager.start();

            expect((mockLogger.info as MockWithCalls).mock.calls).toEqual([['Starting presence manager']]);
        });

        it.each([
            { desc: 'no view', views: [] as PresenceView[], expectedTimers: 0, expectedIdleCalls: 0 },
            { desc: 'an idle view', views: [idleView], expectedTimers: 1, expectedIdleCalls: 1 },
            { desc: 'an active view', views: [activeView], expectedTimers: 0, expectedIdleCalls: 0 },
        ])('start() after $desc creates no timer and generates nothing', async ({ views, expectedTimers, expectedIdleCalls }) => {
            const setIntervalSpy = spyOn(globalThis, 'setInterval');
            const manager = createManager();
            for(const view of views) {
                // eslint-disable-next-line no-await-in-loop -- views are applied strictly in order
                await manager.applyView(view);
            }
            const setIntervalCalls = setIntervalSpy.mock.calls.length;
            const setActivityCalls = mockClient.user.setActivity.mock.calls.length;

            manager.start();
            await drainMicrotasks();

            expect(setIntervalSpy.mock.calls).toHaveLength(setIntervalCalls);
            expect(jest.getTimerCount()).toBe(expectedTimers);
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(expectedIdleCalls);
            expect(mockClient.user.setActivity.mock.calls).toHaveLength(setActivityCalls);
            setIntervalSpy.mockRestore();
        });

        it('start() then stop() with no view never calls the idle generator nor Discord', async () => {
            const manager = createManager();

            expect(() => manager.start()).not.toThrow();
            await drainMicrotasks();
            manager.stop();

            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
        });
    });

    describe('stop()', () => {
        it('stop() logs exactly the stopping message', () => {
            const manager = createManager();

            manager.stop();

            expect((mockLogger.info as MockWithCalls).mock.calls).toEqual([['Stopping presence manager']]);
        });

        it('stop() after an idle view clears the refresh timer so no further idle generation happens', async () => {
            const manager = createManager();

            await manager.applyView(idleView);
            expect(jest.getTimerCount()).toBe(1);
            const idleCalls = mockIdleGenerator.generate.mock.calls.length;

            manager.stop();

            expect(jest.getTimerCount()).toBe(0);
            expect(mockLogger.debug).toHaveBeenCalledWith('Stopped idle status refresh');
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await drainMicrotasks();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCalls);
        });
    });

    describe('logger assertions', () => {
        it('logs a successful apply with the exact activity payload', async () => {
            const manager = createManager();

            await manager.applyView(activeView);

            expect(mockLogger.info).toHaveBeenCalledWith({ activity: thinkingActivity }, 'Updated Discord presence');
        });

        it('logs a failed apply with the exact error and activity payload', async () => {
            const testError = new Error('Discord API error');
            const errorClient = {
                user: {
                    setActivity: mock(() => {
                        throw testError;
                    }),
                },
            } as unknown as Client;
            const manager = createManager({ discordClient: errorClient });

            await manager.applyView(activeView);

            expect(mockLogger.error).toHaveBeenCalledWith({ error: testError, activity: thinkingActivity }, 'Failed to update Discord presence');
        });

        it('logs the idle refresh start with its interval', async () => {
            const manager = createManager();

            await manager.applyView(idleView);

            expect(mockLogger.debug).toHaveBeenCalledWith({ intervalMs: config.idleRefreshIntervalMs }, 'Started idle status refresh');
        });

        it('logs the idle refresh stop when an active view follows an idle one', async () => {
            const manager = createManager();

            await manager.applyView(idleView);
            expect(mockLogger.debug).not.toHaveBeenCalledWith('Stopped idle status refresh');

            await manager.applyView(activeView);

            expect(mockLogger.debug).toHaveBeenCalledWith('Stopped idle status refresh');
        });
    });

    describe('stopIdleRefresh execution', () => {
        it('idle→active calls clearInterval exactly once', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            await manager.applyView(activeView);

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            clearIntervalSpy.mockRestore();
        });

        it('active→active never calls clearInterval', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(clearIntervalSpy).not.toHaveBeenCalled();
            clearIntervalSpy.mockRestore();
        });

        it('idle→active→active→stop() calls clearInterval exactly once', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            await manager.applyView(activeView);
            await manager.applyView(respondingView);
            manager.stop();

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            clearIntervalSpy.mockRestore();
        });
    });

    describe('active/idle generator routing', () => {
        it('idle views never call the active status generator', async () => {
            const manager = createManager();

            await manager.applyView(idleView);
            await manager.applyView({ ...idleView, prefix: '💤 • 2 🪾' });

            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(2);
        });

        it('active views call the active status generator with exactly the view phase and never the idle generator', async () => {
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(mockActiveGenerator.generate.mock.calls).toEqual([[activeView.phase], [respondingView.phase]]);
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('full cycle null→active→idle→active starts one refresh loop and clears it once', async () => {
            const setIntervalSpy = spyOn(globalThis, 'setInterval');
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(activeView);
            expect(setIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            await manager.applyView(idleView);
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(1);

            await manager.applyView(respondingView);
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await drainMicrotasks();
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(1);
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            expect(mockClient.user.setActivity).toHaveBeenLastCalledWith({ name: '💬 • 1 🪾 • Status for responding', type: ActivityType.Custom });

            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
        });
    });
});
