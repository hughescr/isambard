/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Test mocks */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Test mocks */

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
            updateThrottleMs:      100, // 100ms throttle for testing
            idleTimeoutMs:         100,
            idleRefreshIntervalMs: 200,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('shouldUpdate', () => {
        it('should return true when throttle cooldown has expired', () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First call - no updates yet, cooldown is expired (lastActiveUpdateTime=0, now=1000)
            expect(manager.shouldUpdate()).toBe(true);
        });

        it('should return false when within throttle cooldown', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update - applies immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // shouldUpdate should now return false (within 100ms cooldown)
            expect(manager.shouldUpdate()).toBe(false);
        });

        it('should return true after throttle cooldown expires', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Advance past throttle cooldown
            jest.advanceTimersByTime(101);

            // shouldUpdate should return true again
            expect(manager.shouldUpdate()).toBe(true);
        });
    });

    describe('updatePhase - leading-edge throttle', () => {
        it('should update presence immediately for first active phase', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            // Should update immediately (leading-edge)
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase);
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
        });

        it('should drop subsequent updates within throttle cooldown', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update - goes through
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Second update immediately after - should be dropped
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Verify throttle skip was logged
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
            );
        });

        it('should allow update after throttle cooldown expires', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Advance past throttle cooldown
            jest.advanceTimersByTime(101);

            // Second update - should go through
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
        });
    });

    describe('updatePhase - idle transitions', () => {
        it('should transition to idle immediately (bypasses throttle)', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First active update
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Immediately transition to idle - should apply despite being within throttle
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // Idle update should have happened (idle bypasses throttle)
            expect(mockIdleGenerator.generate).toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
        });

        it('should start idle refresh loop when transitioning to idle', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
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

            const manager = createPresenceManager({
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
    });

    describe('throttle boundary tests', () => {
        it('should skip update at exactly throttleMs - 1 milliseconds', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update (at t=1000 from beforeEach)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Advance system time to just before throttle expires (99ms < 100ms throttle)
            // Note: In Bun, jest.advanceTimersByTime() doesn't affect Date.now(),
            // only jest.setSystemTime() does
            jest.setSystemTime(1099); // 1000 + 99 = 1099

            // Second update - should be skipped (99ms < 100ms cooldown)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Verify throttle skip was logged
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
            );
        });

        it('should allow update at exactly throttleMs milliseconds', async () => {
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update (at t=1000 from beforeEach)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Advance system time to exactly throttle time (100ms)
            jest.setSystemTime(1100); // 1000 + 100 = 1100

            // Second update - should go through (cooldown expired)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);
        });

        it('should correctly compute time since last update using subtraction not addition', async () => {
            // This test kills the mutant: now - lastActiveUpdateTime → now + lastActiveUpdateTime
            const manager = createPresenceManager({
                discordClient:         mockClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // At t=1000 (set by beforeEach), first update sets lastActiveUpdateTime=1000
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Immediately (no time advance) try second update
            // - With subtraction: 1000 - 1000 = 0 < 100 → SKIP (correct)
            // - With addition: 1000 + 1000 = 2000 >= 100 → ALLOW (mutation fails test)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            // The update should have been SKIPPED because 0ms < 100ms throttle
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.objectContaining({ timeSinceLastUpdate: 0, throttleMs: 100 }),
                'Skipping presence update due to throttle cooldown'
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

            // First phase is active - should update immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            // Should use active generator
            expect(mockActiveGenerator.generate).toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);
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
            const manager = createPresenceManager({
                discordClient:         mockClient,
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
});
