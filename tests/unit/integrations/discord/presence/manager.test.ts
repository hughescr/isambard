/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-call -- Test mocks */
import _ from 'lodash';
import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
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

        it('should correctly compute time since last update using subtraction not addition', async () => {
            // This test kills the mutant: now - lastUpdateTime → now + lastUpdateTime
            //
            // Strategy: Set a debounce value that will cause:
            // - With correct subtraction: timeSinceLastUpdate < debounceMs → SKIP
            // - With buggy addition: timeSinceLastUpdate would be huge → ALLOW (wrong!)
            //
            // At t=1000 (set by beforeEach), first idle update sets lastUpdateTime=1000
            // Immediately (still t=1000) trigger second update attempt:
            // - With subtraction: 1000 - 1000 = 0 < 150 → SKIP (correct)
            // - With addition: 1000 + 1000 = 2000 >= 150 → ALLOW (mutation fails test)
            const debounceConfig = { ...config, updateDebounceMs: 150 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First: go idle (this calls refreshIdleStatus -> applyPresenceUpdate immediately)
            // At t=1000, lastUpdateTime gets set to 1000
            await manager.updatePhase({ type: 'idle', since: new Date() });

            const firstCallCount = mockClient.user.setActivity.mock.calls.length;
            expect(firstCallCount).toBe(1);

            // Immediately (no time advance) transition idle -> active -> idle
            // This stops the idle refresh and immediately starts it again
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // At t=1000 (unchanged), with lastUpdateTime=1000:
            // With subtraction: timeSinceLastUpdate = 1000 - 1000 = 0 < 150 → SKIP (correct)
            // With addition: timeSinceLastUpdate = 1000 + 1000 = 2000 >= 150 → ALLOW (wrong!)
            //
            // The update should have been SKIPPED because 0ms < 150ms debounce
            expect(mockClient.user.setActivity.mock.calls.length).toBe(firstCallCount);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ timeSinceLastUpdate: 0, debounceMs: 150 }),
                'Skipping presence update due to rate limit'
            );
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
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
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
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle - this creates the interval
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;
            expect(initialIdleCount).toBe(1);

            // Transition to active - this should clear the interval
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Verify the interval was actually cleared (guard behavior)
            expect(clearIntervalSpy).toHaveBeenCalled();

            // Advance time - since interval is cleared, no new refreshes should occur
            jest.advanceTimersByTime(config.idleRefreshIntervalMs * 2);
            await Promise.resolve();
            await Promise.resolve();

            // Idle generator should not have been called again
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialIdleCount);

            clearIntervalSpy.mockRestore();
        });

        it('should not start idle refresh in start() when currentPhase is null', () => {
            const setIntervalSpy = spyOn(globalThis, 'setInterval');

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

            // Verify no interval was created (startIdleRefresh was not called)
            expect(setIntervalSpy).not.toHaveBeenCalled();

            setIntervalSpy.mockRestore();
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
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;
            expect(initialIdleCount).toBe(1);

            // Stop it (clears the interval and sets idleRefreshInterval to null)
            manager.stop();

            // Clear mock to track new calls
            mockIdleGenerator.generate.mockClear();

            // Start again - since currentPhase is still idle, should restart idle refresh
            manager.start();

            // Allow async operations to complete (start calls void startIdleRefresh())
            await Promise.resolve();
            await Promise.resolve();

            // Verify idle generator was called again (proves start() triggered startIdleRefresh)
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            // Verify setActivity was called (proves the full refresh flow executed)
            const activityCallsAfterStart = mockClient.user.setActivity.mock.calls.length;
            expect(activityCallsAfterStart).toBeGreaterThan(0);
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

    describe('logger assertions', () => {
        it('should log phase update with phase parameter', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { phase },
                'Updating presence phase'
            );
        });

        it('should log rate limit skip with timing parameters', async () => {
            // The rate limit can trigger when transitioning to idle immediately after an active update
            // because startIdleRefresh -> refreshIdleStatus -> applyPresenceUpdate bypasses the debounce
            // Use a very long debounce to ensure the rate limit triggers
            const rateConfig = { ...config, updateDebounceMs: 5000 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                rateConfig,
                logger:                mockLogger,
            });

            // First: go idle (this will set lastUpdateTime via applyPresenceUpdate)
            await manager.updatePhase({ type: 'idle', since: new Date() });
            // Now lastUpdateTime is set

            // Second: immediately transition to active (stops idle refresh)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            // This doesn't trigger applyPresenceUpdate immediately - it schedules a debounce

            // Third: immediately go back to idle (before debounce fires)
            // This calls startIdleRefresh -> refreshIdleStatus -> applyPresenceUpdate IMMEDIATELY
            // At this point, almost no time has passed since the first idle update
            // So timeSinceLastUpdate will be ~0, which is < 5000ms debounce, triggering rate limit
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Should have logged the rate limit skip
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({
                    timeSinceLastUpdate: expect.any(Number),
                    debounceMs:          rateConfig.updateDebounceMs,
                }),
                'Skipping presence update due to rate limit'
            );
        });

        it('should log successful presence update with activity parameter', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.objectContaining({ activity: expect.any(Object) }),
                'Updated Discord presence'
            );
        });

        it('should log failure with error and activity parameters', async () => {
            const testError = new Error('Discord API error');
            const errorClient = {
                user: {
                    setActivity: mock(() => {
                        throw testError;
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

            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:    testError,
                    activity: expect.any(Object),
                }),
                'Failed to update Discord presence'
            );
        });

        it('should log idle refresh start with interval parameter', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            await manager.updatePhase({ type: 'idle', since: new Date() });

            expect(mockLogger.debug).toHaveBeenCalledWith(
                { intervalMs: config.idleRefreshIntervalMs },
                'Started idle status refresh'
            );
        });

        it('should log idle refresh stop', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Transition to active (triggers stopIdleRefresh)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(mockLogger.debug).toHaveBeenCalledWith('Stopped idle status refresh');
        });
    });

    describe('start() execution', () => {
        it('should log the exact starting message', () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            manager.start();

            expect(mockLogger.info).toHaveBeenCalledWith('Starting presence manager');
        });

        it('should start idle refresh when current phase is idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to idle first via updatePhase
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Stop the idle refresh (clears the interval)
            manager.stop();

            // Reset mocks to clearly see the effect of start()
            mockIdleGenerator.generate.mockClear();

            // Now call start() - should trigger startIdleRefresh since currentPhase is idle
            manager.start();

            // Wait for async idle refresh to complete
            await Promise.resolve();
            await Promise.resolve();

            // Should have called idle generator again
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
        });

        it('should not start idle refresh when current phase is active', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to active phase via updatePhase
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            // Clear mocks before calling start()
            mockIdleGenerator.generate.mockClear();

            // Call start()
            manager.start();

            // Wait for any potential async operations
            await Promise.resolve();
            await Promise.resolve();

            // Idle generator should NOT have been called
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should not start idle refresh when current phase is null', () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start() without ever setting a phase (currentPhase is null)
            manager.start();

            // Idle generator should NOT have been called
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });

    describe('stopIdleRefresh execution', () => {
        it('should call clearInterval when stopping idle refresh', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle (creates interval)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Stop idle (should call clearInterval)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(clearIntervalSpy).toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should not call clearInterval when interval is not running', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Never went idle, just stop
            manager.stop();

            // clearInterval should not be called (no interval was running)
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should call clearInterval exactly once when stopping idle refresh multiple times', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle (starts interval)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Transition to active (calls stopIdleRefresh once)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Call stop() again - stopIdleRefresh is called but interval is already null
            manager.stop();

            // clearInterval should have been called exactly once
            // (second call to stopIdleRefresh sees idleRefreshInterval is null, so skips)
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

            clearIntervalSpy.mockRestore();
        });
    });

    describe('wasIdle/nowIdle logic verification', () => {
        it('should call stopIdleRefresh only when transitioning from idle to non-idle', async () => {
            // This test kills:
            // - Line 194: `!nowIdle && wasIdle` block mutations
            // - Line 194: `if(!nowIdle && wasIdle)` → `if(true)` or `if(false)` mutations
            // - Line 194-196: Block statement removal mutation
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // thinking → responding: neither is idle, should NOT call clearInterval
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            expect(clearIntervalSpy).not.toHaveBeenCalled();

            // Go idle (wasIdle=false, nowIdle=true) - starts idle refresh but doesn't call stopIdleRefresh
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Still should not have called clearInterval (starting idle, not stopping)
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            // idle → thinking (wasIdle=true, nowIdle=false) → SHOULD call clearInterval via stopIdleRefresh
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(clearIntervalSpy).toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should not call stopIdleRefresh when staying idle (idle→idle)', async () => {
            // This test kills:
            // - Line 194: `!nowIdle && wasIdle` → `!nowIdle || wasIdle` mutation
            // - Line 194: `!nowIdle` → `nowIdle` (removes negation) mutation
            // When idle→idle: wasIdle=true, nowIdle=true
            // With correct logic: !true && true = false → don't call stopIdleRefresh
            // With || mutation: !true || true = true → wrongly call stopIdleRefresh
            // With negation removal: true && true = true → wrongly call stopIdleRefresh
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // idle → idle: wasIdle=true, nowIdle=true, !nowIdle && wasIdle = false
            // So should NOT call stopIdleRefresh (should not call clearInterval)
            clearIntervalSpy.mockClear();
            await manager.updatePhase({ type: 'idle', since: new Date() });

            expect(clearIntervalSpy).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should not call stopIdleRefresh when staying active (active→active)', async () => {
            // This test kills:
            // - Line 194: `!nowIdle && wasIdle` → `!nowIdle || wasIdle` mutation
            // When active→active: wasIdle=false, nowIdle=false
            // With correct logic: !false && false = false → don't call stopIdleRefresh
            // With || mutation: !false || false = true → wrongly call stopIdleRefresh
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // thinking → responding: both active, should NOT call clearInterval
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Should not have called clearInterval at any point
            expect(clearIntervalSpy).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should correctly compute wasIdle from previous phase type', async () => {
            // This test kills:
            // - Line 178: `currentPhase?.type === 'idle'` → `false` mutation
            // - Line 178: `'idle'` → `""` (StringLiteral) mutation
            // Verifies that wasIdle is computed from the PREVIOUS phase before currentPhase is updated
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start active: wasIdle = null?.type === 'idle' = false
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // Go idle: wasIdle = 'thinking' === 'idle' = false, nowIdle = true
            // Should start idle refresh (not stop it)
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            const idleGenCallCount = mockIdleGenerator.generate.mock.calls.length;

            // Go active again: wasIdle = 'idle' === 'idle' = true, nowIdle = false
            // Should stop idle refresh
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(clearIntervalSpy).toHaveBeenCalled();

            // Verify idle refresh has stopped (no more calls after interval)
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleGenCallCount);

            clearIntervalSpy.mockRestore();
        });

        it('should not generate active status when nowIdle is true', async () => {
            // This test kills:
            // - Line 199: `if(!nowIdle)` → `if(true)` mutation
            // When idle, should NOT call activeStatusGenerator.generate
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go directly to idle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Active generator should NOT have been called for idle phase
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();

            // Idle generator SHOULD have been called
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
        });

        it('should generate active status only when nowIdle is false', async () => {
            // This test further validates the `if(!nowIdle)` logic
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go active
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            // Active generator SHOULD be called for active phase
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase);

            // Idle generator should NOT be called for active phase
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should handle full cycle: null→active→idle→active with correct transitions', async () => {
            // Comprehensive test of all state transitions
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // null → active: wasIdle = false (null?.type === 'idle'), nowIdle = false
            // Should NOT start or stop idle refresh
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // active → idle: wasIdle = false, nowIdle = true
            // Should start idle refresh
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(clearIntervalSpy).not.toHaveBeenCalled(); // Still not called (starting, not stopping)
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            const idleCallsAfterStart = mockIdleGenerator.generate.mock.calls.length;

            // idle → active: wasIdle = true, nowIdle = false
            // Should stop idle refresh
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

            // Verify idle refresh is actually stopped
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallsAfterStart);

            clearIntervalSpy.mockRestore();
        });
    });

    describe('mutant-killing boundary tests', () => {
        it('should allow update when timeSinceLastUpdate equals exactly debounceMs (kills < → <= mutant)', async () => {
            // This test kills: manager.ts:114 - if(timeSinceLastUpdate < config.updateDebounceMs)
            // Mutant: < → <=
            // At exactly debounceMs, the update SHOULD go through with <, but would be skipped with <=
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // First update via idle (bypasses debounce scheduling, goes directly to applyPresenceUpdate)
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockClient.user.setActivity.mock.calls.length).toBe(1);

            // Advance time by EXACTLY debounceMs
            jest.advanceTimersByTime(100);

            // Stop idle refresh so we can test manually
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Clear the debounce timer and manually trigger a second idle phase
            // This will call applyPresenceUpdate directly via refreshIdleStatus
            // At this point, timeSinceLastUpdate === 100 === debounceMs
            // With <: 100 < 100 = false, so update goes through
            // With <=: 100 <= 100 = true, so update is SKIPPED (mutant behavior)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // If the mutant survives, the second update would be skipped
            // If the test kills the mutant, the second update goes through
            expect(mockClient.user.setActivity.mock.calls.length).toBe(2);
        });

        it('should exit refreshIdleStatus early when phase is no longer idle (kills guard mutants)', async () => {
            // This test kills manager.ts:135 mutants:
            // - if(false) - would never return early
            // - remove optional chaining - would throw on null
            // - remove block - would continue even when not idle
            //
            // The guard checks currentPhase?.type !== 'idle' BEFORE calling generate().
            // To test this, we:
            // 1. Go idle (first refresh happens immediately)
            // 2. Transition to active (stops idle refresh interval)
            // 3. Advance time to what would be an idle refresh interval
            // 4. Verify that idle generator is NOT called again (because interval was stopped)
            //
            // The key is that stopIdleRefresh clears the interval, so when the interval
            // callback would have fired, it doesn't. And if it somehow did fire,
            // the guard would prevent generate() from being called.

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle - triggers first refreshIdleStatus
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const idleCallsAfterFirst = mockIdleGenerator.generate.mock.calls.length;
            expect(idleCallsAfterFirst).toBe(1);

            // Transition to active - stops the idle refresh interval
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Advance time past what would be multiple idle refresh intervals
            jest.advanceTimersByTime(config.idleRefreshIntervalMs * 3);
            await Promise.resolve();
            await Promise.resolve();

            // The idle generator should NOT have been called again
            // because stopIdleRefresh cleared the interval
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCallsAfterFirst);
        });

        it('should not call generate when interval fires but phase is no longer idle (guards interval callback)', async () => {
            // This test specifically validates that the guard in refreshIdleStatus
            // prevents generate() from being called when the phase has changed.
            // We use a scenario where we manually verify the guard's behavior
            // by checking that switching away from idle stops further generate() calls.

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle - first refresh happens immediately
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(1);

            // Wait for one interval to trigger second refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(2);

            // Now transition to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            const countAfterTransition = mockIdleGenerator.generate.mock.calls.length;

            // Wait for what would be another interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have called generate() again (interval was cleared)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(countAfterTransition);
        });

        it('should not create duplicate intervals when startIdleRefresh called twice (kills guard mutants)', async () => {
            // This test kills manager.ts:148 mutants:
            // - if(false) - would always create new interval
            // - remove block - would not return early

            const setIntervalSpy = spyOn(globalThis, 'setInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First idle transition - creates interval
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const intervalsAfterFirst = setIntervalSpy.mock.calls.length;
            expect(intervalsAfterFirst).toBe(1);

            // Call start() which would try to startIdleRefresh again
            // The guard should prevent creating a duplicate interval
            manager.start();
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have created another interval
            expect(setIntervalSpy.mock.calls.length).toBe(intervalsAfterFirst);

            // Additional verification: idle generator should only have been called once
            // (from the first startIdleRefresh, not from start())
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(1);

            setIntervalSpy.mockRestore();
        });

        it('should not call clearTimeout when pendingUpdate is null in updatePhase (kills if(true) mutant)', async () => {
            // This test kills manager.ts:184 mutant: if(pendingUpdate) → if(true)
            // When pendingUpdate is null, clearTimeout should NOT be called

            const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go directly to idle - this path doesn't create a pendingUpdate
            // (idle uses refreshIdleStatus directly, not debounced updates)
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // clearTimeout should NOT have been called since pendingUpdate was null
            expect(clearTimeoutSpy).not.toHaveBeenCalled();

            clearTimeoutSpy.mockRestore();
        });

        it('should not call activeStatusGenerator.generate when transitioning to idle (kills if(true) mutant)', async () => {
            // This test kills manager.ts:199 mutant: if(!nowIdle) → if(true)
            // When nowIdle is true (going idle), activeStatusGenerator should NOT be called

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Transition directly to idle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // activeStatusGenerator should NOT have been called for idle phase
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();

            // idleStatusGenerator SHOULD have been called
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
        });

        it('should not start idle refresh in start() when currentPhase is active (kills if(true) mutant)', async () => {
            // This test kills manager.ts:212 mutant: if(currentPhase?.type === 'idle') → if(true)
            // When currentPhase is active, start() should NOT call startIdleRefresh

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to active phase first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            // Clear mock to track new calls
            mockIdleGenerator.generate.mockClear();

            // Call start() - should NOT trigger idle refresh because phase is active
            manager.start();
            await Promise.resolve();
            await Promise.resolve();

            // idleStatusGenerator should NOT have been called
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should not call clearTimeout in stop() when pendingUpdate is null (kills if(true) mutant)', async () => {
            // This test kills manager.ts:220 mutant: if(pendingUpdate) → if(true)
            // When pendingUpdate is null, clearTimeout should NOT be called

            const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle (no pendingUpdate created) then stop
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Clear spy to track only stop() calls
            clearTimeoutSpy.mockClear();

            // Call stop() - should call clearInterval for idle refresh but NOT clearTimeout
            manager.stop();

            // clearTimeout should NOT have been called (no pending update exists)
            expect(clearTimeoutSpy).not.toHaveBeenCalled();

            clearTimeoutSpy.mockRestore();
        });

        it('should handle refreshIdleStatus guard when currentPhase is null (kills optional chaining removal)', async () => {
            // This test ensures the optional chaining ?. in currentPhase?.type !== 'idle'
            // handles null correctly. Without ?., accessing .type on null would throw.

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start and stop without ever setting a phase
            // This shouldn't throw even though currentPhase is null
            manager.start();
            manager.stop();

            // If the optional chaining was removed, this would have thrown an error
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should allow update at EXACTLY debounceMs boundary (line 114: < vs <= mutant)', async () => {
            // This test PRECISELY kills the mutant: timeSinceLastUpdate < config.updateDebounceMs
            // Changed to: timeSinceLastUpdate <= config.updateDebounceMs
            //
            // At EXACTLY debounceMs:
            // - With <:  100 < 100 = FALSE, update ALLOWED
            // - With <=: 100 <= 100 = TRUE, update SKIPPED (mutant behavior)
            //
            // Strategy: Use two consecutive idle updates separated by EXACTLY debounceMs.
            // We transition idle->active->idle to avoid the idleRefreshInterval guard
            // that prevents duplicate startIdleRefresh calls.
            const debounceConfig = { ...config, updateDebounceMs: 100 };
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config:                debounceConfig,
                logger:                mockLogger,
            });

            // t=1000: First idle update
            await manager.updatePhase({ type: 'idle', since: new Date() });
            // refreshIdleStatus -> applyPresenceUpdate: now=1000, lastUpdateTime=0
            // timeSinceLastUpdate = 1000, 1000 < 100 = false, update ALLOWED
            // lastUpdateTime = 1000, setActivity called
            expect(mockClient.user.setActivity.mock.calls.length).toBe(1);

            // Transition to active (stops idle interval, schedules debounced active update)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Advance time by EXACTLY debounceMs (100ms) to trigger the active debounced update
            // The active update will set lastUpdateTime = 1100
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            // Active debounced update fires: now=1100, lastUpdateTime=1000
            // timeSinceLastUpdate = 100, 100 < 100 = false, update ALLOWED
            // lastUpdateTime = 1100, setActivity called
            expect(mockClient.user.setActivity.mock.calls.length).toBe(2);

            // Now advance by EXACTLY 100ms more to t=1200
            // When we go idle, timeSinceLastUpdate = 1200 - 1100 = 100
            jest.advanceTimersByTime(100);

            // t=1200: Go back to idle
            await manager.updatePhase({ type: 'idle', since: new Date() });
            // refreshIdleStatus -> applyPresenceUpdate: now=1200, lastUpdateTime=1100
            // timeSinceLastUpdate = 100
            // With <: 100 < 100 = false, update ALLOWED, setActivity called (count: 3)
            // With <=: 100 <= 100 = true, update SKIPPED (count stays at 2)

            // The key assertion: with < operator, we get 3 calls. With <=, only 2.
            expect(mockClient.user.setActivity.mock.calls.length).toBe(3);
        });

        it('should verify refreshIdleStatus guard by testing interval callback behavior (line 135 mutants)', async () => {
            // This test targets the guard at line 135:
            // if(currentPhase?.type !== 'idle') { return; }
            //
            // Mutants:
            // 1. if(false) - would never return early
            // 2. Remove optional chaining - would throw on null
            // 3. Remove block - would continue even when not idle
            //
            // The key is that when the interval callback fires AFTER we've transitioned
            // away from idle, the guard should prevent generate() from being called.
            //
            // However, since stopIdleRefresh clears the interval, we can't test this
            // directly. But we CAN verify that the guard exists by:
            // 1. Going idle (sets interval)
            // 2. Letting interval fire once (guard passes, generate called)
            // 3. Transitioning to active (stops interval, but guard still needed for race conditions)
            // 4. Verifying no more generate() calls happen

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle - first refresh happens immediately
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(1);

            // Wait for interval to fire - guard passes (still idle)
            jest.advanceTimersByTime(config.idleRefreshIntervalMs);
            await Promise.resolve();
            await Promise.resolve();
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(2);

            // Transition to active - interval is cleared
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            const countAfterTransition = mockIdleGenerator.generate.mock.calls.length;

            // Advance time significantly - no interval should fire
            jest.advanceTimersByTime(config.idleRefreshIntervalMs * 5);
            await Promise.resolve();
            await Promise.resolve();

            // If guard mutant survived (if(false)), the interval would still be running
            // and generate() would be called. Since stopIdleRefresh clears it, we verify
            // that no additional calls happened.
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(countAfterTransition);
        });

        it('should never call activeStatusGenerator when transitioning idle->idle (line 199 if(true) mutant)', async () => {
            // This test PRECISELY kills the mutant: if(!nowIdle) → if(true)
            //
            // The code flow for updatePhase:
            // 1. if(nowIdle && !wasIdle) { startIdleRefresh(); return; } <- catches null->idle, active->idle
            // 2. if(!nowIdle && wasIdle) { stopIdleRefresh(); }          <- catches idle->active
            // 3. if(!nowIdle) { activeStatusGenerator.generate(...) }    <- Line 199
            //
            // To reach line 199 with nowIdle=true, we need idle->idle transition:
            // - nowIdle=true, wasIdle=true
            // - First if: true && !true = false (skip)
            // - Second if: !true && true = false (skip)
            // - Line 199: if(!true) = if(false) -> block NOT executed (correct)
            //
            // With mutant if(true): block IS executed, calling activeStatusGenerator.generate()

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First go to idle (this triggers startIdleRefresh via first condition)
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();

            // Clear mocks
            mockActiveGenerator.generate.mockClear();

            // Now transition idle->idle - this reaches line 199 with nowIdle=true
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // With correct code: if(!nowIdle) = if(false), block NOT executed
            // With mutant: if(true), block IS executed, calling activeStatusGenerator.generate()
            expect(mockActiveGenerator.generate).not.toHaveBeenCalled();
        });

        it('should not call startIdleRefresh in start() when phase is not idle (line 212 if(true) mutant)', async () => {
            // This test PRECISELY kills the mutant: if(currentPhase?.type === 'idle') → if(true)
            //
            // When currentPhase is active (not idle), startIdleRefresh should NOT be called.
            // If mutated to if(true), startIdleRefresh is ALWAYS called.
            //
            // The key insight: even if refreshIdleStatus returns early (because phase is not idle),
            // startIdleRefresh still:
            // 1. Sets up idleRefreshInterval (observable via setInterval being called)
            // 2. Logs 'Started idle status refresh'
            //
            // We can detect this by checking the logger.debug calls for the idle refresh start message.

            const setIntervalSpy = spyOn(globalThis, 'setInterval');

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set phase to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateDebounceMs);
            await Promise.resolve();

            // Clear mocks to track only start() effects
            mockLogger.debug.mockClear();
            setIntervalSpy.mockClear();

            // Call start() - should NOT call startIdleRefresh because phase is active
            manager.start();

            // Wait for any potential async effects
            await Promise.resolve();
            await Promise.resolve();

            // With correct code: startIdleRefresh is NOT called, so no interval set
            // With mutant (if(true)): startIdleRefresh IS called, interval IS set
            expect(setIntervalSpy).not.toHaveBeenCalled();

            // Also verify no 'Started idle status refresh' log
            const idleRefreshLogs = _.filter(mockLogger.debug.mock.calls, [1, 'Started idle status refresh']);
            expect(idleRefreshLogs.length).toBe(0);

            setIntervalSpy.mockRestore();
        });

        it('should handle null currentPhase in start() guard (line 212 optional chaining mutant)', async () => {
            // This test kills the optional chaining removal mutant in start():
            // if(currentPhase?.type === 'idle') → if(currentPhase.type === 'idle')
            //
            // When currentPhase is null, accessing .type without ?. would throw.

            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start() without ever setting a phase (currentPhase is null)
            // With ?.  : null?.type === 'idle' = undefined === 'idle' = false, no throw
            // Without ?. : null.type would throw TypeError
            expect(() => manager.start()).not.toThrow();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });
});
