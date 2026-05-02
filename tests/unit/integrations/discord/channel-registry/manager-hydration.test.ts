/**
 * Tests for ChannelRegistryManager self-healing hydration via ReconnectionLoop.
 *
 * These tests verify:
 * - startHydration(loop) makes the manager use the loop to call warmCache()
 * - ready resolves once warmCache() eventually succeeds (even after failures)
 * - isReady() flips to true only after a successful warmCache()
 * - stop() cancels the hydration loop so no further retries fire
 * - Multiple failures are retried with exponential backoff (via fake timers)
 * - Memory is not leaked: stop() before hydration completes cancels the loop
 */

import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import type { Client, Channel } from 'discord.js';
import type { ChannelRegistryBackend } from '@/integrations/discord/channel-registry/backend';
import { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import { createGuildId } from '@/integrations/discord/types';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import { createReconnectionLoop } from '@/services/reconnection-loop';
import type { ServiceName } from '@/services/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const homeGuildId = createGuildId('home-guild');
const SERVICE: ServiceName = 'discord';

function createMockRegistry(): ServiceHealthRegistry {
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

function createMockBackend(getChannelsByGuildImpl: () => Promise<never[]>): ChannelRegistryBackend {
    return {
        getAllChannels:      mock(() => Promise.resolve([])),
        getChannel:          mock(() => Promise.resolve(null)),
        upsertChannel:       mock(() => Promise.resolve()),
        deleteChannel:       mock(() => Promise.resolve()),
        getChannelsByGuild:  mock(getChannelsByGuildImpl),
        getWellKnownChannel: mock(() => Promise.resolve(null)),
        muteChannel:         mock(() => Promise.resolve()),
        unmuteChannel:       mock(() => Promise.resolve()),
        markAsWellKnown:     mock(() => Promise.resolve()),
        unmarkAsWellKnown:   mock(() => Promise.resolve()),
    } as unknown as ChannelRegistryBackend;
}

function createMockClient(): Client {
    return {
        channels: {
            cache: new Map(),
            fetch: mock((channelId: string) => Promise.resolve({ id: channelId, name: `channel-${channelId}` } as unknown as Channel)),
        },
    } as unknown as Client;
}

// Deterministic policy — no jitter, predictable delays.
const DETERMINISTIC_POLICY = {
    baseDelayMs:       100,
    maxDelayMs:        10_000,
    backoffMultiplier: 2,
    jitterFraction:    0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelRegistryManager — self-healing hydration via ReconnectionLoop', () => {
    let registry: ServiceHealthRegistry;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        registry = createMockRegistry();
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Success path
    // -----------------------------------------------------------------------

    describe('hydration succeeds on first attempt', () => {
        it('should resolve ready and set isReady() to true', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // Flush the in-flight warmCache() call
            await Promise.resolve();
            await Promise.resolve();

            expect(manager.isReady()).toBe(true);

            let resolved = false;
            // eslint-disable-next-line promise/always-return -- side-effect setter, no return value needed
            void manager.ready.then(() => {
                resolved = true;
            });
            await Promise.resolve();
            expect(resolved).toBe(true);
        });

        it('should not leave timers running after successful hydration', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            await Promise.resolve();
            await Promise.resolve();

            // Loop auto-stops after success — no pending timers
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Failure then success
    // -----------------------------------------------------------------------

    describe('hydration throws on first attempt, succeeds on second', () => {
        it('should eventually resolve ready and set isReady() to true', async () => {
            let callCount = 0;
            const backend = createMockBackend(() => {
                callCount += 1;
                if(callCount === 1) {
                    throw new Error('DynamoDB hiccup');
                }
                return Promise.resolve([]);
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // First attempt fires and fails
            await Promise.resolve();
            await Promise.resolve();

            // Not ready yet after first failure
            expect(manager.isReady()).toBe(false);

            // ready is still pending
            const raceResult = await Promise.race([
                manager.ready.then(() => 'resolved'),
                Promise.resolve('timeout'),
            ]);
            expect(raceResult).toBe('timeout');

            // Advance past the first retry delay (100ms with DETERMINISTIC_POLICY)
            jest.advanceTimersByTime(100);

            // Second attempt fires and succeeds — flush it
            await Promise.resolve();
            await Promise.resolve();

            expect(manager.isReady()).toBe(true);

            let resolved = false;
            // eslint-disable-next-line promise/always-return -- side-effect setter, no return value needed
            void manager.ready.then(() => {
                resolved = true;
            });
            await Promise.resolve();
            expect(resolved).toBe(true);
        });

        it('should call warmCache twice: once per attempt', async () => {
            let callCount = 0;
            const backend = createMockBackend(() => {
                callCount += 1;
                if(callCount === 1) {
                    throw new Error('transient failure');
                }
                return Promise.resolve([]);
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // First failure
            await Promise.resolve();
            await Promise.resolve();

            const backendMock = backend.getChannelsByGuild as ReturnType<typeof mock>;
            const callsAfterFirstAttempt = backendMock.mock.calls.length;
            expect(callsAfterFirstAttempt).toBeGreaterThanOrEqual(1);

            // Trigger retry
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();

            // Second warmCache() has happened
            expect(backendMock.mock.calls.length).toBeGreaterThan(callsAfterFirstAttempt);
        });
    });

    // -----------------------------------------------------------------------
    // Multiple consecutive failures
    // -----------------------------------------------------------------------

    describe('multiple consecutive failures', () => {
        it('should keep retrying — attempt count grows with each timer advance', async () => {
            let warmCacheCallCount = 0;
            const backend = createMockBackend(() => {
                warmCacheCallCount += 1;
                throw new Error(`failure #${warmCacheCallCount}`);
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // Flush first attempt (failure)
            await Promise.resolve();
            await Promise.resolve();
            expect(warmCacheCallCount).toBe(1);
            expect(manager.isReady()).toBe(false);

            // Advance past delay for attempt 1 (100ms) → attempt 2 fires
            jest.advanceTimersByTime(100);
            await Promise.resolve();
            await Promise.resolve();
            expect(warmCacheCallCount).toBe(2);
            expect(manager.isReady()).toBe(false);

            // Advance past delay for attempt 2 (200ms with multiplier=2) → attempt 3 fires
            jest.advanceTimersByTime(200);
            await Promise.resolve();
            await Promise.resolve();
            expect(warmCacheCallCount).toBe(3);
            expect(manager.isReady()).toBe(false);

            loop.stop(); // Prevent timer leak
        });

        it('should use exponential backoff between retries', async () => {
            let warmCacheCallCount = 0;
            const backend = createMockBackend(() => {
                warmCacheCallCount += 1;
                throw new Error('always fails');
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // First failure
            await Promise.resolve();
            await Promise.resolve();
            expect(warmCacheCallCount).toBe(1);

            // Before delay(1)=100ms, no retry
            jest.advanceTimersByTime(99);
            expect(warmCacheCallCount).toBe(1);

            // At 100ms, second attempt fires
            jest.advanceTimersByTime(1);
            expect(warmCacheCallCount).toBe(2);
            await Promise.resolve();
            await Promise.resolve();

            // Before delay(2)=200ms, no retry
            jest.advanceTimersByTime(199);
            expect(warmCacheCallCount).toBe(2);

            // At 200ms more, third attempt fires
            jest.advanceTimersByTime(1);
            expect(warmCacheCallCount).toBe(3);

            loop.stop();
        });
    });

    // -----------------------------------------------------------------------
    // stop() lifecycle
    // -----------------------------------------------------------------------

    describe('stop() cancels the hydration loop', () => {
        it('should cancel pending retry timer so no further warmCache calls fire', async () => {
            let warmCacheCallCount = 0;
            const backend = createMockBackend(() => {
                warmCacheCallCount += 1;
                throw new Error('always fails');
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);

            // First attempt fails — pending retry timer registered
            await Promise.resolve();
            await Promise.resolve();
            expect(warmCacheCallCount).toBe(1);
            expect(jest.getTimerCount()).toBe(1);

            // Stop via manager
            manager.stop();

            // Timer should be cleared
            expect(jest.getTimerCount()).toBe(0);

            // Advance past what would have been the retry delay
            jest.advanceTimersByTime(500);

            // No further warmCache calls
            expect(warmCacheCallCount).toBe(1);
        });

        it('should not schedule further retries if stopped before first attempt resolves', async () => {
            let rejectConnect!: (e: Error) => void;
            const backend = createMockBackend(() => new Promise<never>((_resolve, reject) => {
                rejectConnect = reject;
            }));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop);
            // First attempt is in-flight

            manager.stop(); // Stop before the attempt completes

            // Now reject the in-flight attempt
            rejectConnect(new Error('late failure'));
            await Promise.resolve();
            await Promise.resolve();

            // No timer should be set because loop was stopped
            expect(jest.getTimerCount()).toBe(0);

            // isReady() stays false
            expect(manager.isReady()).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Guard: only one loop at a time
    // -----------------------------------------------------------------------

    describe('single loop guard', () => {
        it('should throw or ignore a second startHydration call (no duplicate loops)', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop1 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });
            const loop2 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop1);

            // Second call should throw (already started)
            expect(() => manager.startHydration(loop2)).toThrow();

            // Flush
            await Promise.resolve();
            await Promise.resolve();

            manager.stop();
        });

        it('should allow startHydration again after stop() — stop() clears the loop reference', async () => {
            // Bug 3 regression test: stop() must set hydrationLoop = undefined so that a
            // subsequent startHydration() does not throw "already started".
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const loop1 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop1);

            // Flush first hydration attempt
            await Promise.resolve();
            await Promise.resolve();

            // Stop the loop — must clear hydrationLoop reference
            manager.stop();

            // Now start again with a new loop — should NOT throw
            const loop2 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            expect(() => manager.startHydration(loop2)).not.toThrow();

            // Flush second hydration
            await Promise.resolve();
            await Promise.resolve();

            manager.stop();
        });

        // ---------------------------------------------------------------------------
        // Fix 6: stop() resets the ready Promise so the gate re-arms for next cycle
        // ---------------------------------------------------------------------------

        it('Fix 6: stop() resets ready to pending and isReady() to false; re-hydration re-resolves ready', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            // First hydration cycle
            const loop1 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop1);

            // Flush first warmCache
            await Promise.resolve();
            await Promise.resolve();

            // After first hydration, ready should be resolved and isReady() true
            expect(manager.isReady()).toBe(true);
            let ready1Resolved = false;
            // eslint-disable-next-line promise/always-return -- side-effect setter
            void manager.ready.then(() => {
                ready1Resolved = true;
            });
            await Promise.resolve();
            expect(ready1Resolved).toBe(true);

            // stop() — must reset ready to pending and isReady() to false
            manager.stop();

            expect(manager.isReady()).toBe(false);

            // ready must now be pending (race vs immediate resolve should give timeout)
            const raceResult = await Promise.race([
                manager.ready.then(() => 'resolved'),
                Promise.resolve('timeout'),
            ]);
            expect(raceResult).toBe('timeout');

            // Second hydration cycle — re-arm the gate
            const loop2 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });

            manager.startHydration(loop2);

            // Flush second warmCache
            await Promise.resolve();
            await Promise.resolve();

            // After second hydration, ready resolves again and isReady() is true again
            expect(manager.isReady()).toBe(true);

            let ready2Resolved = false;
            // eslint-disable-next-line promise/always-return -- side-effect setter
            void manager.ready.then(() => {
                ready2Resolved = true;
            });
            await Promise.resolve();
            expect(ready2Resolved).toBe(true);

            manager.stop();
        });
    });

    // -----------------------------------------------------------------------
    // warmCache() directly still works (for callers that don't use the loop)
    // -----------------------------------------------------------------------

    describe('warmCache() called directly (without startHydration)', () => {
        it('should still work and resolve ready / set isReady', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            await manager.warmCache();

            expect(manager.isReady()).toBe(true);
        });

        it('should throw on failure (existing behaviour preserved)', async () => {
            const backend = createMockBackend(() => {
                throw new Error('DynamoDB down');
            });
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            expect(manager.warmCache()).rejects.toThrow('DynamoDB down');
            expect(manager.isReady()).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Fix 5: onReady callbacks — .catch prevents unhandled rejections
    // -------------------------------------------------------------------------
    describe('Fix 5: onReady callback rejection is caught and logged', () => {
        it('logs error and does not throw unhandled rejection when onReady callback rejects', async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy mock; only call presence matters, return value ignored
            const errorSpy = jest.spyOn(loggerModule.logger, 'error').mockImplementation((_args: any) => loggerModule.logger);

            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const rejectingCallback = async (): Promise<void> => {
                throw new Error('callback boom');
            };
            manager.onReady(rejectingCallback);

            // Trigger warmCache — should resolve ready and fire the callback
            await manager.warmCache();

            // Flush promise chain (callback fires after warmCache resolves)
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // logger.error should have been called with the rejection
            expect(errorSpy).toHaveBeenCalledWith(
                expect.objectContaining({ msg: 'onReady callback rejected' })
            );

            errorSpy.mockRestore();
        });
    });

    // -------------------------------------------------------------------------
    // Fix 9: offReady — unregister a registered callback
    // -------------------------------------------------------------------------
    describe('Fix 9: offReady removes a registered callback', () => {
        it('removed callback does not fire after offReady', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            let callCount = 0;
            const cb = (): void => {
                callCount++;
            };

            manager.onReady(cb);
            manager.offReady(cb);

            await manager.warmCache();
            await Promise.resolve();
            await Promise.resolve();

            // Callback was removed before warmCache — should not have fired
            expect(callCount).toBe(0);
        });

        it('non-removed callback still fires after offReady for another callback', async () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            let countA = 0;
            let countB = 0;
            const cbA = (): void => {
                countA++;
            };
            const cbB = (): void => {
                countB++;
            };

            manager.onReady(cbA);
            manager.onReady(cbB);
            manager.offReady(cbA); // only remove A

            await manager.warmCache();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(countA).toBe(0); // removed
            expect(countB).toBe(1); // still fires
        });

        it('offReady on a never-registered callback is a no-op', () => {
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            const unregistered = (): void => undefined;
            // Should not throw
            expect(() => manager.offReady(unregistered)).not.toThrow();
        });

        it('Fix 8: callback registered then unregistered fires 0 times even across stop/restart cycle', async () => {
            // Regression test for Fix 8: offReady after ready resolves must prevent re-fire on next cycle
            const backend = createMockBackend(() => Promise.resolve([]));
            const client = createMockClient();
            const manager = new ChannelRegistryManager({ backend, homeGuildId, client });

            let callCount = 0;
            const cb = (): void => {
                callCount++;
            };

            // Step 1: Register callback
            manager.onReady(cb);

            // Step 2: warmCache() → ready resolves → cb fires
            await manager.warmCache();
            await Promise.resolve();
            await Promise.resolve();
            expect(callCount).toBe(1);

            // Step 3: offReady() — unregister the callback
            manager.offReady(cb);

            // Step 4: stop() resets the ready gate
            manager.stop();

            // Step 5: startHydration with a new loop + warmCache resolves
            const loop2 = createReconnectionLoop({
                service:   SERVICE,
                registry,
                connectFn: () => manager.warmCache(),
                policy:    DETERMINISTIC_POLICY,
            });
            manager.startHydration(loop2);

            // Flush second warmCache
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Step 6: cb must NOT have fired again (was offReady'd before second cycle)
            expect(callCount).toBe(1);

            manager.stop();
        });
    });
});
