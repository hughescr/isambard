/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import type { Client } from 'discord.js';
import { ActivityType } from 'discord.js';
import { createPresenceManager } from '@/integrations/discord/presence/manager';
import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';

describe('PresenceManager', () => {
    let mockClient: any;
    let mockActiveGenerator: any;
    let mockIdleGenerator: any;
    let mockLogger: any;
    let config: PresenceConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        // Set to 1000ms (not 0) to avoid rate limit check failing on first update
        // (lastUpdateTime initializes to 0, so Date.now() must be >= updateDebounceMs)
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
            warn:  mock(() => undefined),
            error: mock(() => undefined),
            info:  mock(() => undefined),
        };

        config = {
            updateDebounceMs:      10,
            idleTimeoutMs:         100,
            idleRefreshIntervalMs: 200,
        };
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    describe('updatePhase', () => {
        it('should update presence for thinking phase', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            // Wait for debounce
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase);
            expect(mockClient.user.setActivity).toHaveBeenCalled();
        });

        it('should debounce rapid updates', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            // Wait for debounce
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Should only update once (last update wins)
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
        });

        it('should start idle refresh when transitioning to idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // updatePhase now awaits the first idle refresh
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should have called idle generator
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
        });

        it('should stop idle refresh when transitioning from idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Wait and verify idle generator not called again
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallCount);
        });

        it('should handle Discord API errors gracefully', async () => {
            const errorClient = {
                user: {
                    setActivity: mock(() => {
                        throw new Error('Discord API error');
                    }),
                },
            } as unknown as Client;

            const manager = createPresenceManager({
                discordClient:         errorClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Should not throw (errors are caught internally)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            jest.advanceTimersByTime(20);
            await Promise.resolve();
            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should skip update if within debounce window', async () => {
            // Set very short debounce for testing
            const shortConfig = { ...config, updateDebounceMs: 50 };

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                shortConfig,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(60);
            await Promise.resolve();

            // First update should have gone through
            const firstCallCount = mockClient.user.setActivity.mock.calls.length;

            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            jest.advanceTimersByTime(30); // Before debounce expires
            await Promise.resolve();

            // Second update should be skipped (too soon)
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount);
        });
    });

    describe('rate limit boundary tests', () => {
        it('should skip update at exactly debounceMs milliseconds', async () => {
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(100); // Debounce completes
            await Promise.resolve();

            const firstCallCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCallCount).toBe(1);

            // Immediately try second update (0ms since first) - should skip due to rate limit
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            jest.advanceTimersByTime(100); // Debounce completes but rate limit kicks in

            // Allow any pending promises to resolve
            await Promise.resolve();
            await Promise.resolve();

            // The update should have been skipped due to rate limiting (timeSinceLastUpdate < debounceMs)
            // Since timeSinceLastUpdate was 0, it's less than 100ms
            expect(mockLogger.debug).toHaveBeenCalled();
        });

        it('should skip update at debounceMs - 1 milliseconds', async () => {
            // Use a longer debounce to make timing clearer
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First update - schedule debounced update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            // Complete first debounce + let applyPresenceUpdate run
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            // Now lastUpdateTime is set to the current fake time
            const firstCallCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCallCount).toBe(1);

            // Schedule second update immediately (0ms since last successful update)
            // This will schedule a debounced update for 100ms later
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            // Advance only 99ms - debounce fires at 100ms so this should not trigger yet
            jest.advanceTimersByTime(99);
            await Promise.resolve();

            // The debounce hasn't completed yet (need 100ms, only 99ms passed)
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount);
        });

        it('should allow update at debounceMs + 1 milliseconds', async () => {
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(100); // Debounce fires, applyPresenceUpdate runs
            await Promise.resolve();

            const firstCallCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCallCount).toBe(1);

            // Advance time past rate limit threshold (101ms since last update)
            jest.advanceTimersByTime(101);

            // Schedule second update
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            // Now advance time for the second debounce to fire
            // At this point, 201ms have passed since the first setActivity call
            // When applyPresenceUpdate runs, timeSinceLastUpdate will be ~201ms >= 100ms
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            // The rate limiter should allow this because timeSinceLastUpdate >= 100
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount + 1);
        });

        it('should update lastUpdateTime after successful update', async () => {
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(100); // Debounce fires
            await Promise.resolve();
            expect(mockClient.user.setActivity.mock.calls.length).toBe(1);

            // Wait past rate limit (100ms) before scheduling second update
            jest.advanceTimersByTime(101);

            // Second update - schedule it
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            // Advance for debounce to fire (total 201ms since first update, rate limit passes)
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(mockClient.user.setActivity.mock.calls.length).toBe(2);

            // Wait past rate limit again before scheduling third update
            jest.advanceTimersByTime(101);

            // Third update should also succeed (proving lastUpdateTime was updated after second)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(100);
            await Promise.resolve();

            expect(mockClient.user.setActivity.mock.calls.length).toBe(3);
        });
    });

    describe('state transition matrix', () => {
        it('should handle null→idle transition (first phase is idle)', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
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
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First phase is active - wasIdle should be false (currentPhase is null)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Should use active generator
            expect(mockActiveGenerator.generate).toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should handle idle→idle transition (no state change)', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const firstIdleCallCount = mockIdleGenerator.generate.mock.calls.length;
            const firstSetActivityCount = mockClient.user.setActivity.mock.calls.length;

            // Advance time past debounce
            jest.advanceTimersByTime(150);
            await Promise.resolve();

            // Go idle again - startIdleRefresh should be skipped (already running)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should not call generate again (no new start)
            // The idleRefreshInterval guard prevents duplicate starts
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(firstIdleCallCount);
            // setActivity should not have been called again either
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstSetActivityCount);
        });

        it('should handle active→active transition (debounced update)', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First active phase
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs); // Debounce fires
            await Promise.resolve();

            const firstCallCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCallCount).toBe(1);

            // Wait past rate limit before scheduling second update
            jest.advanceTimersByTime(config.updateDebounceMs + 1);

            // Second active phase (different type)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            // Advance for debounce to fire
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            // Should have updated again
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount + 1);
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should cancel pending debounce when transitioning to idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start an active phase (will schedule debounced update)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Before debounce completes, transition to idle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Wait past the original debounce time
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Should only have idle activity, not the pending active one
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            // Active generator was called but setActivity should only show idle status
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
        });
    });

    describe('timer guard verification', () => {
        it('should only start idle refresh once when transitioning to idle multiple times', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
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
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(firstIdleCount);
        });

        it('should properly stop idle refresh when transitioning from idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;

            // Transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Wait for what would be an idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();

            // Idle generator should not have been called again
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialIdleCount);
        });

        it('should handle stopIdleRefresh when interval is null (no error)', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Stop without ever starting idle - should not throw
            manager.stop();

            expect(mockLogger.info).toHaveBeenCalledWith('Stopping presence manager');
        });

        it('should run idle refresh on interval', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
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

            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialCount + 1);

            // Wait for another interval - third refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialCount + 2);
        });
    });

    describe('null/undefined handling', () => {
        it('should handle null user gracefully', async () => {
            const nullUserClient = {
                user: null,
            } as unknown as Client;

            const manager = createPresenceManager({
                discordClient:         nullUserClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Should not throw
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Should log info about update (even if setActivity wasn't called)
            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should handle undefined user gracefully', async () => {
            const undefinedUserClient = {
                user: undefined,
            } as unknown as Client;

            const manager = createPresenceManager({
                discordClient:         undefinedUserClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Should not throw
            await manager.updatePhase({ type: 'idle', since: new Date() });

            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should return early from refreshIdleStatus when no longer idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;

            // Transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Manually advance time to trigger what would be idle refresh
            // (but the interval should be cleared)
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();

            // Idle generator should not have been called again
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialIdleCount);
        });

        it('should not start idle refresh in start() when currentPhase is null', () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start without setting any phase
            manager.start();

            // Should not call idle generator since currentPhase is null
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should not start idle refresh in start() when currentPhase is active', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set active phase
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Call start
            manager.start();

            // Wait some time
            jest.advanceTimersByTime(500);
            await Promise.resolve();

            // Should not have called idle generator
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });

    describe('assignment mutations', () => {
        it('should properly track currentPhase for state transitions', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go active first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Go idle - this should trigger startIdleRefresh because wasIdle=false, nowIdle=true
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should have started idle refresh
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            // Now go active again - should trigger stopIdleRefresh because wasIdle=true, nowIdle=false
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            const idleCountAfterActive = mockIdleGenerator.generate.mock.calls.length;

            // Wait for what would be idle refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();

            // No new idle refreshes should have occurred
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCountAfterActive);
        });

        it('should clear pendingUpdate on stop()', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start an active phase to schedule debounced update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Stop before debounce completes
            manager.stop();

            // Wait past debounce time
            jest.advanceTimersByTime(config.updateDebounceMs + 10);
            await Promise.resolve();

            // setActivity should not have been called (pendingUpdate was cleared)
            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
        });

        it('should set pendingUpdate to null after debounced update executes', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs); // Debounce fires
            await Promise.resolve();

            // First update complete, pendingUpdate should be null now
            const firstCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCount).toBe(1);

            // Wait past rate limit before scheduling second update
            jest.advanceTimersByTime(config.updateDebounceMs + 1);

            // Second update should work (proving pendingUpdate was nulled)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            // Advance for debounce to fire
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCount + 1);
        });
    });

    describe('start', () => {
        it('should start idle refresh if currently idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });

            manager.start();

            expect(mockLogger.info).toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('should clear all timers', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle refresh
            await manager.updatePhase({ type: 'idle', since: new Date() });

            manager.stop();

            expect(mockLogger.info).toHaveBeenCalled();
        });

        it('should clear pending debounced update', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            manager.stop();

            // Wait past debounce time
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Update should not have happened (cleared by stop)
            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
        });
    });
});
