import { assign, setup, createActor, type StateValueFrom } from 'xstate';

interface ServiceLifecycleContext {
    epoch:         number
    failureCount:  number
    lastOnlineAt:  Date | undefined
    lastOfflineAt: Date | undefined
    lastError:     { code: string, message: string } | undefined
    nextRetryAt:   Date | undefined
}

export type ServiceLifecycleEvent
    = | { type: 'CONFIGURE' }
      | { type: 'CONNECT_SUCCESS' }
      | { type: 'CONNECT_FAIL', error?: string, nextRetryAt?: Date }
      | { type: 'CONNECTION_LOST', error?: string }
      | { type: 'RECONNECT_ATTEMPT' };

export const serviceLifecycleMachine = setup({
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
                CONNECTION_LOST: { target: 'offline', actions: ['incrementEpoch', 'recordOffline'] },
            },
        },
        recovering: {
            on: {
                CONNECT_SUCCESS: { target: 'online', actions: 'recordOnline' },
                CONNECT_FAIL:    { target: 'offline', actions: ['recordOffline', 'setNextRetry'] },
                CONNECTION_LOST: { target: 'offline', actions: ['incrementEpoch', 'recordOffline'] },
            },
        },
        online: {
            on: {
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

export type ServiceLifecycleState = StateValueFrom<typeof serviceLifecycleMachine>;

export type ServiceLifecycleActor = ReturnType<typeof createActor<typeof serviceLifecycleMachine>>;

export function createServiceActor(initialState?: ServiceLifecycleState): ServiceLifecycleActor {
    // Stryker disable next-line llm: HealthState has no falsy members, so this is equivalent for every valid input.
    if(initialState === undefined) {
        // Stryker disable next-line llm: XState spreads omitted and empty actor options into identical defaults.
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
