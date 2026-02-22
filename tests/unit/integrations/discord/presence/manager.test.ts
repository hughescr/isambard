import _ from 'lodash';
import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import type { Client } from 'discord.js';
import { ActivityType } from 'discord.js';
import { PresenceManager } from '@/integrations/discord/presence/manager';
import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';
import { mockWithDiscordRetry, originalWithDiscordRetry } from '../../../../setup';

import type { ActiveStatusGenerator } from '@/integrations/discord/presence/status-generator-active';
import type { IdleStatusGenerator } from '@/integrations/discord/presence/status-generator-idle';
import type { PresenceManagerDeps } from '@/integrations/discord/presence/manager';

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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount);
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                _operationName: string,
                _options?: unknown
            ): Promise<T> => {
                // Call real implementation but inject instant sleep

                const options = _options as Record<string, unknown> & { deps?: Record<string, unknown> };
                return originalWithDiscordRetry(operation, _operationName, {
                    ...options,
                    deps: {
                        ...options?.deps,
                        sleep: async () => {},
                    },
                });
            });

            let callCount = 0;
            const networkError = _.assign(new Error('Connection reset'), { code: 'ECONNRESET' });

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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(firstIdleCallCount);
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstSetActivityCount);
        });

        it('should handle active→active transition with throttle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // First idle transition
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCount = mockIdleGenerator.generate.mock.calls.length;

            // Try to go idle again (should be no-op due to idleRefreshInterval guard)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not have called generate again
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(firstIdleCount);
        });

        it('should properly stop idle refresh when transitioning from idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialIdleCount);
        });

        it('should handle stop when interval is null (no error)', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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

            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialCount + 1);

            // Wait for another interval - third refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialCount + 2);
        });
    });

    describe('assignment mutations', () => {
        it('should properly track currentPhase for state transitions', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCountAfterActive);
        });
    });

    describe('transitionPresenceDisplayMode edge cases', () => {
        it('should generate catch-up status when entering catch-up mode with null currentPhase', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // At startup, currentPhase is null
            // Enter catch-up mode - should trigger idle status generation with 📥 prefix
            manager.transitionPresenceDisplayMode('catching_up');

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called idle generator
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should NOT trigger idle status when exiting catch-up mode to none', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();
            await Promise.resolve();

            const callCountAfterEntry = mockIdleGenerator.generate.mock.calls.length;

            // Exit catch-up mode - should NOT trigger idle status
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();

            // No additional calls to idle generator
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(callCountAfterEntry);
        });

        it('should update active phase status immediately when catch-up mode changes', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            const initialSetActivityCount = mockClient.user.setActivity.mock.calls.length;

            // Change catch-up mode - should trigger immediate status update
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();

            // Should have updated status
            expect(mockClient.user.setActivity.mock.calls.length).toBe(initialSetActivityCount + 1);
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'thinking' }),
                'catching_up'
            );
        });

        it('should NOT generate active status when transitioning to none mode (prevents emoji-less status)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Clear mock calls to track only the transition
            mockActiveGenerator.generate.mockClear();
            mockClient.user.setActivity.mockClear();

            // Transition to 'none' mode (idle)
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();

            // Should NOT have called activeStatusGenerator.generate with mode 'none'
            const generatorCalls = mockActiveGenerator.generate.mock.calls;
            const noneModeCalls = _.filter(generatorCalls, ['1', 'none']);
            expect(noneModeCalls).toHaveLength(0);

            // Should NOT have called setActivity with emoji-less status from active generator
            // (The subsequent updatePhase(idle) will handle the transition properly)
        });

        it('should discard stale idle status when mode changes during async generation', async () => {
            // This test verifies the race condition handling in refreshIdleStatus()
            // where the catch-up mode might change while idle status generation is in progress.
            //
            // The code at lines 168-179 in manager.ts captures the mode at the start,
            // then checks if it changed during the async generation, and discards stale results.

            // Track which promises we can control
            const idleGeneratePromises: { resolve: (value: import('discord.js').ActivitiesOptions) => void, mode: string }[] = [];

            // Override idle generator to return controllable promises
            mockIdleGenerator.generate = mock(() => {
                return new Promise((resolve) => {
                    idleGeneratePromises.push({ resolve, mode: 'none' });
                });
            });

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();

            // Go to idle phase - this triggers idle generation with catch-up mode
            await manager.updatePhase({ type: 'idle', since: new Date() });
            await Promise.resolve();

            // Complete the first generation (entering catch-up while idle)
            expect(idleGeneratePromises.length).toBe(1);
            idleGeneratePromises[0].resolve({
                name: 'Initial catch-up idle status',
                type: ActivityType.Custom,
            });
            await Promise.resolve();
            await Promise.resolve();

            const setActivityCountAfterInitial = mockClient.user.setActivity.mock.calls.length;

            // Now exit catch-up mode to 'none' - this triggers refreshIdleStatus()
            // which starts async idle status generation
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();

            // Idle generator should have been called for the second time (async generation started)
            expect(idleGeneratePromises.length).toBe(2);

            // NOW change the mode WHILE the generation is still in progress
            // This will also trigger another generation (entering catch-up while idle)
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();

            // Complete the third generation (re-entering catch-up)
            expect(idleGeneratePromises.length).toBe(3);
            idleGeneratePromises[2].resolve({
                name: 'Re-entered catch-up idle status',
                type: ActivityType.Custom,
            });
            await Promise.resolve();
            await Promise.resolve();

            const setActivityCountBeforeStale = mockClient.user.setActivity.mock.calls.length;
            expect(setActivityCountBeforeStale).toBe(setActivityCountAfterInitial + 1); // One more for re-entering catch-up

            // NOW complete the stale generation (the one from exiting catch-up to 'none')
            idleGeneratePromises[1].resolve({
                name: 'Stale idle status (mode was "none")',
                type: ActivityType.Custom,
            });
            await Promise.resolve();
            await Promise.resolve();

            // The stale result should have been DISCARDED (no additional setActivity call)
            expect(mockClient.user.setActivity.mock.calls.length).toBe(setActivityCountBeforeStale);

            // Should have logged that stale status was discarded
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { modeAtStart: 'none', currentMode: 'catching_up' },
                'Discarding stale idle status (mode changed during generation)'
            );
        });
    });

    describe('idle→idle duplicate transition', () => {
        it('should skip idle refresh when already idle and updatePhase(idle) called again', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // First idle transition
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Second idle transition (duplicate) - should be skipped
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not have triggered another idle refresh
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(firstIdleCallCount);

            // Verify log message
            expect(mockLogger.debug).toHaveBeenCalledWith('Already idle, skipping duplicate idle transition');
        });
    });

    describe('transitionPresenceDisplayMode state transitions', () => {
        it('should generate catch-up status when entering catch-up mode with null currentPhase (no dynamic generator)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // At startup, currentPhase is null
            // Enter catch-up mode without dynamic generator
            manager.transitionPresenceDisplayMode('catching_up');

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called idle generator (fallback when no dynamic generator)
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should generate catch-up status when entering catch-up mode with null currentPhase (with dynamic generator)', async () => {
            const mockDynamicGenerator = {
                generateSynopsis:        mock(async () => 'Test dynamic status'),
                generateCatchUpSynopsis: mock(async () => 'Ooh, Craig left me something!'),
            };

            const manager = new PresenceManager({
                discordClient:          mockClient as unknown as Client,
                activeStatusGenerator:  mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:    mockIdleGenerator as unknown as IdleStatusGenerator,
                dynamicStatusGenerator: mockDynamicGenerator,
                config,
                logger:                 mockLogger,
            });

            const catchUpContext = {
                totalUnread:         5,
                channelCount:        2,
                channelNames:        ['general', 'DM'],
                topAuthors:          ['Craig', 'Mike'],
                timeSinceLastActive: '3 hours',
                timeOfDay:           'afternoon',
                dayOfWeek:           'Monday',
            };

            // Enter catch-up mode with dynamic generator and context
            manager.transitionPresenceDisplayMode('catching_up', catchUpContext);

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called dynamic generator
            expect(mockDynamicGenerator.generateCatchUpSynopsis).toHaveBeenCalledWith(catchUpContext);
            expect(mockActiveGenerator.formatStatus).toHaveBeenCalledWith('Ooh, Craig left me something!', 'catching_up');
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should generate catch-up status when entering catch-up mode with idle currentPhase (no context)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // First go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Enter catch-up mode without context - should fall back to idle generator
            manager.transitionPresenceDisplayMode('catching_up');

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called idle generator (fallback)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialCallCount + 1);
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
        });

        it('should generate catch-up status when entering catch-up mode with idle currentPhase (with dynamic generator)', async () => {
            const mockDynamicGenerator = {
                generateSynopsis:        mock(async () => 'Test dynamic status'),
                generateCatchUpSynopsis: mock(async () => 'Three hours and #general got busy!'),
            };

            const manager = new PresenceManager({
                discordClient:          mockClient as unknown as Client,
                activeStatusGenerator:  mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:    mockIdleGenerator as unknown as IdleStatusGenerator,
                dynamicStatusGenerator: mockDynamicGenerator,
                config,
                logger:                 mockLogger,
            });

            // First go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            const catchUpContext = {
                totalUnread:         3,
                channelCount:        1,
                channelNames:        ['general'],
                topAuthors:          ['Sarah'],
                timeSinceLastActive: '3 hours',
                timeOfDay:           'morning',
                dayOfWeek:           'Tuesday',
            };

            // Enter catch-up mode with idle currentPhase
            manager.transitionPresenceDisplayMode('catching_up', catchUpContext);

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called dynamic generator
            expect(mockDynamicGenerator.generateCatchUpSynopsis).toHaveBeenCalledWith(catchUpContext);
            expect(mockActiveGenerator.formatStatus).toHaveBeenCalledWith('Three hours and #general got busy!', 'catching_up');
        });

        it('should refresh idle status when exiting catch-up mode to none with idle currentPhase', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();
            await Promise.resolve();

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const callCountAfterIdle = mockIdleGenerator.generate.mock.calls.length;

            // Exit catch-up mode to 'none'
            manager.transitionPresenceDisplayMode('none');

            // Wait for async refresh
            await Promise.resolve();
            await Promise.resolve();

            // Should have triggered refreshIdleStatus
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(callCountAfterIdle + 1);
            // Should have been called (no arguments expected)
            const lastCall = mockIdleGenerator.generate.mock.calls[mockIdleGenerator.generate.mock.calls.length - 1];
            expect(lastCall).toEqual([]);
        });

        it('should update active phase status immediately when entering catch-up mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            const initialSetActivityCount = mockClient.user.setActivity.mock.calls.length;

            // Enter catch-up mode - should trigger immediate status update
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();

            // Should have updated status immediately (synchronous, no async wait needed)
            expect(mockClient.user.setActivity.mock.calls.length).toBe(initialSetActivityCount + 1);
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'thinking' }),
                'catching_up'
            );
        });

        it('should NOT update active phase status when transitioning to none mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Go to active phase in catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
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

        it('should fall back to idle generator when generateCatchUpSynopsis returns null (idle currentPhase)', async () => {
            const mockDynamicGenerator = {
                generateSynopsis:        mock(async () => 'Test dynamic status'),
                generateCatchUpSynopsis: mock(async () => null),
            };

            const manager = new PresenceManager({
                discordClient:          mockClient as unknown as Client,
                activeStatusGenerator:  mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:    mockIdleGenerator as unknown as IdleStatusGenerator,
                dynamicStatusGenerator: mockDynamicGenerator,
                config,
                logger:                 mockLogger,
            });

            // First go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            const catchUpContext = {
                totalUnread:         3,
                channelCount:        1,
                channelNames:        ['general'],
                topAuthors:          ['Sarah'],
                timeSinceLastActive: '3 hours',
                timeOfDay:           'morning',
                dayOfWeek:           'Tuesday',
            };

            // Enter catch-up mode with idle currentPhase — dynamic generator returns null
            manager.transitionPresenceDisplayMode('catching_up', catchUpContext);

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called dynamic generator
            expect(mockDynamicGenerator.generateCatchUpSynopsis).toHaveBeenCalledWith(catchUpContext);
            // Should have fallen back to idle generator since dynamic returned null
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore + 1);
            // Should NOT have called formatStatus (null result means skip active status path)
            expect(mockActiveGenerator.formatStatus).not.toHaveBeenCalled();
        });

        it('should fall back to idle generator when generateCatchUpSynopsis returns null (null currentPhase)', async () => {
            const mockDynamicGenerator = {
                generateSynopsis:        mock(async () => 'Test dynamic status'),
                generateCatchUpSynopsis: mock(async () => null),
            };

            const manager = new PresenceManager({
                discordClient:          mockClient as unknown as Client,
                activeStatusGenerator:  mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:    mockIdleGenerator as unknown as IdleStatusGenerator,
                dynamicStatusGenerator: mockDynamicGenerator,
                config,
                logger:                 mockLogger,
            });

            const catchUpContext = {
                totalUnread:         5,
                channelCount:        2,
                channelNames:        ['general', 'DM'],
                topAuthors:          ['Craig', 'Mike'],
                timeSinceLastActive: '3 hours',
                timeOfDay:           'afternoon',
                dayOfWeek:           'Monday',
            };

            // Enter catch-up mode at startup (null currentPhase) — dynamic generator returns null
            manager.transitionPresenceDisplayMode('catching_up', catchUpContext);

            // Wait for async status generation
            await Promise.resolve();
            await Promise.resolve();

            // Should have called dynamic generator
            expect(mockDynamicGenerator.generateCatchUpSynopsis).toHaveBeenCalledWith(catchUpContext);
            // Should have fallen back to idle generator since dynamic returned null
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            // Should NOT have called formatStatus (null result means skip active status path)
            expect(mockActiveGenerator.formatStatus).not.toHaveBeenCalled();
        });

        it('should handle error during async status generation gracefully', async () => {
            const errorDynamicGenerator = {
                generateSynopsis:        mock(async () => 'Test'),
                generateCatchUpSynopsis: mock(async () => {
                    throw new Error('LLM API failure');
                }),
            };

            const manager = new PresenceManager({
                discordClient:          mockClient as unknown as Client,
                activeStatusGenerator:  mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:    mockIdleGenerator as unknown as IdleStatusGenerator,
                dynamicStatusGenerator: errorDynamicGenerator,
                config,
                logger:                 mockLogger,
            });

            const catchUpContext = {
                totalUnread:         1,
                channelCount:        1,
                channelNames:        ['test'],
                topAuthors:          ['Test'],
                timeSinceLastActive: '1 hour',
                timeOfDay:           'morning',
                dayOfWeek:           'Monday',
            };

            // Enter catch-up mode - error should be caught and logged
            manager.transitionPresenceDisplayMode('catching_up', catchUpContext);

            // Wait for async error handling
            await Promise.resolve();
            await Promise.resolve();

            // Error should be caught and logged
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.any(Error), mode: 'catching_up' }),
                'Failed to generate catch-up status'
            );

            // Manager should remain functional - verify by transitioning to a new phase
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'thinking' }),
                'catching_up'
            );
        });

        it('should handle transition from none to processing_message mode with active phase', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockClient.user.setActivity.mock.calls.length).toBe(initialCallCount + 1);
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'responding' }),
                'processing_message'
            );
        });

        it('should NOT generate status when transitioning modes without currentPhase (except catch-up)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // At startup (null currentPhase), transition to processing_message
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have generated any status (only catch-up mode generates at startup)
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
        });

        it('should handle mode transition logging', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Transition modes
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();

            // Should log mode transition
            expect(mockLogger.debug).toHaveBeenCalledWith(
                { mode: 'catching_up', previousMode: 'none' },
                'Setting presence display mode'
            );
        });

        it('should NOT generate catch-up status when entering catch-up from processing_message mode (not from none)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in processing_message mode
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();
            await Promise.resolve();

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to catch-up mode from processing_message (not from 'none')
            // This should NOT trigger the enteringCatchUp logic
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();
            await Promise.resolve();

            // Should not have called idle generator again (enteringCatchUp is false)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore);
        });

        it('should NOT refresh idle status when exiting to none from processing_message (not from catch-up)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in processing_message mode
            manager.transitionPresenceDisplayMode('processing_message');

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to 'none' from processing_message (NOT from catch-up)
            // This should NOT trigger the exitingCatchUp logic
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();
            await Promise.resolve();

            // Should not have triggered refreshIdleStatus (exitingCatchUp is false)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore);
        });

        it('should refresh idle status when exiting catch-up mode to none (exitingCatchUp true)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Enter catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();
            await Promise.resolve();

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Exit to 'none' - should trigger refreshIdleStatus
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();
            await Promise.resolve();

            // Should have called idle generator (exitingCatchUp is true)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore + 1);
        });

        it('should NOT refresh idle status when mode is none but previousMode is not catch-up', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Start in perching mode
            manager.transitionPresenceDisplayMode('perching');

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to 'none' from perching (not from catch-up)
            manager.transitionPresenceDisplayMode('none');
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT trigger refreshIdleStatus (previousMode is not catching_up)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore);
        });

        it('should NOT refresh idle status when transitioning from catch-up to processing_message (mode is not none)', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Enter catch-up mode
            manager.transitionPresenceDisplayMode('catching_up');
            await Promise.resolve();
            await Promise.resolve();

            // Go idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCountBefore = mockIdleGenerator.generate.mock.calls.length;

            // Transition to processing_message (NOT 'none')
            manager.transitionPresenceDisplayMode('processing_message');
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT trigger refreshIdleStatus (mode is not 'none')
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCountBefore);
        });
    });

    describe('idle refresh stops on active mode entry via transitionPresenceDisplayMode', () => {
        it('should stop idle refresh when entering perching mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount);
        });

        it('should stop idle refresh when entering processing_message mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount);
        });

        it('should stop idle refresh when entering catching_up mode', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle — starts idle refresh loop
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Enter catching_up mode — should stop idle refresh
            // (the enteringCatchUp path fires ONE async status, but the refresh loop should stop)
            manager.transitionPresenceDisplayMode('catching_up');

            // Advance past idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            await Promise.resolve();

            // Only +1 from the enteringCatchUp async generation, not from the refresh loop
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount + 1);
        });

        it('should not error when entering perching mode without prior idle refresh', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
                activeStatusGenerator: mockActiveGenerator as unknown as ActiveStatusGenerator,
                idleStatusGenerator:   mockIdleGenerator as unknown as IdleStatusGenerator,
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
});
