/**
 * Tests for Discord Response Sender's envelope-based send path.
 *
 * Verifies that:
 * - Response routing is delegated to responseRouter.resolveEnvelopeTarget
 * - WellKnownChannelNotFoundError resolves to a skip, never a throw
 * - Messages are split correctly for Discord's 2000-char limit
 * - Messages are sent to the resolved target channel, never threaded as a reply
 * - Errors during send are handled gracefully
 * - @@NO_RESPONSE@@ sentinel is respected
 * - A DiscordCapability facade routes chunks through the outbox with the right item type
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Client, TextChannel } from 'discord.js';
import { mockLogger } from '../../../setup';
import { InvariantViolationError } from '@/errors';
import { WellKnownChannelNotFoundError } from '@/errors/discord';
import { DiscordCapabilityImpl, type DiscordCapability } from '@/integrations/discord/capability';
import { ResponseRouter } from '@/integrations/discord/channel-registry/response-router';
import { DISCORD_MAX_LENGTH } from '@/integrations/discord/messages';
import { DELIVERY_TOKEN_MAX_LENGTH } from '@/integrations/discord/outbox-replay';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { queuedOutboxIdsFromPartialResponse, sendEnvelopeResponse, type SendEnvelopeResponseResult } from '@/integrations/discord/response-sender';
import type { ChannelId } from '@/integrations/discord/types';
import { decodeDeliveryCode, maxContentLengthForDeliveryCode } from '@/integrations/discord/zero-width-delivery-code';
import type { OutboxBackend } from '@/services';

describe('sendEnvelopeResponse', () => {
    let mockResponseRouter: ResponseRouter;
    let mockResolveEnvelopeTarget: ReturnType<typeof mock>;
    let mockRateLimiter: DiscordRateLimiter;
    let mockSendToChannel: ReturnType<typeof mock>;
    let mockReplyToMessage: ReturnType<typeof mock>;
    let mockClient: Client;
    let mockTargetChannel: TextChannel;

    beforeEach(() => {
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
        mockResolveEnvelopeTarget = mock();
        mockResponseRouter = {
            resolveEnvelopeTarget: mockResolveEnvelopeTarget,
        } as unknown as ResponseRouter;

        mockReplyToMessage = mock(async () => ({ id: 'reply-123' }));
        mockSendToChannel = mock(async () => ({ id: 'msg-123' }));
        mockRateLimiter = {
            replyToMessage: mockReplyToMessage,
            sendToChannel:  mockSendToChannel,
        } as unknown as DiscordRateLimiter;

        mockTargetChannel = {
            id:          'target-channel-456',
            isTextBased: () => true,
        } as unknown as TextChannel;

        mockClient = {
            channels: {
                fetch: mock(async () => mockTargetChannel),
            },
        } as unknown as Client;
    });

    // `mockLogger` is the suite-wide preload singleton shared by every test file, and
    // `bunfig.toml` randomizes file order. The missing-well-known-channel tests below
    // drive `logger.error`; leaving those calls recorded lets them surface in whichever
    // file happens to run next (seen as an order-dependent failure of perch-setup's
    // `not.toHaveBeenCalled()` sentinel test under `--seed 1072740724`).
    afterEach(() => {
        mockLogger.info.mockClear();
        mockLogger.warn.mockClear();
        mockLogger.error.mockClear();
    });

    test('a mapped kind with an origin sends to its start channel without well-known lookup', async () => {
        const getWellKnownChannel = mock(async () => null);
        const responseRouter = new ResponseRouter({ manager: { getWellKnownChannel } as never });
        const result = await sendEnvelopeResponse({
            envelopeId:  'origin-catchup',
            kind:        'catchup',
            channelId:   'target-channel-456' as ChannelId,
            text:        'Reply to the start channel',
            responseRouter,
            client:      mockClient,
            rateLimiter: mockRateLimiter,
        });
        expect(result).toEqual({ status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['msg-123'] });
        expect(getWellKnownChannel).not.toHaveBeenCalled();
        expect(mockSendToChannel).toHaveBeenCalledTimes(1);
    });

    test('sends chunks to the resolved channel', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-1',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(mockResolveEnvelopeTarget).toHaveBeenCalledWith('catchup', 'Digest text', undefined);
        expect(mockClient.channels.fetch).toHaveBeenCalledWith('target-channel-456');
        expect(mockSendToChannel).toHaveBeenCalledWith(mockTargetChannel, 'Digest text');
        expect(result).toEqual({ status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['msg-123'] });
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith({
            envelopeId:  'env-1', kind:        'catchup', chunkIndex:  0, totalChunks: 1,
            msg:         'Envelope response chunk sent successfully',
        });
    });

    test('returns message IDs from a multi-chunk client send in send order', async () => {
        const longContent = 'x'.repeat(2500);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         longContent,
        });
        mockSendToChannel
            .mockResolvedValueOnce({ id: 'message-1' })
            .mockResolvedValueOnce({ id: 'message-2' });

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-2',
            kind:           'discord',
            channelId:      'origin-channel-123' as ChannelId,
            text:           longContent,
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(mockClient.channels.fetch).toHaveBeenCalledWith('target-channel-456');
        expect(mockSendToChannel).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['message-1', 'message-2'] });
    });

    test('sends the response router content rather than the source text', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Sanitized response',
        });

        await sendEnvelopeResponse({
            envelopeId:     'env-routed-content',
            kind:           'catchup',
            text:           'Source response',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(mockSendToChannel).toHaveBeenCalledWith(mockTargetChannel, 'Sanitized response');
    });

    test('passes channelId through to resolveEnvelopeTarget as the originChannelId', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'origin-channel-123' as ChannelId,
            shouldSend:      true,
            content:         'reply text',
        });

        await sendEnvelopeResponse({
            envelopeId:     'env-3',
            kind:           'discord',
            channelId:      'origin-channel-123' as ChannelId,
            text:           'reply text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(mockResolveEnvelopeTarget).toHaveBeenCalledWith('discord', 'reply text', 'origin-channel-123');
    });

    test('throws InvariantViolationError for a discord kind with no channelId, without resolving', async () => {
        const error = await sendEnvelopeResponse({
            envelopeId:     'env-4',
            kind:           'discord',
            text:           'reply text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        }).catch(error_ => error_);

        expect(error).toBeInstanceOf(InvariantViolationError);
        expect((error as InvariantViolationError).context).toEqual({
            location: 'sendEnvelopeResponse', invariant: 'channelId is required for envelope kind: discord',
        });
        expect(mockResolveEnvelopeTarget).not.toHaveBeenCalled();
    });

    test('throws InvariantViolationError for a notification kind with no channelId', async () => {
        await expect(sendEnvelopeResponse({
            envelopeId:     'env-4b',
            kind:           'notification',
            text:           'notice text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        })).rejects.toThrow(InvariantViolationError);
    });

    test('a missing well-known channel for a catchup kind resolves to sent:false with a skipReason, no throw', async () => {
        mockResolveEnvelopeTarget.mockRejectedValue(new WellKnownChannelNotFoundError('catch-up'));

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-5',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('catch-up') });
        expect(mockSendToChannel).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId:  'env-5', kind:        'catchup', channelType: 'catch-up',
            msg:         'Cannot route envelope response: well-known channel #catch-up not configured. Response skipped.',
        }));
    });

    test('a missing well-known channel for a perch kind resolves to sent:false with a skipReason', async () => {
        mockResolveEnvelopeTarget.mockRejectedValue(new WellKnownChannelNotFoundError('perch-time'));

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-6',
            kind:           'perch',
            text:           'Perch report',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'skipped', reason: expect.stringContaining('perch-time') });
    });

    test('the @@NO_RESPONSE@@ sentinel resolves to sent:false skipReason no-response', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      false,
            content:         '',
        });

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-7',
            kind:           'catchup',
            text:           'Nothing new. @@NO_RESPONSE@@',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'skipped', reason: 'no-response' });
        expect(mockClient.channels.fetch).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledWith({
            envelopeId:   'env-7', kind:         'catchup', fullResponse: 'Nothing new. @@NO_RESPONSE@@',
            msg:          'Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)',
        });
    });

    test('an unreachable target channel with no discordCapability resolves to a genuine sent:false, not a fabricated queue', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });
        (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(null);

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-8',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'unavailable' });
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(expect.objectContaining({
            envelopeId: 'env-8', kind:       'catchup',
            msg:        expect.stringContaining('Envelope response send failed, no outbox to queue to:'),
        }));
    });

    test('a send failure after retries with no discordCapability resolves to a genuine sent:false, not a fabricated queue', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });
        mockSendToChannel.mockRejectedValue(new Error('network down'));

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-9',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'unavailable' });
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    test('a non-Error send rejection preserves its message in the warning', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });
        mockSendToChannel.mockRejectedValue('network down');

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-non-error',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ status: 'unavailable' });
        expect(mockLogger.warn).toHaveBeenCalledWith({
            error:      new Error('network down'),
            envelopeId: 'env-non-error',
            kind:       'catchup',
            msg:        'Envelope response send failed, no outbox to queue to: network down',
        });
    });

    test('with a discordCapability, a chunk queued to the outbox resolves to sent:false queued:true and never touches the raw client', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });
        const mockSendToChannelCapability = mock(async () => ({ status: 'queued' as const, outboxId: 'outbox-1' }));
        const mockDiscordCapability = {
            sendToChannel: mockSendToChannelCapability,
        } as unknown as DiscordCapability;

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-11',
            kind:              'catchup',
            text:              'Digest text',
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: mockDiscordCapability,
        });

        expect(result).toEqual({ status: 'queued', channelId: 'target-channel-456' as ChannelId, outboxIds: ['outbox-1'] });
        expect(mockSendToChannelCapability).toHaveBeenCalledWith('target-channel-456', 'Digest text', { priority: 'high', type: 'catch_up_output' });
        expect(mockClient.channels.fetch).not.toHaveBeenCalled();
        expect(mockLogger.info).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith({
            envelopeId:  'env-11', kind:        'catchup', chunkIndex:  0, totalChunks: 1,
            msg:         'Envelope response chunk sent via capability facade',
        });
    });

    test('with a real discordCapability, splits against the delivery-code budget before appending one complete code', async () => {
        const largestDeliveryToken = '0'.repeat(DELIVERY_TOKEN_MAX_LENGTH);
        const content = 'a'.repeat(maxContentLengthForDeliveryCode(largestDeliveryToken, DISCORD_MAX_LENGTH));
        const channel = {
            send: mock(async () => ({ id: 'message-with-code' })),
        } as unknown as TextChannel;
        const capabilityClient = {
            channels: { fetch: mock(async () => channel) },
        } as unknown as Client;
        const capability = new DiscordCapabilityImpl({
            registry:      { isAvailable: mock(() => true) } as never,
            logger:        { warn: mock(), error: mock(), info: mock() },
            outboxBackend: { enqueue: mock(async () => undefined) } as unknown as OutboxBackend,
        });
        capability.setClient(capabilityClient);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content,
        });

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-delivery-code-boundary',
            kind:              'catchup',
            text:              content,
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: capability,
        });

        expect(result).toEqual({ status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['message-with-code'] });
        expect(channel.send).toHaveBeenCalledTimes(1);
        const payload = (channel.send as ReturnType<typeof mock>).mock.calls[0]?.[0] as { content: string, nonce: string };
        expect(payload.content.slice(0, content.length)).toBe(content);
        expect(payload.content.length).toBeLessThanOrEqual(DISCORD_MAX_LENGTH);
        expect(decodeDeliveryCode(payload.content)).toBe(payload.nonce);
    });

    test('with a discordCapability, a discord-kind envelope queues under the agent_response outbox type', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'origin-channel-123' as ChannelId,
            shouldSend:      true,
            content:         'reply text',
        });
        const mockSendToChannelCapability = mock(async () => ({ status: 'sent' as const }));
        const mockDiscordCapability = {
            sendToChannel: mockSendToChannelCapability,
        } as unknown as DiscordCapability;

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-12',
            kind:              'discord',
            channelId:         'origin-channel-123' as ChannelId,
            text:              'reply text',
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: mockDiscordCapability,
        });

        expect(result).toEqual({ status: 'sent', channelId: 'origin-channel-123' as ChannelId, messageIds: [] });
        expect(mockSendToChannelCapability).toHaveBeenCalledWith('origin-channel-123', 'reply text', { priority: 'high', type: 'agent_response' });
    });

    test('with a discordCapability, an "unavailable" status also reports sent:false queued:true (no outbox configured)', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'perch-channel-1' as ChannelId,
            shouldSend:      true,
            content:         'Perch report',
        });
        const mockSendToChannelCapability = mock(async () => ({ status: 'unavailable' as const }));
        const mockDiscordCapability = {
            sendToChannel: mockSendToChannelCapability,
        } as unknown as DiscordCapability;

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-13',
            kind:              'perch',
            text:              'Perch report',
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: mockDiscordCapability,
        });

        expect(result).toEqual({ status: 'unavailable' });
        expect(mockSendToChannelCapability).toHaveBeenCalledWith('perch-channel-1', 'Perch report', { priority: 'high', type: 'perch_output' });
    });

    test('with a discordCapability, multiple chunks are sent in original order, not reversed', async () => {
        // Kills llm mutant: chunks.entries() -> chunks.reverse().entries()
        // Build content that splits into exactly two chunks, distinguishable by content, so a
        // reversed send order is observable via the call order on the capability mock.
        const firstChunkWord  = 'A'.repeat(1200);
        const secondChunkWord = 'B'.repeat(1200);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         `${firstChunkWord} ${secondChunkWord}`,
        });
        const mockSendToChannelCapability = mock(async () => ({ status: 'sent' as const }));
        const mockDiscordCapability = {
            sendToChannel: mockSendToChannelCapability,
        } as unknown as DiscordCapability;

        await sendEnvelopeResponse({
            envelopeId:        'env-order',
            kind:              'catchup',
            text:              `${firstChunkWord} ${secondChunkWord}`,
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: mockDiscordCapability,
        });

        expect(mockSendToChannelCapability).toHaveBeenCalledTimes(2);
        expect((mockSendToChannelCapability.mock.calls[0] as unknown[])[1]).toBe(firstChunkWord);
        expect((mockSendToChannelCapability.mock.calls[1] as unknown[])[1]).toBe(secondChunkWord);
    });

    test.each([
        ['all sent', [{ status: 'sent', message: { id: 'message-1' } }, { status: 'sent', message: { id: 'message-2' } }], { status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['message-1', 'message-2'] }],
        ['all queued', [{ status: 'queued', outboxId: 'outbox-1' }, { status: 'queued', outboxId: 'outbox-2' }], { status: 'queued', channelId: 'target-channel-456' as ChannelId, outboxIds: ['outbox-1', 'outbox-2'] }],
        ['mixed sent and queued', [{ status: 'sent', message: { id: 'message-1' } }, { status: 'queued', outboxId: 'outbox-2' }], { status: 'partial', channelId: 'target-channel-456' as ChannelId, chunks: [{ status: 'sent', message: { id: 'message-1' } }, { status: 'queued', outboxId: 'outbox-2' }] }],
        ['an unavailable chunk', [{ status: 'sent', message: { id: 'message-1' } }, { status: 'unavailable' }], { status: 'unavailable' }],
    ])('with a discordCapability, multi-chunk %s outcomes use the documented aggregate precedence', async (_description, statuses, expected) => {
        const firstChunk = 'A'.repeat(1200);
        const secondChunk = 'B'.repeat(1200);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         `${firstChunk} ${secondChunk}`,
        });
        const mockSendToChannelCapability = mock(async () => statuses.shift());
        const mockDiscordCapability = { sendToChannel: mockSendToChannelCapability } as unknown as DiscordCapability;

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-aggregation',
            kind:              'catchup',
            text:              `${firstChunk} ${secondChunk}`,
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: mockDiscordCapability,
        });

        expect(result).toEqual(expected as SendEnvelopeResponseResult);
        expect(mockSendToChannelCapability).toHaveBeenCalledTimes(2);
    });

    test('returns message IDs from a multi-chunk capability send in send order', async () => {
        const firstChunk = 'A'.repeat(1200);
        const secondChunk = 'B'.repeat(1200);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         `${firstChunk} ${secondChunk}`,
        });
        const mockSendToChannelCapability = mock()
            .mockResolvedValueOnce({ status: 'sent' as const, message: { id: 'message-1' } })
            .mockResolvedValueOnce({ status: 'sent' as const, message: { id: 'message-2' } });

        const result = await sendEnvelopeResponse({
            envelopeId:        'env-message-id-order',
            kind:              'catchup',
            text:              `${firstChunk} ${secondChunk}`,
            responseRouter:    mockResponseRouter,
            client:            mockClient,
            rateLimiter:       mockRateLimiter,
            discordCapability: { sendToChannel: mockSendToChannelCapability } as unknown as DiscordCapability,
        });

        expect(result).toEqual({ status: 'sent', channelId: 'target-channel-456' as ChannelId, messageIds: ['message-1', 'message-2'] });
    });

    test('extracts only queued outbox IDs from a partial response, in chunk order', () => {
        expect(queuedOutboxIdsFromPartialResponse({
            status:    'partial',
            channelId: 'target-channel-456' as ChannelId,
            chunks:    [
                { status: 'sent' },
                { status: 'queued', outboxId: 'outbox-2' },
                { status: 'sent' },
                { status: 'queued', outboxId: 'outbox-4' },
            ],
        })).toEqual(['outbox-2', 'outbox-4']);
    });

    test('does not thread replies: always sends to the target channel directly, never message.reply', async () => {
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         'Digest text',
        });

        await sendEnvelopeResponse({
            envelopeId:     'env-10',
            kind:           'catchup',
            text:           'Digest text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(mockReplyToMessage).not.toHaveBeenCalled();
    });
});
