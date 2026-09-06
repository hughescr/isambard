/**
 * Tests for the cross-session shutdown orchestrator (P10).
 *
 * @module tests/unit/agent/session/shutdown
 */
import { describe, it, expect, mock } from 'bun:test';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { createShutdown, type ShutdownSession } from '@/agent/session/shutdown';

/** Flushes enough microtask ticks for `run()`'s internal promise chain (past `await stopIngress()`) to reach its `clock.setTimer` calls. */
async function flush(): Promise<void> {
    for(let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

/** A deferred promise, for scripting a fake session's `shutdown()` resolution from the test body. */
function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
    let resolveFn!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolveFn = resolve;
    });
    return { promise, resolve: resolveFn };
}

describe('createShutdown', () => {
    function makeLogger(): { info: ReturnType<typeof mock>, warn: ReturnType<typeof mock>, error: ReturnType<typeof mock> } {
        return { info: mock(), warn: mock(), error: mock() };
    }

    it('stops ingress before any session shutdown is called', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const callLog: string[] = [];
        const stopIngress = mock(() => {
            callLog.push('stopIngress');
        });
        const session: ShutdownSession = {
            name:     'conversation',
            shutdown: mock(async () => {
                callLog.push('session:conversation');
            }),
        };

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        await shutdown.run();

        expect(callLog).toEqual(['stopIngress', 'session:conversation']);
    });

    it('calls every session\'s own shutdown concurrently with the configured turnWaitMs/deadlineMs', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const conversationDeferred = deferred<void>();
        const perchDeferred = deferred<void>();
        const conversationShutdown = mock(() => conversationDeferred.promise);
        const perchShutdown = mock(() => perchDeferred.promise);
        const sessions: ShutdownSession[] = [
            { name: 'conversation', shutdown: conversationShutdown },
            { name: 'perch', shutdown: perchShutdown },
        ];

        const shutdown = createShutdown({
            sessions, journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        const runPromise = shutdown.run();
        await flush();

        // Both sessions' shutdown() are called before either has resolved — proves concurrency,
        // not a sequential await of one before starting the other.
        expect(conversationShutdown).toHaveBeenCalledWith({ turnWaitMs: 1000, deadlineMs: 5000 });
        expect(perchShutdown).toHaveBeenCalledWith({ turnWaitMs: 1000, deadlineMs: 5000 });

        conversationDeferred.resolve();
        perchDeferred.resolve();
        const result = await runPromise;

        expect(result).toEqual({ forced: false });
    });

    it('flushes the journal after every session has settled', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const callLog: string[] = [];
        const session: ShutdownSession = {
            name:     'conversation',
            shutdown: async () => {
                callLog.push('session:shutdown');
            },
        };
        const flushSpy = mock(async () => {
            callLog.push('journal:flush');
        });
        journal.flush = flushSpy;

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        await shutdown.run();

        expect(callLog).toEqual(['session:shutdown', 'journal:flush']);
    });

    it('a rejecting journal.flush() is caught and logged, and run() still resolves with forced:false', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const flushError = new Error('journal backend unavailable');
        journal.scriptFlushRejection(flushError);
        const session: ShutdownSession = {
            name:     'conversation',
            shutdown: mock(async () => undefined),
        };
        const logger = makeLogger();

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger,
        });

        await expect(shutdown.run()).resolves.toEqual({ forced: false });

        expect(logger.error).toHaveBeenCalledWith({ error: flushError }, 'Shutdown: journal flush failed');
    });

    it('forces completion when deadlineMs elapses before every session has settled', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const stuck = deferred<void>();
        const session: ShutdownSession = {
            name:     'conversation',
            shutdown: () => stuck.promise,
        };

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        const runPromise = shutdown.run();
        await flush();
        clock.advance(5000);
        const result = await runPromise;

        expect(result).toEqual({ forced: true });
    });

    it('does not flush the journal when the deadline forces completion first', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const stuck = deferred<void>();
        const session: ShutdownSession = {
            name:     'conversation',
            shutdown: () => stuck.promise,
        };

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        const runPromise = shutdown.run();
        await flush();
        clock.advance(5000);
        await runPromise;

        expect(journal.flushCount).toBe(0);
    });

    it('second run() returns the same promise and never calls stopIngress or any session shutdown twice', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const stopIngress = mock(() => undefined);
        const sessionShutdown = mock(async () => undefined);
        const session: ShutdownSession = { name: 'conversation', shutdown: sessionShutdown };

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        const first = shutdown.run();
        const second = shutdown.run();

        expect(second).toBe(first);
        await first;
        await second;

        expect(stopIngress).toHaveBeenCalledTimes(1);
        expect(sessionShutdown).toHaveBeenCalledTimes(1);
    });

    it('calling run() again after completion still returns the original settled promise, not a fresh run', async () => {
        const clock = new FakeClock();
        const journal = new FakeJournal();
        const sessionShutdown = mock(async () => undefined);
        const session: ShutdownSession = { name: 'conversation', shutdown: sessionShutdown };

        const shutdown = createShutdown({
            sessions: [session], journal, stopIngress: () => undefined, clock, turnWaitMs: 1000, deadlineMs: 5000, logger: makeLogger(),
        });

        await shutdown.run();
        await shutdown.run();

        expect(sessionShutdown).toHaveBeenCalledTimes(1);
    });
});
