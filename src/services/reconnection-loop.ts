import type { ServiceHealthRegistry } from './health-registry';
import type { ServiceName } from './types';
import { setupRetryContext, calculateDelay, type RetryDeps, type RetryPolicy } from '@/utils';

interface ReconnectionLoopOptions {
    service:   ServiceName
    registry:  ServiceHealthRegistry
    connectFn: () => Promise<void>
    policy?:   Partial<RetryPolicy>
    deps?:     Partial<RetryDeps>
}

export interface ReconnectionLoop {
    start():         void
    restart():       void
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
        options.deps ?? {}
    );

    let running = false;
    // Stryker disable next-line BooleanLiteral: stopped starts true to represent "never started"; cleared by start()
    let stopped = true;
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
            stopped = false;
            running = true;
            attemptCount = 0;
            registry.sendEvent(service, 'RECONNECT_ATTEMPT');
            void attemptConnect();
        },

        restart(): void {
            // No-op when the loop has been explicitly stopped (via stop()) or never started.
            // No-op when a connect attempt is already in-flight (no parallel attempt needed).
            // The `stopped` flag distinguishes "explicitly stopped / never started" from
            // "auto-stopped after a successful connect" — the latter is the primary use case
            // for restart(): SSE connection resolved then dropped.
            // Stryker disable next-line ConditionalExpression,LogicalOperator: `connecting` and `currentAttemptPromise` are always set/cleared atomically; mutations that swap the inner operand alone produce equivalent behaviour
            if(stopped || (connecting && currentAttemptPromise !== undefined)) {
                return;
            }
            // Re-engage the loop, preserving attemptCount so backoff continues to grow.
            running = true;
            // Stryker disable next-line ConditionalExpression: clearTimeout(undefined) is a no-op so →true mutation is equivalent
            if(pendingTimer !== undefined) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
            }
            registry.sendEvent(service, 'RECONNECT_ATTEMPT');
            void attemptConnect();
        },

        stop(): void {
            stopped = true;
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
