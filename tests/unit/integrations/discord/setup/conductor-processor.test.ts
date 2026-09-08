/**
 * Behavioural tests for {@link createConductorProcessor} (P9): bridges the long-lived
 * conversation conductor onto Discord's `MessageProcessor` contract. Uses a hand-rolled fake
 * {@link Conductor} (this module's own contract, not P7's) driving the REAL
 * {@link MessageCoordinator} under fake timers, so the coordinator's own debounce/interrupt/
 * requeue behaviour is exercised exactly as production wires it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Message } from 'discord.js';
import { DateTime } from 'luxon';
import * as agentModule from '@/agent';
import {
    type AgendaEntry, type Conductor, type ConductorStatus, type ContextPolicy, type DiscordEnvelopeInput, type SubmitOptions, type TurnResult, StreamTracker
} from '@/agent';
import type { Envelope } from '@/agent/session/types';
import { formatCalendarContext, type CalendarEvent } from '@/integrations/caldav';
import { MessageCoordinator } from '@/integrations/discord/message-coordinator';
import * as presenceModule from '@/integrations/discord/presence';
import { createConductorProcessor, type DiscordEnvelopeProvider } from '@/integrations/discord/setup/conductor-processor';
import type { ResolvedDiscordNames } from '@/integrations/discord/setup/discord-envelope-provider';
import { createChannelId, createGuildId, createUserId, type DiscordMessageContext } from '@/integrations/discord/types';
import { formatEnvelopeStamp, formatTimeHeader } from '@/utils';

/** A hand-rolled fake `Conductor`: `submit` never resolves on its own — tests settle it explicitly
 * via `settleOldest`/`settleByEnvelopeId`, or let the caller's own `signal` abort it (mirroring
 * the real conductor's withdraw contract). `subscribeTurn` lets tests push frames by turn id. */
class FakeConductor implements Conductor {
    readonly submitCalls:     { envelope: Envelope, options: SubmitOptions }[] = [];
    private readonly pending: { envelope: Envelope, resolve: (result: TurnResult) => void }[] = [];
    private readonly subscribers = new Set<(turnId: string, frame: unknown) => void>();

    submit = (envelope: Envelope, options: SubmitOptions): Promise<TurnResult> => {
        this.submitCalls.push({ envelope, options });
        return new Promise<TurnResult>((resolve) => {
            const { signal } = options;
            if(signal) {
                if(signal.aborted) {
                    resolve(this.withdrawnResult(envelope));
                    return;
                }
                signal.addEventListener('abort', () => {
                    resolve(this.withdrawnResult(envelope));
                }, { once: true });
            }
            this.pending.push({ envelope, resolve });
        });
    };

    private withdrawnResult(envelope: Envelope): TurnResult {
        return {
            envelopeId: envelope.id, response: null, wasInterrupted: true, partialWork: new StreamTracker().getProgress(), sessionId: undefined, isError: false, contextUsagePercent: 3, outcome: 'withdrawn',
        };
    }

    /** Resolves the oldest still-pending `submit()` call with `overrides` merged onto a plain success result. */
    settleOldest(overrides: Partial<TurnResult> = {}): Envelope {
        const next = this.pending.shift();
        if(!next) {
            throw new Error('FakeConductor.settleOldest: no pending submit() call');
        }
        next.resolve({
            envelopeId: next.envelope.id, response: 'ok', wasInterrupted: false, partialWork: new StreamTracker().getProgress(), sessionId: 'sess-1', isError: false, contextUsagePercent: 42, ...overrides,
        });
        return next.envelope;
    }

    emitFrame(turnId: string, frame: unknown): void {
        for(const handler of this.subscribers) {
            handler(turnId, frame);
        }
    }

    subscribeTurn = (handler: (turnId: string, frame: never) => void): (() => void) => {
        this.subscribers.add(handler as (turnId: string, frame: unknown) => void);
        return () => {
            this.subscribers.delete(handler as (turnId: string, frame: unknown) => void);
        };
    };

    open = (): Promise<{ sessionId: string, resumed: boolean }> => Promise.resolve({ sessionId: 'sess-1', resumed: false });
    appendWithoutTurn = (): void => { throw new Error('FakeConductor.appendWithoutTurn is unused by conductor-processor.ts'); };
    deliver = (): Promise<never> => Promise.reject(new Error('FakeConductor.deliver is unused by conductor-processor.ts'));
    interruptCurrent = (): Promise<void> => Promise.resolve();
    status = (): ConductorStatus => ({
        role: 'conversation', sessionId: 'sess-1', opened: true, shuttingDown: false, queueLength: this.pending.length, turn: null,
    });

    shutdown = (): Promise<void> => Promise.resolve();

    private thresholdPercent = 60;
    getCompactionThresholdPercent = (): number => this.thresholdPercent;
    setCompactionThresholdPercent = (percent: number): void => { this.thresholdPercent = percent; };
}

function makeContextPolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
    return {
        shouldInjectUserMemory: jest.fn(() => true),
        markInjected:           jest.fn(),
        resetAll:               jest.fn(),
        eventsDelta:            jest.fn(() => Promise.resolve([])),
        markEventsSeen:         jest.fn(),
        stateTopSetDelta:       jest.fn(() => Promise.resolve({ added: [], removed: [], changed: [] })),
        markStateTopSetSeen:    jest.fn(() => Promise.resolve()),
        calendarDelta:          jest.fn(() => Promise.resolve({ agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false })),
        markCalendarSeen:       jest.fn(),
        healthNote:             jest.fn(() => undefined),
        markHealthSeen:         jest.fn(),
        ...overrides,
    };
}

function makeEnvelopeProvider(overrides: Partial<DiscordEnvelopeProvider> = {}): DiscordEnvelopeProvider {
    const resolveNames = jest.fn((context: DiscordMessageContext): Promise<ResolvedDiscordNames> => Promise.resolve({
        channelName: 'general', guildName: 'My Guild', authorName: context.username ?? context.userId, isDM: false,
    }));
    const toEnvelopeInput = jest.fn((contexts: DiscordMessageContext[], names: ResolvedDiscordNames, images, channelList: string[]): DiscordEnvelopeInput => {
        const first = contexts[0];
        return {
            messageId:   first.messageId,
            channelId:   first.channelId,
            channelName: names.channelName,
            guildName:   names.guildName,
            authorId:    first.userId,
            authorName:  names.authorName,
            content:     contexts.map(c => c.content).join('\n\n'),
            createdAt:   new Date(first.timestamp),
            images:      images.length > 0 ? images : undefined,
            isDM:        names.isDM,
            channelList,
        };
    });
    const channelList = jest.fn(() => Promise.resolve(['general', 'random']));
    return { resolveNames, toEnvelopeInput, channelList, ...overrides };
}

function makeContextBuilder(overrides: { loadUserTimezone?: ReturnType<typeof jest.fn>, loadUserMemories?: ReturnType<typeof jest.fn> } = {}) {
    return {
        loadUserTimezone: jest.fn(() => Promise.resolve(undefined)),
        loadUserMemories: jest.fn(() => Promise.resolve('')),
        ...overrides,
    };
}

function makeLogger() {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function makeContext(overrides: Partial<DiscordMessageContext> = {}): DiscordMessageContext {
    return {
        guildId:   createGuildId('guild-1'),
        channelId: createChannelId('chan-1'),
        userId:    createUserId('user-1'),
        username:  'craig',
        messageId: 'msg-1',
        content:   'hello',
        timestamp: new Date(0).toISOString(),
        botUserId: createUserId('bot-1'),
        ...overrides,
    };
}

/** Flushes enough microtask ticks for the processor's own promise chain (attachments, Promise.all, envelope build, submit) to settle. */
async function flush(): Promise<void> {
    for(let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- deterministic microtask-drain helper used only in tests, not a real async loop
        await Promise.resolve();
    }
}

function makeDiscordMessage(channelId: string, id: string, content: string): Message {
    return {
        id, content, channelId, channel: { id: channelId, isDMBased: () => false },
    } as unknown as Message;
}

describe('createConductorProcessor', () => {
    let conductor: FakeConductor;
    let contextPolicy: ContextPolicy;
    let envelopeProvider: DiscordEnvelopeProvider;
    let contextBuilder: ReturnType<typeof makeContextBuilder>;
    let logger: ReturnType<typeof makeLogger>;
    let resolveTimezone: ReturnType<typeof jest.fn>;
    let coordinator: MessageCoordinator;
    let processor: ReturnType<typeof createConductorProcessor>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);
        conductor = new FakeConductor();
        contextPolicy = makeContextPolicy();
        envelopeProvider = makeEnvelopeProvider();
        contextBuilder = makeContextBuilder();
        logger = makeLogger();
        resolveTimezone = jest.fn((tz?: string) => tz ?? 'America/Los_Angeles');

        processor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator = new MessageCoordinator({ debounceMs: 100 });
        coordinator.setProcessor(processor);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        coordinator.stop();
        jest.useRealTimers();
    });

    it('submits one envelope naming the resolved channel/author, and injects the user memory block on first contact', async () => {
        coordinator.handleMessage(makeContext(), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(conductor.submitCalls).toHaveLength(1);
        const { envelope, options } = conductor.submitCalls[0];
        expect(envelope.kind).toBe('discord');
        expect(envelope.channelId).toBe('chan-1');
        expect(envelope.authorId).toBe('user-1');
        expect(envelope.text).toContain('general');
        expect(options).toMatchObject({ priority: 'human', requestingChannelId: 'chan-1' });
        expect(contextPolicy.shouldInjectUserMemory).toHaveBeenCalledWith('user-1');
        expect(contextBuilder.loadUserMemories).toHaveBeenCalledWith('user-1');
    });

    it('debounce-interrupts a held envelope into exactly one merged resubmission — no duplicate submit', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-A1', content: 'first' }), makeDiscordMessage('chan-1', 'msg-A1', 'first'));
        await flush();
        expect(conductor.submitCalls).toHaveLength(1);

        // A2 arrives while A1 is still held by the fake conductor (never settled) — queued, not
        // interrupted yet (debounce has not expired).
        coordinator.handleMessage(makeContext({ messageId: 'msg-A2', content: 'second' }), makeDiscordMessage('chan-1', 'msg-A2', 'second'));
        expect(conductor.submitCalls).toHaveLength(1);

        // Debounce expires: the coordinator aborts A1's signal, which the fake conductor resolves
        // as withdrawn, and the coordinator immediately resubmits A1+A2 merged into one call.
        jest.advanceTimersByTime(100);
        await flush();

        expect(conductor.submitCalls).toHaveLength(2);
        expect(conductor.submitCalls[1].envelope.text).toContain('first');
        expect(conductor.submitCalls[1].envelope.text).toContain('second');

        conductor.settleOldest();
        await flush();

        expect(conductor.submitCalls).toHaveLength(2);
    });

    it('preserves an interrupted turn\'s real stream progress for the next submit\'s resume context', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-A1' }), makeDiscordMessage('chan-1', 'msg-A1', 'first'));
        await flush();
        const firstEnvelope = conductor.submitCalls[0].envelope;

        coordinator.handleMessage(makeContext({ messageId: 'msg-A2', content: 'second' }), makeDiscordMessage('chan-1', 'msg-A2', 'second'));

        // The turn produces real partial progress before the debounce interrupts it.
        conductor.emitFrame(firstEnvelope.id, {
            type: 'assistant', message: { content: [{ type: 'text', text: 'partial reply' }] },
        });

        jest.advanceTimersByTime(100);
        await flush();

        // message-coordinator.ts forwards partialWork into the NEXT processor call's
        // resumeContext only when hasMeaningfulProgress() was true (its own, already-covered
        // contract — message-coordinator.test.ts, untouched by this package); this processor's
        // own job, asserted directly here, is turning that resumeContext into a [RESUME NOTE]
        // block on the resubmitted envelope so the partial work actually reaches Claude.
        expect(conductor.submitCalls).toHaveLength(2);
        const resumedEnvelope = conductor.submitCalls[1].envelope;
        expect(resumedEnvelope.text).toContain('[RESUME NOTE]');
        expect(resumedEnvelope.text).toContain('partial reply');
    });

    it('submits no [RESUME NOTE] section on a fresh (non-resumed) turn', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(conductor.submitCalls[0].envelope.text).not.toContain('[RESUME NOTE]');
    });

    it('ignores a frame emitted for a different turn\'s id (subscribeTurn\'s per-turn filter)', async () => {
        // Two independent channels run concurrently against the fake conductor (channel
        // independence — message-coordinator.ts's own contract).
        coordinator.handleMessage(makeContext({ channelId: createChannelId('chan-A'), messageId: 'msg-A1' }), makeDiscordMessage('chan-A', 'msg-A1', 'first'));
        await flush();
        const envelopeA = conductor.submitCalls[0].envelope;

        coordinator.handleMessage(makeContext({ channelId: createChannelId('chan-B'), messageId: 'msg-B1' }), makeDiscordMessage('chan-B', 'msg-B1', 'other channel'));
        await flush();
        const envelopeB = conductor.submitCalls[1].envelope;

        // A's own turn produces real progress...
        conductor.emitFrame(envelopeA.id, {
            type: 'assistant', message: { content: [{ type: 'text', text: 'own progress on A' }] },
        });
        // ...but a frame tagged with B's turn id must never reach A's StreamTracker.
        conductor.emitFrame(envelopeB.id, {
            type: 'assistant', message: { content: [{ type: 'text', text: 'unrelated to A' }] },
        });

        // Interrupt A via the debounce path so its captured progress surfaces in its own resume note.
        coordinator.handleMessage(makeContext({ channelId: createChannelId('chan-A'), messageId: 'msg-A2', content: 'second' }), makeDiscordMessage('chan-A', 'msg-A2', 'second'));
        jest.advanceTimersByTime(100);
        await flush();

        const resumedA = conductor.submitCalls.find(call => call.envelope.text.includes('[RESUME NOTE]'));
        expect(resumedA).toBeDefined();
        expect(resumedA!.envelope.text).toContain('own progress on A');
        expect(resumedA!.envelope.text).not.toContain('unrelated to A');
    });

    it('processing an empty context batch directly returns a null response with no submit, and warns', async () => {
        const result = await processor([], null, new AbortController().signal);

        expect(result).toEqual({ response: null, wasInterrupted: false, streamTracker: expect.any(StreamTracker) });
        expect(conductor.submitCalls).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.any(String));
    });

    it('logs contextUsagePercent on every settled result, including a withdrawn one', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-A1' }), makeDiscordMessage('chan-1', 'msg-A1', 'first'));
        await flush();
        conductor.settleOldest({ contextUsagePercent: 17 });
        await flush();

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ contextUsagePercent: 17 }), 'Conductor turn settled');

        logger.info.mockClear();

        coordinator.handleMessage(makeContext({ messageId: 'msg-B1' }), makeDiscordMessage('chan-1', 'msg-B1', 'held'));
        await flush();
        coordinator.handleMessage(makeContext({ messageId: 'msg-B2', content: 'second' }), makeDiscordMessage('chan-1', 'msg-B2', 'second'));
        jest.advanceTimersByTime(100);
        await flush();

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ contextUsagePercent: 3, outcome: 'withdrawn' }), 'Conductor turn settled');
    });

    it('marks the memory block injected only when it was actually shown, but still marks events seen for a completed turn', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();
        expect(contextBuilder.loadUserMemories).toHaveBeenCalledWith('user-1');

        conductor.settleOldest();
        await flush();
        expect(contextPolicy.markInjected).toHaveBeenCalledTimes(1);
        expect(contextPolicy.markInjected).toHaveBeenCalledWith('user-1');
        expect(contextPolicy.markEventsSeen).toHaveBeenCalledTimes(1);
    });

    it('does not mark the memory injected when shouldInjectUserMemory returned false, even though the turn completed (a user active within the window must not have their re-injection deferred)', async () => {
        contextPolicy = makeContextPolicy({ shouldInjectUserMemory: jest.fn(() => false) });
        const noInjectProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(noInjectProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();
        expect(contextBuilder.loadUserMemories).not.toHaveBeenCalled();

        conductor.settleOldest();
        await flush();
        expect(contextPolicy.markInjected).not.toHaveBeenCalled();
        expect(contextPolicy.markEventsSeen).toHaveBeenCalledTimes(1);
    });

    it('skips both context-policy marks for a withdrawn turn', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-2' }), makeDiscordMessage('chan-1', 'msg-2', 'held'));
        await flush();
        coordinator.handleMessage(makeContext({ messageId: 'msg-3', content: 'third' }), makeDiscordMessage('chan-1', 'msg-3', 'third'));
        jest.advanceTimersByTime(100);
        await flush();

        expect(contextPolicy.markInjected).not.toHaveBeenCalled();
        expect(contextPolicy.markEventsSeen).not.toHaveBeenCalled();
    });

    it('passes newEvents as undefined to buildDiscordEnvelope when eventsDelta() resolves an empty array', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        // makeContextPolicy's default eventsDelta already resolves [].

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ newEvents: undefined }));
    });

    it('passes newEvents through to buildDiscordEnvelope verbatim when eventsDelta() resolves a non-empty array', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        const events = ['- event one', '- event two'];
        contextPolicy = makeContextPolicy({ eventsDelta: jest.fn(() => Promise.resolve(events)) });
        const eventsProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(eventsProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ newEvents: events }));
    });

    it('passes channelList as undefined to buildDiscordEnvelope when the resolved channel list is empty', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        envelopeProvider = makeEnvelopeProvider({ channelList: jest.fn(() => Promise.resolve([])) });
        const emptyChannelsProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(emptyChannelsProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ channelList: undefined }));
    });

    it('joins a non-empty channel list with a newline before passing it to buildDiscordEnvelope', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        // makeEnvelopeProvider's default channelList() already resolves ['general', 'random'].

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ channelList: 'general\nrandom' }));
    });

    it('fetches stateTopSetDelta() alongside eventsDelta() and passes its resolved value through to buildDiscordEnvelope\'s stateChanged param', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        const delta = { added: ['state/one'], removed: ['state/two'], changed: ['state/three'] };
        contextPolicy = makeContextPolicy({ stateTopSetDelta: jest.fn(() => Promise.resolve(delta)) });
        const stateChangedProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(stateChangedProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(contextPolicy.stateTopSetDelta).toHaveBeenCalledTimes(1);
        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: delta }));
    });

    it('passes stateChanged as undefined to buildDiscordEnvelope when all three delta lists are empty', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: undefined }));
    });

    it('marks the state top set seen for a completed (non-withdrawn) turn', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();
        conductor.settleOldest();
        await flush();

        expect(contextPolicy.markStateTopSetSeen).toHaveBeenCalledTimes(1);
    });

    it('passes stateChanged through to buildDiscordEnvelope when only added is non-empty', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        const delta = { added: ['state/x'], removed: [], changed: [] };
        contextPolicy = makeContextPolicy({ stateTopSetDelta: jest.fn(() => Promise.resolve(delta)) });
        const addedOnlyProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(addedOnlyProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: delta }));
    });

    it('passes stateChanged through to buildDiscordEnvelope when only removed is non-empty', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        const delta = { added: [], removed: ['state/y'], changed: [] };
        contextPolicy = makeContextPolicy({ stateTopSetDelta: jest.fn(() => Promise.resolve(delta)) });
        const removedOnlyProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(removedOnlyProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: delta }));
    });

    it('does not mark the state top set seen for a withdrawn turn', async () => {
        coordinator.handleMessage(makeContext({ messageId: 'msg-2' }), makeDiscordMessage('chan-1', 'msg-2', 'held'));
        await flush();
        coordinator.handleMessage(makeContext({ messageId: 'msg-3', content: 'third' }), makeDiscordMessage('chan-1', 'msg-3', 'third'));
        jest.advanceTimersByTime(100);
        await flush();

        expect(contextPolicy.markStateTopSetSeen).not.toHaveBeenCalled();
    });

    it('passes stateChanged through to buildDiscordEnvelope when only one of the three delta lists is non-empty', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        const delta = { added: [], removed: [], changed: ['state/x'] };
        contextPolicy = makeContextPolicy({ stateTopSetDelta: jest.fn(() => Promise.resolve(delta)) });
        const singleChangeProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(singleChangeProcessor);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ stateChanged: delta }));
    });

    it('does not drop a completed turn\'s response when markStateTopSetSeen rejects; logs a warning and still marks the memory injection instead', async () => {
        const markStateTopSetSeenError = new Error('DynamoDB throttled');
        contextPolicy = makeContextPolicy({ markStateTopSetSeen: jest.fn(() => Promise.reject(markStateTopSetSeenError)) });
        const flakyProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });

        const resultPromise = flakyProcessor([makeContext({ messageId: 'msg-1' })], null, new AbortController().signal);
        await flush();
        conductor.settleOldest({ response: 'the answer' });

        const result = await resultPromise;

        expect(result.response).toBe('the answer');
        expect(contextPolicy.markInjected).toHaveBeenCalledWith('user-1');
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: markStateTopSetSeenError }), 'markStateTopSetSeen failed; state top-set baseline not updated this turn');
    });

    describe('Q12: calendar delta and health note wiring', () => {
        function makeAgendaEntry(overrides: Partial<AgendaEntry> = {}): AgendaEntry {
            return {
                uid:      'evt-1',
                start:    '2026-09-04T16:00:00.000Z',
                end:      '2026-09-04T17:00:00.000Z',
                summary:  'Team sync',
                isAllDay: false,
                ...overrides,
            };
        }

        /** Mirrors `conductor-processor.ts`'s own `formatAgendaLine`: `HH:mm–HH:mm summary` in `America/Los_Angeles`, computed via luxon rather than hardcoded so it is not sensitive to the fake-timers-active DST-offset quirk (see the module's own note near `formatAgendaLine`). */
        function expectedAgendaLine(entry: AgendaEntry): string {
            if(entry.isAllDay) {
                return `All day: ${entry.summary}`;
            }
            const start = DateTime.fromISO(entry.start, { zone: 'America/Los_Angeles' }).toFormat('HH:mm');
            const end = DateTime.fromISO(entry.end, { zone: 'America/Los_Angeles' }).toFormat('HH:mm');
            return `${start}–${end} ${entry.summary}`;
        }

        function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
            return {
                uid:           'evt-1',
                summary:       'Team sync',
                start:         new Date('2026-09-04T16:00:00.000Z'),
                end:           new Date('2026-09-04T17:00:00.000Z'),
                isAllDay:      false,
                calendarLabel: 'Work',
                ...overrides,
            };
        }

        it('resolves the author\'s own timezone before calling calendarDelta, not the server fallback', async () => {
            contextBuilder = makeContextBuilder({ loadUserTimezone: jest.fn(() => Promise.resolve('Europe/London')) });
            const calendarDeltaSpy = jest.fn(() => Promise.resolve({
                agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false,
            }));
            contextPolicy = makeContextPolicy({ calendarDelta: calendarDeltaSpy });
            const londonCalendarProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(londonCalendarProcessor);

            coordinator.handleMessage(makeContext({ userId: createUserId('user-42') }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(calendarDeltaSpy).toHaveBeenCalledWith('user-42', 'Europe/London');
        });

        it('passes calendarChanged (agenda text via formatCalendarContext, +/-/~ lines from the AgendaEntry lists) and healthNote through to buildDiscordEnvelope', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const event = makeCalendarEvent();
            const addedEntry = makeAgendaEntry();
            const removedEntry = makeAgendaEntry({ uid: 'evt-2', summary: 'Old meeting' });
            const changedEntry = makeAgendaEntry({ uid: 'evt-3', summary: 'Moved lunch', isAllDay: true });
            const delta = {
                agenda: [addedEntry], events: [event], added: [addedEntry], removed: [removedEntry], changed: [changedEntry], isFirst: false, polled: true,
            };
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve(delta)),
                healthNote:    jest.fn(() => 'Email is degraded.'),
            });
            const calendarProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(calendarProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            const expectedAgendaText = formatCalendarContext([event], new Date(1000), 'America/Los_Angeles');
            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({
                calendarChanged: {
                    agenda:  expectedAgendaText,
                    added:   [expectedAgendaLine(addedEntry)],
                    removed: [expectedAgendaLine(removedEntry)],
                    changed: [expectedAgendaLine(changedEntry)],
                    isFirst: false,
                },
                healthNote: 'Email is degraded.',
            }));
        });

        it('passes calendarChanged and healthNote as undefined with no calendar service and an all-online registry (byte-identical to Q9 output)', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            // makeContextPolicy's defaults already model "no calendar service, all-online
            // registry": calendarDelta resolves an empty, non-first delta and healthNote()
            // resolves undefined.

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ calendarChanged: undefined, healthNote: undefined }));
        });

        it('passes calendarChanged as undefined when isFirst is false, nothing changed, and the agenda is non-empty (must not re-inject an unchanged agenda every turn)', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const event = makeCalendarEvent();
            const entry = makeAgendaEntry();
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [entry], events: [event], added: [], removed: [], changed: [], isFirst: false, polled: true,
                })),
            });
            const unchangedNonFirstProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(unchangedNonFirstProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ calendarChanged: undefined }));
        });

        it('passes calendarChanged through when only added is non-empty', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const event = makeCalendarEvent();
            const addedEntry = makeAgendaEntry();
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [addedEntry], events: [event], added: [addedEntry], removed: [], changed: [], isFirst: false, polled: true,
                })),
            });
            const onlyAddedProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(onlyAddedProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({
                calendarChanged: expect.objectContaining({ added: [expectedAgendaLine(addedEntry)], removed: [], changed: [] }),
            }));
        });

        it('passes calendarChanged through when only removed is non-empty', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const removedEntry = makeAgendaEntry({ uid: 'evt-2', summary: 'Old meeting' });
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [], events: [], added: [], removed: [removedEntry], changed: [], isFirst: false, polled: true,
                })),
            });
            const onlyRemovedProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(onlyRemovedProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({
                calendarChanged: expect.objectContaining({ added: [], removed: [expectedAgendaLine(removedEntry)], changed: [] }),
            }));
        });

        it('passes calendarChanged through when only changed is non-empty', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const changedEntry = makeAgendaEntry({ uid: 'evt-3', summary: 'Moved lunch', isAllDay: true });
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [], events: [], added: [], removed: [], changed: [changedEntry], isFirst: false, polled: true,
                })),
            });
            const onlyChangedProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(onlyChangedProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({
                calendarChanged: expect.objectContaining({ added: [], removed: [], changed: [expectedAgendaLine(changedEntry)] }),
            }));
        });

        it('passes calendarChanged as undefined on a genuine first poll with an empty agenda (nothing worth showing)', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [], events: [], added: [], removed: [], changed: [], isFirst: true, polled: true,
                })),
            });
            const firstPollProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(firstPollProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ calendarChanged: undefined }));
        });

        it('passes calendarChanged through on a genuine first poll with a non-empty agenda', async () => {
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            const event = makeCalendarEvent();
            const entry = makeAgendaEntry();
            contextPolicy = makeContextPolicy({
                calendarDelta: jest.fn(() => Promise.resolve({
                    agenda: [entry], events: [event], added: [], removed: [], changed: [], isFirst: true, polled: true,
                })),
            });
            const firstPollProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            coordinator.setProcessor(firstPollProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            const expectedAgendaText = formatCalendarContext([event], new Date(1000), 'America/Los_Angeles');
            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({
                calendarChanged: {
                    agenda: expectedAgendaText, added: [], removed: [], changed: [], isFirst: true,
                },
            }));
        });

        it('logs a warning and still sends the envelope without a calendar section when calendarDelta rejects', async () => {
            const calendarDeltaError = new Error('CalDAV timeout');
            contextPolicy = makeContextPolicy({ calendarDelta: jest.fn(() => Promise.reject(calendarDeltaError)) });
            const flakyCalendarProcessor = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
            });
            const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
            coordinator.setProcessor(flakyCalendarProcessor);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(conductor.submitCalls).toHaveLength(1);
            expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ calendarChanged: undefined }));
            expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: calendarDeltaError }), expect.stringContaining('calendarDelta'));
        });

        it('marks the calendar and health seen for a completed (non-withdrawn) turn', async () => {
            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();
            conductor.settleOldest();
            await flush();

            expect(contextPolicy.markCalendarSeen).toHaveBeenCalledWith('user-1');
            expect(contextPolicy.markHealthSeen).toHaveBeenCalledTimes(1);
        });

        it('does not mark the calendar or health seen for a withdrawn turn', async () => {
            coordinator.handleMessage(makeContext({ messageId: 'msg-2' }), makeDiscordMessage('chan-1', 'msg-2', 'held'));
            await flush();
            coordinator.handleMessage(makeContext({ messageId: 'msg-3', content: 'third' }), makeDiscordMessage('chan-1', 'msg-3', 'third'));
            jest.advanceTimersByTime(100);
            await flush();

            expect(contextPolicy.markCalendarSeen).not.toHaveBeenCalled();
            expect(contextPolicy.markHealthSeen).not.toHaveBeenCalled();
        });
    });

    it('resolves the author\'s stored timezone through resolveTimezone\'s fallback for the envelope stamp', async () => {
        contextBuilder = makeContextBuilder({ loadUserTimezone: jest.fn(() => Promise.resolve('Europe/London')) });
        const londonProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(londonProcessor);

        coordinator.handleMessage(makeContext({ userId: createUserId('user-42') }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(contextBuilder.loadUserTimezone).toHaveBeenCalledWith('user-42');
        expect(resolveTimezone).toHaveBeenCalledWith('Europe/London');
    });

    it('renders the envelope stamp and time header in the author\'s stored zone, not the server zone (folded gap 1)', async () => {
        contextBuilder = makeContextBuilder({ loadUserTimezone: jest.fn(() => Promise.resolve('Europe/London')) });
        const londonProcessor = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(londonProcessor);

        coordinator.handleMessage(makeContext({ userId: createUserId('user-42') }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        const expectedStamp = formatEnvelopeStamp(new Date(1000), 'Europe/London');
        const expectedTimeHeader = formatTimeHeader('Europe/London');
        const text = conductor.submitCalls[0].envelope.text;
        expect(text).toContain(expectedStamp);
        expect(text).toContain(expectedTimeHeader);
        // Distinguishing check: the server-zone fallback resolveTimezone(undefined) would resolve
        // is asserted NOT to have been passed to resolveTimezone at all in this scenario.
        expect(resolveTimezone).not.toHaveBeenCalledWith(undefined);
    });

    it('passes a non-empty user memory block through to buildDiscordEnvelope verbatim', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        contextBuilder = makeContextBuilder({ loadUserMemories: jest.fn(() => Promise.resolve('Craig likes TypeScript.')) });
        const processorWithMemories = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(processorWithMemories);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ userMemoryBlock: 'Craig likes TypeScript.' }));
    });

    it('passes userMemoryBlock as undefined — never the empty string itself — when loadUserMemories resolves ""', async () => {
        const buildDiscordEnvelopeSpy = jest.spyOn(agentModule, 'buildDiscordEnvelope');
        // makeContextBuilder's default loadUserMemories already resolves ''.
        const processorEmptyMemory = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger,
        });
        coordinator.setProcessor(processorEmptyMemory);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(buildDiscordEnvelopeSpy).toHaveBeenCalledWith(expect.objectContaining({ userMemoryBlock: undefined }));
    });

    it('unsubscribes from the turn stream and completes the ledger handler once submit resolves', async () => {
        const ledgerStore = { dispatch: jest.fn() };
        const throttle = { shouldUpdate: jest.fn(() => true), record: jest.fn() };

        const unsubscribeSpies: ReturnType<typeof jest.fn>[] = [];
        const originalSubscribeTurn = conductor.subscribeTurn.bind(conductor);
        jest.spyOn(conductor, 'subscribeTurn').mockImplementation((handler) => {
            const realUnsubscribe = originalSubscribeTurn(handler);
            const wrapped = jest.fn(realUnsubscribe);
            unsubscribeSpies.push(wrapped);
            return wrapped;
        });

        const completeSpies: ReturnType<typeof jest.fn>[] = [];
        const originalCreateLedgerStreamEventHandler = presenceModule.createLedgerStreamEventHandler;
        jest.spyOn(presenceModule, 'createLedgerStreamEventHandler').mockImplementation((deps) => {
            const real = originalCreateLedgerStreamEventHandler(deps);
            const wrappedComplete = jest.fn(real.complete);
            completeSpies.push(wrappedComplete);
            return { ...real, complete: wrappedComplete };
        });

        const processorWithLedger = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle,
        });
        coordinator.setProcessor(processorWithLedger);

        coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
        await flush();

        expect(unsubscribeSpies).toHaveLength(1);
        expect(unsubscribeSpies[0]).not.toHaveBeenCalled();
        expect(completeSpies[0]).not.toHaveBeenCalled();

        conductor.settleOldest();
        await flush();

        expect(unsubscribeSpies[0]).toHaveBeenCalledTimes(1);
        expect(completeSpies[0]).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from the turn stream and completes the ledger handler even when submit rejects', async () => {
        const ledgerStore = { dispatch: jest.fn() };
        const throttle = { shouldUpdate: jest.fn(() => true), record: jest.fn() };

        const unsubscribeSpies: ReturnType<typeof jest.fn>[] = [];
        const originalSubscribeTurn = conductor.subscribeTurn.bind(conductor);
        jest.spyOn(conductor, 'subscribeTurn').mockImplementation((handler) => {
            const realUnsubscribe = originalSubscribeTurn(handler);
            const wrapped = jest.fn(realUnsubscribe);
            unsubscribeSpies.push(wrapped);
            return wrapped;
        });

        const completeSpies: ReturnType<typeof jest.fn>[] = [];
        const originalCreateLedgerStreamEventHandler = presenceModule.createLedgerStreamEventHandler;
        jest.spyOn(presenceModule, 'createLedgerStreamEventHandler').mockImplementation((deps) => {
            const real = originalCreateLedgerStreamEventHandler(deps);
            const wrappedComplete = jest.fn(real.complete);
            completeSpies.push(wrappedComplete);
            return { ...real, complete: wrappedComplete };
        });

        const submitError = new Error('conductor exploded');
        jest.spyOn(conductor, 'submit').mockImplementation(() => Promise.reject(submitError));

        const processorWithLedger = createConductorProcessor({
            conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle,
        });

        const resultPromise = processorWithLedger([makeContext({ messageId: 'msg-1' })], null, new AbortController().signal);

        await expect(resultPromise).rejects.toThrow('conductor exploded');

        expect(unsubscribeSpies).toHaveLength(1);
        expect(unsubscribeSpies[0]).toHaveBeenCalledTimes(1);
        expect(completeSpies).toHaveLength(1);
        expect(completeSpies[0]).toHaveBeenCalledTimes(1);
    });

    describe('P11: ledger-sink presence wiring', () => {
        function makeThrottle() {
            return { shouldUpdate: jest.fn(() => true), record: jest.fn() };
        }

        it('dispatches a phase_synopsis event to the ledger sink for the submitted turn\'s own id', async () => {
            const ledgerStore = { dispatch: jest.fn() };
            const dynamicStatusGenerator = { generateSynopsis: jest.fn(() => Promise.resolve('a fresh synopsis')), generateCatchUpSynopsis: jest.fn() };
            const processorWithLedger = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle: makeThrottle(), dynamicStatusGenerator,
            });
            coordinator.setProcessor(processorWithLedger);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();
            const { envelope } = conductor.submitCalls[0];

            conductor.emitFrame(envelope.id, {
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            });
            await flush();

            expect(ledgerStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
                type: 'phase_synopsis', turnId: envelope.id, phaseType: 'using_tool', text: 'a fresh synopsis',
            }));
        });

        it('never dispatches to the ledger sink when ledgerStore/throttle are not provided (backward compatible)', async () => {
            // `processor` (built in beforeEach) has neither ledgerStore nor throttle — this just
            // re-confirms the existing suite's processor still works without them (no throw).
            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();
            const { envelope } = conductor.submitCalls[0];

            expect(() => {
                conductor.emitFrame(envelope.id, {
                    type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
                });
            }).not.toThrow();
        });

        it('forwards onThinkingContentUpdate to the ledger-sink handler', async () => {
            const ledgerStore = { dispatch: jest.fn() };
            const dynamicStatusGenerator = { generateSynopsis: jest.fn(() => Promise.resolve('a fresh synopsis')), generateCatchUpSynopsis: jest.fn() };
            const onThinkingContentUpdate = jest.fn();
            const processorWithLedger = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle: makeThrottle(), dynamicStatusGenerator, onThinkingContentUpdate,
            });
            coordinator.setProcessor(processorWithLedger);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();
            const { envelope } = conductor.submitCalls[0];

            conductor.emitFrame(envelope.id, {
                type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'pondering' }] },
            });
            await flush();

            expect(onThinkingContentUpdate).toHaveBeenCalledWith('pondering');
        });

        it('pre-generates a thinking synopsis (peeking the throttle, not a BotStateManager) so the first thinking phase carries a synopsis with no accumulated context yet', async () => {
            const ledgerStore = { dispatch: jest.fn() };
            const dynamicStatusGenerator = { generateSynopsis: jest.fn(() => Promise.resolve('pre-generated synopsis')), generateCatchUpSynopsis: jest.fn() };
            const throttle = makeThrottle();
            const processorWithLedger = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle, dynamicStatusGenerator,
            });
            coordinator.setProcessor(processorWithLedger);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();
            const { envelope } = conductor.submitCalls[0];

            expect(dynamicStatusGenerator.generateSynopsis).toHaveBeenCalledWith({ phase: 'thinking', userMessage: 'hello' });

            // No delta text and no tool history yet: the ledger-sink handler's own regeneration
            // gate has nothing to regenerate from, so it must fall back to the pre-generated value.
            conductor.emitFrame(envelope.id, { type: 'assistant', message: { content: [] } });

            expect(ledgerStore.dispatch).toHaveBeenCalledWith(expect.objectContaining({
                type: 'phase_synopsis', turnId: envelope.id, phaseType: 'thinking', text: 'pre-generated synopsis',
            }));
        });

        it('does not pre-generate a thinking synopsis when the throttle window has not elapsed', async () => {
            const ledgerStore = { dispatch: jest.fn() };
            const dynamicStatusGenerator = { generateSynopsis: jest.fn(() => Promise.resolve('should not be used')), generateCatchUpSynopsis: jest.fn() };
            const throttle = { shouldUpdate: jest.fn(() => false), record: jest.fn() };
            const processorWithLedger = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle, dynamicStatusGenerator,
            });
            coordinator.setProcessor(processorWithLedger);

            coordinator.handleMessage(makeContext({ messageId: 'msg-1' }), makeDiscordMessage('chan-1', 'msg-1', 'hello'));
            await flush();

            expect(dynamicStatusGenerator.generateSynopsis).not.toHaveBeenCalled();
        });

        it('ignores a frame for a different turn\'s id (per-turn filter applies to the ledger handler too)', async () => {
            const ledgerStore = { dispatch: jest.fn() };
            const dynamicStatusGenerator = { generateSynopsis: jest.fn(() => Promise.resolve('synopsis')), generateCatchUpSynopsis: jest.fn() };
            const processorWithLedger = createConductorProcessor({
                conductor, contextPolicy, envelopeProvider, contextBuilder, resolveTimezone, logger, ledgerStore, throttle: makeThrottle(), dynamicStatusGenerator,
            });
            coordinator.setProcessor(processorWithLedger);

            coordinator.handleMessage(makeContext({ channelId: createChannelId('chan-A'), messageId: 'msg-A1' }), makeDiscordMessage('chan-A', 'msg-A1', 'first'));
            await flush();

            conductor.emitFrame('some-other-turn-id', {
                type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] },
            });
            await flush();

            expect(ledgerStore.dispatch).not.toHaveBeenCalled();
        });
    });
});
