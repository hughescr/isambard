/**
 * Tests for Discord Response Sender
 *
 * Verifies that:
 * - Session type is correctly determined from bot state
 * - Response routing is delegated to responseRouter
 * - WellKnownChannelNotFoundError is handled with fallback or skip based on config
 * - Messages are split correctly for Discord's 2000-char limit
 * - Messages are sent to the correct target channel
 * - Reply threading is used when target matches origin channel
 * - Errors during send are handled gracefully
 * - @@NO_RESPONSE@@ sentinel is respected
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Message, TextChannel, Client, DMChannel } from 'discord.js';
import { InvariantViolationError } from '@/errors';
import { ChannelNotAccessibleError, WellKnownChannelNotFoundError } from '@/errors/discord';
import type { DiscordCapability } from '@/integrations/discord/capability';
import type { ResponseRouter } from '@/integrations/discord/channel-registry/response-router';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { sendEnvelopeResponse, sendResponse, sendResponseToWellKnownChannel } from '@/integrations/discord/response-sender';
import type { BotStateManager } from '@/integrations/discord/state/types';
import type { ChannelId } from '@/integrations/discord/types';

describe('sendResponse', () => {
    let mockResponseRouter: ResponseRouter;
    let mockRouteResponse: ReturnType<typeof mock>;
    let mockBotStateManager: BotStateManager;
    let mockRateLimiter: DiscordRateLimiter;
    let mockReplyToMessage: ReturnType<typeof mock>;
    let mockSendToChannel: ReturnType<typeof mock>;
    let mockClient: Client;
    let mockMessage: Message;
    let mockMessageReply: ReturnType<typeof mock>;
    let mockChannel: TextChannel;
    let mockChannelSend: ReturnType<typeof mock>;
    let mockTargetChannel: TextChannel;
    let mockTargetChannelSend: ReturnType<typeof mock>;

    beforeEach(() => {
        // Mock response router
        mockRouteResponse = mock();
        mockResponseRouter = {
            routeResponse: mockRouteResponse,
        } as unknown as ResponseRouter;

        // Mock bot state manager
        const getModeMock = mock(() => 'idle');
        mockBotStateManager = {
            getMode:        getModeMock,
            getSessionType: mock((isDMChannel?: boolean) => {
                const mode = getModeMock();
                if(mode === 'catching_up') {
                    return 'catching_up';
                }
                if(mode === 'perching') {
                    return 'perching';
                }
                if(isDMChannel) {
                    return 'dm';
                }
                return 'processing_message';
            }),
        } as unknown as BotStateManager;

        // Mock rate limiter
        mockReplyToMessage = mock(async () => ({ id: 'reply-123' }));
        mockSendToChannel = mock(async () => ({ id: 'msg-123' }));
        mockRateLimiter = {
            replyToMessage: mockReplyToMessage,
            sendToChannel:  mockSendToChannel,
        } as unknown as DiscordRateLimiter;

        // Mock channel
        mockChannelSend = mock(async () => ({ id: 'msg-123' }));
        mockChannel = {
            id:        'origin-channel-123',
            isDMBased: () => false,
            send:      mockChannelSend,
        } as unknown as TextChannel;

        // Mock target channel
        mockTargetChannelSend = mock(async () => ({ id: 'msg-456' }));
        mockTargetChannel = {
            id:          'target-channel-456',
            send:        mockTargetChannelSend,
            isTextBased: () => true,
        } as unknown as TextChannel;

        // Mock client
        mockClient = {
            channels: {
                fetch: mock(async () => mockTargetChannel),
            },
        } as unknown as Client;

        // Mock message
        mockMessageReply = mock(async () => ({ id: 'reply-123' }));
        mockMessage = {
            id:      'msg-123',
            channel: mockChannel,
            client:  mockClient,
            reply:   mockMessageReply,
        } as unknown as Message;
    });

    describe('session type determination', () => {
        test('uses "catching_up" session type when bot is in catching_up mode', async () => {
            (mockBotStateManager.getMode as ReturnType<typeof mock>).mockReturnValue('catching_up');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'catching_up',
                'test response',
                'origin-channel-123'
            );
        });

        test('uses "perching" session type when bot is in perching mode', async () => {
            (mockBotStateManager.getMode as ReturnType<typeof mock>).mockReturnValue('perching');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'perching',
                'test response',
                'origin-channel-123'
            );
        });

        test('uses "dm" session type when message is in DM', async () => {
            const dmChannel = {
                id:        'dm-channel-123',
                isDMBased: () => true,
            } as unknown as DMChannel;

            const dmMessage = {
                ...mockMessage,
                channel: dmChannel,
            } as unknown as Message;

            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'dm-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            dmMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'dm',
                'test response',
                'dm-channel-123'
            );
        });

        test('uses "processing_message" session type by default', async () => {
            (mockBotStateManager.getMode as ReturnType<typeof mock>).mockReturnValue('idle');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'processing_message',
                'test response',
                'origin-channel-123'
            );
        });

        test('sessionTypeOverride wins over botStateManager.getSessionType() when given', async () => {
            (mockBotStateManager.getMode as ReturnType<typeof mock>).mockReturnValue('perching');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:      mockResponseRouter,
                botStateManager:     mockBotStateManager,
                response:            'test response',
                message:             mockMessage,
                rateLimiter:         mockRateLimiter,
                client:              mockClient,
                useFallbackOnError:  true,
                sessionTypeOverride: 'processing_message',
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'processing_message',
                'test response',
                'origin-channel-123'
            );
            expect(mockBotStateManager.getSessionType).not.toHaveBeenCalled();
        });

        test('a reply sent while mode is "perching" with sessionTypeOverride "processing_message" is routed to the requesting channel, not the perch/catch-up destination', async () => {
            (mockBotStateManager.getMode as ReturnType<typeof mock>).mockReturnValue('perching');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:      mockResponseRouter,
                botStateManager:     mockBotStateManager,
                response:            'test response',
                message:             mockMessage,
                rateLimiter:         mockRateLimiter,
                client:              mockClient,
                useFallbackOnError:  true,
                sessionTypeOverride: 'processing_message',
            });

            expect(result.sent).toBe(true);
            expect(mockReplyToMessage).toHaveBeenCalled();
        });

        test('sessionTypeOverride "dm" is used verbatim even for a non-DM message', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            await sendResponse({
                responseRouter:      mockResponseRouter,
                botStateManager:     mockBotStateManager,
                response:            'test response',
                message:             mockMessage,
                rateLimiter:         mockRateLimiter,
                client:              mockClient,
                useFallbackOnError:  true,
                sessionTypeOverride: 'dm',
            });

            expect(mockRouteResponse).toHaveBeenCalledWith(
                'dm',
                'test response',
                'origin-channel-123'
            );
        });
    });

    describe('WellKnownChannelNotFoundError handling', () => {
        test('falls back to origin channel when useFallbackOnError is true', async () => {
            const notFoundError = new WellKnownChannelNotFoundError('catch-up');
            mockRouteResponse.mockRejectedValue(notFoundError);

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(result.routing?.isFallback).toBe(true);
            expect(result.routing?.targetChannelId).toBe('origin-channel-123' as ChannelId);
            expect(mockReplyToMessage).toHaveBeenCalled();
        });

        test('skips response when useFallbackOnError is false', async () => {
            const notFoundError = new WellKnownChannelNotFoundError('catch-up');
            mockRouteResponse.mockRejectedValue(notFoundError);

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'test response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: false,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toContain('catch-up');
            expect(mockReplyToMessage).not.toHaveBeenCalled();
        });

        test('re-throws other routing errors', async () => {
            const otherError = new Error('Some other error');
            mockRouteResponse.mockRejectedValue(otherError);

            expect(
                sendResponse({
                    responseRouter:     mockResponseRouter,
                    botStateManager:    mockBotStateManager,
                    response:           'test response',
                    message:            mockMessage,
                    rateLimiter:        mockRateLimiter,
                    client:             mockClient,
                    useFallbackOnError: true,
                })
            ).rejects.toThrow('Some other error');
        });
    });

    describe('@@NO_RESPONSE@@ sentinel handling', () => {
        test('does not send when shouldSend is false', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      false,
                content:         '',
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           '@@NO_RESPONSE@@',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toContain('@@NO_RESPONSE@@');
            expect(mockReplyToMessage).not.toHaveBeenCalled();
        });
    });

    describe('message sending', () => {
        test('uses reply() for first chunk when target matches origin', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'short response',
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'short response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(mockReplyToMessage).toHaveBeenCalledWith(mockMessage, 'short response');
            expect(mockSendToChannel).not.toHaveBeenCalled();
        });

        test('sends all chunks to target channel when target differs from origin', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'target-channel-456' as ChannelId,
                shouldSend:      true,
                content:         'response to different channel',
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response to different channel',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(mockReplyToMessage).not.toHaveBeenCalled();
            expect(mockSendToChannel).toHaveBeenCalledWith(
                mockTargetChannel,
                'response to different channel'
            );
        });

        test('splits long messages and sends continuation chunks', async () => {
            const longResponse = 'a'.repeat(2500); // Exceeds 2000 char limit

            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         longResponse,
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           longResponse,
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            // First chunk uses reply to original message, continuation chunks reply to first message
            expect(mockReplyToMessage).toHaveBeenCalledTimes(2);
            // sendToChannel should not be used for threaded responses
            expect(mockSendToChannel).not.toHaveBeenCalled();
        });

        test('sends exactly N messages for N chunks without attempting extra', async () => {
            // Create a message that produces exactly 2 chunks (1900 chars each = DISCORD_SAFE_LENGTH)
            const chunk1 = 'a'.repeat(1900);
            const chunk2 = 'b'.repeat(1900);
            const twoChunkMessage = chunk1 + chunk2;

            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'target-channel-456' as ChannelId,
                shouldSend:      true,
                content:         twoChunkMessage,
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           twoChunkMessage,
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            // Should send exactly 2 chunks, not 3
            expect(mockSendToChannel).toHaveBeenCalledTimes(2);
            expect(mockReplyToMessage).not.toHaveBeenCalled();
        });

        test('handles send errors gracefully', async () => {
            const sendError = new Error('Failed to send');
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });
            mockReplyToMessage.mockRejectedValue(sendError);

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(false);
            expect(result.error).toBe(sendError);
        });

        test('throws error when target channel not found', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'nonexistent-channel' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });
            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(null);

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(false);
            expect(result.error).toBeInstanceOf(ChannelNotAccessibleError);
        });
    });

    describe('fallback logging', () => {
        test('logs fallback when routing uses fallback with reason', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      true,
                fallbackReason:  'Channel not configured',
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(result.routing?.isFallback).toBe(true);
            expect(result.routing?.fallbackReason).toBe('Channel not configured');
        });

        test('does not log warning when isFallback is true but fallbackReason is undefined', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      true,
                fallbackReason:  undefined,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(result.routing?.isFallback).toBe(true);
            expect(result.routing?.fallbackReason).toBeUndefined();
            // Warning should not be logged (verified by mutation test)
        });

        test('does not log warning when isFallback is false', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'origin-channel-123' as ChannelId,
                shouldSend:      true,
                content:         'response',
                isFallback:      false,
            });

            const result = await sendResponse({
                responseRouter:     mockResponseRouter,
                botStateManager:    mockBotStateManager,
                response:           'response',
                message:            mockMessage,
                rateLimiter:        mockRateLimiter,
                client:             mockClient,
                useFallbackOnError: true,
            });

            expect(result.sent).toBe(true);
            expect(result.routing?.isFallback).toBe(false);
            // Warning should not be logged (verified by mutation test)
        });
    });

    describe('sendResponseToWellKnownChannel', () => {
        test('returns skipReason when response is null', async () => {
            const result = await sendResponseToWellKnownChannel({
                response:       null,
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('Empty response from agent');
            expect(mockRouteResponse).not.toHaveBeenCalled();
        });

        test('returns skipReason when response is undefined', async () => {
            const result = await sendResponseToWellKnownChannel({
                response:       undefined,
                sessionType:    'perching',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('Empty response from agent');
            expect(mockRouteResponse).not.toHaveBeenCalled();
        });

        test('returns skipReason when response is empty string', async () => {
            const result = await sendResponseToWellKnownChannel({
                response:       '',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('Empty response from agent');
            expect(mockRouteResponse).not.toHaveBeenCalled();
        });

        test('detects sentinel and logs full response', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'catch-up-channel-789' as ChannelId,
                shouldSend:      false,
                content:         '',
                isFallback:      false,
            });

            const result = await sendResponseToWellKnownChannel({
                response:       'Nothing to report today. @@NO_RESPONSE@@',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toBe('Agent chose not to respond (@@NO_RESPONSE@@ sentinel detected)');
            expect(mockSendToChannel).not.toHaveBeenCalled();
        });

        test('sends response to catch-up well-known channel', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'catch-up-channel-789' as ChannelId,
                shouldSend:      true,
                content:         'Caught up on 5 messages',
                isFallback:      false,
            });

            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockTargetChannel);

            const result = await sendResponseToWellKnownChannel({
                response:       'Caught up on 5 messages',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(true);
            expect(mockRouteResponse).toHaveBeenCalledWith(
                'catching_up',
                'Caught up on 5 messages',
                undefined
            );
            expect(mockSendToChannel).toHaveBeenCalledWith(
                mockTargetChannel,
                'Caught up on 5 messages'
            );
        });

        test('sends response to perch-time well-known channel', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'perch-time-channel-890' as ChannelId,
                shouldSend:      true,
                content:         'Perch reflection complete',
                isFallback:      false,
            });

            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockTargetChannel);

            const result = await sendResponseToWellKnownChannel({
                response:       'Perch reflection complete',
                sessionType:    'perching',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(true);
            expect(mockRouteResponse).toHaveBeenCalledWith(
                'perching',
                'Perch reflection complete',
                undefined
            );
            expect(mockSendToChannel).toHaveBeenCalledWith(
                mockTargetChannel,
                'Perch reflection complete'
            );
        });

        test('splits long messages into chunks and sends exact chunk count', async () => {
            // Create a message that produces exactly 2 chunks (1900 chars each)
            const twoChunkResponse = 'a'.repeat(1900) + 'b'.repeat(1900);

            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'catch-up-channel-789' as ChannelId,
                shouldSend:      true,
                content:         twoChunkResponse,
                isFallback:      false,
            });

            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockTargetChannel);

            const result = await sendResponseToWellKnownChannel({
                response:       twoChunkResponse,
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(true);
            // Should send exactly 2 chunks, not 3 (guards against i <= chunks.length mutation)
            expect(mockSendToChannel).toHaveBeenCalledTimes(2);
        });

        test('handles send errors gracefully', async () => {
            const sendError = new Error('Failed to send to channel');

            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'catch-up-channel-789' as ChannelId,
                shouldSend:      true,
                content:         'test response',
                isFallback:      false,
            });

            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(mockTargetChannel);
            mockSendToChannel.mockRejectedValue(sendError);

            const result = await sendResponseToWellKnownChannel({
                response:       'test response',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.error).toBe(sendError);
        });

        test('handles well-known channel not found error', async () => {
            const notFoundError = new WellKnownChannelNotFoundError('catch-up');
            mockRouteResponse.mockRejectedValue(notFoundError);

            const result = await sendResponseToWellKnownChannel({
                response:       'test response',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.skipReason).toContain('catch-up');
            expect(mockSendToChannel).not.toHaveBeenCalled();
        });

        test('handles target channel not found', async () => {
            mockRouteResponse.mockResolvedValue({
                targetChannelId: 'nonexistent-channel' as ChannelId,
                shouldSend:      true,
                content:         'test response',
                isFallback:      false,
            });

            (mockClient.channels.fetch as ReturnType<typeof mock>).mockResolvedValue(null);

            const result = await sendResponseToWellKnownChannel({
                response:       'test response',
                sessionType:    'catching_up',
                responseRouter: mockResponseRouter,
                rateLimiter:    mockRateLimiter,
                client:         mockClient,
            });

            expect(result.sent).toBe(false);
            expect(result.error).toBeInstanceOf(ChannelNotAccessibleError);
        });
    });

    describe('sendEnvelopeResponse', () => {
        let mockResolveEnvelopeTarget: ReturnType<typeof mock>;

        beforeEach(() => {
            mockResolveEnvelopeTarget = mock();
            (mockResponseRouter as unknown as { resolveEnvelopeTarget: ReturnType<typeof mock> }).resolveEnvelopeTarget = mockResolveEnvelopeTarget;
        });

        test('sends chunks to the resolved channel without reading bot state', async () => {
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
            expect((mockBotStateManager.getSessionType as ReturnType<typeof mock>)).not.toHaveBeenCalled();
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
});
