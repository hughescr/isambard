/**
 * Behavioural tests for {@link createConductor} (design doc section 6): the long-lived session
 * conductor. Every timing assertion runs on {@link FakeClock} — no real timers, no real delays.
 * Uses P3's {@link fakeQueryFn}/{@link FakeQuery} to drive the reader loop deterministically, and
 * the P3/P7 in-memory port doubles ({@link FakeJournal}, {@link FakeResumeStore}).
 */
import { afterEach, describe, expect, it, jest } from 'bun:test';
import type { SDKNotificationMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeClock } from '../../../helpers/fake-clock';
import { FakeJournal } from '../../../helpers/fake-journal';
import { fakeQueryFn, type FakeQuery } from '../../../helpers/fake-query';
import { FakeResumeStore } from '../../../helpers/fake-resume-store';
import * as frames from '../../../helpers/sdk-frames';
import { createConductor, type Conductor, type CreateConductorParams } from '@/agent/session/conductor';
import { createLedgerStore, type LedgerStore } from '@/agent/session/ledger';
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

        it('pushes the boot bundle as a boot envelope once open() resolves', async () => {
            const h = build({ bootBundle: 'welcome back' });

            await openWith(h);

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(JSON.stringify(h.instances[0].consumedPrompts[0].message)).toContain('welcome back');
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
                { type: 'envelope_submitted', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord' },
            ]);
            expect(h.ledgerStore.get().turn).toMatchObject({ kind: 'discord', channelId: 'chan-1' });

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;

            expect(result).toEqual({
                envelopeId: envelope.id, response: 'LAUNCHED', wasInterrupted: false, partialWork: expect.any(Object), sessionId: 'sess-1', isError: false,
            });
            expect(h.journal.byKind('turn_completed')).toEqual([
                { type: 'turn_completed', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord' },
            ]);
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

            expect(h.instances[0].consumedPrompts).toHaveLength(0);
            expect(h.ledgerStore.get().turn).toBeNull();

            h.ledgerStore.dispatch({ type: 'compaction_finished', at: new Date(h.clock.now()) });
            await flush();

            expect(h.instances[0].consumedPrompts).toHaveLength(1);
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

    describe('is_error retry via retryPolicy', () => {
        it('a transient error is resubmitted, and exhausting retryPolicy.maxAttempts journals turn_failed', async () => {
            const h = build();
            await openWith(h);
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'overloaded', api_error_status: 529 }));
            await flush();
            expect(h.instances[0].consumedPrompts).toHaveLength(1); // not yet resubmitted — waiting on the backoff timer

            h.clock.advance(FAST_RETRY_POLICY.baseDelayMs);
            await flush();
            expect(h.instances[0].consumedPrompts).toHaveLength(2); // resubmitted (attempt 2 of 2)

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
            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            h.clock.advance(1);
            await flush();
            expect(h.instances[0].consumedPrompts).toHaveLength(2);

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.isError).toBe(false);
        });

        it('a permanent error journals turn_failed immediately with no resubmission', async () => {
            const h = build();
            await openWith(h);
            const envelope = discordEnvelope();
            const resultPromise = h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'bad request', api_error_status: 400 }));
            const result = await resultPromise;

            expect(result.isError).toBe(true);
            expect(h.instances[0].consumedPrompts).toHaveLength(1);
            expect(h.journal.byKind('turn_failed')).toEqual([
                { type: 'turn_failed', at: expect.any(Date), envelopeId: envelope.id, kind: 'discord', error: 'bad request' },
            ]);
        });

        it('a retryable classification with retryAfterMs 0 resubmits immediately, with no clock advance needed', async () => {
            const classifyError = (): ErrorClassification => ({ category: 'rate_limited', retryAfterMs: 0, message: 'immediate retry' });
            const h = build({ classifyError });
            await openWith(h);
            const resultPromise = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            h.instances[0].emit(frames.resultSuccess({ is_error: true, result: 'retry me', api_error_status: 429 }));
            await flush();

            expect(h.instances[0].consumedPrompts).toHaveLength(2); // resubmitted with no clock.advance() call

            h.instances[0].emit(frames.resultSuccess());
            const result = await resultPromise;
            expect(result.isError).toBe(false);
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
            expect(h.instances[1].consumedPrompts).toHaveLength(1);

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
            expect(h.instances[0].consumedPrompts).toHaveLength(0);
            expect(h.instances[1].consumedPrompts).toHaveLength(0);

            h.instances[1].emit(frames.init('sess-1'));
            await flush();

            expect(h.instances[1].consumedPrompts).toHaveLength(1);

            h.instances[1].emit(frames.resultSuccess());
            const result = await pendingSubmit;
            expect(result.isError).toBe(false);
        });

        it('when both the resume and the fresh-open fallback fail, the in-flight and queued submits are rejected rather than hanging forever', async () => {
            const h = build();
            await openWith(h, 'sess-1');
            const inFlight = h.conductor.submit(discordEnvelope(), { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();
            const queued = h.conductor.submit(discordEnvelope(), { priority: 'other' });
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
            const envelope = discordEnvelope();
            void h.conductor.submit(envelope, { priority: 'human', requestingChannelId: 'chan-1' });
            await flush();

            expect(h.conductor.status()).toMatchObject({
                role: 'conversation', sessionId: 'sess-status', opened: true, turn: { kind: 'discord', channelId: 'chan-1', envelopeId: envelope.id },
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
});
