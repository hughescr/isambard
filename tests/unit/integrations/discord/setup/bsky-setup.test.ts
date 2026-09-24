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
import { createFakeOperationalStateStore, type FakeOperationalStateStore } from '../../../../helpers/fake-operational-state-store';
import { mockLogger } from '../../../../setup';
import type { NotifyParams } from '@/agent';
import { createChannelId } from '@/agent/types';
import { ChannelNotAccessibleError } from '@/errors';
import { createAtUri, createCid, type BlueskyClient } from '@/integrations/bsky';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupBsky, type BskySetupOptions } from '@/integrations/discord/setup/bsky-setup';
import type { ApprovedOutboundActionBackend } from '@/services';
import type { PersonAllowlist } from '@/storage';

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
        mockLogger.info.mockClear();
        options = {
            bskyClient:            { getPost: mock(async () => { throw new Error('no post'); }) } as unknown as BlueskyClient,
            docClient:             makeMockDocClient(),
            tableName:             'test-table',
            client:                {} as unknown as Client,
            adminDiscordChannelId: createChannelId('admin-channel-id'),
            approvedActions:       {} as unknown as ApprovedOutboundActionBackend,
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
            operationalStateStore: createFakeOperationalStateStore(),
            healthRegistry:        makeHealthRegistry({ available: { bsky: true } }),
            notify:                mock((_params: NotifyParams) => true),
            _deps:                 { sleep: noopSleep },
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
        await expect(
            result.sendApprovalRequest('hello', '@user.bsky.social', { parent: { uri: createAtUri('at://uri'), cid: createCid('cid123') } })
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('throws ChannelNotAccessibleError when channel.fetch returns null', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => null),
            },
        } as unknown as Client;

        const result = await setupBsky(options);

        await expect(
            result.sendApprovalRequest('hello', '@user.bsky.social', { parent: { uri: createAtUri('at://uri'), cid: createCid('cid123') } })
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('throws ChannelNotAccessibleError when the DM approval channel is not sendable', async () => {
        options.client = { channels: { fetch: mock(async () => null) } } as unknown as Client;
        const result = await setupBsky(options);

        await expect(result.sendDMApprovalRequest('hello', ['@user.bsky.social'], 'convo-1'))
            .rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('sends message when channel.fetch returns a sendable channel (object with send method)', async () => {
        const mockSend = mock(async () => undefined);
        options.client = {
            channels: {
                fetch: mock(async () => ({ send: mockSend })),
            },
        } as unknown as Client;

        const result = await setupBsky(options);

        await result.sendApprovalRequest('hello', '@user.bsky.social', { parent: { uri: createAtUri('at://uri'), cid: createCid('cid123') } });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
            embeds: expect.any(Array), components: expect.any(Array),
        }));
    });

    it('retries a transient approval-send failure through the injected sleep dependency', async () => {
        const sleep = mock(async (_ms: number) => {});
        const send = mock(async () => {
            if(send.mock.calls.length === 1) {
                throw new Error('temporary Discord failure');
            }
        });
        options._deps = { sleep };
        options.client = { channels: { fetch: mock(async () => ({ send })) } } as unknown as Client;

        const result = await setupBsky(options);

        await result.sendApprovalRequest('hello', '@user.bsky.social', { parent: { uri: createAtUri('at://uri'), cid: createCid('cid123') } });

        expect(send).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(0);
    });

    it('sends the reply approval embed and its action row through direct Discord delivery', async () => {
        const send = mock(async () => undefined);
        options.client = { channels: { fetch: mock(async () => ({ send })) } } as unknown as Client;
        (options.bskyClient.getPost as ReturnType<typeof mock>).mockResolvedValue({ text: 'Parent preview' });
        const result = await setupBsky(options);

        await result.sendApprovalRequest('reply text', '@user.bsky.social', { parent: { uri: createAtUri('at://parent'), cid: createCid('cid') } });

        const [payload] = send.mock.calls[0] as unknown as [{ embeds: { toJSON(): { fields?: { name: string, value: string }[] } }[], components: unknown[] }];
        expect(payload.embeds).toHaveLength(1);
        expect(payload.components).toHaveLength(1);
        expect(payload.embeds[0]?.toJSON().fields?.find(field => field.name === 'Replying to')?.value).toBe('@user.bsky.social');
    });

    it('uses the capability facade for reply and DM approvals with the durable approval priority', async () => {
        const sendToChannel = mock(async () => ({ status: 'sent' as const }));
        options.discordCapability = { sendToChannel } as never;
        (options.bskyClient.getPost as ReturnType<typeof mock>).mockResolvedValue({ text: 'Parent preview ✓' });
        const result = await setupBsky(options);

        await result.sendApprovalRequest('reply text', '@user.bsky.social', { parent: { uri: createAtUri('at://parent'), cid: createCid('cid') } });
        await result.sendDMApprovalRequest('dm text', ['@first.bsky.social', '@second.bsky.social'], 'convo');

        expect(sendToChannel).toHaveBeenCalledTimes(2);
        const calls = sendToChannel.mock.calls as unknown as [string, { embeds: { toJSON(): { fields?: { name: string, value: string }[] } }[], components: { components: unknown[] }[] }, unknown][];
        for(const call of calls) {
            expect(call[0]).toBe('admin-channel-id');
            expect(call[1].embeds).toHaveLength(1);
            expect(call[1].components).toHaveLength(1);
            expect(call[1].components[0]?.components).toHaveLength(3);
            expect(call[2]).toEqual({ priority: 'high', type: 'bsky_approval' });
        }
        expect(calls[0]?.[1].embeds[0]?.toJSON().fields?.find(field => field.name === 'Parent Post')?.value)
            .toBe('Parent preview ✓');
        expect(calls[1]?.[1].embeds[0]?.toJSON().fields?.find(field => field.name === 'Recipients')?.value)
            .toBe(JSON.stringify(['@first.bsky.social', '@second.bsky.social']));
    });

    it('uses the direct Discord send contract when the capability is unavailable', async () => {
        const send = mock(async () => undefined);
        const fetch = mock(async () => ({ send }));
        options.client = { channels: { fetch } } as unknown as Client;
        const result = await setupBsky(options);

        await result.sendDMApprovalRequest('dm text', ['@first.bsky.social'], 'convo');

        expect(fetch).toHaveBeenCalledWith('admin-channel-id');
        expect(send).toHaveBeenCalledTimes(1);
        const [payload] = send.mock.calls[0] as unknown as [{ embeds: { toJSON(): { fields?: { name: string, value: string }[] } }[], components: { components: unknown[] }[] }];
        expect(payload.embeds).toHaveLength(1);
        expect(payload.components).toHaveLength(1);
        expect(payload.components[0]?.components).toHaveLength(3);
        expect(payload.embeds[0]?.toJSON().fields?.find(field => field.name === 'Recipients')?.value)
            .toBe(JSON.stringify(['@first.bsky.social']));
    });

    it('propagates a direct Discord DM delivery failure after retry exhaustion', async () => {
        const send = mock(async () => {
            throw new Error('Discord unavailable');
        });
        options.client = { channels: { fetch: mock(async () => ({ send })) } } as unknown as Client;
        const result = await setupBsky(options);

        await expect(result.sendDMApprovalRequest('dm text', ['@first.bsky.social'], 'convo'))
            .rejects.toThrow('Discord unavailable');
        expect(send).toHaveBeenCalledTimes(3);
    });

    it('starts the outbound rate limiter at its documented 24-message capacity', async () => {
        const { rateLimiter } = await setupBsky(options);
        expect(rateLimiter.tokensRemaining()).toBe(24);
    });

    it('logs successful integration initialization', async () => {
        await setupBsky(options);

        expect(mockLogger.info).toHaveBeenCalledWith({ msg: 'Bluesky integration initialized' });
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
            adminDiscordChannelId: createChannelId('admin-channel-id'),
            approvedActions:       {} as unknown as ApprovedOutboundActionBackend,
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
            operationalStateStore: createFakeOperationalStateStore(),
            healthRegistry:        makeHealthRegistry({ available: { bsky: true } }),
            notify:                mock((_params: NotifyParams) => true),
            _deps:                 { sleep: noopSleep },
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
            source: 'bsky-dm', text: '1 new unread Bluesky conversation(s)', wake: false, key: 'msg-1',
        });
        // The poller's DM checkpoint persists through options.operationalStateStore.
        expect((options.operationalStateStore as FakeOperationalStateStore).stored({ owner: 'bsky', name: 'dm/checkpoint' }))
            .toMatchObject({ processedMessageIds: ['msg-1'] });

        result.dmPoller.stop();
    });

    it('threads options.notify into the Bluesky approval operations behind the adapter', async () => {
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
