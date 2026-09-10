/**
 * Tests for coordinator-setup.ts — response-send path channel tracking (FIX A).
 *
 * Verifies that when a response is successfully sent to a Discord channel,
 * that channel ID is pushed into the recent-channels ring buffer.
 * The error path (send fails, i.e. sent: false) must NOT push the channel ID.
 */
import { describe, test, expect, mock, jest, afterEach, spyOn } from 'bun:test';
import type { Client, Message } from 'discord.js';
import { mockGenerateText } from '../../../../setup';
import type { StreamTracker } from '@/agent';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageCoordinatorConfig, MessageProcessor } from '@/integrations/discord/message-coordinator';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { setupCoordinatorIntegration } from '@/integrations/discord/setup/coordinator-setup';
import { createChannelId, createGuildId, createUserId, type DiscordMessageContext } from '@/integrations/discord/types';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeMockClient(): Client {
    return {
        guilds: { cache: { get: mock(() => undefined) } },
    } as unknown as Client;
}

function makeMockChannelRegistry(): ChannelRegistryManager {
    return {
        isReady:            mock(() => true),
        getUnmutedChannels: mock(async () => []),
    } as unknown as ChannelRegistryManager;
}

function makeMockResponseRouter() {
    return {} as unknown as Parameters<typeof setupCoordinatorIntegration>[0]['responseRouter'];
}

function makeMockRateLimiter() {
    return {} as unknown as Parameters<typeof setupCoordinatorIntegration>[0]['rateLimiter'];
}

// ---------------------------------------------------------------------------
// P9/P13b: the conductor branch is the only path — createConductorProcessor is always the
// processor (never agent.handleInput, which no longer exists); onResponse delivers idempotently.
// Presence/activity-phase transitions are driven entirely by the conductor's own ledger.
// ---------------------------------------------------------------------------

describe('setupCoordinatorIntegration — conductor branch', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    afterEach(() => {
        for(const spy of spies) {
            try {
                spy.mockRestore();
            } catch{
                // already restored
            }
        }
        spies.length = 0;
        jest.restoreAllMocks();
    });

    function makeConductorParams(overrides: Record<string, unknown> = {}) {
        return {
            presenceManager:       undefined,
            responseRouter:        makeMockResponseRouter(),
            rateLimiter:           makeMockRateLimiter(),
            readyClient:           makeMockClient(),
            channelRegistry:       makeMockChannelRegistry(),
            conversationConductor: {
                submit: mock(() => Promise.resolve({
                    envelopeId: 'env-1', response: 'ok', wasInterrupted: false, partialWork: { thinking: '', text: '', pendingToolUse: null }, sessionId: 'sess-1', isError: false, contextUsagePercent: 0,
                })),
                subscribeTurn: mock(() => mock(() => undefined)),
                deliver:       mock(async (_envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                    await send();
                    return { delivered: true };
                }),
            },
            contextPolicy: {
                shouldInjectUserMemory: mock(() => false),
                markInjected:           mock(() => undefined),
                eventsDelta:            mock(() => Promise.resolve([])),
                markEventsSeen:         mock(() => undefined),
                stateTopSetDelta:       mock(() => Promise.resolve({ added: [], removed: [], changed: [] })),
                markStateTopSetSeen:    mock(() => Promise.resolve()),
                calendarDelta:          mock(() => Promise.resolve({ agenda: [], events: [], added: [], removed: [], changed: [], isFirst: false, polled: false })),
                markCalendarSeen:       mock(() => undefined),
                healthNote:             mock(() => undefined),
                markHealthSeen:         mock(() => undefined),
                resetAll:               mock(() => undefined),
            },
            deliveryGuard:    { alreadyDelivered: mock(() => false), markDelivered: mock(() => undefined) },
            journal:          { append: mock(() => undefined), flush: mock(() => Promise.resolve()), readSince: mock(() => Promise.resolve([])) },
            inboxManager:     { recordHandled: mock(() => Promise.resolve()) },
            envelopeProvider: {
                resolveNames:    mock(() => Promise.resolve({ channelName: 'general', authorName: 'craig', isDM: false })),
                toEnvelopeInput: mock(() => ({
                    messageId: 'msg-1', channelId: 'chan-1', channelName: 'general', authorId: 'user-1', authorName: 'craig', content: 'hello', createdAt: new Date(0), isDM: false, channelList: [],
                })),
                channelList: mock(() => Promise.resolve([])),
            },
            contextBuilder: { loadUserTimezone: mock(() => Promise.resolve(undefined)), loadUserMemories: mock(() => Promise.resolve('')) },
            ...overrides,
        } as unknown as Parameters<typeof setupCoordinatorIntegration>[0];
    }

    /** Mocks the MessageCoordinator constructor and captures the whole config it was built with. */
    function captureConfig(params: Parameters<typeof setupCoordinatorIntegration>[0]): MessageCoordinatorConfig {
        let captured: MessageCoordinatorConfig | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((config: MessageCoordinatorConfig): messageCoordinatorModule.MessageCoordinator => {
            captured = config;
            return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as messageCoordinatorModule.MessageCoordinator;
        }));
        setupCoordinatorIntegration(params);
        return captured!;
    }

    function makeMinimalContext(): DiscordMessageContext {
        return {
            guildId:   createGuildId('1'),
            channelId: createChannelId('chan-1'),
            userId:    createUserId('user-1'),
            username:  'craig',
            messageId: 'msg-1',
            content:   'hello',
            timestamp: new Date(0).toISOString(),
            botUserId: createUserId('bot-1'),
        };
    }

    /** A minimal batch Message — only the fields `onResponse`'s conductor branch reads. */
    function makeBatchMessage(channelId: string, id: string, createdAt: Date): Message {
        return { id, channelId, createdAt } as unknown as Message;
    }

    test('selects createConductorProcessor as its processor', () => {
        const params = makeConductorParams();
        let capturedProcessor: MessageProcessor | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
            setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator)));

        setupCoordinatorIntegration(params);

        expect(capturedProcessor).toBeDefined();
    });

    test('the selected processor actually routes through conductor.submit when invoked', async () => {
        const params = makeConductorParams();
        let capturedProcessor: MessageProcessor | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
            setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator)));

        setupCoordinatorIntegration(params);
        expect(capturedProcessor).toBeDefined();

        await capturedProcessor!([makeMinimalContext()], null, new AbortController().signal);

        expect(params.conversationConductor.submit).toHaveBeenCalled();
    });

    test('onProcessingEnd is a no-op in conductor mode — the ledger shim is the sole writer of the idle transition', () => {
        const params = makeConductorParams();
        const config = captureConfig(params);

        // setupCoordinatorIntegration takes no BotStateManager at all (see SetupCoordinatorParams'
        // own doc) — proving onProcessingEnd calls nothing observable is really just proving it
        // does not throw, since there is nothing left in scope for it to call.
        expect(() => config.onProcessingEnd?.({ wasInterrupted: true, willResume: false })).not.toThrow();
    });

    test('onResponse delivers through conversationConductor.deliver keyed on the CONDUCTOR'
      + "'s envelope id (not the triggering Discord message id), sending via sendEnvelopeResponse to the origin channel", async () => {
        const params = makeConductorParams();
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-999',
        }, discordMessage, batch);

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-999', kind: 'discord', channelId: '123', text: 'hello',
        }));
        const conductorDeliver = (params.conversationConductor as unknown as { deliver: ReturnType<typeof mock> }).deliver;
        expect(conductorDeliver).toHaveBeenCalledWith('env-999', expect.any(Function));
    });

    test('onResponse forwards params.discordCapability to sendEnvelopeResponse so a Discord outage queues to the real outbox instead of losing the response', async () => {
        const discordCapability = { sendToChannel: mock(() => Promise.resolve({ status: 'sent' as const })) };
        const params = makeConductorParams({ discordCapability });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-999',
        }, discordMessage, batch);

        expect(responseSenderModule.sendEnvelopeResponse).toHaveBeenCalledWith(expect.objectContaining({ discordCapability }));
    });

    test('onResponse refuses a duplicate delivery for an already-delivered envelope id (conversationConductor.deliver\'s own idempotency)', async () => {
        const deliver = mock(async () => ({ delivered: false }));
        const params = makeConductorParams({
            conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver },
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(responseSenderModule.sendEnvelopeResponse).not.toHaveBeenCalled();
    });

    test('onResponse keeps addRecentMessage(\'izzy\') and the discord-exchange activity-log write (folded idle-status-inputs gap)', async () => {
        const addRecentMessage = mock(() => undefined);
        const activityLogger = { log: mock(() => Promise.resolve()) };
        const params = makeConductorParams({ addRecentMessage, activityLogger });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        mockGenerateText.mockResolvedValueOnce('Craig asked about the weather; Izzy answered.');
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'what\'s the weather', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'It\'s sunny.', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(addRecentMessage).toHaveBeenCalledWith('It\'s sunny.', 'izzy');
        expect(activityLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: 'discord-exchange', summary: 'Craig asked about the weather; Izzy answered.' }));
    });

    // ---------------------------------------------------------------------------
    // P10: recordHandled watermark + journal-on-delivered-or-queued-only
    // ---------------------------------------------------------------------------

    test('onResponse records the HANDLED watermark on a sent response', async () => {
        const recordHandled = mock(() => Promise.resolve());
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(1000))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(recordHandled).toHaveBeenCalledWith('123', 'msg-1', new Date(1000).toISOString());
    });

    test('onResponse records the HANDLED watermark on a no-response (@@NO_RESPONSE@@) skip', async () => {
        const recordHandled = mock(() => Promise.resolve());
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, skipReason: 'no-response' }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(1000))];

        await config.onResponse?.({
            response: '@@NO_RESPONSE@@', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(recordHandled).toHaveBeenCalledWith('123', 'msg-1', new Date(1000).toISOString());
    });

    test('onResponse records the HANDLED watermark on an outbox-queued send', async () => {
        const recordHandled = mock(() => Promise.resolve());
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, queued: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(1000))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(recordHandled).toHaveBeenCalledWith('123', 'msg-1', new Date(1000).toISOString());
    });

    test('onResponse records one HANDLED watermark per channel for a multi-channel batch, keyed to each channel\'s newest message', async () => {
        const recordHandled = mock(() => Promise.resolve());
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [
            makeBatchMessage('123', '100', new Date(1000)),
            makeBatchMessage('123', '101', new Date(2000)),
            makeBatchMessage('456', '200', new Date(1500)),
        ];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(recordHandled).toHaveBeenCalledTimes(2);
        expect(recordHandled).toHaveBeenCalledWith('123', '101', new Date(2000).toISOString());
        expect(recordHandled).toHaveBeenCalledWith('456', '200', new Date(1500).toISOString());
    });

    test('onResponse does not journal (deliver\'s send callback throws) on a no-response skip, but does journal on sent/queued', async () => {
        const deliverCalls: { threw: boolean }[] = [];
        const deliver = mock(async (_envelopeId: string, send: () => Promise<unknown>) => {
            try {
                await send();
                deliverCalls.push({ threw: false });
                return { delivered: true };
            } catch{
                deliverCalls.push({ threw: true });
                return { delivered: false };
            }
        });
        const params = makeConductorParams({
            conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver },
        });
        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(1000))];

        const sendEnvelopeResponseSpy = spyOn(responseSenderModule, 'sendEnvelopeResponse');
        spies.push(sendEnvelopeResponseSpy);

        // Sent: the send callback resolves normally — deliver's real implementation would journal.
        sendEnvelopeResponseSpy.mockResolvedValueOnce({ sent: true });
        const config = captureConfig(params);
        await config.onResponse?.({
            response: 'a', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-a',
        }, discordMessage, batch);

        // Queued: also resolves normally — the outbox owns the retry, so this still journals.
        sendEnvelopeResponseSpy.mockResolvedValueOnce({ sent: false, queued: true });
        await config.onResponse?.({
            response: 'b', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-b',
        }, discordMessage, batch);

        // No-response: the send callback throws — deliver's real implementation would NOT journal.
        sendEnvelopeResponseSpy.mockResolvedValueOnce({ sent: false, skipReason: 'no-response' });
        await config.onResponse?.({
            response: '@@NO_RESPONSE@@', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-c',
        }, discordMessage, batch);

        expect(deliverCalls).toEqual([{ threw: false }, { threw: false }, { threw: true }]);
    });
});
