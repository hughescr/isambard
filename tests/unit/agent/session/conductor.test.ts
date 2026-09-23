/**
 * Behavioural tests for {@link createConductor} (design doc section 6): the long-lived session
 * conductor. Every timing assertion runs on {@link FakeClock} — no real timers, no real delays.
 * Uses P3's {@link fakeQueryFn}/{@link FakeQuery} to drive the reader loop deterministically, and
 * the P3/P7 in-memory port doubles ({@link FakeJournal}, {@link FakeResumeStore}).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { SDKMessage, SDKNotificationMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { fakeQueryFn, type FakeQuery, type FakeQueryFnOptions } from '../../../helpers/fake-query';
import { FakeResumeStore } from '../../../helpers/fake-resume-store';
import * as frames from '../../../helpers/sdk-frames';
import { createConductor, type BootBundleRequest, type Conductor, type CreateConductorParams } from '@/agent/session/conductor';
import { createCostCeiling } from '@/agent/session/cost-ceiling';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import { createTaskLaunchRegistry } from '@/agent/session/task-launch-registry';
import type { Envelope, SessionQueryFn } from '@/agent/session/types';
import { DEFAULT_RETRY_CONFIG } from '@/config/retry-config';
import { sessionConfigSchema, type SessionConfig } from '@/config/schemas';
import { ResponseUnavailableError } from '@/errors';
import type { ErrorClassification, RetryPolicy } from '@/utils';

/** Flushes enough microtask ticks for the conductor's promise chains (reader loop, guard.onTurnEnd, retry scheduling) to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: unknown) => void } {
    return Promise.withResolvers<T>();
}

let idCounter = 0;

function discordEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    idCounter += 1;
    return {
        id:           `discord-${idCounter}`,
        kind:         'discord',
        text:         `discord text ${idCounter}`,
        channelId:    'chan-1',
        authorId:     'user-1',
        origin:       { kind: 'human' },
        hostPriority: 'human',
        shouldQuery:  true,
        createdAt:    new Date(0),
        ...overrides,
    };
}

function notificationFrame(key: string): SDKNotificationMessage {
    return {
        type:       'system',
        subtype:    'notification',
        key,
        text:       'compaction trouble',
        priority:   'high',
        uuid:       '00000000-0000-0000-0000-000000000000',
        session_id: 'session-1',
    };
}

function catchupEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    idCounter += 1;
    return {
        id:           `catchup-${idCounter}`,
        kind:         'catchup',
        text:         `catchup text ${idCounter}`,
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    new Date(0),
        ...overrides,
    };
}

function peerEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    idCounter += 1;
    return {
        id:           `peer-${idCounter}`,
        kind:         'peer',
        text:         `[PEER · Izzy-main]\n\npeer text ${idCounter}`,
        peer:         { from: 'uds:/tmp/cc-socks/94548.sock', fromName: 'Izzy-main' },
        hostPriority: 'wake',
        shouldQuery:  true,
        createdAt:    new Date(0),
        ...overrides,
    };
}

function notificationEnvelope(overrides: Partial<Envelope> = {}): Envelope {
    idCounter += 1;
    return {
        id:           `notification-${idCounter}`,
        kind:         'notification',
        text:         `notification text ${idCounter}`,
        hostPriority: 'accumulate',
        shouldQuery:  false,
        createdAt:    new Date(0),
        ...overrides,
    };
}

interface Harness {
    conductor:        Conductor
    instances:        FakeQuery[]
    clock:            FakeClock
    journal:          FakeJournal
    resumeStore:      FakeResumeStore
    ledgerStore:      LedgerStore
    logger:           { info: ReturnType<typeof jest.fn>, warn: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn>, debug: ReturnType<typeof jest.fn> }
    readRss:          ReturnType<typeof jest.fn>
    /** The `buildBootBundle` override, when a test passed a `jest.fn` one — so its calls can be read back. */
    buildBootBundle?: ReturnType<typeof jest.fn>
}

const DEFAULT_CONFIG: SessionConfig = sessionConfigSchema.parse({});
const FAST_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 2, jitterFraction: 0 };

function build(overrides: Partial<CreateConductorParams> = {}, queryFnOptions: FakeQueryFnOptions = {}): Harness {
    const { queryFn, instances } = fakeQueryFn(queryFnOptions);
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const ledgerStore = createLedgerStore('conversation', { logger: { error: jest.fn() } });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const readRss = jest.fn(() => 4096);

    const conductor = createConductor({
        role:         'conversation',
        queryFn,
        // Echoes `resume` back into the Options a test can read off FakeQuery.receivedParams, so
        // a reopen's resume-vs-fresh choice is directly observable.
        buildOptions: (resume?: string) => (resume === undefined ? {} : { resume }),
        clock,
        readRss,
        ledgerStore,
        config:       DEFAULT_CONFIG,
        retryPolicy:  FAST_RETRY_POLICY,
        journal,
        resumeStore,
        logger,
        ...overrides,
    });

    return {
        conductor, instances, clock, journal, resumeStore, ledgerStore, logger, readRss,
        buildBootBundle: overrides.buildBootBundle as ReturnType<typeof jest.fn> | undefined,
    };
}

/** The text of the `[BOOT]` handshake an instance consumed first. */
function handshakeOf(instance: FakeQuery): string {
    const content = instance.consumedPrompts[0]?.message.content;
    return Array.isArray(content) ? content.map(block => (block.type === 'text' ? block.text : '')).join('') : String(content);
}

/** Opens `h.conductor` against `h.instances[0]`, emitting the init frame and flushing. */
async function openWith(h: Harness, sessionId = 'sess-1'): Promise<{ sessionId: string, resumed: boolean }> {
    const openPromise = h.conductor.open();
    await flush();
    h.instances[0].emit(frames.init(sessionId));
    const result = await openPromise;
    await flush();
    return result;
}

/** The prompts a fake instance consumed AFTER its opening handshake (always its first consumed prompt — see the open() describe block) — i.e. the ones real turns/appends pushed. */
function turnPrompts(instance: FakeQuery): SDKUserMessage[] {
    return instance.consumedPrompts.slice(1);
}

/**
 * A {@link SessionQueryFn} whose query yields `system/init` and then, one microtask later, the
 * bare result acknowledging the handshake (echoing its wire uuid, carrying `totalCostUsd`) — the
 * tightest ordering the real CLI can produce when both lines land in one stdout read, and one
 * {@link FakeQuery}'s async-generator iterator is too slow to reproduce. `ackRead()` reports
 * whether the session has read the acknowledgement's echo yet (the queue's claim reads it first).
 * Only the first query opened behaves this way; later ones go to `later` when given.
 */
function initThenAckQueryFn(sessionId: string, totalCostUsd: number, later?: SessionQueryFn): { queryFn: SessionQueryFn, ackRead: () => boolean } {
    let read = false;
    let calls = 0;
    const queryFn: SessionQueryFn = (params) => {
        calls += 1;
        if(calls > 1 && later !== undefined) {
            return later(params);
        }
        const inbox = params.prompt[Symbol.asyncIterator]();
        let step = 0;
        let handshake: SDKUserMessage | undefined;
        const iterator: AsyncIterator<SDKMessage> = {
            next: () => {
                step += 1;
                if(step === 1) {
                    return inbox.next().then((first) => {
                        handshake = first.value as SDKUserMessage;
                        return { done: false, value: frames.init(sessionId) };
                    });
                }
                if(step === 2 && handshake !== undefined) {
                    const echo = frames.echoOf(handshake);
                    const ack = frames.bareResult({ total_cost_usd: totalCostUsd, user_message_uuid: echo.user_message_uuid });
                    Object.defineProperty(ack, 'user_message_uuids', {
                        enumerable: true,
                        get:        () => {
                            read = true;
                            return echo.user_message_uuids;
                        },
                    });
                    return Promise.resolve({ done: false, value: ack });
                }
                // Parks for good: this query simply stays open with nothing more to say.
                return new Promise<IteratorResult<SDKMessage>>(() => {
                    // never settles
                });
            },
        };
        return {
            interrupt:              () => Promise.resolve(undefined),
            close:                  () => undefined,
            stopTask:               () => Promise.resolve(),
            streamInput:            () => Promise.resolve(),
            getContextUsage:        () => Promise.resolve(frames.contextUsage({ percentage: 0 })),
            [Symbol.asyncIterator]: () => iterator,
        };
    };
    return { queryFn, ackRead: () => read };
}

describe('createConductor', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('open()', () => {
        it('with no stored resume id: opens fresh, journals session_opened outcome fresh with cause boot, saves the id', async () => {
            const h = build();

            const result = await openWith(h, 'sess-fresh');

            expect(result).toEqual({ sessionId: 'sess-fresh', resumed: false });
            expect(h.instances).toHaveLength(1);
            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-fresh', outcome: 'fresh', cause: 'boot' },
            ]);
            await expect(h.resumeStore.load('conversation')).resolves.toBe('sess-fresh');
        });

        it('with a stored resume id: passes it to buildOptions and journals outcome resumed with cause boot', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            const buildOptions = jest.fn<CreateConductorParams['buildOptions']>().mockReturnValue({});
            const h2 = build({ buildOptions, resumeStore: h.resumeStore });

            const result = await openWith(h2, 'sess-old');

            expect(result).toEqual({ sessionId: 'sess-old', resumed: true });
            expect(buildOptions).toHaveBeenCalledWith('sess-old', 'boot');
            expect(h2.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-old', outcome: 'resumed', cause: 'boot' },
            ]);
        });

        it('resume attempt failing immediately falls back to a fresh open journaled as outcome resume_fallback with cause boot', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            const resumeError = new Error('resume rejected by CLI');

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail(resumeError);
            await flush();
            h.instances[1].emit(frames.init('sess-new'));
            const result = await openPromise;

            expect(result).toEqual({ sessionId: 'sess-new', resumed: false });
            expect(h.instances).toHaveLength(2);
            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-new', outcome: 'resume_fallback', cause: 'boot' },
            ]);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: resumeError },
                'Resuming the stored session failed; opening a fresh session'
            );
        });

        it('a resume that opens a live handle but whose finishOpen rejects discards that handle before falling back to a fresh session — no leaked concurrent session', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            h.resumeStore.scriptSaveRejection(new Error('DynamoDB throttled'));

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-old')); // the resume "opens" (a live handle exists)...
            await flush();

            // ...but finishOpen's resumeStore.save() rejects, so the resumed handle must be
            // closed rather than left running alongside the fresh fallback handle.
            expect(h.instances[0].closeCalls).toBe(1);

            h.resumeStore.scriptSaveRejection(undefined);
            expect(h.instances).toHaveLength(2);
            h.instances[1].emit(frames.init('sess-new'));
            const result = await openPromise;

            expect(result).toEqual({ sessionId: 'sess-new', resumed: false });
            expect(h.journal.byKind('session_opened').at(-1)).toEqual(
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-new', outcome: 'resume_fallback', cause: 'boot' }
            );
        });

        it('pushes the built boot bundle as the opening handshake boot envelope, building it once as fresh/boot before the query exists', async () => {
            let instancesWhenBuilt = -1;
            const h = build({
                buildBootBundle: jest.fn(() => {
                    instancesWhenBuilt = h.instances.length;
                    return 'welcome back';
                }),
            });

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(handshakeOf(h.instances[0])).toBe('welcome back');
            expect(h.buildBootBundle?.mock.calls).toEqual([[{
                kind: 'fresh', cause: 'boot', lostTasks: [], undelivered: [],
            }]]);
            expect(instancesWhenBuilt).toBe(0);
        });

        it('a stored-id open builds the bundle once as restart_resume/boot, before the query exists, and pushes it as the resume handshake', async () => {
            let instancesWhenBuilt = -1;
            const h = build({
                buildBootBundle: jest.fn(() => {
                    instancesWhenBuilt = h.instances.length;
                    return 'while you were away';
                }),
            });
            await h.resumeStore.save('conversation', 'sess-old');

            await expect(openWith(h, 'sess-old')).resolves.toEqual({ sessionId: 'sess-old', resumed: true });

            expect(h.buildBootBundle?.mock.calls).toEqual([[{
                kind: 'restart_resume', cause: 'boot', lostTasks: [], undelivered: [],
            }]]);
            expect(instancesWhenBuilt).toBe(0);
            expect(handshakeOf(h.instances[0])).toBe('while you were away');
        });

        it('a boot open whose resume fails builds a FRESH bundle for the fallback, and the fallback handshake carries it rather than the restart_resume text', async () => {
            const h = build({ buildBootBundle: jest.fn(({ kind }: { kind: string }) => `bundle for ${kind}`) });
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            expect(handshakeOf(h.instances[0])).toBe('bundle for restart_resume');
            expect(h.buildBootBundle?.mock.calls).toHaveLength(1);
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(h.buildBootBundle?.mock.calls).toEqual([
                [{ kind: 'restart_resume', cause: 'boot', lostTasks: [], undelivered: [] }],
                [{ kind: 'fresh', cause: 'boot', lostTasks: [], undelivered: [] }],
            ]);
            expect(h.instances[1].consumedPrompts).toHaveLength(1);
            expect(handshakeOf(h.instances[1])).toBe('bundle for fresh');
            h.instances[1].emit(frames.init('sess-new'));
            await expect(openPromise).resolves.toEqual({ sessionId: 'sess-new', resumed: false });
        });

        it('pushes the opening handshake BEFORE the session id arrives: the SDK only emits system/init after its first user message, so a silent open never opens', async () => {
            const h = build();

            const openPromise = h.conductor.open();
            await flush();

            // Nothing has been emitted yet — this push is what makes the CLI emit init at all.
            const [handshake, ...rest] = h.instances[0].consumedPrompts;
            expect(rest).toHaveLength(0);
            expect(handshake.shouldQuery).toBe(false);
            expect(JSON.stringify(handshake.message)).toContain('[BOOT] Session opened at 1970-01-01T00:00:00.000Z. No boot context to report.');

            h.instances[0].emit(frames.init('sess-1'));
            await expect(openPromise).resolves.toEqual({ sessionId: 'sess-1', resumed: false });
        });

        it('an empty built boot bundle falls back to the bare open marker rather than pushing an empty handshake', async () => {
            const h = build({ buildBootBundle: jest.fn(() => '') });

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(handshakeOf(h.instances[0])).toBe('[BOOT] Session opened at 1970-01-01T00:00:00.000Z. No boot context to report. Host handshake — nothing to do, no reply expected.');
        });

        it('an empty restart_resume bundle falls back to the bare resume marker', async () => {
            const h = build({ buildBootBundle: jest.fn(() => '') });
            await h.resumeStore.save('conversation', 'sess-old');

            await openWith(h, 'sess-old');

            expect(handshakeOf(h.instances[0])).toBe('[BOOT] Session resumed at 1970-01-01T00:00:00.000Z. No boot context to report. Host handshake — nothing to do, no reply expected.');
        });

        it('a resumed open with no boot bundle says "Session resumed", and the fresh fallback after a failed resume says "Session opened"', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('[BOOT] Session resumed at 1970-01-01T00:00:00.000Z.');
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(JSON.stringify(h.instances[1].consumedPrompts[0].message)).toContain('[BOOT] Session opened at 1970-01-01T00:00:00.000Z.');
            h.instances[1].emit(frames.init('sess-new'));
            await expect(openPromise).resolves.toEqual({ sessionId: 'sess-new', resumed: false });
        });

        it('the handshake acknowledgement arriving after a submitted turn\'s prompt was read never settles that turn (real SDK 0.3.280 ordering on a submit right after open)', async () => {
            // Observed on the real CLI: when the host submits in the same tick as init, the CLI
            // reads that user message BEFORE it writes the handshake's bare result. That bare
            // result used to settle the new turn with "" and orphan its real reply.
            const h = build({ buildBootBundle: jest.fn(() => 'welcome back') });
            await openWith(h);

            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const [handshake, turn] = h.instances[0].consumedPrompts;
            expect(turn.shouldQuery).toBe(true);

            h.instances[0].emitAck(handshake);
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('discord');
            expect(h.ledgerStore.get().turn?.kind).toBe('discord');
            expect(h.journal.byKind('turn_completed')).toEqual([]);

            h.instances[0].emit(frames.assistantText('the real reply'));
            h.instances[0].emit(frames.resultSuccess({ result: 'the real reply', ...frames.echoOf(turn) }));

            await expect(submitted).resolves.toMatchObject({ response: 'the real reply', isError: false });
            expect(h.journal.byKind('turn_completed')).toEqual([expect.objectContaining({ responseText: 'the real reply' })]);
        });

        it('the handshake result arriving before the first submitted turn leaves that turn to be settled by its own result', async () => {
            const h = build({ buildBootBundle: jest.fn(() => 'welcome back') });
            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            h.instances[0].emit(frames.bareResult());
            await openPromise;
            await flush();

            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.assistantText('the real reply'));
            h.instances[0].emit(frames.resultSuccess({ result: 'the real reply' }));

            await expect(submitted).resolves.toMatchObject({ response: 'the real reply', isError: false });
        });

        it('a mid-life reopen pushes a reopen handshake so the replacement session emits init', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            expect(h.instances).toHaveLength(2);
            const [handshake] = h.instances[1].consumedPrompts;
            expect(handshake.shouldQuery).toBe(false);
            expect(JSON.stringify(handshake.message)).toContain('[BOOT] Session reopened');
        });

        it('rejects with the string itself as the message when the query fails with a plain non-empty string before opening', async () => {
            const h = build();

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail('boom');

            await expect(openPromise).rejects.toThrow(new Error('boom'));
        });

        it('rejects with the fallback message, not an empty one, when the query fails with an empty string before opening', async () => {
            const h = build();

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail('');

            await expect(openPromise).rejects.toThrow(new Error('Session closed before it opened'));
        });

        it('rejects with the fallback message when the query fails with a non-Error, non-string value before opening', async () => {
            const h = build();

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail({ code: 'ESOMETHING' });

            await expect(openPromise).rejects.toThrow(new Error('Session closed before it opened'));
        });

        it('a submit() arriving in the gap after a failed resume\'s finishOpen discarded its handle, before the fresh fallback settles, trips the beginTurn invariant', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            h.resumeStore.scriptSaveRejection(new Error('DynamoDB throttled'));

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-old')); // the resume "opens" (a live handle exists)...
            await flush();

            // ...but finishOpen's resumeStore.save() rejects, discarding the resumed handle — opened
            // is already true (set synchronously inside finishOpen before its rejecting await), so
            // submit() no longer rejects with "not open", yet currentQueue/currentHandleRef are now
            // undefined until the fresh fallback settles below.
            expect(h.instances[0].closeCalls).toBe(1);

            await expect(h.conductor.submit(discordEnvelope(), { priority: 'human' })).rejects.toThrow(
                new Error('Invariant violated in conductor.beginTurn: called before open() assigned currentQueue — every call site (processQueue, submitCompact) only runs once opened is true')
            );

            h.resumeStore.scriptSaveRejection(undefined);
            h.instances[1].emit(frames.init('sess-new'));
            await openPromise;
        });

        it('a result frame arriving on the discarded handle during the resume-fallback gap surfaces "Conductor has no active session" from getContextUsage via the compaction guard', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            h.resumeStore.scriptSaveRejection(new Error('DynamoDB throttled'));

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].emit(frames.init('sess-old'));
            await flush();
            expect(h.instances[0].closeCalls).toBe(1); // resumed handle discarded; currentHandleRef/currentQueue are now undefined

            // A frame from the now-discarded handle still flows through onFrame -> afterResult ->
            // guard.onTurnEnd(), since openWithHandle's onFrame callback calls the conductor's frame
            // handler unconditionally, regardless of whether this handle is still "current".
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'Conductor has no active session' }) },
                expect.any(String)
            );

            h.resumeStore.scriptSaveRejection(undefined);
            h.instances[1].emit(frames.init('sess-new'));
            await openPromise;
        });

        it('SessionConfig defaults match the design constants', () => {
            expect(DEFAULT_CONFIG.compactThresholdPercent).toBe(60);
            expect(DEFAULT_CONFIG.humanWaitTargetMs).toBe(10_000);
            expect(DEFAULT_CONFIG.humanWaitCeilingMs).toBe(30_000);
            expect(DEFAULT_CONFIG.shutdownTurnWaitMs).toBe(60_000);
            expect(DEFAULT_CONFIG.shutdownDeadlineMs).toBe(120_000);
        });
    });

    describe('shouldQuery:false acknowledgements (SDK 0.3.280 answers every no-query message with its own bare result)', () => {
        it('an append made just before a submit, acknowledged after the turn prompt was read, does not settle the turn', async () => {
            const h = build();
            await openWith(h);

            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'quiet note' }))).toBe(true);
            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const [handshake, append, turn] = h.instances[0].consumedPrompts;
            expect([handshake.shouldQuery, append.shouldQuery, turn.shouldQuery]).toEqual([false, false, true]);

            h.instances[0].emitAck(handshake);
            h.instances[0].emitAck(append);
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('discord');
            expect(h.journal.byKind('turn_completed')).toEqual([]);

            h.instances[0].emit(frames.resultSuccess({ result: 'answer', ...frames.echoOf(turn) }));
            await expect(submitted).resolves.toMatchObject({ response: 'answer', isError: false });
        });

        it('an append made mid-turn, acknowledged after the next queued turn has begun, settles neither turn early and leaves the ledger turn open', async () => {
            const h = build();
            await openWith(h);
            const first = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const second = h.conductor.submit(catchupEnvelope({ text: 'second turn' }), { priority: 'other' });
            await flush();
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'mid-turn note' }))).toBe(true);
            await flush();
            const [, firstTurn, append] = h.instances[0].consumedPrompts;

            h.instances[0].emit(frames.resultSuccess({ result: 'first answer', total_cost_usd: 0.05, ...frames.echoOf(firstTurn) }));
            await expect(first).resolves.toMatchObject({ response: 'first answer' });
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('catchup');
            const secondTurn = h.instances[0].consumedPrompts[3];
            expect(JSON.stringify(secondTurn.message)).toContain('second turn');

            h.instances[0].emitAck(append, { total_cost_usd: 0.05 });
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('catchup');
            expect(h.ledgerStore.get().turn?.kind).toBe('catchup');
            expect(h.ledgerStore.get().cost).toEqual({ cumulativeUsd: 0.05, lastTurnUsd: 0.05 });
            expect(h.journal.byKind('turn_completed')).toHaveLength(1);

            h.instances[0].emit(frames.resultSuccess({ result: 'second answer', total_cost_usd: 0.08, ...frames.echoOf(secondTurn) }));
            await expect(second).resolves.toMatchObject({ response: 'second answer' });
        });

        it('a requested reopen that plays a held envelope ignores the replacement handshake\'s and the buffered append\'s acknowledgements', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const held = h.conductor.submit(catchupEnvelope({ text: 'held behind the reopen' }), { priority: 'other' });
            await flush();
            h.conductor.requestReopen('an identity change');
            h.instances[0].emit(frames.resultSuccess());
            await flush();
            expect(h.instances).toHaveLength(2);
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered during reopen' }))).toBe(true);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();
            const [handshake, append, heldTurn] = h.instances[1].consumedPrompts;
            expect([handshake.shouldQuery, append.shouldQuery, heldTurn.shouldQuery]).toEqual([false, false, true]);
            expect(JSON.stringify(heldTurn.message)).toContain('held behind the reopen');

            h.instances[1].emitAck(handshake);
            h.instances[1].emitAck(append);
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('catchup');
            expect(h.journal.byKind('turn_completed')).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess({ result: 'held answer', ...frames.echoOf(heldTurn) }));
            await expect(held).resolves.toMatchObject({ response: 'held answer' });
        });

        it('a crash reopen replays an unread append but not the crashed turn\'s own unread prompt, which the re-queued turn pushes exactly once', async () => {
            const h = build({}, { drainPrompts: index => index > 0 });
            await openWith(h, 'sess-1');
            const crashed = h.conductor.submit(discordEnvelope({ text: 'the crashed turn' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'unread append' }))).toBe(true);

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();

            // Instance 0 never drained, so its own handshake is carried over too (unreachable on
            // the real SDK, which reads the handshake before it emits init); it is a quiet message
            // and is replayed like any other.
            const prompts = h.instances[1].consumedPrompts;
            const texts = prompts.map(prompt => JSON.stringify(prompt.message));
            expect(texts.filter(text => text.includes('the crashed turn'))).toHaveLength(1);
            expect(texts.filter(text => text.includes('unread append'))).toHaveLength(1);
            const rerun = prompts.at(-1);
            expect(rerun?.shouldQuery).toBe(true);
            expect(JSON.stringify(rerun?.message)).toContain('the crashed turn');
            expect(new Set(prompts.map(prompt => prompt.uuid)).size).toBe(prompts.length);

            h.instances[1].emit(frames.resultSuccess({ result: 'rerun', ...frames.echoOf(prompts[prompts.length - 1]) }));
            await expect(crashed).resolves.toMatchObject({ response: 'rerun' });
        });

        it('a stray acknowledgement during /compact neither settles the compact turn nor releases the guard', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            const first = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.conductor.appendWithoutTurn(notificationEnvelope());
            await flush();
            const [, firstTurn, append] = h.instances[0].consumedPrompts;
            h.instances[0].emit(frames.resultSuccess({ ...frames.echoOf(firstTurn) }));
            await first;
            await flush();
            expect(h.ledgerStore.get().turn?.kind).toBe('compact');
            const compactTurn = h.instances[0].consumedPrompts[3];

            h.instances[0].emitAck(append);
            await flush();
            expect(h.ledgerStore.get().turn?.kind).toBe('compact');
            expect(h.ledgerStore.get().compaction).toBe('compacting');
            expect(h.journal.byKind('compaction_failed')).toEqual([]);

            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(frames.compactBoundary());
            await flush();
            h.instances[0].emit(frames.bareResult({ duration_ms: 13_000, ...frames.echoOf(compactTurn) }));
            await flush();
            expect(h.journal.byKind('compaction_completed')).toHaveLength(1);
            expect(h.conductor.status().turn).toBeNull();
        });

        it('an acknowledgement arriving during an adopted wake turn does not settle it; the wake\'s own un-echoed result still does', async () => {
            const h = build();
            await openWith(h);
            h.conductor.appendWithoutTurn(notificationEnvelope());
            await flush();
            const append = h.instances[0].consumedPrompts[1];
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'background work finished' });
            h.instances[0].emit(frames.assistantText('working on the wake'));
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('task');

            h.instances[0].emitAck(append);
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('task');

            h.instances[0].emit(frames.resultSuccess({ result: 'wake done' }));
            await flush();
            expect(h.conductor.status().turn).toBeNull();
            expect(h.journal.byKind('turn_completed')).toEqual([expect.objectContaining({ kind: 'task', responseText: 'wake done' })]);
        });

        it('ignores, with a warning, a result that answers a different message than the current turn; the turn\'s own result settles it', async () => {
            const h = build();
            await openWith(h);
            const envelope = discordEnvelope();
            const submitted = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const turn = h.instances[0].consumedPrompts[1];

            h.instances[0].emit(frames.resultSuccess({ result: 'not yours', user_message_uuid: 'someone-else', user_message_uuids: ['someone-else'] }));
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('discord');
            expect(h.ledgerStore.get().turn?.kind).toBe('discord');
            expect(h.logger.warn).toHaveBeenCalledWith(
                { echoed: ['someone-else'], turnId: envelope.id },
                'Ignoring a result frame that answers a different message than the current turn'
            );

            h.instances[0].emit(frames.resultSuccess({ result: 'yours', user_message_uuid: turn.uuid, user_message_uuids: ['earlier-batched', String(turn.uuid)] }));
            await expect(submitted).resolves.toMatchObject({ response: 'yours' });
        });

        it('a result arriving while no turn is current still reaches the ledger', async () => {
            const h = build();
            await openWith(h);

            h.instances[0].emit(frames.resultSuccess({ total_cost_usd: 0.25, user_message_uuid: 'unclaimed', user_message_uuids: ['unclaimed'] }));
            await flush();

            expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.25, 10);
            expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'Ignoring a result frame that answers a different message than the current turn');
        });

        it('an adopted wake turn is settled by a result naming a host message (the CLI may fold one into a turn it started)', async () => {
            const h = build();
            await openWith(h);
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'background work finished' });
            h.instances[0].emit(frames.assistantText('working on the wake'));
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('task');

            h.instances[0].emit(frames.resultSuccess({ result: 'wake done', user_message_uuid: 'folded-host-message', user_message_uuids: ['folded-host-message'] }));
            await flush();

            expect(h.conductor.status().turn).toBeNull();
        });

        it('a result that echoes nothing still settles a host-pushed turn (older producers, delivery-failure results)', async () => {
            const h = build();
            await openWith(h);
            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ result: 'legacy' }));

            await expect(submitted).resolves.toMatchObject({ response: 'legacy' });
            expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'Ignoring a result frame that answers a different message than the current turn');
        });

        it('a retry pushes the envelope again under a fresh wire uuid, since the CLI drops a uuid it has already seen', async () => {
            const h = build();
            await openWith(h);
            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const [firstAttempt] = turnPrompts(h.instances[0]);
            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529, ...frames.echoOf(firstAttempt) }));
            await flush();
            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();

            const [, secondAttempt] = turnPrompts(h.instances[0]);
            expect(secondAttempt.message).toEqual(firstAttempt.message);
            expect(secondAttempt.uuid).toBeDefined();
            expect(secondAttempt.uuid).not.toBe(firstAttempt.uuid);

            h.instances[0].emit(frames.resultSuccess({ result: 'second try', ...frames.echoOf(secondAttempt) }));
            await expect(submitted).resolves.toMatchObject({ response: 'second try' });
        });

        it('an undeclared command_lifecycle frame (emitted for every uuid-stamped message) changes nothing', async () => {
            const h = build();
            await openWith(h);
            const lifecycle = { type: 'command_lifecycle', command_uuid: 'cmd-1', state: 'queued', uuid: 'frame-1', session_id: 'sess-1' } as unknown as SDKMessage;
            const idleLedger = h.ledgerStore.get();

            h.instances[0].emit(lifecycle);
            await flush();
            expect(h.conductor.status().turn).toBeNull();
            expect(h.ledgerStore.get()).toBe(idleLedger);

            const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(lifecycle);
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('discord');
            h.instances[0].emit(frames.resultSuccess({ result: 'done' }));
            await expect(submitted).resolves.toMatchObject({ response: 'done' });
        });

        describe('a failed resume\'s pre-init error result', () => {
            function failedResumeResult(): SDKMessage {
                return frames.resultInterrupted({
                    subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0, errors: ['No conversation found with session ID: sess-old'],
                });
            }

            it('is not treated as a turn result: no ledger dispatch, no compaction poll, and the fresh fallback still opens', async () => {
                const h = build();
                await h.resumeStore.save('conversation', 'sess-old');
                h.ledgerStore.dispatch({ type: 'cost_baseline', cumulativeUsd: 0.4, at: new Date(0) });
                const dispatch = jest.spyOn(h.ledgerStore, 'dispatch');

                const openPromise = h.conductor.open();
                await flush();
                h.instances[0].emit(failedResumeResult());
                await flush();

                expect(dispatch).not.toHaveBeenCalled();
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.4, 10);
                expect(h.logger.warn).toHaveBeenCalledWith(
                    { subtype: 'error_during_execution' },
                    'Session emitted a result before system/init; not a turn result'
                );
                expect(h.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'Compaction guard: getContextUsage rejected');

                h.instances[0].fail(new Error('Claude Code returned an error result: No conversation found with session ID: sess-old'));
                await flush();
                h.instances[1].emit(frames.init('sess-new'));
                await expect(openPromise).resolves.toEqual({ sessionId: 'sess-new', resumed: false });
            });

            it('a pre-init success result is dropped too', async () => {
                const h = build();
                const openPromise = h.conductor.open();
                await flush();

                h.instances[0].emit(frames.resultSuccess({ result: 'impossible' }));
                await flush();
                expect(h.logger.warn).toHaveBeenCalledWith(
                    { subtype: 'success' },
                    'Session emitted a result before system/init; not a turn result'
                );

                h.instances[0].emit(frames.init('sess-1'));
                await expect(openPromise).resolves.toEqual({ sessionId: 'sess-1', resumed: false });
            });
        });

        describe('the acknowledgement\'s running cost total', () => {
            it('restores a resumed session\'s cost baseline, so the first turn is charged only its own delta', async () => {
                const h = build();
                await h.resumeStore.save('conversation', 'sess-old');
                await openWith(h, 'sess-old');
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBe(0);

                h.instances[0].emitAck(h.instances[0].consumedPrompts[0], { total_cost_usd: 0.030_103 });
                await flush();
                expect(h.ledgerStore.get().cost).toEqual({ cumulativeUsd: 0.030_103, lastTurnUsd: 0 });

                const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.instances[0].emit(frames.resultSuccess({ total_cost_usd: 0.032_069_6, ...frames.echoOf(h.instances[0].consumedPrompts[1]) }));
                await submitted;
                expect(h.ledgerStore.get().cost.lastTurnUsd).toBeCloseTo(0.001_966_6, 10);
            });

            it('restores the baseline even when the acknowledgement lands after a turn has begun', async () => {
                const h = build();
                await h.resumeStore.save('conversation', 'sess-old');
                await openWith(h, 'sess-old');
                const submitted = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                const [handshake, turn] = h.instances[0].consumedPrompts;

                h.instances[0].emitAck(handshake, { total_cost_usd: 0.030_103 });
                await flush();
                expect(h.ledgerStore.get().turn?.kind).toBe('discord');
                h.instances[0].emit(frames.resultSuccess({ total_cost_usd: 0.032_069_6, ...frames.echoOf(turn) }));
                await submitted;

                expect(h.ledgerStore.get().cost.lastTurnUsd).toBeCloseTo(0.001_966_6, 10);
            });

            it('an acknowledgement that lands before open() has journaled session_opened is applied after it, not wiped by its reset', async () => {
                const burst = initThenAckQueryFn('sess-old', 0.030_103);
                const h = build({ queryFn: burst.queryFn });
                await h.resumeStore.save('conversation', 'sess-old');
                const events: string[] = [];
                const acknowledgedBeforeSessionOpened: boolean[] = [];
                h.ledgerStore.subscribe((_ledger, event) => {
                    events.push(event.type);
                    if(event.type === 'session_opened') {
                        acknowledgedBeforeSessionOpened.push(burst.ackRead());
                    }
                });

                await h.conductor.open();
                await flush();

                // The witness that this test exercises the ordering it names.
                expect(acknowledgedBeforeSessionOpened).toEqual([true]);
                expect(events.filter(type => type === 'session_opened' || type === 'cost_baseline')).toEqual(['session_opened', 'cost_baseline']);
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.030_103, 10);
            });

            it('an acknowledgement from a discarded handle is ignored', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                const oldHandshake = h.instances[0].consumedPrompts[0];
                h.conductor.requestReopen('an identity change');
                await flush();
                h.instances[1].emit(frames.init('sess-1'));
                await flush();
                h.instances[1].emitAck(h.instances[1].consumedPrompts[0], { total_cost_usd: 0.2 });
                await flush();
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.2, 10);

                h.instances[0].emitAck(oldHandshake, { total_cost_usd: 9 });
                await flush();
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.2, 10);

                // Not held for a later open either: the next replacement starts from its own reset.
                h.conductor.requestReopen('another identity change');
                await flush();
                h.instances[2].emit(frames.init('sess-1'));
                await flush();

                expect(h.ledgerStore.get().cost.cumulativeUsd).toBe(0);
            });

            it('only the handshake\'s acknowledgement restores a baseline: a later append\'s is a live cost update the daily ceiling books', async () => {
                const h = build();
                const ceiling = createCostCeiling({ clock: h.clock, timezone: 'UTC', ceilingUsd: 1 });
                h.ledgerStore.subscribe((ledger, event) => {
                    ceiling.record(h.ledgerStore, ledger, event);
                });
                const costEvents: string[] = [];
                h.ledgerStore.subscribe((_ledger, event) => {
                    costEvents.push(event.type);
                });
                await h.resumeStore.save('conversation', 'sess-old');
                await openWith(h, 'sess-old');
                h.instances[0].emitAck(h.instances[0].consumedPrompts[0], { total_cost_usd: 0.1 });
                await flush();

                const first = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.instances[0].emit(frames.resultSuccess({ total_cost_usd: 0.5, ...frames.echoOf(h.instances[0].consumedPrompts[1]) }));
                await first;
                expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'quiet note' }))).toBe(true);
                await flush();
                // Background subagent spend lands in the running total between turns.
                h.instances[0].emitAck(h.instances[0].consumedPrompts[2], { total_cost_usd: 1.3 });
                await flush();
                expect(h.ledgerStore.get().cost).toEqual({ cumulativeUsd: 1.3, lastTurnUsd: 0.4 });

                const second = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.instances[0].emit(frames.resultSuccess({ total_cost_usd: 1.4, ...frames.echoOf(h.instances[0].consumedPrompts[3]) }));
                await second;

                expect(costEvents.filter(type => type === 'cost_baseline' || type === 'cost_update')).toEqual(['cost_baseline', 'cost_update']);
                expect(ceiling.snapshot().totalUsd).toBeCloseTo(1.3, 10);
                expect(ceiling.isPaused()).toBe(true);
            });

            it('an early acknowledgement is applied once: a later reopen does not re-apply it over the replacement\'s reset', async () => {
                const fake = fakeQueryFn();
                const burst = initThenAckQueryFn('sess-old', 0.030_103, fake.queryFn);
                const h = build({ queryFn: burst.queryFn });
                await h.resumeStore.save('conversation', 'sess-old');
                await h.conductor.open();
                await flush();
                expect(h.ledgerStore.get().cost.cumulativeUsd).toBeCloseTo(0.030_103, 10);

                h.conductor.requestReopen('an identity change');
                await flush();
                fake.instances[0].emit(frames.init('sess-old'));
                await flush();

                expect(h.ledgerStore.get().cost.cumulativeUsd).toBe(0);
            });
        });
    });

    describe('submit()', () => {
        it('rejects when the conductor has not been opened yet', async () => {
            const h = build();

            await expect(h.conductor.submit(discordEnvelope(), { priority: 'human' })).rejects.toThrow('not open');
        });

        it('an idle submit begins the turn immediately: envelope_submitted journaled, turn_submitted on the ledger', async () => {
            const h = build();
            await openWith(h);

            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.journal.byKind('envelope_submitted')).toEqual([
                {
                    type: 'envelope_submitted', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord', channelId: 'chan-1',
                },
            ]);
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord', channelId: 'chan-1' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;

            expect(result).toEqual({
                envelopeId: envelope.id, response: 'LAUNCHED', wasInterrupted: false, partialWork: expect.any(Object), sessionId: 'sess-1', isError: false, contextUsagePercent: 0,
            });
            expect(h.journal.byKind('turn_completed')).toEqual([
                {
                    type: 'turn_completed', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord', responseText: 'LAUNCHED',
                },
            ]);
        });

        it('an idle channel-less submit omits channelId from the journal entry', async () => {
            const h = build();
            await openWith(h);
            const envelope = catchupEnvelope();

            const resultPromise = h.conductor.submit(envelope, { priority: 'other' });
            await flush();

            expect(h.journal.byKind('envelope_submitted')).toEqual([
                { type: 'envelope_submitted', at: expect.any(Date), envelopeId: envelope.id, kind: 'catchup' },
            ]);
            expect(h.journal.byKind('envelope_submitted')[0]).not.toHaveProperty('channelId');

            h.instances[0].emit(frames.resultSuccess());
            await resultPromise;
        });

        it('turn_completed carries a response exactly at the 200_000-char cap in full, with no truncated flag', async () => {
            const h = build();
            await openWith(h);
            const exactCapText = 'x'.repeat(200_000);

            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: exactCapText }));
            await resultPromise;

            const [entry] = h.journal.byKind('turn_completed');
            expect(entry.responseText).toBe(exactCapText);
            expect(entry.responseText).toHaveLength(200_000);
            expect(entry.truncated).toBeUndefined();
        });

        it('turn_completed truncates a response one character past the 200_000-char cap and sets truncated: true', async () => {
            const h = build();
            await openWith(h);
            const overCapText = `${'x'.repeat(200_000)}y`;

            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: overCapText }));
            await resultPromise;

            const [entry] = h.journal.byKind('turn_completed');
            expect(entry.responseText).toHaveLength(200_000);
            expect(entry.responseText).toBe('x'.repeat(200_000));
            expect(entry.truncated).toBe(true);
        });

        it('an interrupted turn journals turn_completed with no responseText', async () => {
            const h = build();
            await openWith(h);

            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const interruptPromise = h.conductor.interruptCurrent({ requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].resolveInterrupt();
            await interruptPromise;
            h.instances[0].emit(frames.resultInterrupted());
            await resultPromise;

            const [entry] = h.journal.byKind('turn_completed');
            expect(entry.responseText).toBeUndefined();
            expect(entry.truncated).toBeUndefined();
        });

        it('process_tick (readRss) is dispatched on every result', async () => {
            const h = build();
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await resultPromise;

            expect(h.readRss).toHaveBeenCalled();
            expect(h.ledgerStore.get().process.rssBytes).toBe(4096);
        });

        it('a human envelope submitted for a different channel while a discord turn runs is queued, not interrupted, and runs after — human still ordered ahead of an already-queued other-priority envelope', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-A' }), { priority: 'human', requestingChannelId: 'chan-A' });
            await flush();

            const otherEnvelope = catchupEnvelope();
            const otherResult = h.conductor.submit(otherEnvelope, { priority: 'other' });
            const humanEnvelopeB = discordEnvelope({ channelId: 'chan-B' });
            const humanResultB = h.conductor.submit(humanEnvelopeB, { priority: 'human', requestingChannelId: 'chan-B' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            // The human envelope for chan-B must be promoted ahead of the earlier-queued 'other' envelope.
            expect(h.ledgerStore.get().turn).toMatchObject({ channelId: 'chan-B' });

            h.instances[0].emit(frames.resultSuccess());
            const resultB = await humanResultB;
            expect(resultB.envelopeId).toBe(humanEnvelopeB.id);

            h.instances[0].emit(frames.resultSuccess());
            const resultOther = await otherResult;
            expect(resultOther.envelopeId).toBe(otherEnvelope.id);
        });

        it('a human envelope for a different channel while a discord turn runs never arms the human-wait escalation (isBackgroundKind boundary: discord is not a background kind)', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-A' }), { priority: 'human', requestingChannelId: 'chan-A' });
            await flush();

            void h.conductor.submit(discordEnvelope({ channelId: 'chan-B' }), { priority: 'human', requestingChannelId: 'chan-B' });
            await flush();

            expect(h.clock.pending()).toBe(0);
            h.clock.advance(30_000);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a human envelope for the SAME channel as the running discord turn interrupts it exactly once', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.journal.byKind('envelope_submitted')[0]).toEqual({
                type: 'envelope_submitted', at: expect.any(Date), envelopeId: expect.any(String), kind: 'discord', channelId: 'chan-1',
            });

            const secondPromise = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'human envelope for the running channel' },
                'Conductor requesting interrupt'
            );

            // A second same-channel human arrival must not call interrupt() again.
            const thirdPromise = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            const firstOutcome = await firstResult;
            expect(firstOutcome.wasInterrupted).toBe(true);
            expect(firstOutcome.isError).toBe(false);

            h.instances[0].emit(frames.resultSuccess());
            await secondPromise;
            h.instances[0].emit(frames.resultSuccess());
            await thirdPromise;
        });

        it('does not pre-empt a discord turn for other priority or for a human without a requesting channel', async () => {
            const h = build();
            await openWith(h);
            const first = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const other = h.conductor.submit(catchupEnvelope(), { priority: 'other', requestingChannelId: 'chan-1' });
            const unscopedHuman = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
            h.instances[0].emit(frames.resultSuccess());
            await first;
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await unscopedHuman;
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await other;
        });

        it('does not pre-empt a channel-tagged non-discord turn when a same-channel human arrives', async () => {
            const h = build();
            await openWith(h);
            const first = h.conductor.submit(catchupEnvelope({ channelId: 'chan-1' }), { priority: 'other' });
            await flush();

            const second = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
            h.instances[0].emit(frames.resultSuccess());
            await first;
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('discord');
            h.instances[0].emit(frames.resultSuccess());
            await second;
        });

        it('does not pre-empt an unscoped discord turn for an unscoped human arrival', async () => {
            const h = build();
            await openWith(h);
            const first = h.conductor.submit(discordEnvelope({ channelId: undefined }), { priority: 'human' });
            await flush();

            const second = h.conductor.submit(discordEnvelope({ channelId: undefined }), { priority: 'human' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
            h.instances[0].emit(frames.resultSuccess());
            await first;
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await second;
        });

        it('keeps FIFO order between two other-priority envelopes', async () => {
            const h = build();
            await openWith(h);
            const first = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const otherA = catchupEnvelope({ text: 'other A' });
            const otherB = catchupEnvelope({ text: 'other B' });
            const resultA = h.conductor.submit(otherA, { priority: 'other' });
            const resultB = h.conductor.submit(otherB, { priority: 'other' });

            h.instances[0].emit(frames.resultSuccess());
            await first;
            await flush();
            expect(h.conductor.status().turn?.envelopeId).toBe(otherA.id);
            h.instances[0].emit(frames.resultSuccess());
            await resultA;
            await flush();
            expect(h.conductor.status().turn?.envelopeId).toBe(otherB.id);
            h.instances[0].emit(frames.resultSuccess());
            await resultB;
        });

        it('interrupting never calls stopTask', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await firstResult;

            expect(h.instances[0].stopTaskCalls).toEqual([]);
        });
    });

    describe('appendWithoutTurn()', () => {
        it('pushes the envelope onto the live queue without opening a turn, and a Discord submit afterward still runs to completion', async () => {
            const h = build();
            await openWith(h);

            h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'accumulate me' }));
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            expect(JSON.stringify(turnPrompts(h.instances[0])[0].message)).toContain('accumulate me');
            expect(h.conductor.status().turn).toBeNull();

            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'discord', channelId: 'chan-1' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;

            expect(result.isError).toBe(false);
        });

        it('never dispatches envelope_queued on the ledger: appendWithoutTurn never opens a turn, so the "other" gauge stays at 0', async () => {
            const h = build();
            await openWith(h);

            h.conductor.appendWithoutTurn(notificationEnvelope());
            await flush();

            expect(h.ledgerStore.get().queued).toEqual({ human: 0, other: 0 });
        });

        it('is a no-op before open() has assigned a live queue: does not throw and pushes nothing', () => {
            const h = build();

            expect(() => {
                h.conductor.appendWithoutTurn(notificationEnvelope());
            }).not.toThrow();
            expect(h.instances).toHaveLength(0);
        });

        it('throws an InvariantViolationError when given a shouldQuery:true envelope', async () => {
            const h = build();
            await openWith(h);

            expect(() => {
                h.conductor.appendWithoutTurn(catchupEnvelope());
            }).toThrow('Invariant violated in conductor.appendWithoutTurn: called with a shouldQuery:true envelope — this seam is accumulate-only; use submit() for shouldQuery:true envelopes');
        });

        it('throws the shouldQuery:true InvariantViolationError even before open() has assigned a live queue', () => {
            const h = build();

            expect(() => {
                h.conductor.appendWithoutTurn(catchupEnvelope());
            }).toThrow('Invariant violated in conductor.appendWithoutTurn: called with a shouldQuery:true envelope — this seam is accumulate-only; use submit() for shouldQuery:true envelopes');
        });
    });

    describe('submit() shouldQuery guard', () => {
        it('throws an InvariantViolationError when given a shouldQuery:false envelope', async () => {
            const h = build();
            await openWith(h);

            expect(() => {
                void h.conductor.submit(notificationEnvelope(), { priority: 'other' });
            }).toThrow('Invariant violated in conductor.submit: called with a shouldQuery:false envelope — submit() always opens a turn; use appendWithoutTurn() for shouldQuery:false envelopes');
        });
    });

    describe('task lifecycle journaling', () => {
        it('a task_started frame journals task_started, and its task_notification journals exactly one task_finished even if repeated', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing' }));
            await flush();

            expect(h.journal.byKind('task_started')).toEqual([
                { type: 'task_started', at: expect.any(Date), taskId: 'task-1', description: 'run a thing' },
            ]);
            expect(h.journal.byKind('task_finished')).toEqual([]);
            expect(h.journal.byKind('task_lost')).toEqual([]);

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing' }));
            await flush();
            expect(h.journal.byKind('task_started')).toHaveLength(1);

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-2', description: 'run another thing' }));
            await flush();
            expect(h.journal.byKind('task_started')).toEqual([
                { type: 'task_started', at: expect.any(Date), taskId: 'task-1', description: 'run a thing' },
                { type: 'task_started', at: expect.any(Date), taskId: 'task-2', description: 'run another thing' },
            ]);
            expect(h.journal.byKind('task_finished')).toEqual([]);
            expect(h.journal.byKind('task_lost')).toEqual([]);

            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-1' }));
            await flush();
            // A duplicate notification for the same (already-removed) task is a ledger no-op and
            // must not journal a second completion.
            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-1' }));
            await flush();

            expect(h.journal.byKind('task_finished')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-1', description: 'run a thing', outcome: 'completed' },
            ]);
            expect(h.journal.byKind('task_completed')).toEqual([]);
            expect(h.journal.byKind('task_lost')).toEqual([]);
        });

        it.each(['completed', 'failed', 'stopped'] as const)('a %s task_notification journals task_finished with that outcome', async (status) => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing' }));
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-2', description: 'run another thing' }));
            await flush();

            h.instances[0].emit(frames.taskNotification(status, { task_id: 'task-2' }));
            await flush();

            expect(h.journal.byKind('task_finished')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-2', description: 'run another thing', outcome: status },
            ]);
            expect(h.logger.debug).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('no finished record'));
        });

        it('a foreground task stopped when its turn ends journals task_finished with outcome stopped', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing', is_backgrounded: false }));
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.journal.byKind('task_finished')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-1', description: 'run a thing', outcome: 'stopped' },
            ]);
        });

        it('a task whose finished record the ledger already evicted journals outcome completed and logs at debug', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            // One more foreground task than the ledger's finishedTasks cap (20): all of them stop
            // in the same turn-end event, so the first is appended and then evicted at once.
            for(let i = 0; i < 21; i += 1) {
                h.instances[0].emit(frames.taskStarted({ task_id: `task-${i}`, description: `task ${i}`, is_backgrounded: false }));
                // eslint-disable-next-line no-await-in-loop -- each frame must reach the ledger before the next is emitted
                await flush();
            }

            h.instances[0].emit(frames.resultSuccess());
            await flush();

            const finished = h.journal.byKind('task_finished');
            expect(finished).toHaveLength(21);
            expect(finished[0]).toEqual({ type: 'task_finished', at: expect.any(Date), taskId: 'task-0', description: 'task 0', outcome: 'completed' });
            expect(finished.slice(1).map(entry => entry.outcome)).toEqual(Array.from({ length: 20 }, () => 'stopped'));
            expect(h.logger.debug).toHaveBeenCalledWith(
                { taskId: 'task-0' },
                'Conductor: finished task has no finished record in the ledger; journaling outcome completed'
            );
        });

        it.each([
            ['failed', ['stopped', 'failed']],
            ['completed', ['stopped', 'completed']],
            ['stopped', ['stopped']],
        ] as const)('a %s task_notification arriving after background_tasks_changed dropped the task journals its corrected outcome once', async (status, outcomes) => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing' }));
            await flush();

            // The payload drops the task a tick before its notification: the ledger finishes it
            // as 'stopped', then corrects that finished record to the notification's status.
            h.instances[0].emit(frames.backgroundTasksChanged([]));
            await flush();
            h.instances[0].emit(frames.taskNotification(status, { task_id: 'task-1' }));
            await flush();
            // A repeated identical notification changes nothing durable.
            h.instances[0].emit(frames.taskNotification(status, { task_id: 'task-1' }));
            await flush();

            expect(h.journal.byKind('task_finished')).toEqual(outcomes.map(outcome => (
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-1', description: 'run a thing', outcome }
            )));
            expect(h.journal.byKind('task_lost')).toEqual([]);
        });

        it('a reused task id that finishes again journals only its own task_finished, not a correction of the earlier run', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'first run' }));
            await flush();
            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-1' }));
            await flush();

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'second run' }));
            await flush();
            h.instances[0].emit(frames.taskNotification('failed', { task_id: 'task-1' }));
            await flush();

            expect(h.journal.byKind('task_finished')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-1', description: 'first run', outcome: 'completed' },
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-1', description: 'second run', outcome: 'failed' },
            ]);
        });

        it('a finished task whose record the ledger later evicts journals nothing more for it', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-0', description: 'task 0' }));
            await flush();
            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-0' }));
            await flush();
            // The ledger's finishedTasks cap (20) foreground tasks stop at the turn end, evicting
            // task-0's finished record in that same event.
            for(let i = 1; i <= 20; i += 1) {
                h.instances[0].emit(frames.taskStarted({ task_id: `task-${i}`, description: `task ${i}`, is_backgrounded: false }));
                // eslint-disable-next-line no-await-in-loop -- each frame must reach the ledger before the next is emitted
                await flush();
            }

            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.journal.byKind('task_finished').filter(entry => entry.taskId === 'task-0')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-0', description: 'task 0', outcome: 'completed' },
            ]);
            expect(h.journal.byKind('task_finished')).toHaveLength(21);
        });

        it('an explicit task_lost ledger event journals the named task as lost', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'lost by supervisor' }));
            await flush();

            h.ledgerStore.dispatch({ type: 'task_lost', taskId: 'task-1', at: new Date(1) });

            expect(h.journal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: 'task-1', description: 'lost by supervisor' },
            ]);
            expect(h.journal.byKind('task_finished')).toEqual([]);
        });

        it('tasks still in flight when a mid-life reopen wipes the ledger\'s task list are journaled task_lost, not task_finished', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'abandoned task' }));
            await flush();
            expect(h.journal.byKind('task_started')).toHaveLength(1);

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.journal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: 'task-1', description: 'abandoned task' },
            ]);
            expect(h.journal.byKind('task_finished')).toEqual([]);
        });
    });

    describe('the human-wait escalation during a spontaneous notification turn', () => {
        async function beginSpontaneousNotificationTurn(h: Harness): Promise<void> {
            h.instances[0].emit(frames.assistantText('thinking out loud'));
            await flush();
        }

        it('does not interrupt at 9999ms and interrupts at exactly 10000ms when no tool is pending', async () => {
            const h = build();
            await openWith(h);
            await beginSpontaneousNotificationTurn(h);

            const humanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const secondHumanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-2' });
            await flush();
            expect(h.clock.pending()).toBe(1);

            h.clock.advance(9999);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'human wait target elapsed' },
                'Conductor requesting interrupt'
            );

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the injected resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            await humanPromise;
            h.instances[0].emit(frames.resultSuccess());
            await secondHumanPromise;
        });

        it('extends to the 30s ceiling while a tool_use is unresolved: no interrupt at 29999ms, interrupt at 30000ms, exactly once', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantToolUse('Read', { file_path: '/tmp/x' }, 'tool-1'));
            await flush();

            const humanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.clock.advance(10_000);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(19_999);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'human wait ceiling elapsed' },
                'Conductor requesting interrupt'
            );

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the injected resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            await humanPromise;
        });

        it('a resume envelope precedes the queued human envelope after an escalation interrupt', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantText('composing a reply'));
            await flush();

            const humanEnvelope = discordEnvelope();
            const humanPromise = h.conductor.submit(humanEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.clock.advance(10_000);
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['resume']);

            h.instances[0].emit(frames.resultSuccess()); // closes the resume turn
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['resume', 'discord']);

            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            const result = await humanPromise;
            expect(result.envelopeId).toBe(humanEnvelope.id);
        });

        it('if the turn ends naturally before 10s, no interrupt ever fires', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantText('short answer'));
            await flush();

            const humanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await flush();
            h.clock.advance(60_000);

            expect(h.instances[0].interruptCalls).toBe(0);
            h.instances[0].emit(frames.resultSuccess());
            await humanPromise;
        });

        it('an interrupted discord turn is not a "background" kind: no resume note is injected even with partial work — only notification/task turns get one (isBackgroundKind boundary)', async () => {
            const h = build();
            await openWith(h);
            const firstEnvelope = discordEnvelope({ channelId: 'chan-1' });
            const firstResult = h.conductor.submit(firstEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.assistantText('partial work in progress'));
            await flush();

            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await firstResult;
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).not.toContain('resume');

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });
    });

    describe('the compaction guard integration', () => {
        it('does not start /compact at threshold while another envelope is queued', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            const first = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const queued = h.conductor.submit(catchupEnvelope(), { priority: 'other' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await first;
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'catchup' });
            expect(h.journal.byKind('compaction_started')).toEqual([]);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(frames.resultSuccess());
            await queued;
        });

        it('submits /compact as a tracked turn at threshold with an empty queue, releases on compact_boundary, and drains a held envelope afterwards', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'compact' });
            expect(h.journal.byKind('compaction_started')).toHaveLength(1);

            // A human envelope arriving mid-compaction is held (queued), not interrupted.
            const heldEnvelope = discordEnvelope();
            const heldResult = h.conductor.submit(heldEnvelope, { priority: 'human', requestingChannelId: 'chan-2' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(frames.compactBoundary());
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.journal.byKind('compaction_completed')).toHaveLength(1);
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await heldResult;
            expect(result.envelopeId).toBe(heldEnvelope.id);
        });

        it('a timeout failure only interrupts the /compact turn that timed out, never an unrelated discord turn', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.ledgerStore.dispatch({ type: 'compaction_started', trigger: 'manual', at: new Date(h.clock.now()) });
            h.ledgerStore.dispatch({ type: 'compaction_failed', reason: 'timeout', at: new Date(h.clock.now()) });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
        });

        it('a non-timeout compaction failure releases a running /compact turn without interrupting it', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'compact' });

            h.ledgerStore.dispatch({ type: 'compaction_failed', reason: 'notification', at: new Date(h.clock.now()) });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
        });

        it('the /compact turn\'s own result with no boundary seen releases and journals compaction_failed', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: expect.any(String) },
            ]);
        });

        it('the compaction_failed journal entry carries the guard\'s actual failure reason, not a generic message', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(frames.resultSuccess()); // the /compact turn's own result, no boundary seen
            await flush();

            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: 'no-boundary' },
            ]);
        });

        it('the error-compacting-conversation notification releases the hold, journals compaction_failed, and drains a held envelope afterwards', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'compact' });

            const heldEnvelope = discordEnvelope();
            const heldResult = h.conductor.submit(heldEnvelope, { priority: 'human', requestingChannelId: 'chan-2' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
            h.instances[0].emit(notificationFrame('error-compacting-conversation'));
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // the /compact turn's own result, ending the turn
            await flush();

            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: 'notification' },
            ]);
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await heldResult;
            expect(result.envelopeId).toBe(heldEnvelope.id);
        });

        it('the 5-minute clock ceiling interrupts the stuck /compact turn, journals compaction_failed reason timeout, and drains a held envelope afterwards', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
            await flush();

            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'compact' });

            const heldEnvelope = discordEnvelope();
            const heldResult = h.conductor.submit(heldEnvelope, { priority: 'human', requestingChannelId: 'chan-2' });
            await flush();

            // The CLI's /compact turn hangs forever: no boundary, no notification, no result.
            h.clock.advance(299_999);
            expect(h.journal.byKind('compaction_failed')).toHaveLength(0);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: 'timeout' },
            ]);
            // Releasing the guard's own bookkeeping is not enough — the stuck turn itself must be
            // interrupted, or processQueue() stays blocked on currentTurn !== null forever.
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'compaction ceiling exceeded' },
                'Conductor requesting interrupt'
            );

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();

            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await heldResult;
            expect(result.envelopeId).toBe(heldEnvelope.id);
        });

        it('a compaction_failed ledger event with no reason journals the generic fallback message, not "undefined"', async () => {
            const h = build();
            await openWith(h);

            // Dispatched directly (bypassing the guard) to exercise the reducer's `reason?: string`
            // optionality — the guard itself always supplies a reason, so this shape only arises
            // from some other future or manual dispatcher.
            h.ledgerStore.dispatch({ type: 'compaction_started', trigger: 'manual', at: new Date(h.clock.now()) });
            h.ledgerStore.dispatch({ type: 'compaction_failed', at: new Date(h.clock.now()) });
            await flush();

            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: 'compaction attempt did not complete' },
            ]);
        });

        it('preserves an explicitly empty compaction failure reason rather than treating it as absent', async () => {
            const h = build();
            await openWith(h);

            h.ledgerStore.dispatch({ type: 'compaction_started', trigger: 'manual', at: new Date(h.clock.now()) });
            h.ledgerStore.dispatch({ type: 'compaction_failed', reason: '', at: new Date(h.clock.now()) });
            await flush();

            expect(h.journal.byKind('compaction_failed')).toEqual([
                { type: 'compaction_failed', at: expect.any(Date), error: '' },
            ]);
        });

        it('submitCompact() rejects "Conductor is shutting down" once shutdown has begun, surfaced via the guard\'s submitCompact-rejected log', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            // The running turn ends naturally (queue-empty, threshold met) after shuttingDown is
            // already true, driving guard.onTurnEnd() -> submit() -> submitCompact() into its
            // shuttingDown guard.
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'Conductor is shutting down' }) },
                expect.any(String)
            );

            await shutdownPromise;
        });

        it('submitCompact() rejects "Conductor is reopening its session" while a mid-life reopen is in flight, surfaced via the guard\'s submitCompact-rejected log', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const pendingSave = deferred<undefined>();
            jest.spyOn(h.resumeStore, 'save').mockReturnValue(pendingSave.promise);

            h.instances[0].fail(new Error('worker crashed')); // handleMidLifeClosed sets reopening = true
            await flush();
            expect(h.instances).toHaveLength(2);

            // The replacement settles on init, but its finishOpen is still awaiting the resume-store
            // save, so `reopening` stays true. A result frame from it now (a pre-init one would be
            // dropped as a failed resume's) drives afterResult() -> guard.onTurnEnd() ->
            // submitCompact() while the reopen is still in flight.
            h.instances[1].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            h.instances[1].emit(frames.resultSuccess());
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'Conductor is reopening its session' }) },
                expect.any(String)
            );

            pendingSave.resolve(undefined);
            await flush();
        });

        it('submitCompact() falls back to "submitCompact failed" when a non-Error is thrown while starting the /compact turn', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            jest.spyOn(h.journal, 'append').mockImplementation((entry) => {
                if(entry.type === 'compaction_started') {
                    throw { nonError: true };
                }
            });

            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'submitCompact failed' }) },
                expect.any(String)
            );

            await resultPromise;
        });

        it('records queue-to-first-token latency by envelope kind on the first assistant frame of a turn', async () => {
            const h = build();
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.clock.advance(250);
            h.instances[0].emit(frames.assistantText('first token'));
            await flush();

            expect(h.ledgerStore.get().latency.bySource.discord).toBe(250);

            h.instances[0].emit(frames.resultSuccess());
            await resultPromise;
        });

        it('a submit arriving while ledger.compaction is compacting but no turn is running is held until compaction ends', async () => {
            const h = build();
            await openWith(h);

            // Simulate compaction being reported as in-flight with no active turn — the branch
            // processQueue() guards for even though the conductor's own auto-compaction flow
            // never leaves currentTurn null and ledger.compaction 'compacting' at the same time.
            h.ledgerStore.dispatch({ type: 'compaction_started', trigger: 'manual', at: new Date(h.clock.now()) });

            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(h.ledgerStore.get().turn).toBeNull();

            h.ledgerStore.dispatch({ type: 'compaction_finished', at: new Date(h.clock.now()) });
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.envelopeId).toBe(envelope.id);
        });

        it('does not spuriously open a notification turn for a frame arriving while the compaction guard is still deciding (one-turn invariant)', async () => {
            const h = build();
            await openWith(h);
            const deferredUsage = h.instances[0].deferContextUsage();
            const firstResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await flush();
            // afterResult() has nulled currentTurn and is now blocked inside guard.onTurnEnd(),
            // awaiting a getContextUsage() call that will not resolve until we say so below.

            // A frame arriving in exactly this window must not be allowed to spontaneously open a
            // 'notification' turn — beginTurn (driven from inside this very onTurnEnd call, once
            // it resolves and decides to submit /compact) would silently clobber it, violating the
            // one-turn invariant with nothing ever settling the clobbered turn's tracker.
            h.instances[0].emit(frames.assistantText('stray frame racing the compaction decision'));
            await flush();

            expect(h.conductor.status().turn).toBeNull();

            deferredUsage.resolve(frames.contextUsage({ percentage: 60 }));
            await flush();
            await firstResult;

            expect(h.conductor.status().turn).toMatchObject({ kind: 'compact' });

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });
    });

    describe('getCompactionThresholdPercent()/setCompactionThresholdPercent()', () => {
        it('getCompactionThresholdPercent returns config.compactThresholdPercent immediately after construction', () => {
            const h = build();

            expect(h.conductor.getCompactionThresholdPercent()).toBe(DEFAULT_CONFIG.compactThresholdPercent);
        });

        it('setCompactionThresholdPercent followed by getCompactionThresholdPercent round-trips through to the private guard', () => {
            const h = build();

            h.conductor.setCompactionThresholdPercent(42);

            expect(h.conductor.getCompactionThresholdPercent()).toBe(42);
        });
    });

    describe('is_error retry via retryPolicy', () => {
        it('uses exponential backoff for the third attempt when no retryAfterMs override is supplied', async () => {
            const retryPolicy: RetryPolicy = { ...FAST_RETRY_POLICY, maxAttempts: 3 };
            const h = build({ retryPolicy });
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'first overload', api_error_status: 529 }));
            await flush();
            h.clock.advance(100);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(2);

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'second overload', api_error_status: 529 }));
            await flush();
            h.clock.advance(199);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(2);
            h.clock.advance(1);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(3);

            h.instances[0].emit(frames.resultSuccess());
            await expect(resultPromise).resolves.toMatchObject({ isError: false });
        });

        it('a transient error is resubmitted, and exhausting retryPolicy.maxAttempts journals turn_failed', async () => {
            const h = build();
            await openWith(h);
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 }));
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(1); // not yet resubmitted — waiting on the backoff timer

            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(2); // resubmitted (attempt 2 of 2)

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'still overloaded', api_error_status: 529 }));
            const result = await resultPromise;

            expect(result).toMatchObject({ isError: true, wasInterrupted: false });
            expect(h.journal.byKind('turn_failed')).toEqual([
                { type: 'turn_failed', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord', error: 'still overloaded' },
            ]);
        });

        it('a rate_limited error waits exactly retryAfterMs on the clock before resubmitting', async () => {
            const h = build();
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'slow down', api_error_status: 429 }));
            await flush();

            h.clock.advance(4999);
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            h.clock.advance(1);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(2);

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.isError).toBe(false);
        });

        it('a permanent error journals turn_failed immediately with no resubmission, and clears the submit()\'s AbortSignal listener', async () => {
            const h = build();
            await openWith(h);
            const envelope = discordEnvelope();
            const controller = new AbortController();
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'bad request', api_error_status: 400 }));
            const result = await resultPromise;

            expect(result.isError).toBe(true);
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            expect(h.journal.byKind('turn_failed')).toEqual([
                { type: 'turn_failed', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord', error: 'bad request' },
            ]);
            // failTurn clears the abort listener — a long-lived signal must not keep retaining a
            // settled turn's callback.
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        it('a retryable classification with retryAfterMs 0 resubmits immediately, with no clock advance needed', async () => {
            const classifyError = (): ErrorClassification => ({ category: 'rate_limited', retryAfterMs: 0, message: 'immediate retry' });
            const h = build({ classifyError });
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'retry me', api_error_status: 429 }));
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(2); // resubmitted with no clock.advance() call

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.isError).toBe(false);
        });

        it('an abort that fires during the retry backoff window withdraws the item instead of letting the stale retry run', async () => {
            const h = build();
            await openWith(h);
            const controller = new AbortController();
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 }));
            await flush();
            // Waiting out the backoff timer: not the current turn (currentTurn is null between
            // turns) and not in pendingQueue (scheduleRetry holds it on clock.setTimer instead).
            expect(turnPrompts(h.instances[0])).toHaveLength(1);

            controller.abort();
            await flush();

            const result = await resultPromise;
            expect(result.outcome).toBe('withdrawn');
            expect(result.response).toBeNull();

            // The stale retry timer still fires, but must not resubmit the withdrawn envelope.
            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
        });
    });

    describe('mid-life generator throw', () => {
        it('a mid-life close observed after shutdown has begun is a no-op — no reopen attempt', async () => {
            const h = build();
            await openWith(h);

            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            h.instances[0].fail(new Error('crash after shutdown'));
            await flush();

            // shuttingDown short-circuits handleMidLifeClosed before it logs or attempts a reopen.
            expect(h.instances).toHaveLength(1);
            expect(h.logger.error).not.toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('reopening'));
        });

        it('a mid-life crash while a human-wait escalation timer is armed clears the timer, not leaving it dangling', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantText('thinking out loud'));
            await flush();

            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            // The escalation timer (10s target) is now armed but has not fired.
            expect(h.clock.pending()).toBe(1);

            h.instances[0].fail(new Error('worker crashed mid-notification'));
            await flush();

            expect(h.clock.pending()).toBe(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            h.instances[1].emit(frames.resultSuccess());
        });

        it('reopens with resume, and resubmits the in-flight envelope', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const crash = new Error('worker crashed');
            h.instances[0].fail(crash);
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.logger.error).toHaveBeenCalledWith({ error: crash }, 'Session ended unexpectedly; reopening');
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-1', outcome: 'fresh', cause: 'boot' },
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-1', outcome: 'resumed', cause: 'crash_reopen' },
            ]);
            expect(turnPrompts(h.instances[1])).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.envelopeId).toBe(envelope.id);
        });

        it('a second consecutive throw during reopen falls back to a fresh session', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].fail(new Error('resume also failed'));
            await flush();

            expect(h.instances).toHaveLength(3);
            h.instances[2].emit(frames.init('sess-2'));
            await flush();

            expect(h.journal.byKind('session_opened').at(-1)).toEqual(
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-2', outcome: 'resume_fallback', cause: 'crash_reopen' }
            );
        });

        it('an envelope submitted while a reopen is in flight is held, not routed into the orphaned queue', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.instances).toHaveLength(2);

            const pendingSubmit = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            // Neither the dead instance nor the not-yet-open replacement should have received it —
            // it must wait, held, for the reopen to actually finish.
            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(turnPrompts(h.instances[1])).toHaveLength(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(turnPrompts(h.instances[1])).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            const result = await pendingSubmit;
            expect(result.isError).toBe(false);
        });

        it('when both the resume and the fresh-open fallback fail, the in-flight and queued submits are rejected rather than hanging forever, with both AbortSignal listeners cleared', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const inFlightController = new AbortController();
            const inFlightRemoveSpy = jest.spyOn(inFlightController.signal, 'removeEventListener');
            const inFlight = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1', signal: inFlightController.signal });
            await flush();
            const queuedController = new AbortController();
            const queuedRemoveSpy = jest.spyOn(queuedController.signal, 'removeEventListener');
            const queued = h.conductor.submit(discordEnvelope(), { priority: 'other', signal: queuedController.signal });
            await flush();

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered first' }))).toBe(true);
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered second' }))).toBe(true);
            h.instances[1].fail(new Error('resume also failed'));
            await flush();
            h.instances[2].fail(new Error('fresh open also failed'));
            await flush();

            await expect(inFlight).rejects.toThrow();
            await expect(queued).rejects.toThrow();
            expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('giving up'));
            expect(h.logger.warn).toHaveBeenCalledWith(
                { dropped: 2 },
                'Giving up on a reopen; dropping input the dead session never delivered'
            );
            // rejectAllQueued/the in-flight-item rejection path both clear their AbortSignal
            // listener — a long-lived signal must not keep retaining a settled item's callback.
            expect(inFlightRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(queuedRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));

            // The conductor must not silently accept further work once it has given up.
            await expect(h.conductor.submit(discordEnvelope(), { priority: 'human' })).rejects.toThrow('not open');
        });

        it('normalises a non-Error final reopen failure and can be opened and used again after giving up', async () => {
            let saveCalls = 0;
            const resumeStore = {
                load: () => Promise.resolve(undefined),
                save: () => {
                    saveCalls += 1;
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises toError's deliberate non-Error fallback branch
                    return saveCalls === 2 || saveCalls === 3 ? Promise.reject(undefined) : Promise.resolve();
                },
            };
            const h = build({ resumeStore });
            await openWith(h, 'sess-1');
            const inFlight = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            h.instances[2].emit(frames.init('sess-fresh'));
            await expect(inFlight).rejects.toThrow('Conductor failed to reopen the session');
            expect(h.logger.error).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'Conductor failed to reopen the session' }) },
                'Conductor could not reopen the session after it closed unexpectedly; giving up'
            );

            const reopened = h.conductor.open();
            await flush();
            h.instances[3].emit(frames.init('sess-recovered'));
            await expect(reopened).resolves.toEqual({ sessionId: 'sess-recovered', resumed: false });
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[3].emit(frames.resultSuccess());
            await expect(resultPromise).resolves.toMatchObject({ isError: false, sessionId: 'sess-recovered' });
        });

        it('closes a fresh fallback handle when its own finishOpen fails before giving up', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.resumeStore.scriptSaveRejection(new Error('resume store unavailable'));
            const inFlight = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(h.instances[1].closeCalls).toBe(1);
            h.instances[2].emit(frames.init('sess-fresh'));
            await expect(inFlight).rejects.toThrow('resume store unavailable');

            expect(h.instances[2].closeCalls).toBe(1);
        });

        it('a resume that opens successfully but whose finishOpen rejects discards that handle before falling back to a fresh session — no leaked concurrent session', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.resumeStore.scriptSaveRejection(new Error('DynamoDB throttled'));
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.instances).toHaveLength(2);
            h.instances[1].emit(frames.init('sess-1')); // resume "succeeds" (a handle opens)...
            await flush();

            // ...but finishOpen's resumeStore.save() rejects, so the resumed handle must be
            // discarded (closed) rather than left running alongside a second, fresh one.
            expect(h.instances[1].closeCalls).toBe(1);

            h.resumeStore.scriptSaveRejection(undefined);
            expect(h.instances).toHaveLength(3);
            h.instances[2].emit(frames.init('sess-2'));
            await flush();

            expect(h.journal.byKind('session_opened').at(-1)).toMatchObject({ sessionId: 'sess-2', outcome: 'resume_fallback', cause: 'crash_reopen' });
        });

        it('discarding an older handle never clears a newer concurrently-opened handle', async () => {
            let saveCalls = 0;
            let rejectOlderSave!: (error: Error) => void;
            const resumeStore = {
                load: () => Promise.resolve(undefined),
                save: () => {
                    saveCalls += 1;
                    if(saveCalls === 2) {
                        return new Promise<void>((_resolve, reject) => {
                            rejectOlderSave = reject;
                        });
                    }
                    return Promise.resolve();
                },
            };
            const h = build({ resumeStore });
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('first handle crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            // The resumed handle closes while its finishOpen save is still pending. That begins a
            // newer reopen, whose handle becomes current before the older save rejects.
            h.instances[1].fail(new Error('resumed handle crashed during save'));
            await flush();
            h.instances[2].emit(frames.init('sess-newer'));
            await flush();
            rejectOlderSave(new Error('older resume-store save failed'));
            await flush();
            expect(h.instances).toHaveLength(4); // the older reopen also starts its fresh fallback

            // Closing the newer handle must still be recognized as a mid-life close. An older
            // discard that unconditionally cleared currentHandleRef would suppress this reopen.
            h.instances[2].fail(new Error('newer current handle crashed'));
            await flush();
            expect(h.instances).toHaveLength(5);
        });
    });

    describe('submit() with an AbortSignal', () => {
        it('a signal already aborted before submit() is called resolves withdrawn immediately, without ever reaching the SDK', async () => {
            const h = build();
            await openWith(h);
            const controller = new AbortController();
            controller.abort();

            const result = await h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });

            expect(result).toMatchObject({ response: null, wasInterrupted: true, isError: false, outcome: 'withdrawn' });
            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(h.instances[0].interruptCalls).toBe(0);
        });

        it('aborting while the envelope is queued behind a spontaneous notification turn withdraws it without ever arming the human-wait escalation interrupt', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantText('thinking out loud'));
            await flush();

            const controller = new AbortController();
            const heldEnvelope = discordEnvelope({ channelId: 'chan-1' });
            const heldResult = h.conductor.submit(heldEnvelope, { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();

            controller.abort();
            const result = await heldResult;

            // Withdrawn the instant the signal aborts — no need to wait out the human-wait target
            // that would otherwise (still, independently of this envelope) eventually interrupt
            // the running notification turn.
            expect(result).toEqual({
                envelopeId: heldEnvelope.id, response: null, wasInterrupted: true, partialWork: expect.any(Object), sessionId: 'sess-1', isError: false, contextUsagePercent: 0, outcome: 'withdrawn',
            });
            expect(h.conductor.status().queueLength).toBe(0);

            h.clock.advance(30_000);
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted()); // closes the spontaneous notification turn
            await flush();
        });

        it('aborting while a DIFFERENT channel\'s turn is running withdraws the held envelope and never interrupts that other turn', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-A' }), { priority: 'human', requestingChannelId: 'chan-A' });
            await flush();

            const controller = new AbortController();
            const heldEnvelope = discordEnvelope({ channelId: 'chan-B' });
            const heldResult = h.conductor.submit(heldEnvelope, { priority: 'human', requestingChannelId: 'chan-B', signal: controller.signal });
            await flush();

            controller.abort();
            const result = await heldResult;

            expect(result.outcome).toBe('withdrawn');
            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].emit(frames.resultSuccess());
            await firstResult;
        });

        it('aborting while this envelope\'s own turn is already running interrupts it and resolves outcome: \'interrupted\'', async () => {
            const h = build();
            await openWith(h);
            const controller = new AbortController();
            const addSpy = jest.spyOn(controller.signal, 'addEventListener');
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const envelope = discordEnvelope({ channelId: 'chan-1' });
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(0);
            expect(addSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });

            controller.abort();
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'submit() signal aborted' },
                'Conductor requesting interrupt'
            );

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            const result = await resultPromise;

            expect(result).toMatchObject({ envelopeId: envelope.id, wasInterrupted: true, isError: false, outcome: 'interrupted' });
        });

        it('an interrupt caused by another human envelope for the same channel (no signal involved) still carries wasInterrupted but no outcome', async () => {
            const h = build();
            await openWith(h);
            const firstResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            const result = await firstResult;

            expect(result.wasInterrupted).toBe(true);
            expect(result.outcome).toBeUndefined();
        });

        it('aborting after the turn has already resolved is a no-op (the listener was already removed)', async () => {
            const h = build();
            await openWith(h);
            const controller = new AbortController();
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.outcome).toBeUndefined();
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

            expect(() => {
                controller.abort();
            }).not.toThrow();
            expect(h.instances[0].interruptCalls).toBe(0);
        });

        it('contextUsagePercent on a TurnResult reflects the previous turn\'s polled usage, 0 before any poll has ever happened', async () => {
            const h = build();
            await openWith(h);

            const firstPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            const firstOutcome = await firstPromise;
            expect(firstOutcome.contextUsagePercent).toBe(0);
            await flush(); // let guard.onTurnEnd()'s poll land on the ledger before the next turn

            h.instances[0].scriptContextUsage({ percentage: 42, totalTokens: 420, maxTokens: 1000 });
            const secondPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            const secondOutcome = await secondPromise;
            expect(secondOutcome.contextUsagePercent).toBe(0); // still the pre-this-turn value; the fresh 42 hasn't been polled yet

            await flush();
            const thirdPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            const thirdOutcome = await thirdPromise;
            expect(thirdOutcome.contextUsagePercent).toBe(42);
        });

        it('aborting an envelope queued BEHIND another withdraws exactly that one: the envelope ahead of it still runs next, and the withdrawn envelope never reaches the SDK', async () => {
            const h = build();
            await openWith(h);
            const runningResult = h.conductor.submit(discordEnvelope({ channelId: 'chan-A' }), { priority: 'human', requestingChannelId: 'chan-A' });
            await flush();

            // Both queue up behind chan-A's turn: `ahead` lands at index 0, the signal-bearing
            // `behind` at index 1 — the case where "the item's own index" and "the head" differ.
            const aheadEnvelope = discordEnvelope({ channelId: 'chan-B' });
            const aheadResult = h.conductor.submit(aheadEnvelope, { priority: 'human', requestingChannelId: 'chan-B' });
            await flush();

            const controller = new AbortController();
            const behindEnvelope = discordEnvelope({ channelId: 'chan-C' });
            const behindResult = h.conductor.submit(behindEnvelope, { priority: 'human', requestingChannelId: 'chan-C', signal: controller.signal });
            await flush();
            expect(h.conductor.status().queueLength).toBe(2);

            controller.abort();
            const withdrawn = await behindResult;
            expect(withdrawn).toMatchObject({ envelopeId: behindEnvelope.id, response: null, wasInterrupted: true, outcome: 'withdrawn' });
            // Exactly one envelope left the queue — the aborted one. Withdrawing by removing the
            // head instead of the aborted envelope's own index would have dropped `ahead` and left
            // this already-settled envelope queued to run a turn of its own.
            expect(h.conductor.status().queueLength).toBe(1);

            h.instances[0].emit(frames.resultSuccess());
            await runningResult;
            await flush();

            expect(h.ledgerStore.get().turn).toMatchObject({ channelId: 'chan-B' });

            h.instances[0].emit(frames.resultSuccess());
            const aheadOutcome = await aheadResult;
            expect(aheadOutcome.envelopeId).toBe(aheadEnvelope.id);
        });
    });

    describe('interruptCurrent()', () => {
        it('is a no-op when nothing is running', async () => {
            const h = build();
            await openWith(h);

            await h.conductor.interruptCurrent();

            expect(h.instances[0].interruptCalls).toBe(0);
        });

        it('ignored when requestingChannelId does not own the running discord turn', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            await h.conductor.interruptCurrent({ requestingChannelId: 'chan-other' });

            expect(h.instances[0].interruptCalls).toBe(0);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { requestingChannelId: 'chan-other', turnChannelId: 'chan-1' },
                'interruptCurrent ignored: requesting channel does not own the running turn'
            );
        });

        it('allows an unscoped interrupt of a channel-owned turn', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const interruptPromise = h.conductor.interruptCurrent({ reason: 'operator requested' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(1);
            h.instances[0].resolveInterrupt();
            await interruptPromise;
        });

        it('allows a channel-scoped interrupt when the running turn itself has no channel', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(catchupEnvelope(), { priority: 'other' });
            await flush();

            const interruptPromise = h.conductor.interruptCurrent({ requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(1);
            h.instances[0].resolveInterrupt();
            await interruptPromise;
        });

        it('interrupts the running turn when the channel matches', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const interruptPromise = h.conductor.interruptCurrent({ requestingChannelId: 'chan-1' });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            await interruptPromise;
        });

        it('a rejecting handle.interrupt() is logged and does not throw out of interruptCurrent()', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const interruptPromise = h.conductor.interruptCurrent({ requestingChannelId: 'chan-1' });
            await flush();

            const interruptError = new Error('SDK refused the interrupt');
            h.instances[0].rejectInterrupt(interruptError);

            await interruptPromise; // must resolve, not reject, even though the underlying call failed

            expect(h.logger.error).toHaveBeenCalledWith(
                { error: interruptError },
                'Conductor interrupt failed'
            );
        });
    });

    describe('status()', () => {
        it('reports role, sessionId, queue length and the running turn', async () => {
            const h = build();
            expect(h.conductor.status()).toMatchObject({ role: 'conversation', opened: false, turn: null });

            await openWith(h, 'sess-status');
            const envelope = discordEnvelope({ authorId: 'user-status' });
            void h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.conductor.status()).toMatchObject({
                role: 'conversation', sessionId: 'sess-status', opened: true, turn: { kind: 'discord', channelId: 'chan-1', envelopeId: envelope.id, authorId: 'user-status' },
            });
        });
    });

    describe('shutdown()', () => {
        it('with no running turn: flushes the journal and closes immediately', async () => {
            const h = build();
            await openWith(h);

            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            expect(h.journal.flushCount).toBe(1);
            expect(h.instances[0].closeCalls).toBe(1);
            expect(h.clock.pending()).toBe(0);
        });

        it('with a running turn: waits turnWaitMs, then interrupts, then flushes and closes', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            h.clock.advance(59_999);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'shutdown turn-wait elapsed' },
                'Conductor requesting interrupt'
            );

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await shutdownPromise;

            expect(h.journal.flushCount).toBe(1);
            expect(h.instances[0].closeCalls).toBe(1);
        });

        it('honors the caller-supplied turnWaitMs, not a hardcoded or dropped wait — no interrupt until it elapses', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 5000, deadlineMs: 120_000 });
            await flush();

            // Flush right after each advance (unlike the test above) so a wait shorter than
            // requested — e.g. a dropped turnWaitMs firing at 0ms — would already show up here.
            h.clock.advance(4999);
            await flush();
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await shutdownPromise;
        });

        it('clears both shutdown timers when the running turn ends naturally before turnWaitMs', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();
            expect(h.clock.pending()).toBe(2);

            h.instances[0].emit(frames.resultSuccess());
            await shutdownPromise;

            expect(h.instances[0].interruptCalls).toBe(0);
            expect(h.clock.pending()).toBe(0);
        });

        it('a naturally-ended turn reaches journal flush without an extra no-op interrupt await before the hard deadline', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 1 });
            await flush();
            h.instances[0].emit(frames.resultSuccess());

            // Drain exactly the reader, waiter-race, graceful-shutdown, and flush-call turns. If
            // shutdown awaits interruptCurrentTurnInternal after the turn is already null, the
            // flush is delayed by one more microtask and can lose the deadline race.
            for(let step = 0; step < 5; step += 1) {
                // eslint-disable-next-line no-await-in-loop -- each turn is the behavior asserted
                await Promise.resolve();
            }
            expect(h.journal.flushCount).toBe(1);
            expect(h.journal.byKind('shutdown')).toHaveLength(1);

            h.clock.advance(1);
            await shutdownPromise;
        });

        it('rejects submit() once shutdown has begun', async () => {
            const h = build();
            await openWith(h);

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            await expect(h.conductor.submit(discordEnvelope(), { priority: 'human' })).rejects.toThrow('shutting down');

            await shutdownPromise;
        });

        it('a hard deadline forces close even if the turn never ends and interrupt never resolves', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 1000, deadlineMs: 5000 });
            await flush();
            h.clock.advance(1000);
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);
            // interrupt() never resolves and the turn never ends — only the deadline can save us.

            h.clock.advance(4000);
            await shutdownPromise;

            expect(h.instances[0].closeCalls).toBe(1);
        });

        it('rejects everything still waiting in pendingQueue, not just later submits, once shutdown begins', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const queuedPromise = h.conductor.submit(discordEnvelope({ channelId: 'chan-2' }), { priority: 'human', requestingChannelId: 'chan-2' });
            await flush();

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            await expect(queuedPromise).rejects.toThrow('shutting down');

            h.clock.advance(60_000);
            await flush();
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await shutdownPromise;
        });

        it('calling shutdown() a second time while already shutting down is a no-op — exactly one flush, one close', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            const firstShutdown = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();
            const secondShutdown = h.conductor.shutdown({ turnWaitMs: 1000, deadlineMs: 2000 });
            await secondShutdown; // the second call must resolve immediately, without its own flush/close

            expect(h.journal.flushCount).toBe(0); // first shutdown is still waiting on the running turn

            h.clock.advance(60_000);
            await flush();
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await firstShutdown;

            expect(h.journal.flushCount).toBe(1);
            expect(h.instances[0].closeCalls).toBe(1);
        });

        it('a rejecting journal.flush() still closes the handle and lets shutdown() resolve', async () => {
            const h = build();
            await openWith(h);
            h.journal.scriptFlushRejection(new Error('journal store unavailable'));

            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            expect(h.journal.flushCount).toBe(1);
            expect(h.instances[0].closeCalls).toBe(1);
            expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('flush'));
        });

        it('journals session_ended then shutdown, before flush()', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            const kinds = h.journal.entries().map(entry => entry.type);
            expect(kinds.indexOf('session_ended')).toBeGreaterThanOrEqual(0);
            expect(kinds.indexOf('session_ended')).toBeLessThan(kinds.indexOf('shutdown'));
            expect(h.journal.byKind('session_ended')).toEqual([{ type: 'session_ended', at: expect.any(Date), sessionId: 'sess-1' }]);
            expect(h.journal.byKind('shutdown')).toEqual([{ type: 'shutdown', at: expect.any(Date) }]);
            // Both entries were appended before shutdown() resolved, which is exactly when flush() was awaited.
            expect(h.journal.flushCount).toBe(1);
        });

        it('does not journal session_ended when shutdown() is called before the session ever opened', async () => {
            const h = build();

            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            expect(h.journal.byKind('session_ended')).toEqual([]);
            expect(h.journal.byKind('shutdown')).toEqual([{ type: 'shutdown', at: expect.any(Date) }]);
        });

        it('called while a mid-life crash reopen is in flight awaits it before flushing/closing, and the reopen discards its brand-new replacement rather than leaking it', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.instances).toHaveLength(2);

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            // The reopen has not resolved yet (instances[1] has not emitted its init frame), so
            // shutdown() must still be waiting on it rather than having already flushed/closed.
            expect(h.instances[1].closeCalls).toBe(0);
            expect(h.journal.flushCount).toBe(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await shutdownPromise;

            // reopenReplacementSession's own shuttingDown branch closes the brand-new handle
            // itself (it would otherwise outlive the process), before shutdown()'s final close.
            expect(h.instances[1].closeCalls).toBe(1);
            expect(h.journal.flushCount).toBe(1);
        });
    });

    describe('deliver()', () => {
        it('throws an InvariantViolationError when called before open() has run its boot recovery', async () => {
            const h = build();

            await expect(h.conductor.deliver('env-1', () => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] })))
                .rejects.toThrow('Invariant violated in conductor.deliver: called before open() completed its boot recovery, which initialises the delivery guard');
        });

        it('sends, journals response_delivered, and awaits flush() before resolving, then marks the envelope delivered', async () => {
            const h = build();
            await openWith(h);
            const order: string[] = [];
            const send = jest.fn(async () => {
                order.push('send');
                return { kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] };
            });
            const originalFlush = h.journal.flush.bind(h.journal);
            const flushSpy = jest.spyOn(h.journal, 'flush').mockImplementation(async () => {
                order.push('flush');
                return originalFlush();
            });

            const result = await h.conductor.deliver('env-1', send);
            order.push('resolved');

            expect(send).toHaveBeenCalledTimes(1);
            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ outcome: 'committed', disposition: 'sent' });
            expect(h.journal.byKind('response_delivered')).toEqual([
                { type: 'response_delivered', at: expect.any(Date), envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'], disposition: 'sent' },
            ]);
            expect(order).toEqual(['send', 'flush', 'resolved']);
        });

        it('journals queued commitments with queued disposition and no message ids', async () => {
            const h = build();
            await openWith(h);

            const result = await h.conductor.deliver('env-queued', () => Promise.resolve({
                kind: 'committed' as const, disposition: 'queued' as const, channelId: 'chan-1', outboxIds: ['outbox-1'],
            }));

            expect(result).toEqual({ outcome: 'committed', disposition: 'queued' });
            expect(h.journal.byKind('response_delivered')).toEqual([
                { type: 'response_delivered', at: expect.any(Date), envelopeId: 'env-queued', channelId: 'chan-1', messageIds: [], disposition: 'queued' },
            ]);
        });

        it('returns skipped without journaling, flushing, or marking the delivery guard', async () => {
            const h = build();
            await openWith(h);
            const send = jest.fn(() => Promise.resolve({ kind: 'skipped' as const, reason: 'no-response' }));

            const result = await h.conductor.deliver('env-skipped', send);

            expect(result).toEqual({ outcome: 'skipped' });
            expect(h.journal.byKind('response_delivered')).toHaveLength(0);
            expect(h.journal.flushCount).toBe(0);
            expect(h.logger.info).toHaveBeenCalledWith(
                { envelopeId: 'env-skipped', reason: 'no-response' },
                'Conductor.deliver: response skipped; not committing delivery'
            );

            const retried = await h.conductor.deliver('env-skipped', send);
            expect(retried).toEqual({ outcome: 'skipped' });
            expect(send).toHaveBeenCalledTimes(2);
        });

        it('a thrown ResponseUnavailableError does not journal, flush, or mark delivery', async () => {
            const h = build();
            await openWith(h);
            const send = jest.fn(() => Promise.reject(new ResponseUnavailableError()));

            await expect(h.conductor.deliver('env-unavailable', send)).rejects.toThrow(ResponseUnavailableError);

            expect(h.journal.byKind('response_delivered')).toHaveLength(0);
            expect(h.journal.flushCount).toBe(0);
            const retried = await h.conductor.deliver('env-unavailable', () => Promise.resolve({
                kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'],
            }));
            expect(retried).toEqual({ outcome: 'committed', disposition: 'sent' });
        });

        it('a second deliver() call for the same envelope id skips the send and does not journal again', async () => {
            const h = build();
            await openWith(h);
            const send = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] }));

            await h.conductor.deliver('env-1', send);
            const second = await h.conductor.deliver('env-1', send);

            expect(send).toHaveBeenCalledTimes(1);
            expect(second).toEqual({ outcome: 'already-committed' });
            expect(h.journal.byKind('response_delivered')).toHaveLength(1);
            expect(h.logger.info).toHaveBeenCalledWith(
                { envelopeId: 'env-1' },
                'Conductor.deliver: envelope already delivered; skipping send'
            );
        });
    });

    describe('boot recovery', () => {
        it('reads a bounded window (24h, not the 30-day journal TTL) so boot recovery cannot scan the whole free-tier-provisioned partition', async () => {
            const h = build();
            const readSinceSpy = jest.spyOn(h.journal, 'readSince');

            await openWith(h);

            expect(readSinceSpy).toHaveBeenCalledWith(0 - 24 * 60 * 60 * 1000);
        });

        it('a readSince() rejection is logged and degrades to an empty-seeded delivery guard rather than rejecting open()', async () => {
            const h = build();
            const recoveryError = new Error('DynamoDB throttled');
            h.journal.scriptReadSinceRejection(recoveryError);

            await expect(openWith(h)).resolves.toEqual({ sessionId: 'sess-1', resumed: false });

            expect(h.logger.error).toHaveBeenCalledWith(
                { error: recoveryError },
                'Conductor boot recovery failed; opening with an empty-seeded delivery guard'
            );
            const send = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] }));
            const result = await h.conductor.deliver('Stryker was here', send);
            expect(result).toEqual({ outcome: 'committed', disposition: 'sent' });
        });

        it('a readSince() rejection hands the bundle builder empty recovery lists', async () => {
            const buildBootBundle = jest.fn((_request: BootBundleRequest) => '');
            const h = build({ buildBootBundle });
            h.journal.scriptReadSinceRejection(new Error('DynamoDB throttled'));

            await openWith(h);

            expect(buildBootBundle.mock.calls).toEqual([[{
                kind: 'fresh', cause: 'boot', lostTasks: [], undelivered: [],
            }]]);
        });

        it('journals task_lost at boot for a task_started with no resolution in the journal window', async () => {
            const h = build();
            h.journal.scriptReadSince([
                { type: 'task_started', at: new Date(0), taskId: 'task-1', description: 'abandoned before restart' },
            ]);

            await openWith(h);

            expect(h.journal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: 'task-1', description: 'abandoned before restart' },
            ]);
        });

        it('seeds the delivery guard from deliveredEnvelopeIds so deliver() refuses to redeliver', async () => {
            const h = build();
            h.journal.scriptReadSince([
                {
                    type: 'response_delivered', at: new Date(0), envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'],
                },
            ]);

            await openWith(h);
            const send = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-2'] }));

            const result = await h.conductor.deliver('env-1', send);

            expect(result).toEqual({ outcome: 'already-committed' });
            expect(send).not.toHaveBeenCalled();
        });

        it('feeds recovery-derived lost task and undelivered-envelope descriptions to buildBootBundle', async () => {
            const buildBootBundle = jest.fn((input: BootBundleRequest) => `lost:${input.lostTasks.join(',')}|undelivered:${input.undelivered.join(',')}`);
            const h = build({
                buildBootBundle,
            });
            h.journal.scriptReadSince([
                { type: 'task_started', at: new Date(0), taskId: 'task-1', description: 'abandoned task' },
                { type: 'envelope_submitted', at: new Date(0), envelopeId: 'env-1', kind: 'discord' },
                { type: 'turn_completed', at: new Date(0), envelopeId: 'env-1', kind: 'discord' },
            ]);

            await openWith(h);

            expect(buildBootBundle.mock.calls).toEqual([[{
                kind:        'fresh',
                cause:       'boot',
                lostTasks:   ['abandoned task'],
                undelivered: ['discord envelope env-1'],
            }]]);
            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(handshakeOf(h.instances[0])).toBe('lost:abandoned task|undelivered:discord envelope env-1');
        });

        it('includes a recovered task with an explicitly empty description in the boot bundle', async () => {
            const buildBootBundle = jest.fn(() => '');
            const h = build({ buildBootBundle });
            h.journal.scriptReadSince([
                { type: 'task_started', at: new Date(0), taskId: 'task-empty-description', description: '' },
            ]);

            await openWith(h);

            expect(buildBootBundle).toHaveBeenCalledWith({
                kind:        'fresh',
                cause:       'boot',
                lostTasks:   [''],
                undelivered: [],
            });
        });

        it('a builder that rejects leaves the recovery-seeded delivery guard in place: deliver() still refuses to resend what a prior process sent', async () => {
            const h = build({ buildBootBundle: jest.fn(() => Promise.reject(new Error('task list unavailable'))) });
            h.journal.scriptReadSince([
                {
                    type: 'response_delivered', at: new Date(0), envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'],
                },
            ]);

            await expect(openWith(h)).resolves.toEqual({ sessionId: 'sess-1', resumed: false });
            expect(handshakeOf(h.instances[0])).toBe('[BOOT] Session opened at 1970-01-01T00:00:00.000Z. No boot context to report. Host handshake — nothing to do, no reply expected.');
            expect(h.logger.error).not.toHaveBeenCalled();

            const send = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-2'] }));
            await expect(h.conductor.deliver('env-1', send)).resolves.toEqual({ outcome: 'already-committed' });
            expect(send).not.toHaveBeenCalled();
        });
    });

    describe('boot bundle build bound and fallback (#98)', () => {
        const BARE_OPENED_AT_ZERO = '[BOOT] Session opened at 1970-01-01T00:00:00.000Z. No boot context to report. Host handshake — nothing to do, no reply expected.';

        it('a builder that rejects is logged and the open goes ahead with the bare marker', async () => {
            const failure = new Error('task list unavailable');
            const h = build({ buildBootBundle: jest.fn(() => Promise.reject(failure)) });

            await openWith(h);

            expect(handshakeOf(h.instances[0])).toBe(BARE_OPENED_AT_ZERO);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: failure, kind: 'fresh', cause: 'boot' },
                'Boot bundle build failed or timed out; opening with the recovery-only fallback'
            );
        });

        it('a builder that throws synchronously is treated like a rejection', async () => {
            const failure = new Error('sync throw');
            const h = build({
                buildBootBundle: jest.fn(() => {
                    throw failure;
                }),
            });

            await openWith(h);

            expect(handshakeOf(h.instances[0])).toBe(BARE_OPENED_AT_ZERO);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: failure, kind: 'fresh', cause: 'boot' },
                'Boot bundle build failed or timed out; opening with the recovery-only fallback'
            );
        });

        it('a builder that never settles holds the open until exactly 10 000 ms on the injected clock, then opens with the bare marker and ignores the late result', async () => {
            const late = deferred<string>();
            const h = build({ buildBootBundle: jest.fn(() => late.promise) });

            const openPromise = h.conductor.open();
            await flush();
            h.clock.advance(9999);
            await flush();
            expect(h.instances).toHaveLength(0);

            h.clock.advance(1);
            await flush();
            expect(h.instances).toHaveLength(1);
            expect(handshakeOf(h.instances[0])).toBe('[BOOT] Session opened at 1970-01-01T00:00:10.000Z. No boot context to report. Host handshake — nothing to do, no reply expected.');
            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: new Error('Boot bundle build did not finish within 10000 ms'), kind: 'fresh', cause: 'boot' },
                'Boot bundle build failed or timed out; opening with the recovery-only fallback'
            );

            h.instances[0].emit(frames.init('sess-1'));
            await expect(openPromise).resolves.toEqual({ sessionId: 'sess-1', resumed: false });
            late.resolve('too late');
            await flush();
            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(h.instances).toHaveLength(1);
        });

        it('a builder that settles in time clears its timeout timer', async () => {
            const h = build({ buildBootBundle: jest.fn(async () => 'in time') });

            const openPromise = h.conductor.open();
            await flush();
            expect(h.instances).toHaveLength(1);
            expect(h.clock.pending()).toBe(0);
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;
        });

        it('a builder that rejects clears its timeout timer too', async () => {
            const h = build({ buildBootBundle: jest.fn(() => Promise.reject(new Error('nope'))) });

            const openPromise = h.conductor.open();
            await flush();
            expect(h.instances).toHaveLength(1);
            expect(h.clock.pending()).toBe(0);
            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;
        });

        it('on a rejection the recovery-only fallback renderer gets the same request, and its text becomes the handshake', async () => {
            const renderBootBundleFallback = jest.fn(({ lostTasks }: BootBundleRequest) => `recovery only: ${lostTasks.join(',')}`);
            const h = build({ buildBootBundle: jest.fn(() => Promise.reject(new Error('perch context failed'))), renderBootBundleFallback });
            h.journal.scriptReadSince([
                { type: 'task_started', at: new Date(0), taskId: 'task-1', description: 'abandoned task' },
            ]);

            await openWith(h);

            expect(renderBootBundleFallback.mock.calls).toEqual([[{
                kind: 'fresh', cause: 'boot', lostTasks: ['abandoned task'], undelivered: [],
            }]]);
            expect(handshakeOf(h.instances[0])).toBe('recovery only: abandoned task');
        });

        it('on a timeout the recovery-only fallback renderer supplies the handshake as well', async () => {
            const renderBootBundleFallback = jest.fn((_request: BootBundleRequest) => 'recovery only');
            const h = build({ buildBootBundle: jest.fn(() => deferred<string>().promise), renderBootBundleFallback });
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            h.clock.advance(10_000);
            await flush();

            expect(renderBootBundleFallback.mock.calls).toEqual([[{
                kind: 'restart_resume', cause: 'boot', lostTasks: [], undelivered: [],
            }]]);
            expect(handshakeOf(h.instances[0])).toBe('recovery only');
            h.instances[0].emit(frames.init('sess-old'));
            await openPromise;
        });

        it('the fallback renderer is never consulted when the build succeeds', async () => {
            const renderBootBundleFallback = jest.fn(() => 'recovery only');
            const h = build({ buildBootBundle: jest.fn(() => 'full bundle'), renderBootBundleFallback });

            await openWith(h);

            expect(renderBootBundleFallback).not.toHaveBeenCalled();
            expect(handshakeOf(h.instances[0])).toBe('full bundle');
        });

        it('an empty fallback text falls back to the bare marker', async () => {
            const h = build({ buildBootBundle: jest.fn(() => Promise.reject(new Error('nope'))), renderBootBundleFallback: jest.fn(() => '') });

            await openWith(h);

            expect(handshakeOf(h.instances[0])).toBe(BARE_OPENED_AT_ZERO);
        });

        it('with no builder at all nothing is built and the open pushes the bare marker', async () => {
            const renderBootBundleFallback = jest.fn(() => 'recovery only');
            const h = build({ renderBootBundleFallback });

            await openWith(h);

            expect(renderBootBundleFallback).not.toHaveBeenCalled();
            expect(handshakeOf(h.instances[0])).toBe(BARE_OPENED_AT_ZERO);
        });

        it('crash-and-restart: a conductor rebuilt over the same journal refuses to redeliver what the crashed one already sent, and reports its unfinished task as lost', async () => {
            const sharedJournal = new FakeJournal();
            const a = build({ journal: sharedJournal });
            await openWith(a, 'sess-a');
            a.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'started by A' }));
            await flush();
            const sendFromA = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] }));
            await a.conductor.deliver('env-E', sendFromA);

            // A crashes here: discarded without ever calling shutdown()/flush(). FakeJournal.append
            // is synchronous, so everything A wrote is already in `sharedJournal` regardless.
            sharedJournal.scriptReadSince(sharedJournal.entries());

            const b = build({ journal: sharedJournal });
            await openWith(b, 'sess-b');

            expect(sharedJournal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: 'task-1', description: 'started by A' },
            ]);

            const sendFromB = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-2'] }));
            const result = await b.conductor.deliver('env-E', sendFromB);

            expect(result).toEqual({ outcome: 'already-committed' });
            expect(sendFromB).not.toHaveBeenCalled();
        });
    });

    describe('subscribeTurn()', () => {
        it('receives every frame observed while subscribed, and stops after unsubscribing', async () => {
            const h = build();
            await openWith(h);
            const received: string[] = [];
            const unsubscribe = h.conductor.subscribeTurn((turnId) => {
                received.push(turnId);
            });

            void h.conductor.submit(discordEnvelope({ id: 'env-sub' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(received).toContain('env-sub');

            unsubscribe();
            received.length = 0;
            h.instances[0].emit(frames.assistantText('after unsubscribe'));
            await flush();
            expect(received).toEqual([]);
        });

        it('reports \'none\' for a frame observed while no turn is open at all', async () => {
            const h = build();
            await openWith(h);
            const received: string[] = [];
            h.conductor.subscribeTurn((turnId) => {
                received.push(turnId);
            });

            // A non-assistant frame opens no turn, so subscribers see the no-turn sentinel.
            h.instances[0].emit(frames.hookStarted());
            await flush();

            expect(received).toEqual(['none']);
        });

        it('keeps a child assistant frame observable on an already-open root turn', async () => {
            const h = build();
            await openWith(h);
            const received: string[] = [];
            h.conductor.subscribeTurn(turnId => received.push(turnId));
            const result = h.conductor.submit(discordEnvelope({ id: 'env-root' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.assistantText('child progress', { parent_tool_use_id: 'toolu-parent' }));
            await flush();

            expect(received).toEqual(['env-root']);
            expect(h.conductor.status().turn).toMatchObject({ kind: 'discord', envelopeId: 'env-root' });
            expect(h.ledgerStore.get().turn).toMatchObject({ id: 'env-root', kind: 'discord', phase: { type: 'responding' } });

            h.instances[0].emit(frames.resultSuccess());
            await result;
            await flush();
        });

        it('a bare spontaneous turn reports the ledger turn\'s own minted id, never the literal kind', async () => {
            const h = build();
            await openWith(h);
            const observed: { turnId: string, ledgerTurnId: string }[] = [];
            h.conductor.subscribeTurn((turnId) => {
                // Read from INSIDE the callback: this is simultaneously the proof that the ledger
                // turn already exists by the time subscribers are notified of the first frame.
                observed.push({ turnId, ledgerTurnId: h.ledgerStore.get().turn?.id ?? 'no ledger turn open' });
            });

            h.instances[0].emit(frames.assistantText('an unsolicited musing'));
            await flush();

            const first = observed[0];
            expect(first.turnId).toMatch(/^notification-\d+$/);
            expect(first.turnId).not.toBe('notification');
            expect(first.turnId).toBe(first.ledgerTurnId);
        });
    });

    describe('synopsis seeds reach the ledger turn', () => {
        it('a submitted envelope carries its synopsisSeed onto the ledger turn', async () => {
            const h = build();
            await openWith(h);

            void h.conductor.submit(discordEnvelope({ synopsisSeed: 'fix the presence bug' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.ledgerStore.get().turn?.seed).toBe('fix the presence bug');
        });

        it('an adopted wake turn seeds from the wake summary, capped', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'z'.repeat(250) });
            h.instances[0].emit(frames.assistantText('woken'));
            await flush();

            expect(h.ledgerStore.get().turn?.seed).toBe('z'.repeat(200));
        });

        it('an adopted peer turn seeds from the peer envelope\'s own synopsisSeed', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptPeerTurn(peerEnvelope({ synopsisSeed: 'Izzy-main: take a look' }));
            h.instances[0].emit(frames.assistantText('sure'));
            await flush();

            expect(h.ledgerStore.get().turn?.seed).toBe('Izzy-main: take a look');
        });

        it('a frame inside the awaitingTurnEnd window opens the ledger turn BEFORE subscribers are notified, so a presence handler keyed on the ledger never misses that frame', async () => {
            const h = build();
            await openWith(h);
            const deferredUsage = h.instances[0].deferContextUsage();
            const priorResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            // Subscribers run BEFORE the sdk_frame dispatch, so a ledger turn opened only by
            // `reduceAssistantFrame`'s null-turn fallback would still be absent right here — and
            // the presence handler, which is created from the ledger turn, would miss this frame
            // entirely. For the common one-assistant-frame-then-result shape that means no
            // synopsis is ever generated and Discord stays generic for the turn's whole life.
            const ledgerTurnAtNotify: (string | undefined)[] = [];
            h.conductor.subscribeTurn(() => {
                ledgerTurnAtNotify.push(h.ledgerStore.get().turn?.id);
            });
            h.instances[0].emit(frames.assistantText('racing the compaction decision'));
            await flush();

            expect(ledgerTurnAtNotify[0]).toMatch(/^notification-\d+$/);
            // Still exactly one turn, with the frame's own phase applied to it by the sdk_frame
            // dispatch that follows — not a second turn, and not a phaseless one.
            expect(h.ledgerStore.get().turn?.id).toBe(ledgerTurnAtNotify[0]);
            expect(h.ledgerStore.get().turn?.phase).not.toBeNull();

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            await priorResult;
        });

        it('a child assistant frame inside the awaitingTurnEnd window opens neither conductor nor ledger turn', async () => {
            const h = build();
            await openWith(h);
            const deferredUsage = h.instances[0].deferContextUsage();
            const priorResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.instances[0].emit(frames.assistantText('child result racing the compaction decision', { parent_tool_use_id: 'toolu-parent' }));
            await flush();

            expect(h.conductor.status().turn).toBeNull();
            expect(h.ledgerStore.get().turn).toBeNull();

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            await priorResult;
        });

        it('the awaitingTurnEnd window: the ledger keeps the turn its own frame opened, while turnIdFor reports the newer minted id', async () => {
            const h = build();
            await openWith(h);
            const deferredUsage = h.instances[0].deferContextUsage();
            const priorResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            // A frame inside the awaitingTurnEnd window: the conductor declines to open a turn,
            // so the ledger's own null-turn fallback opens one instead.
            h.instances[0].emit(frames.assistantText('racing the compaction decision'));
            await flush();
            const ledgerOpenedId = h.ledgerStore.get().turn?.id;
            expect(ledgerOpenedId).toMatch(/^notification-\d+$/);
            expect(h.conductor.status().turn).toBeNull();

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            await priorResult;

            const observed: string[] = [];
            h.conductor.subscribeTurn((turnId) => {
                observed.push(turnId);
            });
            h.clock.advance(5000);
            h.instances[0].emit(frames.assistantText('a later musing'));
            await flush();

            // The conductor minted a fresher id; the ledger kept the turn it already had, and
            // presence reads the LEDGER's id — so the skew is inert, not a dropped synopsis.
            expect(observed[0]).not.toBe(ledgerOpenedId);
            expect(h.ledgerStore.get().turn?.id).toBe(ledgerOpenedId);
        });

        it('the awaitingTurnEnd window dispatches spontaneous_turn_opened with the SAME captured `at` used to mint the turn id — not a second, independent clock read', async () => {
            const h = build();
            await openWith(h);
            const deferredUsage = h.instances[0].deferContextUsage();
            const priorResult = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            // If the dispatched `at` were a fresh `now()` call instead of the one captured for
            // the turn id, a clock that returns a different value on the second read would
            // produce a ledger turn whose startedAt disagrees with its own id's timestamp.
            let call = 0;
            jest.spyOn(h.clock, 'now').mockImplementation(() => {
                call += 1;
                return call === 1 ? 1000 : 2000;
            });

            h.instances[0].emit(frames.assistantText('racing the compaction decision'));
            await flush();

            expect(h.ledgerStore.get().turn?.id).toBe('notification-1000');
            expect(h.ledgerStore.get().turn?.startedAt.getTime()).toBe(1000);

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            await priorResult;
        });
    });

    it('is_error retry uses classifyClaudeError by default (no classifyError override needed)', async () => {
        // Sanity check that the default parameter is wired: an unclassified default retryPolicy
        // from DEFAULT_RETRY_CONFIG.claude is also accepted as-is (shape check only).
        expect(DEFAULT_RETRY_CONFIG.claude.maxAttempts).toBeGreaterThanOrEqual(1);
        const h = build({ retryPolicy: DEFAULT_RETRY_CONFIG.claude });
        await openWith(h);
        const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
        await flush();

        h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'bad request', api_error_status: 400 }));
        const result = await resultPromise;

        expect(result.isError).toBe(true);
    });

    describe('adoptWakeTurn() (R2: background-work wake turns adopt the launching envelope)', () => {
        it('does not let an idle child assistant frame steal the following adopted root wake turn', async () => {
            const journal = new FakeJournal();
            const registry = createTaskLaunchRegistry({ journal });
            const onWakeTurnSettled = jest.fn();
            const h = build({ journal, taskLaunches: registry, onWakeTurnSettled });
            const observed: { turnId: string, frame: SDKMessage }[] = [];
            h.conductor.subscribeTurn((turnId, frame) => observed.push({ turnId, frame }));
            await openWith(h);

            const launchEnvelope = discordEnvelope({ channelId: 'chan-C', authorId: 'user-U' });
            const launchResult = h.conductor.submit(launchEnvelope, { priority: 'human', requestingChannelId: 'chan-C' });
            await flush();
            registry.record({
                taskId: 'agent-X', toolUseId: 'tool-T', toolName: 'Agent', envelopeId: launchEnvelope.id, kind: 'discord', channelId: 'chan-C', authorId: 'user-U', launchedAt: new Date(h.clock.now()),
            });
            h.instances[0].emit(frames.resultSuccess({ result: 'LAUNCHED' }));
            await launchResult;
            await flush();

            const childFrame = frames.assistantText('child final emitted before the wake prompt', { parent_tool_use_id: 'tool-T' });
            h.instances[0].emit(childFrame);
            await flush();

            expect(h.conductor.status().turn).toBeNull();
            expect(h.ledgerStore.get().turn).toBeNull();
            expect(observed.at(-1)).toEqual({ turnId: 'none', frame: childFrame });
            expect(journal.byKind('envelope_submitted').filter(entry => entry.kind === 'task')).toEqual([]);

            h.conductor.adoptWakeTurn({ taskId: 'agent-X', toolUseId: 'tool-T', summary: 'done' });
            const childAfterWake = frames.assistantText('another child frame after the wake hook', { parent_tool_use_id: 'tool-T' });
            h.instances[0].emit(childAfterWake);
            await flush();

            expect(h.conductor.status().turn).toBeNull();
            expect(h.ledgerStore.get().turn).toBeNull();
            expect(observed.at(-1)).toEqual({ turnId: 'none', frame: childAfterWake });
            expect(registry.lookup({ taskId: 'agent-X', toolUseId: 'tool-T' })).toBeDefined();
            expect(journal.byKind('envelope_submitted').filter(entry => entry.kind === 'task')).toEqual([]);

            h.instances[0].emit(frames.assistantText('root wake reply', { parent_tool_use_id: null }));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'task', channelId: 'chan-C', authorId: 'user-U' });
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'task', channelId: 'chan-C' });
            expect(registry.lookup({ taskId: 'agent-X', toolUseId: 'tool-T' })).toBeUndefined();

            h.instances[0].emit(frames.resultSuccess({ result: 'root wake reply' }));
            await flush();

            const submitted = journal.byKind('envelope_submitted').filter(entry => entry.kind === 'task');
            expect(submitted).toEqual([
                { type: 'envelope_submitted', at: expect.any(Date), envelopeId: expect.any(String), kind: 'task', channelId: 'chan-C' },
            ]);
            expect(journal.byKind('turn_completed').at(-1)).toEqual({
                type: 'turn_completed', at: expect.any(Date), envelopeId: submitted[0]?.envelopeId, kind: 'task', responseText: 'root wake reply',
            });
            expect(onWakeTurnSettled).toHaveBeenCalledTimes(1);
            expect(onWakeTurnSettled).toHaveBeenCalledWith(
                expect.objectContaining({ id: submitted[0]?.envelopeId, kind: 'task', channelId: 'chan-C', authorId: 'user-U' }),
                expect.objectContaining({ response: 'root wake reply', isError: false })
            );
        });

        it('unit-level end-to-end: a launch recorded from a discord turn is adopted by its wake, opening a task turn delivered back to the launching channel/author, with no SDK push', async () => {
            const journal = new FakeJournal();
            const registry = createTaskLaunchRegistry({ journal });
            const onWakeTurnSettled = jest.fn();
            const h = build({ journal, taskLaunches: registry, onWakeTurnSettled });
            await openWith(h);

            const launchEnvelope = discordEnvelope({ channelId: 'chan-C', authorId: 'user-U' });
            const discordResult = h.conductor.submit(launchEnvelope, { priority: 'human', requestingChannelId: 'chan-C' });
            await flush();

            // PostToolUse, mid-turn: an Agent launch (agentId 'agent-X', tool_use_id 'tool-T'),
            // recorded from the launching turn's own status().turn context.
            const launchingTurn = h.conductor.status().turn;
            expect(launchingTurn).toMatchObject({ kind: 'discord', channelId: 'chan-C', authorId: 'user-U' });
            registry.record({
                taskId: 'agent-X', toolUseId: 'tool-T', toolName: 'Agent', envelopeId: launchEnvelope.id, kind: 'discord', channelId: 'chan-C', authorId: 'user-U', launchedAt: new Date(h.clock.now()),
            });

            h.instances[0].emit(frames.resultSuccess({ result: 'LAUNCHED' }));
            await discordResult;
            await flush();

            expect(journal.byKind('task_launched')).toEqual([
                {
                    type: 'task_launched', at: expect.any(Date), taskId: 'agent-X', toolUseId: 'tool-T', toolName: 'Agent', envelopeId: launchEnvelope.id, kind: 'discord', channelId: 'chan-C', authorId: 'user-U',
                },
            ]);

            // UserPromptSubmit: the SDK wakes the session with the task-notification prompt.
            h.conductor.adoptWakeTurn({ taskId: 'agent-X', toolUseId: 'tool-T', summary: 'done' });
            h.instances[0].emit(frames.assistantText('done'));
            await flush();

            const submittedTaskEnvelope = journal.byKind('envelope_submitted').at(-1);
            expect(submittedTaskEnvelope).toEqual({
                type: 'envelope_submitted', at: expect.any(Date), envelopeId: expect.any(String), kind: 'task', channelId: 'chan-C',
            });
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'task', channelId: 'chan-C' });
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task', channelId: 'chan-C', authorId: 'user-U' });
            // Nothing was pushed to the SDK queue for the adopted turn — only the original discord submission's own prompt.
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            expect(registry.lookup({ taskId: 'agent-X', toolUseId: 'tool-T' })).toBeUndefined();

            h.instances[0].emit(frames.resultSuccess({ result: 'done' }));
            await flush();

            const taskEnvelopeId = submittedTaskEnvelope?.envelopeId ?? '';
            expect(journal.byKind('turn_completed').at(-1)).toEqual({
                type: 'turn_completed', at: expect.any(Date), envelopeId: taskEnvelopeId, kind: 'task', responseText: 'done',
            });
            expect(onWakeTurnSettled).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: taskEnvelopeId, kind: 'task', channelId: 'chan-C', authorId: 'user-U', text: 'done', hostPriority: 'wake', shouldQuery: true,
                }),
                expect.objectContaining({ response: 'done', isError: false })
            );
        });

        it('with no matching launch record, the adopted envelope carries no channelId/authorId', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'unknown-task', toolUseId: 'unknown-tool', summary: 'no record for this one' });
            h.instances[0].emit(frames.assistantText('no record for this one'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'task', channelId: undefined, authorId: undefined });
            const [entry] = h.journal.byKind('envelope_submitted');
            expect(entry).not.toHaveProperty('channelId');

            h.instances[0].emit(frames.resultSuccess({ result: 'no record for this one' }));
            await flush();
        });

        it('with no pendingWake, a spontaneous assistant frame still opens the bare notification turn unchanged', async () => {
            const h = build();
            await openWith(h);

            h.instances[0].emit(frames.assistantText('musing, unprompted'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'notification' });

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a single, fresh adoptWakeTurn() call (no prior pending wake) never logs the overwrite warning', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-only', toolUseId: 'tool-only', summary: 'only one' });

            expect(h.logger.warn).not.toHaveBeenCalled();

            h.instances[0].emit(frames.assistantText('only one'));
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: 'only one' }));
            await flush();
        });

        it('a second adoptWakeTurn() call before the first is consumed overwrites the pending wake and logs a warning naming both the previous and next wake', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-first', toolUseId: 'tool-first', summary: 'first' });
            h.conductor.adoptWakeTurn({ taskId: 'task-second', toolUseId: 'tool-second', summary: 'second' });

            expect(h.logger.warn).toHaveBeenCalledWith(
                {
                    previous: expect.objectContaining({ taskId: 'task-first', toolUseId: 'tool-first' }),
                    next:     { taskId: 'task-second', toolUseId: 'tool-second', summary: 'second' },
                },
                'adoptWakeTurn called again before the previous pending wake turn was consumed; overwriting'
            );

            h.instances[0].emit(frames.assistantText('second'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            h.instances[0].emit(frames.resultSuccess({ result: 'second' }));
            await flush();

            expect(h.journal.byKind('turn_completed').at(-1)?.responseText).toBe('second');
        });

        it('the overwritten wake is really gone: the replacement is the one adopted, and the next spontaneous turn afterwards is a bare notification turn rather than a second task turn', async () => {
            const forget = jest.fn();
            const h = build({ taskLaunches: { lookup: jest.fn(() => undefined), forget } });
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-first', toolUseId: 'tool-first', summary: 'first' });
            h.conductor.adoptWakeTurn({ taskId: 'task-second', toolUseId: 'tool-second', summary: 'second' });

            h.instances[0].emit(frames.assistantText('second'));
            await flush();
            expect(forget).toHaveBeenCalledTimes(1);
            expect(forget).toHaveBeenCalledWith('task-second');
            h.instances[0].emit(frames.resultSuccess({ result: 'second' }));
            await flush();

            h.instances[0].emit(frames.assistantText('an unrelated musing'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'notification' });
            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['task']);

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('replacing a pending wake removes only that wake: a peer message already queued ahead of it still takes the first turn', async () => {
            const h = build();
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptPeerTurn(envelope);
            h.conductor.adoptWakeTurn({ taskId: 'task-first', toolUseId: 'tool-first', summary: 'first' });
            h.conductor.adoptWakeTurn({ taskId: 'task-second', toolUseId: 'tool-second', summary: 'second' });

            h.instances[0].emit(frames.assistantText('answering the peer'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer' });
            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'peer', envelopeId: envelope.id });
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.instances[0].emit(frames.assistantText('the background result'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['peer', 'task']);

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a rejecting onWakeTurnSettled is caught and logged, never surfacing as an unhandled rejection', async () => {
            const onWakeTurnSettled = jest.fn(() => Promise.reject(new Error('delivery failed')));
            const h = build({ onWakeTurnSettled });
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'done' });
            h.instances[0].emit(frames.assistantText('done'));
            await flush();
            h.instances[0].emit(frames.resultSuccess({ result: 'done' }));
            await flush();

            expect(onWakeTurnSettled).toHaveBeenCalled();
            expect(h.logger.error).toHaveBeenCalledWith(
                { error: expect.any(Error) },
                'onWakeTurnSettled failed for an adopted wake turn'
            );
        });

        it('forgets the launch via taskLaunches.forget once adopted, looking it up by the pendingWake key', async () => {
            const lookup = jest.fn(() => undefined);
            const forget = jest.fn();
            const h = build({ taskLaunches: { lookup, forget } });
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'done' });
            h.instances[0].emit(frames.assistantText('done'));
            await flush();

            expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1', toolUseId: 'tool-1' }));
            expect(forget).toHaveBeenCalledWith('task-1');

            h.instances[0].emit(frames.resultSuccess({ result: 'done' }));
            await flush();
        });

        it('a human envelope arriving during an adopted task turn is enqueued and arms the human-wait escalation, rather than interrupting immediately like a same-channel discord turn', async () => {
            const h = build();
            await openWith(h);
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'working' });
            h.instances[0].emit(frames.assistantText('working'));
            await flush();

            const humanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(10_000);
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the injected resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            await humanPromise;
        });

        it('a transient is_error on an adopted wake turn fails the turn immediately rather than retrying — retrying would re-push the synthesized envelope\'s text into the SDK queue as a fresh, unframed user message, which beginAdoptedWakeTurn deliberately never does', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'partial result' });
            h.instances[0].emit(frames.assistantText('partial result'));
            await flush();

            const submittedTaskEnvelope = h.journal.byKind('envelope_submitted').at(-1);
            expect(submittedTaskEnvelope).toBeDefined();
            const taskEnvelopeId = submittedTaskEnvelope?.envelopeId ?? '';
            expect(turnPrompts(h.instances[0])).toHaveLength(0);

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 }));
            await flush();
            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();

            // No retry was scheduled — nothing was ever pushed to the SDK queue for this turn,
            // and it failed immediately rather than waiting on a backoff timer.
            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(h.journal.byKind('turn_failed')).toEqual([
                {
                    type: 'turn_failed', at: expect.any(Date), envelopeId: taskEnvelopeId, kind: 'task', error: 'overloaded',
                },
            ]);
        });

        it('a pendingWake that misses its own woken turn (e.g. raced by the awaitingTurnEnd window) expires after PENDING_WAKE_TTL_MS — a much LATER, unrelated spontaneous turn is not misattributed to it', async () => {
            const h = build();
            await openWith(h);

            // Reproduces the missed-adoption race the module doc for `pendingWake` describes:
            // adoptWakeTurn() fires while a PRIOR turn's own afterResult() is blocked inside
            // guard.onTurnEnd() (awaitingTurnEnd), so the wake's own first assistant frame is
            // dropped rather than adopted — exactly the pre-R2 behaviour for a racing frame.
            const deferredUsage = h.instances[0].deferContextUsage();
            const priorEnvelope = discordEnvelope();
            const priorResult = h.conductor.submit(priorEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'from the launch' });
            h.instances[0].emit(frames.assistantText('the wake\'s own first frame, racing the compaction decision'));
            await flush();
            expect(h.conductor.status().turn).toBeNull();

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            await priorResult;
            // Nothing else was queued — the guard decided against auto-compaction (10% < the
            // default 60% threshold) and the queue is otherwise empty, so the session is idle here.
            expect(h.conductor.status().turn).toBeNull();

            // Long afterward (well past PENDING_WAKE_TTL_MS), an entirely unrelated spontaneous
            // notification turn opens.
            h.clock.advance(60 * 60 * 1000);
            h.instances[0].emit(frames.assistantText('an unrelated later musing, hours afterward'));
            await flush();

            // Must NOT be adopted as the stale task wake (which would misdeliver this turn's
            // reply to the original launch's channel/author) — it opens an ordinary bare
            // notification turn instead, exactly as if no wake had ever been signalled.
            expect(h.conductor.status().turn).toMatchObject({ kind: 'notification' });
            expect(h.journal.byKind('envelope_submitted').some(e => e.kind === 'task')).toBe(false);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { pendingWake: expect.objectContaining({ taskId: 'task-1', toolUseId: 'tool-1' }) },
                'a pending wake turn expired (PENDING_WAKE_TTL_MS) before it could be adopted; a later spontaneous turn will not be misattributed to it'
            );

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('pins PENDING_WAKE_TTL_MS at exactly 5 minutes (a strict ">", not ">="): a frame arriving exactly AT the TTL, or 1ms before it, still adopts the pending wake; one arriving 1ms past it does not', async () => {
            const FIVE_MINUTES_MS = 5 * 60 * 1000;

            // Just under the TTL: still adopted as the task wake.
            const h1 = build();
            await openWith(h1);
            h1.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'still fresh' });
            h1.clock.advance(FIVE_MINUTES_MS - 1);
            h1.instances[0].emit(frames.assistantText('still fresh'));
            await flush();
            expect(h1.conductor.status().turn).toMatchObject({ kind: 'task' });
            h1.instances[0].emit(frames.resultSuccess());
            await flush();

            // Exactly AT the TTL (elapsed === PENDING_WAKE_TTL_MS): the check is a strict `>`, so
            // this must NOT yet be treated as expired.
            const hExact = build();
            await openWith(hExact);
            hExact.conductor.adoptWakeTurn({ taskId: 'task-exact', toolUseId: 'tool-exact', summary: 'right at the wire' });
            hExact.clock.advance(FIVE_MINUTES_MS);
            hExact.instances[0].emit(frames.assistantText('right at the wire'));
            await flush();
            expect(hExact.conductor.status().turn).toMatchObject({ kind: 'task' });
            expect(hExact.logger.warn).not.toHaveBeenCalled();
            hExact.instances[0].emit(frames.resultSuccess());
            await flush();

            // Just past the TTL: expired, falls back to a bare notification turn.
            const h2 = build();
            await openWith(h2);
            h2.conductor.adoptWakeTurn({ taskId: 'task-2', toolUseId: 'tool-2', summary: 'gone stale' });
            h2.clock.advance(FIVE_MINUTES_MS + 1);
            h2.instances[0].emit(frames.assistantText('gone stale'));
            await flush();
            expect(h2.conductor.status().turn).toMatchObject({ kind: 'notification' });
            h2.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('the pending-wake expiry check is ELAPSED time (clock.now() - setAt), not a raw sum of the two: a wake set only recently, but on a clock that has already run far ahead, is NOT treated as expired', async () => {
            const h = build();
            await openWith(h);

            // The clock is already far along (e.g. a long-lived session) BEFORE this wake is
            // ever set — with `+` in place of `-`, `clock.now() + pendingWake.setAt` would be
            // roughly double the current clock value here and blow past PENDING_WAKE_TTL_MS
            // even though barely any time has elapsed since the wake was set.
            h.clock.advance(1_000_000);
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'fresh despite a high absolute clock value' });
            h.clock.advance(1000); // well under PENDING_WAKE_TTL_MS
            h.instances[0].emit(frames.assistantText('fresh despite a high absolute clock value'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('an "other"-priority envelope arriving during a spontaneous notification turn never arms the human-wait escalation — only "human" priority does (isBackgroundKind\'s sibling condition on item.priority)', async () => {
            const h = build();
            await openWith(h);
            h.instances[0].emit(frames.assistantText('musing'));
            await flush();

            const otherEnvelope = catchupEnvelope();
            const otherPromise = h.conductor.submit(otherEnvelope, { priority: 'other' });
            await flush();

            h.clock.advance(60_000);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.instances[0].emit(frames.resultSuccess()); // closes the notification turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the queued 'other' turn
            const otherResult = await otherPromise;
            expect(otherResult.envelopeId).toBe(otherEnvelope.id);
        });

        it('a directly-submitted (non-adopted) task-kind turn starts with its human-wait escalation NOT yet armed: a human envelope during it still waits out humanWaitTargetMs rather than interrupting immediately', async () => {
            const h = build();
            await openWith(h);
            const directTaskEnvelope: Envelope = {
                id: 'direct-task-1', kind: 'task', text: 'direct task text', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0),
            };
            void h.conductor.submit(directTaskEnvelope, { priority: 'other' });
            await flush();

            const humanEnvelope = discordEnvelope();
            const humanPromise = h.conductor.submit(humanEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);
            h.clock.advance(DEFAULT_CONFIG.humanWaitTargetMs - 1);
            expect(h.instances[0].interruptCalls).toBe(0);
            h.clock.advance(1);
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            // No resume note is injected here (no partial work was ever streamed for this bare,
            // frameless task turn before it was interrupted), so the very next result frame
            // closes the human's own discord turn directly.
            h.instances[0].emit(frames.resultSuccess());
            const result = await humanPromise;
            expect(result.envelopeId).toBe(humanEnvelope.id);
        });

        it('an interrupted task turn injects a resume note ahead of the queued human envelope, exactly like an interrupted notification turn', async () => {
            const h = build();
            await openWith(h);
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'composing' });
            h.instances[0].emit(frames.assistantText('composing a reply'));
            await flush();

            const humanEnvelope = discordEnvelope();
            const humanPromise = h.conductor.submit(humanEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.clock.advance(10_000);
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['task', 'resume']);

            h.instances[0].emit(frames.resultSuccess()); // closes the resume turn
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['task', 'resume', 'discord']);

            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            const result = await humanPromise;
            expect(result.envelopeId).toBe(humanEnvelope.id);
        });

        it('when a mid-life crash strands an ADOPTED wake turn in flight and both the resume and fresh-open fallback fail, its deferred is rejected via buildWakeSettledDeferred\'s own reject path — logged, not left as an unhandled rejection', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'in flight when it crashed' });
            h.instances[0].emit(frames.assistantText('in flight when it crashed'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].fail(new Error('resume also failed'));
            await flush();
            h.instances[2].fail(new Error('fresh open also failed'));
            await flush();

            expect(h.logger.error).toHaveBeenCalledWith(
                { error: expect.any(Error) },
                'An adopted wake turn was rejected before it could settle'
            );
        });
    });

    describe('adoptPeerTurn() (session-peers block 2: a peer session\'s cross-session message opens its own turn)', () => {
        it('unit-level end-to-end: the peer envelope opens a peer-kind turn on the next spontaneous assistant frame, journalled and ledgered, with no SDK push', async () => {
            const h = build();
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptPeerTurn(envelope);
            h.instances[0].emit(frames.assistantText('on it'));
            await flush();

            expect(h.journal.byKind('envelope_submitted')).toEqual([
                { type: 'envelope_submitted', at: expect.any(Date), envelopeId: envelope.id, kind: 'peer' },
            ]);
            expect(h.journal.byKind('envelope_submitted')[0]).not.toHaveProperty('channelId');
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'peer' });
            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer', channelId: undefined, authorId: undefined });
            // The SDK already started this turn from the raw <cross-session-message> prompt, so
            // the host must never push the envelope's own text on top of it.
            expect(turnPrompts(h.instances[0])).toHaveLength(0);

            h.instances[0].emit(frames.resultSuccess({ result: 'replied' }));
            await flush();

            expect(h.journal.byKind('turn_completed')).toEqual([
                { type: 'turn_completed', at: expect.any(Date), envelopeId: envelope.id, kind: 'peer', responseText: 'replied' },
            ]);
            expect(h.conductor.status().turn).toBeNull();
        });

        it('rejects an envelope that is not peer-kind — the adopted turn IS the envelope, so a mis-kinded one would journal and ledger the wrong kind', async () => {
            const h = build();
            await openWith(h);

            expect(() => {
                h.conductor.adoptPeerTurn(discordEnvelope());
            }).toThrow('Invariant violated in conductor.adoptPeerTurn: called with a non peer-kind envelope');
            h.instances[0].emit(frames.assistantText('musing'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'notification' });
            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a single, fresh adoptPeerTurn() call (no prior pending peer) never logs the overwrite warning', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptPeerTurn(peerEnvelope());

            expect(h.logger.warn).not.toHaveBeenCalled();

            h.instances[0].emit(frames.assistantText('ok'));
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a second adoptPeerTurn() before the first is consumed QUEUES it rather than overwriting: each message opens its own turn, oldest first, with no warning', async () => {
            const h = build();
            await openWith(h);

            const first = peerEnvelope();
            const second = peerEnvelope();
            h.conductor.adoptPeerTurn(first);
            h.conductor.adoptPeerTurn(second);

            expect(h.logger.warn).not.toHaveBeenCalled();

            h.instances[0].emit(frames.assistantText('answering the first'));
            await flush();
            expect(h.journal.byKind('envelope_submitted').map(e => e.envelopeId)).toEqual([first.id]);
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.instances[0].emit(frames.assistantText('answering the second'));
            await flush();
            expect(h.journal.byKind('envelope_submitted').map(e => e.envelopeId)).toEqual([first.id, second.id]);

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('caps the pending peer queue, dropping the OLDEST unconsumed message with exactly one warning; only peers count against the cap, and the survivors keep their arrival order behind the earlier wake', async () => {
            const h = build();
            await openWith(h);

            // A pending wake shares the one ordered queue but is not a peer message, so it must
            // not count against the peer cap.
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'background work finished' });
            // One more than the cap, so exactly one message is dropped.
            const envelopes = Array.from({ length: 9 }, () => peerEnvelope());
            for(const envelope of envelopes) {
                h.conductor.adoptPeerTurn(envelope);
            }

            expect(h.logger.warn).toHaveBeenCalledTimes(1);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { dropped: envelopes[0]?.id, next: envelopes[8]?.id, max: 8 },
                'the pending peer queue is full; dropping the oldest peer message that never got a turn of its own'
            );

            // One more: the queue is still exactly at the cap, so the next-oldest goes this time.
            const tenth = peerEnvelope();
            h.conductor.adoptPeerTurn(tenth);

            expect(h.logger.warn).toHaveBeenCalledTimes(2);
            expect(h.logger.warn).toHaveBeenLastCalledWith(
                { dropped: envelopes[1]?.id, next: tenth.id, max: 8 },
                'the pending peer queue is full; dropping the oldest peer message that never got a turn of its own'
            );

            // The wake arrived before every peer, so it still takes the first spontaneous turn.
            h.instances[0].emit(frames.assistantText('the background result'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            // Then the survivors, in arrival order, starting from the oldest one still queued.
            h.instances[0].emit(frames.assistantText('answering the oldest survivor'));
            await flush();
            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'peer', envelopeId: envelopes[2]?.id });
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.instances[0].emit(frames.assistantText('answering the next one'));
            await flush();
            expect(h.journal.byKind('envelope_submitted').at(-1)).toMatchObject({ kind: 'peer', envelopeId: envelopes[3]?.id });

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('serves pending adoptions strictly FIFO: a task wake adopted BEFORE a peer message keeps the first spontaneous turn — and its own deferred is the one that settles, so the background work is still delivered', async () => {
            const onWakeTurnSettled = jest.fn();
            const h = build({ onWakeTurnSettled });
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'background work finished' });
            h.conductor.adoptPeerTurn(envelope);

            h.instances[0].emit(frames.assistantText('reporting the background result'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            h.instances[0].emit(frames.resultSuccess({ result: 'reported' }));
            await flush();

            // The wake's buildWakeSettledDeferred ran: a peer-labelled turn here would have used
            // internalDeferred() instead and lost the background work's result entirely.
            expect(onWakeTurnSettled).toHaveBeenCalledTimes(1);
            expect(onWakeTurnSettled).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'task', text: 'background work finished' }),
                expect.objectContaining({ response: 'reported', isError: false })
            );

            h.instances[0].emit(frames.assistantText('now answering the peer'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer' });
            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['task', 'peer']);

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('serves pending adoptions strictly FIFO the other way round too: a peer message adopted BEFORE a task wake keeps the first turn, and the wake takes the next one with its own deferred', async () => {
            const onWakeTurnSettled = jest.fn();
            const h = build({ onWakeTurnSettled });
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptPeerTurn(envelope);
            h.conductor.adoptWakeTurn({ taskId: 'task-1', toolUseId: 'tool-1', summary: 'background work finished' });

            h.instances[0].emit(frames.assistantText('answering the peer'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer' });
            expect(h.journal.byKind('envelope_submitted').map(e => e.envelopeId)).toEqual([envelope.id]);
            expect(onWakeTurnSettled).not.toHaveBeenCalled();
            h.instances[0].emit(frames.resultSuccess({ result: 'answered' }));
            await flush();

            h.instances[0].emit(frames.assistantText('now the background result'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['peer', 'task']);

            h.instances[0].emit(frames.resultSuccess({ result: 'reported' }));
            await flush();

            expect(onWakeTurnSettled).toHaveBeenCalledWith(
                expect.objectContaining({ kind: 'task', text: 'background work finished' }),
                expect.objectContaining({ response: 'reported', isError: false })
            );
        });

        it('a pendingPeer that misses its own turn expires after PENDING_WAKE_TTL_MS — a much LATER, unrelated spontaneous turn is not misattributed to it', async () => {
            const h = build();
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptPeerTurn(envelope);
            h.clock.advance(5 * 60 * 1000 + 1);
            h.instances[0].emit(frames.assistantText('an unrelated later musing'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'notification' });
            expect(h.journal.byKind('envelope_submitted')).toEqual([]);
            expect(h.logger.warn).toHaveBeenCalledWith(
                { envelopeId: envelope.id },
                'a pending peer message expired (PENDING_WAKE_TTL_MS) before it could be adopted; a later spontaneous turn will not be misattributed to it'
            );

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('the pending-peer expiry shares the wake TTL\'s strict ">" boundary: a frame arriving exactly AT 5 minutes still adopts the peer message', async () => {
            const h = build();
            await openWith(h);

            h.conductor.adoptPeerTurn(peerEnvelope());
            h.clock.advance(5 * 60 * 1000);
            h.instances[0].emit(frames.assistantText('right at the wire'));
            await flush();

            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer' });
            expect(h.logger.warn).not.toHaveBeenCalled();

            h.instances[0].emit(frames.resultSuccess());
            await flush();
        });

        it('a human envelope arriving during an adopted peer turn is enqueued and arms the human-wait escalation, rather than interrupting immediately like a same-channel discord turn', async () => {
            const h = build();
            await openWith(h);
            h.conductor.adoptPeerTurn(peerEnvelope());
            h.instances[0].emit(frames.assistantText('answering the peer'));
            await flush();

            const humanPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(10_000);
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the injected resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            await humanPromise;
        });

        it('an interrupted peer turn injects a resume note ahead of the queued human envelope, exactly like an interrupted task turn', async () => {
            const h = build();
            await openWith(h);
            h.conductor.adoptPeerTurn(peerEnvelope());
            h.instances[0].emit(frames.assistantText('composing a reply to the peer'));
            await flush();

            const humanEnvelope = discordEnvelope();
            const humanPromise = h.conductor.submit(humanEnvelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.clock.advance(10_000);
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();

            expect(h.journal.byKind('envelope_submitted').map(e => e.kind)).toEqual(['peer', 'resume']);

            h.instances[0].emit(frames.resultSuccess()); // closes the resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            const result = await humanPromise;
            expect(result.envelopeId).toBe(humanEnvelope.id);
        });

        it('a transient is_error on an adopted peer turn fails the turn immediately rather than retrying — a retry would push the envelope\'s own rendered text into the SDK queue as a second, unframed user message', async () => {
            const h = build();
            await openWith(h);

            const envelope = peerEnvelope();
            h.conductor.adoptPeerTurn(envelope);
            h.instances[0].emit(frames.assistantText('partial'));
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 }));
            await flush();
            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(h.journal.byKind('turn_failed')).toEqual([
                { type: 'turn_failed', at: expect.any(Date), envelopeId: envelope.id, kind: 'peer', error: 'overloaded' },
            ]);
        });
    });

    describe('requestReopen()', () => {
        it('late frames and closure from a discarded handle cannot steal or reopen the replacement session', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.conductor.requestReopen('rotate identity');
            await flush();
            h.instances[1].emit(frames.init('sess-2'));
            await flush();

            h.instances[0].emit(frames.init('stale-session-id'));
            await flush();
            h.instances[0].fail(new Error('discarded reader finally stopped'));
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.conductor.status().sessionId).toBe('sess-2');
            await h.conductor.shutdown({ turnWaitMs: 1000, deadlineMs: 2000 });
            expect(h.instances[1].closeCalls).toBe(1);
        });

        it('closes and resumes the live session as soon as the conductor is idle', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.instances[0].closeCalls).toBe(1);
            expect(h.instances[1].receivedParams?.options.resume).toBe('sess-1');
        });

        it('journals the resumed replacement as outcome resumed with cause requested_reopen', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.journal.byKind('session_opened').at(-1)).toEqual(
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-1', outcome: 'resumed', cause: 'requested_reopen' }
            );
        });

        it('pushes a boot handshake naming the reason, before any frame is awaited', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();

            const [handshake] = h.instances[1].consumedPrompts;
            expect(JSON.stringify(handshake.message)).toContain('[BOOT] Session reopened');
            expect(JSON.stringify(handshake.message)).toContain('an identity change');
        });

        it('journals session_reopen_requested with the role and reason, at request time', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');

            // Journaled synchronously, before the reopen has begun: a request deferred behind a
            // running turn must still be visible if the process dies before the idle point.
            expect(h.journal.byKind('session_reopen_requested')).toEqual([
                { type: 'session_reopen_requested', at: expect.any(Date), role: 'conversation', reason: 'an identity change' },
            ]);
        });

        it('logs the reason at info when the reopen actually starts', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();

            expect(h.logger.info).toHaveBeenCalledWith({ reason: 'an identity change' }, 'Reopening the session on request');
        });

        it('is a no-op once shutdown has begun — neither journaled nor acted on', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            h.conductor.requestReopen('an identity change');
            await flush();

            expect(h.journal.byKind('session_reopen_requested')).toEqual([]);
            expect(h.instances).toHaveLength(1);
        });

        it('a request made before open() is satisfied by the open itself, not by a second session', async () => {
            const h = build();

            h.conductor.requestReopen('an identity change');
            await openWith(h, 'sess-1');
            await flush();

            // The request is recorded (it may outlive the process) but the open that followed it
            // already built its options from the current prompt, so nothing is reopened.
            expect(h.journal.byKind('session_reopen_requested')).toHaveLength(1);
            expect(h.instances).toHaveLength(1);
            expect(h.logger.debug).toHaveBeenCalledWith(
                { reason: 'an identity change' }, 'Dropping a requested reopen an intervening open already satisfied'
            );
        });

        it('a request made while open() is in flight, after its options were built, reopens once the open completes', async () => {
            const h = build();
            const openPromise = h.conductor.open();
            await flush();
            // buildOptions has already run for instance 0 — this request cannot be satisfied by it.
            h.conductor.requestReopen('an identity change');

            h.instances[0].emit(frames.init('sess-1'));
            await openPromise;
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.instances[1].receivedParams?.options.resume).toBe('sess-1');
        });

        it('a request made while a RESUME open() is in flight, after its options were built, reopens once that resume completes', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            const openPromise = h.conductor.open();
            await flush();
            // buildOptions has already run for instance 0 (the resume attempt) — this request
            // cannot be satisfied by it.
            h.conductor.requestReopen('an identity change');

            h.instances[0].emit(frames.init('sess-old'));
            await openPromise;
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.instances[1].receivedParams?.options.resume).toBe('sess-old');
        });

        it('a request made while a crash reopen is in flight is applied after it', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.instances).toHaveLength(2);

            // instances[1] exists, so its options were built BEFORE this request.
            h.conductor.requestReopen('an identity change');
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.instances).toHaveLength(3);
            expect(h.instances[1].closeCalls).toBe(1);
        });

        it('a request made before a crash reopen is dropped by it — the replacement already carries the new prompt', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.conductor.requestReopen('an identity change');
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.instances).toHaveLength(2);
        });

        it('the turn a crash re-queued still runs once the crash has dropped the pending request', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.conductor.requestReopen('an identity change');
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            // Dropping the now-redundant request must not also abandon the queue the crash
            // reopen just refilled: the interrupted turn is re-queued and has to be started.
            expect(turnPrompts(h.instances[1])).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            await expect(resultPromise).resolves.toEqual(expect.objectContaining({ envelopeId: envelope.id, isError: false }));
        });

        it('waits for a running turn to end before reopening', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.conductor.requestReopen('an identity change');
            await flush();
            expect(h.instances).toHaveLength(1);

            h.instances[0].emit(frames.resultSuccess());
            await flush();

            expect(h.instances).toHaveLength(2);
        });

        it('does not start a queued turn while a reopen is owed; the queued envelope plays on the replacement', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const queued = h.conductor.submit(discordEnvelope(), { priority: 'other' });
            await flush();

            h.conductor.requestReopen('an identity change');
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            // The queued envelope must NOT have been started on the dying session.
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            expect(h.instances).toHaveLength(2);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(turnPrompts(h.instances[1])).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            await expect(queued).resolves.toEqual(expect.objectContaining({ isError: false }));
        });

        it('holds the reopen while the turn-end compaction check is still outstanding', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const deferredUsage = h.instances[0].deferContextUsage();
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await flush();
            h.conductor.requestReopen('an identity change');
            await flush();

            // currentTurn is already null, but guard.onTurnEnd() has not resolved — a /compact
            // turn can still be born in this window, so the reopen must wait it out.
            expect(h.instances).toHaveLength(1);

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();

            expect(h.instances).toHaveLength(2);
        });

        it('starts no turn for an envelope submitted while the reopen is owed but still deferred', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const deferredUsage = h.instances[0].deferContextUsage();
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess());
            await flush();
            h.conductor.requestReopen('an identity change');
            // currentTurn is null and the reopen has not started (guard.onTurnEnd is still
            // outstanding), so this submit reaches processQueue with the reopen merely owed.
            const queued = h.conductor.submit(discordEnvelope(), { priority: 'other' });
            await flush();

            expect(turnPrompts(h.instances[0])).toHaveLength(1);

            deferredUsage.resolve(frames.contextUsage({ percentage: 10 }));
            await flush();
            expect(h.instances).toHaveLength(2);
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            // Held through the whole window, then played on the replacement session.
            expect(turnPrompts(h.instances[1])).toHaveLength(1);
            h.instances[1].emit(frames.resultSuccess());
            await expect(queued).resolves.toEqual(expect.objectContaining({ isError: false }));
        });

        it('an envelope submitted while the requested reopen is in flight is held, not routed into the orphaned queue', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            expect(h.instances).toHaveLength(2);

            const pendingSubmit = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(0);
            expect(turnPrompts(h.instances[1])).toHaveLength(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(turnPrompts(h.instances[1])).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            await expect(pendingSubmit).resolves.toEqual(expect.objectContaining({ isError: false }));
        });

        it('falls back to a fresh session when the resume attempt fails', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            h.instances[1].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(h.instances).toHaveLength(3);
            h.instances[2].emit(frames.init('sess-2'));
            await flush();

            expect(h.journal.byKind('session_opened').at(-1)).toEqual(
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-2', outcome: 'resume_fallback', cause: 'requested_reopen' }
            );
        });

        it('does not reopen a second time once the requested reopen has completed', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();

            expect(h.instances).toHaveLength(2);
        });

        it('wipes the ledger task list on the replacement session, exactly as a crash reopen does', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'background work' }));
            await flush();
            expect(h.ledgerStore.get().tasks).toHaveLength(1);

            h.conductor.requestReopen('an identity change');
            // The fixture's task is backgrounded, so the reopen first waits it out (#97).
            h.clock.advance(DEFAULT_CONFIG.reopenTaskWaitMs);
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.ledgerStore.get().tasks).toHaveLength(0);
        });

        it('replays an accumulate-only envelope the dying session never read onto the replacement', async () => {
            // Instance 0 never reads its prompt iterable, modelling an SDK that has not yet
            // drained what the host queued; instance 1 reads normally so the replay is visible.
            const h = build({}, { drainPrompts: index => index > 0 });
            await openWith(h, 'sess-1');

            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'carry me over' }))).toBe(true);
            h.conductor.requestReopen('an identity change');
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            // A second drain pass: the carried messages are pushed only after finishOpen's own
            // await chain settles, and each one costs the capture loop a couple of ticks.
            await flush();

            expect(JSON.stringify(h.instances[1].consumedPrompts)).toContain('carry me over');
        });

        it('buffers an append made during the reopen and delivers it to the replacement', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            expect(h.instances).toHaveLength(2);

            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered during reopen' }))).toBe(true);
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(JSON.stringify(h.instances[1].consumedPrompts)).toContain('buffered during reopen');
        });

        it('a crash reopen also carries over what the dead queue never delivered', async () => {
            const h = build({}, { drainPrompts: index => index > 0 });
            await openWith(h, 'sess-1');
            h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'crash carry-over' }));

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();

            expect(JSON.stringify(h.instances[1].consumedPrompts)).toContain('crash carry-over');
        });

        it('shutting down during an in-flight requested reopen closes the replacement rather than leaking it', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            expect(h.instances).toHaveLength(2);

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            h.clock.runAll();
            await shutdownPromise;

            expect(h.instances[1].closeCalls).toBeGreaterThanOrEqual(1);
            expect(turnPrompts(h.instances[1])).toHaveLength(0);
            expect(h.instances).toHaveLength(2);
        });

        it('shutdown awaits the reopen a completing reopen started, not the one it replaced', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            // Crash reopen A. instances[1]'s options were built as part of starting it, so the
            // request below cannot be satisfied by it and becomes reopen B the moment A finishes.
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            expect(h.instances).toHaveLength(2);

            h.conductor.requestReopen('an identity change');
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            // B is in flight: its handle exists but has emitted no init frame yet.
            expect(h.instances).toHaveLength(3);
            expect(h.instances[2].closeCalls).toBe(0);

            let finished = false;
            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 }).then(() => {
                finished = true;
                return undefined;
            });
            await flush();

            // A's completion must not have erased B's tracking promise: shutdown has to wait for
            // the replacement child B is spawning, or it exits leaving it orphaned.
            expect(finished).toBe(false);

            h.instances[2].emit(frames.init('sess-1'));
            await flush();
            h.clock.runAll();
            await shutdownPromise;

            expect(finished).toBe(true);
            expect(h.instances[2].closeCalls).toBeGreaterThanOrEqual(1);
        });

        it('a replacement that lands after shutdown gave up at its deadline is closed by the reopen itself, and its buffered input dropped', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            expect(h.instances).toHaveLength(2);

            // Buffered while the reopen is in flight: the replacement it was destined for is
            // about to be thrown away, so it must never be pushed into a session nobody reads.
            expect(h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered during reopen' }))).toBe(true);

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();
            // The deadline wins the race while the replacement is still opening, so shutdown's
            // own final close runs against a cleared currentHandleRef and closes nothing: the
            // freshly opened child is the reopen's to dispose of, or it outlives the process.
            h.clock.advance(120_000);
            await shutdownPromise;
            expect(h.instances[1].closeCalls).toBe(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();

            expect(h.instances[1].closeCalls).toBe(1);
            expect(h.instances).toHaveLength(2);
            expect(turnPrompts(h.instances[1])).toHaveLength(0);
            expect(JSON.stringify(h.instances[1].consumedPrompts)).not.toContain('buffered during reopen');
        });
    });

    describe('appendWithoutTurn() acceptance', () => {
        it('returns true when the envelope reached the live queue', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            expect(h.conductor.appendWithoutTurn(notificationEnvelope())).toBe(true);
        });

        it('returns false before open() has assigned a queue', () => {
            const h = build();

            expect(h.conductor.appendWithoutTurn(notificationEnvelope())).toBe(false);
        });

        it('returns false once shutting down', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });

            expect(h.conductor.appendWithoutTurn(notificationEnvelope())).toBe(false);
        });

        it('returns false once shutting down even while a reopen is still in flight', async () => {
            const h = build();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            // The replacement has emitted no init frame, so the reopen — and the append buffer it
            // owns — is still live when shutdown begins.
            expect(h.instances).toHaveLength(2);

            const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await flush();

            // Buffering here would report the envelope as accepted (burning the caller's dedupe
            // key) and then discard it with the rest of the buffer as the reopen unwinds.
            expect(h.conductor.appendWithoutTurn(notificationEnvelope())).toBe(false);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            h.clock.runAll();
            await shutdownPromise;

            expect(turnPrompts(h.instances[1])).toHaveLength(0);
        });
    });

    describe('mutation regression behavior contracts', () => {
        it('tracks an empty SDK task id through completion and session-loss lifecycle events', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.instances[0].emit(frames.taskStarted({ task_id: '', description: 'empty id task' }));
            await flush();
            expect(h.journal.byKind('task_started')).toEqual([
                { type: 'task_started', at: expect.any(Date), taskId: '', description: 'empty id task' },
            ]);

            h.instances[0].emit(frames.taskStarted({ task_id: 'other-task', description: 'another task' }));
            await flush();
            expect(h.journal.byKind('task_finished')).toEqual([]);

            h.instances[0].emit(frames.taskNotification('completed', { task_id: '' }));
            await flush();
            expect(h.journal.byKind('task_finished')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: '', description: 'empty id task', outcome: 'completed' },
            ]);

            h.instances[0].emit(frames.taskStarted({ task_id: '', description: 'lost empty id task' }));
            await flush();
            h.ledgerStore.dispatch({ type: 'task_lost', taskId: '', at: new Date(h.clock.now()) });
            expect(h.journal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: '', description: 'lost empty id task' },
            ]);

            h.instances[0].emit(frames.taskStarted({ task_id: '', description: 'crash-lost empty id task' }));
            await flush();
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(h.journal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: '', description: 'lost empty id task' },
                { type: 'task_lost', at: expect.any(Date), taskId: 'other-task', description: 'another task' },
                { type: 'task_lost', at: expect.any(Date), taskId: '', description: 'crash-lost empty id task' },
            ]);
        });

        it('gives a compact turn exactly two attempts when maxAttempts is two', async () => {
            const classifyError = (): ErrorClassification => ({ category: 'transient', retryAfterMs: 0, message: 'retry compact' });
            const h = build({ classifyError });
            await openWith(h);
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
            const initial = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            await initial;
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('compact');
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'compact overloaded', api_error_status: 529 }));
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(3);
            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'compact still overloaded', api_error_status: 529 }));
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(3);
        });

        it('gives an injected background resume turn exactly two attempts', async () => {
            const classifyError = (): ErrorClassification => ({ category: 'transient', retryAfterMs: 0, message: 'retry resume' });
            const h = build({ classifyError });
            await openWith(h);
            h.instances[0].emit(frames.assistantText('meaningful partial work'));
            await flush();
            void h.conductor.interruptCurrent({ reason: 'test background interruption' });
            await flush();
            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            expect(h.conductor.status().turn?.kind).toBe('resume');

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'resume overloaded', api_error_status: 529 }));
            await flush();
            expect(h.journal.byKind('envelope_submitted').map(entry => entry.kind)).toEqual(['resume', 'resume']);
            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'resume still overloaded', api_error_status: 529 }));
            await flush();
            expect(h.journal.byKind('envelope_submitted').map(entry => entry.kind)).toEqual(['resume', 'resume']);
        });

        it('honors a one millisecond retryAfter delay', async () => {
            const classifyError = (): ErrorClassification => ({ category: 'rate_limited', retryAfterMs: 1, message: 'brief limit' });
            const h = build({ classifyError });
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'limited', api_error_status: 429 }));
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(1);
            h.clock.advance(1);
            await flush();
            expect(turnPrompts(h.instances[0])).toHaveLength(2);
        });

        it('timestamps a newly adopted peer at the current clock time', async () => {
            const h = build();
            await openWith(h);
            h.clock.advance(10 * 60_000);
            const peer = peerEnvelope();
            h.conductor.adoptPeerTurn(peer);
            h.instances[0].emit(frames.assistantText('peer response'));
            await flush();
            expect(h.conductor.status().turn).toMatchObject({ kind: 'peer', envelopeId: peer.id });
        });

        it('preserves FIFO order for two appends buffered during reopen', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.conductor.requestReopen('new identity');
            await flush();
            h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered first' }));
            h.conductor.appendWithoutTurn(notificationEnvelope({ text: 'buffered second' }));
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            await flush();
            const prompts = JSON.stringify(turnPrompts(h.instances[1]));
            expect(prompts.indexOf('buffered first')).toBeLessThan(prompts.indexOf('buffered second'));
        });

        it('rejects every queued submit when shutdown begins', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope({ channelId: 'active' }), { priority: 'human', requestingChannelId: 'active' });
            await flush();
            const queuedB = h.conductor.submit(discordEnvelope({ channelId: 'B' }), { priority: 'other' });
            const queuedC = h.conductor.submit(discordEnvelope({ channelId: 'C' }), { priority: 'other' });
            await flush();
            void h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
            await expect(Promise.all([queuedB, queuedC])).rejects.toThrow('shutting down');
            expect(h.conductor.status().queueLength).toBe(0);
        });

        it('requeues a crashed active turn ahead of an already queued turn', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const active = discordEnvelope({ text: 'active A' });
            const queued = discordEnvelope({ text: 'queued B' });
            const activeResult = h.conductor.submit(active, { priority: 'human', requestingChannelId: 'A' });
            await flush();
            const queuedResult = h.conductor.submit(queued, { priority: 'other' });
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(JSON.stringify(turnPrompts(h.instances[1])[0])).toContain('active A');
            h.instances[1].emit(frames.resultSuccess());
            await activeResult;
            await flush();
            expect(JSON.stringify(turnPrompts(h.instances[1])[1])).toContain('queued B');
            h.instances[1].emit(frames.resultSuccess());
            await queuedResult;
        });

        it('keeps open pending until the fresh session id is persisted and propagates persistence failure', async () => {
            const saveGate = deferred<void>();
            void saveGate.promise.catch(() => {});
            const resumeStore = {
                load: () => Promise.resolve(undefined),
                save: () => saveGate.promise,
            };
            const h = build({ resumeStore });
            let settled = false;
            const opening = h.conductor.open().finally(() => {
                settled = true;
            });
            await flush();
            h.instances[0].emit(frames.init('sess-1'));
            await flush();
            expect(settled).toBe(false);
            saveGate.resolve();
            await opening;

            const rejection = deferred<void>();
            void rejection.promise.catch(() => {});
            const failed = build({ resumeStore: { load: () => Promise.resolve(undefined), save: () => rejection.promise } });
            const failedOpen = failed.conductor.open();
            await flush();
            failed.instances[0].emit(frames.init('sess-2'));
            rejection.reject(new Error('save failed'));
            await expect(failedOpen).rejects.toThrow('save failed');
        });

        it('withdrawing one queued submit leaves the following submit runnable', async () => {
            const h = build();
            await openWith(h);
            const active = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'A' });
            await flush();
            const controller = new AbortController();
            const withdrawn = h.conductor.submit(discordEnvelope({ text: 'withdraw B' }), { priority: 'other', signal: controller.signal });
            const following = h.conductor.submit(discordEnvelope({ text: 'run C' }), { priority: 'other' });
            controller.abort();
            await expect(withdrawn).resolves.toMatchObject({ outcome: 'withdrawn' });
            h.instances[0].emit(frames.resultSuccess());
            await active;
            await flush();
            expect(JSON.stringify(turnPrompts(h.instances[0]).at(-1))).toContain('run C');
            h.instances[0].emit(frames.resultSuccess());
            await following;
        });

        it('does not resolve delivery or mark it delivered before journal flush settles', async () => {
            const h = build();
            await openWith(h);
            const flushGate = deferred<void>();
            const flushSpy = jest.spyOn(h.journal, 'flush').mockImplementation(() => flushGate.promise);
            let settled = false;
            const firstSend = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-1'] }));
            const delivery = h.conductor.deliver('deferred-env', firstSend).finally(() => {
                settled = true;
            });
            await flush();
            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect(settled).toBe(false);
            flushGate.resolve();
            await expect(delivery).resolves.toEqual({ outcome: 'committed', disposition: 'sent' });
            const secondSend = jest.fn(() => Promise.resolve({ kind: 'committed' as const, disposition: 'sent' as const, channelId: 'chan-1', messageIds: ['msg-2'] }));
            await expect(h.conductor.deliver('deferred-env', secondSend)).resolves.toEqual({ outcome: 'already-committed' });
            expect(secondSend).not.toHaveBeenCalled();
        });

        it('waits for the real interrupt call after shutdown turn-wait elapses', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            let settled = false;
            const shutdown = h.conductor.shutdown({ turnWaitMs: 1, deadlineMs: 120_000 }).finally(() => {
                settled = true;
            });
            await flush();
            h.clock.advance(1);
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);
            expect(h.journal.flushCount).toBe(0);
            expect(h.instances[0].closeCalls).toBe(0);
            expect(settled).toBe(false);
            h.instances[0].resolveInterrupt();
            await shutdown;
            expect(h.journal.flushCount).toBe(1);
        });
    });

    describe('reopen cause and handshake (#62)', () => {
        /** The text of the `[BOOT]` handshake an instance consumed first. */
        function handshakeTextOf(instance: FakeQuery): string {
            const content = instance.consumedPrompts[0]?.message.content;
            return Array.isArray(content) ? content.map(block => (block.type === 'text' ? block.text : '')).join('') : String(content);
        }

        /** Builds a harness whose buildOptions is a spy echoing `resume` like the default one. */
        function buildWithOptionsSpy(): Harness & { buildOptions: ReturnType<typeof jest.fn<CreateConductorParams['buildOptions']>> } {
            const buildOptions = jest.fn<CreateConductorParams['buildOptions']>(resume => (resume === undefined ? {} : { resume }));
            return { ...build({ buildOptions }), buildOptions };
        }

        const RESUMED_CONTINUITY = 'This same conversation was resumed, so this was not an offline gap: messages waiting for you were kept and will still be delivered, and no conversation was lost.';
        const FALLBACK_CONTINUITY = 'The previous conversation could not be resumed, so this is a new session transcript, and earlier context from it is not available to you. It was still not an offline gap: messages waiting for you were kept and will still be delivered.';
        const FALLBACK_CONTINUITY_RESEEDED = 'The previous conversation could not be resumed, so this is a new session transcript. Your working memory is re-seeded below. It was still not an offline gap: messages waiting for you were kept and will still be delivered.';
        const TASKS_INTRO = 'Background tasks you had started in the previous session process were still running when it ended. They may have been stopped, or may still be running with no way to report back to you — either way, do not wait for a result from them:';
        const TASKS_ADVICE = 'If you still need a result from one of them, check whether it finished and re-run it if needed. If one finished just before the reopen, its result may already be in the transcript.';
        const HANDSHAKE_SUFFIX = 'Host handshake — no reply expected.';
        const CRASH_OPENING = 'because the previous session process ended unexpectedly (it crashed or was killed). The host process kept running throughout; only the session process was replaced.';
        const REQUESTED_OPENING = 'because the host deliberately closed the previous session process to apply an identity change. The host process kept running throughout; only the session process was replaced.';

        /** Starts two background tasks and one foreground task inside a running turn on instance 0. */
        async function startTasksInTurn(h: Harness): Promise<void> {
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-bg-1', tool_use_id: 'tool-bg-1', description: 'index the archive', is_backgrounded: true }));
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-fg', tool_use_id: 'tool-fg', description: 'foreground helper', is_backgrounded: false }));
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-bg-2', tool_use_id: 'tool-bg-2', description: 'summarise the inbox', is_backgrounded: true }));
            await flush();
        }

        /** Starts exactly one background task inside a running turn on instance 0. */
        async function startOneTaskInTurn(h: Harness): Promise<void> {
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            h.instances[0].emit(frames.taskStarted({ task_id: 'task-bg-1', tool_use_id: 'tool-bg-1', description: 'index the archive', is_backgrounded: true }));
            await flush();
        }

        it('a boot open with no stored id builds its options with (undefined, boot)', async () => {
            const h = buildWithOptionsSpy();

            await openWith(h, 'sess-1');

            expect(h.buildOptions.mock.calls).toEqual([[undefined, 'boot']]);
        });

        it('a boot open whose resume fails builds both attempts with cause boot', async () => {
            const h = buildWithOptionsSpy();
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();
            h.instances[1].emit(frames.init('sess-new'));
            await openPromise;

            expect(h.buildOptions.mock.calls).toEqual([['sess-old', 'boot'], [undefined, 'boot']]);
        });

        it('a crash reopen builds the resume attempt and its fresh fallback with cause crash_reopen', async () => {
            const h = buildWithOptionsSpy();
            await openWith(h, 'sess-1');

            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].fail(new Error('resume also failed'));
            await flush();

            expect(h.buildOptions.mock.calls).toEqual([[undefined, 'boot'], ['sess-1', 'crash_reopen'], [undefined, 'crash_reopen']]);
        });

        it('a requested reopen builds the resume attempt and its fresh fallback with cause requested_reopen', async () => {
            const h = buildWithOptionsSpy();
            await openWith(h, 'sess-1');

            h.conductor.requestReopen('an identity change');
            await flush();
            h.instances[1].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(h.buildOptions.mock.calls).toEqual([[undefined, 'boot'], ['sess-1', 'requested_reopen'], [undefined, 'requested_reopen']]);
        });

        it('a crash reopen with no background task running pushes the exact handshake with no tasks paragraph', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            h.clock.advance(5000);

            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            expect(handshakeTextOf(h.instances[1])).toBe([
                `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                RESUMED_CONTINUITY,
                HANDSHAKE_SUFFIX,
            ].join('\n\n'));
        });

        it('a crash reopen with exactly one background task running pushes the tasks paragraph with a single task line', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await startOneTaskInTurn(h);
            h.clock.advance(5000);

            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            expect(handshakeTextOf(h.instances[1])).toBe([
                `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                RESUMED_CONTINUITY,
                `${TASKS_INTRO}\n- index the archive\n${TASKS_ADVICE}`,
                HANDSHAKE_SUFFIX,
            ].join('\n\n'));
        });

        it('a crash reopen names each background task running at the crash, in start order, and leaves out the interrupted turn\'s foreground task', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await startTasksInTurn(h);
            h.clock.advance(5000);

            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            expect(handshakeTextOf(h.instances[1])).toBe([
                `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                RESUMED_CONTINUITY,
                `${TASKS_INTRO}\n- index the archive\n- summarise the inbox\n${TASKS_ADVICE}`,
                HANDSHAKE_SUFFIX,
            ].join('\n\n'));

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            // The foreground task belonged to the interrupted turn, which is re-queued and re-run,
            // so the handshake leaves it out; the ledger reset still journals all three as lost.
            expect(h.journal.byKind('task_lost').map(entry => entry.taskId).toSorted((a, b) => a.localeCompare(b))).toEqual(['task-bg-1', 'task-bg-2', 'task-fg']);
        });

        it('a requested reopen names the reason and each background task still running, and its journal loses exactly those tasks', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await startTasksInTurn(h);
            h.instances[0].emit(frames.resultSuccess());
            await flush();
            h.clock.advance(7000);

            h.conductor.requestReopen('an identity change');
            await flush();
            // #97: the reopen waits out reopenTaskWaitMs for the still-running tasks first.
            h.clock.advance(DEFAULT_CONFIG.reopenTaskWaitMs);
            await flush();

            expect(handshakeTextOf(h.instances[1])).toBe([
                `[BOOT] Session reopened at 1970-01-01T00:02:07.000Z ${REQUESTED_OPENING}`,
                RESUMED_CONTINUITY,
                `${TASKS_INTRO}\n- index the archive\n- summarise the inbox\n${TASKS_ADVICE}`,
                HANDSHAKE_SUFFIX,
            ].join('\n\n'));

            h.instances[1].emit(frames.init('sess-1'));
            await flush();
            expect(h.journal.byKind('task_lost').map(entry => entry.taskId).toSorted((a, b) => a.localeCompare(b))).toEqual(['task-bg-1', 'task-bg-2']);
        });

        it('a requested reopen that falls back to a fresh session says the conversation could not be resumed, still naming the tasks', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await startTasksInTurn(h);
            h.instances[0].emit(frames.resultSuccess());
            await flush();
            h.clock.advance(7000);

            h.conductor.requestReopen('an identity change');
            await flush();
            h.clock.advance(DEFAULT_CONFIG.reopenTaskWaitMs);
            await flush();
            h.clock.advance(1000);
            h.instances[1].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(handshakeTextOf(h.instances[2])).toBe([
                `[BOOT] Session reopened at 1970-01-01T00:02:08.000Z ${REQUESTED_OPENING}`,
                FALLBACK_CONTINUITY,
                `${TASKS_INTRO}\n- index the archive\n- summarise the inbox\n${TASKS_ADVICE}`,
                HANDSHAKE_SUFFIX,
            ].join('\n\n'));
        });

        it('a task that finishes between the snapshot and the replacement open is journaled finished, while the cautious handshake still lists it', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            await startTasksInTurn(h);
            h.instances[0].emit(frames.resultSuccess());
            await flush();

            h.conductor.requestReopen('an identity change');
            await flush();
            // #97: neither task finishes within reopenTaskWaitMs, so the reopen goes ahead at it.
            h.clock.advance(DEFAULT_CONFIG.reopenTaskWaitMs);
            await flush();
            expect(h.instances).toHaveLength(2);
            // A notification the discarded reader had already buffered lands after the snapshot.
            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-bg-1', tool_use_id: 'tool-bg-1' }));
            await flush();
            // The request was consumed when the reopen started, so the late finish arms no recheck.
            expect(h.clock.pending()).toBe(0);
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(handshakeTextOf(h.instances[1])).toContain(`${TASKS_INTRO}\n- index the archive\n- summarise the inbox\n${TASKS_ADVICE}`);
            expect(h.journal.byKind('task_lost').map(entry => entry.taskId)).toEqual(['task-bg-2']);
            expect(h.journal.byKind('task_finished').filter(entry => entry.taskId === 'task-bg-1')).toEqual([
                { type: 'task_finished', at: expect.any(Date), taskId: 'task-bg-1', description: 'index the archive', outcome: 'completed' },
            ]);
        });

        describe('a requested reopen waits, bounded, for background work (#97)', () => {
            const WAIT_MS = 120_000;
            const SETTLE_MS = 5000;
            const PENDING_WAKE_TTL_MS = 300_000;
            const DEFER_MESSAGE = 'Deferring a requested reopen until the old session\'s background work has finished and its result has had a chance to reach the model (bounded by reopenTaskWaitMs)';
            const CUT_OFF_MESSAGE = 'Reopening the session with background tasks still running: the wait for them (reopenTaskWaitMs) ran out, so the reopen handshake lists them as cut off';
            const UNDELIVERED_MESSAGE = 'Reopening the session although a result may not have reached the model yet: the wait (reopenTaskWaitMs) ran out while a background task\'s wake or a peer message was still pending adoption, or within REOPEN_WAKE_SETTLE_MS of a task finishing; the reopen handshake does not mention it';
            const TASK_PARAGRAPH = `${TASKS_INTRO}\n- index the archive\n${TASKS_ADVICE}`;

            /** Opens, runs one turn that starts background task `task-bg-1` ("index the archive"), and ends that turn, all at t=0. */
            async function openWithBackgroundTask(h: Harness): Promise<void> {
                await openWith(h, 'sess-1');
                await startOneTaskInTurn(h);
                h.instances[0].emit(frames.resultSuccess());
                await flush();
            }

            function emitTaskCompleted(h: Harness): void {
                h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-bg-1', tool_use_id: 'tool-bg-1' }));
            }

            async function advance(h: Harness, ms: number): Promise<void> {
                h.clock.advance(ms);
                await flush();
            }

            function callsWithMessage(fn: ReturnType<typeof jest.fn>, message: string): unknown[][] {
                return fn.mock.calls.filter(call => call[1] === message);
            }

            it('holds the reopen while a background task runs, and reopens exactly at reopenTaskWaitMs naming it as cut off', async () => {
                const h = build();
                await openWithBackgroundTask(h);

                h.conductor.requestReopen('an identity change');
                await flush();
                expect(h.instances).toHaveLength(1);
                expect(h.instances[0].closeCalls).toBe(0);
                expect(h.clock.pending()).toBe(1);
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: ['index the archive'], waitAtMostMs: WAIT_MS }, DEFER_MESSAGE],
                ]);

                await advance(h, WAIT_MS - 1000);
                // Progress from a task that is still running is not a finish: it neither opens a
                // settle window (which would log an undelivered result below) nor re-arms.
                h.instances[0].emit(frames.taskProgress({ task_id: 'task-bg-1', tool_use_id: 'tool-bg-1' }));
                await flush();
                await advance(h, 999);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(h.instances[0].closeCalls).toBe(1);
                expect(h.clock.pending()).toBe(0);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:02:00.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    TASK_PARAGRAPH,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: ['index the archive'], waitedMs: WAIT_MS }, CUT_OFF_MESSAGE],
                ]);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([]);
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toHaveLength(1);

                h.instances[1].emit(frames.init('sess-1'));
                await flush();
                expect(h.journal.byKind('task_lost').map(entry => entry.taskId)).toEqual(['task-bg-1']);
            });

            it('the reopen that cut a task off leaves no settle behind: a later request made during a turn reopens at that turn\'s end', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, WAIT_MS);
                h.instances[1].emit(frames.init('sess-1'));
                await flush();

                void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.conductor.requestReopen('a second change');
                h.instances[1].emit(frames.resultSuccess());
                await flush();

                expect(h.instances).toHaveLength(3);
            });

            it('a task finishing during the wait: reopens exactly REOPEN_WAKE_SETTLE_MS after its task_notification, with no tasks paragraph and nothing lost', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);

                emitTaskCompleted(h);
                await flush();
                expect(h.instances).toHaveLength(1);
                expect(h.clock.pending()).toBe(1);

                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);
                expect(h.clock.pending()).toBe(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(h.clock.pending()).toBe(0);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:15.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([]);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([]);
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toHaveLength(1);

                h.instances[1].emit(frames.init('sess-1'));
                await flush();
                expect(h.journal.byKind('task_lost')).toEqual([]);
                expect(h.journal.byKind('task_finished').filter(entry => entry.taskId === 'task-bg-1')).toEqual([
                    { type: 'task_finished', at: expect.any(Date), taskId: 'task-bg-1', description: 'index the archive', outcome: 'completed' },
                ]);
            });

            it('one of two background tasks dropped near the deadline: still held for the other, which is cut off, and the fresh finish is logged as settling', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                await startTasksInTurn(h);
                h.instances[0].emit(frames.resultSuccess());
                await flush();
                h.conductor.requestReopen('an identity change');
                await advance(h, WAIT_MS - 1000);

                // No task_notification: only the running-set diff can see task-bg-1 finish here.
                h.instances[0].emit(frames.backgroundTasksChanged([{ task_id: 'task-bg-2', task_type: 'local_agent', description: 'summarise the inbox' }]));
                await flush();
                await advance(h, 999);
                expect(h.instances).toHaveLength(1);
                expect(h.clock.pending()).toBe(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:02:00.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    `${TASKS_INTRO}\n- summarise the inbox\n${TASKS_ADVICE}`,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: ['summarise the inbox'], waitedMs: WAIT_MS }, CUT_OFF_MESSAGE],
                ]);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', waitedMs: WAIT_MS, pendingAdoptions: [], settling: true }, UNDELIVERED_MESSAGE],
                ]);
            });

            it('a pending wake holds the reopen past the settle window until its wake turn has run, then settles again from that turn\'s end', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);
                emitTaskCompleted(h);
                h.conductor.adoptWakeTurn({ taskId: 'task-bg-1', toolUseId: 'tool-bg-1', summary: 'archive indexed' });
                await flush();

                await advance(h, 60_000);
                expect(h.instances).toHaveLength(1);

                h.instances[0].emit(frames.assistantText('the archive is indexed', { parent_tool_use_id: null }));
                await flush();
                expect(h.conductor.status().turn).toMatchObject({ kind: 'task' });
                h.instances[0].emit(frames.resultSuccess({ result: 'the archive is indexed' }));
                await flush();
                expect(h.instances).toHaveLength(1);
                expect(h.journal.byKind('turn_completed').at(-1)).toMatchObject({ kind: 'task', responseText: 'the archive is indexed' });

                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);
                expect(h.instances).toHaveLength(2);
                expect(h.instances[0].closeCalls).toBe(1);
            });

            it('a pending wake stops holding at its PENDING_WAKE_TTL_MS staleness boundary, well before a longer reopenTaskWaitMs', async () => {
                const h = build({ config: sessionConfigSchema.parse({ reopenTaskWaitMs: 600_000 }) });
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 1000);
                emitTaskCompleted(h);
                h.conductor.adoptWakeTurn({ taskId: 'task-bg-1', toolUseId: 'tool-bg-1', summary: 'archive indexed' });
                await flush();

                // Stale once more than PENDING_WAKE_TTL_MS has elapsed since it was set at t=1000.
                await advance(h, PENDING_WAKE_TTL_MS);
                expect(h.instances).toHaveLength(1);
                expect(h.clock.pending()).toBe(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([]);
            });

            it('a task finishing mid-turn: the settle window restarts at that turn\'s end, where a deferred wake is delivered', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                await startOneTaskInTurn(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 1000);
                // Mid-turn, the request is not evaluated, so nothing is armed; a frame that finishes
                // no background task does not arm anything either.
                h.instances[0].emit(frames.taskProgress({ task_id: 'task-bg-1', tool_use_id: 'tool-bg-1' }));
                await flush();
                expect(h.clock.pending()).toBe(0);
                emitTaskCompleted(h);
                await flush();
                await advance(h, 19_000);
                expect(h.instances).toHaveLength(1);

                h.instances[0].emit(frames.resultSuccess());
                await flush();
                expect(h.instances).toHaveLength(1);
                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
            });

            it('a foreground task stopped at the turn end neither holds nor settles the reopen', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.instances[0].emit(frames.taskStarted({ task_id: 'task-fg', tool_use_id: 'tool-fg', description: 'foreground helper', is_backgrounded: false }));
                await flush();

                h.conductor.requestReopen('an identity change');
                h.instances[0].emit(frames.resultSuccess());
                await flush();

                expect(h.instances).toHaveLength(2);
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toEqual([]);
            });

            it('background_tasks_changed dropping the task starts the settle window, and a late task_notification for it restarts it', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);

                h.instances[0].emit(frames.backgroundTasksChanged([]));
                await flush();
                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);

                // t=14,999: the notification for the already-dropped task restarts the window.
                emitTaskCompleted(h);
                await flush();
                await advance(h, 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, SETTLE_MS - 2);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:19.999Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a late task_notification the ledger ignores (its finished record already evicted) still restarts the settle window', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);

                h.instances[0].emit(frames.backgroundTasksChanged([]));
                await flush();
                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);

                // t=14,999: an id in neither `tasks` nor `finishedTasks` — as for a record evicted
                // past the finished-tasks cap — leaves the ledger unchanged by reference, so no
                // ledger subscriber sees this frame; the window must restart all the same.
                const ledgerBefore = h.ledgerStore.get();
                h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-evicted', tool_use_id: 'tool-evicted' }));
                await flush();
                expect(h.ledgerStore.get()).toBe(ledgerBefore);
                await advance(h, 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, SETTLE_MS - 2);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toContain('[BOOT] Session reopened at 1970-01-01T00:00:19.999Z ');
            });

            it('a repeated task_notification with an unchanged status still restarts the settle window', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);
                emitTaskCompleted(h);
                await flush();
                await advance(h, 4000);

                emitTaskCompleted(h);
                await flush();
                await advance(h, SETTLE_MS - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toContain('[BOOT] Session reopened at 1970-01-01T00:00:19.000Z ');
            });

            it('an explicitly lost task releases the hold at once, with no settle window', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);

                h.ledgerStore.dispatch({ type: 'task_lost', taskId: 'task-bg-1', at: new Date(h.clock.now()) });
                await flush();
                expect(h.instances).toHaveLength(1);
                expect(h.clock.pending()).toBe(1);
                await advance(h, 0);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:10.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a second request during the wait keeps the ORIGINAL deadline and applies the later reason', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 30_000);

                h.conductor.requestReopen('a second change');
                await flush();
                expect(h.clock.pending()).toBe(1);
                await advance(h, WAIT_MS - 30_000 - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(h.journal.byKind('session_reopen_requested').map(entry => entry.reason)).toEqual(['an identity change', 'a second change']);
                expect(handshakeTextOf(h.instances[1])).toContain('[BOOT] Session reopened at 1970-01-01T00:02:00.000Z because the host deliberately closed the previous session process to apply a second change.');
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([
                    [{ reason: 'a second change', tasks: ['index the archive'], waitedMs: WAIT_MS }, CUT_OFF_MESSAGE],
                ]);
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: ['index the archive'], waitAtMostMs: WAIT_MS }, DEFER_MESSAGE],
                    [{ reason: 'a second change', tasks: ['index the archive'], waitAtMostMs: WAIT_MS - 30_000 }, DEFER_MESSAGE],
                ]);
            });

            it('the cut-off warning\'s waitedMs counts from the first request, not from t=0', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                await advance(h, 50_000);
                h.conductor.requestReopen('an identity change');
                await advance(h, WAIT_MS - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: ['index the archive'], waitedMs: WAIT_MS }, CUT_OFF_MESSAGE],
                ]);
            });

            it('a request after a completed reopen starts a fresh deadline of its own', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                h.clock.advance(50_000);
                h.conductor.requestReopen('an identity change');
                await flush();
                h.instances[1].emit(frames.init('sess-1'));
                await flush();

                void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                h.instances[1].emit(frames.taskStarted({ task_id: 'task-bg-9', tool_use_id: 'tool-bg-9', description: 'crawl the feed', is_backgrounded: true }));
                h.instances[1].emit(frames.resultSuccess());
                await flush();
                h.conductor.requestReopen('a second change');
                await advance(h, WAIT_MS - 1);
                expect(h.instances).toHaveLength(2);
                await advance(h, 1);

                expect(h.instances).toHaveLength(3);
            });

            it('crash during the wait: the crash reopen lists the task, drops the satisfied request and clears its recheck', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);

                h.instances[0].fail(new Error('worker crashed'));
                await flush();
                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:10.000Z ${CRASH_OPENING}`,
                    RESUMED_CONTINUITY,
                    TASK_PARAGRAPH,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
                h.instances[1].emit(frames.init('sess-1'));
                await flush();

                expect(h.logger.debug).toHaveBeenCalledWith({ reason: 'an identity change' }, 'Dropping a requested reopen an intervening open already satisfied');
                expect(h.clock.pending()).toBe(0);
                await advance(h, WAIT_MS);
                expect(h.instances).toHaveLength(2);
                expect(h.journal.byKind('session_opened').at(-1)).toMatchObject({ cause: 'crash_reopen' });
            });

            it('shutdown during the wait cancels it: no recheck timer is left and no reopen ever starts', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await flush();
                expect(h.clock.pending()).toBe(1);

                await h.conductor.shutdown({ turnWaitMs: 1000, deadlineMs: 2000 });

                expect(h.clock.pending()).toBe(0);
                await advance(h, WAIT_MS);
                expect(h.instances).toHaveLength(1);
                expect(h.instances[0].closeCalls).toBe(1);
            });

            it('a background task finishing during shutdown\'s grace period arms no recheck', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                await startOneTaskInTurn(h);
                h.conductor.requestReopen('an identity change');
                const shutdownPromise = h.conductor.shutdown({ turnWaitMs: 60_000, deadlineMs: 120_000 });
                await flush();
                const before = h.clock.pending();

                emitTaskCompleted(h);
                await flush();

                expect(h.clock.pending()).toBe(before);
                h.instances[0].emit(frames.resultSuccess());
                await flush();
                h.clock.runAll();
                await shutdownPromise;
                expect(h.instances).toHaveLength(1);
            });

            it('compaction: a deadline that passes during a /compact turn reopens once that turn ends', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, WAIT_MS - 1000);

                h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));
                h.instances[0].emit(frames.assistantText('a spontaneous note', { parent_tool_use_id: null }));
                h.instances[0].emit(frames.resultSuccess());
                await flush();
                expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'compact' });

                await advance(h, 2000);
                expect(h.instances).toHaveLength(1);

                h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 10 }));
                h.instances[0].emit(frames.compactBoundary());
                await flush();
                expect(h.instances).toHaveLength(1);
                h.instances[0].emit(frames.resultSuccess());
                await flush();

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:02:01.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    TASK_PARAGRAPH,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a settle window that would run past the deadline is clamped to it, and the possibly undelivered result is logged', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, WAIT_MS - 1000);
                emitTaskCompleted(h);
                await flush();

                await advance(h, 999);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(handshakeTextOf(h.instances[1])).toContain('[BOOT] Session reopened at 1970-01-01T00:02:00.000Z ');
                expect(callsWithMessage(h.logger.warn, CUT_OFF_MESSAGE)).toEqual([]);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', waitedMs: WAIT_MS, pendingAdoptions: [], settling: true }, UNDELIVERED_MESSAGE],
                ]);
            });

            it('a pending wake that would run past the deadline is clamped to it, and logged as undelivered', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await advance(h, 10_000);
                emitTaskCompleted(h);
                h.conductor.adoptWakeTurn({ taskId: 'task-bg-1', toolUseId: 'tool-bg-1', summary: 'archive indexed' });
                await flush();

                await advance(h, WAIT_MS - 10_000 - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([
                    [{
                        reason: 'an identity change', waitedMs: WAIT_MS, pendingAdoptions: [{ kind: 'wake', taskId: 'task-bg-1', toolUseId: 'tool-bg-1', summary: 'archive indexed', setAt: 10_000 }], settling: false,
                    }, UNDELIVERED_MESSAGE],
                ]);
            });

            it('a pending peer message holds the reopen too, up to the deadline, and is logged as undelivered there', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                const peer = peerEnvelope();
                h.conductor.adoptPeerTurn(peer);
                h.conductor.requestReopen('an identity change');
                await flush();
                expect(callsWithMessage(h.logger.info, DEFER_MESSAGE)).toEqual([
                    [{ reason: 'an identity change', tasks: [], waitAtMostMs: WAIT_MS }, DEFER_MESSAGE],
                ]);

                await advance(h, WAIT_MS - 1);
                expect(h.instances).toHaveLength(1);
                await advance(h, 1);

                expect(h.instances).toHaveLength(2);
                expect(callsWithMessage(h.logger.warn, UNDELIVERED_MESSAGE)).toEqual([
                    [{
                        reason: 'an identity change', waitedMs: WAIT_MS, pendingAdoptions: [{ kind: 'peer', envelopeId: peer.id, setAt: 0 }], settling: false,
                    }, UNDELIVERED_MESSAGE],
                ]);
            });

            it('a reopen started at a turn end clears the recheck timer it no longer needs', async () => {
                const h = build();
                await openWith(h, 'sess-1');
                h.conductor.adoptPeerTurn(peerEnvelope());
                h.conductor.requestReopen('an identity change');
                await flush();
                expect(h.clock.pending()).toBe(1);
                await advance(h, 1000);

                h.instances[0].emit(frames.assistantText('peer reply', { parent_tool_use_id: null }));
                await flush();
                expect(h.conductor.status().turn).toMatchObject({ kind: 'peer' });
                h.instances[0].emit(frames.resultSuccess());
                await flush();

                expect(h.instances).toHaveLength(2);
                expect(h.clock.pending()).toBe(0);
            });

            it('no queued envelope starts on the old session during the wait; it plays on the replacement', async () => {
                const h = build();
                await openWithBackgroundTask(h);
                h.conductor.requestReopen('an identity change');
                await flush();

                const queued = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
                await flush();
                expect(turnPrompts(h.instances[0])).toHaveLength(1);

                await advance(h, WAIT_MS);
                h.instances[1].emit(frames.init('sess-1'));
                await flush();
                expect(turnPrompts(h.instances[1])).toHaveLength(1);
                h.instances[1].emit(frames.resultSuccess());
                await expect(queued).resolves.toEqual(expect.objectContaining({ isError: false }));
            });
        });

        describe('the boot bundle on a reopen (#98)', () => {
            it('a requested reopen that resumes builds no bundle and pushes exactly the #62 reopen text', async () => {
                const buildBootBundle = jest.fn(() => 'BUNDLE');
                const h = build({ buildBootBundle });
                await openWith(h, 'sess-1');
                h.clock.advance(7000);

                h.conductor.requestReopen('an identity change');
                await flush();

                expect(buildBootBundle).toHaveBeenCalledTimes(1);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:07.000Z ${REQUESTED_OPENING}`,
                    RESUMED_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a crash reopen that resumes builds no bundle either', async () => {
                const buildBootBundle = jest.fn(() => 'BUNDLE');
                const h = build({ buildBootBundle });
                await openWith(h, 'sess-1');
                h.clock.advance(5000);

                h.instances[0].fail(new Error('worker crashed'));
                await flush();

                expect(buildBootBundle).toHaveBeenCalledTimes(1);
                expect(handshakeTextOf(h.instances[1])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                    RESUMED_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a requested reopen that falls back to fresh builds a fresh bundle for its cause only after the resume failed, and appends it as the last paragraph', async () => {
                const buildBootBundle = jest.fn((_request: BootBundleRequest) => 'FRESH BUNDLE');
                const h = build({ buildBootBundle });
                await openWith(h, 'sess-1');
                await startTasksInTurn(h);
                h.instances[0].emit(frames.resultSuccess());
                await flush();
                h.clock.advance(7000);

                h.conductor.requestReopen('an identity change');
                await flush();
                h.clock.advance(DEFAULT_CONFIG.reopenTaskWaitMs);
                await flush();
                expect(buildBootBundle).toHaveBeenCalledTimes(1);
                h.clock.advance(1000);
                h.instances[1].fail(new Error('resume rejected by CLI'));
                await flush();

                expect(buildBootBundle.mock.calls).toEqual([
                    [{ kind: 'fresh', cause: 'boot', lostTasks: [], undelivered: [] }],
                    [{ kind: 'fresh', cause: 'requested_reopen', lostTasks: [], undelivered: [] }],
                ]);
                expect(handshakeTextOf(h.instances[2])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:02:08.000Z ${REQUESTED_OPENING}`,
                    FALLBACK_CONTINUITY_RESEEDED,
                    `${TASKS_INTRO}\n- index the archive\n- summarise the inbox\n${TASKS_ADVICE}`,
                    HANDSHAKE_SUFFIX,
                    'FRESH BUNDLE',
                ].join('\n\n'));
            });

            it('a crash reopen that falls back to fresh builds its fresh bundle with cause crash_reopen', async () => {
                const buildBootBundle = jest.fn((_request: BootBundleRequest) => 'FRESH BUNDLE');
                const h = build({ buildBootBundle });
                await openWith(h, 'sess-1');
                h.clock.advance(5000);

                h.instances[0].fail(new Error('worker crashed'));
                await flush();
                h.instances[1].fail(new Error('resume also failed'));
                await flush();

                expect(buildBootBundle.mock.calls).toEqual([
                    [{ kind: 'fresh', cause: 'boot', lostTasks: [], undelivered: [] }],
                    [{ kind: 'fresh', cause: 'crash_reopen', lostTasks: [], undelivered: [] }],
                ]);
                expect(handshakeTextOf(h.instances[2])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                    FALLBACK_CONTINUITY_RESEEDED,
                    HANDSHAKE_SUFFIX,
                    'FRESH BUNDLE',
                ].join('\n\n'));
            });

            it('an empty fallback bundle claims no re-seed and appends nothing', async () => {
                const h = build({ buildBootBundle: jest.fn(() => '') });
                await openWith(h, 'sess-1');
                h.clock.advance(5000);

                h.instances[0].fail(new Error('worker crashed'));
                await flush();
                h.instances[1].fail(new Error('resume also failed'));
                await flush();

                expect(handshakeTextOf(h.instances[2])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                    FALLBACK_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });

            it('a fallback bundle whose build rejects claims no re-seed either', async () => {
                const buildBootBundle = jest.fn()
                    .mockImplementationOnce(() => 'BOOT BUNDLE')
                    .mockImplementationOnce(() => Promise.reject(new Error('task list unavailable')));
                const h = build({ buildBootBundle });
                await openWith(h, 'sess-1');
                h.clock.advance(5000);

                h.instances[0].fail(new Error('worker crashed'));
                await flush();
                h.instances[1].fail(new Error('resume also failed'));
                await flush();

                expect(handshakeTextOf(h.instances[2])).toBe([
                    `[BOOT] Session reopened at 1970-01-01T00:00:05.000Z ${CRASH_OPENING}`,
                    FALLBACK_CONTINUITY,
                    HANDSHAKE_SUFFIX,
                ].join('\n\n'));
            });
        });
    });

    describe('shutdown during a boot bundle build (#98)', () => {
        const SHUTDOWN_OPTIONS = { turnWaitMs: 0, deadlineMs: 1000 };

        it('shutdown while the initial fresh bundle is building: no query is spawned and open() rejects', async () => {
            const bundle = deferred<string>();
            const h = build({ buildBootBundle: jest.fn(() => bundle.promise) });

            const openPromise = h.conductor.open();
            const openOutcome = openPromise.catch((error: unknown) => error);
            await flush();
            await h.conductor.shutdown(SHUTDOWN_OPTIONS);
            bundle.resolve('late bundle');
            await flush();

            expect(h.instances).toHaveLength(0);
            expect(await openOutcome).toEqual(new Error('Conductor is shutting down; the session was not opened'));
        });

        it('shutdown while the restart_resume bundle is building: no query is spawned, and no fresh fallback is attempted', async () => {
            const bundle = deferred<string>();
            const h = build({ buildBootBundle: jest.fn(() => bundle.promise) });
            await h.resumeStore.save('conversation', 'sess-old');

            const openOutcome = h.conductor.open().catch((error: unknown) => error);
            await flush();
            await h.conductor.shutdown(SHUTDOWN_OPTIONS);
            bundle.resolve('late bundle');
            await flush();

            expect(h.instances).toHaveLength(0);
            expect(h.buildBootBundle).toHaveBeenCalledTimes(1);
            expect(await openOutcome).toEqual(new Error('Conductor is shutting down; the session was not opened'));
            expect(h.logger.warn).not.toHaveBeenCalled();
        });

        it('shutdown while the boot fallback bundle is building: no fallback query is spawned', async () => {
            const fallbackBundle = deferred<string>();
            const h = build({
                buildBootBundle: jest.fn()
                    .mockImplementationOnce(() => 'resume bundle')
                    .mockImplementationOnce(() => fallbackBundle.promise),
            });
            await h.resumeStore.save('conversation', 'sess-old');

            const openOutcome = h.conductor.open().catch((error: unknown) => error);
            await flush();
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();
            expect(h.buildBootBundle).toHaveBeenCalledTimes(2);
            await h.conductor.shutdown(SHUTDOWN_OPTIONS);
            fallbackBundle.resolve('late bundle');
            await flush();

            expect(h.instances).toHaveLength(1);
            expect(await openOutcome).toEqual(new Error('Conductor is shutting down; the session was not opened'));
        });

        it('a boot handle that settles after shutdown finished is closed, not left running, and open() rejects', async () => {
            const h = build({ buildBootBundle: jest.fn(() => 'bundle') });

            const openOutcome = h.conductor.open().catch((error: unknown) => error);
            await flush();
            expect(h.instances).toHaveLength(1);
            await h.conductor.shutdown(SHUTDOWN_OPTIONS);
            expect(h.instances[0].closeCalls).toBe(0);

            h.instances[0].emit(frames.init('sess-late'));
            await flush();

            expect(h.instances[0].closeCalls).toBe(1);
            expect(h.conductor.status().opened).toBe(false);
            expect(h.journal.byKind('session_opened')).toEqual([]);
            expect(await openOutcome).toEqual(new Error('Conductor is shutting down; the session was not opened'));
        });

        it('a restart_resume handle that settles after shutdown is closed without falling back to a fresh open', async () => {
            const h = build({ buildBootBundle: jest.fn(() => 'bundle') });
            await h.resumeStore.save('conversation', 'sess-old');

            const openOutcome = h.conductor.open().catch((error: unknown) => error);
            await flush();
            await h.conductor.shutdown(SHUTDOWN_OPTIONS);
            h.instances[0].emit(frames.init('sess-old'));
            await flush();

            expect(h.instances).toHaveLength(1);
            expect(h.instances[0].closeCalls).toBe(1);
            expect(await openOutcome).toEqual(new Error('Conductor is shutting down; the session was not opened'));
        });

        it('shutdown while a reopen\'s fallback bundle is building: no replacement query is spawned', async () => {
            const fallbackBundle = deferred<string>();
            const h = build({
                buildBootBundle: jest.fn()
                    .mockImplementationOnce(() => 'boot bundle')
                    .mockImplementationOnce(() => fallbackBundle.promise),
            });
            await openWith(h, 'sess-1');
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].fail(new Error('resume also failed'));
            await flush();
            expect(h.buildBootBundle).toHaveBeenCalledTimes(2);

            const shutdownPromise = h.conductor.shutdown(SHUTDOWN_OPTIONS);
            await flush();
            fallbackBundle.resolve('late bundle');
            await shutdownPromise;
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(h.logger.error).not.toHaveBeenCalledWith(expect.anything(), 'Conductor could not reopen the session after it closed unexpectedly; giving up');
        });

        it('shutdown while a reopen\'s fallback bundle is building rejects the turn the crash interrupted, clearing its abort listener', async () => {
            const fallbackBundle = deferred<string>();
            const h = build({
                buildBootBundle: jest.fn()
                    .mockImplementationOnce(() => 'boot bundle')
                    .mockImplementationOnce(() => fallbackBundle.promise),
            });
            await openWith(h, 'sess-1');
            const controller = new AbortController();
            const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
            const inFlight = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            const inFlightOutcome = inFlight.catch((error: unknown) => error);
            await flush();
            h.instances[0].fail(new Error('worker crashed'));
            await flush();
            h.instances[1].fail(new Error('resume also failed'));
            await flush();

            const shutdownPromise = h.conductor.shutdown(SHUTDOWN_OPTIONS);
            await flush();
            fallbackBundle.resolve('late bundle');
            await shutdownPromise;
            await flush();

            expect(h.instances).toHaveLength(2);
            expect(await inFlightOutcome).toEqual(new Error('Conductor is shutting down'));
            expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
        });

        it('shutdown while a crash reopen\'s resume is in flight rejects the interrupted turn instead of re-queueing it', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const inFlightOutcome = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' }).catch((error: unknown) => error);
            await flush();
            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            const shutdownPromise = h.conductor.shutdown(SHUTDOWN_OPTIONS);
            await flush();
            h.instances[1].emit(frames.init('sess-1'));
            await shutdownPromise;
            await flush();

            expect(h.instances[1].closeCalls).toBe(1);
            expect(turnPrompts(h.instances[1])).toHaveLength(0);
            expect(await inFlightOutcome).toEqual(new Error('Conductor is shutting down'));
        });
    });
});
