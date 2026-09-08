import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { ChannelRegistryManager } from '../../../../../src/integrations/discord/channel-registry/manager';
import { ENVELOPE_KIND_TO_CHANNEL, ResponseRouter } from '../../../../../src/integrations/discord/channel-registry/response-router';
import { NO_RESPONSE_SENTINEL } from '../../../../../src/integrations/discord/channel-registry/sentinel';
import type { ChannelMetadata } from '../../../../../src/integrations/discord/channel-registry/types';
import { createChannelId, createGuildId } from '../../../../../src/integrations/discord/types';
import { InvariantViolationError, WellKnownChannelNotFoundError } from '@/errors';

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
            getWellKnownChannel: mock(() => Promise.resolve(null)),
        } as unknown as ChannelRegistryManager;

        router = new ResponseRouter({
            manager: mockManager,
        });
    });

    describe('routeToFallback', () => {
        const FALLBACK_META: ChannelMetadata = {
            channelId:    FALLBACK_CHANNEL,
            guildId:      createGuildId('guild-123'),
            channelName:  'fallback',
            isMuted:      false,
            isWellKnown:  'fallback',
            discoveredAt: new Date().toISOString(),
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        };

        it('should route to the fallback channel and set isFallback=true', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(FALLBACK_META));

            const result = await router.routeToFallback('Operator notification');

            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('fallback');
            expect(result.targetChannelId).toBe(FALLBACK_CHANNEL);
            expect(result.shouldSend).toBe(true);
            expect(result.content).toBe('Operator notification');
            expect(result.isFallback).toBe(true);
        });

        it('should process sentinel in content', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(FALLBACK_META));

            const result = await router.routeToFallback(`${NO_RESPONSE_SENTINEL} Silent`);

            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('Silent');
            expect(result.isFallback).toBe(true);
        });

        it('should throw WellKnownChannelNotFoundError when no fallback channel is configured', () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(null));

            expect(router.routeToFallback('Notification')).rejects.toThrow(WellKnownChannelNotFoundError);
        });
    });

    describe('ENVELOPE_KIND_TO_CHANNEL', () => {
        it('maps catchup and perch envelope kinds to their well-known channels, and nothing else', () => {
            expect(ENVELOPE_KIND_TO_CHANNEL).toEqual({
                catchup: 'catch-up',
                perch:   'perch-time',
            });
        });
    });

    describe('resolveEnvelopeTarget', () => {
        const CATCHUP_META: ChannelMetadata = {
            channelId:    CATCHUP_CHANNEL,
            guildId:      createGuildId('guild-123'),
            channelName:  'catch-up',
            isMuted:      false,
            isWellKnown:  'catch-up',
            discoveredAt: new Date().toISOString(),
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        };

        const PERCH_META: ChannelMetadata = {
            channelId:    PERCH_CHANNEL,
            guildId:      createGuildId('guild-123'),
            channelName:  'perch-time',
            isMuted:      false,
            isWellKnown:  'perch-time',
            discoveredAt: new Date().toISOString(),
            lastSeenAt:   new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        };

        it('resolves a catchup envelope to the catch-up well-known channel', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(CATCHUP_META));

            const result = await router.resolveEnvelopeTarget('catchup', 'Here is the digest');

            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('catch-up');
            expect(result.targetChannelId).toBe(CATCHUP_CHANNEL);
            expect(result.shouldSend).toBe(true);
            expect(result.content).toBe('Here is the digest');
        });

        it('resolves a perch envelope to the perch-time well-known channel', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(PERCH_META));

            const result = await router.resolveEnvelopeTarget('perch', 'Perch report');

            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('perch-time');
            expect(result.targetChannelId).toBe(PERCH_CHANNEL);
            expect(result.content).toBe('Perch report');
        });

        it('applies @@NO_RESPONSE@@ sentinel processing exactly like routeResponse', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(CATCHUP_META));

            const result = await router.resolveEnvelopeTarget('catchup', `Nothing new. ${NO_RESPONSE_SENTINEL}`);

            expect(result.shouldSend).toBe(false);
            expect(result.content).toBe('Nothing new.');
        });

        it('throws WellKnownChannelNotFoundError when the catchup channel is missing, with no fallback attempt', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(null));

            await expect(router.resolveEnvelopeTarget('catchup', 'text')).rejects.toThrow(WellKnownChannelNotFoundError);
            expect(mockManager.getWellKnownChannel).toHaveBeenCalledTimes(1);
            expect(mockManager.getWellKnownChannel).toHaveBeenCalledWith('catch-up');
        });

        it('throws WellKnownChannelNotFoundError when the perch channel is missing', async () => {
            mockManager.getWellKnownChannel = mock(() => Promise.resolve(null));

            await expect(router.resolveEnvelopeTarget('perch', 'text')).rejects.toThrow(WellKnownChannelNotFoundError);
        });

        it('routes a discord-kind envelope to the given originChannelId', async () => {
            const result = await router.resolveEnvelopeTarget('discord', 'reply text', ORIGIN_CHANNEL);

            expect(mockManager.getWellKnownChannel).not.toHaveBeenCalled();
            expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
            expect(result.shouldSend).toBe(true);
            expect(result.content).toBe('reply text');
        });

        it('routes a notification-kind envelope to the given originChannelId', async () => {
            const result = await router.resolveEnvelopeTarget('notification', 'notice text', ORIGIN_CHANNEL);

            expect(result.targetChannelId).toBe(ORIGIN_CHANNEL);
        });

        it('throws InvariantViolationError for a discord-kind envelope with no originChannelId', async () => {
            await expect(router.resolveEnvelopeTarget('discord', 'reply text')).rejects.toThrow(InvariantViolationError);
        });

        it('throws InvariantViolationError for a notification-kind envelope with no originChannelId', async () => {
            await expect(router.resolveEnvelopeTarget('notification', 'notice text')).rejects.toThrow(InvariantViolationError);
        });
    });
});
