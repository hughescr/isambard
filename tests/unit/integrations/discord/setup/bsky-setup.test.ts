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
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Client } from 'discord.js';
import { ChannelNotAccessibleError } from '@/errors';
import type { BlueskyClient } from '@/integrations/bsky';
import type { AllowlistInteractionHandler } from '@/integrations/discord/allowlist-interaction-handler';
import { setupBsky, type BskySetupOptions } from '@/integrations/discord/setup/bsky-setup';
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
            _deps: { sleep: noopSleep },
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
