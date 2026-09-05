/**
 * Tests for coordinator-setup.ts — response-send path channel tracking (FIX A).
 *
 * Verifies that when a response is successfully sent to a Discord channel,
 * that channel ID is pushed into the recent-channels ring buffer.
 * The error path (send fails, i.e. sent: false) must NOT push the channel ID.
 */
import { describe, test, expect, mock, jest, afterEach, spyOn } from 'bun:test';
import type { Client, Message } from 'discord.js';
import type { ClaudeAgent, StreamTracker } from '@/agent';
import type { ChannelRegistryManager } from '@/integrations/discord/channel-registry/manager';
import * as messageCoordinatorModule from '@/integrations/discord/message-coordinator';
import type { MessageCoordinatorConfig, MessageProcessor, ProcessResult } from '@/integrations/discord/message-coordinator';
import * as responseSenderModule from '@/integrations/discord/response-sender';
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
    ): ((result: ProcessResult, discordMessage: Message | null) => Promise<void>) | undefined {
        let capturedOnResponse: ((result: ProcessResult, discordMessage: Message | null) => Promise<void>) | undefined;

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

        await onResponse!(makeProcessResult('test response'), makeMockMessage(channelId));

        expect(pushedChannels).toContain(channelId);
    });

    test('failed send (sent: false) does NOT push channel ID into ring buffer', async () => {
        const channelId = createChannelId('555666777888');
        const pushedChannels: ChannelId[] = [];

        // Mock sendResponse to return sent: false (e.g. queued to outbox)
        spies.push(spyOn(responseSenderModule, 'sendResponse').mockResolvedValue({ sent: false, queued: true }));

        const onResponse = captureOnResponse(id => pushedChannels.push(id));
        expect(onResponse).toBeDefined();

        await onResponse!(makeProcessResult('test response'), makeMockMessage(channelId));

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
