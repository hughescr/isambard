/**
 * Tests for setupTaskBoard: the wiring that turns ledger events (and a refresh tick) into
 * `TaskBoardManager.applyViews` calls. The manager itself is stubbed here — its behaviour is
 * covered in manager.test.ts — so these tests are about subscription, composition and the
 * running-only refresh interval.
 */
import { describe, test, expect, mock, spyOn, beforeEach, afterEach, jest } from 'bun:test';
import type { Client } from 'discord.js';
import type { Ledger, LedgerStore } from '@/agent/session/ledger';
import type { TaskBoardConfig } from '@/config';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import * as managerModule from '@/integrations/discord/task-board/manager';
import type { TaskBoardManagerDeps } from '@/integrations/discord/task-board/manager';
import { setupTaskBoard } from '@/integrations/discord/task-board/setup';
import type { TaskBoardView } from '@/integrations/discord/task-board/types';

const T0 = new Date('2026-09-09T20:36:43.000Z');

const CONFIG: TaskBoardConfig = { enabled: true, editIntervalMs: 3000, refreshIntervalMs: 10_000 };

/** A ledger-shaped object with one task; `channelId`/`turnId` are what give it a board. */
function ledgerWith(tasks: Record<string, unknown>[]): Ledger {
    return { role: 'conversation', tasks, finishedTasks: [] } as unknown as Ledger;
}

function runningTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id:          'task-1',
        taskType:    'local_agent',
        kind:        'subagent',
        description: 'do a thing',
        background:  true,
        channelId:   'chan-1',
        turnId:      'turn-1',
        startedAt:   T0,
        status:      'running',
        ...overrides,
    };
}

/** A LedgerStore stub whose snapshot can be swapped and whose subscribers can be fired. */
function fakeStore(initial: Ledger): { store: LedgerStore, set: (ledger: Ledger) => void, emit: () => void, unsubscribe: ReturnType<typeof mock> } {
    let current = initial;
    const listeners: (() => void)[] = [];
    const unsubscribe = mock(() => undefined);
    return {
        store: {
            dispatch:  mock(() => undefined),
            get:       () => current,
            subscribe: ((listener: () => void) => {
                listeners.push(listener);
                return unsubscribe;
            }) as unknown as LedgerStore['subscribe'],
        },
        set: (ledger: Ledger): void => {
            current = ledger;
        },
        emit: (): void => {
            for(const listener of listeners) {
                listener();
            }
        },
        unsubscribe,
    };
}

describe('setupTaskBoard', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    let applyViews: ReturnType<typeof mock>;
    let managerStop: ReturnType<typeof mock>;
    let capturedDeps: TaskBoardManagerDeps | undefined;
    let logger: { debug: ReturnType<typeof mock>, warn: ReturnType<typeof mock> };
    let readyClient: Client;
    let rateLimiter: DiscordRateLimiter;

    /** All views passed to applyViews, most recent last. */
    function applied(): TaskBoardView[][] {
        return (applyViews.mock.calls as [TaskBoardView[]][]).map(call => call[0]);
    }

    beforeEach(() => {
        jest.useFakeTimers();
        applyViews = mock(() => undefined);
        managerStop = mock(() => undefined);
        capturedDeps = undefined;
        logger = { debug: mock(), warn: mock() };
        readyClient = {} as unknown as Client;
        rateLimiter = {} as unknown as DiscordRateLimiter;

        spies.push(
            // @ts-expect-error — mocking a constructor
            spyOn(managerModule, 'TaskBoardManager').mockImplementation((deps: TaskBoardManagerDeps): managerModule.TaskBoardManager => {
                capturedDeps = deps;
                return { applyViews, stop: managerStop } as unknown as managerModule.TaskBoardManager;
            })
        );
    });

    afterEach(() => {
        jest.useRealTimers();
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    test('builds the manager from the config, time zone and injected clock', () => {
        const store = fakeStore(ledgerWith([]));
        const now = (): Date => T0;

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [store.store],
            config:   CONFIG,
            timeZone: 'America/Los_Angeles',
            logger,
            now,
        });

        expect(capturedDeps?.client).toBe(readyClient);
        expect(capturedDeps?.rateLimiter).toBe(rateLimiter);
        expect(capturedDeps?.logger).toBe(logger);
        expect(capturedDeps?.editIntervalMs).toBe(3000);
        expect(capturedDeps?.timeZone).toBe('America/Los_Angeles');
        expect(capturedDeps?.now).toBe(now);

        board.stop();
    });

    test('defaults the clock to the system clock when none is injected', () => {
        const store = fakeStore(ledgerWith([]));

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [store.store],
            config:   CONFIG,
            timeZone: 'UTC',
            logger,
        });

        expect(capturedDeps?.now).toBeDefined();
        expect(capturedDeps?.now()).toBeInstanceOf(Date);
        expect(applied()).toHaveLength(1);

        board.stop();
    });

    test('composes and applies once synchronously at setup', () => {
        const store = fakeStore(ledgerWith([runningTask()]));

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [store.store],
            config:   CONFIG,
            timeZone: 'UTC',
            logger,
            now:      () => T0,
        });

        expect(applied()).toHaveLength(1);
        expect(applied()[0].map(view => view.key)).toEqual(['chan-1:turn-1']);

        board.stop();
    });

    test('composes across every ledger', () => {
        const conversation = fakeStore(ledgerWith([runningTask()]));
        const perch = fakeStore({ role: 'perch', tasks: [runningTask({ id: 'task-2', channelId: 'chan-2', turnId: 'turn-2' })], finishedTasks: [] } as unknown as Ledger);

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [conversation.store, perch.store],
            config:   CONFIG,
            timeZone: 'UTC',
            logger,
            now:      () => T0,
        });

        expect(applied()[0].map(view => view.key)).toEqual(['chan-1:turn-1', 'chan-2:turn-2']);

        board.stop();
    });

    test('re-composes on every ledger event', () => {
        const store = fakeStore(ledgerWith([]));

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [store.store],
            config:   CONFIG,
            timeZone: 'UTC',
            logger,
            now:      () => T0,
        });
        expect(applied()[0]).toEqual([]);

        store.set(ledgerWith([runningTask()]));
        store.emit();

        expect(applied()).toHaveLength(2);
        expect(applied()[1].map(view => view.key)).toEqual(['chan-1:turn-1']);

        board.stop();
    });

    test('subscribes to every ledger', () => {
        const first = fakeStore(ledgerWith([]));
        const second = fakeStore(ledgerWith([]));

        const board = setupTaskBoard({
            readyClient,
            rateLimiter,
            ledgers:  [first.store, second.store],
            config:   CONFIG,
            timeZone: 'UTC',
            logger,
            now:      () => T0,
        });

        second.emit();
        expect(applied()).toHaveLength(2);
        first.emit();
        expect(applied()).toHaveLength(3);

        board.stop();
    });

    describe('fallback channel', () => {
        /** A resolver whose settlement the test controls. */
        function deferredResolver(): { resolver: ReturnType<typeof mock>, resolve: (id: string | undefined) => void, reject: (error: unknown) => void } {
            const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
            return { resolver: mock(() => promise), resolve, reject };
        }

        test('a channel-less task gets no board until the fallback resolves, then re-ticks onto it', async () => {
            const store = fakeStore(ledgerWith([runningTask({ channelId: undefined })]));
            const deferred = deferredResolver();

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:                  [store.store],
                config:                   CONFIG,
                timeZone:                 'UTC',
                logger,
                now:                      () => T0,
                resolveFallbackChannelId: deferred.resolver,
            });
            expect(applied()).toEqual([[]]);

            deferred.resolve('fallback-1');
            await Promise.resolve();
            await Promise.resolve();

            expect(applied()).toHaveLength(2);
            expect(applied()[1].map(view => view.key)).toEqual(['fallback-1:turn-1']);

            board.stop();
        });

        test('resolves once per distinct ledger role', async () => {
            const conversation = fakeStore(ledgerWith([]));
            const perch = fakeStore({ role: 'perch', tasks: [], finishedTasks: [] } as unknown as Ledger);
            const again = fakeStore(ledgerWith([]));
            const resolver = mock(async (role: string) => `${role}-fallback`);

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:                  [conversation.store, perch.store, again.store],
                config:                   CONFIG,
                timeZone:                 'UTC',
                logger,
                now:                      () => T0,
                resolveFallbackChannelId: resolver,
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(resolver.mock.calls).toEqual([['conversation'], ['perch']]);

            perch.set({ role: 'perch', tasks: [runningTask({ channelId: undefined })], finishedTasks: [] } as unknown as Ledger);
            perch.emit();
            expect(applied().at(-1)?.map(view => view.key)).toEqual(['perch-fallback:turn-1']);

            board.stop();
        });

        test('a resolver that yields nothing leaves channel-less tasks without a board and does not re-tick', async () => {
            const store = fakeStore(ledgerWith([runningTask({ channelId: undefined })]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:                  [store.store],
                config:                   CONFIG,
                timeZone:                 'UTC',
                logger,
                now:                      () => T0,
                resolveFallbackChannelId: async () => undefined,
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(applied()).toEqual([[]]);
            expect(logger.warn).not.toHaveBeenCalled();

            board.stop();
        });

        test('a resolver that rejects is logged once and channel-less tasks stay without a board', async () => {
            const store = fakeStore(ledgerWith([runningTask({ channelId: undefined })]));
            const error = new Error('registry down');

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:                  [store.store],
                config:                   CONFIG,
                timeZone:                 'UTC',
                logger,
                now:                      () => T0,
                resolveFallbackChannelId: () => Promise.reject(error),
            });
            await Promise.resolve();
            await Promise.resolve();

            expect(applied()).toEqual([[]]);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0]?.[0]).toEqual({ role: 'conversation', error, msg: 'Task board fallback channel lookup failed; channel-less tasks get no board' });

            board.stop();
        });

        test('a fallback that resolves after stop() is not applied', async () => {
            const store = fakeStore(ledgerWith([runningTask({ channelId: undefined })]));
            const deferred = deferredResolver();

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:                  [store.store],
                config:                   CONFIG,
                timeZone:                 'UTC',
                logger,
                now:                      () => T0,
                resolveFallbackChannelId: deferred.resolver,
            });
            board.stop();

            deferred.resolve('fallback-1');
            await Promise.resolve();
            await Promise.resolve();

            expect(applied()).toEqual([[]]);
        });

        test('without a resolver, channel-less tasks get no board', () => {
            const store = fakeStore(ledgerWith([runningTask({ channelId: undefined })]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            expect(applied()).toEqual([[]]);

            board.stop();
        });
    });

    describe('refresh interval', () => {
        test('re-ticks while a board is running', () => {
            const store = fakeStore(ledgerWith([runningTask()]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });
            expect(applied()).toHaveLength(1);

            jest.advanceTimersByTime(9999);
            expect(applied()).toHaveLength(1);

            jest.advanceTimersByTime(1);
            expect(applied()).toHaveLength(2);

            jest.advanceTimersByTime(10_000);
            expect(applied()).toHaveLength(3);

            board.stop();
        });

        test('does not arm a second interval on a later tick', () => {
            const store = fakeStore(ledgerWith([runningTask()]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            store.emit();
            store.emit();
            expect(applied()).toHaveLength(3);

            jest.advanceTimersByTime(10_000);
            expect(applied()).toHaveLength(4);

            board.stop();
        });

        test('never arms an interval when nothing is running', () => {
            const store = fakeStore(ledgerWith([]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            jest.advanceTimersByTime(100_000);
            expect(applied()).toHaveLength(1);

            board.stop();
        });

        test('clears the interval once every board has settled', () => {
            const store = fakeStore(ledgerWith([runningTask()]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            store.set({ role: 'conversation', tasks: [], finishedTasks: [runningTask({ status: 'completed', finishedAt: T0 })] } as unknown as Ledger);
            store.emit();
            expect(applied()).toHaveLength(2);
            expect(applied()[1][0].state).toBe('done');

            jest.advanceTimersByTime(100_000);
            expect(applied()).toHaveLength(2);

            board.stop();
        });

        // The manager keeps a settled board's message alive for a second launch under the same
        // key, so the composer can report `running` again after reporting `done`; the refresh has
        // to come back with it.
        test('re-arms the interval when a settled board starts running again', () => {
            const store = fakeStore(ledgerWith([runningTask()]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            store.set({ role: 'conversation', tasks: [], finishedTasks: [runningTask({ status: 'completed', finishedAt: T0 })] } as unknown as Ledger);
            store.emit();
            expect(applied()[1][0].state).toBe('done');

            jest.advanceTimersByTime(100_000);
            expect(applied()).toHaveLength(2);

            store.set({
                role:          'conversation',
                tasks:         [runningTask({ id: 'task-2' })],
                finishedTasks: [runningTask({ status: 'completed', finishedAt: T0 })],
            } as unknown as Ledger);
            store.emit();
            expect(applied()).toHaveLength(3);
            expect(applied()[2][0].state).toBe('running');

            jest.advanceTimersByTime(10_000);
            expect(applied()).toHaveLength(4);

            board.stop();
        });

        test('honours a custom refresh interval', () => {
            const store = fakeStore(ledgerWith([runningTask()]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   { enabled: true, editIntervalMs: 500, refreshIntervalMs: 2000 },
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            jest.advanceTimersByTime(2000);
            expect(applied()).toHaveLength(2);

            board.stop();
        });
    });

    describe('stop', () => {
        test('unsubscribes every ledger, clears the interval and stops the manager', () => {
            const first = fakeStore(ledgerWith([runningTask()]));
            const second = fakeStore(ledgerWith([]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [first.store, second.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            board.stop();

            expect(first.unsubscribe).toHaveBeenCalledTimes(1);
            expect(second.unsubscribe).toHaveBeenCalledTimes(1);
            expect(managerStop).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(100_000);
            expect(applied()).toHaveLength(1);
        });

        test('is safe when no interval was ever armed', () => {
            const store = fakeStore(ledgerWith([]));

            const board = setupTaskBoard({
                readyClient,
                rateLimiter,
                ledgers:  [store.store],
                config:   CONFIG,
                timeZone: 'UTC',
                logger,
                now:      () => T0,
            });

            expect(() => {
                board.stop();
            }).not.toThrow();
            expect(managerStop).toHaveBeenCalledTimes(1);
        });
    });
});
