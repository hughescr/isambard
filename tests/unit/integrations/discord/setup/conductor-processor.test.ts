/**
 * Behavioural tests for {@link createConductorProcessor} (P9): bridges the long-lived
 * conversation conductor onto Discord's `MessageProcessor` contract. Uses a hand-rolled fake
 * {@link Conductor} (this module's own contract, not P7's) driving the REAL
 * {@link MessageCoordinator} under fake timers, so the coordinator's own debounce/interrupt/
 * requeue behaviour is exercised exactly as production wires it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { Message } from 'discord.js';
import * as agentModule from '@/agent';
import {
    type Conductor, type ConductorStatus, type ContextPolicy, type DiscordEnvelopeInput, type SubmitOptions, type TurnResult, StreamTracker
} from '@/agent';
import type { Envelope } from '@/agent/session/types';
import { MessageCoordinator } from '@/integrations/discord/message-coordinator';
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
    deliver = (): Promise<never> => Promise.reject(new Error('FakeConductor.deliver is unused by conductor-processor.ts'));
    recordCompactionSummary = (): Promise<void> => Promise.resolve();
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

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ contextUsagePercent: 17 }), expect.any(String));

        logger.info.mockClear();

        coordinator.handleMessage(makeContext({ messageId: 'msg-B1' }), makeDiscordMessage('chan-1', 'msg-B1', 'held'));
        await flush();
        coordinator.handleMessage(makeContext({ messageId: 'msg-B2', content: 'second' }), makeDiscordMessage('chan-1', 'msg-B2', 'second'));
        jest.advanceTimersByTime(100);
        await flush();

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ contextUsagePercent: 3, outcome: 'withdrawn' }), expect.any(String));
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
