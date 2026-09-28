/**
 * Tests for isSendableChannel type guard in email-setup.ts.
 *
 * The guard `isSendableChannel` is module-private — tested indirectly through the
 * `sendApprovalRequest` callback exposed in EmailSetupResult. These tests verify
 * the guard correctly rejects non-object values (killing the ConditionalExpression
 * mutant on `typeof channel === 'object'`).
 *
 * The `_deps.sleep` override eliminates retryAsync backoff delays in tests.
 */
import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ButtonInteraction, Client } from 'discord.js';
import { mockLogger } from '../../../../setup';
import type { NotifyParams } from '@/agent';
import { createChannelId } from '@/agent/types';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { approvalCardEditGate } from '@/integrations/discord/approvals/card-edit-gate';
import type { EmailApprovalCard } from '@/integrations/discord/approvals/email-approval-card';
import { EmailApprovalCardPresenter } from '@/integrations/discord/approvals/email-approval-cards';
import { buildReviewEmbed, buildUnsafeAlert } from '@/integrations/discord/approvals/email-embeds';
import { setupEmail, buildEmailApprovalCardTransport, buildEmailProcessorCallbacks, type EmailSetupOptions } from '@/integrations/discord/setup/email-setup';
import { type EmailMetadata, type ClassifierVerdict, WildDuckClient, ClassifierVerdictType, EmailFolder  } from '@/integrations/email';
import type { ApprovedOutboundActionBackend } from '@/services';
import type { PersonAllowlist } from '@/storage';

async function drainMicrotasks(ticks = 10): Promise<void> {
    for(let i = 0; i < ticks; i++) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential microtask flushing
        await Promise.resolve();
    }
}

/** Minimal valid NotifyFn mock — always reports delivery succeeded. */
function makeNotify() {
    return mock((_params: NotifyParams) => true);
}

/** Minimal EmailMetadata fixture — only the fields the callbacks under test read. */
function makeEmail(overrides: Partial<EmailMetadata> = {}): EmailMetadata {
    return {
        uid:            42,
        messageId:      '<msg@example.com>',
        from:           { address: 'sender@example.com', name: 'Sender' },
        to:             [],
        cc:             [],
        subject:        'Test subject',
        date:           new Date('2026-01-01T00:00:00Z'),
        bodyText:       'body',
        hasAttachments: false,
        attachments:    [],
        headers:        {},
        ...overrides,
    };
}

/** Minimal ClassifierVerdict fixture. */
function makeVerdict(
    overrides: Partial<Pick<ClassifierVerdict, 'verdict' | 'confidence' | 'reason'>> = {}
): ClassifierVerdict {
    const verdict = overrides.verdict ?? ClassifierVerdictType.Uncertain;
    const fields = {
        confidence: overrides.confidence ?? 0.5,
        reason:     overrides.reason ?? 'test reason',
    };

    return { verdict, ...fields };
}

/** Build a mock DynamoDB document client whose send() always returns {} (empty item). */
function makeMockDocClient(): DynamoDBDocumentClient {
    return { send: mock(async () => ({})) } as unknown as DynamoDBDocumentClient;
}

/** No-op sleep for instant retry in tests. */
async function noopSleep(_ms: number): Promise<void> {
    // no-op: eliminates retryAsync backoff delays in tests
}

function makeDeferred(): { promise: Promise<void>, resolve: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, resolve: release };
}

const MINIMAL_EMAIL_CONFIG = {
    user:                           'test@example.com',
    password:                       'secret',
    pollFallbackMs:                 300_000,
    sseReconnectDelayMs:            5000,
    maxBodySizeBytes:               50_000,
    wildDuckApiUrl:                 'http://localhost:8080',
    sendReservoirCapacity:          24,
    sendReservoirRefillRatePerHour: 1,
};

/** The admin review channel — top-level config, handed to setupEmail as its own option (not via emailConfig). */
const ADMIN_REVIEW_CHANNEL_ID = createChannelId('review-7');

interface RegisteredTool {
    handler:     (...args: unknown[]) => Promise<{ content: unknown[], isError?: boolean }>
    inputSchema: { parseAsync: (args: unknown) => Promise<unknown> }
}

function getToolHandler(result: Awaited<ReturnType<typeof setupEmail>>, toolName: string): (args: unknown) => Promise<{ content: unknown[], isError?: boolean }> {
    const registered = (result.emailMcpServer as unknown as { instance: { _registeredTools: Record<string, RegisteredTool> } }).instance
        ._registeredTools[toolName];
    return async (args: unknown) => registered.handler(await registered.inputSchema.parseAsync(args));
}

describe('setupEmail — isSendableChannel type guard', () => {
    let options: EmailSetupOptions;

    beforeEach(async () => {
        mockLogger.info.mockClear();
        options = {
            emailConfig:           MINIMAL_EMAIL_CONFIG,
            docClient:             makeMockDocClient(),
            tableName:             'test-table',
            client:                {} as unknown as Client,
            adminDiscordUserId:    'admin-user-id',
            adminDiscordChannelId: ADMIN_REVIEW_CHANNEL_ID,
            // Provide a pre-created wildDuckClient so WildDuck init() is skipped
            wildDuckClient:        {
                getUserAddresses:   mock(async () => []),
                getMessages:        mock(async () => ({ messages: [], nextCursor: undefined })),
                uploadMessage:      mock(async () => ({ id: 'msg-id', uid: 1 })),
                submitMessage:      mock(async () => undefined),
                updateMessageFlags: mock(async () => undefined),
                getMessage:         mock(async () => null),
            } as unknown as WildDuckClient,
            approvedActions:      {} as unknown as ApprovedOutboundActionBackend,
            approvedActionReader: { get: mock(async () => undefined) },
            personAllowlist:      {
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
            _deps:  { sleep: noopSleep },
            notify: makeNotify(),
        };
    });

    it('exposes the approval card presenter, wired to the email tools', async () => {
        const getMessage = mock(async () => null);
        options.wildDuckClient = { ...options.wildDuckClient, getMessage } as unknown as WildDuckClient;
        const result = await setupEmail(options);

        expect(result.approvalCards).toBeInstanceOf(EmailApprovalCardPresenter);
        expect(await result.approvalCards.present(9)).toBe('missing');
        expect(getMessage).toHaveBeenCalledWith('Drafts', 9);
    });

    it('gives cards a preview link only when a preview URL builder is passed', async () => {
        const token = 'A'.repeat(43);
        const sendToChannel = mock(async (_channelId: string, _payload: { components: { toJSON(): { components: { url?: string }[] } }[] }) => ({ status: 'queued', outboxId: 'o' }));
        options.discordCapability = { sendToChannel } as never;
        options.wildDuckClient = { ...options.wildDuckClient, getMessage: mock(async () => ({ id: 3, draft: true, metaData: { previewToken: token } })) } as unknown as WildDuckClient;
        const linkUrls = (): (string | undefined)[] => sendToChannel.mock.calls.at(-1)![1].components.flatMap(row => row.toJSON().components.map(c => c.url)).filter(url => url !== undefined);

        const withoutPreview = await setupEmail(options);
        await withoutPreview.approvalCards.present(3);
        expect(linkUrls()).toEqual([]);

        options.previewUrlFor = (uid, t) => `https://mac.ts.net/d/${uid}/${t}`;
        const withPreview = await setupEmail(options);
        await withPreview.approvalCards.present(3);
        expect(linkUrls()).toEqual([`https://mac.ts.net/d/3/${token}`]);
    });

    it('decides clicks under the process-wide card gate, on the draft\'s key after the card\'s', async () => {
        const getMessage = mock(async () => ({ id: 5, draft: true, messageId: '<m@x>', date: '2026-09-27T00:00:00.000Z', metaData: {} }));
        const create = mock(async () => undefined);
        options.wildDuckClient = { ...options.wildDuckClient, getMessage, updateMessageMetadata: mock(async () => undefined) } as unknown as WildDuckClient;
        options.approvedActions = { create };
        const result = await setupEmail(options);
        const interaction = {
            customId:    'email-send-approve:5',
            message:     { id: 'card-5', channelId: 'admin', fetch: mock(async () => ({ components: [{ components: [{ customId: 'email-send-approve:5' }] }] })) },
            deferUpdate: mock(async () => ({})),
            editReply:   mock(async () => ({})),
            followUp:    mock(async () => ({})),
        } as unknown as ButtonInteraction;
        const releaseDraft = approvalCardEditGate.hold('email-draft:5');

        const clicking = result.outboundApprovalHandler.handleButton(interaction);
        await drainMicrotasks();
        expect(approvalCardEditGate.pendingEdit('card-5')).toBeDefined();
        expect(getMessage).not.toHaveBeenCalled();

        releaseDraft();
        await clicking;
        expect(create).toHaveBeenCalledTimes(1);
        expect(approvalCardEditGate.pendingEdit('card-5')).toBeUndefined();
    });

    it('reads the approved-action row through the configured reader, refusing a click on a completed approval', async () => {
        const getMessage = mock(async () => ({ id: 6, draft: true, messageId: '<m@x>', date: '2026-09-27T00:00:00.000Z', metaData: { approval: { actionId: 'act-6', at: 'x' } } }));
        const get = mock(async (_id: string) => ({ id: 'act-6' }));
        const create = mock(async () => undefined);
        options.wildDuckClient = { ...options.wildDuckClient, getMessage } as unknown as WildDuckClient;
        options.approvedActions = { create };
        options.approvedActionReader = { get } as unknown as EmailSetupOptions['approvedActionReader'];
        const result = await setupEmail(options);
        const followUp = mock(async () => ({}));
        const interaction = {
            customId:    'email-send-approve:6',
            message:     { id: 'card-6', channelId: 'admin', fetch: mock(async () => ({ components: [{ components: [{ customId: 'email-send-approve:6' }] }] })) },
            deferUpdate: mock(async () => ({})),
            editReply:   mock(async () => ({})),
            followUp,
        } as unknown as ButtonInteraction;

        await result.outboundApprovalHandler.handleButton(interaction);

        expect(get.mock.calls).toEqual([['act-6']]);
        expect(create).not.toHaveBeenCalled();
        expect(followUp).toHaveBeenCalledWith({ content: 'This draft was already approved or rejected.', flags: 64 });
    });

    it('marks an amended draft superseded through the approvals when neither delete worked', async () => {
        const getMessage = mock(async () => ({ id: 42, draft: true, to: [{ address: 'a@example.com' }], metaData: {} }));
        const updateMessageMetadata = mock(async () => undefined);
        options.wildDuckClient = {
            ...options.wildDuckClient,
            getUserAddresses:     mock(async () => [{ address: 'formal@example.com', tags: ['formal'] }]),
            getMessage,
            updateMessageMetadata,
            uploadReplacingDraft: mock(async () => ({ id: 55, previousDeleted: false })),
            deleteMessage:        mock(async () => {
                throw new Error('delete failed');
            }),
        } as unknown as WildDuckClient;
        options.discordCapability = { sendToChannel: mock(async () => ({ status: 'queued', outboxId: 'o' })) } as never;
        const result = await setupEmail(options);

        const response = await getToolHandler(result, 'amendAndResubmitDraft')({ message: 'Drafts:42' });

        expect(updateMessageMetadata).toHaveBeenCalledWith('Drafts', 42, { supersededBy: 55 });
        expect((response.content[0] as { text: string }).text).toBe('Message saved to Drafts, pending admin approval (draft UID: 55).');
    });

    it('posts approval cards directly with the injected retry sleep when there is no Discord capability', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        const fetch = mock(async () => {
            throw new Error('Discord temporarily unavailable');
        });
        options.client = { channels: { fetch } } as unknown as Client;
        options._deps = { sleep };
        options.wildDuckClient = { ...options.wildDuckClient, getMessage: mock(async () => ({ id: 3, draft: true, metaData: {} })) } as unknown as WildDuckClient;
        const result = await setupEmail(options);

        expect(await result.approvalCards.present(3)).toBe('failed');

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('does not expose the admin review channel on the email setup result', async () => {
        const result = await setupEmail(options);

        expect(result).not.toHaveProperty('adminChannelId');
    });

    it('creates and initializes WildDuck when no client is provided, and logs the lifecycle', async () => {
        options.wildDuckClient = undefined;
        const initSpy = spyOn(WildDuckClient.prototype, 'init').mockResolvedValue(undefined);

        await setupEmail(options);

        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(mockLogger.info.mock.calls).toContainEqual(['Starting WildDuck client...']);
        expect(mockLogger.info.mock.calls).toContainEqual(['WildDuck client initialized']);
        expect(mockLogger.info.mock.calls).toContainEqual([{ msg: 'Email integration initialized' }]);
        initSpy.mockRestore();
    });

    it('targets the configured WildDuck API URL when it creates the client', async () => {
        options.wildDuckClient = undefined;
        const initSpy = spyOn(WildDuckClient.prototype, 'init').mockResolvedValue(undefined);

        const result = await setupEmail(options);

        expect(result.wildDuckClient.getApiUrl()).toBe(MINIMAL_EMAIL_CONFIG.wildDuckApiUrl);
        initSpy.mockRestore();
    });

    it('does not finish setup until a newly-created WildDuck client is initialized', async () => {
        const gate = makeDeferred();
        const started = makeDeferred();
        options.wildDuckClient = undefined;
        const initSpy = spyOn(WildDuckClient.prototype, 'init').mockImplementation(async () => {
            started.resolve();
            await gate.promise;
        });
        const setupOperation = setupEmail(options);

        try {
            await started.promise;
            await drainMicrotasks();
            expect(Bun.peek.status(setupOperation)).toBe('pending');
        } finally {
            gate.resolve();
            try {
                await setupOperation;
            } finally {
                initSpy.mockRestore();
            }
        }
    });
});

describe('buildEmailApprovalCardTransport', () => {
    const CARD: EmailApprovalCard = { embeds: [], components: [] };
    const REF = { channelId: 'admin-ch', messageId: 'card-1' };

    function transport(client: unknown, discordCapability?: unknown, sleep = noopSleep): ReturnType<typeof buildEmailApprovalCardTransport> {
        return buildEmailApprovalCardTransport({
            client:                client as Client,
            adminDiscordChannelId: ADMIN_REVIEW_CHANNEL_ID,
            discordCapability:     discordCapability as never,
            retryDeps:             { deps: { sleep } },
        });
    }

    it('posts a card through the capability with high-priority approval outbox metadata', async () => {
        const sendToChannel = mock(async (_channelId: string, _payload: unknown, _metadata: unknown) => ({ status: 'queued' as const, outboxId: 'o1' }));

        expect(await transport({}, { sendToChannel }).postCard(CARD)).toEqual({ status: 'queued', outboxId: 'o1' });
        expect(sendToChannel.mock.calls).toEqual([[ADMIN_REVIEW_CHANNEL_ID, CARD, { priority: 'high', type: 'email_approval' }]]);
    });

    it('posts a card straight to the admin review channel without a capability, returning the sent message', async () => {
        const message = { id: 'card-9', channelId: ADMIN_REVIEW_CHANNEL_ID };
        const send = mock(async (_payload: unknown) => message);
        const fetch = mock(async (_channelId: string) => ({ send }));

        expect(await transport({ channels: { fetch } }).postCard(CARD)).toEqual({ status: 'sent', message: message as never });
        expect(fetch.mock.calls).toEqual([[ADMIN_REVIEW_CHANNEL_ID]]);
        expect(send.mock.calls).toEqual([[CARD]]);
    });

    it.each([
        ['a non-object', 'not-a-channel'],
        ['null', null],
    ])('rejects with ChannelNotAccessibleError when the admin channel is %s, after retrying', async (_label, channel) => {
        const sleep = mock(async (_ms: number) => undefined);
        const fetch = mock(async () => channel);

        await expect(transport({ channels: { fetch } }, undefined, sleep).postCard(CARD)).rejects.toBeInstanceOf(ChannelNotAccessibleError);
        expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not finish a direct post until Discord has taken it', async () => {
        const gate = makeDeferred();
        const started = makeDeferred();
        const send = mock(async () => {
            started.resolve();
            await gate.promise;
            return { id: 'm' };
        });
        const operation = transport({ channels: { fetch: mock(async () => ({ send })) } }).postCard(CARD);

        await started.promise;
        await drainMicrotasks();
        expect(Bun.peek.status(operation)).toBe('pending');
        gate.resolve();
        expect(await operation).toEqual({ status: 'sent', message: { id: 'm' } as never });
    });

    it('reads a card\'s channel through the capability, keeping only a text channel', async () => {
        const textChannel = { isTextBased: () => true };
        const fetchChannel = mock(async (_channelId: string) => textChannel);

        expect(await transport({}, { fetchChannel }).fetchChannel('admin-ch')).toBe(textChannel as never);
        expect(fetchChannel.mock.calls).toEqual([['admin-ch']]);

        fetchChannel.mockImplementation(async () => ({ isTextBased: () => false }));
        expect(await transport({}, { fetchChannel }).fetchChannel('admin-ch')).toBeNull();

        fetchChannel.mockImplementation(async () => null as never);
        expect(await transport({}, { fetchChannel }).fetchChannel('admin-ch')).toBeNull();
    });

    it('reads a card\'s channel straight from the client without a capability', async () => {
        const textChannel = { isTextBased: () => true };
        const fetch = mock(async (_channelId: string) => textChannel);

        expect(await transport({ channels: { fetch } }).fetchChannel('admin-ch')).toBe(textChannel as never);
        expect(fetch.mock.calls).toEqual([['admin-ch']]);
    });

    it('replies under a card through the capability, as a high-priority notification', async () => {
        const sendText = mock(async (_channelId: string, _text: string, _options: unknown) => ({ status: 'sent' }));

        await transport({}, { sendText }).reply(REF, 'Edited');

        expect(sendText.mock.calls).toEqual([['admin-ch', 'Edited', { replyToMessageId: 'card-1', priority: 'high', type: 'email_notification' }]]);
    });

    it('replies under a card straight to its channel without a capability, and skips a channel that cannot take messages', async () => {
        const send = mock(async (_payload: unknown) => ({}));
        const fetch = mock(async (_channelId: string) => ({ send }));

        await transport({ channels: { fetch } }).reply(REF, 'Edited');

        expect(fetch.mock.calls).toEqual([['admin-ch']]);
        expect(send.mock.calls).toEqual([[{ content: 'Edited', reply: { messageReference: 'card-1' } }]]);

        fetch.mockImplementation(async () => null as never);
        await expect(transport({ channels: { fetch } }).reply(REF, 'Edited')).resolves.toBeUndefined();
    });
});

describe('setupEmail — createEmailMcpServerInstance', () => {
    let options: EmailSetupOptions;

    beforeEach(() => {
        options = {
            emailConfig:           MINIMAL_EMAIL_CONFIG,
            docClient:             makeMockDocClient(),
            tableName:             'test-table',
            client:                { channels: { fetch: mock(async () => ({ send: mock(async () => undefined) })) } } as unknown as Client,
            adminDiscordUserId:    'admin-user-id',
            adminDiscordChannelId: ADMIN_REVIEW_CHANNEL_ID,
            wildDuckClient:        {
                getUserAddresses:   mock(async () => []),
                getMessages:        mock(async () => ({ messages: [], nextCursor: undefined })),
                uploadMessage:      mock(async () => ({ id: 'msg-id', uid: 1 })),
                submitMessage:      mock(async () => undefined),
                updateMessageFlags: mock(async () => undefined),
                getMessage:         mock(async () => null),
            } as unknown as WildDuckClient,
            approvedActions:      {} as unknown as ApprovedOutboundActionBackend,
            approvedActionReader: { get: mock(async () => undefined) },
            personAllowlist:      {
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
            _deps:  { sleep: noopSleep },
            notify: makeNotify(),
        };
    });

    it('returns a new McpServerConfig instance distinct from emailMcpServer on each call', async () => {
        const result = await setupEmail(options);

        const first = result.createEmailMcpServerInstance();
        const second = result.createEmailMcpServerInstance();

        expect(first).not.toBe(result.emailMcpServer);
        expect(second).not.toBe(first);
    });

    it('applies the configured rate limiter capacity rather than the constructor default', async () => {
        options.emailConfig = { ...MINIMAL_EMAIL_CONFIG, sendReservoirCapacity: 0, sendReservoirRefillRatePerHour: 7 };
        options.wildDuckClient = {
            ...options.wildDuckClient,
            getUserAddresses: mock(async () => [{ address: 'formal@example.com', tags: ['formal'] }]),
            uploadMessage:    mock(async () => 71),
            submitMessage:    mock(async () => undefined),
        } as unknown as WildDuckClient;
        options.personAllowlist = { ...options.personAllowlist, isAllowed: mock(() => true) } as unknown as PersonAllowlist;
        const result = await setupEmail(options);

        const response = await getToolHandler(result, 'sendEmail')({
            to: 'recipient@example.com', subject: 'Rate limit', body: 'body', senderProfile: 'formal',
        });

        expect((response.content[0] as { text: string }).text).toBe('Sent successfully. Warning: send rate limit reached (0 tokens remaining).');
    });

    it('sends restricted-mailbox notices through the capability with complete embed payload and metadata', async () => {
        const sendToChannel = mock<(channelId: string, payload: unknown, metadata: unknown) => Promise<{ status: 'sent' }>>(async () => ({ status: 'sent' as const }));
        options.discordCapability = { sendToChannel } as never;
        const result = await setupEmail(options);

        const response = await getToolHandler(result, 'getEmailContent')({ message: 'Quarantine:19' });

        expect(response.isError).toBe(true);
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, payload, metadata] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(ADMIN_REVIEW_CHANNEL_ID);
        expect((payload as { embeds: unknown[], components: unknown[] }).embeds).toHaveLength(1);
        expect((payload as { embeds: unknown[], components: unknown[] }).components).toHaveLength(1);
        expect(metadata).toEqual({ priority: 'high', type: 'email_notification' });
    });

    it('logs the restricted-mailbox delivery failure with its specific context', async () => {
        mockLogger.error.mockClear();
        options.discordCapability = {
            sendToChannel: mock(async () => {
                throw new Error('outbox unavailable');
            }),
        } as never;
        const result = await setupEmail(options);

        await getToolHandler(result, 'getEmailContent')({ message: 'Quarantine:20' });

        expect(mockLogger.error).toHaveBeenCalledWith({
            error: 'outbox unavailable',
            msg:   'Failed to send restricted mailbox notification to admin channel',
        });
    });

    it('does not return a restricted-mailbox result until its admin notice is delivered', async () => {
        const gate = makeDeferred();
        const started = makeDeferred();
        const deliveryFinished = makeDeferred();
        const order: string[] = [];
        options.discordCapability = {
            sendToChannel: mock(async () => {
                started.resolve();
                await gate.promise;
                order.push('delivery');
                deliveryFinished.resolve();
                return { status: 'sent' as const };
            }),
        } as never;
        const result = await setupEmail(options);
        const operation = getToolHandler(result, 'getEmailContent')({ message: 'Quarantine:21' });
        void operation.then(() => {
            order.push('operation');
            return undefined;
        });

        try {
            await started.promise;
            await drainMicrotasks();
            expect(Bun.peek.status(operation)).toBe('pending');
        } finally {
            gate.resolve();
            await operation;
            await deliveryFinished.promise;
        }

        expect(order).toEqual(['delivery', 'operation']);
    });
});

describe('buildEmailProcessorCallbacks', () => {
    const adminDiscordChannelId = createChannelId('admin-channel-id');
    let notify: ReturnType<typeof makeNotify>;
    let sendToChannel: ReturnType<typeof mock<(channelId: string, content: unknown, options?: unknown) => Promise<{ status: 'sent' }>>>;
    let discordCapability: { sendToChannel: typeof sendToChannel };

    beforeEach(() => {
        notify = makeNotify();
        sendToChannel = mock((_channelId: string, _content: unknown, _options?: unknown) => Promise.resolve({ status: 'sent' as const }));
        discordCapability = { sendToChannel };
    });

    it('onSafe notifies with wake:false and a uid-keyed notify key, and posts the unchanged admin content', async () => {
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: discordCapability as never,
            notify,
        });
        const email = makeEmail({ uid: 7, from: { address: 'sender@example.com', name: 'Sender' }, subject: 'Hi there' });

        await callbacks.onSafe?.(email, makeVerdict({ verdict: ClassifierVerdictType.Safe }));

        expect(notify).toHaveBeenCalledTimes(1);
        const call = notify.mock.calls[0][0];
        expect(call.source).toBe('email');
        expect(call.wake).toBe(false);
        expect(call.key).toBe('safe:7');
        expect(call.text).toBe('Safe email from sender@example.com — not on allowlist. Subject: Hi there');
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        expect((content as { content?: string }).content).toBe(
            'Safe email from **sender@example.com** — not on allowlist.\nSubject: Hi there\n\nTo allowlist: first `/contact add` (if needed), then `/allowlist add <personId>`.'
        );
    });

    it('onReview notifies with wake:false and a uid-keyed notify key, and posts the unchanged review embed', async () => {
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: discordCapability as never,
            notify,
        });
        const email = makeEmail({ uid: 8 });

        const verdict = makeVerdict();
        await callbacks.onReview?.(email, verdict);

        expect(notify).toHaveBeenCalledTimes(1);
        const call = notify.mock.calls[0][0];
        expect(call.source).toBe('email');
        expect(call.wake).toBe(false);
        expect(call.key).toBe('review:8');
        expect(call.text).toBe(`Email needs review: ${email.subject}`);
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        const expected = buildReviewEmbed(email, EmailFolder.Review);
        const actual = content as { embeds: { toJSON: () => unknown }[], components: { toJSON: () => unknown }[] };
        expect(actual.embeds).toHaveLength(1);
        expect(actual.embeds[0].toJSON()).toEqual(expected.embed.toJSON());
        expect(actual.components).toHaveLength(1);
        expect(actual.components[0].toJSON()).toEqual(expected.actionRow.toJSON());
    });

    it('onAuthFailed notifies with wake:false and a uid-keyed notify key, and posts the unchanged admin content', async () => {
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: discordCapability as never,
            notify,
        });
        const email = makeEmail({ uid: 9, from: { address: 'sender@example.com', name: 'Sender' }, subject: 'Auth fail' });

        await callbacks.onAuthFailed?.(email);

        expect(notify).toHaveBeenCalledTimes(1);
        const call = notify.mock.calls[0][0];
        expect(call.source).toBe('email');
        expect(call.wake).toBe(false);
        expect(call.key).toBe('auth-failed:9');
        expect(call.text).toBe('Allowlisted sender sender@example.com failed auth check. Subject: Auth fail');
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        expect((content as { content?: string }).content).toBe(
            'Allowlisted sender **sender@example.com** failed SPF/DKIM auth check.\nSubject: Auth fail\nEmail was sent to classifier instead of auto-approved.'
        );
    });

    it('onUnsafe notifies with wake:true and a uid-keyed notify key, and posts the unchanged unsafe alert embed', async () => {
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: discordCapability as never,
            notify,
        });
        const email = makeEmail({ uid: 10 });

        const verdict = makeVerdict({ verdict: ClassifierVerdictType.Unsafe });
        await callbacks.onUnsafe?.(email, verdict);

        expect(notify).toHaveBeenCalledTimes(1);
        const call = notify.mock.calls[0][0];
        expect(call.source).toBe('email');
        expect(call.wake).toBe(true);
        expect(call.key).toBe('unsafe:10');
        expect(call.text).toBe(`Unsafe email quarantined: ${email.subject}`);
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        const expected = buildUnsafeAlert(email, verdict, EmailFolder.Quarantine);
        const actual = content as { embeds: { toJSON: () => unknown }[], components: { toJSON: () => unknown }[] };
        expect(actual.embeds).toHaveLength(1);
        expect(actual.embeds[0].toJSON()).toEqual(expected.embed.toJSON());
        expect(actual.components).toHaveLength(1);
        expect(actual.components[0].toJSON()).toEqual(expected.actionRow.toJSON());
    });

    it('calls notify only after the admin-channel send has resolved, not before', async () => {
        const order: string[] = [];
        const orderedSendToChannel = mock(() => {
            order.push('send');
            return Promise.resolve({ status: 'sent' as const });
        });
        const orderedNotify = mock((_params: NotifyParams) => {
            order.push('notify');
            return true;
        });
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: { sendToChannel: orderedSendToChannel } as never,
            notify:            orderedNotify,
        });

        await callbacks.onSafe?.(makeEmail(), makeVerdict());

        expect(order).toEqual(['send', 'notify']);
    });

    it.each([
        ['onSafe',       (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onSafe?.(makeEmail(), makeVerdict())],
        ['onReview',     (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onReview?.(makeEmail(), makeVerdict())],
        ['onUnsafe',     (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onUnsafe?.(makeEmail(), makeVerdict())],
        ['onAuthFailed', (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onAuthFailed?.(makeEmail())],
    ])('%s waits for capability delivery before notifying', async (_name, invoke) => {
        const gate = makeDeferred();
        const started = makeDeferred();
        const deferredNotify = makeNotify();
        const callbacks = buildEmailProcessorCallbacks({
            client:            {} as unknown as Client,
            adminDiscordChannelId,
            discordCapability: {
                sendToChannel: mock(async () => {
                    started.resolve();
                    await gate.promise;
                    return { status: 'sent' as const };
                }),
            } as never,
            notify: deferredNotify,
        });
        const operation = invoke(callbacks);

        try {
            await started.promise;
            await drainMicrotasks();
            expect(deferredNotify).not.toHaveBeenCalled();
        } finally {
            gate.resolve();
            await operation;
        }

        expect(deferredNotify).toHaveBeenCalledTimes(1);
    });

    it('waits for direct Discord delivery before notifying', async () => {
        const gate = makeDeferred();
        const started = makeDeferred();
        const deferredNotify = makeNotify();
        const callbacks = buildEmailProcessorCallbacks({
            client: {
                channels: {
                    fetch: mock(async () => ({
                        send: mock(async () => {
                            started.resolve();
                            await gate.promise;
                        }),
                    })),
                },
            } as unknown as Client,
            adminDiscordChannelId,
            notify: deferredNotify,
        });
        const operation = callbacks.onSafe?.(makeEmail(), makeVerdict());

        try {
            await started.promise;
            await drainMicrotasks();
            expect(deferredNotify).not.toHaveBeenCalled();
        } finally {
            gate.resolve();
            await operation;
        }

        expect(deferredNotify).toHaveBeenCalledTimes(1);
    });

    it('falls back to client.channels.fetch when discordCapability is not provided', async () => {
        const mockSend = mock(async () => undefined);
        const fetch = mock(async (_channelId: string) => ({ send: mockSend }));
        const callbacks = buildEmailProcessorCallbacks({
            client: { channels: { fetch } } as unknown as Client,
            adminDiscordChannelId,
            notify,
        });

        await callbacks.onSafe?.(makeEmail(), makeVerdict());

        expect(fetch).toHaveBeenCalledWith(adminDiscordChannelId);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['onSafe',       (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onSafe?.(makeEmail(), makeVerdict()), 'Failed to send safe-but-not-allowlisted notification to admin channel'],
        ['onReview',     (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onReview?.(makeEmail(), makeVerdict()), 'Failed to send email review embed to admin channel'],
        ['onUnsafe',     (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onUnsafe?.(makeEmail(), makeVerdict()), 'Failed to send unsafe alert to admin channel'],
        ['onAuthFailed', (callbacks: ReturnType<typeof buildEmailProcessorCallbacks>) => callbacks.onAuthFailed?.(makeEmail()), 'Failed to send auth-failure notification to admin channel'],
    ])('%s logs its specific admin delivery failure', async (_name, invoke, expectedMessage) => {
        mockLogger.error.mockClear();
        const callbacks = buildEmailProcessorCallbacks({
            client: { channels: { fetch: mock(async () => { throw new Error('offline'); }) } } as unknown as Client,
            adminDiscordChannelId,
            notify,
        });

        await invoke(callbacks);

        expect(mockLogger.error).toHaveBeenCalledWith({ error: 'offline', msg: expectedMessage });
    });
});
