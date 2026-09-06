/**
 * Tests for isSendableChannel type guard in bsky-setup.ts.
 *
 * The guard `isSendableChannel` is module-private — tested indirectly through the
 * `sendApprovalRequest` callback returned by `setupBsky`. These tests verify the
 * guard correctly rejects non-object values (killing the ConditionalExpression mutant
 * on `typeof channel === 'object'`).
 *
 * The `_deps.sleep` override eliminates retryAsync backoff delays in tests.
 */
import { describe, it, expect, mock, beforeEach, jest, afterEach } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Client } from 'discord.js';
import { makeHealthRegistry } from '../../../../helpers/fake-health-registry';
import type { NotifyParams } from '@/agent';
import { ChannelNotAccessibleError } from '@/errors';
import type { BlueskyClient } from '@/integrations/bsky';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupBsky, type BskySetupOptions } from '@/integrations/discord/setup/bsky-setup';
import type { ApprovalSagaBackend } from '@/services';
import type { MemoryToolBackend, PersonAllowlist } from '@/storage';

/** Minimal in-memory-shaped fake backend — DM checkpoint round-trips through it, but starts empty every test. */
function makeMockMemoryBackend(): MemoryToolBackend {
    return {
        get:    mock(async () => undefined),
        create: mock(async () => {}),
        update: mock(async () => {}),
    } as unknown as MemoryToolBackend;
}

/** Build a mock DynamoDB document client whose send() always returns {} (empty item). */
function makeMockDocClient(): DynamoDBDocumentClient {
    return { send: mock(async () => ({})) } as unknown as DynamoDBDocumentClient;
}

/** No-op sleep for instant retry in tests. */
async function noopSleep(_ms: number): Promise<void> {
    // no-op: eliminates retryAsync backoff delays in tests
}

describe('setupBsky — isSendableChannel type guard', () => {
    let options: BskySetupOptions;

    beforeEach(() => {
        options = {
            bskyClient:            { getPost: mock(async () => { throw new Error('no post'); }) } as unknown as BlueskyClient,
            docClient:             makeMockDocClient(),
            tableName:             'test-table',
            client:                {} as unknown as Client,
            adminDiscordChannelId: 'admin-channel-id',
            approvalSagaBackend:   {} as unknown as ApprovalSagaBackend,
            personAllowlist:       {
                isAllowed:       mock((_platform: string, _value: string) => false),
                isPersonAllowed: mock(() => false),
                addPerson:       mock(async () => {}),
                removePerson:    mock(async () => {}),
                load:            mock(async () => {}),
                list:            mock(async () => []),
                refreshPerson:   mock(async () => {}),
            } as unknown as PersonAllowlist,
            allowlistInteractionHandler: {
                startFromApproval: mock(async () => ({ allowlistSuffix: '' })),
                handleButton:      mock(async () => {}),
                handleModalSubmit: mock(async () => {}),
            } as unknown as AllowlistInteractionHandler,
            memoryBackend:  makeMockMemoryBackend(),
            healthRegistry: makeHealthRegistry({ available: { bluesky: true } }),
            notify:         mock((_params: NotifyParams) => true),
            _deps:          { sleep: noopSleep },
        };
    });

    it('throws ChannelNotAccessibleError when channel.fetch returns a non-object (string)', async () => {
        // channels.fetch returns a truthy non-object — isSendableChannel returns false
        options.client = {
            channels: {
                fetch: mock(async () => 'not-a-channel'),
            },
        } as unknown as Client;

        const result = await setupBsky(options);

        // Call sendApprovalRequest — it will call isSendableChannel with the string
        expect(
            result.sendApprovalRequest('hello', '@user.bsky.social', 'at://uri', 'cid123')
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('throws ChannelNotAccessibleError when channel.fetch returns null', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => null),
            },
        } as unknown as Client;

        const result = await setupBsky(options);

        expect(
            result.sendApprovalRequest('hello', '@user.bsky.social', 'at://uri', 'cid123')
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('sends message when channel.fetch returns a sendable channel (object with send method)', async () => {
        const mockSend = mock(async () => undefined);
        options.client = {
            channels: {
                fetch: mock(async () => ({ send: mockSend })),
            },
        } as unknown as Client;

        const result = await setupBsky(options);

        await result.sendApprovalRequest('hello', '@user.bsky.social', 'at://uri', 'cid123');

        expect(mockSend).toHaveBeenCalledTimes(1);
    });
});

describe('setupBsky — Q8 DM poller and notify threading', () => {
    let options: BskySetupOptions;

    beforeEach(() => {
        jest.useFakeTimers();
        options = {
            bskyClient: {
                getPost:           mock(async () => { throw new Error('no post'); }),
                listConversations: mock(async () => ({ conversations: [] })),
            } as unknown as BlueskyClient,
            docClient:             makeMockDocClient(),
            tableName:             'test-table',
            client:                {} as unknown as Client,
            adminDiscordChannelId: 'admin-channel-id',
            approvalSagaBackend:   {} as unknown as ApprovalSagaBackend,
            personAllowlist:       {
                isAllowed:       mock((_platform: string, _value: string) => false),
                isPersonAllowed: mock(() => false),
                addPerson:       mock(async () => {}),
                removePerson:    mock(async () => {}),
                load:            mock(async () => {}),
                list:            mock(async () => []),
                refreshPerson:   mock(async () => {}),
            } as unknown as PersonAllowlist,
            allowlistInteractionHandler: {
                startFromApproval: mock(async () => ({ allowlistSuffix: '' })),
                handleButton:      mock(async () => {}),
                handleModalSubmit: mock(async () => {}),
            } as unknown as AllowlistInteractionHandler,
            memoryBackend:  makeMockMemoryBackend(),
            healthRegistry: makeHealthRegistry({ available: { bluesky: true } }),
            notify:         mock((_params: NotifyParams) => true),
            _deps:          { sleep: noopSleep },
        };
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('returns a dmPoller that is not already started', async () => {
        const result = await setupBsky(options);

        jest.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();

        expect(options.bskyClient.listConversations).not.toHaveBeenCalled();
        expect(result.dmPoller).toBeDefined();
    });

    it('threads options.notify into the returned dmPoller so a started tick can notify', async () => {
        options.dmPollIntervalMs = 1000;
        (options.bskyClient.listConversations as ReturnType<typeof mock>).mockImplementation(async () => ({
            conversations: [{
                id:          'c1', rev:         'r1', members:     [], muted:       false, unreadCount: 1,
                lastMessage: { id: 'msg-1', rev: 'r', text: 'hi', senderDid: 'did:plc:x', sentAt: '2026-01-01T00:00:00.000Z' },
            }],
        }));
        const result = await setupBsky(options);

        result.dmPoller.start();
        jest.advanceTimersByTime(1000);
        for(let i = 0; i < 5; i++) {
            // eslint-disable-next-line no-await-in-loop -- sequential microtask flush by design
            await Promise.resolve();
        }

        expect(options.notify).toHaveBeenCalledTimes(1);
        expect((options.notify as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
            source: 'bluesky-dm', text: '1 new unread Bluesky conversation(s)', wake: false, dedupeKey: 'bsky-dm:msg-1',
        });

        result.dmPoller.stop();
    });

    it('threads options.notify into the BskyOutboundApprovalHandler construction', async () => {
        const result = await setupBsky(options);
        const { interaction } = {
            interaction: {
                customId: 'bsky-send-reject-reason:11111111-1111-1111-1111-111111111111',
                message:  {
                    embeds: [{
                        description: 'hello',
                        fields:      [
                            { name: 'Replying to', value: '@user.bsky.social' },
                            { name: 'Parent URI', value: 'at://uri' },
                            { name: 'Parent CID', value: 'cid' },
                        ],
                    }],
                },
                fields:      { getTextInputValue: mock(() => 'not appropriate') },
                deferUpdate: mock(async () => {}),
                editReply:   mock(async () => {}),
            },
        };

        await result.outboundApprovalHandler.handleModalSubmit(interaction as unknown as Parameters<typeof result.outboundApprovalHandler.handleModalSubmit>[0]);

        expect(options.notify).toHaveBeenCalledTimes(1);
        expect((options.notify as ReturnType<typeof mock>).mock.calls[0]?.[0]).toMatchObject({
            source: 'bsky-approval', wake: true,
        });
    });
});
