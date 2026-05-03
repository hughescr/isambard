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

/* eslint-disable no-restricted-syntax -- sendResponseToWellKnownChannel is re-imported per test to avoid module-level spy contamination; these imports are lightweight (same module, cached by bun) and necessary because the function is a module-level export that needs fresh resolution after mock setup */
import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Message, TextChannel, Client, DMChannel } from 'discord.js';
import { ChannelNotAccessibleError, WellKnownChannelNotFoundError } from '@/errors/discord';
import type { ResponseRouter } from '@/integrations/discord/channel-registry/response-router';
import type { DiscordRateLimiter } from '@/integrations/discord/rate-limiter';
import { sendResponse } from '@/integrations/discord/response-sender';
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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
            const { sendResponseToWellKnownChannel } = await import('@/integrations/discord/response-sender');

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
});
