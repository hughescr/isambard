/**
 * Behavioural tests for {@link createConductor} (design doc section 6): the long-lived session
 * conductor. Every timing assertion runs on {@link FakeClock} — no real timers, no real delays.
 * Uses P3's {@link fakeQueryFn}/{@link FakeQuery} to drive the reader loop deterministically, and
 * the P3/P7 in-memory port doubles ({@link FakeJournal}, {@link FakeResumeStore}).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { SDKNotificationMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { fakeQueryFn, type FakeQuery } from '../../../helpers/fake-query';
import { FakeResumeStore } from '../../../helpers/fake-resume-store';
import * as frames from '../../../helpers/sdk-frames';
import { createConductor, type Conductor, type CreateConductorParams } from '@/agent/session/conductor';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
import { createTaskLaunchRegistry } from '@/agent/session/task-launch-registry';
import type { Envelope } from '@/agent/session/types';
import { DEFAULT_RETRY_CONFIG } from '@/config/retry-config';
import { sessionConfigSchema, type SessionConfig } from '@/config/schemas';
import type { ErrorClassification, RetryPolicy } from '@/utils';

/** Flushes enough microtask ticks for the conductor's promise chains (reader loop, guard.onTurnEnd, retry scheduling) to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
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
    conductor:   Conductor
    instances:   FakeQuery[]
    clock:       FakeClock
    journal:     FakeJournal
    resumeStore: FakeResumeStore
    ledgerStore: LedgerStore
    logger:      { info: ReturnType<typeof jest.fn>, warn: ReturnType<typeof jest.fn>, error: ReturnType<typeof jest.fn>, debug: ReturnType<typeof jest.fn> }
    readRss:     ReturnType<typeof jest.fn>
}

const DEFAULT_CONFIG: SessionConfig = sessionConfigSchema.parse({});
const FAST_RETRY_POLICY: RetryPolicy = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 2, jitterFraction: 0 };

function build(overrides: Partial<CreateConductorParams> = {}): Harness {
    const { queryFn, instances } = fakeQueryFn();
    const clock = new FakeClock(0);
    const journal = new FakeJournal();
    const resumeStore = new FakeResumeStore();
    const ledgerStore = createLedgerStore('conversation', { logger: { error: jest.fn() } });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const readRss = jest.fn(() => 4096);

    const conductor = createConductor({
        role:         'conversation',
        queryFn,
        buildOptions: () => ({}),
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
    };
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

describe('createConductor', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('open()', () => {
        it('with no stored resume id: opens fresh, journals session_opened without fallback, saves the id', async () => {
            const h = build();

            const result = await openWith(h, 'sess-fresh');

            expect(result).toEqual({ sessionId: 'sess-fresh', resumed: false });
            expect(h.instances).toHaveLength(1);
            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-fresh', resumed: false },
            ]);
            await expect(h.resumeStore.load('conversation')).resolves.toBe('sess-fresh');
        });

        it('with a stored resume id: passes it to buildOptions and journals resumed:true, no fallback', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');
            const buildOptions = jest.fn<CreateConductorParams['buildOptions']>().mockReturnValue({});
            const h2 = build({ buildOptions, resumeStore: h.resumeStore });

            const result = await openWith(h2, 'sess-old');

            expect(result).toEqual({ sessionId: 'sess-old', resumed: true });
            expect(buildOptions).toHaveBeenCalledWith('sess-old');
            expect(h2.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-old', resumed: true },
            ]);
        });

        it('resume attempt failing immediately falls back to a fresh open with fallback:true', async () => {
            const h = build();
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();
            h.instances[1].emit(frames.init('sess-new'));
            const result = await openPromise;

            expect(result).toEqual({ sessionId: 'sess-new', resumed: false });
            expect(h.instances).toHaveLength(2);
            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-new', resumed: false, fallback: true },
            ]);
            expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
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
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-new', resumed: false, fallback: true }
            );
        });

        it('pushes the boot bundle as the opening handshake boot envelope', async () => {
            const h = build({ bootBundle: 'welcome back' });

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('welcome back');
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

        it('an empty boot bundle falls back to the bare open marker rather than pushing an empty handshake', async () => {
            const h = build({ bootBundle: '' });

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('[BOOT] Session opened at 1970-01-01T00:00:00.000Z. No boot context to report.');
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

        it('a fallback fresh open after a failed resume pushes its own handshake onto the fresh handle', async () => {
            const h = build({ bootBundle: 'welcome back' });
            await h.resumeStore.save('conversation', 'sess-old');

            const openPromise = h.conductor.open();
            await flush();
            expect(JSON.stringify(h.instances[0].consumedPrompts[0]?.message)).toContain('welcome back');
            h.instances[0].fail(new Error('resume rejected by CLI'));
            await flush();

            expect(h.instances[1].consumedPrompts).toHaveLength(1);
            expect(JSON.stringify(h.instances[1].consumedPrompts[0]?.message)).toContain('welcome back');
            h.instances[1].emit(frames.init('sess-new'));
            await expect(openPromise).resolves.toEqual({ sessionId: 'sess-new', resumed: false });
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

            const secondPromise = h.conductor.submit(discordEnvelope({ channelId: 'chan-1' }), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.instances[0].interruptCalls).toBe(1);

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
            }).toThrow('shouldQuery');
        });

        it('throws the shouldQuery:true InvariantViolationError even before open() has assigned a live queue', () => {
            const h = build();

            expect(() => {
                h.conductor.appendWithoutTurn(catchupEnvelope());
            }).toThrow('shouldQuery');
        });
    });

    describe('submit() shouldQuery guard', () => {
        it('throws an InvariantViolationError when given a shouldQuery:false envelope', async () => {
            const h = build();
            await openWith(h);

            expect(() => {
                void h.conductor.submit(notificationEnvelope(), { priority: 'other' });
            }).toThrow('shouldQuery');
        });
    });

    describe('task lifecycle journaling', () => {
        it('a task_started frame journals task_started, and its task_notification journals exactly one task_completed even if repeated', async () => {
            const h = build();
            await openWith(h);
            void h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'run a thing' }));
            await flush();

            expect(h.journal.byKind('task_started')).toEqual([
                { type: 'task_started', at: expect.any(Date), taskId: 'task-1', description: 'run a thing' },
            ]);

            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-1' }));
            await flush();
            // A duplicate notification for the same (already-removed) task is a ledger no-op and
            // must not journal a second completion.
            h.instances[0].emit(frames.taskNotification('completed', { task_id: 'task-1' }));
            await flush();

            expect(h.journal.byKind('task_completed')).toEqual([
                { type: 'task_completed', at: expect.any(Date), taskId: 'task-1', description: 'run a thing' },
            ]);
            expect(h.journal.byKind('task_lost')).toEqual([]);
        });

        it('tasks still in flight when a mid-life reopen wipes the ledger\'s task list are journaled task_lost, not task_completed', async () => {
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
            expect(h.journal.byKind('task_completed')).toEqual([]);
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

            h.clock.advance(9999);
            expect(h.instances[0].interruptCalls).toBe(0);

            h.clock.advance(1);
            expect(h.instances[0].interruptCalls).toBe(1);

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the injected resume turn
            await flush();
            h.instances[0].emit(frames.resultSuccess()); // closes the human's discord turn
            await humanPromise;
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
            h.instances[0].scriptContextUsage(frames.contextUsage({ percentage: 60 }));

            h.instances[0].fail(new Error('worker crashed')); // handleMidLifeClosed sets reopening = true
            await flush();
            expect(h.instances).toHaveLength(2);

            // currentHandleRef/currentQueue still point at the crashed instances[0] (uncleared)
            // until the reopen settles, so getContextUsage() still resolves via its scripted value
            // above. instances[0]'s reader loop has already exited (it failed), so the 'result'
            // frame that drives afterResult() -> guard.onTurnEnd() -> submit() -> submitCompact()
            // must come from instances[1] instead — its own reader loop is alive and forwards every
            // frame to the same global onFrame handler even before it has captured a session id.
            h.instances[1].emit(frames.resultSuccess());
            await flush();

            expect(h.logger.warn).toHaveBeenCalledWith(
                { error: expect.objectContaining({ message: 'Conductor is reopening its session' }) },
                expect.any(String)
            );

            h.instances[1].emit(frames.init('sess-1'));
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

            expect(result.isError).toBe(true);
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

            h.instances[0].fail(new Error('worker crashed'));
            await flush();

            expect(h.instances).toHaveLength(2);
            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.journal.byKind('session_opened')).toEqual([
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-1', resumed: false },
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-1', resumed: true },
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
                { type: 'session_opened', at: expect.any(Date), role: 'conversation', sessionId: 'sess-2', resumed: false, fallback: true }
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
            h.instances[1].fail(new Error('resume also failed'));
            await flush();
            h.instances[2].fail(new Error('fresh open also failed'));
            await flush();

            await expect(inFlight).rejects.toThrow();
            await expect(queued).rejects.toThrow();
            expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.stringContaining('giving up'));
            // rejectAllQueued/the in-flight-item rejection path both clear their AbortSignal
            // listener — a long-lived signal must not keep retaining a settled item's callback.
            expect(inFlightRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(queuedRemoveSpy).toHaveBeenCalledWith('abort', expect.any(Function));

            // The conductor must not silently accept further work once it has given up.
            await expect(h.conductor.submit(discordEnvelope(), { priority: 'human' })).rejects.toThrow('not open');
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

            expect(h.journal.byKind('session_opened').at(-1)).toMatchObject({ sessionId: 'sess-2', fallback: true });
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
            const envelope = discordEnvelope({ channelId: 'chan-1' });
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();
            expect(h.instances[0].interruptCalls).toBe(0);

            controller.abort();
            await flush();
            expect(h.instances[0].interruptCalls).toBe(1);

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
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1', signal: controller.signal });
            await flush();
            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.outcome).toBeUndefined();

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
            expect(h.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ requestingChannelId: 'chan-other' }), expect.any(String));
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

            h.instances[0].rejectInterrupt(new Error('SDK refused the interrupt'));

            await interruptPromise; // must resolve, not reject, even though the underlying call failed

            expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
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

            h.instances[0].resolveInterrupt();
            h.instances[0].emit(frames.resultInterrupted());
            await shutdownPromise;

            expect(h.journal.flushCount).toBe(1);
            expect(h.instances[0].closeCalls).toBe(1);
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
    });

    describe('deliver()', () => {
        it('throws an InvariantViolationError when called before open() has run its boot recovery', async () => {
            const h = build();

            await expect(h.conductor.deliver('env-1', () => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-1'] })))
                .rejects.toThrow('called before open()');
        });

        it('sends, journals response_delivered, and awaits flush() before resolving, then marks the envelope delivered', async () => {
            const h = build();
            await openWith(h);
            const order: string[] = [];
            const send = jest.fn(async () => {
                order.push('send');
                return { channelId: 'chan-1', messageIds: ['msg-1'] };
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
            expect(result).toEqual({ delivered: true });
            expect(h.journal.byKind('response_delivered')).toEqual([
                { type: 'response_delivered', at: expect.any(Date), envelopeId: 'env-1', channelId: 'chan-1', messageIds: ['msg-1'] },
            ]);
            expect(order).toEqual(['send', 'flush', 'resolved']);
        });

        it('a second deliver() call for the same envelope id skips the send and does not journal again', async () => {
            const h = build();
            await openWith(h);
            const send = jest.fn(() => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-1'] }));

            await h.conductor.deliver('env-1', send);
            const second = await h.conductor.deliver('env-1', send);

            expect(send).toHaveBeenCalledTimes(1);
            expect(second).toEqual({ delivered: false });
            expect(h.journal.byKind('response_delivered')).toHaveLength(1);
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
            h.journal.scriptReadSinceRejection(new Error('DynamoDB throttled'));

            await expect(openWith(h)).resolves.toEqual({ sessionId: 'sess-1', resumed: false });

            expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
            const send = jest.fn(() => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-1'] }));
            const result = await h.conductor.deliver('env-unseen', send);
            expect(result).toEqual({ delivered: true });
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
            const send = jest.fn(() => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-2'] }));

            const result = await h.conductor.deliver('env-1', send);

            expect(result).toEqual({ delivered: false });
            expect(send).not.toHaveBeenCalled();
        });

        it('feeds recovery-derived lost task and undelivered-envelope descriptions to buildBootBundle', async () => {
            const h = build({
                buildBootBundle: jest.fn(input => `lost:${input.lostTasks.join(',')}|undelivered:${input.undelivered.join(',')}`),
            });
            h.journal.scriptReadSince([
                { type: 'task_started', at: new Date(0), taskId: 'task-1', description: 'abandoned task' },
                { type: 'envelope_submitted', at: new Date(0), envelopeId: 'env-1', kind: 'discord' },
                { type: 'turn_completed', at: new Date(0), envelopeId: 'env-1', kind: 'discord' },
            ]);

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('lost:abandoned task');
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('undelivered:');
        });

        it('crash-and-restart: a conductor rebuilt over the same journal refuses to redeliver what the crashed one already sent, and reports its unfinished task as lost', async () => {
            const sharedJournal = new FakeJournal();
            const a = build({ journal: sharedJournal });
            await openWith(a, 'sess-a');
            a.instances[0].emit(frames.taskStarted({ task_id: 'task-1', description: 'started by A' }));
            await flush();
            const sendFromA = jest.fn(() => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-1'] }));
            await a.conductor.deliver('env-E', sendFromA);

            // A crashes here: discarded without ever calling shutdown()/flush(). FakeJournal.append
            // is synchronous, so everything A wrote is already in `sharedJournal` regardless.
            sharedJournal.scriptReadSince(sharedJournal.entries());

            const b = build({ journal: sharedJournal });
            await openWith(b, 'sess-b');

            expect(sharedJournal.byKind('task_lost')).toEqual([
                { type: 'task_lost', at: expect.any(Date), taskId: 'task-1', description: 'started by A' },
            ]);

            const sendFromB = jest.fn(() => Promise.resolve({ channelId: 'chan-1', messageIds: ['msg-2'] }));
            const result = await b.conductor.deliver('env-E', sendFromB);

            expect(result).toEqual({ delivered: false });
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
});
