import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { type Client, type ActivitiesOptions, ActivityType  } from 'discord.js';
import { mockWithDiscordRetry, originalWithDiscordRetry } from '../../../../setup';
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

/** Same prefix as {@link activeView}, different phase — so the default mock generator renders a different digest. */
const respondingView: PresenceView = { ...activeView, phase: { type: 'responding', startedAt: new Date(0) } };

const thinkingActivity = { name: '💬 • 1 🪾 • Status for thinking', type: ActivityType.Custom };
const respondingActivity = { name: '💬 • 1 🪾 • Status for responding', type: ActivityType.Custom };

describe('PresenceManager', () => {
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
    async function drainTicks(): Promise<void> {
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
                name: '💤 Dozing peacefully',
                type: ActivityType.Custom,
            })),
        };

        mockLogger = {
            debug: mock(() => undefined),
            error: mock(() => undefined),
            info:  mock(() => undefined),
        };

        config = {
            updateThrottleMs:      100, // 100ms throttle for testing
            idleTimeoutMs:         100,
            idleRefreshIntervalMs: 200,
        };
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    describe('applyView - active views apply immediately (no internal throttling)', () => {
        it('an active view calls setActivity once with the prefix-rendered digest', async () => {
            const manager = createManager();

            await manager.applyView(activeView);

            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(activeView.phase);
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith(thinkingActivity);
        });

        it('consecutive active views with different text each reach Discord straight away', async () => {
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity.mock.calls).toEqual([[thinkingActivity], [respondingActivity]]);
        });
    });

    describe('applyView - idle transitions', () => {
        it('an idle view after an active view generates the idle line and applies it immediately', async () => {
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(idleView);

            expect(mockIdleGenerator.generate.mock.calls).toEqual([[{ prefix: '💤 • 1 🪾', compacting: false }]]);
            expect(mockClient.user.setActivity.mock.calls).toEqual([
                [thinkingActivity],
                [{ name: '💤 Dozing peacefully', type: ActivityType.Custom }],
            ]);
        });

        it('an idle view registers exactly one refresh timer', async () => {
            const manager = createManager();

            await manager.applyView(idleView);

            expect(jest.getTimerCount()).toBe(1);
        });

        it('an active view after an idle view clears the refresh timer and no further idle generation happens', async () => {
            const manager = createManager();

            await manager.applyView(idleView);
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            await manager.applyView(activeView);

            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await drainTicks();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCount);
        });
    });

    describe('applyPresenceUpdate dedupe', () => {
        // Defect 3b: Discord was being handed the identical activity repeatedly (the 2026-09-08
        // production log shows back-to-back "Updated Discord presence" lines with the same text).
        // The manager now remembers the last activity it SUCCESSFULLY applied and skips a call
        // that would change nothing.
        it('skips the Discord call when the same name and type are applied twice', async () => {
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type: ActivityType.Custom }));
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { activity: { name: '💬 • 1 🪾 • Same status', type: ActivityType.Custom } },
                'Presence unchanged, skipping update'
            );
        });

        it('applies again when the name differs', async () => {
            const manager = createManager();

            // The default generator names the status after the phase, so these differ.
            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
            expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.anything(), 'Presence unchanged, skipping update');
        });

        it('applies again when only the activity type differs', async () => {
            let type: ActivityType = ActivityType.Custom;
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type }));
            const manager = createManager();

            await manager.applyView(activeView);
            type = ActivityType.Playing;
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity.mock.calls).toEqual([
                [{ name: '💬 • 1 🪾 • Same status', type: ActivityType.Custom }],
                [{ name: '💬 • 1 🪾 • Same status', type: ActivityType.Playing }],
            ]);
        });

        it('re-sends an identical activity after a failed apply (a failure is never remembered)', async () => {
            let attempts = 0;
            const flakyClient = {
                user: {
                    setActivity: mock(() => {
                        attempts += 1;
                        if(attempts === 1) {
                            throw new Error('Discord API error');
                        }
                    }),
                },
            };
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type: ActivityType.Custom }));
            const manager = createManager({ discordClient: flakyClient as unknown as Client });

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(flakyClient.user.setActivity).toHaveBeenCalledTimes(2);
        });

        it('does not remember an activity Discord was never told about (client.user is null)', async () => {
            // `discordClient.user` is null until the gateway READY frame lands. The apply throws
            // nothing in that window — it simply has nobody to call — so it must not be recorded
            // as applied, or the first real apply after READY would be deduped into oblivion.
            const lateReadyClient: { user: MockedClient['user'] | null } = { user: null };
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type: ActivityType.Custom }));
            const manager = createManager({ discordClient: lateReadyClient as unknown as Client });

            await manager.applyView(activeView);

            lateReadyClient.user = mockClient.user;
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: '💬 • 1 🪾 • Same status', type: ActivityType.Custom });
        });

        it('does not log a successful apply when there was no user to apply it to', async () => {
            const manager = createManager({ discordClient: { user: null } as unknown as Client });

            await manager.applyView(activeView);

            expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), 'Updated Discord presence');
        });

        it('re-pushes the idle status on every refresh tick even when the text never changes', async () => {
            // The idle refresh loop doubles as a presence keep-alive: Discord drops a bot's
            // activity on a fresh IDENTIFY, and nothing re-applies presence on reconnect, so an
            // idle re-push must reach Discord even though the generated line is identical.
            const manager = createManager();

            await manager.applyView(idleView);
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainTicks();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainTicks();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(3);

            expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.anything(), 'Presence unchanged, skipping update');
        });

        it('records the forced idle apply, so an identical active apply straight after is still deduped', async () => {
            // The idle line happens to be word-for-word the text the next active view renders.
            mockIdleGenerator.generate = mock(async () => thinkingActivity);
            const manager = createManager();

            await manager.applyView(idleView);
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            await manager.applyView(activeView);

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith({ activity: thinkingActivity }, 'Presence unchanged, skipping update');
        });
    });

    describe('error handling', () => {
        it('should handle Discord API errors gracefully', async () => {
            const errorClient = {
                user: {
                    setActivity: mock(() => {
                        throw new Error('Discord API error');
                    }),
                },
            } as unknown as Client;
            const manager = createManager({ discordClient: errorClient });

            // Should not throw (errors are caught internally)
            await manager.applyView(activeView);

            expect(mockLogger.error).toHaveBeenCalledWith(
                { error: expect.any(Error), activity: thinkingActivity },
                'Failed to update Discord presence'
            );
        });

        it('should not retry setActivity for permanent (non-network) errors', async () => {
            // Permanent (non-network) errors short-circuit the retry wrapper: exactly one attempt.
            // Together with the transient-error test below, this pins `{ policy: { maxAttempts: 2 } }`.
            let callCount = 0;
            const retryClient = {
                user: {
                    setActivity: mock(() => {
                        callCount++;
                        // Throw permanent error (not a network error code)
                        throw new Error('Invalid activity type');
                    }),
                },
            } as unknown as Client;
            const manager = createManager({ discordClient: retryClient });

            await manager.applyView(activeView);

            // Should have been called exactly 1 time (no retries for permanent errors)
            expect(callCount).toBe(1);
            expect(retryClient.user!.setActivity).toHaveBeenCalledTimes(1);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), activity: expect.any(Object) }),
                'Failed to update Discord presence'
            );
        });

        it('should retry setActivity for transient (network) errors', async () => {
            // Transient (network) errors retry according to maxAttempts: 2 → exactly 2 attempts.

            // Restore original retry implementation but inject instant sleep for fast test execution
            mockWithDiscordRetry.mockImplementation(async <T>(
                operation: () => Promise<T>,
                _options?: unknown
            ): Promise<T> => {
                const options = _options as Record<string, unknown> & { deps?: Record<string, unknown> };
                return originalWithDiscordRetry(operation, {
                    ...options,
                    deps: {
                        ...options.deps,
                        sleep: async () => {},
                    },
                });
            });

            let callCount = 0;
            const networkError = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });

            const retryClient = {
                user: {
                    setActivity: mock(() => {
                        callCount++;
                        // ECONNRESET is a transient error code, retried per maxAttempts
                        throw networkError;
                    }),
                },
            } as unknown as Client;
            const manager = createManager({ discordClient: retryClient });

            await manager.applyView(activeView);

            // Restore mock behavior for other tests
            mockWithDiscordRetry.mockReset();
            mockWithDiscordRetry.mockImplementation(async <T>(operation: () => Promise<T>) => operation());

            // Should have been called exactly 2 times (1 initial + 1 retry)
            expect(callCount).toBe(2);
            expect(retryClient.user!.setActivity).toHaveBeenCalledTimes(2);

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), activity: expect.any(Object) }),
                'Failed to update Discord presence'
            );
        });
    });

    describe('state transition matrix', () => {
        it('null→idle: a first idle view starts the refresh and applies the idle line', async () => {
            const manager = createManager();

            await manager.applyView(idleView);

            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(1);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: '💤 Dozing peacefully', type: ActivityType.Custom });
        });

        it('null→active: a first active view uses only the active generator', async () => {
            const manager = createManager();

            await manager.applyView(activeView);

            expect(mockActiveGenerator.generate).toHaveBeenCalledTimes(1);
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);
        });

        it('idle→idle: a second idle view refreshes once more on the same loop, without a second setInterval or any clearInterval', async () => {
            const setIntervalSpy = spyOn(globalThis, 'setInterval');
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            await manager.applyView(idleView);

            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(2);
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();
        });

        it('active→active: consecutive active views never touch the idle generator or timers', async () => {
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(respondingView);

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    describe('timer guard verification', () => {
        it('repeated idle views register exactly one setInterval and log one refresh start', async () => {
            const setIntervalSpy = spyOn(globalThis, 'setInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            await manager.applyView(idleView);
            await manager.applyView({ ...idleView, prefix: '💤 • 2 🪾' });

            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(1);
            const startedLogs = (mockLogger.debug as MockWithCalls).mock.calls.filter(call => call.at(-1) === 'Started idle status refresh');
            expect(startedLogs).toHaveLength(1);
            setIntervalSpy.mockRestore();
        });

        it('idle→active calls clearInterval exactly once and leaves no timer', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            await manager.applyView(idleView);
            await manager.applyView(activeView);

            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
            expect(jest.getTimerCount()).toBe(0);
            clearIntervalSpy.mockRestore();
        });

        it('should handle stop when interval is null (no error)', () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');
            const manager = createManager();

            // Stop without ever starting idle - should not throw
            expect(() => manager.stop()).not.toThrow();

            // Verify clearInterval was NOT called (no interval existed to clear)
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should run idle refresh on interval', async () => {
            const manager = createManager();

            // Start idle - first refresh happens immediately
            await manager.applyView(idleView);
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(1);

            // Wait for one interval - second refresh should happen
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainTicks();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(2);

            // Wait for another interval - third refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainTicks();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(3);
            expect(mockIdleGenerator.generate).toHaveBeenLastCalledWith({ prefix: '💤 • 1 🪾', compacting: false });
        });
    });

    describe('assignment mutations', () => {
        it('active→idle→active: the loop the idle view started is stopped by the next active view', async () => {
            const manager = createManager();

            await manager.applyView(activeView);
            await manager.applyView(idleView);
            expect(mockIdleGenerator.generate).toHaveBeenCalledTimes(1);

            await manager.applyView(respondingView);
            const idleCountAfterActive = mockIdleGenerator.generate.mock.calls.length;

            // Wait for what would be idle refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await drainTicks();

            // No new idle refreshes should have occurred
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCountAfterActive);
            expect(mockClient.user.setActivity).toHaveBeenLastCalledWith(respondingActivity);
        });
    });

    describe('applyView (P11)', () => {
        it('idle view starts the idle refresh and passes { prefix, compacting } to idleStatusGenerator.generate', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.applyView(idleView);

            expect(mockIdleGenerator.generate).toHaveBeenCalledWith({ prefix: '💤 • 1 🪾', compacting: false });
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: '💤 Dozing peacefully', type: ActivityType.Custom });
        });

        it('an idle-to-idle prefix change refreshes the status immediately, not just on the next periodic interval', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.applyView(idleView);
            const callCountAfterFirst = mockIdleGenerator.generate.mock.calls.length;

            const changedView: PresenceView = { ...idleView, prefix: '💤 • 2 🪾' };
            await manager.applyView(changedView);

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(callCountAfterFirst + 1);
            expect(mockIdleGenerator.generate).toHaveBeenLastCalledWith({ prefix: '💤 • 2 🪾', compacting: false });
        });

        it('active view stops the idle refresh and applies renderPresenceText(view, digest)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Establish the idle refresh loop first so we can prove it gets stopped.
            await manager.applyView(idleView);
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            await manager.applyView(activeView);

            // activeStatusGenerator.generate is called with the view's phase only
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(activeView.phase);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({
                name: '💬 • 1 🪾 • Status for thinking',
                type: ActivityType.Custom,
            });

            // Idle refresh loop was stopped: advancing time triggers no further idle generation
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCount);
        });

        it('compacting active view renders the compacting marker before the digest', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.applyView({ ...activeView, compacting: true });

            expect(mockClient.user.setActivity).toHaveBeenCalledWith({
                name: '💬 • 1 🪾 • compacting • Status for thinking',
                type: ActivityType.Custom,
            });
        });

        it('periodic idle refresh recomposes the prefix via recomposeIdlePrefix instead of re-rendering a stale cached one (Q3/B4: the ⏸ perch marker must clear at midnight even with no ledger event to trigger a fresh applyView)', async () => {
            // A call counter (rather than reassigning a captured variable) drives the sequence: the
            // ceiling is paused for the first recompose (the initial applyView), then clears for
            // the second (the periodic timer's own refresh) — with no further test-side mutation
            // in between, so nothing here races the async idle-generation path.
            const prefixesByCall = ['💤 • ⏸ perch', '💤'];
            let recomposeCallCount = 0;
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
                recomposeIdlePrefix:   () => {
                    const prefix = prefixesByCall[recomposeCallCount] ?? prefixesByCall.at(-1)!;
                    recomposeCallCount += 1;
                    return { prefix, compacting: false };
                },
            });

            await manager.applyView(idleView);
            expect(mockIdleGenerator.generate).toHaveBeenLastCalledWith({ prefix: '💤 • ⏸ perch', compacting: false });

            // The cost ceiling clears at local midnight from a wall-clock rollover, not a ledger
            // event — nothing calls applyView() again, but the periodic idle refresh timer still
            // fires and must recompose rather than reuse the stale cached prefix.
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate).toHaveBeenLastCalledWith({ prefix: '💤', compacting: false });
        });

        it('recomposeIdlePrefix also supplies the compacting marker the idle refresh renders with', async () => {
            const manager = createManager({ recomposeIdlePrefix: () => ({ prefix: '💤 • recomposed', compacting: true }) });

            await manager.applyView(idleView);

            expect(mockIdleGenerator.generate.mock.calls).toEqual([[{ prefix: '💤 • recomposed', compacting: true }]]);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: '💤 Dozing peacefully', type: ActivityType.Custom });
        });

        it('isolates recomposed state and stale-result checks from generator input mutation', async () => {
            const recomposed = { prefix: '💤 • stable', compacting: false };
            mockIdleGenerator.generate = mock(async (options) => {
                if(options) {
                    options.prefix = 'mutated by generator';
                    options.compacting = true;
                }
                return { name: 'Stable idle status', type: ActivityType.Custom };
            });
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
                recomposeIdlePrefix:   () => recomposed,
            });

            await manager.applyView(idleView);

            expect(recomposed).toEqual({ prefix: '💤 • stable', compacting: false });
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({
                name: 'Stable idle status', type: ActivityType.Custom,
            });
        });

        it('without recomposeIdlePrefix, periodic idle refresh keeps rendering the last composed prefix', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.applyView(idleView);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate).toHaveBeenLastCalledWith({ prefix: '💤 • 1 🪾', compacting: false });
        });

        it('discards a stale idle result when the composed prefix changes during generation', async () => {
            const idleGeneratePromises: { resolve: (value: ActivitiesOptions) => void }[] = [];
            mockIdleGenerator.generate = mock(() => new Promise<ActivitiesOptions>((resolve) => {
                idleGeneratePromises.push({ resolve });
            }));

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            const staleView: PresenceView = { ...idleView, prefix: '💤 • 1 🪾' };
            const freshView: PresenceView = { ...idleView, prefix: '💤 • 2 🪾' };

            void manager.applyView(staleView);
            await Promise.resolve();
            expect(idleGeneratePromises).toHaveLength(1);

            void manager.applyView(freshView);
            await Promise.resolve();
            expect(idleGeneratePromises).toHaveLength(2);

            // Resolve the stale (first) generation — must be discarded, not applied.
            idleGeneratePromises[0].resolve({ name: 'Stale idle status', type: ActivityType.Custom });
            await Promise.resolve();
            await Promise.resolve();

            expect(mockClient.user.setActivity).not.toHaveBeenCalledWith(
                expect.objectContaining({ name: 'Stale idle status' })
            );
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { prefixAtStart: '💤 • 1 🪾', currentPrefix: '💤 • 2 🪾' },
                'Discarding stale idle status (composed prefix changed during generation)'
            );

            // Resolve the fresh (second) generation — must be applied.
            idleGeneratePromises[1].resolve({ name: 'Fresh idle status', type: ActivityType.Custom });
            await Promise.resolve();
            await Promise.resolve();

            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: 'Fresh idle status', type: ActivityType.Custom });
        });

        it('keeps the newer in-flight refresh registered when an older prefix generation settles', async () => {
            const idleGeneratePromises: { resolve: (value: ActivitiesOptions) => void }[] = [];
            mockIdleGenerator.generate = mock(() => new Promise<ActivitiesOptions>((resolve) => {
                idleGeneratePromises.push({ resolve });
            }));
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });
            const oldView: PresenceView = { ...idleView, prefix: 'old' };
            const newView: PresenceView = { ...idleView, prefix: 'new' };

            void manager.applyView(oldView);
            await Promise.resolve();
            void manager.applyView(newView);
            await Promise.resolve();
            expect(idleGeneratePromises).toHaveLength(2);

            idleGeneratePromises[0].resolve({ name: 'old status', type: ActivityType.Custom });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            void manager.applyView(newView);
            await Promise.resolve();

            expect(idleGeneratePromises).toHaveLength(2);
            idleGeneratePromises[1].resolve({ name: 'new status', type: ActivityType.Custom });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        it('discards an idle status whose generation was still in flight when an active view arrived (interrupt-then-new-turn gap)', async () => {
            const idleGeneratePromises: { resolve: (value: ActivitiesOptions) => void }[] = [];
            mockIdleGenerator.generate = mock(() => new Promise<ActivitiesOptions>((resolve) => {
                idleGeneratePromises.push({ resolve });
            }));
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            void manager.applyView(idleView);
            await Promise.resolve();
            expect(idleGeneratePromises).toHaveLength(1);

            await manager.applyView(activeView);
            (mockClient.user.setActivity as ReturnType<typeof mock>).mockClear();

            idleGeneratePromises[0].resolve({ name: 'Stale idle line', type: ActivityType.Custom });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledWith({ currentPhase: 'thinking' }, 'Discarding stale idle status (no longer idle)');
        });

        it('two idle views arriving while the first idle generation is still in flight (both sessions going idle at boot) start exactly ONE refresh loop and ONE generation', async () => {
            const idleGeneratePromises: { resolve: (value: ActivitiesOptions) => void }[] = [];
            mockIdleGenerator.generate = mock(() => new Promise<ActivitiesOptions>((resolve) => {
                idleGeneratePromises.push({ resolve });
            }));

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            void manager.applyView(idleView);
            await Promise.resolve();
            void manager.applyView(idleView);
            await Promise.resolve();

            // Same prefix, generation still in flight: the second view joins it rather than
            // spending a second Haiku call on an identical status.
            expect(idleGeneratePromises).toHaveLength(1);

            idleGeneratePromises[0].resolve({ name: 'Once', type: ActivityType.Custom });
            // Drain the generate → retry wrapper → setActivity → in-flight cleanup chain.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            const startedLogs = (mockLogger.debug as ReturnType<typeof mock>).mock.calls.filter(call => call.at(-1) === 'Started idle status refresh');
            expect(startedLogs).toHaveLength(1);

            // Exactly one periodic loop: one tick later there is exactly one more generation.
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            expect(idleGeneratePromises).toHaveLength(2);
        });
    });
    describe('applyView awaits the presence work it triggers (dropped-await guards)', () => {
        // A dropped `await` cannot change WHAT applyView does, only WHEN its promise settles, so
        // the observable here is the promise's pending state: hold the downstream Discord write
        // (or the Haiku generation feeding it) open, drain every microtask a mutant could have
        // used, and assert applyView is still unsettled. Nothing here waits on a real timer.
        async function drainMicrotasks(): Promise<void> {
            for(let i = 0; i < 30; i++) {
                // eslint-disable-next-line no-await-in-loop -- each turn must land one microtask tick later than the last (a chain, not a parallel batch), covering generate → in-flight coalescing → refreshIdleStatus → applyPresenceUpdate → retry wrapper
                await Promise.resolve();
            }
        }

        it('applyView(idle) stays pending until the idle status it started has been generated and applied (await on startIdleRefresh/refreshIdleStatus)', async () => {
            let releaseIdle!: (value: ActivitiesOptions) => void;
            mockIdleGenerator.generate = mock(() => new Promise<ActivitiesOptions>((resolve) => {
                releaseIdle = resolve;
            }));

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            let settled = false;
            const applied = manager.applyView(idleView).finally(() => {
                settled = true;
            });

            await drainMicrotasks();
            expect(settled).toBe(false);

            releaseIdle({ name: 'Gated idle line', type: ActivityType.Custom });
            await applied;

            expect(settled).toBe(true);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: 'Gated idle line', type: ActivityType.Custom });
        });

        it('applyView(active) stays pending until its presence update has reached Discord (await on applyPresenceUpdate)', async () => {
            let releaseRetry!: () => void;
            mockWithDiscordRetry.mockImplementationOnce(async <T>(operation: () => Promise<T>, _options?: unknown): Promise<T> => {
                await new Promise<void>((resolve) => {
                    releaseRetry = resolve;
                });
                return operation();
            });

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            let settled = false;
            const applied = manager.applyView(activeView).finally(() => {
                settled = true;
            });

            await drainMicrotasks();
            expect(settled).toBe(false);

            releaseRetry();
            await applied;

            expect(settled).toBe(true);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({
                name: '💬 • 1 🪾 • Status for thinking',
                type: ActivityType.Custom,
            });
        });

        it('an idle refresh stays pending until its forced presence update has reached Discord (await on forcePresenceUpdate)', async () => {
            let releaseRetry!: () => void;
            mockWithDiscordRetry.mockImplementationOnce(async <T>(operation: () => Promise<T>, _options?: unknown): Promise<T> => {
                await new Promise<void>((resolve) => {
                    releaseRetry = resolve;
                });
                return operation();
            });

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            let settled = false;
            const applied = manager.applyView(idleView).finally(() => {
                settled = true;
            });

            await drainMicrotasks();
            // The idle line has been generated by now; only the Discord write is still outstanding.
            expect(mockIdleGenerator.generate).toHaveBeenCalledWith({ prefix: '💤 • 1 🪾', compacting: false });
            expect(settled).toBe(false);

            releaseRetry();
            await applied;

            expect(settled).toBe(true);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: '💤 Dozing peacefully', type: ActivityType.Custom });
        });
    });
});
