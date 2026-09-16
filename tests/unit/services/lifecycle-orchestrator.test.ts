import { describe, test, expect } from 'bun:test';
import { createActor } from 'xstate';
import { serviceLifecycleMachine, createServiceActor } from '@/services/lifecycle-orchestrator';

type LifecycleActorEvent = Parameters<ReturnType<typeof createServiceActor>['send']>[0];
// @ts-expect-error The lifecycle actor must not accept an event outside ServiceLifecycleEvent.
const _invalidLifecycleActorEvent: LifecycleActorEvent = { type: 'UNKNOWN_EVENT' };

interface TransitionCase {
    event:    LifecycleActorEvent
    expected: 'disabled' | 'starting' | 'recovering' | 'online' | 'degraded' | 'offline'
    desc:     string
}

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
        test('has a stable machine identity for actor diagnostics', () => {
            expect(serviceLifecycleMachine.id).toBe('serviceLifecycle');
        });

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
        test.each([
            { event: { type: 'CONFIGURE' }, expected: 'starting', desc: 'CONFIGURE transitions to starting' },
            { event: { type: 'CONNECT_SUCCESS' }, expected: 'disabled', desc: 'CONNECT_SUCCESS is ignored' },
            { event: { type: 'CONNECT_FAIL' }, expected: 'disabled', desc: 'CONNECT_FAIL is ignored' },
            { event: { type: 'CONNECTION_LOST' }, expected: 'disabled', desc: 'CONNECTION_LOST is ignored' },
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'disabled', desc: 'RECONNECT_ATTEMPT is ignored' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('disabled');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
            actor.stop();
        });

        test('should increment epoch on CONFIGURE', () => {
            const actor = actorInState('disabled');
            expect(actor.getSnapshot().context.epoch).toBe(0);
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().context.epoch).toBe(1);
            actor.stop();
        });
    });

    describe('starting state transitions', () => {
        test.each([
            { event: { type: 'CONNECT_SUCCESS' }, expected: 'online', desc: 'CONNECT_SUCCESS transitions to online' },
            { event: { type: 'CONNECT_FAIL' }, expected: 'offline', desc: 'CONNECT_FAIL transitions to offline' },
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'starting', desc: 'RECONNECT_ATTEMPT is ignored' },
            { event: { type: 'CONNECTION_LOST' }, expected: 'offline', desc: 'CONNECTION_LOST transitions to offline' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('starting');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
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

        test('should record offline details (failureCount, lastOfflineAt) on CONNECTION_LOST from starting', () => {
            const before = new Date();
            const actor = actorInState('starting');
            actor.send({ type: 'CONNECTION_LOST', error: 'probe failed during startup' });
            const after = new Date();
            const ctx = actor.getSnapshot().context;
            expect(ctx.failureCount).toBe(1);
            expect(ctx.lastOfflineAt).toBeInstanceOf(Date);
            expect(ctx.lastOfflineAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(ctx.lastOfflineAt!.getTime()).toBeLessThanOrEqual(after.getTime());
            expect(ctx.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'probe failed during startup' });
            actor.stop();
        });

        test('should increment epoch on CONNECTION_LOST from starting', () => {
            const actor = actorInState('starting');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
            actor.stop();
        });
    });

    describe('online state transitions', () => {
        test.each([
            { event: { type: 'CONNECTION_LOST' }, expected: 'offline', desc: 'CONNECTION_LOST transitions to offline' },
            { event: { type: 'PARTIAL_FAILURE' }, expected: 'degraded', desc: 'PARTIAL_FAILURE transitions to degraded' },
            { event: { type: 'CONFIGURE' }, expected: 'online', desc: 'CONFIGURE is ignored' },
            { event: { type: 'CONNECT_SUCCESS' }, expected: 'online', desc: 'CONNECT_SUCCESS is ignored' },
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'online', desc: 'RECONNECT_ATTEMPT is ignored' },
            { event: { type: 'RECOVERY_FAIL' }, expected: 'online', desc: 'RECOVERY_FAIL is ignored' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('online');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
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

        test('should not change epoch on PARTIAL_FAILURE', () => {
            const actor = actorInState('online');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'PARTIAL_FAILURE' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore);
            actor.stop();
        });
    });

    describe('degraded state transitions', () => {
        test.each([
            { event: { type: 'RECOVERED' }, expected: 'online', desc: 'RECOVERED transitions to online' },
            { event: { type: 'CONNECTION_LOST' }, expected: 'offline', desc: 'CONNECTION_LOST transitions to offline' },
            { event: { type: 'CONFIGURE' }, expected: 'degraded', desc: 'CONFIGURE is ignored' },
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'degraded', desc: 'RECONNECT_ATTEMPT is ignored' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('degraded');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
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

        test('should increment epoch on CONNECTION_LOST from degraded', () => {
            const actor = actorInState('degraded');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
            actor.stop();
        });
    });

    describe('offline state transitions', () => {
        test.each([
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'recovering', desc: 'RECONNECT_ATTEMPT transitions to recovering' },
            { event: { type: 'CONFIGURE' }, expected: 'starting', desc: 'CONFIGURE transitions to starting' },
            { event: { type: 'CONNECT_SUCCESS' }, expected: 'online', desc: 'CONNECT_SUCCESS transitions to online' },
            { event: { type: 'CONNECTION_LOST' }, expected: 'offline', desc: 'CONNECTION_LOST is ignored' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('offline');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
            actor.stop();
        });

        test('should NOT increment epoch on RECONNECT_ATTEMPT from offline', () => {
            const actor = actorInState('offline');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'RECONNECT_ATTEMPT' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore);
            actor.stop();
        });

        test('should increment epoch on CONFIGURE from offline', () => {
            const actor = actorInState('offline');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONFIGURE' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
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
    });

    describe('recovering state transitions', () => {
        test.each([
            { event: { type: 'CONNECT_SUCCESS' }, expected: 'online', desc: 'CONNECT_SUCCESS transitions to online' },
            { event: { type: 'CONNECT_FAIL' }, expected: 'offline', desc: 'CONNECT_FAIL transitions to offline' },
            { event: { type: 'RECOVERY_FAIL' }, expected: 'offline', desc: 'RECOVERY_FAIL transitions to offline' },
            { event: { type: 'CONFIGURE' }, expected: 'recovering', desc: 'CONFIGURE is ignored' },
            { event: { type: 'RECONNECT_ATTEMPT' }, expected: 'recovering', desc: 'RECONNECT_ATTEMPT is ignored' },
            { event: { type: 'CONNECTION_LOST' }, expected: 'offline', desc: 'CONNECTION_LOST transitions to offline' },
        ] satisfies TransitionCase[])('should end in $expected when $desc', ({ event, expected }) => {
            const actor = actorInState('recovering');
            actor.send(event);
            expect(actor.getSnapshot().value).toBe(expected);
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

        test('should increment failureCount on CONNECT_FAIL from recovering', () => {
            const actor = actorInState('recovering');
            const failureBefore = actor.getSnapshot().context.failureCount;
            actor.send({ type: 'CONNECT_FAIL' });
            expect(actor.getSnapshot().context.failureCount).toBe(failureBefore + 1);
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

        test('should record offline details on CONNECTION_LOST from recovering', () => {
            const actor = actorInState('recovering');
            actor.send({ type: 'CONNECTION_LOST', error: 'connection lost mid-recovery' });
            const ctx = actor.getSnapshot().context;
            expect(ctx.failureCount).toBeGreaterThan(0);
            expect(ctx.lastOfflineAt).toBeInstanceOf(Date);
            expect(ctx.lastError).toEqual({ code: 'CONNECTION_FAILED', message: 'connection lost mid-recovery' });
            actor.stop();
        });

        test('should increment epoch on CONNECTION_LOST from recovering', () => {
            const actor = actorInState('recovering');
            const epochBefore = actor.getSnapshot().context.epoch;
            actor.send({ type: 'CONNECTION_LOST' });
            expect(actor.getSnapshot().context.epoch).toBe(epochBefore + 1);
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

    test.each([
        'disabled',
        'online',
        'offline',
        'starting',
        'recovering',
        'degraded',
    ] as const)('should start in %s state when initialState is %j', (state) => {
        const actor = createServiceActor(state);
        actor.start();
        expect(actor.getSnapshot().value).toBe(state);
        actor.stop();
    });

    test('explicit disabled state has the same snapshot, start notification, and first transition as the default', () => {
        const defaultActor = createServiceActor();
        const explicitActor = createServiceActor('disabled');
        const defaultSnapshots: unknown[] = [];
        const explicitSnapshots: unknown[] = [];
        defaultActor.subscribe(snapshot => defaultSnapshots.push({ value: snapshot.value, context: snapshot.context }));
        explicitActor.subscribe(snapshot => explicitSnapshots.push({ value: snapshot.value, context: snapshot.context }));

        defaultActor.start();
        explicitActor.start();
        expect(explicitActor.getSnapshot()).toMatchObject(defaultActor.getSnapshot());
        expect(explicitSnapshots).toEqual(defaultSnapshots);

        defaultActor.send({ type: 'CONFIGURE' });
        explicitActor.send({ type: 'CONFIGURE' });
        expect(explicitActor.getSnapshot()).toMatchObject(defaultActor.getSnapshot());
        expect(explicitSnapshots).toEqual(defaultSnapshots);
        defaultActor.stop();
        explicitActor.stop();
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
