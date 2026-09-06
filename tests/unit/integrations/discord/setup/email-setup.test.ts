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
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Client } from 'discord.js';
import type { NotifyParams } from '@/agent';
import { ChannelNotAccessibleError } from '@/errors';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupEmail, buildEmailProcessorCallbacks, type EmailSetupOptions } from '@/integrations/discord/setup/email-setup';
import { type EmailMetadata, type ClassifierVerdict, type WildDuckClient, ClassifierVerdictType, buildReviewEmbed, buildUnsafeAlert, EmailFolder  } from '@/integrations/email';
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
function makeVerdict(overrides: Partial<ClassifierVerdict> = {}): ClassifierVerdict {
    return {
        verdict:    ClassifierVerdictType.Uncertain,
        confidence: 0.5,
        reason:     'test reason',
        ...overrides,
    };
}

/** Build a mock DynamoDB document client whose send() always returns {} (empty item). */
function makeMockDocClient(): DynamoDBDocumentClient {
    return { send: mock(async () => ({})) } as unknown as DynamoDBDocumentClient;
}

/** No-op sleep for instant retry in tests. */
async function noopSleep(_ms: number): Promise<void> {
    // no-op: eliminates retryAsync backoff delays in tests
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

describe('setupEmail — isSendableChannel type guard', () => {
    let options: EmailSetupOptions;

    beforeEach(async () => {
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
        expect(
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
        expect(
            result.sendApprovalRequest('to@example.com', 'Test Subject', 123)
        ).rejects.toBeInstanceOf(ChannelNotAccessibleError);
    });

    it('sends message when channel.fetch returns a sendable channel (object with send method)', async () => {
        const mockSend = mock(async () => undefined);
        options.client = {
            channels: {
                fetch: mock(async () => ({ send: mockSend })),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        await result.sendApprovalRequest('to@example.com', 'Test Subject', 123);

        expect(mockSend).toHaveBeenCalledTimes(1);
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
});
