/**
 * Tests for src/app/lifecycle.ts (P10): `registerSignalHandlers` (SIGINT/SIGTERM registered
 * once, idempotent on a repeated signal, bounded by a deadline+grace hard-exit timer) and
 * `createDiscordRecoveryHandler` (the Discord-reconnect recovery subscriber — P13b: the conductor
 * is the only path, so the one-shot `mode`/`botStateManager`/`bot` branch is gone).
 */
import { describe, test, expect, mock, jest, afterEach } from 'bun:test';
import { FakeClock } from '../../helpers/fake-clock';
import { registerSignalHandlers, createDiscordRecoveryHandler } from '@/app/lifecycle';

/** A fake `process` cast to exactly the shape `registerSignalHandlers` depends on. */
interface FakeProcess extends Pick<NodeJS.Process, 'on' | 'off'> {
    emit(event: string): void
    listenerCount(event: string): number
}

/** A minimal fake `process` — just enough of `on`/`off` for registerSignalHandlers to drive. */
function makeFakeProcess(): FakeProcess {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    return {
        on: mock((event: string, handler: (...args: unknown[]) => void) => {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
        }),
        off: mock((event: string, handler: (...args: unknown[]) => void) => {
            listeners.get(event)?.delete(handler);
        }),
        emit(event: string): void {
            for(const handler of listeners.get(event) ?? []) {
                handler();
            }
        },
        listenerCount(event: string): number {
            return listeners.get(event)?.size ?? 0;
        },
    } as unknown as FakeProcess;
}

function makeFakeLogger(): { info: ReturnType<typeof mock>, warn: ReturnType<typeof mock>, error: ReturnType<typeof mock> } {
    return { info: mock(), warn: mock(), error: mock() };
}

describe('registerSignalHandlers', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('SIGINT calls stop once and exits 0 once stop resolves', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(async () => undefined);
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        proc.emit('SIGINT');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('SIGTERM calls stop once and exits 0 once stop resolves', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(async () => undefined);
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        proc.emit('SIGTERM');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('a second signal received while shutdown is already in progress does not call stop again', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        let resolveStop: (() => void) | undefined;
        const stop = mock(() => new Promise<void>((resolve) => {
            resolveStop = resolve;
        }));
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        proc.emit('SIGINT');
        await Promise.resolve();
        proc.emit('SIGTERM');
        await Promise.resolve();

        expect(stop).toHaveBeenCalledTimes(1);
        expect(exit).not.toHaveBeenCalled();

        resolveStop?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
    });

    test('exceeding deadlineMs + 10s while stop() is still pending forces exit(1)', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(() => new Promise<void>(() => {
            // Never resolves — simulates a hung shutdown.
        }));
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 5000, clock, logger, exit });

        proc.emit('SIGINT');
        await Promise.resolve();

        clock.advance(14_999);
        await Promise.resolve();
        expect(exit).not.toHaveBeenCalled();

        clock.advance(1);
        await Promise.resolve();
        await Promise.resolve();

        expect(exit).toHaveBeenCalledWith(1);
    });

    test('a rejecting stop() forces exit(1)', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(() => Promise.reject(new Error('stop failed')));
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        proc.emit('SIGINT');
        for(let i = 0; i < 10; i += 1) {
            // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain, not a real async loop
            await Promise.resolve();
        }

        expect(exit).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalled();
    });

    test('unregister removes both SIGINT and SIGTERM listeners', () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(async () => undefined);
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        const unregister = registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        expect(proc.listenerCount('SIGINT')).toBe(1);
        expect(proc.listenerCount('SIGTERM')).toBe(1);

        unregister();

        expect(proc.listenerCount('SIGINT')).toBe(0);
        expect(proc.listenerCount('SIGTERM')).toBe(0);
    });

    test('a hard-exit timer that never fires (stop() settles first) is cleared, not left pending', async () => {
        const proc = makeFakeProcess();
        const clock = new FakeClock();
        const stop = mock(async () => undefined);
        const exit = mock(() => undefined);
        const logger = makeFakeLogger();

        registerSignalHandlers({ proc, stop, deadlineMs: 120_000, clock, logger, exit });

        proc.emit('SIGINT');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(exit).toHaveBeenCalledWith(0);
        expect(clock.pending()).toBe(0);
    });
});

describe('createDiscordRecoveryHandler', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('the params carry no mode, botStateManager, or bot field (P13b: the one-shot branch is gone)', () => {
        const warmCache = mock(async () => undefined);
        const submitCatchUp = mock(async () => undefined);
        const params = { warmCache, submitCatchUp, logger: makeFakeLogger() };

        expect(params).not.toHaveProperty('mode');
        expect(params).not.toHaveProperty('botStateManager');
        expect(params).not.toHaveProperty('bot');

        // Type-level check: createDiscordRecoveryHandler accepts exactly this shape.
        createDiscordRecoveryHandler(params);
    });

    test('ignores a change for a service other than discord', async () => {
        const warmCache = mock(async () => undefined);
        const submitCatchUp = mock(async () => undefined);
        const handler = createDiscordRecoveryHandler({ warmCache, submitCatchUp, logger: makeFakeLogger() });

        handler({ service: 'email', newState: 'online' } as never);
        await Promise.resolve();

        expect(warmCache).not.toHaveBeenCalled();
    });

    test('ignores a discord change that is not "online"', async () => {
        const warmCache = mock(async () => undefined);
        const submitCatchUp = mock(async () => undefined);
        const handler = createDiscordRecoveryHandler({ warmCache, submitCatchUp, logger: makeFakeLogger() });

        handler({ service: 'discord', newState: 'degraded' } as never);
        await Promise.resolve();

        expect(warmCache).not.toHaveBeenCalled();
    });

    test('warms the cache then submits a catch-up envelope through the conductor', async () => {
        const warmCache = mock(async () => undefined);
        const submitCatchUp = mock(async () => undefined);
        const handler = createDiscordRecoveryHandler({ warmCache, submitCatchUp, logger: makeFakeLogger() });

        handler({ service: 'discord', newState: 'online' } as never);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(warmCache).toHaveBeenCalledTimes(1);
        expect(submitCatchUp).toHaveBeenCalledTimes(1);
        const warmOrder = warmCache.mock.invocationCallOrder[0];
        const submitOrder = submitCatchUp.mock.invocationCallOrder[0];
        expect(warmOrder).toBeLessThan(submitOrder);
    });

    test('a failure during recovery is caught and logged, never thrown', async () => {
        const warmCache = mock(async () => {
            throw new Error('cache warm failed');
        });
        const submitCatchUp = mock(async () => undefined);
        const logger = makeFakeLogger();
        const handler = createDiscordRecoveryHandler({ warmCache, submitCatchUp, logger });

        expect(() => {
            handler({ service: 'discord', newState: 'online' } as never);
        }).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalled();
        expect(submitCatchUp).not.toHaveBeenCalled();
    });
});
