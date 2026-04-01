import { assign, setup, createActor } from 'xstate';
import type { HealthState } from './types';

interface ServiceLifecycleContext {
    epoch:         number
    failureCount:  number
    lastOnlineAt:  Date | undefined
    lastOfflineAt: Date | undefined
    lastError:     { code: string, message: string } | undefined
    nextRetryAt:   Date | undefined
}

type ServiceLifecycleEvent
    = | { type: 'CONFIGURE' }
      | { type: 'CONNECT_SUCCESS' }
      | { type: 'CONNECT_FAIL', error?: string, nextRetryAt?: Date }
      | { type: 'CONNECTION_LOST', error?: string }
      | { type: 'PARTIAL_FAILURE' }
      | { type: 'RECOVERED' }
      | { type: 'RECONNECT_ATTEMPT' }
      | { type: 'RECOVERY_FAIL', error?: string };

export const serviceLifecycleMachine = setup({
    // Stryker disable next-line ObjectLiteral: xstate types property is compile-time only
    types: {
        context: {} as ServiceLifecycleContext,
        events:  {} as ServiceLifecycleEvent,
    },
    actions: {
        incrementEpoch: assign({ epoch: ({ context }) => context.epoch + 1 }),
        recordOnline:   assign({
            lastOnlineAt: () => new Date(),
            failureCount: 0,
            lastError:    undefined,
        }),
        recordOffline: assign(({ context, event }) => {
            const ev = event as { error?: string };
            return {
                lastOfflineAt: new Date(),
                failureCount:  context.failureCount + 1,
                lastError:     typeof ev.error === 'string'
                    ? { code: 'CONNECTION_FAILED', message: ev.error }
                    : context.lastError,
            };
        }),
        setNextRetry: assign(({ event }) => {
            const ev = event as { nextRetryAt?: Date };
            return {
                nextRetryAt: ev.nextRetryAt instanceof Date ? ev.nextRetryAt : undefined,
            };
        }),
    },
}).createMachine({
    // Stryker disable next-line StringLiteral: machine id is an xstate identity constant
    id:      'serviceLifecycle',
    initial: 'disabled',
    context: {
        epoch:         0,
        failureCount:  0,
        lastOnlineAt:  undefined,
        lastOfflineAt: undefined,
        lastError:     undefined,
        nextRetryAt:   undefined,
    },
    states: {
        disabled: {
            on: {
                CONFIGURE: { target: 'starting', actions: 'incrementEpoch' },
            },
        },
        starting: {
            on: {
                CONNECT_SUCCESS: { target: 'online', actions: 'recordOnline' },
                CONNECT_FAIL:    { target: 'offline', actions: ['recordOffline', 'setNextRetry'] },
            },
        },
        recovering: {
            on: {
                CONNECT_SUCCESS: { target: 'online', actions: 'recordOnline' },
                CONNECT_FAIL:    { target: 'offline', actions: ['recordOffline', 'setNextRetry'] },
                RECOVERY_FAIL:   { target: 'offline', actions: 'recordOffline' },
            },
        },
        online: {
            on: {
                CONNECTION_LOST: { target: 'offline', actions: ['incrementEpoch', 'recordOffline'] },
                PARTIAL_FAILURE: { target: 'degraded' },
            },
        },
        degraded: {
            on: {
                RECOVERED:       { target: 'online', actions: 'recordOnline' },
                CONNECTION_LOST: { target: 'offline', actions: ['incrementEpoch', 'recordOffline'] },
            },
        },
        offline: {
            on: {
                RECONNECT_ATTEMPT: { target: 'recovering' },
                CONFIGURE:         { target: 'starting', actions: 'incrementEpoch' },
                CONNECT_SUCCESS:   { target: 'online', actions: 'recordOnline' },
            },
        },
    },
});

export type ServiceLifecycleActor = ReturnType<typeof createActor<typeof serviceLifecycleMachine>>;

export function createServiceActor(initialState?: HealthState): ServiceLifecycleActor {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: disabled path creates a simpler actor — both disabled and undefined are equivalent starting points
    if(initialState === undefined || initialState === 'disabled') {
        return createActor(serviceLifecycleMachine);
    }

    return createActor(serviceLifecycleMachine, {
        snapshot: serviceLifecycleMachine.resolveState({
            value:   initialState,
            context: {
                epoch:         0,
                failureCount:  0,
                lastOnlineAt:  undefined,
                lastOfflineAt: undefined,
                lastError:     undefined,
                nextRetryAt:   undefined,
            },
        }),
    });
}
