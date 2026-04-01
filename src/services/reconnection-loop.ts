import { calculateDelay } from '@/utils/retry/delay';
import { setupRetryContext } from '@/utils/retry/defaults';
import type { RetryDeps, RetryPolicy } from '@/utils/retry/types';
import type { ServiceHealthRegistry } from './health-registry';
import type { ServiceName } from './types';

export interface ReconnectionLoopOptions {
    service:   ServiceName
    registry:  ServiceHealthRegistry
    connectFn: () => Promise<void>
    policy?:   Partial<RetryPolicy>
    deps?:     Partial<RetryDeps>
}

export interface ReconnectionLoop {
    start():         void
    stop():          void
    triggerNow():    Promise<boolean>
    isRunning():     boolean
}

// Stryker disable next-line ObjectLiteral: DEFAULT_POLICY is a configuration constant
const DEFAULT_POLICY: Partial<RetryPolicy> = {
    maxAttempts:       10,
    baseDelayMs:       1000,
    maxDelayMs:        300_000,
    backoffMultiplier: 2,
    jitterFraction:    0.1,
};

export function createReconnectionLoop(options: ReconnectionLoopOptions): ReconnectionLoop {
    const { service, registry, connectFn } = options;
    const { policy, deps } = setupRetryContext(
        { ...DEFAULT_POLICY, ...options.policy },
        options.deps ?? {},
    );

    let running = false;
    // Stryker disable next-line BooleanLiteral: connecting is only checked conjunctively with currentAttemptPromise !== undefined; initial value is unobservable
    let connecting = false;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let attemptCount = 0;
    let currentAttemptPromise: Promise<boolean> | undefined;

    function attemptConnect(): Promise<boolean> {
        if(currentAttemptPromise !== undefined) {
            return currentAttemptPromise;
        }

        connecting = true;
        currentAttemptPromise = (async (): Promise<boolean> => {
            try {
                await connectFn();
                registry.sendEvent(service, 'CONNECT_SUCCESS');
                running = false;
                // Stryker disable next-line BooleanLiteral: connecting is only checked conjunctively with currentAttemptPromise; cleared along with currentAttemptPromise = undefined
                connecting = false;
                currentAttemptPromise = undefined;
                return true;
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);

                attemptCount += 1;
                const delayMs = calculateDelay(attemptCount, policy);
                const nextRetryAt = new Date(deps.now() + delayMs);

                registry.sendEvent(service, 'CONNECT_FAIL', { error: errorMessage, nextRetryAt });

                // Stryker disable next-line BooleanLiteral: connecting is only checked conjunctively with currentAttemptPromise; cleared along with currentAttemptPromise = undefined
                connecting = false;
                currentAttemptPromise = undefined;

                if(running) {
                    pendingTimer = setTimeout(() => {
                        // Stryker disable next-line ConditionalExpression: clearTimeout in stop() prevents this timer from firing when running=false; inner guard is unreachable
                        if(running) {
                            registry.sendEvent(service, 'RECONNECT_ATTEMPT');
                            void attemptConnect();
                        }
                    }, delayMs);
                }

                return false;
            }
        })();

        return currentAttemptPromise;
    }

    return {
        start(): void {
            // Stryker disable next-line ConditionalExpression,EqualityOperator,BlockStatement: clearTimeout(undefined) is a no-op so all mutations are equivalent
            if(pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }
            running = true;
            attemptCount = 0;
            registry.sendEvent(service, 'RECONNECT_ATTEMPT');
            void attemptConnect();
        },

        stop(): void {
            running = false;
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op so →true mutation is equivalent
            if(pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }
        },

        async triggerNow(): Promise<boolean> {
            if(connecting && currentAttemptPromise !== undefined) {
                return currentAttemptPromise;
            }

            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op so →true mutation is equivalent
            if(pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }

            registry.sendEvent(service, 'RECONNECT_ATTEMPT');
            return attemptConnect();
        },

        isRunning(): boolean {
            return running;
        },
    };
}
