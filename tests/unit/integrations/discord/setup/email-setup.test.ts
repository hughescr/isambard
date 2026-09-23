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
import { ButtonStyle, type Client } from 'discord.js';
import { mockLogger } from '../../../../setup';
import type { NotifyParams } from '@/agent';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupEmail, buildEmailProcessorCallbacks, type EmailSetupOptions } from '@/integrations/discord/setup/email-setup';
import { type EmailMetadata, type ClassifierVerdict, WildDuckClient, ClassifierVerdictType, buildReviewEmbed, buildUnsafeAlert, EmailFolder  } from '@/integrations/email';
import type { ApprovalSagaBackend } from '@/services';
import type { PersonAllowlist } from '@/storage';

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
    adminDiscordChannelId:          'admin-channel-id',
    wildDuckApiUrl:                 'http://localhost:8080',
    sendReservoirCapacity:          24,
    sendReservoirRefillRatePerHour: 1,
};

interface RegisteredTool {
    handler: (...args: unknown[]) => Promise<{ content: unknown[], isError?: boolean }>
}

function getToolHandler(result: Awaited<ReturnType<typeof setupEmail>>, toolName: string): RegisteredTool['handler'] {
    return ((result.emailMcpServer as unknown as { instance: { _registeredTools: Record<string, RegisteredTool> } }).instance
        ._registeredTools[toolName]
        .handler);
}

describe('setupEmail — isSendableChannel type guard', () => {
    let options: EmailSetupOptions;

    beforeEach(async () => {
        mockLogger.info.mockClear();
        options = {
            emailConfig:        MINIMAL_EMAIL_CONFIG,
            docClient:          makeMockDocClient(),
            tableName:          'test-table',
            client:             {} as unknown as Client,
            adminDiscordUserId: 'admin-user-id',
            // Provide a pre-created wildDuckClient so WildDuck init() is skipped
            wildDuckClient:     {
                getUserAddresses:   mock(async () => []),
                getMessages:        mock(async () => ({ messages: [], nextCursor: undefined })),
                uploadMessage:      mock(async () => ({ id: 'msg-id', uid: 1 })),
                submitMessage:      mock(async () => undefined),
                updateMessageFlags: mock(async () => undefined),
                getMessage:         mock(async () => null),
            } as unknown as WildDuckClient,
            approvalSagaBackend: {} as unknown as ApprovalSagaBackend,
            personAllowlist:     {
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

    it('throws ChannelNotAccessibleError when channel.fetch returns a non-object (string)', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => 'not-a-channel'),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        // Call sendApprovalRequest — isSendableChannel('not-a-channel') → false → throws
        await expect(
            result.sendApprovalRequest('to@example.com', 'Test Subject', 123)
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('throws ChannelNotAccessibleError when channel.fetch returns null', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => null),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        // null: isSendableChannel → false → throws
        await expect(
            result.sendApprovalRequest('to@example.com', 'Test Subject', 123)
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('sends message when channel.fetch returns a sendable channel (object with send method)', async () => {
        const mockSend = mock(async (_payload: unknown) => undefined);
        options.client = {
            channels: {
                fetch: mock(async () => ({ send: mockSend })),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        await result.sendApprovalRequest('to@example.com', 'Test Subject', 123, ['copy@example.com']);

        expect(mockSend).toHaveBeenCalledTimes(1);
        const payload = mockSend.mock.calls[0]?.[0] as { embeds: { toJSON: () => { fields?: { name: string, value: string }[] } }[], components: unknown[] };
        expect(payload.embeds[0]?.toJSON().fields).toContainEqual(expect.objectContaining({
            name: 'CC', value: 'copy@example.com',
        }));
        expect(payload.embeds[0]?.toJSON().fields).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'To', value: 'to@example.com', inline: true }),
            expect.objectContaining({ name: 'Subject', value: 'Test Subject', inline: true }),
            expect.objectContaining({ name: 'UID', value: '123', inline: true }),
        ]));
        expect(payload.components).toHaveLength(1);
    });

    it('omits the CC field when no copies are supplied', async () => {
        const mockSend = mock(async (_payload: unknown) => undefined);
        options.client = { channels: { fetch: mock(async () => ({ send: mockSend })) } } as unknown as Client;
        const result = await setupEmail(options);
        await result.sendApprovalRequest('to@example.com', 'Test Subject', 123);
        const payload = mockSend.mock.calls[0]?.[0] as { embeds: { toJSON: () => { fields?: { name: string }[] } }[] };
        expect(payload.embeds[0]?.toJSON().fields?.some(field => field.name === 'CC')).toBe(false);
    });

    it('omits CC for an empty recipient list and preserves the comma separator and inline layout when recipients exist', async () => {
        const mockSend = mock(async (_payload: unknown) => undefined);
        options.client = { channels: { fetch: mock(async () => ({ send: mockSend })) } } as unknown as Client;
        const result = await setupEmail(options);

        await result.sendApprovalRequest('to@example.com', 'Test Subject', 123, []);
        let fields = (mockSend.mock.calls[0]?.[0] as { embeds: { toJSON: () => { fields?: { name: string, value: string, inline: boolean }[] } }[] }).embeds[0]?.toJSON().fields ?? [];
        expect(fields.some(field => field.name === 'CC')).toBe(false);

        await result.sendApprovalRequest('to@example.com', 'Test Subject', 124, ['one@example.com', 'two@example.com']);
        fields = (mockSend.mock.calls[1]?.[0] as { embeds: { toJSON: () => { fields?: { name: string, value: string, inline: boolean }[] } }[] }).embeds[0]?.toJSON().fields ?? [];
        expect(fields).toContainEqual(expect.objectContaining({ name: 'CC', value: 'one@example.com, two@example.com', inline: true }));
    });

    it('uses the configured retry policy and injected sleep when direct Discord delivery repeatedly fails', async () => {
        const sleep = mock(async (_ms: number) => undefined);
        const fetch = mock(async () => {
            throw new Error('Discord temporarily unavailable');
        });
        options.client = { channels: { fetch } } as unknown as Client;
        options._deps = { sleep };
        const result = await setupEmail(options);

        await expect(result.sendApprovalRequest('to@example.com', 'Test Subject', 123)).rejects.toThrow('Discord temporarily unavailable');

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('passes the complete approval payload and high-priority outbox metadata to Discord capability', async () => {
        const sendToChannel = mock<(channelId: string, payload: unknown, metadata: unknown) => Promise<{ status: 'sent' }>>(async () => ({ status: 'sent' as const }));
        options.discordCapability = { sendToChannel } as never;
        const result = await setupEmail(options);

        await result.sendApprovalRequest('to@example.com', 'Capability subject', 321);

        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, payload, metadata] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(MINIMAL_EMAIL_CONFIG.adminDiscordChannelId);
        expect((payload as { embeds: unknown[], components: unknown[] }).embeds).toHaveLength(1);
        expect((payload as { embeds: unknown[], components: unknown[] }).components).toHaveLength(1);
        expect(metadata).toEqual({ priority: 'high', type: 'email_approval' });
    });

    it('creates distinct, correctly styled approval actions that target the requested draft', async () => {
        const mockSend = mock(async (_payload: unknown) => undefined);
        options.client = { channels: { fetch: mock(async () => ({ send: mockSend })) } } as unknown as Client;
        const result = await setupEmail(options);

        await result.sendApprovalRequest('to@example.com', 'Test Subject', 321);

        const payload = mockSend.mock.calls[0]?.[0] as { components: { toJSON: () => { components: { type: number, custom_id: string, label: string, style: ButtonStyle }[] } }[] };
        expect(payload.components[0]?.toJSON().components).toEqual([
            { type: 2, custom_id: 'email-send-approve:321', label: 'Approve', style: ButtonStyle.Success },
            { type: 2, custom_id: 'email-send-approveallowlist:321', label: 'Approve + Allowlist...', style: ButtonStyle.Primary },
            { type: 2, custom_id: 'email-send-reject:321', label: 'Reject', style: ButtonStyle.Danger },
        ]);
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
            await Bun.sleep(0);
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

    it('does not finish an approval request until direct Discord delivery completes', async () => {
        const gate = makeDeferred();
        const started = makeDeferred();
        const deliveryFinished = makeDeferred();
        const order: string[] = [];
        const send = mock(async () => {
            started.resolve();
            await gate.promise;
            order.push('delivery');
            deliveryFinished.resolve();
        });
        options.client = { channels: { fetch: mock(async () => ({ send })) } } as unknown as Client;
        const result = await setupEmail(options);
        const operation = result.sendApprovalRequest('to@example.com', 'Deferred delivery', 456);
        void operation.then(() => {
            order.push('operation');
            return undefined;
        });

        try {
            await started.promise;
            await Bun.sleep(0);
            expect(Bun.peek.status(operation)).toBe('pending');
        } finally {
            gate.resolve();
            await operation;
            await deliveryFinished.promise;
        }

        expect(order).toEqual(['delivery', 'operation']);
    });
});

describe('setupEmail — createEmailMcpServerInstance', () => {
    let options: EmailSetupOptions;

    beforeEach(() => {
        options = {
            emailConfig:        MINIMAL_EMAIL_CONFIG,
            docClient:          makeMockDocClient(),
            tableName:          'test-table',
            client:             { channels: { fetch: mock(async () => ({ send: mock(async () => undefined) })) } } as unknown as Client,
            adminDiscordUserId: 'admin-user-id',
            wildDuckClient:     {
                getUserAddresses:   mock(async () => []),
                getMessages:        mock(async () => ({ messages: [], nextCursor: undefined })),
                uploadMessage:      mock(async () => ({ id: 'msg-id', uid: 1 })),
                submitMessage:      mock(async () => undefined),
                updateMessageFlags: mock(async () => undefined),
                getMessage:         mock(async () => null),
            } as unknown as WildDuckClient,
            approvalSagaBackend: {} as unknown as ApprovalSagaBackend,
            personAllowlist:     {
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
            to: 'recipient@example.com', subject: 'Rate limit', body: 'body', identity: 'formal',
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
        expect(channelId).toBe(MINIMAL_EMAIL_CONFIG.adminDiscordChannelId);
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
            await Bun.sleep(0);
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
    const adminDiscordChannelId = 'admin-channel-id';
    let notify: ReturnType<typeof makeNotify>;
    let sendToChannel: ReturnType<typeof mock<(channelId: string, content: unknown, options?: unknown) => Promise<{ status: 'sent' }>>>;
    let discordCapability: { sendToChannel: typeof sendToChannel };

    beforeEach(() => {
        notify = makeNotify();
        sendToChannel = mock((_channelId: string, _content: unknown, _options?: unknown) => Promise.resolve({ status: 'sent' as const }));
        discordCapability = { sendToChannel };
    });

    it('onSafe notifies with wake:false and a uid-keyed dedupeKey, and posts the unchanged admin content', async () => {
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
        expect(call.dedupeKey).toBe('email-safe:7');
        expect(call.text).toBe('Safe email from sender@example.com — not on allowlist. Subject: Hi there');
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        expect((content as { content?: string }).content).toBe(
            'Safe email from **sender@example.com** — not on allowlist.\nSubject: Hi there\n\nTo allowlist: first `/contact add` (if needed), then `/allowlist add <personId>`.'
        );
    });

    it('onReview notifies with wake:false and a uid-keyed dedupeKey, and posts the unchanged review embed', async () => {
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
        expect(call.dedupeKey).toBe('email-review:8');
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

    it('onAuthFailed notifies with wake:false and a uid-keyed dedupeKey, and posts the unchanged admin content', async () => {
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
        expect(call.dedupeKey).toBe('email-auth-failed:9');
        expect(call.text).toBe('Allowlisted sender sender@example.com failed auth check. Subject: Auth fail');
        expect(sendToChannel).toHaveBeenCalledTimes(1);
        const [channelId, content] = sendToChannel.mock.calls[0];
        expect(channelId).toBe(adminDiscordChannelId);
        expect((content as { content?: string }).content).toBe(
            'Allowlisted sender **sender@example.com** failed SPF/DKIM auth check.\nSubject: Auth fail\nEmail was sent to classifier instead of auto-approved.'
        );
    });

    it('onUnsafe notifies with wake:true and a uid-keyed dedupeKey, and posts the unchanged unsafe alert embed', async () => {
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
        expect(call.dedupeKey).toBe('email-unsafe:10');
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
            await Bun.sleep(0);
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
            await Bun.sleep(0);
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
