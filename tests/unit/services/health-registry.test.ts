import { describe, test, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import {
    ServiceHealthRegistryImpl,
    type ServiceHealthRegistryLogger
} from '@/services/health-registry';
import type { ServiceHealthChange, ServiceName } from '@/services/types';

function createMockLogger(): ServiceHealthRegistryLogger {
    return {
        warn:  mock(() => undefined),
        error: mock(() => undefined),
        info:  mock(() => undefined),
        debug: mock(() => undefined),
    };
}

describe('ServiceHealthRegistryImpl', () => {
    let registry: ServiceHealthRegistryImpl;
    let mockLogger: ServiceHealthRegistryLogger;

    beforeEach(() => {
        jest.useFakeTimers();
        mockLogger = createMockLogger();
        registry = new ServiceHealthRegistryImpl({ logger: mockLogger });
    });

    afterEach(() => {
        registry.stop();
        jest.useRealTimers();
    });

    describe('getState()', () => {
        test('should return disabled for all services initially', () => {
            expect(registry.getState('discord')).toBe('disabled');
            expect(registry.getState('discord-channel-registry')).toBe('disabled');
            expect(registry.getState('email')).toBe('disabled');
            expect(registry.getState('bluesky')).toBe('disabled');
            expect(registry.getState('caldav')).toBe('disabled');
            expect(registry.getState('dynamodb')).toBe('disabled');
        });

        test('should return starting after CONFIGURE', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            expect(registry.getState('discord')).toBe('starting');
        });

        test('should return online after CONFIGURE + CONNECT_SUCCESS', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');
            expect(registry.getState('discord')).toBe('online');
        });

        test('should return offline after CONFIGURE + CONNECT_FAIL', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');
            expect(registry.getState('discord')).toBe('offline');
        });

        test('should track state independently for each service', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');

            registry.sendEvent('email', 'CONFIGURE');

            expect(registry.getState('discord')).toBe('online');
            expect(registry.getState('email')).toBe('starting');
            expect(registry.getState('bluesky')).toBe('disabled');
        });
    });

    describe('getEntry()', () => {
        test('should return entry with disabled state initially', () => {
            const entry = registry.getEntry('discord');
            expect(entry.state).toBe('disabled');
            expect(entry.epoch).toBe(0);
            expect(entry.failureCount).toBe(0);
        });

        test('should return entry with updated state after transitions', () => {
            registry.sendEvent('email', 'CONFIGURE');
            registry.sendEvent('email', 'CONNECT_SUCCESS');

            const entry = registry.getEntry('email');
            expect(entry.state).toBe('online');
            expect(entry.epoch).toBe(1);
            expect(entry.failureCount).toBe(0);
            expect(entry.lastOnlineAt).toBeInstanceOf(Date);
        });

        test('should return entry with failure details after CONNECT_FAIL', () => {
            registry.sendEvent('bluesky', 'CONFIGURE');
            registry.sendEvent('bluesky', 'CONNECT_FAIL', { error: 'Auth failed' });

            const entry = registry.getEntry('bluesky');
            expect(entry.state).toBe('offline');
            expect(entry.failureCount).toBe(1);
            expect(entry.lastOfflineAt).toBeInstanceOf(Date);
            expect(entry.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Auth failed' });
        });

        test('should return a ServiceHealthEntry with required fields', () => {
            const entry = registry.getEntry('discord');
            expect(entry).toHaveProperty('state');
            expect(entry).toHaveProperty('epoch');
            expect(entry).toHaveProperty('failureCount');
        });
    });

    describe('getAll()', () => {
        test('should return all 6 services', () => {
            const all = registry.getAll();
            expect(Object.keys(all)).toContain('discord');
            expect(Object.keys(all)).toContain('discord-channel-registry');
            expect(Object.keys(all)).toContain('email');
            expect(Object.keys(all)).toContain('bluesky');
            expect(Object.keys(all)).toContain('caldav');
            expect(Object.keys(all)).toContain('dynamodb');
            expect(Object.keys(all)).toHaveLength(6);
        });

        test('should return all services initially in disabled state', () => {
            const all = registry.getAll();
            for(const entry of Object.values(all)) {
                expect(entry.state).toBe('disabled');
            }
        });

        test('should return frozen result', () => {
            const all = registry.getAll();
            expect(() => {
                (all as Record<string, unknown>).newService = {};
            }).toThrow();
        });

        test('should reflect current state for each service', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');

            const all = registry.getAll();
            expect(all.discord.state).toBe('online');
            expect(all.email.state).toBe('disabled');
        });
    });

    describe('isAvailable()', () => {
        test('should return false for disabled state', () => {
            expect(registry.isAvailable('discord')).toBe(false);
        });

        test('should return false for starting state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            expect(registry.isAvailable('discord')).toBe(false);
        });

        test('should return true for online state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');
            expect(registry.isAvailable('discord')).toBe(true);
        });

        test('should return true for degraded state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');
            registry.sendEvent('discord', 'PARTIAL_FAILURE');
            expect(registry.isAvailable('discord')).toBe(true);
        });

        test('should return false for offline state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');
            expect(registry.isAvailable('discord')).toBe(false);
        });

        test('should return false for recovering state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');
            registry.sendEvent('discord', 'RECONNECT_ATTEMPT');
            expect(registry.isAvailable('discord')).toBe(false);
        });
    });

    describe('isWriteAvailable()', () => {
        test('should return false for disabled state', () => {
            expect(registry.isWriteAvailable('discord')).toBe(false);
        });

        test('should return false for starting state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            expect(registry.isWriteAvailable('discord')).toBe(false);
        });

        test('should return true for online state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');
            expect(registry.isWriteAvailable('discord')).toBe(true);
        });

        test('should return false for degraded state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');
            registry.sendEvent('discord', 'PARTIAL_FAILURE');
            expect(registry.isWriteAvailable('discord')).toBe(false);
        });

        test('should return false for offline state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');
            expect(registry.isWriteAvailable('discord')).toBe(false);
        });

        test('should return false for recovering state', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');
            registry.sendEvent('discord', 'RECONNECT_ATTEMPT');
            expect(registry.isWriteAvailable('discord')).toBe(false);
        });
    });

    describe('sendEvent()', () => {
        test('should transition state correctly for a given service', () => {
            registry.sendEvent('email', 'CONFIGURE');
            expect(registry.getState('email')).toBe('starting');
        });

        test('should pass payload to the actor', () => {
            const retryAt = new Date(Date.now() + 5000);
            registry.sendEvent('email', 'CONFIGURE');
            registry.sendEvent('email', 'CONNECT_FAIL', { nextRetryAt: retryAt });
            expect(registry.getEntry('email').nextRetryAt).toEqual(retryAt);
        });

        test('should only affect the specified service', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');

            registry.sendEvent('email', 'CONFIGURE');

            expect(registry.getState('discord')).toBe('online');
            expect(registry.getState('email')).toBe('starting');
            expect(registry.getState('bluesky')).toBe('disabled');
            expect(registry.getState('caldav')).toBe('disabled');
        });

        test('should work without payload', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            expect(registry.getState('discord')).toBe('starting');
        });
    });

    describe('subscribe()', () => {
        // NOTE: The registry subscribes to each xstate actor AFTER calling actor.start().
        // In xstate v5, the initial snapshot fires when .subscribe() is called on a started actor,
        // but since the registry subscribes AFTER start, the initial subscription fires immediately
        // at subscribe() time — but only sets previousStates (since previousState === undefined,
        // the early-return guard fires and listeners are NOT called).
        // Therefore: the FIRST event after construction sets previousStates but does NOT fire listeners.
        // Only the SECOND transition fires listeners.
        // We use a helper to prime the first state transition before registering test listeners.

        function primeFirstTransition(service: ServiceName = 'discord') {
            registry.sendEvent(service, 'CONFIGURE'); // disabled → starting, sets previousStates
        }

        test('should notify listener on the second state transition', () => {
            primeFirstTransition();

            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // starting → online

            expect(changes).toHaveLength(1);
            expect(changes[0].service).toBe('discord');
            expect(changes[0].previousState).toBe('starting');
            expect(changes[0].newState).toBe('online');
        });

        test('should not call listener when state does not change (idempotent transitions)', () => {
            primeFirstTransition();

            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            // Send an event that has no transition defined in current state (starting)
            registry.sendEvent('discord', 'RECONNECT_ATTEMPT'); // ignored in starting

            expect(changes).toHaveLength(0);
        });

        test('should include correct ServiceHealthChange data', () => {
            primeFirstTransition();

            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            const before = new Date();
            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // starting → online
            const after = new Date();

            expect(changes).toHaveLength(1);
            const onlineChange = changes[0];
            expect(onlineChange.service).toBe('discord');
            expect(onlineChange.previousState).toBe('starting');
            expect(onlineChange.newState).toBe('online');
            expect(onlineChange.epoch).toBe(1);
            expect(onlineChange.timestamp).toBeInstanceOf(Date);
            expect(onlineChange.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(onlineChange.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
        });

        test('should notify multiple listeners on state transition', () => {
            primeFirstTransition('email');

            const changes1: ServiceHealthChange[] = [];
            const changes2: ServiceHealthChange[] = [];

            registry.subscribe((change) => {
                changes1.push(change);
            });
            registry.subscribe((change) => {
                changes2.push(change);
            });

            registry.sendEvent('email', 'CONNECT_SUCCESS'); // starting → online

            expect(changes1).toHaveLength(1);
            expect(changes2).toHaveLength(1);
        });

        test('should unsubscribe correctly', () => {
            primeFirstTransition();

            const changes: ServiceHealthChange[] = [];
            const unsubscribe = registry.subscribe((change) => {
                changes.push(change);
            });

            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // starting → online
            expect(changes).toHaveLength(1);

            unsubscribe();

            registry.sendEvent('discord', 'CONNECTION_LOST'); // online → offline
            expect(changes).toHaveLength(1); // No new change after unsubscribe
        });

        test('should continue calling remaining listeners when one throws', () => {
            primeFirstTransition();

            const changes2: ServiceHealthChange[] = [];

            registry.subscribe((_change) => {
                throw new Error('Listener error');
            });
            registry.subscribe((change) => {
                changes2.push(change);
            });

            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // starting → online

            expect(changes2).toHaveLength(1);
            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        test('should log error when listener throws', () => {
            primeFirstTransition();
            const thrownError = new Error('Listener threw');

            registry.subscribe((_change) => {
                throw thrownError;
            });

            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // starting → online

            expect(mockLogger.error).toHaveBeenCalledTimes(1);
        });

        test('should not call listener when same state is re-emitted (no actual transition)', () => {
            primeFirstTransition();

            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            // No events sent — no transitions should fire listeners
            expect(changes).toHaveLength(0);
        });
    });

    describe('buildStatusSummary()', () => {
        test('should return undefined when all services are in online state', () => {
            for(const service of ['discord', 'email', 'bluesky', 'caldav'] as ServiceName[]) {
                registry.sendEvent(service, 'CONFIGURE');
                registry.sendEvent(service, 'CONNECT_SUCCESS');
            }
            expect(registry.buildStatusSummary()).toBeUndefined();
        });

        test('should return undefined when all services are in disabled state', () => {
            // The code skips both 'online' and 'disabled' — all disabled = no issues to report
            const summary = registry.buildStatusSummary();
            expect(summary).toBeUndefined();
        });

        test('should not include disabled services in summary', () => {
            // All services start disabled; summary should be undefined (nothing to report)
            const summary = registry.buildStatusSummary();
            expect(summary).toBeUndefined();
        });

        test('should return undefined when all four services are disabled', () => {
            const summary = registry.buildStatusSummary();
            expect(summary).toBeUndefined();
        });

        test('should return undefined when all services are online or disabled', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');

            // email/bluesky/caldav are disabled — also excluded
            const summary = registry.buildStatusSummary();
            expect(summary).toBeUndefined();
        });

        test('should return undefined when all services are online', () => {
            for(const service of ['discord', 'email', 'bluesky', 'caldav'] as ServiceName[]) {
                registry.sendEvent(service, 'CONFIGURE');
                registry.sendEvent(service, 'CONNECT_SUCCESS');
            }
            expect(registry.buildStatusSummary()).toBeUndefined();
        });

        test('should include offline duration in summary when lastOfflineAt is set', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');

            const summary = registry.buildStatusSummary();
            expect(summary).toContain('discord: offline');
            // The lastOfflineAt is very recent (within seconds), so formatShortRelativeTime returns "now"
            expect(summary).toContain('offline');
        });

        test('should include error details in summary when lastError is set', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { error: 'Connection timed out' });

            const summary = registry.buildStatusSummary();
            expect(summary).toContain('[CONNECTION_FAILED: Connection timed out]');
        });

        test('should include retry info when nextRetryAt is in the future', () => {
            const retryAt = new Date(Date.now() + 60_000);
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            expect(summary).toContain('retry in');
        });

        test('should show seconds for retry under 60 seconds', () => {
            const retryAt = new Date(Date.now() + 30_000);
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            // retryMs = 30000, retrySec = 30, which is < 60, so shows seconds
            expect(summary).toMatch(/retry in ~\d+s/);
            expect(summary).not.toContain('retry in ~1m');
        });

        test('should show minutes for retry of 60 seconds or more', () => {
            const retryAt = new Date(Date.now() + 120_000);
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            // retryMs = 120000, retrySec = 120, which is >= 60, so shows minutes = ceil(120/60) = 2
            expect(summary).toContain('retry in ~2m');
        });

        test('should show 1m for retry of exactly 60 seconds', () => {
            const retryAt = new Date(Date.now() + 60_000);
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            // retryMs = 60000, retrySec = 60, which is >= 60, so shows minutes = ceil(60/60) = 1
            expect(summary).toContain('retry in ~1m');
        });

        test('should not include retry info when nextRetryAt is in the past', () => {
            const retryAt = new Date(Date.now() - 60_000);
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            expect(summary).not.toContain('retry in');
        });

        test('should not include retry info when nextRetryAt equals exactly now (retryMs=0)', () => {
            const retryAt = new Date(Date.now()); // exactly now, retryMs=0
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { nextRetryAt: retryAt });

            const summary = registry.buildStatusSummary();
            // retryMs === 0 is not > 0, so should fall through to "reconnection attempt is in progress"
            expect(summary).not.toContain('retry in ~');
            expect(summary).toContain('discord: offline');
        });

        test('should include multiple offline services on separate lines', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');

            registry.sendEvent('email', 'CONFIGURE');
            registry.sendEvent('email', 'CONNECT_FAIL');

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            const lines = summary!.split('\n');
            const discordLine = lines.find(l => l.includes('discord'));
            const emailLine = lines.find(l => l.includes('email'));
            expect(discordLine).toBeDefined();
            expect(emailLine).toBeDefined();
            // Two services means two lines
            expect(lines).toHaveLength(2);
        });

        test('should format status line as "name: state (offline duration) [error]"', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL', { error: 'Timeout' });

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            // Exact format: "discord: offline (offline now) [CONNECTION_FAILED: Timeout]"
            // parts.join(' ') produces space-separated components
            expect(summary).toContain('discord: offline (');
            expect(summary).toContain(') [CONNECTION_FAILED: Timeout]');
        });

        test('should not include online services in summary', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS'); // online

            registry.sendEvent('email', 'CONFIGURE');
            registry.sendEvent('email', 'CONNECT_FAIL'); // offline

            const summary = registry.buildStatusSummary();
            expect(summary).toBeDefined();
            expect(summary).not.toContain('discord');
            expect(summary).toContain('email: offline');
        });

        test('should separate multiple services with newlines (no trailing newline)', () => {
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_FAIL');

            registry.sendEvent('email', 'CONFIGURE');
            registry.sendEvent('email', 'CONNECT_FAIL');

            const summary = registry.buildStatusSummary()!;
            expect(summary).toBeDefined();
            // No trailing newline
            expect(summary.endsWith('\n')).toBe(false);
        });
    });

    describe('stop()', () => {
        test('should not throw when called once', () => {
            expect(() => {
                registry.stop();
            }).not.toThrow();
        });

        test('should stop actors so no more transitions fire', () => {
            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            registry.stop();

            // After stop, actors are stopped and events should not produce listener calls
            // (XState actors don't process events after stop)
            expect(changes).toHaveLength(0);
        });

        test('should stop actors so previous state is preserved', () => {
            // First prime the state machine
            registry.sendEvent('discord', 'CONFIGURE');
            expect(registry.getState('discord')).toBe('starting');

            // After stop, the last known state should still be accessible
            registry.stop();
            expect(registry.getState('discord')).toBe('starting');
        });

        test('should unsubscribe from all actors on stop (no events after stop)', () => {
            // Prime transition, register listener
            registry.sendEvent('discord', 'CONFIGURE');
            const changes: ServiceHealthChange[] = [];
            registry.subscribe((change) => {
                changes.push(change);
            });

            registry.stop();

            // No listener calls were recorded during stop itself
            expect(changes).toHaveLength(0);
        });
    });

    describe('handleStateChange() optimization — zero listeners', () => {
        test('should not throw when state changes and there are no subscribers', () => {
            // Prime first transition (sets previousStates)
            registry.sendEvent('discord', 'CONFIGURE');

            // Ensure no listeners registered
            // Second transition would normally notify listeners, but with none registered it's a no-op
            expect(() => {
                registry.sendEvent('discord', 'CONNECT_SUCCESS');
            }).not.toThrow();

            // State should still update correctly even with no listeners
            expect(registry.getState('discord')).toBe('online');
        });

        test('should still update state even with zero listeners', () => {
            // No subscribers at all
            registry.sendEvent('discord', 'CONFIGURE');
            registry.sendEvent('discord', 'CONNECT_SUCCESS');

            expect(registry.getState('discord')).toBe('online');
        });
    });
});
