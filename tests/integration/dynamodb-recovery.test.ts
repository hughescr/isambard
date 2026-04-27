/**
 * End-to-end integration test: DynamoDB failure → health notification → state transition → reconnect loop.
 *
 * Tests the complete failure-recovery chain using real implementations (not stubs) for:
 *   withDynamoTimeout → setDynamoHealthNotifier notifier → ServiceHealthRegistryImpl.sendEvent
 *   → serviceLifecycleMachine (starting/online/recovering) → offline
 *   → ReconnectionLoop.start() (externally controlled in this test)
 *
 * Only the actual DynamoDB calls are stubbed out to avoid real AWS SDK connections.
 */
import { describe, it, expect, beforeEach, afterEach, mock, jest } from 'bun:test';
import { ServiceHealthRegistryImpl, type ServiceHealthRegistryLogger } from '@/services/health-registry';
import { createReconnectionLoop } from '@/services/reconnection-loop';
import type { ServiceName } from '@/services/types';
import { withDynamoTimeout, setDynamoHealthNotifier, DynamoTimeoutError } from '@/storage/dynamo-retry';

const SERVICE: ServiceName = 'dynamodb';

// Deterministic retry policy so tests don't need long timers
const FAST_POLICY = {
    baseDelayMs:       50,
    maxDelayMs:        200,
    backoffMultiplier: 2,
    jitterFraction:    0,
};

function makeNullLogger(): ServiceHealthRegistryLogger {
    return {
        warn:  mock(() => {}),
        error: mock(() => {}),
        info:  mock(() => {}),
        debug: mock(() => {}),
    };
}

describe('DynamoDB failure → CONNECTION_LOST → offline chain', () => {
    let registry: ServiceHealthRegistryImpl;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        registry = new ServiceHealthRegistryImpl({ logger: makeNullLogger() });
        // Wire the notifier to route health events through the real registry
        setDynamoHealthNotifier((err) => {
            const error = err instanceof Error ? err.message : String(err);
            registry.sendEvent(SERVICE, 'CONNECTION_LOST', { error });
        });
    });

    afterEach(() => {
        setDynamoHealthNotifier(undefined);
        registry.stop();
        jest.useRealTimers();
    });

    it('should transition from starting to offline when CONNECTION_LOST fires during startup probe', () => {
        // Put service in starting state
        registry.sendEvent(SERVICE, 'CONFIGURE');
        expect(registry.getState(SERVICE)).toBe('starting');

        // Simulate a probe failure during startup — use a real Smithy TimeoutError shape
        const smithyTimeoutErr = Object.assign(
            new Error('@smithy/node-http-handler - the request socket timed out after 3000 ms of inactivity.'),
            { name: 'TimeoutError' }
        );

        // Fire notifier manually (simulates a backend op failing during startup)
        const error = smithyTimeoutErr instanceof Error ? smithyTimeoutErr.message : String(smithyTimeoutErr);
        registry.sendEvent(SERVICE, 'CONNECTION_LOST', { error });

        expect(registry.getState(SERVICE)).toBe('offline');
    });

    it('should transition from online to offline when a DynamoDB op throws a network-classified error', async () => {
        // Put service in online state
        registry.sendEvent(SERVICE, 'CONFIGURE');
        registry.sendEvent(SERVICE, 'CONNECT_SUCCESS');
        expect(registry.getState(SERVICE)).toBe('online');

        // Simulate DynamoDB operation that throws a real ETIMEDOUT socket error
        const networkError = Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' });
        const operation = mock(async () => {
            throw networkError;
        });

        let caughtErr: unknown;
        try {
            await withDynamoTimeout(operation, { timeoutMs: 5000, operation: 'GetItem' });
        } catch (err) {
            caughtErr = err;
        }

        // The original error is re-thrown
        expect(caughtErr).toBe(networkError);
        // The notifier fired → registry received CONNECTION_LOST → state transitioned
        expect(registry.getState(SERVICE)).toBe('offline');
    });

    it('should transition from online to offline when a DynamoDB timeout fires', async () => {
        registry.sendEvent(SERVICE, 'CONFIGURE');
        registry.sendEvent(SERVICE, 'CONNECT_SUCCESS');
        expect(registry.getState(SERVICE)).toBe('online');

        const neverResolves = mock(() => new Promise<never>(() => {}));

        const promise = withDynamoTimeout(neverResolves, { timeoutMs: 1000, operation: 'PutItem' });

        // Advance fake timers to trigger the timeout
        jest.advanceTimersByTime(1001);

        let caughtErr: unknown;
        try {
            await promise;
        } catch (err) {
            caughtErr = err;
        }

        // Should throw DynamoTimeoutError
        expect(caughtErr).toBeInstanceOf(DynamoTimeoutError);
        // Notifier fired via timeout → CONNECTION_LOST → offline
        expect(registry.getState(SERVICE)).toBe('offline');
    });

    it('should transition from recovering to offline when a DynamoDB op fails during reconnect attempt', async () => {
        // Start → online → offline → recovering
        registry.sendEvent(SERVICE, 'CONFIGURE');
        registry.sendEvent(SERVICE, 'CONNECT_SUCCESS');
        registry.sendEvent(SERVICE, 'CONNECTION_LOST', { error: 'initial failure' });
        registry.sendEvent(SERVICE, 'RECONNECT_ATTEMPT');
        expect(registry.getState(SERVICE)).toBe('recovering');

        // Another network error fires during recovery
        const networkError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        const operation = mock(async () => {
            throw networkError;
        });

        try {
            await withDynamoTimeout(operation, { timeoutMs: 5000, operation: 'DescribeTable' });
        } catch{
            // expected — verifying state transition, not the thrown error
        }

        // CONNECTION_LOST from notifier → offline
        expect(registry.getState(SERVICE)).toBe('offline');
    });

    it('should capture state change via health-change listener when transitioning to offline', async () => {
        registry.sendEvent(SERVICE, 'CONFIGURE');
        registry.sendEvent(SERVICE, 'CONNECT_SUCCESS');

        const stateChanges: string[] = [];
        const unsubscribe = registry.subscribe((change) => {
            if(change.service === SERVICE) {
                stateChanges.push(`${change.previousState}→${change.newState}`);
            }
        });

        // Trigger failure chain
        const networkError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        const operation = mock(async () => {
            throw networkError;
        });

        try {
            await withDynamoTimeout(operation, { timeoutMs: 5000, operation: 'Query' });
        } catch{
            // expected — verifying state change, not the thrown error
        }

        unsubscribe();

        expect(stateChanges).toContain('online→offline');
    });

    it('reconnect loop integration: notifier fires → offline → reconnect loop start → CONNECT_SUCCESS → online', async () => {
        registry.sendEvent(SERVICE, 'CONFIGURE');
        registry.sendEvent(SERVICE, 'CONNECT_SUCCESS');
        expect(registry.getState(SERVICE)).toBe('online');

        let connectCallCount = 0;
        const connectFn = mock(async () => {
            connectCallCount++;
            // Succeed on first attempt
        });

        const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: FAST_POLICY });

        // Subscribe to state changes to know when reconnect loop marks online
        const stateValues: string[] = [];
        const unsubscribe = registry.subscribe((change) => {
            if(change.service === SERVICE) {
                stateValues.push(change.newState);
            }
        });

        // Trigger failure: notifier fires → offline
        const networkError = Object.assign(new Error('FailedToOpenSocket'), { name: 'FailedToOpenSocket' });
        const operation = mock(async () => {
            throw networkError;
        });
        try {
            await withDynamoTimeout(operation, { timeoutMs: 5000, operation: 'Scan' });
        } catch{
            // expected — verifying state transition
        }
        expect(registry.getState(SERVICE)).toBe('offline');

        // Start reconnect loop (normally driven by the health change listener)
        loop.start();
        registry.sendEvent(SERVICE, 'RECONNECT_ATTEMPT');

        // Let reconnect attempt run
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        unsubscribe();
        loop.stop();

        // connectFn was called
        expect(connectCallCount).toBeGreaterThan(0);
        // State went online
        expect(stateValues).toContain('online');
    });
});
