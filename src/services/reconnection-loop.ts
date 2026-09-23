import type { ServiceHealthRegistry } from './health-registry';
import type { ServiceName } from './types';
import { setupRetryContext, calculateDelay, type RetryDeps, type RetryPolicy } from '@/utils';

interface ReconnectionLoopOptions {
    service:   ServiceName
    registry:  Pick<ServiceHealthRegistry, 'sendEvent'>
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

const DEFAULT_POLICY: Partial<RetryPolicy> = {
    // Stryker disable next-line NumberLiteralValue: maxAttempts is inert here — the policy only feeds calculateDelay, which reads baseDelayMs/backoffMultiplier/jitterFraction/maxDelayMs, and 9 and 10 both pass retryPolicySchema
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
    let stopped = true;
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    let attemptCount = 0;
    let currentAttemptPromise: Promise<boolean> | undefined;

    function attemptConnect(): Promise<boolean> {
        if(currentAttemptPromise !== undefined) {
            return currentAttemptPromise;
        }

        currentAttemptPromise = (async (): Promise<boolean> => {
            try {
                await connectFn();
                registry.sendEvent(service, { type: 'CONNECT_SUCCESS' });
                running = false;
                currentAttemptPromise = undefined;
                return true;
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);

                attemptCount += 1;
                const delayMs = calculateDelay(attemptCount, policy);
                const nextRetryAt = new Date(deps.now() + delayMs);

                registry.sendEvent(service, { type: 'CONNECT_FAIL', error: errorMessage, nextRetryAt });

                currentAttemptPromise = undefined;

                if(running) {
                    pendingTimer = setTimeout(() => {
                        registry.sendEvent(service, { type: 'RECONNECT_ATTEMPT' });
                        void attemptConnect();
                    }, delayMs);
                }

                return false;
            }
        })();

        return currentAttemptPromise;
    }

    return {
        start(): void {
            clearTimeout(pendingTimer);
            pendingTimer = undefined;
            stopped = false;
            running = true;
            attemptCount = 0;
            registry.sendEvent(service, { type: 'RECONNECT_ATTEMPT' });
            void attemptConnect();
        },

        restart(): void {
            // No-op when the loop has been explicitly stopped (via stop()) or never started.
            // No-op when a connect attempt is already in-flight (no parallel attempt needed).
            // The `stopped` flag distinguishes "explicitly stopped / never started" from
            // "auto-stopped after a successful connect" — the latter is the primary use case
            // for restart(): SSE connection resolved then dropped.
            if(stopped || currentAttemptPromise !== undefined) {
                return;
            }
            // Re-engage the loop, preserving attemptCount so backoff continues to grow.
            running = true;
            clearTimeout(pendingTimer);
            pendingTimer = undefined;
            registry.sendEvent(service, { type: 'RECONNECT_ATTEMPT' });
            void attemptConnect();
        },

        stop(): void {
            stopped = true;
            running = false;
            clearTimeout(pendingTimer);
            pendingTimer = undefined;
        },

        async triggerNow(): Promise<boolean> {
            if(currentAttemptPromise !== undefined) {
                return currentAttemptPromise;
            }

            clearTimeout(pendingTimer);
            pendingTimer = undefined;

            registry.sendEvent(service, { type: 'RECONNECT_ATTEMPT' });
            return attemptConnect();
        },

        isRunning(): boolean {
            return running;
        },
    };
}
