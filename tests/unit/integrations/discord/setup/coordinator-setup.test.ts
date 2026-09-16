/**
 * Tests for coordinator-setup.ts — response-send path channel tracking (FIX A).
 *
 * Verifies that when a response is successfully sent to a Discord channel,
 * that channel ID is pushed into the recent-channels ring buffer.
 * The error path (send fails, i.e. sent: false) must NOT push the channel ID.
 */
import { describe, test, expect, mock, jest, afterEach, spyOn } from 'bun:test';
import type { Client, Message } from 'discord.js';
import { mockGenerateText, mockLogger } from '../../../../setup';
import type { StreamTracker } from '@/agent';
import * as attachmentsModule from '@/integrations/discord/attachments';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageCoordinatorConfig, MessageProcessor } from '@/integrations/discord/message-coordinator';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import { processAttachments, setupCoordinatorIntegration } from '@/integrations/discord/setup/coordinator-setup';
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
        const addRecentChannel = mock(() => undefined);
        const deliveredPayloads: { channelId: string, messageIds: string[] }[] = [];
        const deliver = mock(async (_envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
            const payload = await send();
            deliveredPayloads.push(payload);
            return { delivered: true };
        });
        const params = makeConductorParams({ addRecentChannel, conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver } });
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
        expect(deliver).toHaveBeenCalledWith('env-999', expect.any(Function));
        expect(deliveredPayloads).toEqual([{ channelId: '123', messageIds: [] }]);
        expect(addRecentChannel).toHaveBeenCalledWith('123');
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

    test('does not send an envelope-less response, but still records the returned session id', async () => {
        const setLastSessionId = mock(() => undefined);
        const params = makeConductorParams({ setLastSessionId });
        const sendEnvelopeResponse = spyOn(responseSenderModule, 'sendEnvelopeResponse');
        spies.push(sendEnvelopeResponse);
        const config = captureConfig(params);
        const discordMessage = { id: 'msg-1', content: 'hi', channelId: '123' } as unknown as Message;

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-without-envelope', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: undefined,
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);

        expect(sendEnvelopeResponse).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith({ msg: 'Conductor response has no envelopeId — cannot deliver idempotently, skipping send' });
        expect(setLastSessionId).toHaveBeenCalledWith('sess-without-envelope');
    });

    test('adds a channel only after a conductor-confirmed delivery and logs unexpected delivery failures', async () => {
        const addRecentChannel = mock(() => undefined);
        const deliveryError = new Error('journal unavailable');
        const params = makeConductorParams({
            addRecentChannel,
            conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver: mock(() => Promise.reject(deliveryError)) },
        });
        const config = captureConfig(params);
        const discordMessage = { id: 'msg-1', content: 'hi', channelId: '123' } as unknown as Message;

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);

        expect(addRecentChannel).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith({ err: deliveryError, envelopeId: 'env-1', msg: 'Conductor response delivery failed' });
    });

    test('does not add a channel when the conductor rejects a duplicate delivery without invoking its send callback', async () => {
        const addRecentChannel = mock(() => undefined);
        const params = makeConductorParams({
            addRecentChannel,
            conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver: mock(async () => ({ delivered: false })) },
        });
        const config = captureConfig(params);
        const discordMessage = { id: 'msg-1', content: 'hi', channelId: '123' } as unknown as Message;

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-duplicate',
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);

        expect(addRecentChannel).not.toHaveBeenCalled();
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

    test('falls back to the stable exchange summary and warns if asynchronous activity logging fails', async () => {
        const activityLogger = { log: mock(() => Promise.reject(new Error('activity store unavailable'))) };
        const params = makeConductorParams({ activityLogger });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        mockGenerateText.mockResolvedValueOnce('');
        const config = captureConfig(params);
        const discordMessage = { id: 'msg-1', content: 'hello', channelId: '123' } as unknown as Message;

        await config.onResponse?.({
            response: 'reply', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(activityLogger.log).toHaveBeenCalledWith({ type: 'discord-exchange', summary: 'Discord exchange in channel' });
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: '123', msg: 'Activity log failed for Discord exchange' }));
    });

    test('limits exchange summarization input to 500 characters per side', async () => {
        const activityLogger = { log: mock(() => Promise.resolve()) };
        const params = makeConductorParams({ activityLogger });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);
        const userContent = 'u'.repeat(501);
        const response = 'r'.repeat(501);
        const discordMessage = { id: 'msg-1', content: userContent, channelId: '123' } as unknown as Message;

        await config.onResponse?.({
            response, sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);
        await Promise.resolve();

        expect(mockGenerateText).toHaveBeenCalledWith(`Summarize this Discord exchange in one sentence (max 30 words):\nUser: ${'u'.repeat(500)}\nIzzy: ${'r'.repeat(500)}`);
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
            makeBatchMessage('123', '100', new Date(3000)),
            makeBatchMessage('456', '200', new Date(1500)),
            makeBatchMessage('456', '200', new Date(2500)),
        ];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);

        expect(recordHandled).toHaveBeenCalledTimes(2);
        expect(recordHandled).toHaveBeenCalledWith('123', '101', new Date(2000).toISOString());
        expect(recordHandled).toHaveBeenCalledWith('456', '200', new Date(1500).toISOString());
    });

    test('bounds concurrent watermark writes, drains them, and warns in batch order', async () => {
        const first  = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        const third  = Promise.withResolvers<void>();
        const fourth = Promise.withResolvers<void>();
        const writes = new Map([['123', first], ['456', second], ['789', third], ['999', fourth]]);
        const admitted: string[] = [];
        const recordHandled = mock((channelId: string) => {
            admitted.push(channelId);
            return writes.get(channelId)!.promise;
        });
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        mockLogger.warn.mockClear();
        const config = captureConfig(params);
        const discordMessage = { id: '100', content: 'hi', channelId: '123' } as unknown as Message;
        const batch = [
            makeBatchMessage('123', '100', new Date(1000)),
            makeBatchMessage('456', '200', new Date(2000)),
            makeBatchMessage('789', '300', new Date(3000)),
            makeBatchMessage('999', '400', new Date(4000)),
        ];

        const response = config.onResponse!({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Bun.sleep(1);
        expect(admitted).toEqual(['123', '456', '789']);

        const firstError = new Error('first write failed');
        const thirdError = new Error('third write failed');
        third.reject(thirdError);
        second.resolve();
        await Bun.sleep(1);
        expect(admitted).toEqual(['123', '456', '789', '999']);
        expect(mockLogger.warn).not.toHaveBeenCalled();

        first.reject(firstError);
        fourth.resolve();
        await response;
        expect(mockLogger.warn).toHaveBeenNthCalledWith(1, { err: firstError, channelId: '123', msg: 'Failed to record handled watermark' });
        expect(mockLogger.warn).toHaveBeenNthCalledWith(2, { err: thirdError, channelId: '789', msg: 'Failed to record handled watermark' });
    });

    test('serializes watermark writes to the same channel across overlapping responses', async () => {
        const firstWrite = Promise.withResolvers<void>();
        let callCount = 0;
        const recordHandled = mock(() => {
            callCount++;
            return callCount === 1 ? firstWrite.promise : Promise.resolve();
        });
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);
        const discordMessage = { id: '100', content: 'hi', channelId: '123' } as unknown as Message;
        const result = { response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1' };

        const firstResponse = config.onResponse!(result, discordMessage, [makeBatchMessage('123', '100', new Date(1000))]);
        await Bun.sleep(1);
        const secondResponse = config.onResponse!({ ...result, envelopeId: 'env-2' }, discordMessage, [makeBatchMessage('123', '101', new Date(2000))]);
        await Bun.sleep(1);
        expect(recordHandled).toHaveBeenCalledTimes(1);

        firstWrite.resolve();
        await Promise.all([firstResponse, secondResponse]);
        expect(recordHandled).toHaveBeenCalledTimes(2);
        expect(recordHandled).toHaveBeenNthCalledWith(1, '123', '100', new Date(1000).toISOString());
        expect(recordHandled).toHaveBeenNthCalledWith(2, '123', '101', new Date(2000).toISOString());
    });

    test('retains the newest pending tail while an earlier same-channel write settles, then deletes the settled final tail', async () => {
        const firstWrite = Promise.withResolvers<void>();
        const secondWrite = Promise.withResolvers<void>();
        let calls = 0;
        const recordHandled = mock(() => (++calls === 1 ? firstWrite.promise : secondWrite.promise));
        const params = makeConductorParams({ inboxManager: { recordHandled } });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const deleteSpy = spyOn(Map.prototype, 'delete');
        spies.push(deleteSpy);
        const config = captureConfig(params);
        const discordMessage = { id: '100', content: 'hi', channelId: '123' } as unknown as Message;
        const result = { response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker };

        const firstResponse = config.onResponse!({ ...result, envelopeId: 'env-1' }, discordMessage, [makeBatchMessage('123', '100', new Date(1000))]);
        await Bun.sleep(1);
        const secondResponse = config.onResponse!({ ...result, envelopeId: 'env-2' }, discordMessage, [makeBatchMessage('123', '101', new Date(2000))]);
        await Bun.sleep(1);
        firstWrite.resolve();
        await Bun.sleep(1);
        expect(deleteSpy).not.toHaveBeenCalledWith('123');

        secondWrite.resolve();
        await Promise.all([firstResponse, secondResponse]);
        await Promise.resolve();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith('123');
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

    test('suppresses the expected no-response delivery sentinel without treating it as a conductor failure', async () => {
        const deliver = mock(async (_envelopeId: string, send: () => Promise<unknown>) => send());
        const params = makeConductorParams({
            conversationConductor: { submit: mock(() => Promise.resolve()), subscribeTurn: mock(() => mock(() => undefined)), deliver },
        });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: false, skipReason: 'no-response' }));
        const config = captureConfig(params);
        const discordMessage = { id: 'msg-1', content: 'hi', channelId: '123' } as unknown as Message;
        mockLogger.error.mockClear();

        await config.onResponse?.({
            response: '@@NO_RESPONSE@@', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-no-response',
        }, discordMessage, [makeBatchMessage('123', 'msg-1', new Date(0))]);

        expect(mockLogger.error).not.toHaveBeenCalled();
    });
});

describe('processAttachments', () => {
    const spies: ReturnType<typeof spyOn>[] = [];

    afterEach(() => {
        for(const spy of spies) {
            spy.mockRestore();
        }
        spies.length = 0;
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
    });

    function context(messageId: string, attachments: DiscordMessageContext['attachments']): DiscordMessageContext {
        return {
            guildId:   createGuildId('guild-1'),
            channelId: createChannelId('channel-1'),
            userId:    createUserId('user-1'),
            username:  'Craig',
            messageId,
            content:   'attachments',
            timestamp: new Date(0).toISOString(),
            botUserId: createUserId('bot-1'),
            attachments,
        };
    }

    test('returns empty media for an empty context batch without invoking either persistence boundary', async () => {
        const fetchImages = spyOn(attachmentsModule, 'fetchImages');
        const save = spyOn(attachmentsModule, 'saveNonImageAttachment');

        await expect(processAttachments([])).resolves.toEqual({ images: [], contentAdditions: [] });

        expect(fetchImages).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    test('returns empty media when every context has no attachments and does not invoke either persistence boundary', async () => {
        mockLogger.info.mockClear();
        const fetchImages = spyOn(attachmentsModule, 'fetchImages');
        const save = spyOn(attachmentsModule, 'saveNonImageAttachment');

        await expect(processAttachments([context('message-1', []), context('message-2', undefined)])).resolves.toEqual({ images: [], contentAdditions: [] });

        expect(fetchImages).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalled();
    });

    test('separates images from files, reports failed image retrieval, and saves every non-image recursively in input order', async () => {
        const image = { filename: 'photo.png', contentType: 'image/png', url: 'https://example.test/photo.png', size: 12 };
        const video = { filename: 'clip.mp4', contentType: 'video/mp4', url: 'https://example.test/clip.mp4', size: 2048 };
        const document = { filename: 'notes.txt', contentType: 'text/plain', url: 'https://example.test/notes.txt', size: 32 };
        const fetched = { filename: 'photo.png', mediaType: 'image/png' as const, base64Data: 'aGVsbG8=', originalSize: 12, width: 2, height: 3 };
        const failure = { filename: 'broken.jpg', contentType: 'image/jpeg', size: 99, error: 'timeout' };
        spies.push(
            spyOn(attachmentsModule, 'fetchImages').mockResolvedValue({ images: [fetched], failures: [failure] }),
            spyOn(attachmentsModule, 'saveNonImageAttachment').mockImplementation(async (attachment) => {
                return attachment.filename === 'clip.mp4'
                    ? { localPath: '/tmp/clip.mp4', originalFilename: 'clip.mp4', contentType: 'video/mp4', size: 2048 }
                    : { localPath: '/tmp/notes.txt', originalFilename: 'notes.txt', contentType: 'text/plain', size: 32 };
            })
        );

        const result = await processAttachments([context('first-message', [image, video]), context('second-message', [document])]);

        expect(attachmentsModule.fetchImages).toHaveBeenCalledWith([image]);
        expect(attachmentsModule.saveNonImageAttachment).toHaveBeenNthCalledWith(1, video, process.cwd(), 'first-message');
        expect(attachmentsModule.saveNonImageAttachment).toHaveBeenNthCalledWith(2, document, process.cwd(), 'first-message');
        expect(result).toEqual({
            images:           [fetched],
            contentAdditions: [
                '[Image fetch failed: broken.jpg - timeout]',
                '[Video file saved: /tmp/clip.mp4 (video/mp4, 2KB). Use analyzeLocalVideo to analyze this video for scene frames, metadata, and transcription.]',
                '[Attached file: /tmp/notes.txt (text/plain, 32B)]',
            ],
        });
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ totalAttachments: 1, fetchedImages: 1, failedImages: 1, msg: 'Fetched 1 images from 1 image attachments (1 failed)' }));
        expect(mockLogger.info).toHaveBeenCalledWith(expect.objectContaining({ filename: 'clip.mp4', msg: 'Saved non-image attachment: clip.mp4' }));
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ filename: 'broken.jpg', msg: 'Failed to fetch image: broken.jpg' }));
    });

    test('continues to later files after a failed non-image save and records the failure with its source metadata', async () => {
        const missing = { filename: 'missing.pdf', contentType: 'application/pdf', url: 'https://example.test/missing.pdf', size: 500 };
        const saved = { filename: 'saved.csv', contentType: 'text/csv', url: 'https://example.test/saved.csv', size: 50 };
        spies.push(spyOn(attachmentsModule, 'saveNonImageAttachment').mockImplementation(async (attachment) => {
            return attachment.filename === 'missing.pdf'
                ? null
                : { localPath: '/tmp/saved.csv', originalFilename: 'saved.csv', contentType: 'text/csv', size: 50 };
        }));

        await expect(processAttachments([context('message-1', [missing, saved])])).resolves.toEqual({
            images: [], contentAdditions: ['[Attached file: /tmp/saved.csv (text/csv, 50B)]'],
        });

        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ filename: 'missing.pdf', contentType: 'application/pdf', msg: 'Failed to save non-image attachment: missing.pdf' }));
        expect(attachmentsModule.saveNonImageAttachment).toHaveBeenCalledTimes(2);
    });

    test('does not produce an image-fetch summary for a non-image-only context', async () => {
        const document = { filename: 'notes.txt', contentType: 'text/plain', url: 'https://example.test/notes.txt', size: 32 };
        spies.push(spyOn(attachmentsModule, 'saveNonImageAttachment').mockResolvedValue(null));
        mockLogger.info.mockClear();

        await processAttachments([context('message-1', [document])]);

        expect(mockLogger.info).not.toHaveBeenCalled();
    });
});
