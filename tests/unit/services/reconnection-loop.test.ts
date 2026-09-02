import { describe, test, expect, mock, jest, beforeEach, afterEach, type Mock } from 'bun:test';
import type { ServiceHealthRegistry } from '@/services/health-registry';
import { createReconnectionLoop } from '@/services/reconnection-loop';
import type { ServiceName } from '@/services/types';

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

const SERVICE: ServiceName = 'discord';

// Deterministic policy — no jitter, so delays are predictable.
// All values must be within the Zod schema bounds:
//   baseDelayMs: 100–30000, maxDelayMs: 1000–120000,
//   backoffMultiplier: 1–4, jitterFraction: 0–0.5
const DETERMINISTIC_POLICY = {
    baseDelayMs:       100,
    maxDelayMs:        10_000,
    backoffMultiplier: 2,
    jitterFraction:    0,
};

describe('createReconnectionLoop', () => {
    let registry: ServiceHealthRegistry;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        registry = createMockRegistry();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // -------------------------------------------------------------------------
    // Basic lifecycle
    // -------------------------------------------------------------------------

    describe('basic lifecycle', () => {
        test('start() sets isRunning() to true', () => {
            const connectFn = mock(async () => {
                // pending — never resolves in this test
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();

            expect(loop.isRunning()).toBe(true);
        });

        test('start() sends RECONNECT_ATTEMPT event to registry', () => {
            const connectFn = mock(async () => {
                // pending
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();

            expect(registry.sendEvent).toHaveBeenCalledWith(SERVICE, 'RECONNECT_ATTEMPT');
        });

        test('start() calls connectFn immediately', () => {
            const connectFn = mock(async () => {
                // pending
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();

            expect(connectFn).toHaveBeenCalledTimes(1);
        });

        test('stop() sets isRunning() to false', () => {
            const connectFn = mock(async () => {
                // pending
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            loop.stop();

            expect(loop.isRunning()).toBe(false);
        });

        test('isRunning() is false before start()', () => {
            const connectFn = mock(async () => {
                // never called
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            expect(loop.isRunning()).toBe(false);
        });

        test('after successful connect, isRunning() becomes false (auto-stop)', async () => {
            const connectFn = mock(async () => {
                // success — resolves immediately
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await connectFn.mock.results[0].value;
            // Flush the IIFE continuation (running = false runs after connectFn resolves)
            await Promise.resolve();

            expect(loop.isRunning()).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Successful connection
    // -------------------------------------------------------------------------

    describe('successful connection', () => {
        test('connectFn succeeds → registry receives CONNECT_SUCCESS event', async () => {
            const connectFn = mock(async () => {
                // success
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await connectFn.mock.results[0].value;
            // Flush IIFE continuation so CONNECT_SUCCESS event is sent
            await Promise.resolve();

            expect(registry.sendEvent).toHaveBeenCalledWith(SERVICE, 'CONNECT_SUCCESS');
        });

        test('loop auto-stops after success', async () => {
            const connectFn = mock(async () => {
                // success
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await connectFn.mock.results[0].value;
            // Flush IIFE continuation so running = false is set
            await Promise.resolve();

            expect(loop.isRunning()).toBe(false);
        });

        test('triggerNow() returns true after successful connect started via start()', async () => {
            const connectFn = mock(async () => {
                // success
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            // start() has already kicked off an in-flight attempt; triggerNow() should
            // reuse that same in-flight promise rather than starting a second connect.
            const result = await loop.triggerNow();

            expect(connectFn).toHaveBeenCalledTimes(1);
            expect(result).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // Failed connection
    // -------------------------------------------------------------------------

    describe('failed connection', () => {
        test('connectFn fails → registry receives CONNECT_FAIL event with error and nextRetryAt', async () => {
            const error = new Error('connection refused');
            const connectFn = mock(async () => {
                throw error;
            });
            const nowMs = 500_000;
            const deps = { now: mock(() => nowMs) };
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY, deps });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const calls = (registry.sendEvent as Mock<typeof registry.sendEvent>).mock.calls;
            const failCall = calls.find(c => c[1] === 'CONNECT_FAIL');
            expect(failCall).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            expect(failCall![2]?.['error']).toBe('connection refused');
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            expect(failCall![2]?.['nextRetryAt']).toBeInstanceOf(Date);

            loop.stop();
        });

        test('non-Error thrown → String(err) used as error message', async () => {
            const connectFn = mock(async () => {
                throw 'plain string error';
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const calls = (registry.sendEvent as Mock<typeof registry.sendEvent>).mock.calls;
            const failCall = calls.find(c => c[1] === 'CONNECT_FAIL');
            expect(failCall).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            expect(failCall![2]?.['error']).toBe('plain string error');

            loop.stop();
        });

        test('non-Error object thrown → String(err) used as error message', async () => {
            class CustomError {
                toString() {
                    return 'CustomError: oops';
                }
            }
            const connectFn = mock(async () => {
                throw new CustomError();
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const calls = (registry.sendEvent as Mock<typeof registry.sendEvent>).mock.calls;
            const failCall = calls.find(c => c[1] === 'CONNECT_FAIL');
            expect(failCall).toBeDefined();
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            expect(failCall![2]?.['error']).toBe('CustomError: oops');

            loop.stop();
        });

        test('after failure, next attempt is scheduled after delay', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount === 1) {
                    throw new Error('fail');
                }
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            // Let the first attempt's rejection settle
            await Promise.resolve();
            await Promise.resolve();

            expect(connectFn).toHaveBeenCalledTimes(1);

            // Advance past the delay for attempt 1: baseDelay * 2^(1-1) = 100 * 1 = 100ms
            jest.advanceTimersByTime(100);

            // Timer fires → RECONNECT_ATTEMPT sent and connectFn called again (synchronously in bun)
            expect(connectFn).toHaveBeenCalledTimes(2);
        });

        test('second attempt sends RECONNECT_ATTEMPT before calling connectFn', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount < 2) {
                    throw new Error('fail');
                }
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const callsBefore = sendEventMock.mock.calls.length;

            jest.advanceTimersByTime(100);

            // A second RECONNECT_ATTEMPT should have been sent by the timer callback
            const reconnectAttempts = sendEventMock.mock.calls.filter(c => c[1] === 'RECONNECT_ATTEMPT');
            expect(reconnectAttempts.length).toBeGreaterThan(callsBefore - 1);
        });
    });

    // -------------------------------------------------------------------------
    // Exponential backoff
    // -------------------------------------------------------------------------

    describe('exponential backoff', () => {
        test('first failure delay is baseDelayMs', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount === 1) {
                    throw new Error('fail 1');
                }
            });
            // policy: base=100, multiplier=2, no jitter → delay(1) = 100ms
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            // Advance by 99ms — should NOT trigger retry
            jest.advanceTimersByTime(99);
            expect(connectFn).toHaveBeenCalledTimes(1);

            // Advance by 1ms more (total 100ms) — SHOULD trigger retry
            jest.advanceTimersByTime(1);
            expect(connectFn).toHaveBeenCalledTimes(2);
        });

        test('second failure delay is baseDelayMs * backoffMultiplier', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount <= 2) {
                    throw new Error(`fail ${callCount}`);
                }
            });
            // delay(1)=100ms, delay(2)=200ms with multiplier=2
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            expect(connectFn).toHaveBeenCalledTimes(1);

            // Trigger second attempt at 100ms
            jest.advanceTimersByTime(100);
            expect(connectFn).toHaveBeenCalledTimes(2);

            // Settle second failure so its timer is registered
            await Promise.resolve();
            await Promise.resolve();

            // Advance by 199ms — should NOT trigger third retry yet
            jest.advanceTimersByTime(199);
            expect(connectFn).toHaveBeenCalledTimes(2);

            // Advance by 1ms more (total 200ms since 2nd failure) — SHOULD trigger
            jest.advanceTimersByTime(1);
            expect(connectFn).toHaveBeenCalledTimes(3);
        });

        test('delays increase exponentially: delay(2) > delay(1)', async () => {
            let callCount = 0;
            const baseNow = 1_000_000;
            const nowFn = mock(() => baseNow);

            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount <= 2) {
                    throw new Error(`fail ${callCount}`);
                }
            });
            const loop = createReconnectionLoop({
                service: SERVICE,
                registry,
                connectFn,
                policy:  DETERMINISTIC_POLICY,
                deps:    { now: nowFn },
            });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;

            // Get delay from first failure's nextRetryAt
            const fail1Call = sendEventMock.mock.calls.find(c => c[1] === 'CONNECT_FAIL');
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            const delay1 = (fail1Call![2]!['nextRetryAt'] as Date).getTime() - baseNow;

            // Trigger second attempt
            jest.advanceTimersByTime(delay1);
            await Promise.resolve();
            await Promise.resolve();

            const fail2Call = sendEventMock.mock.calls.filter(c => c[1] === 'CONNECT_FAIL')[1];
            const fail2Payload = fail2Call[2] ?? {};
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            const delay2 = (fail2Payload['nextRetryAt'] as Date).getTime() - baseNow;

            expect(delay2).toBeGreaterThan(delay1);
        });
    });

    // -------------------------------------------------------------------------
    // triggerNow()
    // -------------------------------------------------------------------------

    describe('triggerNow()', () => {
        test('when pending timer exists: clears it, sends RECONNECT_ATTEMPT, calls connectFn immediately', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount === 1) {
                    throw new Error('fail');
                }
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            // At this point there is a pending 100ms retry timer
            expect(jest.getTimerCount()).toBe(1);

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const callsBefore = connectFn.mock.calls.length;

            const resultPromise = loop.triggerNow();
            // Timer should be cleared immediately by triggerNow
            expect(jest.getTimerCount()).toBe(0);
            // connectFn should have been invoked immediately (not waiting for timer)
            expect(connectFn.mock.calls).toHaveLength(callsBefore + 1);

            // RECONNECT_ATTEMPT should have been sent by triggerNow
            const reconnectCalls = sendEventMock.mock.calls.filter(c => c[1] === 'RECONNECT_ATTEMPT');
            expect(reconnectCalls.length).toBeGreaterThanOrEqual(2);

            await resultPromise;
        });

        test('triggerNow() returns true when connectFn succeeds', async () => {
            const connectFn = mock(async () => {
                // success
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            const result = await loop.triggerNow();

            expect(result).toBe(true);
        });

        test('triggerNow() returns false when connectFn fails', async () => {
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            const result = await loop.triggerNow();
            loop.stop();

            expect(result).toBe(false);
        });

        test('when in-flight attempt exists: returns same promise, no parallel call', async () => {
            let resolveConnect!: () => void;
            const connectFn = mock(async () => {
                await new Promise<void>((resolve) => {
                    resolveConnect = resolve;
                });
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const eventsBefore = sendEventMock.mock.calls.length;

            // First attempt is in-flight; triggerNow should reuse it (no new RECONNECT_ATTEMPT)
            const p1 = loop.triggerNow();
            const p2 = loop.triggerNow();

            // No new events emitted — the in-flight promise was returned directly
            expect(sendEventMock.mock.calls).toHaveLength(eventsBefore);
            expect(connectFn).toHaveBeenCalledTimes(1);

            resolveConnect();
            const [r1, r2] = await Promise.all([p1, p2]);
            expect(r1).toBe(true);
            expect(r2).toBe(true);
        });

        test('triggerNow() works without calling start() first', async () => {
            const connectFn = mock(async () => {
                // success
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            const result = await loop.triggerNow();

            expect(result).toBe(true);
            expect(connectFn).toHaveBeenCalledTimes(1);
        });
    });

    // -------------------------------------------------------------------------
    // stop() behaviour
    // -------------------------------------------------------------------------

    describe('stop() behaviour', () => {
        test('stop() clears pending timer — no retry fires after stop', async () => {
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            expect(connectFn).toHaveBeenCalledTimes(1);
            // Pending timer should be registered at this point
            expect(jest.getTimerCount()).toBe(1);

            loop.stop();
            // Timer must be cleared immediately on stop
            expect(jest.getTimerCount()).toBe(0);

            // Advance past what would have been the retry delay
            jest.advanceTimersByTime(200);

            expect(connectFn).toHaveBeenCalledTimes(1);
        });

        test('stop() while connecting: in-flight completes but no retry scheduled', async () => {
            let rejectConnect!: (e: Error) => void;
            const connectFn = mock(async () => {
                await new Promise<void>((_resolve, reject) => {
                    rejectConnect = reject;
                });
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            loop.stop();

            rejectConnect(new Error('late fail'));
            await Promise.resolve();
            await Promise.resolve();

            jest.advanceTimersByTime(500);
            expect(connectFn).toHaveBeenCalledTimes(1);
        });

        test('after stop(), isRunning() is false', () => {
            const connectFn = mock(async () => {
                // pending
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            expect(loop.isRunning()).toBe(true);

            loop.stop();
            expect(loop.isRunning()).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // start() resets attemptCount
    // -------------------------------------------------------------------------

    describe('start() resets attemptCount', () => {
        test('start() resets attemptCount so backoff starts fresh', async () => {
            // Policy with multiplier=4 (schema max): delay(1)=100ms, delay(2)=400ms.
            // The large gap proves the 2nd start resets the counter.
            const bigBackoffPolicy = { baseDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 4, jitterFraction: 0 };

            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                throw new Error(`fail ${callCount}`);
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: bigBackoffPolicy });

            // First run: fail twice to advance internal attemptCount to 2
            loop.start();
            await Promise.resolve();
            expect(callCount).toBe(1); // first failure

            jest.advanceTimersByTime(100); // fires first retry (delay=100ms)
            expect(callCount).toBe(2); // second failure (synchronous in bun)

            await Promise.resolve();
            await Promise.resolve();
            // Second failure sets timer for 400ms; stop before it fires
            loop.stop();

            // Fresh start — attemptCount should be reset to 0
            loop.start();
            await Promise.resolve();
            expect(callCount).toBe(3); // third call from fresh start

            // With reset counter, delay(1)=100ms, NOT 400ms
            jest.advanceTimersByTime(99);
            expect(callCount).toBe(3); // no retry yet

            jest.advanceTimersByTime(1);
            expect(callCount).toBe(4); // retry fires at 100ms — confirms reset

            loop.stop();
        });
    });

    // -------------------------------------------------------------------------
    // restart() — re-engage without resetting attemptCount
    // -------------------------------------------------------------------------

    describe('restart()', () => {
        test('restart() does not reset attemptCount — next delay uses existing counter', async () => {
            // Policy with multiplier=4: delay(1)=100ms, delay(2)=400ms, delay(3)=1600ms.
            // After 2 failures, attemptCount=2. restart() should produce delay(3)=1600ms,
            // whereas start() would reset and produce delay(1)=100ms.
            const bigBackoffPolicy = { baseDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 4, jitterFraction: 0 };

            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                throw new Error(`fail ${callCount}`);
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: bigBackoffPolicy });

            // Fail twice to build up attemptCount to 2
            loop.start();
            await Promise.resolve();
            expect(callCount).toBe(1); // first failure

            jest.advanceTimersByTime(100); // fires retry at delay(1)=100ms
            expect(callCount).toBe(2); // second failure

            await Promise.resolve();
            await Promise.resolve();
            // Second failure has set a pending timer for delay(2)=400ms
            // Simulate SSE-after-open scenario: cancel that timer and restart without resetting counter
            loop.restart();
            await Promise.resolve();
            expect(callCount).toBe(3); // third call fired immediately by restart()

            await Promise.resolve();
            await Promise.resolve();
            // Third failure: attemptCount=3 → delay(3)=1600ms (NOT 100ms if counter were reset)
            // Advance 399ms — should NOT fire (would fire at 100ms if counter were reset)
            jest.advanceTimersByTime(399);
            expect(callCount).toBe(3);

            // Advance to 1600ms total — should fire
            jest.advanceTimersByTime(1201);
            expect(callCount).toBe(4);

            loop.stop();
        });

        test('restart() cancels any pending timer before triggering', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                if(callCount <= 3) {
                    throw new Error(`fail ${callCount}`);
                }
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            // A pending timer is now registered for the retry
            expect(jest.getTimerCount()).toBeGreaterThanOrEqual(1);

            // restart() must cancel that timer and fire immediately
            loop.restart();

            // There should be no timer from the cancelled one anymore
            // (a new one may be created after the new attempt fails, but connectFn is still in-flight now)
            // Verify by counting calls: restart() immediately invokes connectFn again
            expect(callCount).toBe(2);

            await Promise.resolve();
            await Promise.resolve();

            loop.stop();
        });

        test('restart() sends RECONNECT_ATTEMPT event', async () => {
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            sendEventMock.mockClear();

            loop.restart();

            const attempts = sendEventMock.mock.calls.filter(c => c[1] === 'RECONNECT_ATTEMPT');
            expect(attempts).toHaveLength(1);

            loop.stop();
        });

        test('restart() after stop() is a no-op — no connectFn call, no timer', async () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            loop.stop();

            const callsBefore = callCount;
            const timersBefore = jest.getTimerCount();

            loop.restart();

            expect(callCount).toBe(callsBefore);
            expect(jest.getTimerCount()).toBe(timersBefore);
        });

        test('restart() while connect is in-flight is a no-op — no parallel connectFn call', async () => {
            let resolveConnect!: () => void;
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
                await new Promise<void>((resolve) => {
                    resolveConnect = resolve;
                });
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start(); // attempt in-flight
            expect(callCount).toBe(1);

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const eventsBefore = sendEventMock.mock.calls.length;

            // Call restart() while connect is in-flight
            loop.restart();

            // Should not have started a parallel connectFn
            expect(callCount).toBe(1);
            // Should not have emitted a RECONNECT_ATTEMPT event (restart is a full no-op when in-flight)
            expect(sendEventMock.mock.calls).toHaveLength(eventsBefore);

            resolveConnect();
            await Promise.resolve();
            await Promise.resolve();
        });

        test('restart() before start() is a no-op — loop is not running', () => {
            let callCount = 0;
            const connectFn = mock(async () => {
                callCount += 1;
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.restart();

            expect(callCount).toBe(0);
            expect(jest.getTimerCount()).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // nextRetryAt calculation
    // -------------------------------------------------------------------------

    describe('nextRetryAt in CONNECT_FAIL payload', () => {
        test('nextRetryAt equals now() + calculateDelay(1, policy)', async () => {
            const nowMs = 2_000_000;
            const deps = { now: mock(() => nowMs) };
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({
                service: SERVICE,
                registry,
                connectFn,
                policy:  DETERMINISTIC_POLICY,
                deps,
            });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            // delay(1) = base=100, multiplier=2, no jitter = 100ms
            const expectedRetryAt = new Date(nowMs + 100);

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const failCall = sendEventMock.mock.calls.find(c => c[1] === 'CONNECT_FAIL');
            // eslint-disable-next-line @typescript-eslint/dot-notation -- bracket notation required for unknown Record type
            expect(failCall![2]!['nextRetryAt']).toEqual(expectedRetryAt);

            loop.stop();
        });
    });

    // -------------------------------------------------------------------------
    // Multiple start() calls
    // -------------------------------------------------------------------------

    describe('multiple start() calls', () => {
        test('start() while in-flight attempt exists: deduplicates, does not start a parallel connectFn', async () => {
            let resolveConnect!: () => void;
            const connectFn = mock(async () => {
                await new Promise<void>((resolve) => {
                    resolveConnect = resolve;
                });
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start(); // starts first attempt — in-flight
            // Call start() again while the first attempt is still pending
            loop.start();

            // connectFn should still only have been called once (deduplicated)
            expect(connectFn).toHaveBeenCalledTimes(1);

            resolveConnect();
            await Promise.resolve();
            await Promise.resolve();
        });

        test('second start() fires connectFn immediately', async () => {
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            loop.start();

            expect(connectFn).toHaveBeenCalledTimes(2);
            loop.stop();
        });

        test('second start() sends RECONNECT_ATTEMPT again', async () => {
            const connectFn = mock(async () => {
                throw new Error('fail');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            await Promise.resolve();
            await Promise.resolve();
            loop.stop();

            (registry.sendEvent as Mock<typeof registry.sendEvent>).mockClear();
            loop.start();

            const sendEventMock = registry.sendEvent as Mock<typeof registry.sendEvent>;
            const attempts = sendEventMock.mock.calls.filter(c => c[1] === 'RECONNECT_ATTEMPT');
            expect(attempts).toHaveLength(1);
            loop.stop();
        });
    });

    // -------------------------------------------------------------------------
    // No-retry when stopped before failure resolves
    // -------------------------------------------------------------------------

    describe('no-retry when loop stopped before failure resolves', () => {
        test('if running=false when failure resolves, no timer is set', async () => {
            let rejectFn!: (e: Error) => void;
            const connectFn = mock(async () => {
                await new Promise<void>((_resolve, reject) => {
                    rejectFn = reject;
                });
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });

            loop.start();
            loop.stop(); // stop before connectFn rejects

            rejectFn(new Error('fail'));
            await Promise.resolve();
            await Promise.resolve();

            // No timer should have been set because running=false when catch block ran
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(1000);
            expect(connectFn).toHaveBeenCalledTimes(1);
        });

        test('connectFn calls stop() before throwing — no timer is set', async () => {
            const loopRef: { loop?: ReturnType<typeof createReconnectionLoop> } = {};
            const connectFn = mock(async () => {
                loopRef.loop?.stop(); // sets running=false from within connectFn
                throw new Error('stopped inside');
            });
            const loop = createReconnectionLoop({ service: SERVICE, registry, connectFn, policy: DETERMINISTIC_POLICY });
            loopRef.loop = loop;

            loop.start();
            await Promise.resolve();
            await Promise.resolve();

            // running=false when catch ran, so outer if(running) guard prevented timer
            expect(jest.getTimerCount()).toBe(0);
            expect(connectFn).toHaveBeenCalledTimes(1);
        });
    });
});
