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
import * as agentModule from '@/agent';
import type { SendOutcome } from '@/agent';
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
            return { outcome: 'committed' as const, disposition: 'sent' as const };
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
        let deliveredTarget: unknown;
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<unknown>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            }),
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        const warnCount = warnSpy.mock.calls.length;

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        );

        expect(conductor.deliver).toHaveBeenCalledWith('e1', expect.any(Function));
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ envelopeId: 'e1', kind: 'catchup', text: 'ok' }));
        expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'sent', channelId: 'channel-1', messageIds: [] });
        expect(warnSpy).toHaveBeenCalledTimes(warnCount);
    });

    test('a queued send does not throw inside the deliver callback (still counts as delivered)', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'queued', channelId: 'channel-1' as never, outboxIds: ['outbox-1'] }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        const warnCount = warnSpy.mock.calls.length;

        await expect(submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        )).resolves.toBeUndefined();

        expect(conductor.deliver).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(warnCount);
    });

    test('a well-known-channel-missing skip is returned to the conductor without warning', async () => {
        let outcome: SendOutcome | undefined;
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<SendOutcome>) => {
                outcome = await send();
                return { outcome: 'skipped' as const };
            }),
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'missing' }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        warnSpy.mockClear();

        await expect(submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        )).resolves.toBeUndefined();

        expect(outcome).toEqual({ kind: 'skipped', reason: 'missing' });
        expect(warnSpy).not.toHaveBeenCalled();
    });

    test('an unavailable response logs the fixed response-unavailable error', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'unavailable' }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        warnSpy.mockClear();

        await submitAndDeliverConductorEnvelope(
            { id: 'e1', kind: 'catchup', text: 'x', hostPriority: 'wake', shouldQuery: true, createdAt: new Date(0) },
            { conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never }
        );

        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
            err:        expect.objectContaining({ message: 'Discord response unavailable' }) as unknown,
            envelopeId: 'e1',
            msg:        'Conductor envelope delivery failed',
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }, { channelId: 'c2' }] })) });

        await submitConductorCatchUp({
            inboxManager: inboxManager as never, conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never,
        });

        expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup' }), { priority: 'other' });
    });

    test('renders the catch-up envelope\'s time header with formatTimeHeader by default', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })) });

        await submitConductorCatchUp({
            inboxManager: inboxManager as never, conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never,
        });

        const [defaultEnvelope] = conductor.submit.mock.calls[0] as unknown as [{ text: string }];
        expect(defaultEnvelope.text).toContain('## Current Time');
    });

    test('takes the catch-up envelope\'s time header from an injected provider, called with no user zone (session-peers block 4)', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })) });
        const timeHeader = mock((_userTimezone?: string) => 'AMBIENT-HEADER\n- Perch: idle');

        await submitConductorCatchUp({
            inboxManager: inboxManager as never, conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never, timeHeader,
        });

        expect(timeHeader).toHaveBeenCalledWith();
        const [ambientEnvelope] = conductor.submit.mock.calls[0] as unknown as [{ text: string }];
        expect(ambientEnvelope.text).toContain('- Perch: idle');
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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

    test('reads recovery entries from exactly 24 hours before the current time', async () => {
        const now = Date.UTC(2026, 8, 12, 12);
        const dateNowSpy = spyOn(Date, 'now').mockReturnValue(now);
        spies.push(dateNowSpy);
        const journal = makeFakeJournal();

        await runConductorInboxInit(conductorParams({ journal }));

        expect(journal.readSince).toHaveBeenCalledWith(now - 24 * 60 * 60 * 1000);
    });

    test('opens the ingress gate with an empty set when nothing was replayed', async () => {
        const ingressGate = makeFakeIngressGate();

        await runConductorInboxInit(conductorParams({ ingressGate: ingressGate as never }));

        expect(ingressGate.open).toHaveBeenCalledWith(new Set());
    });

    test('delivers every undelivered envelope from recovery, via sendEnvelopeResponse', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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

    /**
     * A background task launched from the perch session carries no origin channel, and boot-time
     * redelivery used to hand its `'task'` envelope straight to `sendEnvelopeResponse`, where
     * `ResponseRouter.resolveEnvelopeTarget` raised `InvariantViolationError` for every restart
     * inside the recovery window. The live delivery path (`setup/wake-delivery.ts`) already routes
     * exactly this case to the fallback channel; boot now resolves it the same way, through the
     * same `ResponseRouter.routeToFallback`.
     */
    test('a channel-less task envelope is redelivered to the fallback channel rather than raising the routing invariant', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const routeToFallback = mock(async () => ({ targetChannelId: 'fallback-chan', shouldSend: true, content: 'a stale reply', isFallback: true }));
        let deliveredTarget: unknown;
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<unknown>) => {
                deliveredTarget = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            }),
        });
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-task', kind: 'task' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-task', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({
            conversationConductor: conductor as never,
            journal,
            responseRouter:        { routeToFallback } as never,
        }));

        expect(routeToFallback).toHaveBeenCalledWith('a stale reply');
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-task', kind: 'task', channelId: 'fallback-chan', text: 'a stale reply',
        }));
        // The delivery guard records the channel actually written to, not an empty string
        expect(deliveredTarget).toEqual({ kind: 'committed', disposition: 'sent', channelId: 'channel-1', messageIds: [] });
    });

    test('a task envelope that kept its own channel is redelivered there, never consulting the fallback', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const routeToFallback = mock(async () => ({ targetChannelId: 'fallback-chan', shouldSend: true, content: '', isFallback: true }));
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-task', kind: 'task', channelId: 'chan-7' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-task', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ journal, responseRouter: { routeToFallback } as never }));

        expect(routeToFallback).not.toHaveBeenCalled();
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-task', kind: 'task', channelId: 'chan-7',
        }));
    });

    test('a channel-less catchup envelope still resolves through its well-known channel, never the fallback', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const routeToFallback = mock(async () => ({ targetChannelId: 'fallback-chan', shouldSend: true, content: '', isFallback: true }));
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-catchup', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-catchup', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ journal, responseRouter: { routeToFallback } as never }));

        expect(routeToFallback).not.toHaveBeenCalled();
        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-catchup', kind: 'catchup', channelId: undefined,
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

    test('boot-time skipped redelivery is not summarized or warned', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'missing well-known channel' }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        warnSpy.mockClear();
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<SendOutcome>) => {
                const outcome = await send();
                return outcome.kind === 'skipped' ? { outcome: 'skipped' as const } : { outcome: 'committed' as const, disposition: outcome.disposition };
            }),
        });
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-missing-channel', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-missing-channel', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(conductor.deliver).toHaveBeenCalledWith('env-missing-channel', expect.any(Function));
        expect(warnSpy).not.toHaveBeenCalled();
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        let deliveredResult: SendOutcome | undefined;
        const conductor = makeFakeConductor({
            deliver: mock(async (_envelopeId: string, send: () => Promise<SendOutcome>) => {
                deliveredResult = await send();
                return { outcome: 'committed' as const, disposition: 'sent' as const };
            }),
        });
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'env-catchup', kind: 'catchup' },
                { type: 'turn_completed', at: 1, envelopeId: 'env-catchup', responseText: 'a stale reply' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        expect(deliveredResult).toEqual({ kind: 'committed', disposition: 'sent', channelId: 'channel-1', messageIds: [] });
    });

    test('replays received-but-unhandled messages as one discord-kind envelope submission per channel', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
                { id: '200', channelId: 'chan-2', channelName: 'DM with Bob', guildId: 'DM', author: 'bob', content: 'yo', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const discordSubmissions = conductor.submit.mock.calls.filter(([envelope]: [{ kind: string }]) => envelope.kind === 'discord');
        expect(discordSubmissions).toHaveLength(2);
        const replayTexts = (discordSubmissions as unknown as [{ text: string }][]).map(([envelope]) => envelope.text);
        expect(replayTexts.some(text => text.includes('alice: hi'))).toBe(true);
        expect(replayTexts.some(text => text.includes('bob: yo'))).toBe(true);
        expect(replayTexts.some(text => text.startsWith('[DISCORD #general'))).toBe(true);
        expect(replayTexts.some(text => text.startsWith('[DISCORD DM'))).toBe(true);
    });

    test('renders both boot envelopes\' time headers through an injected provider (session-peers block 4)', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'chan-1' }] })),
            replayUnhandled:   mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });
        const timeHeader = mock((_userTimezone?: string) => 'AMBIENT-HEADER\n- Perch: idle');

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never, timeHeader }));

        const kinds = new Map<string, string>(
            (conductor.submit.mock.calls as unknown as [{ kind: string, text: string }][]).map(([envelope]) => [envelope.kind, envelope.text])
        );
        expect(kinds.get('discord')).toContain('- Perch: idle');
        expect(kinds.get('catchup')).toContain('- Perch: idle');
        expect(timeHeader).toHaveBeenCalledWith();
    });

    test('the replay envelope\'s authorId is the real Discord user id (a snowflake), not the display name', async () => {
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
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
        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] });
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
        const replayCalls = conductor.submit.mock.calls as unknown as [{ channelId?: string, text: string }][];
        const chanOneEnvelope = replayCalls.map(([envelope]) => envelope)
            .find(envelope => envelope.channelId === 'chan-1');
        expect(chanOneEnvelope?.text).toContain('alice: hi');
        expect(chanOneEnvelope?.text).toContain('alice: again');
    });

    test('does NOT advance the HANDLED watermark for a channel whose replay submission failed (so it is replayed again on the next boot)', async () => {
        const submissionError = new Error('conductor busy');
        const conductor = makeFakeConductor({
            submit: mock(async (envelope: { id: string, kind: string, channelId?: string }) => {
                if(envelope.channelId === 'chan-1') {
                    throw submissionError;
                }
                return { envelopeId: envelope.id, response: 'ok', wasInterrupted: false, sessionId: 'sess-1', isError: false, contextUsagePercent: 0 };
            }),
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
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
        expect(warnSpy).toHaveBeenCalledWith({
            err: submissionError, channelId: 'chan-1', msg: 'Boot-time replay submission failed — channel will be replayed again on the next boot',
        });
    });

    test('includes each replayed message exactly once in its channel\'s envelope, even when the channel has multiple messages', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const conductor = makeFakeConductor();
        const inboxManager = makeFakeInboxManager({
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
                { id: '150', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', authorId: 'snowflake-alice', content: 'again', timestamp: new Date(1).toISOString(), isRead: false },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const [envelope] = conductor.submit.mock.calls.find(([e]: [{ kind: string }]) => e.kind === 'discord')! as unknown as [{ text: string }];
        expect(envelope.text.match(/alice: hi/g)).toHaveLength(1);
        expect(envelope.text.match(/alice: again/g)).toHaveLength(1);
        expect(envelope.text).toContain('messageIds=[100, 150]');
    });

    test('forces runBootSequence\'s unreadCount callback to 0 when perch testMode skips catch-up, regardless of actual unread mail', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const runBootSequenceSpy = spyOn(agentModule, 'runBootSequence');
        spies.push(runBootSequenceSpy);
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 7, channels: [{ channelId: 'c1' }] })) });

        await runConductorInboxInit(conductorParams({
            inboxManager: inboxManager as never,
            perchConfig:  { testMode: { triggerOnStartup: true } } as never,
        }));

        expect(runBootSequenceSpy).toHaveBeenCalledTimes(1);
        const [params] = runBootSequenceSpy.mock.calls[0] as unknown as [{ unreadCount: () => number }];
        expect(params.unreadCount()).toBe(0);
    });

    test('feeds runBootSequence\'s unreadCount callback the real unread total when catch-up is not skipped', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const runBootSequenceSpy = spyOn(agentModule, 'runBootSequence');
        spies.push(runBootSequenceSpy);
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 7, channels: [{ channelId: 'c1' }] })) });

        await runConductorInboxInit(conductorParams({ inboxManager: inboxManager as never }));

        expect(runBootSequenceSpy).toHaveBeenCalledTimes(1);
        const [params] = runBootSequenceSpy.mock.calls[0] as unknown as [{ unreadCount: () => number }];
        expect(params.unreadCount()).toBe(7);
    });

    test('opens the ingress gate with exactly the replayed message ids', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

            expect(conductor.submit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catchup', shouldQuery: true }), { priority: 'other' });
            expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        });

        test('lost tasks: a lost background task from recovery escalates the merged envelope to a turn, and its description is rendered', async () => {
            const conductor = makeFakeConductor();
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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

        test('commits only queued chunks when a boot-time redelivery is partial', async () => {
            let deliveredResult: SendOutcome | undefined;
            const conductor = makeFakeConductor({
                deliver: mock(async (_envelopeId: string, send: () => Promise<SendOutcome>) => {
                    deliveredResult = await send();
                    return { outcome: 'committed' as const, disposition: 'queued' as const };
                }),
            });
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({
                status:    'partial',
                channelId: 'channel-1' as never,
                chunks:    [
                    { status: 'sent' },
                    { status: 'queued', outboxId: 'outbox-2' },
                ],
            }));
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'envelope_submitted', at: 0, envelopeId: 'env-partial', kind: 'discord', channelId: 'chan-1' },
                    { type: 'turn_completed', at: 1, envelopeId: 'env-partial', responseText: 'a stale reply' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

            expect(deliveredResult).toEqual({
                kind: 'committed', disposition: 'queued', channelId: 'channel-1', outboxIds: ['outbox-2'],
            });
        });

        test('does not summarize a redelivery whose conductor outcome was skipped', async () => {
            const conductor = makeFakeConductor({
                deliver: mock(async (_envelopeId: string, send: () => Promise<SendOutcome>) => {
                    await send();
                    return { outcome: 'skipped' as const };
                }),
            });
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'skipped', reason: 'missing well-known channel' }));
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'envelope_submitted', at: 0, envelopeId: 'env-skipped', kind: 'catchup' },
                    { type: 'turn_completed', at: 1, envelopeId: 'env-skipped', responseText: 'not redelivered' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

            expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
        });

        test('logs a failed redelivery and continues with the next undelivered reply', async () => {
            const deliveryError = new Error('delivery guard unavailable');
            const conductor = makeFakeConductor({
                deliver: mock(async (envelopeId: string, send: () => Promise<SendOutcome>) => {
                    if(envelopeId === 'env-fails') {
                        throw deliveryError;
                    }
                    await send();
                    return { outcome: 'committed' as const, disposition: 'sent' as const };
                }),
            });
            const warnSpy = spyOn(loggerModule.logger, 'warn');
            warnSpy.mockClear();
            spies.push(warnSpy, spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
            const journal = makeFakeJournal({
                readSince: mock(async () => [
                    { type: 'envelope_submitted', at: new Date(0), envelopeId: 'env-fails', kind: 'discord', channelId: 'chan-1' },
                    { type: 'turn_completed', at: new Date(1), envelopeId: 'env-fails', responseText: 'first reply' },
                    { type: 'envelope_submitted', at: new Date(2), envelopeId: 'env-succeeds', kind: 'discord', channelId: 'chan-1' },
                    { type: 'turn_completed', at: new Date(3), envelopeId: 'env-succeeds', responseText: 'second reply' },
                ]),
            });

            await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

            expect(warnSpy).toHaveBeenCalledWith({
                err: deliveryError, envelopeId: 'env-fails', msg: 'Boot-time undelivered redelivery failed',
            });
            expect(conductor.deliver).toHaveBeenCalledTimes(2);
            expect(conductor.appendWithoutTurn).toHaveBeenCalledWith(expect.objectContaining({
                text: expect.stringContaining('second reply') as unknown,
            }));
        });

        test('redelivers an undelivered reply and reports it in the merged envelope\'s "Replies redelivered for you" section', async () => {
            const conductor = makeFakeConductor();
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
            spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));

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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const infoSpy = spyOn(loggerModule.logger, 'info');
        spies.push(infoSpy);
        const result = setupInboxAndCatchUp(conductorInboxParams() as never);
        await expect(result).resolves.toBeUndefined();
        expect(infoSpy).toHaveBeenCalledWith({ msg: 'Starting inbox initialization...' });
    });

    test('the returned promise settles only after a deferred discord-online change fires, not merely when the subscription is registered', async () => {
        let changeListener: ((change: { service: string, newState: string }) => void) | undefined;
        const unsubscribe = mock(() => undefined);
        const healthRegistry = {
            isAvailable: mock(() => false),
            subscribe:   mock((cb: (change: { service: string, newState: string }) => void) => {
                changeListener = cb;
                return unsubscribe;
            }),
        };
        const infoSpy = spyOn(loggerModule.logger, 'info');
        spies.push(infoSpy);
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
        expect(infoSpy).toHaveBeenCalledWith({
            msg: 'Discord not yet available — deferring inbox initialization until Discord is online',
        });

        changeListener?.({ service: 'email', newState: 'online' });
        changeListener?.({ service: 'discord', newState: 'offline' });
        await Promise.resolve();
        expect(inboxManager.loadUnread).not.toHaveBeenCalled();
        expect(unsubscribe).not.toHaveBeenCalled();

        changeListener?.({ service: 'discord', newState: 'online' });
        await promise;

        expect(resolved).toBe(true);
        expect(inboxManager.loadUnread).toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    test('loadUnread happens before replayUnhandled (runBootSequence)', async () => {
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
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

        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy);
        await expect(setupInboxAndCatchUp(conductorInboxParams({ inboxManager }) as never)).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith({ error: 'boom', msg: 'Failed to load inbox on startup' });
    });

    test('reports a deferred inbox initialization logging failure with its initialization context', async () => {
        let changeListener: ((change: { service: string, newState: string }) => void) | undefined;
        const healthRegistry = {
            isAvailable: mock(() => false),
            subscribe:   mock((cb: (change: { service: string, newState: string }) => void) => {
                changeListener = cb;
                return mock(() => undefined);
            }),
        };
        const inboxManager = makeFakeInboxManager({
            loadUnread: mock(async () => {
                throw new Error('load failed');
            }),
        });
        const warnSpy = spyOn(loggerModule.logger, 'warn').mockImplementation(() => {
            throw new Error('logger sink failed');
        });
        const errorSpy = spyOn(loggerModule.logger, 'error');
        spies.push(warnSpy, errorSpy);

        const setup = setupInboxAndCatchUp(conductorInboxParams({ healthRegistry, inboxManager }) as never);
        changeListener?.({ service: 'discord', newState: 'online' });
        await setup;

        expect(errorSpy).toHaveBeenCalledWith({
            error: 'logger sink failed',
            msg:   'Unhandled error in inbox initialization',
        });
    });

    test('contains a logging failure while reporting an inbox initialization failure', async () => {
        const inboxManager = makeFakeInboxManager({
            loadUnread: mock(async () => {
                throw new Error('load failed');
            }),
        });
        const warnSpy = spyOn(loggerModule.logger, 'warn').mockImplementation(() => {
            throw new Error('logger sink failed');
        });
        const errorSpy = spyOn(loggerModule.logger, 'error');
        spies.push(warnSpy, errorSpy);

        await expect(setupInboxAndCatchUp(conductorInboxParams({ inboxManager }) as never)).resolves.toBeUndefined();

        expect(errorSpy).toHaveBeenCalledWith({
            error: 'logger sink failed',
            msg:   'Unhandled error in inbox initialization',
        });
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

describe('catchup setup mutation witnesses', () => {
    const spies: ReturnType<typeof spyOn>[] = [];
    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test('waits for catch-up submission failures to propagate', async () => {
        const submissionError = new Error('conductor unavailable');
        const conductor = makeFakeConductor({ submit: mock(async () => {
            throw submissionError;
        }) });
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }] })) });

        await expect(submitConductorCatchUp({
            inboxManager: inboxManager as never, conversationConductor: conductor as never, responseRouter: {} as never, client: makeFakeClient(), rateLimiter: {} as never,
        })).rejects.toBe(submissionError);
    });

    test('keeps the redelivery summary ordered and caps each preview at 200 characters', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const firstReply = 'x'.repeat(201);
        const expectedPreview = `${'x'.repeat(199)}…`;
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'envelope_submitted', at: 0, envelopeId: 'first', kind: 'discord', channelId: 'chan-1' },
                { type: 'turn_completed', at: new Date(1), envelopeId: 'first', responseText: firstReply },
                { type: 'envelope_submitted', at: 2, envelopeId: 'second', kind: 'discord', channelId: 'chan-1' },
                { type: 'turn_completed', at: new Date(3), envelopeId: 'second', responseText: 'second redelivery' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal }));

        const [envelope] = conductor.appendWithoutTurn.mock.calls[0] as unknown as [{ text: string }];
        expect(envelope.text).toContain(`${expectedPreview}\nsecond redelivery`);
    });

    test('logs a failed replay watermark instead of leaving its rejection detached', async () => {
        const watermarkError = new Error('watermark unavailable');
        const recordHandled = mock(async () => {
            throw watermarkError;
        });
        const warnSpy = spyOn(loggerModule.logger, 'warn');
        spies.push(warnSpy, spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({
            recordHandled,
            replayUnhandled: mock(async () => [
                { id: '100', channelId: 'chan-1', channelName: 'general', guildId: 'guild-1', author: 'alice', content: 'hi', timestamp: new Date(0).toISOString(), isRead: false },
            ]),
        });

        await expect(runConductorInboxInit(conductorParams({ inboxManager: inboxManager as never }))).resolves.toBeUndefined();

        expect(warnSpy).toHaveBeenCalledWith({
            err: watermarkError, channelId: 'chan-1', msg: 'Boot-time replay submission failed — channel will be replayed again on the next boot',
        });
    });

    test('treats an absent events delta as empty when deciding whether to append a boot envelope', async () => {
        const conductor = makeFakeConductor();

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never }));

        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
    });

    test('reports the actual number of unread channels in the merged boot envelope', async () => {
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 3, channels: [{ channelId: 'c1' }, { channelId: 'c2' }] })) });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const [envelope] = conductor.submit.mock.calls.find(([candidate]: [{ kind: string }]) => candidate.kind === 'catchup')! as unknown as [{ text: string }];
        expect(envelope.text).toContain('across 2 channels');
    });

    test('timestamps the merged boot envelope at the current time', async () => {
        const now = new Date('2026-09-16T12:00:00.000Z');
        jest.useFakeTimers({ now });
        const conductor = makeFakeConductor();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ status: 'sent', channelId: 'channel-1' as never, messageIds: [] }));
        const inboxManager = makeFakeInboxManager({ getUnreadOverview: mock(() => ({ totalUnread: 1, channels: [{ channelId: 'c1' }] })) });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, inboxManager: inboxManager as never }));

        const [envelope] = conductor.submit.mock.calls.find(([candidate]: [{ kind: string }]) => candidate.kind === 'catchup')! as unknown as [{ createdAt: Date }];
        expect(envelope.createdAt).toEqual(now);
    });

    test('uses an explicit empty boot task snapshot instead of stale recovery tasks', async () => {
        const conductor = makeFakeConductor();
        const journal = makeFakeJournal({
            readSince: mock(async () => [
                { type: 'task_started', at: new Date(0), taskId: 'task-orphan', description: 'stale task' },
            ]),
        });

        await runConductorInboxInit(conductorParams({ conversationConductor: conductor as never, journal, bootLostTasks: [] }));

        expect(conductor.submit).not.toHaveBeenCalled();
        expect(conductor.appendWithoutTurn).not.toHaveBeenCalled();
    });
});
