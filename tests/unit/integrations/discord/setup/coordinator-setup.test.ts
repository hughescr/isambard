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
import type { ClaudeAgent, StreamTracker } from '@/agent';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageCoordinatorConfig, MessageProcessor, ProcessResult } from '@/integrations/discord/message-coordinator';
import * as responseSenderModule from '@/integrations/discord/response-sender';
import * as conductorProcessorModule from '@/integrations/discord/setup/conductor-processor';
import { setupCoordinatorIntegration } from '@/integrations/discord/setup/coordinator-setup';
import type { BotStateManager, StateChange } from '@/integrations/discord/state';
import { createChannelId, createGuildId, createUserId, type ChannelId, type DiscordMessageContext } from '@/integrations/discord/types';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeMockBotStateManager(): BotStateManager {
    return {
        subscribe:              mock((_listener: (change: StateChange) => void) => mock(() => undefined)),
        getMode:                mock(() => 'idle' as const),
        goIdle:                 mock(() => undefined),
        startProcessingMessage: mock(() => undefined),
        shouldUpdatePresence:   mock(() => false),
        recordPresenceUpdate:   mock(() => undefined),
        start:                  mock(() => undefined),
        stop:                   mock(() => undefined),
    } as unknown as BotStateManager;
}

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

/** Build a minimal Discord Message mock with the given channelId */
function makeMockMessage(channelId: string): Message {
    return {
        channelId,
        content: 'hello',
        channel: { id: channelId },
    } as unknown as Message;
}

function makeMockAgent(): ClaudeAgent {
    return {
        handleInput: mock(async () => ({
            response:       'Hello back',
            sessionId:      'sess-1',
            wasInterrupted: false,
            streamTracker:  {},
        })),
    } as unknown as ClaudeAgent;
}

/** Minimal params for setupCoordinatorIntegration */
function makeSetupParams(
    addRecentChannel: (id: ChannelId) => void
): Parameters<typeof setupCoordinatorIntegration>[0] {
    return {
        agent:                  makeMockAgent(),
        presenceManager:        undefined,
        dynamicStatusGenerator: undefined,
        botStateManager:        makeMockBotStateManager(),
        catchUpSessionRunner:   undefined,
        perchSessionRunner:     undefined,
        responseRouter:         makeMockResponseRouter(),
        rateLimiter:            makeMockRateLimiter(),
        readyClient:            makeMockClient(),
        channelRegistry:        makeMockChannelRegistry(),
        addRecentChannel,
    };
}

// ---------------------------------------------------------------------------
// FIX A: response-send path feeds recent-channels ring buffer
// ---------------------------------------------------------------------------

describe('setupCoordinatorIntegration — FIX A: response-send channel tracking', () => {
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

    /** Minimal ProcessResult for testing — streamTracker is unused in the onResponse path */
    function makeProcessResult(response: string): ProcessResult {
        return {
            response,
            sessionId:      'sess-1',
            wasInterrupted: false,
            streamTracker:  {} as StreamTracker,
        };
    }

    /** Mock MessageCoordinator constructor and capture the onResponse config. */
    function captureOnResponse(
        addRecentChannel: (id: ChannelId) => void
    ): ((result: ProcessResult, discordMessage: Message | null, batch: Message[]) => Promise<void>) | undefined {
        let capturedOnResponse: ((result: ProcessResult, discordMessage: Message | null, batch: Message[]) => Promise<void>) | undefined;

        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((config: MessageCoordinatorConfig): messageCoordinatorModule.MessageCoordinator => {
            capturedOnResponse = config.onResponse;
            const stub = { setProcessor: mock(() => undefined), stop: mock(() => undefined) };
            return stub as unknown as messageCoordinatorModule.MessageCoordinator;
        }));

        setupCoordinatorIntegration(makeSetupParams(addRecentChannel));

        return capturedOnResponse;
    }

    test('successful send pushes channel ID into ring buffer via addRecentChannel callback', async () => {
        const channelId = createChannelId('111222333444');
        const pushedChannels: ChannelId[] = [];

        // Mock sendResponse to return sent: true (only field exercised here)
        spies.push(spyOn(responseSenderModule, 'sendResponse').mockResolvedValue({ sent: true }));

        const onResponse = captureOnResponse(id => pushedChannels.push(id));
        expect(onResponse).toBeDefined();

        await onResponse!(makeProcessResult('test response'), makeMockMessage(channelId), []);

        expect(pushedChannels).toContain(channelId);
    });

    test('failed send (sent: false) does NOT push channel ID into ring buffer', async () => {
        const channelId = createChannelId('555666777888');
        const pushedChannels: ChannelId[] = [];

        // Mock sendResponse to return sent: false (e.g. queued to outbox)
        spies.push(spyOn(responseSenderModule, 'sendResponse').mockResolvedValue({ sent: false, queued: true }));

        const onResponse = captureOnResponse(id => pushedChannels.push(id));
        expect(onResponse).toBeDefined();

        await onResponse!(makeProcessResult('test response'), makeMockMessage(channelId), []);

        expect(pushedChannels).not.toContain(channelId);
    });

    test('receive path wiring: setupCoordinatorIntegration accepts addRecentChannel without errors', () => {
        // Smoke test: verifies the receive-path subscription in bot.ts coexists with the send-path fix.
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => {
            return { setProcessor: mock(() => undefined), stop: mock(() => undefined) } as unknown as messageCoordinatorModule.MessageCoordinator;
        }));

        expect(() => setupCoordinatorIntegration(makeSetupParams(mock(() => undefined)))).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// P2: explicit requestingUserId — 'Requesting user:' line prepended to the batch,
// no ambient @/agent conversation-context setters called.
// ---------------------------------------------------------------------------

describe('setupCoordinatorIntegration — explicit requesting user', () => {
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

    function makeContext(overrides: Partial<DiscordMessageContext> = {}): DiscordMessageContext {
        return {
            guildId:   createGuildId('1'),
            channelId: createChannelId('123456789012345678'),
            userId:    createUserId('user-42'),
            username:  'alice',
            messageId: 'msg-1',
            content:   'hello there',
            timestamp: new Date(0).toISOString(),
            botUserId: createUserId('bot-1'),
            ...overrides,
        };
    }

    /** Mock the MessageCoordinator constructor and capture the processor passed to setProcessor(). */
    function captureProcessor(agent: ClaudeAgent): MessageProcessor | undefined {
        let capturedProcessor: MessageProcessor | undefined;

        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => {
            const stub = {
                setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
                stop:         mock(() => undefined),
            };
            return stub as unknown as messageCoordinatorModule.MessageCoordinator;
        }));

        setupCoordinatorIntegration({ ...makeSetupParams(mock(() => undefined)), agent });

        return capturedProcessor;
    }

    test('prepends "Requesting user: <userId> (<username>)" to the first context content passed to handleInput', async () => {
        const agent = makeMockAgent();
        const processor = captureProcessor(agent);
        expect(processor).toBeDefined();

        await processor!([makeContext()], null, new AbortController().signal);

        const handleInputMock = agent.handleInput as unknown as ReturnType<typeof mock>;
        expect(handleInputMock).toHaveBeenCalled();
        const [passedContexts] = handleInputMock.mock.calls[0] as [{ content: string }[], unknown];
        expect(passedContexts[0].content).toBe('Requesting user: user-42 (alice)\nhello there');
    });

    test('only prepends the requesting-user line to the first context in a batch', async () => {
        const agent = makeMockAgent();
        const processor = captureProcessor(agent);
        expect(processor).toBeDefined();

        await processor!(
            [makeContext(), makeContext({ messageId: 'msg-2', content: 'second message' })],
            null,
            new AbortController().signal
        );

        const handleInputMock = agent.handleInput as unknown as ReturnType<typeof mock>;
        const [passedContexts] = handleInputMock.mock.calls[0] as [{ content: string }[], unknown];
        expect(passedContexts[1].content).toBe('second message');
    });

    test('falls back to "(unknown)" when the first context has no username', async () => {
        const agent = makeMockAgent();
        const processor = captureProcessor(agent);
        expect(processor).toBeDefined();

        await processor!([makeContext({ username: undefined })], null, new AbortController().signal);

        const handleInputMock = agent.handleInput as unknown as ReturnType<typeof mock>;
        const [passedContexts] = handleInputMock.mock.calls[0] as [{ content: string }[], unknown];
        expect(passedContexts[0].content).toBe('Requesting user: user-42 (unknown)\nhello there');
    });

    test('does not throw on an empty context batch', async () => {
        const agent = makeMockAgent();
        const processor = captureProcessor(agent);
        expect(processor).toBeDefined();

        // Should resolve without throwing (e.g. a TypeError on first.userId in
        // prependRequestingUserLine) for an empty batch.
        await processor!([], null, new AbortController().signal);

        const handleInputMock = agent.handleInput as unknown as ReturnType<typeof mock>;
        const [passedContexts] = handleInputMock.mock.calls[0] as [unknown[], unknown];
        expect(passedContexts).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// P9: conductor-mode branch — createConductorProcessor selected instead of agent.handleInput;
// onResponse delivers idempotently, never calls goIdle, keeps the resume-after-suspension blocks.
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
        const agent = makeMockAgentForConductor();
        return {
            agent,
            presenceManager:        undefined,
            dynamicStatusGenerator: undefined,
            botStateManager:        makeMockBotStateManager(),
            catchUpSessionRunner:   undefined,
            perchSessionRunner:     undefined,
            responseRouter:         makeMockResponseRouter(),
            rateLimiter:            makeMockRateLimiter(),
            readyClient:            makeMockClient(),
            channelRegistry:        makeMockChannelRegistry(),
            conversationConductor:  {
                submit: mock(() => Promise.resolve({
                    envelopeId: 'env-1', response: 'ok', wasInterrupted: false, partialWork: { thinking: '', text: '', pendingToolUse: null }, sessionId: 'sess-1', isError: false, contextUsagePercent: 0,
                })),
                subscribeTurn: mock(() => mock(() => undefined)),
                deliver:       mock(async (_envelopeId: string, send: () => Promise<{ channelId: string, messageIds: string[] }>) => {
                    await send();
                    return { delivered: true };
                }),
            },
            contextPolicy:    { shouldInjectUserMemory: mock(() => false), markInjected: mock(() => undefined), eventsDelta: mock(() => Promise.resolve([])), markEventsSeen: mock(() => undefined), stateTopSetDelta: mock(() => Promise.resolve({ added: [], removed: [], changed: [] })), markStateTopSetSeen: mock(() => Promise.resolve()), resetAll: mock(() => undefined) },
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

    function makeMockAgentForConductor(): ClaudeAgent {
        return { handleInput: mock(async () => ({ response: 'unused', sessionId: 'x', wasInterrupted: false, streamTracker: {} })) } as unknown as ClaudeAgent;
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

    test('selects createConductorProcessor and never calls agent.handleInput', () => {
        const params = makeConductorParams();
        let capturedProcessor: MessageProcessor | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
            setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator)));

        setupCoordinatorIntegration(params);

        expect(capturedProcessor).toBeDefined();
        expect(params.agent.handleInput).not.toHaveBeenCalled();
    });

    test('P11: forwards ledgerStore/presenceThrottle/dynamicStatusGenerator into createConductorProcessor when provided', () => {
        const createConductorProcessorSpy = spyOn(conductorProcessorModule, 'createConductorProcessor');
        spies.push(
            createConductorProcessorSpy,
            // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
            spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
                setProcessor: mock(() => undefined),
                stop:         mock(() => undefined),
            } as unknown as messageCoordinatorModule.MessageCoordinator))
        );

        const ledgerStore = { dispatch: mock(() => undefined) };
        const presenceThrottle = { shouldUpdate: mock(() => true), record: mock(() => undefined) };
        const dynamicStatusGenerator = { generateSynopsis: mock(() => Promise.resolve(null)), generateCatchUpSynopsis: mock(() => Promise.resolve(null)) };
        const params = makeConductorParams({ ledgerStore, presenceThrottle, dynamicStatusGenerator });

        setupCoordinatorIntegration(params);

        expect(createConductorProcessorSpy).toHaveBeenCalledWith(expect.objectContaining({ ledgerStore, throttle: presenceThrottle, dynamicStatusGenerator }));
    });

    test('P11: forwards onThinkingContentUpdate into createConductorProcessor when provided', () => {
        const createConductorProcessorSpy = spyOn(conductorProcessorModule, 'createConductorProcessor');
        spies.push(
            createConductorProcessorSpy,
            // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
            spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
                setProcessor: mock(() => undefined),
                stop:         mock(() => undefined),
            } as unknown as messageCoordinatorModule.MessageCoordinator))
        );

        const onThinkingContentUpdate = mock(() => undefined);
        const params = makeConductorParams({ onThinkingContentUpdate });

        setupCoordinatorIntegration(params);

        expect(createConductorProcessorSpy).toHaveBeenCalledWith(expect.objectContaining({ onThinkingContentUpdate }));
    });

    test('P11: omits ledgerStore/throttle from createConductorProcessor when not provided (backward compatible)', () => {
        const createConductorProcessorSpy = spyOn(conductorProcessorModule, 'createConductorProcessor');
        spies.push(
            createConductorProcessorSpy,
            // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
            spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
                setProcessor: mock(() => undefined),
                stop:         mock(() => undefined),
            } as unknown as messageCoordinatorModule.MessageCoordinator))
        );

        setupCoordinatorIntegration(makeConductorParams());

        const call = createConductorProcessorSpy.mock.calls[0]?.[0] as { ledgerStore?: unknown, throttle?: unknown } | undefined;
        expect(call?.ledgerStore).toBeUndefined();
        expect(call?.throttle).toBeUndefined();
    });

    test('the selected processor actually routes through conductor.submit, never agent.handleInput, when invoked', async () => {
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

        expect(params.conversationConductor!.submit).toHaveBeenCalled();
        expect(params.agent.handleInput).not.toHaveBeenCalled();
    });

    test('onProcessingEnd never calls goIdle in conductor mode', () => {
        const params = makeConductorParams();
        const config = captureConfig(params);

        config.onProcessingEnd?.({ wasInterrupted: true, willResume: false });

        expect(params.botStateManager.goIdle).not.toHaveBeenCalled();
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

    test('onResponse resumes a suspended legacy catch-up/perch run once idle, same as the legacy branch (P12 has not yet retired these runners)', async () => {
        const resumeAfterSuspension = mock(() => Promise.resolve());
        const catchUpSessionRunner = {
            isSuspended: mock(() => true), resumeAfterSuspension, clearSuspension: mock(() => undefined),
        };
        const perchResumeAfterSuspension = mock(() => Promise.resolve());
        const perchSessionRunner = {
            isSuspended: mock(() => true), resumeAfterSuspension: perchResumeAfterSuspension, clearSuspension: mock(() => undefined),
        };
        const params = makeConductorParams({ catchUpSessionRunner, perchSessionRunner });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Promise.resolve();

        expect(resumeAfterSuspension).toHaveBeenCalled();
        expect(perchResumeAfterSuspension).toHaveBeenCalled();
    });

    test('onResponse does NOT resume catch-up/perch while botStateManager is still busy (not idle)', async () => {
        const resumeAfterSuspension = mock(() => Promise.resolve());
        const catchUpSessionRunner = {
            isSuspended: mock(() => true), resumeAfterSuspension, clearSuspension: mock(() => undefined),
        };
        const botStateManager = { ...makeMockBotStateManager(), getMode: mock(() => 'processing_message' as const) };
        const params = makeConductorParams({ catchUpSessionRunner, botStateManager });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Promise.resolve();

        expect(resumeAfterSuspension).not.toHaveBeenCalled();
    });

    test('onResponse does not attempt to resume when the legacy runner is not suspended', async () => {
        const resumeAfterSuspension = mock(() => Promise.resolve());
        const catchUpSessionRunner = {
            isSuspended: mock(() => false), resumeAfterSuspension, clearSuspension: mock(() => undefined),
        };
        const params = makeConductorParams({ catchUpSessionRunner });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Promise.resolve();

        expect(resumeAfterSuspension).not.toHaveBeenCalled();
    });

    test('onResponse clears suspension when the resume attempt itself fails', async () => {
        const resumeAfterSuspension = mock(() => Promise.reject(new Error('resume failed')));
        const clearSuspension = mock(() => undefined);
        const catchUpSessionRunner = {
            isSuspended: mock(() => true), resumeAfterSuspension, clearSuspension,
        };
        const params = makeConductorParams({ catchUpSessionRunner });
        spies.push(spyOn(responseSenderModule, 'sendEnvelopeResponse').mockResolvedValue({ sent: true }));
        const config = captureConfig(params);

        const discordMessage = {
            id: 'msg-1', content: 'hi', channelId: '123', channel: { id: '123', isDMBased: () => false },
        } as unknown as Message;
        const batch = [makeBatchMessage('123', 'msg-1', new Date(0))];

        await config.onResponse?.({
            response: 'hello', sessionId: 'sess-1', wasInterrupted: false, streamTracker: {} as StreamTracker, envelopeId: 'env-1',
        }, discordMessage, batch);
        await Promise.resolve();
        await Promise.resolve();

        expect(clearSuspension).toHaveBeenCalled();
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

    test('legacy branch (no conversationConductor) still uses agent.handleInput', () => {
        const agent = makeMockAgentForConductor();
        let capturedProcessor: MessageProcessor | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
            setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator)));

        setupCoordinatorIntegration({ ...makeSetupParams(mock(() => undefined)), agent });

        expect(capturedProcessor).toBeDefined();
        expect(agent.handleInput).not.toHaveBeenCalled();
    });

    test('the legacy branch\'s selected processor actually routes through agent.handleInput when invoked (no conductor to route through)', async () => {
        const agent = makeMockAgentForConductor();
        let capturedProcessor: MessageProcessor | undefined;
        // @ts-expect-error - Mocking class constructor; mockImplementation typed as never for constructors
        spies.push(spyOn(messageCoordinatorModule, 'MessageCoordinator').mockImplementation((): messageCoordinatorModule.MessageCoordinator => ({
            setProcessor: mock((fn: MessageProcessor) => { capturedProcessor = fn; }),
            stop:         mock(() => undefined),
        } as unknown as messageCoordinatorModule.MessageCoordinator)));

        setupCoordinatorIntegration({ ...makeSetupParams(mock(() => undefined)), agent });
        expect(capturedProcessor).toBeDefined();

        await capturedProcessor!([makeMinimalContext()], null, new AbortController().signal);

        expect(agent.handleInput).toHaveBeenCalled();
    });
});
