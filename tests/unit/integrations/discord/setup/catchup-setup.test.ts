/**
 * Tests for catchup-setup.ts's P10 additions: `setupInboxAndCatchUp` returning a settling
 * promise (including the deferred discord-online path), the conductor-mode
 * `runConductorInboxInit` (boot recovery + replay + catch-up composed around `runBootSequence`),
 * and the reusable `submitAndDeliverConductorEnvelope`/`submitConductorCatchUp` helpers shared
 * with `bot.ts`'s `triggerCatchUp`.
 */
import { describe, test, expect, mock, jest, afterEach, spyOn } from 'bun:test';
import * as loggerModule from '@hughescr/logger';
import type { Client } from 'discord.js';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import {
    setupInboxAndCatchUp,
    runConductorInboxInit,
    submitAndDeliverConductorEnvelope,
    submitConductorCatchUp,
    type RunConductorInboxInitParams
} from '@/integrations/discord/setup/catchup-setup';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeFakeClient(userId = 'bot-1'): Client {
    return { user: { id: userId } } as unknown as Client;
}

function makeFakeInboxManager(overrides: Record<string, unknown> = {}) {
    return {
        setBotUserId:      mock(() => undefined),
        loadUnread:        mock(async () => undefined),
        replayUnhandled:   mock(async () => []),
        getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })),
        recordHandled:     mock(async () => undefined),
        ...overrides,
    };
}

function makeFakeJournal(overrides: Record<string, unknown> = {}) {
    return {
        readSince: mock(async () => []),
        flush:     mock(async () => undefined),
        append:    mock(() => undefined),
        ...overrides,
    };
}

function makeFakeIngressGate() {
    return { open: mock(() => undefined) };
}

/** A fake conductor whose `submit` returns a response only for envelopes matching `respondsTo`. */
function makeFakeConductor(overrides: Record<string, unknown> = {}) {
    return {
        submit: mock(async (envelope: { id: string, kind: string }) => ({
            envelopeId: envelope.id, response: 'ok', wasInterrupted: false, sessionId: 'sess-1', isError: false, contextUsagePercent: 0,
        })),
        deliver: mock(async (_envelopeId: string, send: () => Promise<unknown>) => {
            await send();
            return { delivered: true };
        }),
        // R1: the merged boot envelope appends via this seam whenever it carries nothing worth
        // opening a turn for (`shouldQuery: false`) — see `submitMergedBootEnvelope`.
        appendWithoutTurn: mock(() => undefined),
        ...overrides,
    };
}

/** A fake `ContextPolicy`, narrowed to the events-mark methods `runConductorInboxInit`'s merged boot envelope actually reads/writes (R1). */
function makeFakeContextPolicy(overrides: Record<string, unknown> = {}) {
    return {
        markEventsSeenAt: mock(() => undefined),
        eventsDelta:      mock(async () => [] as string[]),
        markEventsSeen:   mock(() => undefined),
        ...overrides,
    };
}

function conductorParams(overrides: Partial<RunConductorInboxInitParams> = {}): RunConductorInboxInitParams {
    return {
        inboxManager:          makeFakeInboxManager() as unknown as RunConductorInboxInitParams['inboxManager'],
        readyClient:           makeFakeClient(),
        perchConfig:           undefined,
        ingressGate:           makeFakeIngressGate() as unknown as RunConductorInboxInitParams['ingressGate'],
        conversationConductor: makeFakeConductor() as unknown as RunConductorInboxInitParams['conversationConductor'],
        journal:               makeFakeJournal(),
        responseRouter:        {} as unknown as RunConductorInboxInitParams['responseRouter'],
        rateLimiter:           {} as unknown as RunConductorInboxInitParams['rateLimiter'],
        ...overrides,
    };
}

describe('submitAndDeliverConductorEnvelope', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    test('does not deliver when the conductor produced no response', async () => {
        const conductor = makeFakeConductor({ submit: mock(async () => ({ envelopeId: 'e1', response: null })) });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse'));

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        );

        expect(conductor.deliver).not.toHaveBeenCalled();
        expect(responseSenderModule.sendEnvelopeResponse).not.toHaveBeenCalled();
    });

    test('delivers a produced response via sendEnvelopeResponse, keyed on the envelope id', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        );

        expect(conductor.deliver).toHaveBeenCalledWith('e1', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'e1', kind: 'catchup', text: 'ok' }));
    });

    test('a queued send does not throw inside the deliver callback (still counts as delivered)', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: true }));

        await expect(submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        )).resolves.toBeUndefined();

        expect(conductor.deliver).toHaveBeenCalled();
    });

    test('a well-known-channel-missing skip is swallowed, never thrown to the caller', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, skipReason: 'missing' }));

        await expect(submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        )).resolves.toBeUndefined();
    });

    test('a skip with no skipReason logs "unknown reason" rather than an empty explanation', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        );

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
            err: expect.objectContaining({ message: expect.stringContaining('unknown reason') }) as unknown,
        }));
    });
});

describe('submitAndDeliverConductorEnvelope — discordCapability forwarding', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    test('forwards discordCapability to sendEnvelopeResponse so a boot-time redelivery can queue to the real outbox instead of losing the response', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const discordCapability = { sendToChannel: mock(() => Promise.resolve({ status: 'sent' as const })) };

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never, discordCapability: discordCapability as never }
        );

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ discordCapability }));
    });
});

describe('submitConductorCatchUp', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    test('builds and submits a catchup-kind envelope from the inbox overview', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }, { channelId: 'c2' }] })) });

        await submitConductorCatchUp({
            inboxManager: inboxManager as never, conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never,
        });

        expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup' }), { priority: 'other' });
    });
});

describe('runConductorInboxInit', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    test('sets the bot user id and loads unread before replaying', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const callOrder: string[] = [];
        const inboxManager = makeFakeInboxManager({
            setBotUserId: mock(() => {
                callOrder.push('setBotUserId');
            }),
            loadUnread: mock(async () => {
                callOrder.push('loadUnread');
            }),
            replayUnhandled: mock(async () => {
                callOrder.push('replayUnhandled');
                return [];
            }),
        });

        await runConductorInboxInit(conductorParams({
            inboxManager: inboxManager as never,
        }));

        expect(callOrder).toEqual(['setBotUserId', 'loadUnread', 'replayUnhandled']);
    });

    test('sets the bot user id from readyClient.user.id', async () => {
        const inboxManager = makeFakeInboxManager();
        await runConductorInboxInit(conductorParams({
            inboxManager: inboxManager as never,
            readyClient:  makeFakeClient('the-bot-id'),
        }));

        expect(inboxManager.setBotUserId).toHaveBeenCalledWith('the-bot-id');
    });

    test('runs the boot sequence exactly once: journal flushed once and the ingress gate opened exactly once', async () => {
        const journal = makeFakeJournal();
        const ingressGate = makeFakeIngressGate();

        await runConductorInboxInit(conductorParams({ journal, ingressGate: ingressGate as never }));

        expect(journal.flush).toHaveBeenCalledTimes(1);
        expect(ingressGate.open).toHaveBeenCalledTimes(1);
    });

    test('opens the ingress gate with an empty set when nothing was replayed', async () => {
        const ingressGate = makeFakeIngressGate();

        await runConductorInboxInit(conductorParams({ ingressGate: ingressGate as never }));

        expect(ingressGate.open).toHaveBeenCalledWith(new Set());
    });

    test('delivers every undelivered envelope from recovery, via sendEnvelopeResponse', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const conductor = makeFakeConductor();
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-undelivered', kind: 'discord', channelId: 'chan-1' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-undelivered', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(conductor.deliver).toHaveBeenCalledWith('env-undelivered', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-undelivered', kind: 'discord', channelId: 'chan-1', text: 'a stale reply',
        }));
    });

    test('an undelivered envelope with no responseText is skipped, never calling sendEnvelopeResponse (interrupted turn, no completion recorded)', async () => {
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse');
        spies.push(sendEnvelopeResponseSpy);
        const conductor = makeFakeConductor();
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-interrupted', kind: 'discord', channelId: 'chan-1' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(conductor.deliver).not.toHaveBeenCalled();
        expect(sendEnvelopeResponseSpy).not.toHaveBeenCalled();
    });

    test('a boot-time undelivered redelivery that neither sends nor queues (e.g. its well-known channel is now missing) is swallowed and logged, never thrown to the caller', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, skipReason: 'missing well-known channel' }));
        const conductor = makeFakeConductor();
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-undelivered', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-undelivered', responseText: 'a stale reply' },
            ]),
        });

        await expect(runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }))).resolves.toBeUndefined();

        expect(conductor.deliver).toHaveBeenCalledWith('env-undelivered', expect.any(Function));
    });

    test('a boot-time undelivered redelivery with no skipReason logs "unknown reason" rather than an empty explanation', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false }));
        const conductor = makeFakeConductor();
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-undelivered', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-undelivered', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
            err: expect.objectContaining({ message: expect.stringContaining('unknown reason') }) as unknown,
        }));
    });

    test('an undelivered turn that completed with no response text (interrupted, nothing to say) is skipped, never calling deliver', async () => {
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse');
        spies.push(sendEnvelopeResponseSpy);
        const conductor = makeFakeConductor();
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-no-text', kind: 'discord', channelId: 'chan-1' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-no-text' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(conductor.deliver).not.toHaveBeenCalled();
        expect(sendEnvelopeResponseSpy).not.toHaveBeenCalled();
    });

    test('a redelivered catch-up envelope (no channelId on the recovered item) reports an empty channelId to the conductor, not undefined', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        let deliveredResult: { channelId: string, messageIds: string[] } | undefined;
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                deliveredResult = await send();
                return { delivered: true };
            }),
        });
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-catchup', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-catchup', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(deliveredResult).toEqual({ channelId: '', messageIds: [] });
    });

    test('replays received-but-unhandled messages as one discord-kind envelope submission per channel', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
                { id: '200', channelId: 'chan-2', channelName: 'random', guildId: 'guild-1', author: 'bob', content: 'yo', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const discordSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'discord');
        expect(discordSubmissions).toHaveLength(2);
    });

    test('the replay envelope\'s authorId is the real Discord user id (a snowflake), not the display name', async () => {
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });
        spies.push(sendEnvelopeResponseSpy);
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'Alice', authorId: 'snowflake-alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const [envelope] = conductor.submit.mock.calls.find(([e]: [{ kind: string }]) => e.kind === 'discord')! as unknown as [{ authorId: string }];
        expect(envelope.authorId).toBe('snowflake-alice');
    });

    test('the replay envelope carries a caveat that these messages may already have been seen or answered', async () => {
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true });
        spies.push(sendEnvelopeResponseSpy);
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const [envelope] = conductor.submit.mock.calls.find(([e]: [{ kind: string }]) => e.kind === 'discord')! as unknown as [{ text: string }];
        expect(envelope.text).toMatch(/already.*(seen|answered)/i);
    });

    test('advances the per-channel HANDLED watermark after a successful replay submission', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const conductor = makeFakeConductor();
        const recordHandled = mock(async () => undefined);
        const inboxManager = makeFakeInboxManager({
            recordHandled,
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
                { id: '150', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'again', timestamp: new Date(1).toISOString(), isRead: false },
                { id: '200', channelId: 'chan-2', channelName: 'random', guildId: 'guild-1', author: 'bob', authorId: 'snowflake-bob', content: 'yo', timestamp: new Date(2).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        expect(recordHandled).toHaveBeenCalledTimes(2);
        expect(recordHandled).toHaveBeenCalledWith('chan-1', '150', new Date(1).toISOString());
        expect(recordHandled).toHaveBeenCalledWith('chan-2', '200', new Date(2).toISOString());
    });

    test('does NOT advance the HANDLED watermark for a channel whose replay submission failed (so it is replayed again on the next boot)', async () => {
        const conductor = makeFakeConductor({
            submit: mock(async (envelope: { id: string, kind: string, channelId?: string }) => {
                if(envelope.channelId === 'chan-1') {
                    throw new Error('conductor busy');
                }
                return { envelopeId: envelope.id, response: 'ok', wasInterrupted: false, sessionId: 'sess-1', isError: false, contextUsagePercent: 0 };
            }),
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const recordHandled = mock(async () => undefined);
        const inboxManager = makeFakeInboxManager({
            recordHandled,
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
                { id: '200', channelId: 'chan-2', channelName: 'random', guildId: 'guild-1', author: 'bob', authorId: 'snowflake-bob', content: 'yo', timestamp: new Date(2).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        expect(recordHandled).toHaveBeenCalledTimes(1);
        expect(recordHandled).toHaveBeenCalledWith('chan-2', '200', new Date(2).toISOString());
    });

    test('opens the ingress gate with exactly the replayed message ids', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const ingressGate = makeFakeIngressGate();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ ingressGate: ingressGate as never, inboxManager: inboxManager as never }));

        expect(ingressGate.open).toHaveBeenCalledWith(new Set(['100']));
    });

    test('submits a catch-up envelope when unread mail remains after replay', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 2, channels: [{ channelId: 'c1' }] })) });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup' }), { priority: 'other' });
    });

    test('does not submit a catch-up envelope when there is no unread mail', async () => {
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const catchupSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'catchup');
        expect(catchupSubmissions).toHaveLength(0);
    });

    test('honours perch triggerOnStartup by suppressing the catch-up envelope even with unread mail, while still running replay/recovery and opening the gate', async () => {
        const conductor = makeFakeConductor();
        const ingressGate = makeFakeIngressGate();
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 5, channels: [{ channelId: 'c1' }] })) });

        await runConductorInboxInit(conductorParams({
            conversationConductor: conductor as never,
            inboxManager:          inboxManager as never,
            ingressGate:           ingressGate as never,
            perchConfig:           { testMode: { triggerOnStartup: true } } as never,
        }));

        const catchupSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'catchup');
        expect(catchupSubmissions).toHaveLength(0);
        expect(ingressGate.open).toHaveBeenCalledTimes(1);
        expect(inboxManager.loadUnread).toHaveBeenCalledTimes(1);
    });

    test('forwards discordCapability from params through to sendEnvelopeResponse for a boot-time undelivered redelivery', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const conductor = makeFakeConductor();
        const discordCapability = { sendToChannel: mock(() => Promise.resolve({ status: 'sent' as const })) };
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-undelivered', kind: 'discord', channelId: 'chan-1' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-undelivered', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({
            conversationConductor: conductor as never,
            journal,
            discordCapability:     discordCapability as never,
        }));

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ discordCapability }));
    });

    test('excludeChannelIds is forwarded to inboxManager.replayUnhandled', async () => {
        const inboxManager = makeFakeInboxManager();
        const excludeChannelIds = new Set(['perch-time-channel']) as never;

        await runConductorInboxInit(conductorParams({ inboxManager: inboxManager as never, excludeChannelIds }));

        expect(inboxManager.replayUnhandled).toHaveBeenCalledWith({ excludeChannelIds });
    });

    // R1: the boot bundle and the Discord catch-up merge into ONE boot envelope, built after the
    // boot sequence — the four cases below (nothing / events only / unread / lost tasks).
    describe('R1: the merged boot envelope', () => {
        test('nothing to report: submits no envelope at all — neither appendWithoutTurn nor a catchup turn (R1 acceptance criterion)', async () => {
            const conductor = makeFakeConductor();
            const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) });
            const contextPolicy = makeFakeContextPolicy();

            await runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, inboxManager: inboxManager as never, contextPolicy: contextPolicy as never,
            }));

            expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
            const catchupSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'catchup');
            expect(catchupSubmissions).toHaveLength(0);
        });

        test('events only: a non-empty eventsDelta renders the "Events while you were away" section and still appends without a turn', async () => {
            const conductor = makeFakeConductor();
            const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 0, channels: [] })) });
            const contextPolicy = makeFakeContextPolicy({ eventsDelta: mock(async () => ['[2026-09-07 10:00] state/foo.md: Foo happened']) });

            await runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, inboxManager: inboxManager as never, contextPolicy: contextPolicy as never,
            }));

            expect(conductor.appendWithoutTurn).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'catchup', shouldQuery: false, text: expect.stringContaining('Foo happened') as unknown,
            }));
            const [envelope] = conductor.appendWithoutTurn.mock.calls[0] as unknown as [{ text: string }];
            expect(envelope.text).not.toContain('Replies redelivered');
        });

        test('unread mail: submits with a turn (priority \'other\'), not appendWithoutTurn', async () => {
            const conductor = makeFakeConductor();
            const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })) });
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

            expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup', shouldQuery: true }), { priority: 'other' });
            expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        });

        test('lost tasks: a lost background task from recovery escalates the merged envelope to a turn, and its description is rendered', async () => {
            const conductor = makeFakeConductor();
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'task_started', at: new Date(0), taskId: 'task-orphan', description: 'Summarize last week' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

            expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'catchup', shouldQuery: true, text: expect.stringContaining('Summarize last week') as unknown,
            }), { priority: 'other' });
        });

        test('redelivers an undelivered reply and reports it in the merged envelope\'s "Replies redelivered for you" section', async () => {
            const conductor = makeFakeConductor();
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'envelope_submitted', at: 0, envelopeId: 'env-undelivered', kind: 'discord', channelId: 'chan-1' },
                    { type: 'turn_completed', at: 1, envelopeId: 'env-undelivered', responseText: 'a stale reply' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

            // shouldQuery is false here (no unread mail, no lost tasks) -- a redelivered reply
            // alone does not escalate to a turn -- so this goes through appendWithoutTurn.
            expect(conductor.appendWithoutTurn).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'catchup', text: expect.stringContaining('a stale reply') as unknown,
            }));
        });

        test('seeds the events mark from the journal-derived lastKnownAt before reading eventsDelta, then advances it via markEventsSeen after submitting', async () => {
            const conductor = makeFakeConductor();
            const contextPolicy = makeFakeContextPolicy();
            const callOrder: string[] = [];
            contextPolicy.markEventsSeenAt.mockImplementation(() => {
                callOrder.push('markEventsSeenAt');
            });
            contextPolicy.eventsDelta.mockImplementation(async () => {
                callOrder.push('eventsDelta');
                return [];
            });
            contextPolicy.markEventsSeen.mockImplementation(() => {
                callOrder.push('markEventsSeen');
            });
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'turn_completed', at: new Date(12_345), envelopeId: 'env-1' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal, contextPolicy: contextPolicy as never }));

            expect(contextPolicy.markEventsSeenAt).toHaveBeenCalledWith(12_345);
            expect(callOrder).toEqual(['markEventsSeenAt', 'eventsDelta', 'markEventsSeen']);
        });

        test('falls back to now - bootEventsWindowMs seeding the mark when the journal carries no lastKnownAt boundary', async () => {
            const conductor = makeFakeConductor();
            const contextPolicy = makeFakeContextPolicy();
            const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000_000);
            spies.push(nowSpy);

            await runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, contextPolicy: contextPolicy as never, bootEventsWindowMs: 60_000,
            }));

            expect(contextPolicy.markEventsSeenAt).toHaveBeenCalledWith(1_000_000 - 60_000);
        });

        test('falls back to the 24h DEFAULT_BOOT_EVENTS_WINDOW_MS when neither lastKnownAt nor bootEventsWindowMs is available', async () => {
            const conductor = makeFakeConductor();
            const contextPolicy = makeFakeContextPolicy();
            const nowSpy = spyOn(Date, 'now').mockReturnValue(1_000_000);
            spies.push(nowSpy);

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, contextPolicy: contextPolicy as never }));

            expect(contextPolicy.markEventsSeenAt).toHaveBeenCalledWith(1_000_000 - 24 * 60 * 60 * 1000);
        });

        test('seeds the events mark BEFORE the ingress gate opens, so a live turn released concurrently cannot race the seed against a stale mark', async () => {
            const conductor = makeFakeConductor();
            const contextPolicy = makeFakeContextPolicy();
            const ingressGate = makeFakeIngressGate();
            const callOrder: string[] = [];
            contextPolicy.markEventsSeenAt.mockImplementation(() => {
                callOrder.push('markEventsSeenAt');
            });
            ingressGate.open.mockImplementation(() => {
                callOrder.push('ingressGate.open');
            });

            await runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, contextPolicy: contextPolicy as never, ingressGate: ingressGate as never,
            }));

            expect(callOrder).toEqual(['markEventsSeenAt', 'ingressGate.open']);
        });

        test('honours perch triggerOnStartup by suppressing the merged boot envelope entirely, never calling appendWithoutTurn or submit for it', async () => {
            const conductor = makeFakeConductor();
            const contextPolicy = makeFakeContextPolicy();

            await runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never,
                contextPolicy:         contextPolicy as never,
                perchConfig:           { testMode: { triggerOnStartup: true } } as never,
            }));

            expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
            const catchupSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'catchup');
            expect(catchupSubmissions).toHaveLength(0);
            expect(contextPolicy.markEventsSeenAt).not.toHaveBeenCalled();
        });

        test('without a contextPolicy, the merged envelope carries no events section and no mark calls are attempted', async () => {
            const conductor = makeFakeConductor();
            const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 2, channels: [{ channelId: 'c1' }] })) });
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));

            await expect(runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, inboxManager: inboxManager as never,
            }))).resolves.toBeUndefined();

            const [envelope] = conductor.submit.mock.calls.find(([e]: [{ kind: string }]) => e.kind === 'catchup')! as unknown as [{ text: string }];
            expect(envelope.text).not.toContain('Events while you were away');
        });

        test('a failure while building/submitting the merged boot envelope is swallowed and logged, never rejecting runConductorInboxInit', async () => {
            const conductor = makeFakeConductor({
                submit: mock(async (envelope: { id: string, kind: string }) => {
                    if(envelope.kind === 'catchup') {
                        throw new Error('boom');
                    }
                    return {
                        envelopeId: envelope.id, response: 'ok', wasInterrupted: false, sessionId: 'sess-1', isError: false, contextUsagePercent: 0,
                    };
                }),
            });
            const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 1, channels: [{ channelId: 'c1' }] })) });
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            spies.push(warnSpy);

            await expect(runConductorInboxInit(conductorParams({
                conversationConductor: conductor as never, inboxManager: inboxManager as never,
            }))).resolves.toBeUndefined();

            expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), msg: 'Boot-time catch-up envelope submission failed' }));
        });
    });
});

describe('setupInboxAndCatchUp', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    function conductorInboxParams(overrides: Record<string, unknown> = {}) {
        return {
            inboxManager:          makeFakeInboxManager(),
            readyClient:           makeFakeClient(),
            perchConfig:           undefined,
            conversationConductor: makeFakeConductor(),
            journal:               makeFakeJournal(),
            responseRouter:        {},
            rateLimiter:           {},
            ingressGate:           makeFakeIngressGate(),
            ...overrides,
        };
    }

    test('resolves immediately (Discord already available / no health registry given)', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const result = setupInboxAndCatchUp(conductorInboxParams() as never);
        await expect(result).resolves.toBeUndefined();
    });

    test('the returned promise settles only after a deferred discord-online change fires, not merely when the subscription is registered', async () => {
        let changeListener: ((change: { service: string, newState: string }) => void) | undefined;
        const healthRegistry = {
            isAvailable: mock(() => false),
            subscribe:   mock((cb: (change: { service: string, newState: string }) => void) => {
                changeListener = cb;
                return mock(() => undefined);
            }),
        };
        const inboxManager = makeFakeInboxManager();

        let resolved = false;
        const promise = setupInboxAndCatchUp(conductorInboxParams({ inboxManager, healthRegistry }) as never);
        void promise.then(() => {
            resolved = true;
            return undefined;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(inboxManager.loadUnread).not.toHaveBeenCalled();

        changeListener?.({ service: 'discord', newState: 'online' });
        await promise;

        expect(resolved).toBe(true);
        expect(inboxManager.loadUnread).toHaveBeenCalled();
    });

    test('loadUnread happens before replayUnhandled (runBootSequence)', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const callOrder: string[] = [];
        const inboxManager = makeFakeInboxManager({
            loadUnread: mock(async () => {
                callOrder.push('loadUnread');
            }),
            replayUnhandled: mock(async () => {
                callOrder.push('replayUnhandled');
                return [];
            }),
        });

        await setupInboxAndCatchUp(conductorInboxParams({ inboxManager }) as never);

        expect(callOrder).toEqual(['loadUnread', 'replayUnhandled']);
    });

    test('the boot sequence (and hence the ingress gate) runs exactly once', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const ingressGate = makeFakeIngressGate();

        await setupInboxAndCatchUp(conductorInboxParams({ ingressGate }) as never);

        expect(ingressGate.open).toHaveBeenCalledTimes(1);
    });

    test('a failure is caught and logged, never rejecting the returned promise', async () => {
        const inboxManager = makeFakeInboxManager({
            loadUnread: mock(async () => {
                throw new Error('boom');
            }),
        });

        await expect(setupInboxAndCatchUp(conductorInboxParams({ inboxManager }) as never)).resolves.toBeUndefined();
    });

    test('a failure that happens BEFORE the boot sequence (loadUnread rejects) still opens the ingress gate, so live messages are not buffered forever', async () => {
        const ingressGate = makeFakeIngressGate();
        const inboxManager = makeFakeInboxManager({
            loadUnread: mock(async () => {
                throw new Error('Discord search 500');
            }),
        });

        await setupInboxAndCatchUp(conductorInboxParams({ inboxManager, ingressGate }) as never);

        expect(ingressGate.open).toHaveBeenCalledWith(new Set());
    });
});
