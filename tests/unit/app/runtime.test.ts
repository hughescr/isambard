/**
 * The session supervisor (`src/app/runtime.ts`): conductor open under a timeout with the per-role
 * failure policy, cross-session shutdown over exactly the sessions that opened, boot-time crash
 * recovery through a host adapter, and the `startSessions` readiness sequence.
 */
import { describe, test, expect, mock, spyOn, jest, afterEach } from 'bun:test';
import type { Logger } from '@hughescr/logger';
import { FakeClock } from '../../helpers/fake-clock';
import * as agentModule from '@/agent';
import type { BootRecoveryAdapter, BootRecoveryRuntime, JournalEntry, SessionOpenOutcome } from '@/agent';
import {
    CONDUCTOR_OPEN_TIMEOUT_MS,
    RECOVERY_WINDOW_MS,
    createBootRecoveryRuntime,
    createSessionSupervisor,
    startSessions,
    stopSessions,
    type CreateSessionSupervisorParams,
    type SessionHost,
    type SessionSupervisor
} from '@/app/runtime';
import { createStartupChain } from '@/app/startup-chain';

interface OpenResult {
    sessionId: string
    resumed:   boolean
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void } {
    let resolveFn!: (value: T) => void;
    let rejectFn!: (reason: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
    });
    return { promise, resolve: resolveFn, reject: rejectFn };
}

async function flush(count = 20): Promise<void> {
    for(let i = 0; i < count; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask drain, not a real async loop
        await Promise.resolve();
    }
}

function makeJournal(entries: JournalEntry[] = []) {
    return {
        append:    mock(() => undefined),
        flush:     mock(async () => undefined),
        readSince: mock(async (_sinceMs: number) => entries),
    };
}

function makeConductor(open: () => Promise<OpenResult> = async () => ({ sessionId: 'sess', resumed: false })) {
    return {
        open:     mock(open),
        shutdown: mock(async (_options: { turnWaitMs: number, deadlineMs: number }) => undefined),
    };
}

function makeLogger() {
    const logger = { info: mock(() => undefined), warn: mock(() => undefined), error: mock(() => undefined) };
    return logger as typeof logger & Pick<Logger, 'info' | 'warn' | 'error'>;
}

function never<T>(): Promise<T> {
    return new Promise<T>(() => {
        // Deliberately never settles — a wedged CLI child.
    });
}

function build(overrides: Partial<CreateSessionSupervisorParams> = {}) {
    const clock = new FakeClock(1_000_000_000);
    const logger = makeLogger();
    const exit = mock((_code: number) => undefined);
    const stopIngress = mock(() => undefined);
    const conversation = { conductor: makeConductor(), journal: makeJournal() };
    const perch = { conductor: makeConductor(), journal: makeJournal() };
    const params: CreateSessionSupervisorParams = {
        conversation,
        perch,
        turnWaitMs: 7000,
        deadlineMs: 9000,
        stopIngress,
        exit,
        clock,
        logger,
        ...overrides,
    };
    return { supervisor: createSessionSupervisor(params), clock, logger, exit, stopIngress, conversation, perch };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('createSessionSupervisor.openSessions: cancellation', () => {
    test('an aborted supervisor open cannot begin either session', async () => {
        const { supervisor, conversation, perch } = build();
        const controller = new AbortController();
        controller.abort();
        expect(await supervisor.openSessions(controller.signal)).toEqual({ conversation: 'absent', perch: 'absent' });
        expect(conversation.conductor.open).not.toHaveBeenCalled();
        expect(perch.conductor.open).not.toHaveBeenCalled();
        expect(supervisor.shutdown).toBeUndefined();
    });
});

describe('session supervisor constants', () => {
    test('CONDUCTOR_OPEN_TIMEOUT_MS is 30 seconds', () => {
        expect(CONDUCTOR_OPEN_TIMEOUT_MS).toBe(30_000);
    });

    test('RECOVERY_WINDOW_MS is 24 hours', () => {
        expect(RECOVERY_WINDOW_MS).toBe(86_400_000);
    });
});

describe('createSessionSupervisor.openSessions: conversation failure', () => {
    test('a rejected conversation open logs, exits 1 once and never attempts perch', async () => {
        const conversation = { conductor: makeConductor(() => Promise.reject(new Error('boom'))), journal: makeJournal() };
        const { supervisor, exit, logger, perch } = build({ conversation });

        const outcome = await supervisor.openSessions();

        expect(outcome).toEqual({ conversation: 'failed', perch: 'absent' });
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith({ error: 'boom', msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
        expect(perch.conductor.open).not.toHaveBeenCalled();
        expect(supervisor.shutdown).toBeUndefined();
    });

    test('a non-Error conversation rejection is logged as its string form', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection is the case under test
        const conversation = { conductor: makeConductor(() => Promise.reject('plain failure')), journal: makeJournal() };
        const { supervisor, logger } = build({ conversation });

        await supervisor.openSessions();

        expect(logger.error).toHaveBeenCalledWith({ error: 'plain failure', msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
    });

    test('a conversation open that never settles times out at 30s and exits 1', async () => {
        const conversation = { conductor: makeConductor(never), journal: makeJournal() };
        const { supervisor, clock, exit, logger, perch } = build({ conversation });

        const opening = supervisor.openSessions();
        await flush();
        clock.advance(29_999);
        await flush();
        expect(exit).not.toHaveBeenCalled();

        clock.advance(1);
        const outcome = await opening;

        expect(outcome).toEqual({ conversation: 'failed', perch: 'absent' });
        expect(exit).toHaveBeenCalledWith(1);
        expect(logger.error).toHaveBeenCalledWith({ error: 'conductor.open() timed out', msg: 'Conductor open() failed — exiting so the deploy supervisor restarts this process' });
        expect(perch.conductor.open).not.toHaveBeenCalled();
    });

    test('a custom openTimeoutMs bounds the conversation open', async () => {
        const conversation = { conductor: makeConductor(never), journal: makeJournal() };
        const { supervisor, clock, exit } = build({ conversation, openTimeoutMs: 5 });

        const opening = supervisor.openSessions();
        await flush();
        clock.advance(4);
        await flush();
        expect(exit).not.toHaveBeenCalled();

        clock.advance(1);
        await opening;

        expect(exit).toHaveBeenCalledWith(1);
    });
});

describe('createSessionSupervisor.openSessions: success and perch failure', () => {
    test('both sessions opening report open/open, never exit and leave no pending timer', async () => {
        const { supervisor, clock, exit, logger } = build();

        const outcome = await supervisor.openSessions();

        expect(outcome).toEqual({ conversation: 'open', perch: 'open' });
        expect(exit).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(clock.pending()).toBe(0);
    });

    test('a rejected conversation open also clears its timeout timer', async () => {
        const conversation = { conductor: makeConductor(() => Promise.reject(new Error('boom'))), journal: makeJournal() };
        const { supervisor, clock } = build({ conversation });

        await supervisor.openSessions();

        expect(clock.pending()).toBe(0);
    });

    test('a rejected perch open disables perch without exiting', async () => {
        const perch = { conductor: makeConductor(() => Promise.reject(new Error('perch boom'))), journal: makeJournal() };
        const { supervisor, exit, logger } = build({ perch });

        const outcome = await supervisor.openSessions();

        expect(outcome).toEqual({ conversation: 'open', perch: 'disabled' });
        expect(exit).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith({ error: 'perch boom', msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
    });

    test('a non-Error perch rejection is logged as its string form', async () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection is the case under test
        const perch = { conductor: makeConductor(() => Promise.reject('perch plain')), journal: makeJournal() };
        const { supervisor, logger } = build({ perch });

        await supervisor.openSessions();

        expect(logger.error).toHaveBeenCalledWith({ error: 'perch plain', msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
    });

    test('a perch open that never settles times out and disables perch', async () => {
        const perch = { conductor: makeConductor(never), journal: makeJournal() };
        const { supervisor, clock, exit, logger } = build({ perch });

        const opening = supervisor.openSessions();
        await flush();
        clock.advance(29_999);
        await flush();
        expect(logger.error).not.toHaveBeenCalled();

        clock.advance(1);
        const outcome = await opening;

        expect(outcome).toEqual({ conversation: 'open', perch: 'disabled' });
        expect(exit).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith({ error: 'perch conductor.open() timed out', msg: 'Perch conductor open() failed — perch disabled for this process, no restart' });
    });

    test('perch opens only after the conversation open has resolved', async () => {
        const conversationOpen = deferred<OpenResult>();
        const conversation = { conductor: makeConductor(() => conversationOpen.promise), journal: makeJournal() };
        const { supervisor, perch } = build({ conversation });

        const opening = supervisor.openSessions();
        await flush();
        expect(conversation.conductor.open).toHaveBeenCalledTimes(1);
        expect(perch.conductor.open).not.toHaveBeenCalled();

        conversationOpen.resolve({ sessionId: 'sess', resumed: false });
        await opening;

        expect(perch.conductor.open).toHaveBeenCalledTimes(1);
    });

    test('a second openSessions call returns the same promise and opens each conductor once', async () => {
        const { supervisor, conversation, perch } = build();

        const first = supervisor.openSessions();
        const second = supervisor.openSessions();

        expect(second).toBe(first);
        await first;
        expect(conversation.conductor.open).toHaveBeenCalledTimes(1);
        expect(perch.conductor.open).toHaveBeenCalledTimes(1);
    });

    test('omitted sessions report absent/absent and open nothing', async () => {
        const { supervisor, exit } = build({ conversation: undefined, perch: undefined });

        const outcome = await supervisor.openSessions();

        expect(outcome).toEqual({ conversation: 'absent', perch: 'absent' });
        expect(exit).not.toHaveBeenCalled();
    });
});

describe('createSessionSupervisor.shutdown', () => {
    test('shutdown is undefined before openSessions has run', () => {
        const { supervisor } = build();

        expect(supervisor.shutdown).toBeUndefined();
    });

    test('with both sessions open, run() stops ingress first, then shuts down conversation then perch, then flushes both journals once', async () => {
        const { supervisor, stopIngress, conversation, perch, logger } = build();
        const order: string[] = [];
        stopIngress.mockImplementation(() => {
            order.push('stopIngress');
        });
        conversation.conductor.shutdown.mockImplementation(async () => {
            order.push('conversation.shutdown');
        });
        perch.conductor.shutdown.mockImplementation(async () => {
            order.push('perch.shutdown');
        });
        await supervisor.openSessions();

        const result = await supervisor.shutdown!.run();

        expect(result).toEqual({ forced: false });
        expect(order).toEqual(['stopIngress', 'conversation.shutdown', 'perch.shutdown']);
        expect(conversation.conductor.shutdown).toHaveBeenCalledWith({ turnWaitMs: 7000, deadlineMs: 9000 });
        expect(perch.conductor.shutdown).toHaveBeenCalledWith({ turnWaitMs: 7000, deadlineMs: 9000 });
        expect(conversation.journal.flush).toHaveBeenCalledTimes(1);
        expect(perch.journal.flush).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith({ forced: false, sessionCount: 2, msg: 'Shutdown sequence complete' });
    });

    test('names the shutdown sessions conversation then perch', async () => {
        const createShutdownSpy = spyOn(agentModule, 'createShutdown');
        const { supervisor } = build();

        await supervisor.openSessions();

        expect(createShutdownSpy).toHaveBeenCalledTimes(1);
        expect(createShutdownSpy.mock.calls[0][0].sessions.map(session => session.name)).toEqual(['conversation', 'perch']);
    });

    test('with perch disabled, run() covers only the conversation session and journal', async () => {
        const perch = { conductor: makeConductor(() => Promise.reject(new Error('perch boom'))), journal: makeJournal() };
        const { supervisor, conversation, logger } = build({ perch });
        await supervisor.openSessions();

        await supervisor.shutdown!.run();

        expect(conversation.conductor.shutdown).toHaveBeenCalledTimes(1);
        expect(conversation.journal.flush).toHaveBeenCalledTimes(1);
        expect(perch.conductor.shutdown).not.toHaveBeenCalled();
        expect(perch.journal.flush).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith({ forced: false, sessionCount: 1, msg: 'Shutdown sequence complete' });
    });

    test('with no conversation session and perch open, run() covers only perch', async () => {
        const { supervisor, perch } = build({ conversation: undefined });
        await supervisor.openSessions();

        await supervisor.shutdown!.run();

        expect(perch.conductor.shutdown).toHaveBeenCalledTimes(1);
        expect(perch.journal.flush).toHaveBeenCalledTimes(1);
    });

    test('with nothing opened, shutdown stays undefined', async () => {
        const { supervisor } = build({ conversation: undefined, perch: undefined });
        await supervisor.openSessions();

        expect(supervisor.shutdown).toBeUndefined();
    });

    test('a rejecting conversation journal flush still flushes the perch journal', async () => {
        const { supervisor, conversation, perch } = build();
        conversation.journal.flush.mockImplementation(() => Promise.reject(new Error('journal down')));
        await supervisor.openSessions();

        await expect(supervisor.shutdown!.run()).resolves.toEqual({ forced: false });

        expect(perch.journal.flush).toHaveBeenCalledTimes(1);
    });

    test('run() waits for both journal flushes before resolving', async () => {
        const { supervisor, conversation, perch } = build();
        const conversationFlush = deferred<undefined>();
        const perchFlush = deferred<undefined>();
        conversation.journal.flush.mockImplementation(() => conversationFlush.promise);
        perch.journal.flush.mockImplementation(() => perchFlush.promise);
        await supervisor.openSessions();

        let settled = false;
        const running = supervisor.shutdown!.run().then(() => {
            settled = true;
            return undefined;
        });
        conversationFlush.resolve(undefined);
        await flush();
        expect(settled).toBe(false);

        perchFlush.resolve(undefined);
        await running;
        expect(settled).toBe(true);
    });

    test('run() still waits for the perch journal flush after the conversation flush rejects', async () => {
        const { supervisor, conversation, perch } = build();
        const perchFlush = deferred<undefined>();
        conversation.journal.flush.mockImplementation(() => Promise.reject(new Error('journal down')));
        perch.journal.flush.mockImplementation(() => perchFlush.promise);
        await supervisor.openSessions();

        let settled = false;
        const running = supervisor.shutdown!.run().then(() => {
            settled = true;
            return undefined;
        });
        await flush(50);
        expect(settled).toBe(false);

        perchFlush.resolve(undefined);
        await running;
        expect(settled).toBe(true);
    });

    test('the deadline timer comes from the injected clock', async () => {
        const { supervisor, clock, conversation } = build({ perch: undefined });
        conversation.conductor.shutdown.mockImplementation(never);
        await supervisor.openSessions();

        const running = supervisor.shutdown!.run();
        await flush();
        clock.advance(9000);

        await expect(running).resolves.toEqual({ forced: true });
    });
});

describe('createBootRecoveryRuntime', () => {
    const at = new Date(999_000_000);
    const entries: JournalEntry[] = [
        { type: 'envelope_submitted', at, envelopeId: 'env-1', kind: 'discord', channelId: 'chan-1' },
        { type: 'turn_completed', at, envelopeId: 'env-1', kind: 'discord', responseText: 'hello there' },
    ];

    test('loadRecovery reads the journal from exactly the recovery window before now and recomputes recovery and knownAt', async () => {
        const journal = makeJournal(entries);
        const runtime = createBootRecoveryRuntime(journal, new FakeClock(1_000_000_000), makeLogger());

        const loaded = await runtime.loadRecovery();

        expect(journal.readSince).toHaveBeenCalledTimes(1);
        expect(journal.readSince).toHaveBeenCalledWith(1_000_000_000 - 86_400_000);
        expect(loaded.knownAt).toEqual(at);
        expect(loaded.recovery.undelivered).toEqual([{ envelopeId: 'env-1', envelopeKind: 'discord', channelId: 'chan-1', responseText: 'hello there' }]);
    });

    test('runBoot runs the boot sequence over the given journal: one flush, one gate open', async () => {
        const journal = makeJournal();
        const logger = makeLogger();
        const runtime = createBootRecoveryRuntime(journal, new FakeClock(), logger);
        const ingressGate = { open: mock((_ids: ReadonlySet<string>) => undefined) };

        const result = await runtime.runBoot<{ id: string }>({
            recovery:        { undelivered: [] },
            deliver:         mock(async () => undefined),
            replayUnhandled: async () => [{ id: 'm-1' }],
            submitReplay:    mock(async () => undefined),
            submitCatchUp:   mock(async () => undefined),
            unreadCount:     () => 0,
            ingressGate,
        });

        expect(result).toEqual({ replayedCount: 1, catchUpSubmitted: false });
        expect(journal.flush).toHaveBeenCalledTimes(1);
        expect(ingressGate.open).toHaveBeenCalledTimes(1);
        expect(ingressGate.open).toHaveBeenCalledWith(new Set(['m-1']));
        expect(logger.info).toHaveBeenNthCalledWith(1, { redeliveredCount: 0, replayedCount: 1, msg: 'Boot recovery: response redelivery and message replay complete' });
        expect(logger.info).toHaveBeenNthCalledWith(2, { msg: 'Boot recovery: journal flushed' });
        expect(logger.info).toHaveBeenNthCalledWith(3, { replayedCount: 1, msg: 'Boot recovery: ingress gate opened' });
    });
});

describe('createSessionSupervisor.runRecovery', () => {
    function makeAdapter() {
        const runtimes: BootRecoveryRuntime[] = [];
        const adapter: BootRecoveryAdapter & { recover: ReturnType<typeof mock> } = {
            recover: mock(async (runtime: BootRecoveryRuntime) => {
                runtimes.push(runtime);
            }),
        };
        return { adapter, runtimes };
    }

    test('after the conversation opened, invokes the adapter exactly once with a runtime over the conversation journal', async () => {
        const { supervisor, conversation, perch } = build();
        const { adapter, runtimes } = makeAdapter();
        await supervisor.openSessions();

        await supervisor.runRecovery(adapter);

        expect(adapter.recover).toHaveBeenCalledTimes(1);
        await runtimes[0].loadRecovery();
        expect(conversation.journal.readSince).toHaveBeenCalledWith(1_000_000_000 - 86_400_000);
        expect(perch.journal.readSince).not.toHaveBeenCalled();
    });

    test('stays pending until the adapter\'s recovery settles', async () => {
        const { supervisor } = build();
        const recovered = deferred<undefined>();
        const adapter = { recover: mock(() => recovered.promise) };
        await supervisor.openSessions();

        let settled = false;
        const running = supervisor.runRecovery(adapter).then(() => {
            settled = true;
            return undefined;
        });
        await flush();
        expect(settled).toBe(false);

        recovered.resolve(undefined);
        await running;
        expect(settled).toBe(true);
    });

    test('does nothing when the conversation open failed', async () => {
        const conversation = { conductor: makeConductor(() => Promise.reject(new Error('boom'))), journal: makeJournal() };
        const { supervisor } = build({ conversation });
        const { adapter } = makeAdapter();
        await supervisor.openSessions();

        await supervisor.runRecovery(adapter);

        expect(adapter.recover).not.toHaveBeenCalled();
    });

    test('does nothing when no conversation session was built', async () => {
        const { supervisor } = build({ conversation: undefined });
        const { adapter } = makeAdapter();
        await supervisor.openSessions();

        await supervisor.runRecovery(adapter);

        expect(adapter.recover).not.toHaveBeenCalled();
    });

    test('does nothing before openSessions has run', async () => {
        const { supervisor } = build();
        const { adapter } = makeAdapter();

        await supervisor.runRecovery(adapter);

        expect(adapter.recover).not.toHaveBeenCalled();
    });
});

describe('startSessions', () => {
    function makeHost(ready: Promise<void> = Promise.resolve()) {
        const order: string[] = [];
        const recover = mock(async (_runtime: BootRecoveryRuntime) => {
            order.push('recover');
        });
        const host = {
            ready,
            attachSessions: mock(async (_outcome: SessionOpenOutcome, _shutdown: unknown) => {
                order.push('attachSessions');
            }),
            recoveryAdapter: { recover },
        } satisfies SessionHost;
        return { host, order, recover };
    }

    function makeSupervisor(order: string[]) {
        const outcome: SessionOpenOutcome = { conversation: 'open', perch: 'disabled' };
        const shutdown = { run: mock(async () => ({ forced: false })) };
        const supervisor = {
            openSessions: mock(async () => {
                order.push('openSessions');
                return outcome;
            }),
            shutdown,
            runRecovery: mock(async (adapter: BootRecoveryAdapter) => {
                order.push('runRecovery');
                await adapter.recover({} as BootRecoveryRuntime);
            }),
        } satisfies SessionSupervisor;
        return { supervisor, outcome, shutdown };
    }

    test('stop releases an unresolved ready wait and late readiness cannot open sessions', async () => {
        const ready = deferred<undefined>();
        const { host, order } = makeHost(ready.promise);
        const { supervisor, shutdown } = makeSupervisor(order);
        const chain = createStartupChain(signal => startSessions({ host, supervisor, logger: makeLogger(), signal }), async () => {
            await supervisor.shutdown.run();
        });
        const starting = chain();
        await chain.stop();
        await starting;
        ready.resolve(undefined);
        await flush();
        expect(supervisor.openSessions).not.toHaveBeenCalled();
        expect(host.attachSessions).not.toHaveBeenCalled();
        expect(supervisor.runRecovery).not.toHaveBeenCalled();
        expect(shutdown.run).toHaveBeenCalledTimes(1);
    });

    test.each([false, true])('readiness listener is removed after normal completion or abort=%s', async (abort) => {
        const { host, order } = makeHost(abort ? never() : Promise.resolve());
        const { supervisor } = makeSupervisor(order);
        const controller = new AbortController();
        const add = spyOn(controller.signal, 'addEventListener');
        const remove = spyOn(controller.signal, 'removeEventListener');
        const starting = startSessions({ host, supervisor, logger: makeLogger(), signal: controller.signal });
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0]?.[0]).toBe('abort');
        if(abort) {
            controller.abort();
        }
        await starting;
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    });

    test('an already aborted startup returns even when the host never becomes ready', async () => {
        const { host, order } = makeHost(never());
        const { supervisor } = makeSupervisor(order);
        const controller = new AbortController();
        controller.abort();
        let completed = false;
        const starting = startSessions({ host, supervisor, logger: makeLogger(), signal: controller.signal }).then(() => {
            completed = true;
            return undefined;
        });
        await flush();
        expect(completed).toBe(true);
        await starting;
        expect(supervisor.openSessions).not.toHaveBeenCalled();
    });

    test('shutdown joins startup and host stop before releasing unattached sessions', async () => {
        const startupWait = deferred<undefined>();
        const hostWait = deferred<undefined>();
        const startup = { stop: mock(() => startupWait.promise) };
        const host = { stop: mock(() => hostWait.promise) };
        const { supervisor, shutdown } = makeSupervisor([]);
        const stopping = stopSessions({ startup, host, supervisor });
        await flush();
        expect(startup.stop).toHaveBeenCalledTimes(1);
        expect(host.stop).not.toHaveBeenCalled();
        expect(shutdown.run).not.toHaveBeenCalled();
        startupWait.resolve(undefined);
        await flush();
        expect(host.stop).toHaveBeenCalledTimes(1);
        expect(shutdown.run).not.toHaveBeenCalled();
        hostWait.resolve(undefined);
        await stopping;
        expect(shutdown.run).toHaveBeenCalledTimes(1);
    });

    test('host stop closes attached sessions before the fallback reruns the idempotent shutdown', async () => {
        const { supervisor, conversation, perch } = build();
        await supervisor.openSessions();
        const host = { stop: mock(async () => {
            expect(conversation.conductor.shutdown).not.toHaveBeenCalled();
            expect(perch.conductor.shutdown).not.toHaveBeenCalled();
            await supervisor.shutdown?.run();
        }) };
        await stopSessions({ startup: { stop: async () => undefined }, host, supervisor });
        expect(conversation.conductor.shutdown).toHaveBeenCalledTimes(1);
        expect(perch.conductor.shutdown).toHaveBeenCalledTimes(1);
    });

    test('fallback shutdown runs after a host stop failure and stop awaits its completion', async () => {
        const shutdownWait = deferred<undefined>();
        const host = { stop: mock(async () => {
            throw new Error('host stop failed');
        }) };
        const shutdown = { run: mock(async () => {
            await shutdownWait.promise;
            return { forced: false };
        }) };
        let completed = false;
        const stopping = stopSessions({ startup: { stop: async () => undefined }, host, supervisor: { shutdown } }).catch((error: unknown) => {
            completed = true;
            return error;
        });
        await flush();
        expect(shutdown.run).toHaveBeenCalledTimes(1);
        expect(completed).toBe(false);
        shutdownWait.resolve(undefined);
        expect(await stopping).toEqual(new Error('host stop failed'));
    });

    test('stop with no opened sessions still stops the host', async () => {
        const host = { stop: mock(async () => undefined) };
        await stopSessions({ startup: { stop: async () => undefined }, host, supervisor: { shutdown: undefined } });
        expect(host.stop).toHaveBeenCalledTimes(1);
    });

    test('an already aborted startup never opens even for a ready host', async () => {
        const { host, order } = makeHost();
        const { supervisor } = makeSupervisor(order);
        const controller = new AbortController();
        controller.abort();
        await startSessions({ host, supervisor, logger: makeLogger(), signal: controller.signal });
        expect(supervisor.openSessions).not.toHaveBeenCalled();
    });

    test.each(['conversation', 'perch'] as const)('stop during %s open joins then shuts down opened owners without opening more or attaching', async (role) => {
        const opening = deferred<OpenResult>();
        const conversation = { conductor: makeConductor(role === 'conversation' ? () => opening.promise : undefined), journal: makeJournal() };
        const perch = { conductor: makeConductor(role === 'perch' ? () => opening.promise : undefined), journal: makeJournal() };
        const { supervisor, logger } = build({ conversation, perch });
        const { host } = makeHost();
        const chain = createStartupChain(signal => startSessions({ host, supervisor, logger, signal }), async () => {
            await supervisor.shutdown?.run();
        });
        const starting = chain();
        await flush();
        const stopping = chain.stop();
        await flush();
        expect(conversation.conductor.shutdown).not.toHaveBeenCalled();
        expect(perch.conductor.shutdown).not.toHaveBeenCalled();
        opening.resolve({ sessionId: 'opened', resumed: false });
        await stopping;
        await starting;
        expect(host.attachSessions).not.toHaveBeenCalled();
        expect(host.recoveryAdapter.recover).not.toHaveBeenCalled();
        const perchOpens = role === 'conversation' ? 0 : 1;
        expect(perch.conductor.open).toHaveBeenCalledTimes(perchOpens);
        expect(conversation.conductor.shutdown).toHaveBeenCalledTimes(1);
        expect(perch.conductor.shutdown).toHaveBeenCalledTimes(perchOpens);
        // The host may also call the same shutdown during bot.stop().
        await supervisor.shutdown?.run();
        expect(conversation.conductor.shutdown).toHaveBeenCalledTimes(1);
        expect(perch.conductor.shutdown).toHaveBeenCalledTimes(perchOpens);
    });

    test('stop during attachment waits for it but skips recovery', async () => {
        const attaching = deferred<undefined>();
        const { host, order } = makeHost();
        host.attachSessions.mockImplementation(() => attaching.promise);
        const { supervisor, shutdown } = makeSupervisor(order);
        const chain = createStartupChain(signal => startSessions({ host, supervisor, logger: makeLogger(), signal }), async () => {
            await supervisor.shutdown.run();
        });
        void chain();
        await flush();
        expect(host.attachSessions).toHaveBeenCalledTimes(1);
        const stopping = chain.stop();
        await flush();
        expect(shutdown.run).not.toHaveBeenCalled();
        attaching.resolve(undefined);
        await stopping;
        expect(supervisor.runRecovery).not.toHaveBeenCalled();
        expect(shutdown.run).toHaveBeenCalledTimes(1);
    });

    test('stop during recovery waits for it before shutdown', async () => {
        const recovering = deferred<undefined>();
        const { host, order } = makeHost();
        const { supervisor, shutdown } = makeSupervisor(order);
        supervisor.runRecovery.mockImplementation(() => recovering.promise);
        const chain = createStartupChain(signal => startSessions({ host, supervisor, logger: makeLogger(), signal }), async () => {
            await supervisor.shutdown.run();
        });
        void chain();
        await flush();
        expect(supervisor.runRecovery).toHaveBeenCalledTimes(1);
        const stopping = chain.stop();
        await flush();
        expect(shutdown.run).not.toHaveBeenCalled();
        recovering.resolve(undefined);
        await stopping;
        expect(shutdown.run).toHaveBeenCalledTimes(1);
    });

    test('opens nothing until the host signals readiness', async () => {
        const ready = deferred<undefined>();
        const { host, order } = makeHost(ready.promise);
        const { supervisor } = makeSupervisor(order);
        const logger = makeLogger();

        const starting = startSessions({ host, supervisor, logger });
        await flush();
        expect(supervisor.openSessions).not.toHaveBeenCalled();

        ready.resolve(undefined);
        await starting;
        expect(supervisor.openSessions).toHaveBeenCalledTimes(1);
    });

    test('opens sessions, attaches them with the outcome and shutdown, then runs recovery through the host adapter', async () => {
        const { host, order } = makeHost();
        const { supervisor, outcome, shutdown } = makeSupervisor(order);
        const logger = makeLogger();

        await startSessions({ host, supervisor, logger });

        expect(order).toEqual(['openSessions', 'attachSessions', 'runRecovery', 'recover']);
        expect(logger.info).toHaveBeenCalledWith({ conversation: 'open', perch: 'disabled', msg: 'Sessions opened and attached to Discord' });
        expect(host.attachSessions).toHaveBeenCalledWith(outcome, shutdown);
        expect(supervisor.runRecovery).toHaveBeenCalledWith(host.recoveryAdapter);
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('a failing recovery is logged and never rejects', async () => {
        const { host, order } = makeHost();
        const { supervisor } = makeSupervisor(order);
        const failure = new Error('recovery failed');
        supervisor.runRecovery.mockImplementation(() => Promise.reject(failure));
        const logger = makeLogger();

        await expect(startSessions({ host, supervisor, logger })).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith({ err: failure, msg: 'Session startup failed' });
    });

    test('a failing attach is logged, skips recovery and never rejects', async () => {
        const { host, order } = makeHost();
        const failure = new Error('attach failed');
        host.attachSessions.mockImplementation(() => Promise.reject(failure));
        const { supervisor } = makeSupervisor(order);
        const logger = makeLogger();

        await expect(startSessions({ host, supervisor, logger })).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith({ err: failure, msg: 'Session startup failed' });
        expect(supervisor.runRecovery).not.toHaveBeenCalled();
    });
});
