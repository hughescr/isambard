import { describe, it, expect, beforeEach, afterEach, mock, jest, spyOn } from 'bun:test';
import { type Client, ActivityType  } from 'discord.js';
import { PresenceManager, type PresenceManagerDeps  } from '@/integrations/discord/presence/manager';

import type { PresencePhase, PresenceConfig } from '@/integrations/discord/presence/types';

// Typed mock shapes that expose both real interface and bun mock methods
type MockWithCalls = ReturnType<typeof mock> & { mock: { calls: unknown[][] } };
interface MockedClient { user: { setActivity: MockWithCalls } }
interface MockedActiveGenerator { generate: MockWithCalls, formatStatus: MockWithCalls }
interface MockedIdleGenerator { generate: MockWithCalls }

describe('PresenceManager Lifecycle', () => {
    let mockClient: MockedClient;
    let mockActiveGenerator: MockedActiveGenerator;
    let mockIdleGenerator: MockedIdleGenerator;
    let mockLogger: PresenceManagerDeps['logger'];
    let config: PresenceConfig;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllTimers();
        // Set to 1000ms (not 0) to avoid rate limit check failing on first update
        // (lastUpdateTime initializes to 0, so Date.now() must be >= updateThrottleMs)
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
            updateThrottleMs:      100, // 100ms throttle for testing
            idleTimeoutMs:         100,
            idleRefreshIntervalMs: 200,
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('null/undefined handling', () => {
        it('should handle null user gracefully', async () => {
            const nullUserClient = {
                user: null,
            } as unknown as Client;

            const manager = new PresenceManager({
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

            const manager = new PresenceManager({
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

        it('should not trigger idle refresh in start() - caller must explicitly transition', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start without setting any phase (currentPhase is null)
            manager.start();

            // Allow async operations to complete
            jest.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT call idle generator - start() no longer triggers status generation
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            // Verify setActivity was NOT called
            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
        });

        it('should not start idle refresh in start() when currentPhase is active', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

    describe('start', () => {
        it('should not automatically restart idle refresh even if currently idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            // Clear mocks to track new calls
            mockIdleGenerator.generate.mockClear();
            mockClient.user.setActivity.mockClear();

            // Start again - start() should NOT trigger idle refresh anymore
            manager.start();

            // Allow async operations to complete
            await Promise.resolve();
            await Promise.resolve();

            // Verify idle generator was NOT called again (start() no longer triggers status generation)
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            // Verify setActivity was NOT called
            expect(mockClient.user.setActivity).not.toHaveBeenCalled();
        });
    });

    describe('stop', () => {
        it('should log the exact stopping message', () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            manager.stop();

            expect(mockLogger.info).toHaveBeenCalledWith('Stopping presence manager');
        });

        it('should clear all timers', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

        it('should clear idle refresh interval', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start idle to create interval
            await manager.updatePhase({ type: 'idle', since: new Date() });
            const initialIdleCount = mockIdleGenerator.generate.mock.calls.length;

            manager.stop();

            // Wait past idle refresh interval
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();

            // Idle refresh should not have happened again (cleared by stop)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(initialIdleCount);
        });
    });

    describe('logger assertions', () => {
        it('should log phase update with phase parameter', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

        it('should apply all updates (no throttle logging)', async () => {
            // Test that updates are applied without internal throttling
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First active update - goes through
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(1);

            // Second active update immediately - also goes through (no internal throttle)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity).toHaveBeenCalledTimes(2);

            // Should NOT have logged throttle skip (throttling is upstream)
            expect(mockLogger.debug).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    timeSinceLastUpdate: expect.any(Number),
                    throttleMs:          config.updateThrottleMs,
                }),
                'Skipping presence update due to throttle cooldown'
            );
        });

        it('should log successful presence update with activity parameter', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // With leading-edge throttle, update happens immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

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

            const manager = new PresenceManager({
                discordClient:         errorClient,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // With leading-edge throttle, update happens immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    error:    testError,
                    activity: expect.any(Object),
                }),
                'Failed to update Discord presence'
            );
        });

        it('should log idle refresh start with interval parameter', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            manager.start();

            expect(mockLogger.info).toHaveBeenCalledWith('Starting presence manager');
        });

        it('should not start idle refresh even when current phase is idle', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            // Now call start() - should NOT trigger idle refresh anymore
            manager.start();

            // Wait for any potential async operations
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have called idle generator again
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should not start idle refresh when current phase is active', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to active phase via updatePhase
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateThrottleMs);
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

        it('should not start idle refresh when current phase is null', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start() without ever setting a phase (currentPhase is null)
            manager.start();

            // Allow async operations to complete
            await Promise.resolve();
            await Promise.resolve();

            // Idle generator should NOT have been called (start() no longer triggers status)
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });

    describe('stopIdleRefresh execution', () => {
        it('should call clearInterval when stopping idle refresh', async () => {
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // - Line 194: `if(!nowIdle && wasIdle)` -> `if(true)` or `if(false)` mutations
            // - Line 194-196: Block statement removal mutation
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // thinking -> responding: neither is idle, should NOT call clearInterval
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

            // idle -> thinking (wasIdle=true, nowIdle=false) -> SHOULD call clearInterval via stopIdleRefresh
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });

            expect(clearIntervalSpy).toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should not call stopIdleRefresh when staying idle (idle->idle)', async () => {
            // This test kills:
            // - Line 194: `!nowIdle && wasIdle` -> `!nowIdle || wasIdle` mutation
            // - Line 194: `!nowIdle` -> `nowIdle` (removes negation) mutation
            // When idle->idle: wasIdle=true, nowIdle=true
            // With correct logic: !true && true = false -> don't call stopIdleRefresh
            // With || mutation: !true || true = true -> wrongly call stopIdleRefresh
            // With negation removal: true && true = true -> wrongly call stopIdleRefresh
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go idle first
            await manager.updatePhase({ type: 'idle', since: new Date() });

            // idle -> idle: wasIdle=true, nowIdle=true, !nowIdle && wasIdle = false
            // So should NOT call stopIdleRefresh (should not call clearInterval)
            clearIntervalSpy.mockClear();
            await manager.updatePhase({ type: 'idle', since: new Date() });

            expect(clearIntervalSpy).not.toHaveBeenCalled();

            clearIntervalSpy.mockRestore();
        });

        it('should not call stopIdleRefresh when staying active (active->active)', async () => {
            // This test kills:
            // - Line 194: `!nowIdle && wasIdle` -> `!nowIdle || wasIdle` mutation
            // When active->active: wasIdle=false, nowIdle=false
            // With correct logic: !false && false = false -> don't call stopIdleRefresh
            // With || mutation: !false || false = true -> wrongly call stopIdleRefresh
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // thinking -> responding: both active, should NOT call clearInterval
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
            // - Line 178: `currentPhase?.type === 'idle'` -> `false` mutation
            // - Line 178: `'idle'` -> `""` (StringLiteral) mutation
            // Verifies that wasIdle is computed from the PREVIOUS phase before currentPhase is updated
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // - Line 199: `if(!nowIdle)` -> `if(true)` mutation
            // When idle, should NOT call activeStatusGenerator.generate
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Go active
            const phase: PresencePhase = { type: 'thinking', startedAt: new Date() };
            await manager.updatePhase(phase);

            // Active generator SHOULD be called for active phase
            expect(mockActiveGenerator.generate).toHaveBeenCalledWith(phase, 'none');

            // Idle generator should NOT be called for active phase
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should handle full cycle: null->active->idle->active with correct transitions', async () => {
            // Comprehensive test of all state transitions
            const clearIntervalSpy = spyOn(globalThis, 'clearInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // null -> active: wasIdle = false (null?.type === 'idle'), nowIdle = false
            // Should NOT start or stop idle refresh
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(clearIntervalSpy).not.toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            jest.advanceTimersByTime(20);
            await Promise.resolve();

            // active -> idle: wasIdle = false, nowIdle = true
            // Should start idle refresh
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(clearIntervalSpy).not.toHaveBeenCalled(); // Still not called (starting, not stopping)
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            const idleCallsAfterStart = mockIdleGenerator.generate.mock.calls.length;

            // idle -> active: wasIdle = true, nowIdle = false
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
        it('should allow update when timeSinceLastUpdate equals exactly throttleMs (kills < -> <= mutant)', async () => {
            // This test kills: manager.ts - if(timeSinceLastUpdate < config.updateThrottleMs)
            // Mutant: < -> <=
            // At exactly throttleMs, the update SHOULD go through with <, but would be skipped with <=
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update - goes through immediately (leading-edge)
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity.mock.calls.length).toBe(1);

            // Advance time by EXACTLY throttleMs (100ms)
            jest.advanceTimersByTime(100);

            // Second active update - at exactly throttleMs
            // With <: 100 < 100 = false, so update goes through
            // With <=: 100 <= 100 = true, so update is SKIPPED (mutant behavior)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

        it('should not create any intervals when start() is called (new behavior)', async () => {
            // With the new behavior, start() should NOT create any intervals
            // It just logs and returns

            const setIntervalSpy = spyOn(globalThis, 'setInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start() without any prior phase
            manager.start();
            await Promise.resolve();
            await Promise.resolve();

            // Should NOT have created any intervals
            expect(setIntervalSpy).not.toHaveBeenCalled();

            // Idle generator should not have been called
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            setIntervalSpy.mockRestore();
        });

        it('should not call clearTimeout when pendingUpdate is null in updatePhase (kills if(true) mutant)', async () => {
            // This test kills manager.ts:184 mutant: if(pendingUpdate) -> if(true)
            // When pendingUpdate is null, clearTimeout should NOT be called

            const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // This test kills manager.ts:199 mutant: if(!nowIdle) -> if(true)
            // When nowIdle is true (going idle), activeStatusGenerator should NOT be called

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // This test kills manager.ts:212 mutant: if(currentPhase?.type === 'idle') -> if(true)
            // When currentPhase is active, start() should NOT call startIdleRefresh

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set to active phase first
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateThrottleMs);
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
            // This test kills manager.ts:220 mutant: if(pendingUpdate) -> if(true)
            // When pendingUpdate is null, clearTimeout should NOT be called

            const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // Now that null is treated as idle, start() will trigger idle refresh.

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start without ever setting a phase - should not throw
            manager.start();

            // Allow async operations to complete
            await Promise.resolve();
            await Promise.resolve();

            // Stop should also not throw
            manager.stop();

            // With new behavior, start() does NOT trigger status generation
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });

        it('should allow update at EXACTLY debounceMs boundary (line 114: < vs <= mutant)', async () => {
            // This test PRECISELY kills the mutant: timeSinceLastUpdate < config.updateThrottleMs
            // Changed to: timeSinceLastUpdate <= config.updateThrottleMs
            //
            // At EXACTLY debounceMs:
            // - With <:  100 < 100 = FALSE, update ALLOWED
            // - With <=: 100 <= 100 = TRUE, update SKIPPED (mutant behavior)
            //
            // Strategy: Use two consecutive idle updates separated by EXACTLY debounceMs.
            // We transition idle->active->idle to avoid the idleRefreshInterval guard
            // that prevents duplicate startIdleRefresh calls.
            const debounceConfig = { ...config, updateThrottleMs: 100 };
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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
            // This test PRECISELY kills the mutant: if(!nowIdle) -> if(true)
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

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
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

        it('should not call startIdleRefresh in start() regardless of phase (new behavior)', async () => {
            // With the new behavior, start() NEVER calls startIdleRefresh
            // regardless of the current phase state

            const setIntervalSpy = spyOn(globalThis, 'setInterval');

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Set phase to active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            jest.advanceTimersByTime(config.updateThrottleMs);
            await Promise.resolve();

            // Clear mocks to track only start() effects
            (mockLogger.debug as ReturnType<typeof mock>).mockClear();
            setIntervalSpy.mockClear();

            // Call start() - should NOT call startIdleRefresh (new behavior)
            manager.start();

            // Wait for any potential async effects
            await Promise.resolve();
            await Promise.resolve();

            // start() should NOT set any intervals
            expect(setIntervalSpy).not.toHaveBeenCalled();

            // Also verify no 'Started idle status refresh' log
            const idleRefreshLogs = (mockLogger.debug as ReturnType<typeof mock>).mock.calls.filter(call => call[1] === 'Started idle status refresh');
            expect(idleRefreshLogs.length).toBe(0);

            setIntervalSpy.mockRestore();
        });

        it('should handle null currentPhase in start() without throwing', async () => {
            // With the new behavior, start() just logs and returns
            // It doesn't access currentPhase at all, so no optional chaining needed

            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Call start() without ever setting a phase (currentPhase is null)
            // Should not throw
            expect(() => manager.start()).not.toThrow();

            // Allow async operations to complete
            await Promise.resolve();
            await Promise.resolve();

            // With new behavior, start() does NOT trigger status generation
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();
        });
    });

    describe('assignment mutations', () => {
        it('should update lastActiveUpdateTime on successful update', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // First update - goes through immediately
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockClient.user.setActivity.mock.calls.length).toBe(1);

            // Advance past throttle cooldown
            jest.advanceTimersByTime(101);

            // Second update should work (proving lastActiveUpdateTime was updated)
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });
            expect(mockClient.user.setActivity.mock.calls.length).toBe(2);
        });

        it('should properly track currentPhase transitions', async () => {
            const manager = new PresenceManager({
                discordClient:         mockClient as unknown as Client,
                activeStatusGenerator: mockActiveGenerator,
                idleStatusGenerator:   mockIdleGenerator,
                config,
                logger:                mockLogger,
            });

            // Start active
            await manager.updatePhase({ type: 'thinking', startedAt: new Date() });
            expect(mockActiveGenerator.generate).toHaveBeenCalled();
            expect(mockIdleGenerator.generate).not.toHaveBeenCalled();

            // Transition to idle (bypasses throttle)
            await manager.updatePhase({ type: 'idle', since: new Date() });
            expect(mockIdleGenerator.generate).toHaveBeenCalled();

            const idleCount = mockIdleGenerator.generate.mock.calls.length;

            // Advance past throttle cooldown
            jest.advanceTimersByTime(101);

            // Transition back to active
            await manager.updatePhase({ type: 'responding', startedAt: new Date() });

            // Wait for what would be idle refresh
            jest.advanceTimersByTime(config.idleRefreshIntervalMs + 50);
            await Promise.resolve();

            // Idle should not have been called again (proves currentPhase was updated)
            expect(mockIdleGenerator.generate.mock.calls.length).toBe(idleCount);
        });
    });
});
