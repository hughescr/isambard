/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Test assertions use optional chaining on mock call args for defensive access */
import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { type Client, type ActivitiesOptions, ActivityType  } from 'discord.js';
import { mockWithDiscordRetry, originalWithDiscordRetry } from '../../../../setup';
import { PresenceManager, type PresenceManagerDeps  } from '@/integrations/discord/presence/manager';
import type { PresenceView } from '@/integrations/discord/presence/presence-view';
import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';

// Typed mock shapes that expose both real interface and bun mock methods
type MockWithCalls = ReturnType<typeof mock> & { mock: { calls: unknown[][] } };
interface MockedClient { user: { setActivity: MockWithCalls } }
interface MockedActiveGenerator { generate: MockWithCalls, formatStatus: MockWithCalls }
interface MockedIdleGenerator { generate: MockWithCalls }

describe('PresenceManager', () => {
    let mockClient: MockedClient;
    let mockActiveGenerator: MockedActiveGenerator;
    let mockIdleGenerator: MockedIdleGenerator;
    let mockLogger: PresenceManagerDeps['logger'];
    let config: PresenceConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        // Set to 1000ms (not 0) to avoid rate limit check failing on first update
        // (lastActiveUpdateTime initializes to 0, so Date.now() must be >= updateThrottleMs)
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
            formatStatus: mock((status: string) => ({
                name: status,
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
        jest.useRealTimers();
    });

    describe('updatePhase - immediate updates (no internal throttling)', () => {
        it('should update presence immediately for first active phase', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            // Should update immediately (leading-edge)
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase, 'none');
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
        });

        it('should apply all updates immediately (throttling handled upstream)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update - goes through
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Second update immediately after - also goes through (no throttle in PresenceManager)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            // No throttle skip should be logged (throttling is upstream)
            expect(mockLogger.debug).not.toHaveBeenCalledWith(
                expect.objectContaining({ throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
            );
        });

        it('should apply updates regardless of timing (no internal throttle)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Advance time (not needed anymore, but kept for test clarity)
            jest.advanceTimersByTime(101);

            // Second update - goes through (throttling is upstream)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
        });
    });

    describe('updatePhase - idle transitions', () => {
        it('should transition to idle immediately', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First active update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Immediately transition to idle - always applies
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Idle update should have happened
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
        });

        it('should start idle refresh loop when transitioning to idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should have called idle generator
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should stop idle refresh when transitioning from idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Advance past throttle so active update will apply
            jest.advanceTimersByTime(101);

            // Transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Wait for what would be an idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();

            // Idle generator should not have been called again
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
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { activity: { name: 'Same status', type: ActivityType.Custom } },
                'Presence unchanged, skipping update'
            );
        });

        it('applies again when the name differs', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // The default generator names the status after the phase, so these differ.
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
            expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.anything(), 'Presence unchanged, skipping update');
        });

        it('applies again when only the activity type differs', async () => {
            let type: ActivityType = ActivityType.Custom;
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type }));
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            type = ActivityType.Playing;
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
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
            const manager = new PresenceManager({
                discordClient:         flakyClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            expect(flakyClient.user.setActivity).toHaveBeenCalledTimes(2);
        });

        it('does not remember an activity Discord was never told about (client.user is null)', async () => {
            // `discordClient.user` is null until the gateway READY frame lands. The apply throws
            // nothing in that window — it simply has nobody to call — so it must not be recorded
            // as applied, or the first real apply after READY would be deduped into oblivion.
            const lateReadyClient: { user: MockedClient['user'] | null } = { user: null };
            mockActiveGenerator.generate = mock(() => ({ name: 'Same status', type: ActivityType.Custom }));
            const manager = new PresenceManager({
                discordClient:         lateReadyClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            lateReadyClient.user = mockClient.user;
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({ name: 'Same status', type: ActivityType.Custom });
        });

        it('does not log a successful apply when there was no user to apply it to', async () => {
            const lateReadyClient = { user: null };
            const manager = new PresenceManager({
                discordClient:         lateReadyClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(mockLogger.info).not.toHaveBeenCalledWith(expect.anything(), 'Updated Discord presence');
        });

        it('re-pushes the idle status on every refresh tick even when the text never changes', async () => {
            // The idle refresh loop doubles as a presence keep-alive: Discord drops a bot's
            // activity on a fresh IDENTIFY, and nothing re-applies presence on reconnect, so an
            // idle re-push must reach Discord even though the generated line is identical.
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(3);

            expect(mockLogger.debug).not.toHaveBeenCalledWith(expect.anything(), 'Presence unchanged, skipping update');
        });

        it('records the forced idle apply, so an identical active apply straight after is still deduped', async () => {
            mockActiveGenerator.generate = mock(() => ({ name: '💤 Dozing peacefully', type: ActivityType.Custom }));
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { activity: { name: '💤 Dozing peacefully', type: ActivityType.Custom } },
                'Presence unchanged, skipping update'
            );
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

            const manager = new PresenceManager({
                discordClient:         errorClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Should not throw (errors are caught internally)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should not retry setActivity for permanent (non-network) errors', async () => {
            // This test verifies that the retry configuration is properly integrated
            // by confirming that permanent errors (non-network/non-transient) result
            // in exactly 1 attempt with no retries.
            //
            // This indirectly validates that:
            // 1. The retry wrapper is being called with the correct config (maxAttempts: 2)
            // 2. The error classifier correctly identifies permanent vs. transient errors
            // 3. Permanent errors short-circuit the retry logic
            //
            // This test kills the mutant on lines 148-149:
            // { policy: { maxAttempts: 2 } }
            //
            // If the retry config were incorrectly set (maxAttempts: 1), transient errors
            // would not retry at all. If set to maxAttempts: 3, transient errors would
            // retry too many times. By verifying permanent errors result in exactly 1 call,
            // we confirm the retry wrapper is integrated correctly.

            let callCount = 0;
            const retryClient = {
                user: {
                    setActivity: mock(() => {
                        callCount++;
                        // Throw permanent error (not a network error code)
                        // This will NOT be retried regardless of maxAttempts
                        throw new Error('Invalid activity type');
                    }),
                },
            } as unknown as Client;

            const manager = new PresenceManager({
                discordClient:         retryClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Update phase - permanent error should NOT retry
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Should have been called exactly 1 time (no retries for permanent errors)
            expect(callCount).toBe(1);
            expect(retryClient.user!.setActivity).toHaveBeenCalledTimes(1);

            // Should have logged error
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), activity: expect.any(Object) }),
                'Failed to update Discord presence'
            );
        });

        it('should retry setActivity for transient (network) errors', async () => {
            // This test verifies that transient errors (network errors)
            // properly trigger retry logic according to the maxAttempts configuration.
            //
            // This validates that:
            // 1. The retry wrapper is called with maxAttempts: 2
            // 2. The error classifier correctly identifies transient errors (ECONNRESET, ETIMEDOUT, ECONNREFUSED)
            // 3. Transient errors trigger exactly 1 retry (2 total attempts)

            // Restore original retry implementation but inject instant sleep for fast test execution
            mockWithDiscordRetry.mockImplementation(async <T>(
                operation: () => Promise<T>,
                _options?: unknown
            ): Promise<T> => {
                // Call real implementation but inject instant sleep

                const options = _options as Record<string, unknown> & { deps?: Record<string, unknown> };
                return originalWithDiscordRetry(operation, {
                    ...options,
                    deps: {
                        ...options?.deps,
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
                        // Throw network error (ECONNRESET is a transient error code)
                        // This will be retried according to maxAttempts config
                        throw networkError;
                    }),
                },
            } as unknown as Client;

            const manager = new PresenceManager({
                discordClient:         retryClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Update phase - transient error should retry
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Restore mock behavior for other tests
            mockWithDiscordRetry.mockReset();
            mockWithDiscordRetry.mockImplementation(async <T>(operation: () => Promise<T>) => operation());

            // Should have been called exactly 2 times (1 initial + 1 retry)
            expect(callCount).toBe(2);
            expect(retryClient.user!.setActivity).toHaveBeenCalledTimes(2);

            // Should have logged error
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), activity: expect.any(Object) }),
                'Failed to update Discord presence'
            );
        });
    });

    describe('immediate updates - no internal throttle boundaries', () => {
        it('should apply all updates immediately (throttling moved to BotStateManager)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update (at t=1000 from beforeEach)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Advance system time to just before old throttle would expire
            jest.setSystemTime(1099); // 1000 + 99 = 1099

            // Second update - goes through immediately (no throttle in PresenceManager)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            // No throttle skip should be logged
            expect(mockLogger.debug).not.toHaveBeenCalledWith(
                expect.objectContaining({ throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
            );
        });

        it('should allow immediate consecutive updates (no internal throttle)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // At t=1000, first update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Immediately (no time advance) try second update - goes through
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            // Both updates should have been applied
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            // No throttle logging (throttling is upstream in BotStateManager)
            expect(mockLogger.debug).not.toHaveBeenCalledWith(
                expect.objectContaining({ timeSinceLastUpdate: expect.anything(), throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
            );
        });
    });

    describe('state transition matrix', () => {
        it('should handle null→idle transition (first phase is idle)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First phase is idle - wasIdle should be false (currentPhase is null)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should start idle refresh
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should handle null→active transition (first phase is active)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First phase is active - should update immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Should use active generator
            expect(mockActiveGenerator.generate).toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
        });

        it('should handle idle→idle transition (no state change)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCallCount = mockIdleGenerator.generate.mock.calls.length;
            const firstSetActivityCount = mockClient.user.setActivity.mock.calls.length;

            // Advance time
            jest.advanceTimersByTime(150);
            await Promise.resolve();

            // Go idle again - startIdleRefresh should be skipped (already running)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not call generate again (no new start)
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(firstIdleCallCount);
            expect(mockClient.user.setActivity.mock.calls).toHaveLength(firstSetActivityCount);
        });

        it('should handle active→active transition with throttle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First active phase - updates immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Wait past throttle cooldown
            jest.advanceTimersByTime(101);

            // Second active phase - should go through
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });

    describe('timer guard verification', () => {
        it('should only start idle refresh once when transitioning to idle multiple times', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First idle transition
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCount = mockIdleGenerator.generate.mock.calls.length;

            // Try to go idle again (should be no-op due to idleRefreshInterval guard)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not have called generate again
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(firstIdleCount);
        });

        it('should properly stop idle refresh when transitioning from idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;

            // Advance past throttle so active update applies
            jest.advanceTimersByTime(101);

            // Transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Wait for what would be an idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();

            // Idle generator should not have been called again
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(initialIdleCount);
        });

        it('should handle stop when interval is null (no error)', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Stop without ever starting idle - should not throw
            manager.stop();

            // Verify clearInterval was NOT called (no interval existed to clear)
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            // Also verify no idle refresh occurred
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should run idle refresh on interval', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle - first refresh happens immediately
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialCount = mockIdleGenerator.generate.mock.calls.length;
            expect(initialCount).toBe(1);

            // Wait for one interval - second refresh should happen
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve(); // Extra tick for async

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(initialCount + 1);

            // Wait for another interval - third refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(initialCount + 2);
        });
    });

    describe('assignment mutations', () => {
        it('should properly track currentPhase for state transitions', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go active first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Advance past throttle
            jest.advanceTimersByTime(101);

            // Go idle - this should trigger startIdleRefresh because wasIdle=false, nowIdle=true
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should have started idle refresh
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            // Advance past throttle
            jest.advanceTimersByTime(101);

            // Now go active again - should trigger stopIdleRefresh because wasIdle=true, nowIdle=false
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            const idleCountAfterActive = mockIdleGenerator.generate.mock.calls.length;

            // Wait for what would be idle refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();

            // No new idle refreshes should have occurred
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCountAfterActive);
        });
    });

    describe('idle→idle duplicate transition', () => {
        it('should skip idle refresh when already idle and updatePhase(idle) called again', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First idle transition
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Second idle transition (duplicate) - should be skipped
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not have triggered another idle refresh
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(firstIdleCallCount);

            // Verify log message
            expect(mockLogger.debug).toHaveBeenCalledWith('Already idle, skipping duplicate idle transition');
        });
    });

    describe('transitionPresenceDisplayMode state transitions', () => {
        it('should handle transition from none to processing_message mode with active phase', async () => {
            // The real generator prefixes the status with the mode's emoji (getPresencePrefix in
            // status-generator-active.ts), so the re-render produces DIFFERENT text — model that
            // here, otherwise the manager's identical-activity dedupe (correctly) skips it.
            mockActiveGenerator.generate = mock((phase: PresencePhase, mode: string) => ({
                name: `Status for ${phase.type} (${mode})`,
                type: ActivityType.Custom,
            }));
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            const initialCallCount = mockClient.user.setActivity.mock.calls.length;

            // Transition to processing_message mode
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();

            // Should update status with new mode
            expect(mockClient.user.setActivity.mock.calls).toHaveLength(initialCallCount + 1);
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'responding' }),
                'processing_message'
            );
        });

        it('should NOT generate status when transitioning modes without a current phase', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // At startup (null currentPhase), transition to processing_message
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have generated any status — there is no phase to re-render with a prefix
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
        });

        it('should NOT generate active status when transitioning to none mode (the subsequent updatePhase(idle) handles it)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase in processing_message mode
            manager.transitionPresenceDisplayMode('processing_message');
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Clear mock calls to track only the transition
            mockActiveGenerator.generate.mockClear();
            mockClient.user.setActivity.mockClear();

            // Transition to 'none' mode
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();

            // Should NOT have called activeStatusGenerator.generate (mode === 'none' is skipped)
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
        });

        it('should NOT generate active status when transitioning to a non-none mode while currently idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first.
            await manager.updatePhase({ type: 'idle', since: new Date() });
            mockActiveGenerator.generate.mockClear();

            // Transition to a non-'none' mode while still idle: `currentPhase` is truthy AND
            // `mode !== 'none'`, so only the `currentPhase.type !== 'idle'` conjunct prevents
            // an (incorrect) active-status render over an idle phase.
            manager.transitionPresenceDisplayMode('perching');
            await Promise.resolve();

            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
        });

        it('should handle mode transition logging', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Transition modes
            manager.transitionPresenceDisplayMode('perching');
            await Promise.resolve();

            // Should log mode transition
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { mode: 'perching', previousMode: 'none' },
                'Setting presence display mode'
            );
        });

        it('should NOT refresh idle status when transitioning to none, regardless of the previous mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in perching mode
            manager.transitionPresenceDisplayMode('perching');

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to 'none' from perching — no catch-up bridge exists any more to trigger
            // an immediate refresh, so this is purely a no-op mode change.
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCountBefore);
        });

        it('should NOT refresh idle status when transitioning from processing_message to none (mode is not none is a no-op path either way)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in processing_message mode
            manager.transitionPresenceDisplayMode('processing_message');

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to processing_message again (NOT 'none')
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT trigger refreshIdleStatus (mode is not 'none')
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCountBefore);
        });
    });

    describe('idle refresh stops on active mode entry via transitionPresenceDisplayMode', () => {
        it('should stop idle refresh when entering perching mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle — starts idle refresh loop
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Enter perching mode — should stop idle refresh
            manager.transitionPresenceDisplayMode('perching');

            // Advance past idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            await Promise.resolve();

            // No new idle refreshes should have occurred
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCount);
        });

        it('should stop idle refresh when entering processing_message mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle — starts idle refresh loop
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Enter processing_message mode — should stop idle refresh
            manager.transitionPresenceDisplayMode('processing_message');

            // Advance past idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            await Promise.resolve();

            // No new idle refreshes should have occurred
            expect(mockIdleGenerator.generate.mock.calls).toHaveLength(idleCallCount);
        });

        it('should not error when entering perching mode without prior idle refresh', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go active first (no idle refresh running)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Enter perching mode — stopIdleRefresh is idempotent, should not error
            manager.transitionPresenceDisplayMode('perching');

            // No errors should have been logged
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should NOT stop idle refresh when transitioning to none mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle — starts idle refresh loop
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Transition to 'none' — should NOT stop idle refresh (it's the idle mode)
            manager.transitionPresenceDisplayMode('none');

            // Advance past idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            await Promise.resolve();

            // Idle refresh should have fired again (loop still running)
            expect(mockIdleGenerator.generate.mock.calls.length).toBeGreaterThan(idleCallCount);
        });
    });

    describe('applyView (P11)', () => {
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

            // activeStatusGenerator.generate is called with the phase only (no display mode / no emoji prefix)
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(activeView.phase);
            expect(mockClient.user.setActivity).toHaveBeenCalledWith({
                name: '💬 • 1 🪾 • Status for thinking',
                type: ActivityType.Custom,
            });

            // Idle refresh loop was stopped: advancing time triggers no further idle generation
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

        it('without recomposeIdlePrefix, periodic idle refresh keeps rendering the last composed prefix (legacy behaviour unchanged)', async () => {
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
});
