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

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Client, TextChannel } from 'discord.js';
import { InvariantViolationError } from '@/errors';
import { WellKnownChannelNotFoundError } from '@/errors/discord';
import type { DiscordCapability } from '@/integrations/discord/capability';
import type { ResponseRouter } from '@/integrations/discord/channel-registry/response-router';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { sendEnvelopeResponse } from '@/integrations/discord/response-sender';
import type { ChannelId } from '@/integrations/discord/types';

describe('sendEnvelopeResponse', () => {
    let mockResponseRouter: ResponseRouter;
    let mockResolveEnvelopeTarget: ReturnType<typeof mock>;
    let mockRateLimiter: DiscordRateLimiter;
    let mockSendToChannel: ReturnType<typeof mock>;
    let mockReplyToMessage: ReturnType<typeof mock>;
    let mockClient: Client;
    let mockTargetChannel: TextChannel;

    beforeEach(() => {
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
        expect(result).toEqual({ sent: true });
    });

    test('splits long content into multiple chunks, sent in order', async () => {
        const longContent = 'x'.repeat(2500);
        mockResolveEnvelopeTarget.mockResolvedValue({
            targetChannelId: 'target-channel-456' as ChannelId,
            shouldSend:      true,
            content:         longContent,
        });

        const result = await sendEnvelopeResponse({
            envelopeId:     'env-2',
            kind:           'discord',
            channelId:      'origin-channel-123' as ChannelId,
            text:           longContent,
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        });

        expect(result).toEqual({ sent: true });
        expect(mockSendToChannel).toHaveBeenCalledTimes(2);
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
        await expect(sendEnvelopeResponse({
            envelopeId:     'env-4',
            kind:           'discord',
            text:           'reply text',
            responseRouter: mockResponseRouter,
            client:         mockClient,
            rateLimiter:    mockRateLimiter,
        })).rejects.toThrow(InvariantViolationError);

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

        expect(result.sent).toBe(false);
        expect(result.skipReason).toContain('catch-up');
        expect(mockSendToChannel).not.toHaveBeenCalled();
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

        expect(result.sent).toBe(false);
        expect(result.skipReason).toContain('perch-time');
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

        expect(result).toEqual({ sent: false, skipReason: 'no-response' });
        expect(mockClient.channels.fetch).not.toHaveBeenCalled();
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

        expect(result).toEqual({ sent: false });
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

        expect(result).toEqual({ sent: false });
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

        expect(result).toEqual({ sent: false, queued: true });
        expect(mockSendToChannelCapability).toHaveBeenCalledWith('target-channel-456', 'Digest text', { priority: 'high', type: 'catch_up_output' });
        expect(mockClient.channels.fetch).not.toHaveBeenCalled();
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

        expect(result).toEqual({ sent: true });
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

        expect(result).toEqual({ sent: false, queued: true });
        expect(mockSendToChannelCapability).toHaveBeenCalledWith('perch-channel-1', 'Perch report', { priority: 'high', type: 'perch_output' });
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
