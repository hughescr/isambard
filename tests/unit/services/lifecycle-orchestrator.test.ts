import { describe, test, expect } from 'bun:test';
import { createActor } from 'xstate';
import { serviceLifecycleMachine, createServiceActor } from '@/services/lifecycle-orchestrator';

// Helper to build an actor, start it, and send it to a desired state quickly
function actorInState(targetState: 'disabled' | 'starting' | 'online' | 'offline' | 'recovering' | 'degraded') {
    const actor = createActor(serviceLifecycleMachine);
    actor.start();

    if(targetState === 'disabled') {
        return actor;
    }

    // disabled → starting
    actor.send({ type: 'CONFIGURE' });
    if(targetState === 'starting') {
        return actor;
    }

    if(targetState === 'online') {
        actor.send({ type: 'CONNECT_SUCCESS' });
        return actor;
    }

    if(targetState === 'degraded') {
        actor.send({ type: 'CONNECT_SUCCESS' });
        actor.send({ type: 'PARTIAL_FAILURE' });
        return actor;
    }

    // offline path from starting
    actor.send({ type: 'CONNECT_FAIL' });
    if(targetState === 'offline') {
        return actor;
    }

    // offline → recovering
    actor.send({ type: 'RECONNECT_ATTEMPT' });
    return actor; // recovering
}

describe('serviceLifecycleMachine', () => {
    describe('initial state', () => {
        test('should start in disabled state', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();
            expect(actor.getSnapshot().value).toBe('disabled');
            actor.stop();
        });

        test('should have zeroed initial context', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();
            const ctx = actor.getSnapshot().context;
            expect(ctx.epoch).toBe(0);
            expect(ctx.failureCount).toBe(0);
            expect(ctx.lastOnlineAt).toBeUndefined();
            expect(ctx.lastOfflineAt).toBeUndefined();
            expect(ctx.lastError).toBeUndefined();
            expect(ctx.nextRetryAt).toBeUndefined();
            actor.stop();
        });
    });

    describe('disabled state transitions', () => {
        test('should transition disabled → starting on CONFIGURE', () => {
            const actor = actorInState('disabled');
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().value).toBe('starting');
            actor.stop();
        });

        test('should increment epoch on CONFIGURE', () => {
            const actor = actorInState('disabled');
            expect(actor.getSnapshot().context.epoch).toBe(0);
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().context.epoch).toBe(1);
            actor.stop();
        });

        test('should ignore CONNECT_SUCCESS in disabled state', () => {
            const actor = actorInState('disabled');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().value).toBe('disabled');
            actor.stop();
        });

        test('should ignore CONNECT_FAIL in disabled state', () => {
            const actor = actorInState('disabled');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().value).toBe('disabled');
            actor.stop();
        });

        test('should ignore CONNECTION_LOST in disabled state', () => {
            const actor = actorInState('disabled');
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().value).toBe('disabled');
            actor.stop();
        });

        test('should ignore RECONNECT_ATTEMPT in disabled state', () => {
            const actor = actorInState('disabled');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('disabled');
            actor.stop();
        });
    });

    describe('starting state transitions', () => {
        test('should transition starting → online on CONNECT_SUCCESS', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should set lastOnlineAt on CONNECT_SUCCESS from starting', () => {
            const before = new Date();
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_SUCCESS' });
            const after = new Date();
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastOnlineAt).toBeInstanceOf(Date);
            expect(ctx.lastOnlineAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(ctx.lastOnlineAt!.getTime()).toBeLessThanOrEqual(after.getTime());
            actor.stop();
        });

        test('should reset failureCount to 0 on CONNECT_SUCCESS from starting', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().context.failureCount).toBe(0);
            actor.stop();
        });

        test('should clear lastError on CONNECT_SUCCESS from starting', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().context.lastError).toBeUndefined();
            actor.stop();
        });

        test('should transition starting → offline on CONNECT_FAIL', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });

        test('should increment failureCount on CONNECT_FAIL from starting', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(1);
            actor.stop();
        });

        test('should set lastOfflineAt on CONNECT_FAIL from starting', () => {
            const before = new Date();
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL' });
            const after = new Date();
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastOfflineAt).toBeInstanceOf(Date);
            expect(ctx.lastOfflineAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(ctx.lastOfflineAt!.getTime()).toBeLessThanOrEqual(after.getTime());
            actor.stop();
        });

        test('should set lastError from error string on CONNECT_FAIL', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL', error: 'Connection refused' });
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Connection refused' });
            actor.stop();
        });

        test('should not set lastError when no error string on CONNECT_FAIL', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.lastError).toBeUndefined();
            actor.stop();
        });

        test('should set nextRetryAt from event on CONNECT_FAIL', () => {
            const retryAt = new Date(Date.now() + 5000);
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL', nextRetryAt: retryAt });
            expect(actor.getSnapshot().context.nextRetryAt).toEqual(retryAt);
            actor.stop();
        });

        test('should set nextRetryAt to undefined when not provided on CONNECT_FAIL', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.nextRetryAt).toBeUndefined();
            actor.stop();
        });

        test('should ignore RECONNECT_ATTEMPT in starting state', () => {
            const actor = actorInState('starting');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('starting');
            actor.stop();
        });
    });

    describe('online state transitions', () => {
        test('should transition online → offline on CONNECTION_LOST', () => {
            const actor = actorInState('online');
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });

        test('should increment epoch on CONNECTION_LOST from online', () => {
            const actor = actorInState('online');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
            actor.stop();
        });

        test('should record offline details on CONNECTION_LOST from online', () => {
            const actor = actorInState('online');
            actor.send({ type: 'CONNECTION_LOST', error: 'Timed out' });
            const ctx = actor.getSnapshot().context;
            expect(ctx.failureCount).toBe(1);
            expect(ctx.lastOfflineAt).toBeInstanceOf(Date);
            expect(ctx.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Timed out' });
            actor.stop();
        });

        test('should transition online → degraded on PARTIAL_FAILURE', () => {
            const actor = actorInState('online');
            actor.send({ type: 'PARTIAL_FAILURE' });
            expect(actor.getSnapshot().value).toBe('degraded');
            actor.stop();
        });

        test('should not change epoch on PARTIAL_FAILURE', () => {
            const actor = actorInState('online');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'PARTIAL_FAILURE' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore);
            actor.stop();
        });

        test('should ignore CONFIGURE in online state', () => {
            const actor = actorInState('online');
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should ignore CONNECT_SUCCESS in online state', () => {
            const actor = actorInState('online');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should ignore RECONNECT_ATTEMPT in online state', () => {
            const actor = actorInState('online');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should ignore RECOVERY_FAIL in online state', () => {
            const actor = actorInState('online');
            actor.send({ type: 'RECOVERY_FAIL' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });
    });

    describe('degraded state transitions', () => {
        test('should transition degraded → online on RECOVERED', () => {
            const actor = actorInState('degraded');
            actor.send({ type: 'RECOVERED' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should set lastOnlineAt and reset failureCount on RECOVERED from degraded', () => {
            const actor = actorInState('degraded');
            actor.send({ type: 'RECOVERED' });
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastOnlineAt).toBeInstanceOf(Date);
            expect(ctx.failureCount).toBe(0);
            actor.stop();
        });

        test('should transition degraded → offline on CONNECTION_LOST', () => {
            const actor = actorInState('degraded');
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });

        test('should increment epoch on CONNECTION_LOST from degraded', () => {
            const actor = actorInState('degraded');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
            actor.stop();
        });

        test('should ignore CONFIGURE in degraded state', () => {
            const actor = actorInState('degraded');
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().value).toBe('degraded');
            actor.stop();
        });

        test('should ignore RECONNECT_ATTEMPT in degraded state', () => {
            const actor = actorInState('degraded');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('degraded');
            actor.stop();
        });
    });

    describe('offline state transitions', () => {
        test('should transition offline → recovering on RECONNECT_ATTEMPT', () => {
            const actor = actorInState('offline');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('recovering');
            actor.stop();
        });

        test('should NOT increment epoch on RECONNECT_ATTEMPT from offline', () => {
            const actor = actorInState('offline');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore);
            actor.stop();
        });

        test('should transition offline → starting on CONFIGURE', () => {
            const actor = actorInState('offline');
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().value).toBe('starting');
            actor.stop();
        });

        test('should increment epoch on CONFIGURE from offline', () => {
            const actor = actorInState('offline');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
            actor.stop();
        });

        test('should transition offline → online on CONNECT_SUCCESS', () => {
            const actor = actorInState('offline');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should set lastOnlineAt and reset failureCount on CONNECT_SUCCESS from offline', () => {
            const before = new Date();
            const actor = actorInState('offline');
            actor.send({ type: 'CONNECT_SUCCESS' });
            const after = new Date();
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastOnlineAt).toBeInstanceOf(Date);
            expect(ctx.lastOnlineAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(ctx.lastOnlineAt!.getTime()).toBeLessThanOrEqual(after.getTime());
            expect(ctx.failureCount).toBe(0);
            actor.stop();
        });

        test('should ignore CONNECTION_LOST in offline state', () => {
            const actor = actorInState('offline');
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });
    });

    describe('recovering state transitions', () => {
        test('should transition recovering → online on CONNECT_SUCCESS', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().value).toBe('online');
            actor.stop();
        });

        test('should set lastOnlineAt and reset failureCount on CONNECT_SUCCESS from recovering', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'CONNECT_SUCCESS' });
            const ctx = actor.getSnapshot().context;
            expect(ctx.lastOnlineAt).toBeInstanceOf(Date);
            expect(ctx.failureCount).toBe(0);
            actor.stop();
        });

        test('should transition recovering → offline on CONNECT_FAIL', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });

        test('should increment failureCount on CONNECT_FAIL from recovering', () => {
            const actor = actorInState('recovering');
            const failureBefore = actor.getSnapshot().context.failureCount;
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(failureBefore + 1);
            actor.stop();
        });

        test('should transition recovering → offline on RECOVERY_FAIL', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'RECOVERY_FAIL' });
            expect(actor.getSnapshot().value).toBe('offline');
            actor.stop();
        });

        test('should increment failureCount on RECOVERY_FAIL', () => {
            const actor = actorInState('recovering');
            const failureBefore = actor.getSnapshot().context.failureCount;
            actor.send({ type: 'RECOVERY_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(failureBefore + 1);
            actor.stop();
        });

        test('should set lastError on RECOVERY_FAIL with error string', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'RECOVERY_FAIL', error: 'Auth failed' });
            expect(actor.getSnapshot().context.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Auth failed' });
            actor.stop();
        });

        test('should ignore CONFIGURE in recovering state', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().value).toBe('recovering');
            actor.stop();
        });

        test('should ignore RECONNECT_ATTEMPT in recovering state', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().value).toBe('recovering');
            actor.stop();
        });
    });

    describe('context tracking across multiple transitions', () => {
        test('should accumulate failureCount across multiple failures', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            // First failure cycle
            actor.send({ type: 'CONFIGURE' });
            actor.send({ type: 'CONNECT_FAIL', error: 'error 1' });
            expect(actor.getSnapshot().context.failureCount).toBe(1);

            // Second failure cycle
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_FAIL', error: 'error 2' });
            expect(actor.getSnapshot().context.failureCount).toBe(2);

            // Third failure via RECOVERY_FAIL
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'RECOVERY_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(3);

            actor.stop();
        });

        test('should reset failureCount to 0 on CONNECT_SUCCESS after multiple failures', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            // Two failures
            actor.send({ type: 'CONFIGURE' });
            actor.send({ type: 'CONNECT_FAIL' });
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(2);

            // Recovery
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().context.failureCount).toBe(0);

            actor.stop();
        });

        test('should increment epoch through full cycle disabled → starting → online → offline → recovering → online', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            expect(actor.getSnapshot().context.epoch).toBe(0);

            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().context.epoch).toBe(1);

            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().context.epoch).toBe(1);

            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(2);

            // RECONNECT_ATTEMPT no longer increments epoch — epoch only increments on CONFIGURE and CONNECTION_LOST
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().context.epoch).toBe(2);

            actor.send({ type: 'CONNECT_SUCCESS' });
            expect(actor.getSnapshot().context.epoch).toBe(2);

            actor.stop();
        });

        test('should preserve lastError when new CONNECT_FAIL has no error', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            // First failure with error
            actor.send({ type: 'CONFIGURE' });
            actor.send({ type: 'CONNECT_FAIL', error: 'Initial error' });
            expect(actor.getSnapshot().context.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Initial error' });

            // Second failure with no error — should preserve previous lastError
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Initial error' });

            actor.stop();
        });

        test('should overwrite lastError when new CONNECT_FAIL has error', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            actor.send({ type: 'CONFIGURE' });
            actor.send({ type: 'CONNECT_FAIL', error: 'First error' });
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_FAIL', error: 'Second error' });

            expect(actor.getSnapshot().context.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'Second error' });
            actor.stop();
        });

        test('should set nextRetryAt from event payload and clear it when not provided', () => {
            const retryAt = new Date(Date.now() + 10_000);
            const actor = createActor(serviceLifecycleMachine);
            actor.start();

            actor.send({ type: 'CONFIGURE' });
            actor.send({ type: 'CONNECT_FAIL', nextRetryAt: retryAt });
            expect(actor.getSnapshot().context.nextRetryAt).toEqual(retryAt);

            // Retry without nextRetryAt — should be cleared
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.nextRetryAt).toBeUndefined();

            actor.stop();
        });

        test('should not set nextRetryAt when value is not a Date', () => {
            const actor = createActor(serviceLifecycleMachine);
            actor.start();
            actor.send({ type: 'CONFIGURE' });
            // Send CONNECT_FAIL without nextRetryAt (undefined path through setNextRetry)
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.nextRetryAt).toBeUndefined();
            actor.stop();
        });
    });
});

describe('createServiceActor', () => {
    test('should start in disabled state when no initialState provided', () => {
        const actor = createServiceActor();
        actor.start();
        expect(actor.getSnapshot().value).toBe('disabled');
        actor.stop();
    });

    test('should start in disabled state when initialState is "disabled"', () => {
        const actor = createServiceActor('disabled');
        actor.start();
        expect(actor.getSnapshot().value).toBe('disabled');
        actor.stop();
    });

    test('should start in online state when initialState is "online"', () => {
        const actor = createServiceActor('online');
        actor.start();
        expect(actor.getSnapshot().value).toBe('online');
        actor.stop();
    });

    test('should start in offline state when initialState is "offline"', () => {
        const actor = createServiceActor('offline');
        actor.start();
        expect(actor.getSnapshot().value).toBe('offline');
        actor.stop();
    });

    test('should start in starting state when initialState is "starting"', () => {
        const actor = createServiceActor('starting');
        actor.start();
        expect(actor.getSnapshot().value).toBe('starting');
        actor.stop();
    });

    test('should start in recovering state when initialState is "recovering"', () => {
        const actor = createServiceActor('recovering');
        actor.start();
        expect(actor.getSnapshot().value).toBe('recovering');
        actor.stop();
    });

    test('should start in degraded state when initialState is "degraded"', () => {
        const actor = createServiceActor('degraded');
        actor.start();
        expect(actor.getSnapshot().value).toBe('degraded');
        actor.stop();
    });

    test('should allow transitions after starting from non-disabled initialState', () => {
        const actor = createServiceActor('online');
        actor.start();
        actor.send({ type: 'CONNECTION_LOST' });
        expect(actor.getSnapshot().value).toBe('offline');
        actor.stop();
    });

    test('should have zeroed context when created with initialState', () => {
        const actor = createServiceActor('online');
        actor.start();
        const ctx = actor.getSnapshot().context;
        expect(ctx.epoch).toBe(0);
        expect(ctx.failureCount).toBe(0);
        expect(ctx.lastOnlineAt).toBeUndefined();
        expect(ctx.lastOfflineAt).toBeUndefined();
        expect(ctx.lastError).toBeUndefined();
        expect(ctx.nextRetryAt).toBeUndefined();
        actor.stop();
    });
});
