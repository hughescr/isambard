/* eslint-disable @typescript-eslint/unbound-method -- Test mocks require accessing methods */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import _ from 'lodash';
import { ResponseRouter } from '../../../../../src/integrations/discord/channel-registry/response-router';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import type { ChannelMetadata } from '../../../../../src/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '../../../../../src/integrations/discord/types';
import { NO_RESPONSE_SENTINEL } from '../../../../../src/integrations/discord/channel-registry/sentinel';
import { WellKnownChannelNotFoundError } from '@/errors';

describe('ResponseRouter', () => {
    let router: ResponseRouter;
    let mockManager: ChannelRegistryManager;

    const ORIGIN_CHANNEL = createChannelId('origin-123');
    const CATCHUP_CHANNEL = createChannelId('catchup-456');
    const PERCH_CHANNEL = createChannelId('perch-789');
    const FALLBACK_CHANNEL = createChannelId('fallback-999');

    beforeEach(() => {
        // Create minimal mocks with just the methods we need
        mockManager = {
            getWellKnownChannel: mock(_.constant(Promise.resolve(null))),
        } as unknown as ChannelRegistryManager;

        router = new ResponseRouter({
            manager: mockManager,
        });
    });

    describe('routeResponse', () => {
        describe('dm session type', () => {
            it('should route to origin channel', async () => {
                const result = await router.routeResponse(
                    'dm',
                    'Hello from DM',
                    ORIGIN_CHANNEL
                );

                // Should NOT attempt to get well-known channel for DM
                expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
                expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toBe('Hello from DM');
                expect(result.isFallback).toBe(false);
                expect(result.fallbackReason).toBeUndefined();
            });

            it('should detect sentinel in DM response', async () => {
                const result = await router.routeResponse(
                    'dm',
                    `${NO_RESPONSE_SENTINEL} Not sending this`,
                    ORIGIN_CHANNEL
                );

                // Should NOT attempt to get well-known channel for DM
                expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
                expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
                expect(result.shouldSend).toBe(false);
                expect(result.content).toBe('Not sending this');
                expect(result.isFallback).toBe(false);
            });
        });

        describe('processing_message session type', () => {
            it('should route to origin channel', async () => {
                const result = await router.routeResponse(
                    'processing_message',
                    'Processing message response',
                    ORIGIN_CHANNEL
                );

                // Should NOT attempt to get well-known channel for processing_message
                expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
                expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toBe('Processing message response');
                expect(result.isFallback).toBe(false);
            });

            it('should detect sentinel in regular message', async () => {
                const result = await router.routeResponse(
                    'processing_message',
                    `Some text ${NO_RESPONSE_SENTINEL} more text`,
                    ORIGIN_CHANNEL
                );

                // Should NOT attempt to get well-known channel for processing_message
                expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
                expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
                expect(result.shouldSend).toBe(false);
                expect(result.content).toBe('Some text  more text');
                expect(result.isFallback).toBe(false);
            });
        });

        describe('catching_up session type', () => {
            it('should route to catch-up channel when available', async () => {
                const catchupMeta: ChannelMetadata = {
                    channelId:    CATCHUP_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'catch-up',
                    isMuted:      false,
                    isWellKnown:  'catch-up',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(catchupMeta)));

                const result = await router.routeResponse(
                    'catching_up',
                    'Catch-up complete',
                    ORIGIN_CHANNEL
                );

                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('catch-up');
                expect(result.targetChannelId).toBe(CATCHUP_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toBe('Catch-up complete');
                expect(result.isFallback).toBe(false);
            });

            it('should route to fallback when catch-up channel missing', async () => {
                const fallbackMeta: ChannelMetadata = {
                    channelId:    FALLBACK_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'fallback',
                    isMuted:      false,
                    isWellKnown:  'fallback',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                // First call for 'catch-up' returns null, second call for 'fallback' returns fallback channel
                mockManager.getWellKnownChannel = mock((type: string) =>
                    Promise.resolve(type === 'fallback' ? fallbackMeta : null)
                );

                const result = await router.routeResponse(
                    'catching_up',
                    'Catch-up complete',
                    ORIGIN_CHANNEL
                );

                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('catch-up');
                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('fallback');
                expect(result.targetChannelId).toBe(FALLBACK_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toContain('⚠️ Channel #catch-up not configured');
                expect(result.content).toContain('Catch-up complete');
                expect(result.isFallback).toBe(true);
                expect(result.fallbackReason).toBe('#catch-up not configured');
            });

            it('should throw WellKnownChannelNotFoundError when both catch-up and fallback channels missing', () => {
                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(null)));

                expect(router.routeResponse(
                    'catching_up',
                    'Catch-up complete',
                    ORIGIN_CHANNEL
                )).rejects.toThrow(WellKnownChannelNotFoundError);
            });

            it('should detect sentinel in catch-up response', async () => {
                const catchupMeta: ChannelMetadata = {
                    channelId:    CATCHUP_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'catch-up',
                    isMuted:      false,
                    isWellKnown:  'catch-up',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(catchupMeta)));

                const result = await router.routeResponse(
                    'catching_up',
                    `${NO_RESPONSE_SENTINEL} Silent catch-up`,
                    ORIGIN_CHANNEL
                );

                expect(result.shouldSend).toBe(false);
                expect(result.content).toBe('Silent catch-up');
            });
        });

        describe('perching session type', () => {
            it('should route to perch-time channel when available', async () => {
                const perchMeta: ChannelMetadata = {
                    channelId:    PERCH_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'perch-time',
                    isMuted:      false,
                    isWellKnown:  'perch-time',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(perchMeta)));

                const result = await router.routeResponse(
                    'perching',
                    'Perch observation',
                    ORIGIN_CHANNEL
                );

                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
                expect(result.targetChannelId).toBe(PERCH_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toBe('Perch observation');
                expect(result.isFallback).toBe(false);
            });

            it('should route to fallback when perch-time channel missing', async () => {
                const fallbackMeta: ChannelMetadata = {
                    channelId:    FALLBACK_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'fallback',
                    isMuted:      false,
                    isWellKnown:  'fallback',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                // First call for 'perch-time' returns null, second call for 'fallback' returns fallback channel
                mockManager.getWellKnownChannel = mock((type: string) =>
                    Promise.resolve(type === 'fallback' ? fallbackMeta : null)
                );

                const result = await router.routeResponse(
                    'perching',
                    'Perch observation',
                    ORIGIN_CHANNEL
                );

                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
                expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('fallback');
                expect(result.targetChannelId).toBe(FALLBACK_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toContain('⚠️ Channel #perch-time not configured');
                expect(result.content).toContain('Perch observation');
                expect(result.isFallback).toBe(true);
                expect(result.fallbackReason).toBe('#perch-time not configured');
            });

            it('should throw WellKnownChannelNotFoundError when both perch-time and fallback channels missing', () => {
                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(null)));

                expect(router.routeResponse(
                    'perching',
                    'Perch observation',
                    ORIGIN_CHANNEL
                )).rejects.toThrow(WellKnownChannelNotFoundError);
            });

            it('should detect sentinel in perch response', async () => {
                const perchMeta: ChannelMetadata = {
                    channelId:    PERCH_CHANNEL,
                    guildId:      createGuildId('guild-123'),
                    channelName:  'perch-time',
                    isMuted:      false,
                    isWellKnown:  'perch-time',
                    discoveredAt: new Date().toISOString(),
                    lastSeenAt:   new Date().toISOString(),
                    updatedAt:    new Date().toISOString(),
                };

                mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(perchMeta)));

                const result = await router.routeResponse(
                    'perching',
                    `${NO_RESPONSE_SENTINEL} Silent perch`,
                    ORIGIN_CHANNEL
                );

                expect(result.shouldSend).toBe(false);
                expect(result.content).toBe('Silent perch');
            });
        });

        describe('unknown session type (unmapped)', () => {
            it('should fallback to origin channel for unmapped session type', async () => {
                // Cast to SessionType to simulate an unknown/unmapped type
                // This tests the line 68-76 branch where wellKnownType is undefined
                const unknownType = 'unknown_type' as unknown as import('../../../../../src/integrations/discord/channel-registry/response-router').SessionType;

                const result = await router.routeResponse(
                    unknownType,
                    'Response for unknown type',
                    ORIGIN_CHANNEL
                );

                // Should not call manager since wellKnownType is undefined
                expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
                expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
                expect(result.shouldSend).toBe(true);
                expect(result.content).toBe('Response for unknown type');
                expect(result.isFallback).toBe(false);
                expect(result.fallbackReason).toBeUndefined();
            });
        });
    });

    describe('getTargetChannel', () => {
        it('should return origin channel for dm session', async () => {
            const target = await router.getTargetChannel('dm', ORIGIN_CHANNEL);

            // Should NOT attempt to get well-known channel for DM
            expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
            expect(target).toBe(ORIGIN_CHANNEL);
        });

        it('should return origin channel for processing_message session', async () => {
            const target = await router.getTargetChannel('processing_message', ORIGIN_CHANNEL);

            // Should NOT attempt to get well-known channel for processing_message
            expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
            expect(target).toBe(ORIGIN_CHANNEL);
        });

        it('should return catch-up channel when available', async () => {
            const catchupMeta: ChannelMetadata = {
                channelId:    CATCHUP_CHANNEL,
                guildId:      createGuildId('guild-123'),
                channelName:  'catch-up',
                isMuted:      false,
                isWellKnown:  'catch-up',
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            };

            mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(catchupMeta)));

            const target = await router.getTargetChannel('catching_up', ORIGIN_CHANNEL);

            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('catch-up');
            expect(target).toBe(CATCHUP_CHANNEL);
        });

        it('should throw WellKnownChannelNotFoundError when catch-up channel missing', () => {
            mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(null)));

            expect(router.getTargetChannel('catching_up', ORIGIN_CHANNEL)).rejects.toThrow(WellKnownChannelNotFoundError);
        });

        it('should return perch-time channel when available', async () => {
            const perchMeta: ChannelMetadata = {
                channelId:    PERCH_CHANNEL,
                guildId:      createGuildId('guild-123'),
                channelName:  'perch-time',
                isMuted:      false,
                isWellKnown:  'perch-time',
                discoveredAt: new Date().toISOString(),
                lastSeenAt:   new Date().toISOString(),
                updatedAt:    new Date().toISOString(),
            };

            mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(perchMeta)));

            const target = await router.getTargetChannel('perching', ORIGIN_CHANNEL);

            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
            expect(target).toBe(PERCH_CHANNEL);
        });

        it('should throw WellKnownChannelNotFoundError when perch-time channel missing', () => {
            mockManager.getWellKnownChannel = mock(_.constant(Promise.resolve(null)));

            expect(router.getTargetChannel('perching', ORIGIN_CHANNEL)).rejects.toThrow(WellKnownChannelNotFoundError);
        });

        it('should return origin channel for unmapped session type', async () => {
            // Cast to SessionType to simulate an unknown/unmapped type
            // This tests the line 111-114 branch where wellKnownType is undefined
            const unknownType = 'unknown_type' as unknown as import('../../../../../src/integrations/discord/channel-registry/response-router').SessionType;

            const target = await router.getTargetChannel(unknownType, ORIGIN_CHANNEL);

            // Should not call manager since wellKnownType is undefined
            expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
            expect(target).toBe(ORIGIN_CHANNEL);
        });
    });
});
