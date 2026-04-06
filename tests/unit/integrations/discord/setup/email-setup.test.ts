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
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupEmail, type EmailSetupOptions } from '@/integrations/discord/setup/email-setup';
import type { WildDuckClient } from '@/integrations/email';
import type { ApprovalSagaBackend } from '@/services';
import type { PersonAllowlist } from '@/storage';

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
            _deps: { sleep: noopSleep },
        };
    });

    it('throws "not a sendable text channel" when channel.fetch returns a non-object (string)', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => 'not-a-channel'),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        // Call sendApprovalRequest — isSendableChannel('not-a-channel') → false → throws
        expect(
            result.sendApprovalRequest('to@example.com', 'Test Subject', 123)
        ).rejects.toThrow('not a sendable text channel');
    });

    it('throws "not a sendable text channel" when channel.fetch returns null', async () => {
        options.client = {
            channels: {
                fetch: mock(async () => null),
            },
        } as unknown as Client;

        const result = await setupEmail(options);

        // null: isSendableChannel → false → throws
        expect(
            result.sendApprovalRequest('to@example.com', 'Test Subject', 123)
        ).rejects.toThrow('not a sendable text channel');
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
